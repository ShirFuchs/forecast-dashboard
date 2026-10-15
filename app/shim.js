// Loaded only by the Cloud Run app, before the dashboard's own script. It stands in for the claude.ai runtime
// (window.claude.use) so the same index.html runs unchanged: Salesforce and Snowflake calls go to this app's server,
// downloads are plain browser downloads, and there is no shared copy (everyone reads live data here).
(function () {
  "use strict";
  async function api(path, body) {
    // X-Requested-With makes Google sign-in (IAP) answer an expired session with 401 instead of a redirect to its sign-in page
    const base = {credentials: "same-origin", redirect: "manual", headers: {"X-FD": "1", "X-Requested-With": "XMLHttpRequest"}};
    let r;
    try {
      r = await fetch(path, body === undefined ? base
        : {...base, method: "POST", headers: {...base.headers, "Content-Type": "application/json"}, body: JSON.stringify(body)});
    } catch (e) {
      throw {code: "server_unavailable", message: "The dashboard server can't be reached.", retryable: true};
    }
    // the server never redirects its API, so a redirect (or a 401) means the Google sign-in has run out
    if (r.type === "opaqueredirect" || r.status === 0 || r.status === 401) {
      let j = null;
      try { j = r.status === 401 ? await r.json() : null; } catch (e) {}
      if (!j || j.code === "unauthenticated") throw {code: "unauthenticated", message: "Your Google sign-in has expired. Reload the page to sign in again."};
      throw {code: j.code || "tool_error", message: j.message || "Not signed in."};
    }
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (r.ok && j) return j;
    const retryable = !!(j && j.retryable) || r.status === 429 || r.status === 503;
    throw {code: (j && j.code) || (retryable ? "server_unavailable" : "tool_error"), message: (j && j.message) || `The dashboard server answered ${r.status}.`, retryable,
      retryAfterMs: retryable ? (Number(r.headers.get("Retry-After")) || 2) * 1000 : undefined};
  }
  const mcp = {
    async callTool(server, tool, args, opts) {
      const refresh = !!(opts && opts.cache && opts.cache.refresh);
      if (server === "SalesForce Read Only" && tool === "soqlQuery") {
        const j = await api("/api/sf/query", {q: args.q, refresh});
        return {payload: {records: j.records}, cache: {storedAt: j.storedAt}};
      }
      if (server === "Snowflake" && tool === "sql_exec") return {payload: await api("/api/snowflake/query", {sql: args.sql})};
      throw {code: "not_in_manifest", message: `${server} isn't available in the app.`};
    }
  };
  const downloads = {
    async save({filename, data}) {
      const url = URL.createObjectURL(new Blob([data], {type: /\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : "application/octet-stream"}));
      const a = Object.assign(document.createElement("a"), {href: url, download: filename});
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };
  let sessionP = null;
  const session = () => sessionP || (sessionP = api("/api/session").catch(e => { sessionP = null; throw e; }));
  // The page's storage: the app keeps only Aviv's inputs (aviv/Q4-2026), on its server. Everything else the claude.ai version
  // stores (the shared copy for viewers without connectors) isn't needed here, so it reads as missing and can't be written.
  const DOCS = ["aviv/Q4-2026"];
  const snap = j => ({exists: !!j.exists, data: () => j.data});
  const db = {
    doc(path) {
      const ours = DOCS.includes(path);
      const get = async () => ours ? snap(await api("/api/doc?path=" + encodeURIComponent(path))) : snap({exists: false});
      return {
        get,
        async set(data) {
          if (!ours) throw {code: "invalid_argument", message: "Not stored in the app."};
          await api("/api/doc", {path, data});
        },
        async delete() { throw {code: "invalid_argument", message: "Not stored in the app."}; },
        // other viewers' changes show up within half a minute
        onSnapshot(next, error) {
          let stop = false, timer = null;
          const tick = async () => {
            if (stop) return;
            try { if (!document.hidden) next(await get()); } catch (e) { if (error) error(e); }
            if (!stop) timer = setTimeout(tick, 30000);
          };
          timer = setTimeout(tick, 0);
          return () => { stop = true; clearTimeout(timer); };
        }
      };
    }
  };
  // who is viewing: never the claude.ai owner or an editor (so no shared-copy controls), but may change Aviv's inputs when listed
  const user = {
    isOwner: () => false,
    canEdit: () => false,
    can: async perm => perm === "data.write" && !!(await session()).canEditDocs,
    id: async () => (await session()).email
  };
  window.FD_APP = {
    razieli: refresh => api("/api/razieli", {refresh: !!refresh}),
    session,
    disconnectSnowflake: () => api("/api/snowflake/disconnect", {})
  };
  window.claude = {use: async name => ({mcp, downloads, db, user})[name] || null};
})();
