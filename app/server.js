"use strict";
// Forecast dashboard as a Cloud Run app. Serves the same index.html as the claude.ai artifact, plus a small client shim
// (shim.js) that answers the page's data calls through this server instead of claude.ai connectors:
//   Salesforce - the owner's server login (JWT bearer, as in vertical-planning); only the dashboard's own read queries
//   Snowflake  - each viewer's own Snowflake sign-in (OAuth through the company SSO); only the page's two snapshot queries
//   Razieli    - every lead's forecast submissions, judgments and the quarter rollups, live, with the RAZIELI_TOKEN secret
// Google sign-in (Cloud Run IAP) sits in front, and every request's IAP token is verified here as well.
// Node 20 built-ins only. Secrets are read from Secret Manager at run time, never sent to the browser.

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ENV = process.env;
const PORT = Number(ENV.PORT || 8080);
const PROJECT = ENV.GCP_PROJECT || "revenue-operations-475018";
const DOMAIN = (ENV.ALLOWED_DOMAIN || "wsc-sports.com").toLowerCase();
const IAP_AUDIENCE = ENV.IAP_AUDIENCE || ""; // /projects/<number>/locations/<region>/services/<name>; required
const PUBLIC_URL = (ENV.PUBLIC_URL || "").replace(/\/+$/, "");
const SF = {
  login: (ENV.SF_LOGIN_URL || "https://login.salesforce.com").replace(/\/+$/, ""),
  clientId: ENV.SF_CLIENT_ID || "", user: ENV.SF_USERNAME || "", api: ENV.SF_API_VERSION || "v64.0",
  keySecret: ENV.SF_KEY_SECRET || "sf-jwt-key"
};
const SNOW = {
  url: (ENV.SNOWFLAKE_ACCOUNT_URL || "https://ufawbbj-sm32288.snowflakecomputing.com").replace(/\/+$/, ""),
  idSecret: ENV.SNOWFLAKE_CLIENT_ID_SECRET || "snowflake-oauth-client-id",
  secretSecret: ENV.SNOWFLAKE_CLIENT_SECRET_SECRET || "snowflake-oauth-client-secret",
  role: ENV.SNOWFLAKE_ROLE ?? "WSC_BA_VIEWER", warehouse: ENV.SNOWFLAKE_WAREHOUSE ?? "WSC_MCP_WH"
};
const RZ = {url: ENV.RAZIELI_URL || "https://app.wscast.com/api/mcp", tokenSecret: ENV.RAZIELI_TOKEN_SECRET || "RAZIELI_TOKEN"};
// Documents the page keeps (Aviv's inputs), in a Cloud Storage bucket; only these people may change them
const STORE = {bucket: ENV.STORE_BUCKET || "revenue-operations-475018-forecast-dashboard",
  editors: new Set((ENV.AVIV_EDITORS || "").toLowerCase().split(/[;,\s]+/).filter(Boolean))};
const SESSION_SECRET = ENV.SESSION_KEY_SECRET || "forecast-dashboard-session-key";

const log = (severity, message, extra) => console.log(JSON.stringify({severity, message, ...extra}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = b => Buffer.from(b).toString("base64url");
const httpError = (status, code, message, extra) => Object.assign(new Error(message), {status, code, ...extra});
const unavailable = what => httpError(503, "server_unavailable", `${what} can't be reached right now.`, {retryable: true});
if (!IAP_AUDIENCE) log("ERROR", "IAP_AUDIENCE is not set, so every request is refused");

const SHIM = fs.readFileSync(path.join(__dirname, "shim.js"), "utf8");
const PAGE = (() => {
  // the shim has to run before the page's own script
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8"), i = html.indexOf("<script");
  if (i < 0 || html.indexOf("<script>") !== i) throw new Error("index.html's first script must be its own inline script");
  return html.slice(0, i) + `<script src="/app/shim.js"></script>\n` + html.slice(i);
})();
const PAGE_GZ = zlib.gzipSync(PAGE);

/* ---------- Google: metadata token and Secret Manager ---------- */
let gcpTok = {v: null, exp: 0};
async function gcpToken() {
  if (gcpTok.v && Date.now() < gcpTok.exp - 60000) return gcpTok.v;
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {headers: {"Metadata-Flavor": "Google"}});
  if (!r.ok) throw new Error(`metadata token: HTTP ${r.status}`);
  const j = await r.json();
  gcpTok = {v: j.access_token, exp: Date.now() + j.expires_in * 1000};
  return gcpTok.v;
}
const secrets = new Map();
// The latest version of a secret, cached for 10 minutes. Optional secrets (the Snowflake app's id and secret, which the
// data team fills in later) come back null while missing or still "PENDING", and are looked up again after a minute.
async function secret(name, optional = false) {
  const c = secrets.get(name);
  if (c && Date.now() - c.at < (c.v == null ? 60000 : 600000)) {
    if (c.v == null && !optional) throw httpError(500, "not_configured", `The app's ${name} secret isn't available.`);
    return c.v;
  }
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${encodeURIComponent(name)}/versions/latest:access`,
    {headers: {Authorization: "Bearer " + await gcpToken()}});
  let v = null;
  if (r.ok) {
    const j = await r.json();
    v = Buffer.from(j.payload.data, "base64").toString("utf8").trim();
    if (!v || v === "PENDING") v = null;
  } else if (!optional || ![403, 404].includes(r.status)) {
    throw httpError(500, "not_configured", `The app can't read its ${name} secret (HTTP ${r.status}).`);
  }
  secrets.set(name, {v, at: Date.now()});
  if (v == null && !optional) throw httpError(500, "not_configured", `The app's ${name} secret is empty.`);
  return v;
}

