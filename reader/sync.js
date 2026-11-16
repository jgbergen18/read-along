'use strict';
/* Read-Along sync: keeps reading progress, bookmarks, highlights/notes, listening time and "finished"
 * the same on the laptop and the offline phone app, through a private GitHub repository (one small
 * JSON file per book). Never the books themselves.
 *
 *  - SyncCore: normalize/merge rules. Must match syncer.py on the laptop exactly.
 *  - GH: tiny client for GitHub's contents API.
 *  - PhoneSync: the offline phone app's background sync (the laptop's runs in syncer.py).
 *  - the Sync dialog for both: setup (laptop: paste a GitHub key; phone: scan the laptop's QR code).
 */
const SYNC_API = 'https://api.github.com';
// changes are sent 20 s after the last one, right away when a reading session ends, and at least every
// 5 minutes while you keep listening; news from the other devices is fetched every 5 minutes
const SYNC_QUIET = 20000, SYNC_MAX_DELAY = 300000, SYNC_PULL_EVERY = 300000;

// ================================================================ merge rules (mirror of syncer.py)
// Must give exactly the same answers as syncer.py: only real (finite) numbers count, text compares by
// UTF-16 code units (JavaScript's own order), and ties are broken by the whole item.
const SyncCore = {
  dv: new DataView(new ArrayBuffer(8)),
  num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : 0; },
  isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); },
  // a text form of a JSON value, identical to syncer._canon; only used to break ties
  canon(v) {
    if (v === null || v === undefined) return 'n';
    if (typeof v === 'boolean') return v ? 't' : 'f';
    if (typeof v === 'number') {                      // the exact 64-bit value, as hex (-0 counts as 0)
      SyncCore.dv.setFloat64(0, SyncCore.num(v) + 0);
      let h = 'd';
      for (let i = 0; i < 8; i++) h += SyncCore.dv.getUint8(i).toString(16).padStart(2, '0');
      return h;
    }
    if (typeof v === 'string') return 's' + v.length + ':' + v;
    if (Array.isArray(v)) return '[' + v.map((x) => SyncCore.canon(x)).join('') + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
        .map((k) => SyncCore.canon(k) + SyncCore.canon(v[k])).join('') + '}';
    }
    return 'n';
  },
  stamp(x) { return SyncCore.num(x.updated) || SyncCore.num(x.created); },
  itemKey(x) { return [SyncCore.stamp(x), x.deleted ? 1 : 0, SyncCore.canon(x)]; },
  posKey(p) { return [SyncCore.num(p.updated), SyncCore.num(p.time), SyncCore.canon(p)]; },
  cmp(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; },
  validItem(x) { return SyncCore.isObj(x) && typeof x.id === 'string' && x.id !== ''; },

  // one version per item (the newest; a deletion wins a tie), in a fixed order
  combine(items) {
    const best = new Map();
    for (const x of items) {
      const cur = best.get(x.id);
      if (!cur || SyncCore.cmp(SyncCore.itemKey(x), SyncCore.itemKey(cur)) > 0) best.set(x.id, x);
    }
    return [...best.values()].sort((x, y) => (SyncCore.num(x.created) - SyncCore.num(y.created))
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  },

  normalize(st, replica) {
    st = SyncCore.isObj(st) ? st : {};
    const out = { position: SyncCore.isObj(st.position) ? st.position : null };
    if (st.id) out.id = st.id;
    for (const kind of ['bookmarks', 'highlights']) {
      out[kind] = SyncCore.combine((Array.isArray(st[kind]) ? st[kind] : []).filter(SyncCore.validItem)
        .map((x) => (SyncCore.num(x.updated) ? { ...x } : { ...x, updated: SyncCore.num(x.created) })));
    }
    let listened = SyncCore.isObj(st.listened) ? st.listened : {};
    const vals = Object.values(listened);
    if (vals.length && vals.every((v) => !SyncCore.isObj(v))) listened = { [replica]: listened };   // older format
    out.listened = Object.create(null);              // plain maps: names like "constructor" are just names
    for (const [r, days] of Object.entries(listened)) {
      if (!SyncCore.isObj(days)) continue;
      out.listened[r] = Object.create(null);
      for (const [d, s] of Object.entries(days)) out.listened[r][d] = SyncCore.num(s);
    }
    out.finished = SyncCore.num(st.finished) || null;
    out.finishedUpdated = SyncCore.num(st.finishedUpdated) || SyncCore.num(st.finished);
    return out;
  },

  // combine two normalized states; order-independent, and merging something already included changes nothing
  merge(a, b) {
    const out = {};
    if (a.id || b.id) out.id = a.id || b.id;
    const pa = a.position || null, pb = b.position || null;
    out.position = pb == null ? pa : pa == null ? pb : (SyncCore.cmp(SyncCore.posKey(pa), SyncCore.posKey(pb)) >= 0 ? pa : pb);
    for (const kind of ['bookmarks', 'highlights']) out[kind] = SyncCore.combine([...(a[kind] || []), ...(b[kind] || [])]);
    const listened = Object.create(null);
    for (const src of [a, b]) {
      for (const [rep, days] of Object.entries(src.listened || {})) {
        const d = listened[rep] || (listened[rep] = Object.create(null));
        for (const [day, s] of Object.entries(days)) d[day] = Math.max(d[day] || 0, SyncCore.num(s));
      }
    }
    out.listened = listened;
    const ka = [SyncCore.num(a.finishedUpdated), SyncCore.num(a.finished)];
    const kb = [SyncCore.num(b.finishedUpdated), SyncCore.num(b.finished)];
    const win = SyncCore.cmp(ka, kb) >= 0 ? a : b;
    out.finished = SyncCore.num(win.finished) || null;
    out.finishedUpdated = SyncCore.num(win.finishedUpdated);
    return out;
  },

  isEmpty(st) {
    return !(st.position || (st.bookmarks || []).length || (st.highlights || []).length
      || Object.keys(st.listened || {}).length || st.finished || st.finishedUpdated);
  },

  // equal as saved data (JSON drops undefined; 1 == 1.0), ignoring the local-only "id"
  same(a, b) {
    const plain = (o) => { const c = JSON.parse(JSON.stringify(o || {})); delete c.id; return c; };
    const eq = (x, y) => {
      if (x === y) return true;
      if (typeof x === 'number' && typeof y === 'number') return x === y;
      if (!x || !y || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x) !== Array.isArray(y)) return false;
      const kx = Object.keys(x), ky = Object.keys(y);
      return kx.length === ky.length && kx.every((k) => Object.prototype.hasOwnProperty.call(y, k) && eq(x[k], y[k]));
    };
    return eq(plain(a), plain(b));
  },

  // JSON with sorted keys (like the laptop writes), so files don't churn between devices
  stringify(o) {
    const sort = (v) => (Array.isArray(v) ? v.map(sort) : SyncCore.isObj(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
    return JSON.stringify(sort(o), null, 1);
  },
};

// ================================================================ GitHub contents API
const b64enc = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(String(b64 || '').replace(/\s/g, '')), (c) => c.charCodeAt(0)));

