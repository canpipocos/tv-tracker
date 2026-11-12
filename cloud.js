// Stands in for the Mac server: the page's /api/ calls are answered here, using GitHub and TVmaze.
window.cloud = (() => {
  const REPO = "https://api.github.com/repos/canpipocos/tv-series";
  const TOKEN = "tv-token", OUTBOX = "tv-outbox";
  const realFetch = window.fetch.bind(window);
  const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const pad = n => String(n).padStart(2, "0");
  const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => iso(new Date());
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const encode = text => { let b = ""; new TextEncoder().encode(text).forEach(c => b += String.fromCharCode(c)); return btoa(b); };
  const decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

  let baseText = null, trackerSha = null, pendingSha = null, pending = [], state = null;
  let syncing = false, flushing = null, signedIn = null, notice = null;

  // Keep in step with apply_action in tracker.py, which makes these changes permanent.
  function newShow(name, id, genres) {
    return {name, status: "wait_list", csv_progress: "", csv_upcoming: "", csv_date: "", tvmaze_id: id, match: "ok",
            tvmaze_name: name, tvmaze_status: null, url: null, episodes: [], watched: [], seeded: false,
            watched_guess: false, genres};
  }
  function applyAction(s, a) {
    if (a.type === "alert-read") s.alerts = (s.alerts || []).filter(x => x.date !== a.date || x.text !== a.text);
    else if (a.type === "cancelled") s.cancellations = (s.cancellations || []).filter(c => c.name !== a.name);
    else if (a.type === "add") {
      if (s.shows.some(x => x.tvmaze_id === a.id)) return;
      const name = s.shows.some(x => x.name === a.name) ? `${a.name} (${(a.premiered || "").slice(0, 4)})` : a.name;
      s.shows.push(newShow(name, a.id, a.genres || []));
      s.recommendations = (s.recommendations || []).filter(r => r.id !== a.id);
    } else if (a.type === "rec") {
      const recs = s.recommendations || [], rec = recs.find(r => r.id === a.id);
      if (!rec) return;
      recs.splice(recs.indexOf(rec), 1);
      if (a.action === "add") s.shows.push(newShow(rec.name, rec.id, rec.genres));
      else (s.dismissed = s.dismissed || []).push({id: rec.id, name: rec.name, genres: rec.genres});
    } else if (a.type === "restore") {
      const removed = s.removed || [], show = removed.find(x => x.name === a.show);
      if (!show) return;
      removed.splice(removed.indexOf(show), 1);
      s.shows.push(show);
    } else {
      const show = s.shows.find(x => x.name === a.show);
      if (!show) return;
      if (a.type === "watch") {
        const ids = new Set(a.ids), current = new Set(show.watched);
        if (a.watched) {
          const d = new Date(a.today + "T12:00:00");
          d.setDate(d.getDate() - 7);
          const weekAgo = iso(d);
          const fresh = show.episodes.filter(e => ids.has(e.id) && !current.has(e.id) && weekAgo <= e.date && e.date <= a.today);
          show.fresh_ticks = (show.fresh_ticks || 0) + fresh.length;
          ids.forEach(i => current.add(i));
        } else ids.forEach(i => current.delete(i));
        show.watched = [...current].sort((x, y) => x - y);
      } else if (a.type === "status") show.status = a.status;
      else if (a.type === "remove") {
        s.shows.splice(s.shows.indexOf(show), 1);
        s.removed = [show, ...(s.removed || [])].slice(0, 10);
      }
    }
  }

  function showNotice(text) {
    if (!notice) {
      notice = document.createElement("div");
      notice.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:20;padding:10px 14px;border-radius:8px;font-size:14px;background:var(--warn);color:var(--ink)";
      document.body.append(notice);
    }
    notice.textContent = text;
    notice.hidden = !text;
  }

  async function gh(path, {raw, method, body} = {}) {
    const res = await realFetch(path.startsWith("http") ? path : REPO + path, {
      method: method || "GET", cache: "no-store", body: body ? JSON.stringify(body) : undefined,
      headers: {Authorization: "Bearer " + read(TOKEN, ""), Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"}});
    if (res.status === 401) { try { localStorage.removeItem(TOKEN); } catch (e) {} location.reload(); await new Promise(() => {}); }
    if (!res.ok) { const err = new Error("GitHub " + res.status); err.status = res.status; throw err; }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  }

  function askForKey(message) {
    return new Promise(resolve => {
      const box = document.createElement("form");
      box.style.cssText = "position:fixed;inset:0;z-index:30;display:grid;place-content:center;gap:10px;padding:24px;background:var(--bg);color:var(--ink)";
      box.innerHTML = `<h1>TV Tracker</h1><input type="password" autocomplete="off" placeholder="Access key" required style="font:inherit;padding:10px;width:min(320px,85vw)"><button style="padding:10px">Open</button><p class="muted" style="margin:0;max-width:320px"></p>`;
      box.querySelector("p").textContent = message || "";
      box.onsubmit = e => { e.preventDefault(); const key = box.querySelector("input").value.trim(); box.remove(); resolve(key); };
      document.body.append(box);
    });
  }

  // The last data seen on this phone, so the page opens at once and checks GitHub after.
  const CACHE = "tv-data";
  async function saveCache() {
    try {
      const c = await caches.open(CACHE);
      await c.put("/tv/tracker", new Response(baseText, {headers: {"X-Sha": trackerSha || ""}}));
      await c.put("/tv/pending", new Response(JSON.stringify({sha: pendingSha, list: pending})));
    } catch (e) {}  // no cache: it just loads the slow way next time
  }
  async function loadCache() {
    try {
      const c = await caches.open(CACHE);
      const [t, p] = await Promise.all([c.match("/tv/tracker"), c.match("/tv/pending")]);
      if (!t || !p) return false;
      const saved = await p.json();
      baseText = await t.text();
      trackerSha = t.headers.get("X-Sha") || null;
      pendingSha = saved.sha;
      pending = saved.list || [];
      rebuild();
      return true;
    } catch (e) { return false; }
  }

  async function signIn() {
    if (read(TOKEN, "") && await loadCache()) {  // a bad key still gets caught: gh() asks for it again on 401
      refresh(false).then(changed => { if (changed && window.cloudUpdate) window.cloudUpdate(current()); }).catch(() => {});
      return;
    }
    let message = "";
    while (true) {
      if (!read(TOKEN, "")) { const key = await askForKey(message); write(TOKEN, key); }
      const res = await realFetch(REPO, {cache: "no-store", headers: {Authorization: "Bearer " + read(TOKEN, "")}});
      if (res.ok) break;
      if (res.status !== 401 && res.status !== 403 && res.status !== 404) throw new Error("GitHub " + res.status);
      try { localStorage.removeItem(TOKEN); } catch (e) {}
      message = "That key didn't work. Check it and try again.";
    }
    await refresh(true);
  }

  function rebuild() {
    const s = JSON.parse(baseText), applied = new Set(s.applied_actions || []), seen = new Set();
    for (const a of [...pending, ...read(OUTBOX, [])]) {
      if (applied.has(a.uid) || seen.has(a.uid)) continue;
      seen.add(a.uid);
      applyAction(s, a);
    }
    state = s;
  }

  // One listing gives the current version of both files from the same commit, so a sync folding in saved
  // changes can never make one vanish. Files are downloaded only when they changed. web.json is the slim
  // copy the sync writes for this page; tracker.json is the fallback.
  async function refresh(force) {
    const files = await gh("/contents");
    const sha = name => (files.find(f => f.name === name) || {}).sha;
    const dataSha = sha("web.json") || sha("tracker.json"), newPending = sha("pending.json");
    const changed = force || dataSha !== trackerSha || newPending !== pendingSha;
    const [p, t] = await Promise.all([
      force || newPending !== pendingSha ? (newPending ? gh("/git/blobs/" + newPending, {raw: true}) : "[]") : null,
      force || dataSha !== trackerSha ? gh("/git/blobs/" + dataSha, {raw: true}) : null]);
    if (p !== null) { pending = JSON.parse(p); pendingSha = newPending; }
    if (t !== null) { baseText = t; trackerSha = dataSha; }
    if (changed) { rebuild(); saveCache(); }
    return changed;
  }

  async function saveOutbox() {
    let items;
    while ((items = read(OUTBOX, [])).length) {
      for (let attempt = 0; ; attempt++) {
        try {
          let list = [], sha;
          try { const meta = await gh("/contents/pending.json"); sha = meta.sha; list = JSON.parse(decode(meta.content)); }
          catch (e) { if (e.status !== 404) throw e; }
          const have = new Set(list.map(a => a.uid));
          const merged = list.concat(items.filter(a => !have.has(a.uid)));
          const saved = await gh("/contents/pending.json", {method: "PUT", body: {message: "Save changes", content: encode(JSON.stringify(merged)), sha}});
          pendingSha = saved.content.sha;
          pending = merged;
          break;
        } catch (e) {
          if ((e.status !== 409 && e.status !== 422) || attempt >= 6) throw e;
          await pause(400 * (attempt + 1));
        }
      }
      const done = new Set(items.map(a => a.uid));
      write(OUTBOX, read(OUTBOX, []).filter(a => !done.has(a.uid)));
    }
  }

  function flush() {
    if (!flushing) flushing = saveOutbox()
      .then(() => showNotice(""))
      .catch(e => { showNotice("Couldn't save your last change yet. Trying again…"); setTimeout(flush, 15000); throw e; })
      .finally(() => { flushing = null; });
    return flushing;
  }

  async function runSync() {
    if (syncing) return;
    syncing = true;
    try {
      await flush();
      const url = "/actions/workflows/sync.yml/runs?event=workflow_dispatch&per_page=1";
      const before = ((await gh(url)).workflow_runs[0] || {}).id;
      await gh("/actions/workflows/sync.yml/dispatches", {method: "POST", body: {ref: "main"}});
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await pause(4000);
        const run = (await gh(url)).workflow_runs[0];
        if (run && run.id !== before && run.status === "completed") {
          if (run.conclusion !== "success") showNotice("The update didn't finish. Try again in a bit.");
          await refresh(true);
          break;
        }
      }
    } catch (e) { showNotice("Couldn't check for updates. Try again in a bit."); }
    syncing = false;
  }

  function current() { return Object.assign({}, state, {syncing, today: today()}); }
  const reply = (body, status) => new Response(JSON.stringify(body), {status: status || 200, headers: {"Content-Type": "application/json"}});

  function act(action, thenSync) {
    action.uid = crypto.randomUUID();
    write(OUTBOX, [...read(OUTBOX, []), action]);
    rebuild();
    const saved = flush();
    saved.catch(() => {});
    if (thenSync) { syncing = true; saved.catch(() => {}).finally(() => { syncing = false; runSync(); }); }
  }

  async function search(query) {
    const res = await realFetch("https://api.tvmaze.com/search/shows?q=" + encodeURIComponent(query));
    const tracked = new Set(state.shows.map(s => s.tvmaze_id));
    return (await res.json()).map(({show}) => ({
      id: show.id, name: show.name, year: (show.premiered || "").slice(0, 4),
      channel: (show.webChannel || show.network || {}).name || "", status: show.status || "",
      poster: (show.image || {}).medium, tracked: tracked.has(show.id)}));
  }

  window.fetch = async (url, options) => {
    if (typeof url !== "string" || !url.startsWith("/api/")) return realFetch(url, options);
    await signedIn;
    if (url === "/api/state") return reply(current());
    if (url === "/api/syncing") return reply({syncing});
    if (url.startsWith("/api/search?")) return reply(await search(new URLSearchParams(url.split("?")[1]).get("q") || ""));
    const data = JSON.parse((options && options.body) || "{}");
    if (url === "/api/sync") { runSync(); return reply(current()); }
    if (url === "/api/watch") act({type: "watch", show: data.show, ids: data.ids, watched: data.watched, today: today()});
    else if (url === "/api/status") act({type: "status", show: data.show, status: data.status});
    else if (url === "/api/remove") act({type: "remove", show: data.show});
    else if (url === "/api/restore") act({type: "restore", show: data.show});
    else if (url === "/api/alert-read") act({type: "alert-read", date: data.date, text: data.text});
    else if (url === "/api/cancelled") act({type: "cancelled", name: data.name});
    else if (url === "/api/rec") act({type: "rec", id: data.id, action: data.action}, data.action === "add");
    else if (url === "/api/add") {
      const info = await (await realFetch("https://api.tvmaze.com/shows/" + Number(data.id))).json();
      act({type: "add", id: info.id, name: info.name, premiered: info.premiered, genres: info.genres || []}, true);
    } else return reply({}, 404);
    return reply(current());
  };

  async function checkForNews() {
    flush().catch(() => {});
    if (syncing || !state || document.hidden) return;
    try { if (await refresh(false) && window.cloudUpdate) window.cloudUpdate(current()); } catch (e) {}
  }
  document.addEventListener("visibilitychange", checkForNews);
  window.addEventListener("online", checkForNews);
  setInterval(checkForNews, 300000);

  signedIn = signIn().catch(() => { showNotice("Couldn't reach GitHub. Check your connection and reload."); throw new Error("offline"); });
  return {applyAction};
})();