/* ---------- who is asking: the IAP token ---------- */
let iapKeys = {at: 0, keys: {}};
async function iapKey(kid) {
  if (!iapKeys.keys[kid] || Date.now() - iapKeys.at > 3600000) {
    const r = await fetch("https://www.gstatic.com/iap/verify/public_key-jwk");
    if (!r.ok) throw new Error(`IAP keys: HTTP ${r.status}`);
    const keys = {};
    for (const k of (await r.json()).keys || []) { try { keys[k.kid] = crypto.createPublicKey({key: k, format: "jwk"}); } catch (e) {} }
    iapKeys = {at: Date.now(), keys};
  }
  return iapKeys.keys[kid] || null;
}
async function identify(req) {
  const jwt = req.headers["x-goog-iap-jwt-assertion"];
  if (typeof jwt !== "string") return null;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  let head, body;
  try { head = JSON.parse(Buffer.from(h, "base64url")); body = JSON.parse(Buffer.from(p, "base64url")); } catch (e) { return null; }
  if (head.alg !== "ES256" || typeof head.kid !== "string") return null;
  const key = await iapKey(head.kid);
  if (!key || !crypto.verify("sha256", Buffer.from(`${h}.${p}`), {key, dsaEncoding: "ieee-p1363"}, Buffer.from(s, "base64url"))) return null;
  const now = Date.now() / 1000;
  if (body.iss !== "https://cloud.google.com/iap" || !(body.exp > now) || !(body.iat < now + 300)) return null;
  // Google signs every IAP token with the same keys, so only a token issued for this service counts
  if (!IAP_AUDIENCE || body.aud !== IAP_AUDIENCE) { log("WARNING", "IAP token refused: wrong audience", {aud: body.aud, expected: IAP_AUDIENCE || null}); return null; }
  const email = String(body.email || "").replace(/^accounts\.google\.com:/, "").toLowerCase();
  if (!email.endsWith("@" + DOMAIN)) return null;
  return {email};
}

/* ---------- sealed cookies (AES-256-GCM, key from Secret Manager) ---------- */
let sealKey = null;
async function cookieKey() {
  if (!sealKey) sealKey = Buffer.from(crypto.hkdfSync("sha256", await secret(SESSION_SECRET), "", "forecast-dashboard cookies v1", 32));
  return sealKey;
}
async function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", await cookieKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
async function unseal(s) {
  if (!s) return null;
  try {
    const b = Buffer.from(s, "base64url"), d = crypto.createDecipheriv("aes-256-gcm", await cookieKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  } catch (e) { return null; }
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
const setCookie = (name, value, maxAge, p = "/") => `${name}=${value}; Path=${p}; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=Lax`;

/* ---------- HTTP helpers ---------- */
const SEC_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY", "Strict-Transport-Security": "max-age=31536000"};
function send(res, status, body, headers = {}) {
  const raw = typeof body === "string";
  res.writeHead(status, {"Content-Type": raw ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS, ...headers});
  res.end(raw ? body : JSON.stringify(body));
}
function sendJson(res, json, headers = {}) {
  res.writeHead(200, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS, ...headers});
  res.end(json);
}
const fail = (res, status, code, message, headers, retryable) => send(res, status, {code, message, ...(retryable ? {retryable: true} : {})}, headers);
async function readJson(req, limit = 200000) {
  let n = 0; const parts = [];
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, "tool_error", "Request too large."); parts.push(c); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch (e) { throw httpError(400, "tool_error", "Bad JSON."); }
}
// API calls come from the page itself: a custom header and JSON body, which a cross-site page can't send without CORS
function sameOrigin(req) {
  if (req.headers["x-fd"] !== "1") return false;
  const o = req.headers.origin;
  return !o || o === `https://${req.headers.host}` || (!!PUBLIC_URL && o === PUBLIC_URL);
}
const baseUrl = req => PUBLIC_URL || `https://${req.headers.host}`;
function limiter(n) {
  let active = 0; const queue = [];
  return async fn => {
    if (active >= n) await new Promise(r => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; const next = queue.shift(); if (next) next(); }
  };
}