const GH = {
  async call(cfg, method, path, body, timeoutMs) {
    const ctl = timeoutMs ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    // reads get a unique address too, in case a browser ignores "no-store" (GitHub allows 60 s of caching)
    const bust = method === 'GET' ? `${path.includes('?') ? '&' : '?'}_=${Date.now().toString(36)}` : '';
    try {
      const r = await fetch(`${cfg.api || SYNC_API}/repos/${cfg.repo}${path ? '/' + path : ''}${bust}`, {
        method, cache: 'no-store', signal: ctl ? ctl.signal : undefined,
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await r.json(); } catch { /* empty */ }
      return { status: r.status, data };
    } finally { if (t) clearTimeout(t); }
  },
  fail(r, what) {
    const detail = r.data && typeof r.data.message === 'string' ? r.data.message : '';
    const e = new Error(`GitHub answered ${r.status} ${what}${detail ? ': ' + detail : ''}`);
    e.status = r.status; e.detail = detail;
    return e;
  },
  bookPath(id) { return 'contents/books/' + encodeURIComponent(id + '.json'); },
  async getBook(cfg, id, timeoutMs) {
    const r = await GH.call(cfg, 'GET', GH.bookPath(id), null, timeoutMs);
    if (r.status === 404) return [null, null];
    if (r.status !== 200 || !SyncCore.isObj(r.data)) throw GH.fail(r, `reading ${id}`);
    let content = r.data.content || '';
    if (!content && (r.data.size || 0) > 0) {                       // over 1 MB: the contents API leaves it out
      const b = await GH.call(cfg, 'GET', 'git/blobs/' + r.data.sha, null, Math.max(timeoutMs || 0, 15000));
      if (b.status !== 200 || !b.data || !b.data.content) throw GH.fail(b, `reading ${id}`);   // never overwrite it
      content = b.data.content;
    }
    let st;
    try { st = JSON.parse(b64dec(content) || '{}'); } catch { st = {}; }   // damaged: gets replaced
    return [SyncCore.isObj(st) ? st : {}, r.data.sha];
  },
  async putBook(cfg, id, state, sha, message) {
    const body = { message, content: b64enc(SyncCore.stringify(state)) };
    if (sha) body.sha = sha;
    const r = await GH.call(cfg, 'PUT', GH.bookPath(id), body);
    if ((r.status === 200 || r.status === 201) && r.data && r.data.content) return r.data.content.sha;
    if (r.status === 409 || r.status === 422) return null;            // changed meanwhile: re-read and merge again
    throw GH.fail(r, `saving ${id}`);
  },
  async listBooks(cfg) {
    const r = await GH.call(cfg, 'GET', 'contents/books');
    if (r.status === 404) return {};
    if (r.status !== 200 || !Array.isArray(r.data)) throw GH.fail(r, 'listing books');
    const out = {};
    for (const x of r.data) if (String(x.name).endsWith('.json')) out[x.name.slice(0, -5)] = x.sha;
    return out;
  },
  // a short explanation for the Sync dialog (same wording as syncer.friendly_error)
  friendly(e) {
    const status = e && e.status;
    if (!status) {
      return (e && (e.name === 'TypeError' || e.name === 'AbortError'))
        ? 'Can’t reach GitHub right now (no internet?). It will try again.' : String((e && e.message) || e).slice(0, 300);
    }
    if ((status === 403 || status === 429) && /rate limit/i.test(e.detail || '')) return 'GitHub asked to slow down for a while. It will try again.';
    if (status === 401) return 'GitHub no longer accepts the sync key (it may have expired or been deleted). Turn sync off and set it up again.';
    if (status === 403 || status === 404) return 'The sync key can’t use the sync repository any more. Turn sync off and set it up again.';
    if (status >= 500) return 'GitHub is having trouble right now. It will try again.';
    return String(e.message).slice(0, 300);
  },
};

// ================================================================ phone (offline app) sync
const PhoneSync = {
  cfg: null, shas: {}, dirty: {}, ver: {}, lastPull: 0, running: null, again: null, changed: false,
  pulls: {},              // book id -> fetch of the newest progress still under way (opening a book)
  status: { lastSync: null, lastError: null, syncing: false },

  configured() { return !!(this.cfg && this.cfg.token && this.cfg.repo); },

  async init() {
    try {
      this.cfg = (await LocalDB.get('meta', 'sync')) || null;
      const m = (await LocalDB.get('meta', 'syncState')) || {};
      this.shas = m.shas || {};
      this.dirty = m.dirty || {};
    } catch { /* storage unavailable */ }
    window.addEventListener('online', () => this.run({ pull: true, force: true }));   // back online: catch up now
    // leaving the app: send changes now; coming back: get the other devices' news
    document.addEventListener('visibilitychange', () => (document.hidden ? this.run({ force: true }) : this.run({ pull: true })));
    window.addEventListener('pagehide', () => this.run({ force: true }));
    setInterval(() => this.run(), 10000);
    if (this.configured()) setTimeout(() => this.run({ pull: true }), 1500);
  },

  persist() { return LocalDB.put('meta', { shas: this.shas, dirty: this.dirty }, 'syncState').catch(() => {}); },

  mark(id) {
    if (!this.configured()) return;
    const now = Date.now();
    this.dirty[id] = [this.dirty[id] ? this.dirty[id][0] : now, now];
    this.ver[id] = (this.ver[id] || 0) + 1;
    this.persist();
  },

  // the repository has everything up to change number seenVer: clear the "to send" mark unless
  // something changed since then
  clean(id, seenVer) { if ((this.ver[id] || 0) === seenVer) delete this.dirty[id]; },

  run(opts = {}) {
    if (!this.configured() || !navigator.onLine) return Promise.resolve();
    if (this.running) {                                     // remember what was asked, do it right after
      this.again = { force: !!(opts.force || (this.again && this.again.force)), pull: !!(opts.pull || (this.again && this.again.pull)) };
      return this.running;
    }
    this.running = (async () => {
      this.status.syncing = true; SyncUI.render();
      const errors = [];
      try {
        if (Local.pending.size) await Promise.allSettled([...Local.pending]);   // changes being saved this moment
        let did = false;                                       // did this pass talk to GitHub at all?
        if (opts.pull || Date.now() - this.lastPull > SYNC_PULL_EVERY) {
          did = true;
          try { await this.full(); } catch (e) { errors.push(e); }
        }
        const now = Date.now();
        const due = Object.entries(this.dirty)
          .filter(([, [first, last]]) => opts.force || now - last >= SYNC_QUIET || now - first >= SYNC_MAX_DELAY);
        const onDevice = new Set(due.length ? (await LocalDB.all('books')).map((b) => b.id) : []);
        did = did || due.length > 0;
        for (const [id] of due) {
          try {
            if (!onDevice.has(id) && !(await LocalDB.get('state', id))) { delete this.dirty[id]; continue; }
            await this.syncBook(id, true);           // (also books no longer on this phone: their notes still sync)
          } catch (e) { errors.push(e); }
        }
        if (errors.length) throw errors[0];
        if (did) { this.status.lastSync = Date.now(); this.status.lastError = null; }
      } catch (e) {
        this.status.lastError = GH.friendly(e);
      } finally {
        this.status.syncing = false;
        await this.persist();
        this.running = null;
        SyncUI.render();
        if (this.changed) { this.changed = false; SyncUI.refreshViews(); }
        const next = this.again; this.again = null;
        if (next) this.run(next);
      }
    })();
    return this.running;
  },

  // merge the repository copy into ours; save ours back if it has anything new
  async syncBook(id, push = true, timeoutMs) {
    let changedLocal = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, 500 * attempt));   // someone else is saving
      const [remote, sha] = await GH.getBook(this.cfg, id, timeoutMs);
      const replica = await Local.replica();
      let merged = null, seenVer = 0;
      await Local.withLock(id, async () => {
        seenVer = this.ver[id] || 0;                            // read together with the local copy
        const local = await Local.state(id);
        merged = remote ? SyncCore.merge(local, SyncCore.normalize(remote, replica)) : local;
        merged.id = id;
        if (!SyncCore.same(merged, local)) { await Local.saveRaw(id, merged); changedLocal = true; this.changed = true; }
      });
      if (remote && SyncCore.same(merged, SyncCore.normalize(remote, replica))) {
        if (sha) this.shas[id] = sha;                          // in sync at this version: full passes may skip it
        this.clean(id, seenVer); return changedLocal;
      }
      if (!remote && SyncCore.isEmpty(merged)) { delete this.shas[id]; this.clean(id, seenVer); return changedLocal; }
      if (!push) { this.mark(id); return changedLocal; }       // a quick fetch: send our news later, never drop it
      const { id: _drop, ...toSave } = merged;
      const pos = merged.position || {};
      let newSha;
      try {
        newSha = await GH.putBook(this.cfg, id, toSave, sha, `${id}: reading progress from ${pos.device || deviceName()}`);
      } catch (e) { delete this.shas[id]; throw e; }          // not saved: the next full pass must look again
      if (newSha) { this.shas[id] = newSha; this.clean(id, seenVer); return changedLocal; }
    }
    delete this.shas[id];
    throw new Error(`could not save ${id}: it kept changing`);
  },

  // every book in the repository (also ones not on this phone: their progress and listening time show
  // here too, and are ready when the book is added) plus every book on this phone
  async full() {
    const remote = await GH.listBooks(this.cfg);
    const errors = [];
    const ids = new Set([...(await LocalDB.all('books')).map((b) => b.id), ...Object.keys(remote)]);
    for (const id of ids) {
      if (!id || id.length > 120 || /[\\/:*?"<>|]/.test(id)) continue;
      if (remote[id] && remote[id] === this.shas[id] && !this.dirty[id]) continue;
      try { await this.syncBook(id, true); } catch (e) { errors.push(e); }
    }
    this.lastPull = Date.now();
    if (errors.length) throw errors[0];
  },

  // when a book is opened: get the newest progress quickly (best effort)
  // the fetch itself is never cut short: if it takes longer than waitMs, the book opens with what's on the
  // phone, and the late answer still arrives (the reader then offers the newer place)
  async pullBook(id, waitMs = 4000) {
    if (!this.configured() || !navigator.onLine) return;
    const p = this.pulls[id] || (this.pulls[id] = this.syncBook(id, false, 30000).catch(() => {})
      .then(() => { delete this.pulls[id]; }));
    await Promise.race([p, new Promise((res) => setTimeout(res, waitMs))]);
  },

  async connect(code) {
    const m = /RA-SYNC:(\{[\s\S]*\})/.exec(String(code || '').trim());
    if (!m) throw new Error('That isn’t a Read-Along sync code. Show the code from the laptop app (Sync → Show code for your phone).');
    let p;
    try { p = JSON.parse(m[1]); } catch { throw new Error('The code is damaged; try again.'); }
    if (!p || typeof p.r !== 'string' || typeof p.t !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(p.r)) throw new Error('The code is damaged; try again.');
    // GitHub itself; a different address is only accepted for a test server on this computer
    const testApi = typeof p.a === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(p.a);
    const cfg = { repo: p.r, token: p.t, api: testApi ? p.a : SYNC_API };
    let r;
    try { r = await GH.call(cfg, 'GET', '', null, 15000); } catch (e) { throw new Error(GH.friendly(e)); }
    if (r.status === 401) throw new Error('GitHub didn’t accept this key. Make a new code on the laptop and try again.');
    if (r.status !== 200) throw new Error(`This key can’t see ${cfg.repo} (GitHub answered ${r.status}).`);
    await LocalDB.put('meta', cfg, 'sync');
    this.cfg = cfg; this.shas = {}; this.lastPull = 0; this.status.lastError = null;
    for (const b of await LocalDB.all('books')) this.mark(b.id);   // send what's on this phone too,
    for (const st of await LocalDB.all('state')) if (st && st.id) this.mark(st.id);   // and kept data of removed books
    await this.persist();
    await this.run({ force: true, pull: true });
    if (this.status.lastError) throw new Error(this.status.lastError);
  },

  // a book is being removed from this phone: send its unsent reading data first. Returns false when
  // that wasn't possible (no internet...): then its reading data must be kept, and is sent later
  async forget(id) {
    if (!this.configured()) return true;
    if (this.dirty[id] && navigator.onLine) {
      try { await Promise.race([this.syncBook(id, true, 8000), new Promise((res) => setTimeout(res, 9000))]); } catch { /* sent later */ }
    }
    return !this.dirty[id];
  },

  async disconnect() {
    await LocalDB.del('meta', 'sync');
    try {                     // reading data of books not on this phone came with sync: let it go, unless it was never sent
      const onDevice = new Set((await LocalDB.all('books')).map((b) => b.id));
      for (const st of await LocalDB.all('state')) {
        if (st && st.id && !onDevice.has(st.id) && !this.dirty[st.id]) await LocalDB.del('state', st.id);
      }
    } catch { /* ignore */ }
    this.cfg = null; this.shas = {};                           // (unsent changes stay marked: sent after reconnecting)
    this.status = { lastSync: null, lastError: null, syncing: false };
    await this.persist();
  },
};

// ================================================================ Sync dialog (laptop and phone)
const SyncUI = {
  laptopInfo: null,
  scanning: null,

  available() { return isLocal || OFFLINE; },

  async open() {
    $('#sync-error').hidden = true;
    $('#sync-dialog').hidden = false;
    $('#sync-phone').hidden = !OFFLINE;
    $('#sync-laptop').hidden = OFFLINE;
    if (!OFFLINE) await this.refreshLaptop();
    this.render();
  },

  close() { this.stopScan(); clearTimeout(this.pollTimer); $('#sync-dialog').hidden = true; },

  ago(ms) {
    if (!ms) return '';
    const s = (Date.now() - ms) / 1000;
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ms).toLocaleDateString();
  },

  statusText(st) {
    if (!st.configured) return 'Not set up yet.';
    if (st.syncing) return 'Syncing…';
    if (st.lastError) return 'Couldn’t sync: ' + st.lastError;
    return st.lastSync ? `In sync · last synced ${this.ago(st.lastSync)}` + (st.pending ? ` · ${st.pending} change${st.pending === 1 ? '' : 's'} waiting` : '') : 'Connected.';
  },

  async refreshLaptop() {
    try { this.laptopInfo = await (await api('api/sync')).json(); } catch { this.laptopInfo = null; }
  },

  render() {
    const btn = $('#btn-sync');
    if (btn) btn.hidden = !this.available();
    if ($('#sync-dialog').hidden) return;
    if (OFFLINE) {
      const st = { configured: PhoneSync.configured(), ...PhoneSync.status, pending: Object.keys(PhoneSync.dirty).length };
      $('#sync-phone-status').textContent = this.statusText(st);
      $('#sync-phone-setup').hidden = st.configured;
      $('#sync-phone-on').hidden = !st.configured;
      $('#sync-actions').hidden = !st.configured;
      if (st.configured && !st.syncing && !st.lastError && st.lastSync) this.showError('');   // recovered
    } else {
      const st = this.laptopInfo || { configured: false };
      $('#sync-laptop-status').textContent = this.statusText({ ...st, lastSync: st.lastSync ? st.lastSync * 1000 : null });
      $('#sync-laptop-setup').hidden = !!st.configured;
      $('#sync-laptop-on').hidden = !st.configured;
      $('#sync-actions').hidden = !st.configured;
      $('#sync-repo-name').textContent = (st.repo || '').split('/').pop() || 'read-along-sync';
      clearTimeout(this.pollTimer);                            // while a pass runs, keep the status fresh
      if (st.syncing) this.pollTimer = setTimeout(async () => { await this.refreshLaptop(); this.render(); }, 2500);
    }
    this.renderBooks();
  },

  // what's in sync: each book's latest place and where it came from
  async renderBooks() {
    const box = $('#sync-books');
    const on = OFFLINE ? PhoneSync.configured() : !!(this.laptopInfo && this.laptopInfo.configured);
    if (!box || !on || $('#sync-dialog').hidden) { if (box) box.hidden = true; return; }
    if (this.booksBusy) return;
    this.booksBusy = true;
    try {
      let rows;
      if (OFFLINE) {
        const here = await Local.books();
        const ids = new Set(here.map((b) => b.id));
        rows = here.map((b) => ({ title: b.title || b.id, pos: b.position, here: true }));
        for (const st of await LocalDB.all('state')) {
          if (st && st.id && !ids.has(st.id) && st.position) rows.push({ title: st.id, pos: st.position, here: false });
        }
      } else {
        rows = ((await (await api('api/books')).json()) || []).map((b) => ({ title: b.title || b.id, pos: b.position, here: true }));
      }
      const place = (p) => (p && p.time > 0
        ? `${p.chapter ? chapterLabel(p.chapter) + ' · ' : ''}${fmt(p.time)}${p.device ? ` · ${esc(p.device)}` : ''}${p.updated ? `, ${this.ago(p.updated)}` : ''}`
        : 'Not started');
      box.innerHTML = '<h4>In sync</h4>' + rows.map((r) => `<div class="sb-row"><b>${esc(r.title)}</b><span>${place(r.pos)}${r.here ? '' : ' · not on this phone'}</span></div>`).join('');
      box.hidden = !rows.length;
    } catch { /* ignore */ } finally { this.booksBusy = false; }
  },

  showError(msg) { const e = $('#sync-error'); e.hidden = !msg; e.textContent = msg || ''; },

  // news from the other devices arrived: refresh the library if it is showing (an open book refreshes
  // its notes by itself, and never jumps away from where you are reading)
  refreshViews() {
    try {
      if (!$('#library').hidden) showLibrary();
      else if (S.book) Shared.refresh();
    } catch { /* ignore */ }
  },

  // ---- laptop
  async laptopPost(body) {
    const r = await (await api('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' }, body: JSON.stringify(body) })).json();
    this.laptopInfo = r;
    this.showError(r.error);
    this.render();
    return r;
  },
  async connectLaptop() {
    const token = $('#sync-token').value.trim();
    if (!token) { this.showError('Paste the key you copied from GitHub.'); return; }
    $('#sync-connect').disabled = true;
    try {
      const r = await this.laptopPost({ token });
      if (!r.error) { $('#sync-token').value = ''; toast('Sync is on. Now connect your phone.'); this.showCode(); }
    } catch { this.showError('Could not change sync.'); } finally { $('#sync-connect').disabled = false; }
  },
  async showCode() {
    try {
      const r = await (await api('api/sync?code=1')).json();
      if (!r.code) return;
      const qr = qrcode(0, 'L');
      qr.addData(r.code);
      qr.make();
      $('#sync-qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      $('#sync-qr-wrap').hidden = false;
    } catch { /* ignore */ }
  },

  // ---- phone: scan the laptop's QR code with the camera
  async startScan() {
    if (this.scanning || this.starting) return;                // already on (or starting)
    this.showError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.showError('This browser can’t use the camera here; paste the code instead.'); return; }
    const attempt = {};                                        // this start; a Cancel/close (or a newer start) replaces it
    this.starting = attempt;
    $('#sync-scan').disabled = true;
    const video = $('#sync-video');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      if (this.starting === attempt) { this.starting = null; $('#sync-scan').disabled = false; }
      this.showError('Camera access was refused. Allow camera access for Read-Along, or paste the code instead.');
      return;
    }
    // cancelled (or the dialog closed) while the camera was starting: turn it straight off again
    const cancelled = () => this.starting !== attempt || $('#sync-dialog').hidden;
    const drop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (video.srcObject === stream) video.srcObject = null;
      if (!this.starting && !this.scanning) $('#sync-scan').disabled = false;
    };
    if (cancelled()) { drop(); return; }
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play().catch(() => {});
    if (cancelled()) { drop(); return; }
    this.starting = null;
    $('#sync-scan-box').hidden = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scan = { stream, stop: false };
    this.scanning = scan;
    const tick = () => {
      if (scan.stop) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const w = 640, h = Math.round((video.videoHeight * w) / video.videoWidth);
        canvas.width = w; canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (found && found.data.startsWith('RA-SYNC:')) { this.stopScan(); this.connectPhone(found.data); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  stopScan() {
    this.starting = null;                                      // also cancels a camera that is still starting
    $('#sync-scan').disabled = false;
    const s = this.scanning;
    if (!s) return;
    s.stop = true;
    s.stream.getTracks().forEach((t) => t.stop());
    $('#sync-video').srcObject = null;
    this.scanning = null;
    $('#sync-scan-box').hidden = true;
  },
  async connectPhone(code) {
    this.stopScan();
    $('#sync-phone-status').textContent = 'Connecting…';
    try {
      await PhoneSync.connect(code);
      this.showError('');
      if (!$('#library').hidden) await showLibrary();           // (this hides any message, so the toast comes after)
      toast('Sync is on. Your reading progress now follows you.', 3500);
    } catch (e) {
      this.showError(String((e && e.message) || e));
    }
    this.render();
  },
};

// ---------------------------------------------------------------- wiring
$('#btn-sync').addEventListener('click', () => SyncUI.open());
$('#sync-close').addEventListener('click', () => SyncUI.close());
$('#sync-dialog').addEventListener('click', (e) => { if (e.target.id === 'sync-dialog') SyncUI.close(); });
$('#sync-connect').addEventListener('click', () => SyncUI.connectLaptop());
$('#sync-show-code').addEventListener('click', () => SyncUI.showCode());
$('#sync-now').addEventListener('click', async () => {
  if (OFFLINE) { PhoneSync.run({ force: true, pull: true }); SyncUI.render(); return; }
  await SyncUI.laptopPost({ now: true });
  setTimeout(async () => { await SyncUI.refreshLaptop(); SyncUI.render(); }, 4000);
});
$('#sync-off').addEventListener('click', async () => {
  if (!confirm('Turn off sync on this device? Your reading data stays here; it just stops syncing.')) return;
  if (OFFLINE) { await PhoneSync.disconnect(); SyncUI.render(); } else { await SyncUI.laptopPost({ off: true }); $('#sync-qr-wrap').hidden = true; }
});
$('#sync-scan').addEventListener('click', () => SyncUI.startScan());
$('#sync-scan-stop').addEventListener('click', () => SyncUI.stopScan());
$('#sync-paste-go').addEventListener('click', () => SyncUI.connectPhone($('#sync-paste').value));
$('#sync-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') SyncUI.connectLaptop(); });
if (OFFLINE) PhoneSync.init().then(() => SyncUI.render());
SyncUI.render();
