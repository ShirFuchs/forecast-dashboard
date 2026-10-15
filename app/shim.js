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
  let sessionP = null, sessionAt = 0;
  const session = () => sessionP || (sessionAt = Date.now(), sessionP = api("/api/session").catch(e => { sessionP = null; throw e; }));
  // asked again (at most once a minute) when the page comes back into view, so edit rights follow the editor list without a reload
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - sessionAt > 60000) sessionP = null; });
  // The page's storage: the app keeps only Aviv's inputs (aviv/Q4-2026), on its server. Everything else the claude.ai version
  // stores (the shared copy for viewers without connectors) isn't needed here, so it reads as missing and can't be written.
  const DOCS = ["aviv/Q4-2026"];
  const snap = j => ({exists: !!j.exists, data: () => j.data});
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Applies what the page changed (from `base`, the version it last took, to `mine`) onto `latest`, the newest saved version:
  // deal calls by deal, added amounts by line id. Everyone else's changes in between stay.
  function rebase(base, mine, latest) {
    base = base || {}; latest = latest || {};
    const calls = {...(latest.calls || {})}, bc = base.calls || {}, mc = mine.calls || {};
    for (const id of new Set([...Object.keys(bc), ...Object.keys(mc)])) {
      if (same(bc[id], mc[id])) continue;
      if (mc[id] === undefined) delete calls[id]; else calls[id] = mc[id];
    }
    const out = {calls};
    if (Array.isArray(mine.adds) || Array.isArray(base.adds)) {
      const ba = new Map((base.adds || []).map(a => [a.id, a])), ma = new Map((mine.adds || []).map(a => [a.id, a]));
      let adds = Array.isArray(latest.adds) ? latest.adds.slice() : [];
      for (const id of ba.keys()) if (!ma.has(id)) adds = adds.filter(a => a.id !== id);
      for (const [id, a] of ma) {
        if (same(ba.get(id), a)) continue;
        const i = adds.findIndex(x => x.id === id);
        if (i >= 0) adds[i] = a; else adds.push(a);
      }
      out.adds = adds;
    } else if (latest.adds !== undefined) out.adds = latest.adds;
    return out;
  }
  const docs = {}; // path -> {gen, latest: newest saved version known, base: the version the page last took, ticks}
  const db = {
    doc(path) {
      const ours = DOCS.includes(path);
      const st = docs[path] = docs[path] || {gen: "0", latest: null, base: null, ticks: new Set()};
      // the saved version; an answer older than one already seen (a read that crossed a save) is dropped
      const read = async () => {
        const j = await api("/api/doc?path=" + encodeURIComponent(path));
        if (Number(j.gen) < Number(st.gen)) return null;
        st.gen = j.gen; st.latest = j.exists ? j.data : null;
        return j;
      };
      return {
        async get() {
          if (!ours) return snap({exists: false});
          const j = (await read()) || {exists: st.latest != null, data: st.latest};
          st.base = j.data || null;
          return snap(j);
        },
        // saves the page's changes on top of the newest version; when someone saved in between, reads theirs and merges
        async set(data) {
          if (!ours) throw {code: "invalid_argument", message: "Not stored in the app."};
          for (let attempt = 0; ; attempt++) {
            const target = rebase(st.base, data, st.latest);
            try {
              const r = await api("/api/doc", {path, data: target, gen: st.gen});
              // the page now holds `data`; its next changes are measured from there
              st.gen = r.gen; st.latest = r.data; st.base = data;
              // show the page what others added, once its own save is done
              if (!same(target.calls, data.calls) || !same(target.adds, data.adds)) setTimeout(() => st.ticks.forEach(t => t()), 300);
              return;
            } catch (e) {
              if (!e || e.code !== "conflict" || attempt >= 3) throw e;
              await read();
            }
          }
        },
        async delete() { throw {code: "invalid_argument", message: "Not stored in the app."}; },
        // the first read happens right away (retried every few seconds until it works); after that, other people's changes
        // show up within half a minute while the tab is visible, and at once when it becomes visible again
        onSnapshot(next, error) {
          if (!ours) { setTimeout(() => next(snap({exists: false})), 0); return () => {}; }
          let stop = false, timer = null, loaded = false, busy = false;
          const tick = async () => {
            if (stop || busy) return;
            clearTimeout(timer); busy = true;
            try {
              if (!loaded || !document.hidden) {
                const j = await read();
                if (j || !loaded) {
                  const s = j || {exists: st.latest != null, data: st.latest};
                  // the page says whether it took this version (it skips one while its own edit is being saved)
                  if (next(snap(s)) !== false) st.base = s.data || null;
                  loaded = true;
                }
              }
            } catch (e) { if (error) error(e); }
            busy = false;
            if (!stop) timer = setTimeout(tick, loaded ? 30000 : 5000);
          };
          const onShow = () => { if (!document.hidden) tick(); };
          document.addEventListener("visibilitychange", onShow);
          st.ticks.add(tick);
          timer = setTimeout(tick, 0);
          return () => { stop = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onShow); st.ticks.delete(tick); };
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