/* ---------- Salesforce ---------- */
// The objects and fields the dashboard reads (SELECT, WHERE and ORDER BY); any other query is refused.
const lowerSet = s => new Set(s.toLowerCase().split(/\s+/));
const SOQL_ALLOW = Object.fromEntries(Object.entries({
  ARR_Breakdown__c: "Id Opportunity__c Product__r.Name ARR_Dollar__c ARR_End_Date__c First_Deal_ARR__c Opportunity__r.Name Opportunity__r.Type " +
    "Opportunity__r.StageName Opportunity__r.VP_Forecast__c Opportunity__r.Region_Lead_Forecast__c Opportunity__r.Region__c Opportunity__r.Owner.Name " +
    "Opportunity__r.CreatedDate Opportunity__r.Min_ARR_Date__c Opportunity__r.Min_ARR_Period_Amount_Dollar__c Opportunity__r.LastModifiedDate",
  Opportunity: "Id Name Type StageName VP_Forecast__c Region_Lead_Forecast__c Region__c Owner.Name CreatedDate Min_ARR_Date__c Min_ARR_Period_Amount_Dollar__c",
  OpportunityFieldHistory: "Id OpportunityId Field OldValue NewValue CreatedDate CreatedBy.Name",
  Booking__c: "Id Opportunity__c Product__r.Name ARR_Start_Date__c ARR_End_Date__c ARR_Base_Amount__c ARRDollar__c Conversion_Rate_USD_new__c CreatedDate",
  Booking__History: "Id ParentId Field OldValue NewValue CreatedDate",
  OpportunityLineItem: "Id OpportunityId Product2.Name TotalPrice"
}).map(([o, f]) => [o, lowerSet(f)]));
// History rows carry the old and new value of whatever field changed, so only these fields' history may be read
const HISTORY_FIELDS = {
  OpportunityFieldHistory: lowerSet("VP_Forecast__c Region_Lead_Forecast__c StageName Min_ARR_Date__c Min_ARR_Period_Amount_Dollar__c"),
  Booking__History: lowerSet("ARR_Start_Date__c ARR_End_Date__c ARR_Base_Amount__c Opportunity__c")
};
const SOQL_WORDS = new Set(["AND", "OR", "NOT", "IN", "LIKE", "NULL", "TRUE", "FALSE", "INCLUDES", "EXCLUDES"]);
const STR = /'(?:[^'\\]|\\.)*'/g;
// {obj} when the query is one the dashboard sends, otherwise {why}
function checkSoql(q) {
  if (typeof q !== "string" || q.length > 20000) return {why: "query too long"};
  const s = q.replace(/\s+/g, " ").trim();
  const m = /^SELECT (.+?) FROM ([A-Za-z_][A-Za-z0-9_]*)(?: WHERE (.+?))?(?: ORDER BY ([A-Za-z_][A-Za-z0-9_.]*)(?: (?:ASC|DESC))?)?(?: LIMIT (\d{1,4}))?$/i.exec(s);
  if (!m) return {why: "query shape not allowed"};
  const obj = Object.keys(SOQL_ALLOW).find(k => k.toLowerCase() === m[2].toLowerCase());
  if (!obj) return {why: `object ${m[2]} not allowed`};
  const allowed = SOQL_ALLOW[obj], where = m[3] || "";
  // plain fields, or (for one summary row, as Aviv's tab asks for closed ARR) aggregates of them with an alias
  let aggregates = 0;
  const cols = m[1].split(",").map(x => x.trim());
  for (const f of cols) {
    const a = /^(?:SUM|COUNT|COUNT_DISTINCT|MIN|MAX)\(([A-Za-z_][A-Za-z0-9_.]*)\)(?: [A-Za-z_][A-Za-z0-9_]*)?$/i.exec(f);
    if (a ? !allowed.has(a[1].toLowerCase()) : !allowed.has(f.toLowerCase())) return {why: `field ${f} not allowed on ${obj}`};
    if (a) aggregates++;
  }
  if (aggregates && (aggregates !== cols.length || m[4])) return {why: "aggregates can't be mixed with fields or ordered"};
  if (m[4] && !allowed.has(m[4].toLowerCase())) return {why: `ORDER BY ${m[4]} not allowed on ${obj}`};
  // only fields, quoted literals, dates, numbers, comparison operators, AND/OR/NOT and IN lists: no subqueries or functions
  const w = where.replace(STR, "''").replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?\b/g, "0");
  if (/[;:{}[\]"`\\]|\bSELECT\b|[A-Za-z_][A-Za-z0-9_.]*\s*\(/i.test(w.replace(/\b(?:IN|NOT IN|AND|OR|NOT)\s*\(/gi, ""))) return {why: "WHERE clause not allowed"};
  for (const id of w.match(/\b[A-Za-z_][A-Za-z0-9_.]*/g) || []) {
    if (SOQL_WORDS.has(id.toUpperCase())) continue;
    if (!allowed.has(id.toLowerCase())) return {why: `filter on ${id} not allowed on ${obj}`};
  }
  // bounded: a single summary row, a LIMIT of at most 2000 (the page pages by Id), or a list of at most 200 Ids
  const lim = Number(m[5] || 0);
  if (!aggregates && !(lim > 0 && lim <= 2000) && !/^Id IN \((?:'[A-Za-z0-9]{15,18}', ?){0,199}'[A-Za-z0-9]{15,18}'\)$/i.test(where)) return {why: "query needs LIMIT 2000 or less, or at most 200 Ids"};
  const hf = HISTORY_FIELDS[obj];
  if (hf) {
    // exactly one Field = / Field IN filter, ANDed with the rest, naming only the fields above
    if (/\b(?:OR|NOT)\b|!=|<>/i.test(w)) return {why: `OR/NOT not allowed on ${obj}`};
    const f = /\bField\s*(?:=\s*('[^'\\]*')|IN\s*\(([^)]*)\))/i.exec(where);
    if ((w.match(/\bField\b/gi) || []).length !== 1 || !f) return {why: `${obj} needs one Field filter`};
    const lits = (f[1] || f[2]).split(",").map(x => x.trim());
    if (lits.some(x => !/^'[^'\\]*'$/.test(x) || !hf.has(x.slice(1, -1).toLowerCase()))) return {why: `history of ${f[1] || f[2]} not allowed`};
  }
  return {obj};
}
let sfSess = null, sfLogin = null;
async function sfSession(force) {
  if (sfSess && !force && Date.now() - sfSess.at < 3600000) return sfSess;
  if (!sfLogin) sfLogin = (async () => {
    if (!SF.clientId || !SF.user) throw httpError(500, "not_configured", "The app's Salesforce login isn't configured (SF_CLIENT_ID, SF_USERNAME).");
    const key = (await secret(SF.keySecret)).replace(/\\n/g, "\n");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64u(JSON.stringify({alg: "RS256", typ: "JWT"}))}.${b64u(JSON.stringify({iss: SF.clientId, sub: SF.user, aud: SF.login, exp: now + 180}))}`;
    const sig = crypto.sign("sha256", Buffer.from(unsigned), key).toString("base64url");
    const r = await fetch(`${SF.login}/services/oauth2/token`, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}`})}).catch(() => { throw unavailable("Salesforce"); });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500) throw unavailable("Salesforce");
    if (!r.ok || !j.access_token) throw httpError(500, "not_configured", `The app's Salesforce login failed: ${j.error || r.status} ${j.error_description || ""}`.trim());
    sfSess = {token: j.access_token, instance: j.instance_url, at: Date.now()};
    return sfSess;
  })().finally(() => { sfLogin = null; });
  return sfLogin;
}
async function sfGet(pathAndQuery, retried) {
  const s = await sfSession(false);
  const r = await fetch(s.instance + pathAndQuery, {headers: {Authorization: "Bearer " + s.token, Accept: "application/json"}}).catch(() => { throw unavailable("Salesforce"); });
  if (r.status === 401 && !retried) { await sfSession(true); return sfGet(pathAndQuery, true); }
  const j = await r.json().catch(() => null);
  if (r.status >= 500 || r.status === 429) throw unavailable("Salesforce");
  if (!r.ok) throw httpError(400, "tool_error", `Salesforce: ${Array.isArray(j) && j[0] ? `${j[0].errorCode}: ${j[0].message}` : `HTTP ${r.status}`}`);
  return j;
}
function stripAttributes(r) {
  if (!r || typeof r !== "object") return;
  delete r.attributes;
  for (const k in r) if (r[k] && typeof r[k] === "object") stripAttributes(r[k]);
}
// Results are cached for 5 minutes (as the artifact's connector cache was), least recently used first out
const sfLimit = limiter(6), sfCache = new Map(), SF_TTL = 300000, SF_MAX_ROWS = 10000;
let sfBytes = 0;
function sfCacheSet(q, v) {
  const old = sfCache.get(q); if (old && old.json) sfBytes -= old.json.length;
  sfCache.delete(q); sfCache.set(q, v); if (v.json) sfBytes += v.json.length;
  const now = Date.now();
  for (const [k, e] of sfCache) {
    if (!e.json) continue;
    if (now - e.at < SF_TTL && sfCache.size <= 400 && sfBytes <= 150e6) break;
    sfCache.delete(k); sfBytes -= e.json.length;
  }
}
async function sfQuery(q, obj, refresh) {
  const c = sfCache.get(q);
  if (c && c.p) return c.p;
  // a refresh re-reads Salesforce unless this result is under 30 seconds old
  if (c && c.json && Date.now() - c.at < (refresh ? 30000 : SF_TTL)) { sfCache.delete(q); sfCache.set(q, c); return c.json; }
  const p = sfLimit(async () => {
    let j = await sfGet(`/services/data/${SF.api}/query?q=${encodeURIComponent(q)}`), records = j.records || [];
    while (!j.done && j.nextRecordsUrl) {
      if (records.length > SF_MAX_ROWS) throw httpError(400, "tool_error", "Salesforce result too large.");
      j = await sfGet(j.nextRecordsUrl); records.push(...(j.records || []));
    }
    records.forEach(stripAttributes);
    const hf = HISTORY_FIELDS[obj];
    if (hf) for (const r of records) if (!hf.has(String(r.Field || "").toLowerCase())) r.OldValue = r.NewValue = null;
    const at = Date.now();
    return {at, json: JSON.stringify({records, storedAt: at})};
  });
  sfCache.set(q, {p: p.then(v => v.json)});
  try { const v = await p; sfCacheSet(q, v); return v.json; }
  catch (e) { if (c && c.json) sfCacheSet(q, c); else sfCache.delete(q); throw e; }
}

/* ---------- Snowflake: each viewer's own OAuth sign-in ---------- */
// Only the page's two statements (its list of a lead's submissions, and one submission's rows), with plain values
const SNOW_TABLE = "WSC_PROD\\.DWH_REVOPS\\.REVOPS_ARR_WATERFALL_PRODUCTS_BINARY_(?:REGION_LEAD_)?SNAPSHOT";
const SQL_ID = "[A-Za-z0-9_-]+", SQL_DATE = "\\d{4}-\\d{2}-\\d{2}", SQL_REGION = "'[A-Za-z0-9 ]+'";
const SQL_SHAPES = [
  new RegExp(`^SELECT SUBMISSION_ID, TO_VARCHAR\\(MAX\\(SUBMITTED_AT\\), 'YYYY-MM-DD"T"HH24:MI:SS\\.FF3'\\), MAX\\(IFF\\(ARR_END_DATE_C = '${SQL_DATE}', ARR_DOLLAR_C, NULL\\)\\) FROM ${SNOW_TABLE} WHERE SUBMITTED_BY_USER_ID = '${SQL_ID}' AND FISCAL_QUARTER = '${SQL_ID}' AND FISCAL_YEAR = \\d{4} GROUP BY 1$`),
  new RegExp(`^SELECT OPPORTUNITY_C, OPPORTUNITY_NAME, OPPORTUNITY_STAGE, (?:VP_FORECAST|REGION_LEAD_FORECAST), REGION, BIZDEV_OWNER, PRODUCT_NAME, ARR_DOLLAR_C FROM ${SNOW_TABLE} WHERE SUBMISSION_ID = '${SQL_ID}' AND ARR_END_DATE_C = '${SQL_DATE}' AND ARR_DOLLAR_C <> 0(?: AND REGION IN \\(${SQL_REGION}(?:,${SQL_REGION})*\\))?$`)
];
const checkSql = sql => typeof sql === "string" && sql.length < 4000 && SQL_SHAPES.some(r => r.test(sql)) ? null : "query shape not allowed";
async function snowApp() {
  const [id, sec] = await Promise.all([secret(SNOW.idSecret, true), secret(SNOW.secretSecret, true)]);
  return id && sec ? {id, sec} : null;
}
async function snowToken(form, app) {
  const r = await fetch(`${SNOW.url}/oauth/token-request`, {method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${encodeURIComponent(app.id)}:${encodeURIComponent(app.sec)}`).toString("base64")},
    body: new URLSearchParams(form)}).catch(() => { throw unavailable("Snowflake's sign-in"); });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.access_token) return j;
  if (j.error === "invalid_grant") throw httpError(401, "needs_reauth", "Your Snowflake sign-in has expired. Connect Snowflake again.");
  if (r.status >= 500 || r.status === 429) throw unavailable("Snowflake's sign-in");
  throw httpError(502, "tool_error", `Snowflake sign-in failed: ${j.error || r.status} ${j.message || j.error_description || ""}`.trim());
}
// A viewer's Snowflake sign-in lives in two sealed cookies tied to their Google email: fd_sf (the refresh token, up to 90 days)
// and fd_sfa (the current access token, about 10 minutes), so neither gets near the browser's 4 KB cookie limit.
async function snowCookies(s) {
  return [setCookie("fd_sf", await seal({email: s.email, user: s.user, rt: s.rt, rtExp: s.rtExp}), (s.rtExp - Date.now()) / 1000),
    setCookie("fd_sfa", await seal({email: s.email, at: s.at, atExp: s.atExp}), (s.atExp - Date.now()) / 1000)];
}
const SNOW_LOGOUT = [setCookie("fd_sf", "", 0), setCookie("fd_sfa", "", 0)];
async function snowRead(req, who) {
  const c = cookies(req), a = await unseal(c.fd_sf);
  if (!a || a.email !== who.email || !(a.rtExp > Date.now())) return null;
  const b = await unseal(c.fd_sfa), ok = b && b.email === who.email;
  return {...a, at: ok ? b.at : "", atExp: ok ? b.atExp : 0};
}
const refreshes = new Map();
async function snowRefresh(s, app) {
  if (!s.rt) throw httpError(401, "needs_reauth", "Your Snowflake sign-in has expired. Connect Snowflake again.");
  const k = crypto.createHash("sha256").update(s.rt).digest("hex");
  if (!refreshes.has(k)) refreshes.set(k, snowToken({grant_type: "refresh_token", refresh_token: s.rt}, app).finally(() => setTimeout(() => refreshes.delete(k), 5000)));
  const j = await refreshes.get(k), n = {...s, at: j.access_token, atExp: Date.now() + (Number(j.expires_in) || 600) * 1000};
  if (j.refresh_token && j.refresh_token !== s.rt) { n.rt = j.refresh_token; n.rtExp = Date.now() + (Number(j.refresh_token_expires_in) || 7776000) * 1000; }
  return n;
}
// Runs one statement with the viewer's token; on a 401 it renews the token once and repeats that step
async function snowSql(sess, sql, renew) {
  let renewed = false;
  const call = async (url, init = {}) => {
    for (;;) {
      const r = await fetch(url, {...init, headers: {Authorization: "Bearer " + sess.at, "X-Snowflake-Authorization-Token-Type": "OAUTH",
        "Content-Type": "application/json", Accept: "application/json", "User-Agent": "wsc-forecast-dashboard/1.0"}}).catch(() => { throw unavailable("Snowflake"); });
      if (r.status === 401 && !renewed) { renewed = true; sess = await renew(); continue; }
      if (r.status === 401) throw httpError(401, "needs_reauth", "Your Snowflake sign-in has expired. Connect Snowflake again.");
      return r;
    }
  };
  const body = {statement: sql, timeout: 120};
  if (SNOW.warehouse) body.warehouse = SNOW.warehouse;
  if (SNOW.role) body.role = SNOW.role;
  let r = await call(`${SNOW.url}/api/v2/statements?requestId=${crypto.randomUUID()}`, {method: "POST", body: JSON.stringify(body)});
  let j = await r.json().catch(() => ({}));
  const handle = j.statementHandle;
  for (let i = 0; (r.status === 202 || r.status === 429) && handle && i < 150; i++) {
    await sleep(i < 10 ? 500 : 1000);
    r = await call(`${SNOW.url}/api/v2/statements/${encodeURIComponent(handle)}`);
    j = await r.json().catch(() => ({}));
  }
  if (r.status === 202 || r.status === 429 || r.status >= 500) throw httpError(503, "server_unavailable", "Snowflake is busy right now.", {retryable: true});
  if (!r.ok) throw httpError(400, "tool_error", `Snowflake: ${j.message || "HTTP " + r.status}`);
  const meta = j.resultSetMetaData || {}, parts = meta.partitionInfo || [];
  if (parts.length > 40 || meta.numRows > 200000) throw httpError(400, "tool_error", "Snowflake result too large.");
  let data = j.data || [];
  for (let p = 1; p < parts.length; p++) {
    const rr = await call(`${SNOW.url}/api/v2/statements/${encodeURIComponent(j.statementHandle || handle)}?partition=${p}`);
    const jj = await rr.json().catch(() => ({}));
    if (!rr.ok) throw httpError(503, "server_unavailable", `Snowflake: ${jj.message || "HTTP " + rr.status}`, {retryable: true});
    data = data.concat(jj.data || []);
  }
  return {result_set: {data, resultSetMetaData: {numRows: meta.numRows ?? data.length, rowType: (meta.rowType || []).map(c => ({name: c.name, type: c.type}))}}};
}

/* ---------- Razieli ---------- */
let rzId = 0, rzSessionId = null;
async function rzPost(token, msg, sessionId) {
  const headers = {Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream"};
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(RZ.url, {method: "POST", headers, body: JSON.stringify(msg)}).catch(() => { throw unavailable("Razieli"); });
  const text = await r.text();
  let out = null;
  if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) { try { const j = JSON.parse(line.slice(5)); if (j && j.id === msg.id) out = j; } catch (e) {} }
  } else if (text) { try { out = JSON.parse(text); } catch (e) {} }
  return {status: r.status, sessionId: r.headers.get("mcp-session-id"), msg: out};
}
async function rzInit(token) {
  const a = await rzPost(token, {jsonrpc: "2.0", id: ++rzId, method: "initialize", params: {protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {name: "wsc-forecast-dashboard", version: "1.0"}}});
  if (a.status >= 400 || !a.msg || a.msg.error) throw httpError(502, "tool_error", `Razieli didn't accept the connection (HTTP ${a.status}).`);
  rzSessionId = a.sessionId || null;
  if (rzSessionId) await rzPost(token, {jsonrpc: "2.0", method: "notifications/initialized"}, rzSessionId).catch(() => {});
}
async function razieli(tool, args) {
  const token = await secret(RZ.tokenSecret);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await rzPost(token, {jsonrpc: "2.0", id: ++rzId, method: "tools/call", params: {name: tool, arguments: args}}, rzSessionId);
    if ((r.status === 400 || r.status === 404) && attempt < 2) { await rzInit(token); continue; } // the server wants a (new) MCP session
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) throw unavailable("Razieli");
    if (r.status >= 400 || !r.msg) throw httpError(502, "tool_error", `Razieli ${tool}: HTTP ${r.status}`);
    if (r.msg.error) throw httpError(502, "tool_error", `Razieli ${tool}: ${r.msg.error.message || "error"}`);
    const res = r.msg.result || {}, t = (res.content || []).find(c => c.type === "text");
    if (res.isError || !t) throw httpError(502, "tool_error", `Razieli ${tool}: ${t ? t.text.slice(0, 200) : "no result"}`);
    return JSON.parse(t.text);
  }
  throw unavailable("Razieli");
}
const LEADS = [["co", "Shachar Arnon"], ["na", "Daniel Pesce"], ["emea", "Lidor Oz"], ["apac", "Guy Port"]];
const num = v => v == null || v === "" || !isFinite(Number(v)) ? null : Number(v);
let rzCache = {at: 0, data: null, p: null};
// Every lead's submissions (all quarters) with the judgment and note of each, plus each quarter's rollup: the closed ARR and the
// lead's current submitted forecast (Razieli's history sometimes misses a lead's latest submission; the page adds it back).
// Same shape as RAZIELI embedded in index.html: {asOf, live, notes: [text], leads: {view: {name, subs: [[ms, "Q4-2026",
// forecast, judgment, note index or -1]]}}, closed: {"Q4-2026": {view: ARR}}, current: {"Q4-2026": {view: [ms, forecast, judgment, note index]}}}
async function razieliData(refresh) {
  // cached for 2 minutes; a refresh re-reads Razieli unless the copy is under 30 seconds old
  if (rzCache.data && Date.now() - rzCache.at < (refresh ? 30000 : 120000)) return rzCache.data;
  if (rzCache.p) return rzCache.p;
  rzCache.p = (async () => {
    const notes = [], noteIx = new Map(), quarters = new Set(), leads = {}, closed = {}, current = {};
    const note = t => { t = String(t || "").trim(); if (!t) return -1; if (!noteIx.has(t)) { noteIx.set(t, notes.length); notes.push(t); } return noteIx.get(t); };
    const hist = await Promise.all(LEADS.map(([, name]) => razieli("get_judgment_history", {name})));
    hist.forEach((h, i) => {
      const [k, name] = LEADS[i];
      leads[k] = {name, subs: (h.submits || []).map(s => {
        const qm = /^Q([1-4]) (\d{4})$/.exec(String(s.quarter || "").trim()), t = Date.parse(s.submitted_at);
        if (!qm || !isFinite(t)) return null;
        const q = `Q${qm[1]}-${qm[2]}`;
        quarters.add(q);
        return [t, q, num(s.realistic_forecast), num(s.judgment) || 0, note(s.judgment_note)];
      }).filter(Boolean).sort((a, b) => a[0] - b[0])};
    });
    await Promise.all([...quarters].map(async q => {
      const [n, y] = q.slice(1).split("-");
      let roll;
      try { roll = await razieli("get_forecast_rollup", {quarter: "Q" + n, year: Number(y)}); }
      catch (e) { log("WARNING", "Razieli rollup failed", {q, err: String(e.message || e)}); return; }
      for (const row of roll.rows || []) {
        const lead = LEADS.find(([, name]) => name === row.name);
        if (!lead) continue;
        (closed[q] = closed[q] || {})[lead[0]] = num(row.closed);
        const t = Date.parse(row.last_submitted_at || "");
        if (row.forecast_status === "submitted" && isFinite(t))
          (current[q] = current[q] || {})[lead[0]] = [t, num(row.realistic_forecast), num(row.judgment) || 0, note(row.judgment_note)];
      }
    }));
    const data = {asOf: new Date().toISOString(), live: true, notes, leads, closed, current};
    rzCache = {at: Date.now(), data, p: null};
    return data;
  })().catch(e => { rzCache.p = null; throw e; });
  return rzCache.p;
}

/* ---------- stored documents (Aviv's inputs) ---------- */
// The page's documents, by path, as objects in the bucket; each is checked into a fixed shape before it's saved
const DOCS = {
  "aviv/Q4-2026": d => {
    const calls = {}, adds = [], num = v => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;
    for (const [id, c] of Object.entries((d && d.calls) || {}).slice(0, 5000)) {
      if (/^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id) && c && ["Commit", "Best Case", "Pipeline"].includes(c.cat)) calls[id] = {cat: c.cat, amt: c.amt == null ? null : num(c.amt)};
    }
    for (const a of (Array.isArray(d && d.adds) ? d.adds : []).slice(0, 300)) {
      if (a && typeof a === "object") adds.push({id: String(a.id || "").slice(0, 40), name: String(a.name || "").slice(0, 300), amt: num(a.amt) || 0, note: String(a.note || "").slice(0, 300)});
    }
    // no list of added amounts at all means it still follows Shaka's judgment lines, so it stays absent
    return Array.isArray(d && d.adds) ? {calls, adds} : {calls};
  }
};
const docObject = p => `docs/${p}.json`;
async function storeFetch(url, init = {}) {
  const r = await fetch(url, {...init, headers: {Authorization: "Bearer " + await gcpToken(), ...(init.headers || {})}}).catch(() => { throw unavailable("The app's storage"); });
  if (r.status >= 500 || r.status === 429) throw unavailable("The app's storage");
  return r;
}
// Each saved version has a generation number; a save names the generation it builds on and is refused (409 "conflict")
// when someone saved in between, so the page's storage can merge and try again. Generation "0" means "doesn't exist yet".
async function docGet(p) {
  const o = `https://storage.googleapis.com/storage/v1/b/${STORE.bucket}/o/${encodeURIComponent(docObject(p))}`;
  const m = await storeFetch(o);
  if (m.status === 404) return {exists: false, gen: "0"};
  if (!m.ok) throw httpError(500, "not_configured", `The app can't read its storage (HTTP ${m.status}).`);
  const gen = String((await m.json()).generation);
  const r = await storeFetch(`${o}?alt=media&generation=${encodeURIComponent(gen)}`);
  if (r.status === 404) return docGet(p); // replaced between the two reads
  if (!r.ok) throw httpError(500, "not_configured", `The app can't read its storage (HTTP ${r.status}).`);
  return {exists: true, data: await r.json(), gen};
}
async function docSet(p, data, gen) {
  const r = await storeFetch(`https://storage.googleapis.com/upload/storage/v1/b/${STORE.bucket}/o?uploadType=media&name=${encodeURIComponent(docObject(p))}&ifGenerationMatch=${gen}`,
    {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
  if (r.status === 412) throw httpError(409, "conflict", "Someone saved a newer version in the meantime.");
  if (!r.ok) throw httpError(500, "not_configured", `The app can't save to its storage (HTTP ${r.status}).`);
  return String((await r.json()).generation);
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost"), m = req.method, p = url.pathname;
  if (p === "/healthz") return send(res, 200, "ok");
  // one address for everyone, so the Snowflake sign-in's cookies and return address always match
  if (PUBLIC_URL && m === "GET" && !p.startsWith("/api/") && `https://${req.headers.host}` !== PUBLIC_URL) {
    res.writeHead(302, {Location: PUBLIC_URL + url.pathname + url.search, "Cache-Control": "no-store", ...SEC_HEADERS});
    return res.end();
  }
  const who = await identify(req);
  if (!who) return fail(res, 401, "unauthenticated", `Sign in with your @${DOMAIN} Google account.`);

  if (m === "GET" && (p === "/" || p === "/index.html")) {
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", Vary: "Accept-Encoding", ...SEC_HEADERS, ...(gz ? {"Content-Encoding": "gzip"} : {})});
    return res.end(gz ? PAGE_GZ : PAGE);
  }
  if (m === "GET" && p === "/app/shim.js") {
    res.writeHead(200, {"Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", ...SEC_HEADERS});
    return res.end(SHIM);
  }
  if (m === "GET" && p === "/api/session") {
    const app = await snowApp().catch(() => null), s = app ? await snowRead(req, who) : null;
    return send(res, 200, {email: who.email, snowflake: {configured: !!app, connected: !!s, user: s ? s.user : null, until: s ? s.rtExp : null},
      canEditDocs: STORE.editors.has(who.email)});
  }
  if (m === "GET" && p === "/api/doc") {
    const path = url.searchParams.get("path") || "";
    if (!DOCS[path]) return fail(res, 404, "not_found", "No such document.");
    return send(res, 200, await docGet(path));
  }

  if (m === "POST" && p.startsWith("/api/")) {
    if (!sameOrigin(req)) return fail(res, 403, "forbidden", "Cross-site request refused.");
    const body = await readJson(req);
    if (p === "/api/sf/query") {
      const c = checkSoql(body.q);
      if (c.why) { log("WARNING", "SOQL refused", {email: who.email, why: c.why, q: String(body.q).slice(0, 400)}); return fail(res, 400, "tool_error", `Query not allowed: ${c.why}`); }
      return sendJson(res, await sfQuery(body.q.replace(/\s+/g, " ").trim(), c.obj, !!body.refresh));
    }
    if (p === "/api/snowflake/query") {
      const why = checkSql(body.sql);
      if (why) { log("WARNING", "SQL refused", {email: who.email, why, sql: String(body.sql).slice(0, 400)}); return fail(res, 400, "tool_error", `Query not allowed: ${why}`); }
      const app = await snowApp();
      if (!app) return fail(res, 409, "not_configured", "Snowflake sign-in isn't set up for this app yet.");
      let sess = await snowRead(req, who), cookie = null;
      if (!sess) return fail(res, 401, "server_not_connected", "Connect Snowflake to read the saved submissions.");
      const renew = async () => { sess = await snowRefresh(sess, app); cookie = await snowCookies(sess); return sess; };
      try {
        // a query can run for a few minutes, so the token is renewed ahead of time
        if (!(sess.atExp > Date.now() + 240000)) await renew();
        return sendJson(res, JSON.stringify(await snowSql(sess, body.sql, renew)), cookie ? {"Set-Cookie": cookie} : {});
      } catch (e) {
        e.setCookie = e.code === "needs_reauth" ? SNOW_LOGOUT : cookie;
        throw e;
      }
    }
    if (p === "/api/razieli") return send(res, 200, await razieliData(!!body.refresh));
    if (p === "/api/doc") {
      const clean = DOCS[body.path];
      if (!clean) return fail(res, 404, "not_found", "No such document.");
      if (!STORE.editors.has(who.email)) return fail(res, 403, "invalid_argument", "You can view this but not change it.");
      const data = {...clean(body.data), updatedAt: Date.now(), updatedBy: who.email};
      // without the generation it builds on, a save can only create the document, never replace one
      const gen = await docSet(body.path, data, /^\d+$/.test(String(body.gen)) ? String(body.gen) : "0");
      log("NOTICE", "document saved", {path: body.path, email: who.email, gen});
      return send(res, 200, {ok: true, data, gen});
    }
    if (p === "/api/snowflake/disconnect") return send(res, 200, {ok: true}, {"Set-Cookie": SNOW_LOGOUT});
    return fail(res, 404, "not_found", "No such API.");
  }

  if (m === "GET" && p === "/oauth/snowflake/start") {
    const app = await snowApp();
    if (!app) return send(res, 409, "Snowflake sign-in isn't set up for this app yet.");
    const state = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(48));
    const q = new URLSearchParams({client_id: app.id, response_type: "code", redirect_uri: `${baseUrl(req)}/oauth/snowflake/callback`, state,
      code_challenge: b64u(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
      scope: ["refresh_token", SNOW.role ? `session:role:${SNOW.role}` : ""].filter(Boolean).join(" ")});
    const c = await seal({state, verifier, email: who.email, exp: Date.now() + 600000});
    res.writeHead(302, {Location: `${SNOW.url}/oauth/authorize?${q}`, "Set-Cookie": setCookie("fd_sfo", c, 600, "/oauth/snowflake"), "Cache-Control": "no-store", ...SEC_HEADERS});
    return res.end();
  }
  if (m === "GET" && p === "/oauth/snowflake/callback") {
    const st = await unseal(cookies(req).fd_sfo), clear = setCookie("fd_sfo", "", 0, "/oauth/snowflake");
    const back = (msg, extra = []) => {
      res.writeHead(302, {Location: "/#snowflake=" + encodeURIComponent(msg), "Set-Cookie": [clear, ...extra], "Cache-Control": "no-store", ...SEC_HEADERS});
      res.end();
    };
    if (url.searchParams.get("error")) return back(url.searchParams.get("error_description") || url.searchParams.get("error"));
    const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
    if (!st || st.email !== who.email || !(st.exp > Date.now()) || !code || state.length !== st.state.length ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(st.state))) return back("The Snowflake sign-in expired. Try again.");
    const app = await snowApp();
    if (!app) return back("Snowflake sign-in isn't set up for this app yet.");
    let j;
    try { j = await snowToken({grant_type: "authorization_code", code, redirect_uri: `${baseUrl(req)}/oauth/snowflake/callback`, code_verifier: st.verifier}, app); }
    catch (e) { log("WARNING", "Snowflake code exchange failed", {email: who.email, err: e.message}); return back("Snowflake didn't accept the sign-in."); }
    // the Snowflake login (an email address at WSC) has to be the person who's signed in to Google
    if (j.username && String(j.username).toLowerCase() !== who.email) {
      log("WARNING", "Snowflake user doesn't match the Google user", {email: who.email, snowflake: j.username});
      return back(`You signed in to Snowflake as ${j.username}, not ${who.email}.`);
    }
    const now = Date.now(), atExp = now + (Number(j.expires_in) || 600) * 1000;
    const sess = {email: who.email, user: j.username || null, at: j.access_token, atExp, rt: j.refresh_token || "",
      rtExp: j.refresh_token ? now + (Number(j.refresh_token_expires_in) || 7776000) * 1000 : atExp};
    const sc = await snowCookies(sess);
    log("NOTICE", "Snowflake connected", {email: who.email, refresh: !!j.refresh_token, cookieBytes: sc.map(c => c.length)});
    return back("connected", sc);
  }
  return fail(res, 404, "not_found", "Not found.");
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    const status = e.status || 500, retryable = !!e.retryable;
    log(status >= 500 ? "ERROR" : "WARNING", "request failed", {path: String(req.url || "").split("?")[0], err: String(e && e.message || e)});
    if (res.headersSent) return res.end();
    fail(res, status, e.code || (retryable ? "server_unavailable" : "tool_error"), String(e && e.message || "Request failed."),
      {...(retryable ? {"Retry-After": "2"} : {}), ...(e.setCookie ? {"Set-Cookie": e.setCookie} : {})}, retryable);
  });
}).listen(PORT, () => log("INFO", `listening on ${PORT}`));
