'use strict';
/* Immersive Reader offline mode: the version that runs on its own on a phone (installed from the web,
 * no laptop needed). Books are imported from a ".readalong" file and stored on the device; the
 * library, reading positions, bookmarks, highlights and stats are kept on the device too.
 *
 * It answers the same requests the laptop server answers (api/books, api/state/..., api/stats), so
 * the rest of the app works unchanged. Inactive unless the page sets window.READALONG_OFFLINE.
 *
 * A .readalong file is an uncompressed ZIP with: book.epub, audio.m4a, sync.json, meta.json.
 * It is read in slices, so a 500 MB file never has to fit in memory. The audio is stored in 4 MB
 * pieces (plain data, which every browser engine can store) and played through the offline helper
 * (sw.js), which hands the player only the pieces it asks for.
 */
const CHUNK = 4 * 1024 * 1024;

// ---------------------------------------------------------------- device storage (IndexedDB)
const LocalDB = {
  db: null,
  open() {
    if (!this.db) {
      this.db = new Promise((res, rej) => {
        const r = indexedDB.open('read-along', 3);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const [name, opts] of [['books', { keyPath: 'id' }], ['files', undefined], ['state', undefined], ['chunks', undefined], ['meta', undefined]]) {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts);
          }
        };
        r.onsuccess = () => {
          const d = r.result;
          d.onversionchange = () => { d.close(); this.db = null; };   // let a newer version of the app upgrade
          res(d);
        };
        r.onerror = () => rej(r.error);
        r.onblocked = () => { try { toast('Close Immersive Reader in your other tabs to finish updating it.', 8000); } catch { /* ignore */ } };
      });
    }
    return this.db;
  },
  async run(store, mode, op) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const r = op(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage was refused (is the phone full?)'));
    });
  },
  get(store, key) { return this.run(store, 'readonly', (s) => s.get(key)); },
  all(store) { return this.run(store, 'readonly', (s) => s.getAll()); },
  put(store, value, key) { return this.run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))); },
  del(store, key) { return this.run(store, 'readwrite', (s) => s.delete(key)); },
  delPrefix(store, prefix) { return this.run(store, 'readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'))); },
  keys(store) { return this.run(store, 'readonly', (s) => s.getAllKeys()); },
  count(store, query) { return this.run(store, 'readonly', (s) => s.count(query)); },
  // a book's record and everything stored for it, in one step: all of it goes, or (if interrupted) none of it
  async delBook(id, withState) {
    const db = await this.open();
    const stores = withState ? ['books', 'files', 'chunks', 'state'] : ['books', 'files', 'chunks'];
    return new Promise((res, rej) => {
      const t = db.transaction(stores, 'readwrite');
      const range = IDBKeyRange.bound(`${id}/`, `${id}/\uffff`);
      t.objectStore('books').delete(id);
      t.objectStore('files').delete(range);
      t.objectStore('chunks').delete(range);
      if (withState) t.objectStore('state').delete(id);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage was refused.'));
    });
  },
};

// ---------------------------------------------------------------- the local "server"
const Local = {
  urls: {},          // id -> { epub, audio, sync } object URLs for the stored files
  locks: {},         // id -> promise: one change to a book's reading data at a time
  replicaId: null,
  removing: new Set(),  // ids of books being removed right now

  // a stable id for this phone's copy of the reading data (listening time is kept per device)
  async replica() {
    if (!this.replicaId) {
      let id = null;
      try { id = await LocalDB.get('meta', 'replica'); } catch { /* ignore */ }
      if (!id) { id = 'phone-' + Math.random().toString(36).slice(2, 10); try { await LocalDB.put('meta', id, 'replica'); } catch { /* ignore */ } }
      this.replicaId = id;
    }
    return this.replicaId;
  },

  withLock(id, fn) {
    const run = (this.locks[id] || Promise.resolve()).then(fn, fn);
    this.locks[id] = run.catch(() => {});
    return run;
  },

  async saveRaw(id, st) { await LocalDB.put('state', st, id); },

  async fileUrls(id, book) {
    if (!this.urls[id]) {
      const [epub, sync] = await Promise.all([LocalDB.get('files', (book && book.epubKey) || `${id}/epub`), LocalDB.get('files', (book && book.syncKey) || `${id}/sync`)]);
      if (!epub || !sync || !book || !book.audioSize) return null;
      this.urls[id] = {
        epub: URL.createObjectURL(new Blob([epub], { type: 'application/epub+zip' })),
        sync: URL.createObjectURL(new Blob([sync], { type: 'application/json' })),
        // streamed piece by piece by sw.js (falls back to one in-memory file, see audioFallback)
        audio: new URL('local-audio/' + encodeURIComponent(id), location.href).href,
      };
    }
    return this.urls[id];
  },

  // if the browser doesn't route audio through the offline helper: put the pieces together in memory
  async audioFallback(id) {
    const book = await LocalDB.get('books', id);
    const parts = [];
    const key = book.audioKey || `${id}/audio/`;
    for (let n = 0; n * CHUNK < book.audioSize; n++) parts.push(await LocalDB.get('chunks', key + n));
    const url = URL.createObjectURL(new Blob(parts, { type: 'audio/mp4' }));
    if (this.urls[id]) this.urls[id].audio = url;
    return url;
  },

  async books() {
    const out = [];
    for (const b of await LocalDB.all('books')) {
      const u = await this.fileUrls(b.id, b);
      if (!u) continue;
      const st = await this.state(b.id);
      out.push({ ...b, folder: b.id, epub: u.epub, audio: u.audio, sync: u.sync, aligned: true,
        syncInfo: { complete: true, mode: b.syncMode || 'dense', duration: b.duration },
        position: st.position, finished: st.finished,
        bookmarks: st.bookmarks.filter((x) => !x.deleted).length, highlights: st.highlights.filter((x) => !x.deleted).length });
    }
    return out;
  },

  async state(id) {
    const st = SyncCore.normalize((await LocalDB.get('state', id)) || {}, await this.replica());
    st.id = id;
    return st;
  },

  // changes being saved right now (a sync pass waits for them, so a change made as the app is left is sent)
  pending: new Set(),
  seenListen: {},         // book id -> ids of listening-time reports already counted
  apply(id, ops) {
    const p = this.applyNow(id, ops);
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    // a reading session ended (pause, close, leaving the app): send it right away
    if ((Array.isArray(ops) ? ops : [ops]).some((o) => o && o.op === 'flush')) p.then(() => PhoneSync.run({ force: true }), () => {});
    return p;
  },

  // same rules as library.apply_ops on the laptop (every change is time-stamped so it can be merged
  // with the other devices; deletions are kept as bare "tombstones")
  async applyNow(id, ops) {
    const replica = await this.replica();
    const st = await this.withLock(id, async () => {
      const st = await this.state(id);
      const now = Date.now();
      for (const op of Array.isArray(ops) ? ops : [ops]) {
        const k = op.op;
        if (k === 'position') {
          const pos = { time: op.time, cfi: op.cfi, dur: op.dur, chapter: op.chapter, device: op.device, updated: op.updated };
          if (op.from) pos.from = op.from;
          let applied = false;
          if (!st.position || (pos.updated || 0) >= (st.position.updated || 0)) { st.position = pos; applied = true; }
          if (applied && op.dur && op.time >= op.dur - 90 && !st.finished && (op.updated || 0) > (st.finishedUpdated || 0)) {
            st.finished = now; st.finishedUpdated = now;
          }
        } else if ((k === 'add' || k === 'update') && (op.kind === 'bookmarks' || op.kind === 'highlights')) {
          const item = op.item || {};
          if (!item.id) continue;
          const list = st[op.kind];
          const i = list.findIndex((x) => x.id === item.id);
          // a change is stamped later than the version it replaces, even if this phone's clock is a little behind
          const after = (x) => Math.max(now, ((x && x.updated) || 0) + 1);
          if (i < 0) { if (k === 'add') list.push({ ...item, created: item.created || now, updated: now }); }
          else if (list[i].deleted) { if (k === 'add') list[i] = { ...item, created: item.created || now, updated: after(list[i]) }; }   // editing something deleted elsewhere: skip
          else list[i] = { ...list[i], ...item, updated: after(list[i]) };
        } else if (k === 'remove' && (op.kind === 'bookmarks' || op.kind === 'highlights')) {
          st[op.kind] = st[op.kind].map((x) => (x.id === op.id ? { id: x.id, created: x.created || 0, deleted: true, updated: Math.max(now, (x.updated || 0) + 1) } : x));
        } else if (k === 'listened') {
          if (op.id) {                                // the same listening time sent again: count it once
            const seen = this.seenListen[id] || (this.seenListen[id] = new Set());
            if (seen.has(op.id)) continue;
            seen.add(op.id);
            if (seen.size > 500) seen.delete(seen.values().next().value);
          }
          const day = String(op.date).slice(0, 10);
          const mine = st.listened[replica] || (st.listened[replica] = {});
          mine[day] = Math.round(((mine[day] || 0) + Math.max(0, Math.min(+op.seconds || 0, 3600))) * 10) / 10;
        } else if (k === 'finished') {
          const fu = Math.max(now, (st.finishedUpdated || 0) + 1);
          st.finished = op.value ? fu : null; st.finishedUpdated = fu;
        } else if (k === 'restart') {
          st.position = { time: 0, cfi: null, updated: Math.max(now, ((st.position && st.position.updated) || 0) + 1), device: op.device };
          st.finished = null; st.finishedUpdated = Math.max(now, (st.finishedUpdated || 0) + 1);
        }
      }
      await this.saveRaw(id, st);
      return st;
    });
    PhoneSync.mark(id);
    return st;
  },

  async stats() {
    const perDay = {};
    const replica = await this.replica();
    for (const raw of await LocalDB.all('state')) {       // every book in sync (also ones not on this phone)
      for (const days of Object.values(SyncCore.normalize(raw, replica).listened)) {   // every device's listening time
        for (const [d, s] of Object.entries(days)) perDay[d] = (perDay[d] || 0) + s;
      }
    }
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const day = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
    const weekStart = day((now.getDay() + 6) % 7);
    let streak = 0, n = (perDay[iso(now)] || 0) >= 60 ? 0 : 1;
    while ((perDay[iso(day(n))] || 0) >= 60) { streak++; n++; }
    return {
      today: perDay[iso(now)] || 0,
      week: Object.entries(perDay).filter(([d]) => d >= iso(weekStart)).reduce((a, [, s]) => a + s, 0),
      total: Object.values(perDay).reduce((a, s) => a + s, 0),
      streak,
      days: Array.from({ length: 14 }, (_, i) => ({ date: iso(day(13 - i)), seconds: perDay[iso(day(13 - i))] || 0 })),
    };
  },

  // returns true when some reading data couldn't be sent yet (no internet...): it is sent when possible
  // space used by each book on this device, and an estimate of what still fits
  async storageInfo() {
    const books = [];
    let booksBytes = 0;
    for (const b of await LocalDB.all('books')) {
      let size = b.bytes;
      if (!size) {                                     // added by an older version: measure once, remember it
        const [e, s] = await Promise.all([LocalDB.get('files', b.epubKey || `${b.id}/epub`), LocalDB.get('files', b.syncKey || `${b.id}/sync`)]);
        size = (b.audioSize || 0) + ((e && e.byteLength) || 0) + ((s && s.byteLength) || 0);
        try { await LocalDB.put('books', { ...b, bytes: size }); } catch { /* ignore */ }
      }
      books.push({ id: b.id, title: b.title, bytes: size });
      booksBytes += size;
    }
    let usage = null, quota = null;
    try { const est = await navigator.storage.estimate(); usage = est.usage; quota = est.quota; } catch { /* not available */ }
    const free = usage != null && quota ? Math.max(0, quota - usage) : null;
    return { books, booksBytes, usage, quota, free };
  },
  // refuse (with a clear reason) to add something that won't fit
  async checkSpace(bytes) {
    let info;
    try { info = await this.storageInfo(); } catch { return; }
    if (info.free != null && bytes > info.free * 0.95) {
      throw new Error(`There isn’t enough room in Immersive Reader on this phone: this book needs ${sizeText(bytes)} and it can store about ${sizeText(info.free)} more. `
        + 'Remove a book you’ve finished (ⓘ → Remove from this device) and try again.');
    }
  },

  async remove(id) {
    const adding = 'This book is being added to the phone right now. Remove it once that’s done.';
    if (ImportSink.busy(id)) throw new Error(adding);
    this.removing.add(id);
    let keep;
    try {
      const syncing = PhoneSync.configured();
      const sent = await PhoneSync.forget(id);          // try to send what's new first
      if (ImportSink.busy(id)) throw new Error(adding);
      // every copy of its files and audio, and its record; with sync on, its reading data stays in sync
      // (and comes back with the book)
      await LocalDB.delBook(id, !syncing);
      keep = syncing && !sent;
    } finally { this.removing.delete(id); }
    const u = this.urls[id];
    if (u) Object.values(u).forEach((x) => { if (x.startsWith('blob:')) URL.revokeObjectURL(x); });
    delete this.urls[id];
    coverCache.delete(id);
    return keep;
  },
};

// ---------------------------------------------------------------- storage indicator (phone library)
const sizeText = (n) => (n >= 1e9 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`);
async function renderStorage() {
  const el = $('#storage');
  if (!el || !OFFLINE) return;
  let info;
  try { info = await Local.storageInfo(); } catch { el.hidden = true; return; }
  const n = info.books.length;
  $('#storage-used').textContent = n ? `${n} book${n === 1 ? '' : 's'} on this phone · ${sizeText(info.booksBytes)}` : 'No books on this phone yet';
  // (the browser only tells how much more Immersive Reader may store; the phone's own free space can be less)
  $('#storage-free').textContent = info.free != null ? `room for up to ~${sizeText(info.free)} more` : '';
  const low = info.free != null && info.free < 1.5e9;
  el.classList.toggle('low', low);
  $('#storage-low').hidden = !low || !n;
  const share = info.free != null ? info.booksBytes / Math.max(1, info.booksBytes + info.free) : 0;
  el.querySelector('.storage-bar i').style.width = `${Math.min(100, n ? Math.max(1.5, 100 * share) : 0).toFixed(1)}%`;
  el.hidden = false;
  return info;
}

// ---------------------------------------------------------------- reading a .readalong file
async function readStoredZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("This isn't a .readalong file.");
  let count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {          // zip64
    const loc = e - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('Unsupported file.');
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const zv = new DataView(await file.slice(z64, z64 + 56).arrayBuffer());
    count = Number(zv.getBigUint64(32, true)); cdSize = Number(zv.getBigUint64(40, true)); cdOff = Number(zv.getBigUint64(48, true));
  }
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = {};
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged file.');
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true), lho = cd.getUint32(p + 42, true);
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    // zip64 sizes/offsets live in the "extra" field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (cd.getUint32(p + 24, true) === 0xffffffff) q += 8;                   // uncompressed size
        if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(cd.getBigUint64(q, true)); }
      }
      x += 4 + len;
    }
    if (method !== 0) throw new Error('This file is compressed; make it with make_phone_pack.py.');
    const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
    const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    entries[name] = file.slice(start, start + csize);
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

// storing a book on this device, piece by piece: used by "Add book" (a .readalong file) and by
// receiving a book straight from the PC (transfer.js). The audio is kept in CHUNK-sized pieces.
// The new copy is stored under its own keys next to any copy already there; finish() switches the book
// over in one step (the book record says which keys it uses), then removes the old copy. So a transfer
// or import that breaks off never costs the copy you had.
const ImportSink = {
  active: new Map(),                                  // audio key -> a copy being stored right now
  importing: 0,                                       // "Add book" imports running (from the moment a file is picked)
  cleaning: null,                                     // a cleanup in progress (never at the same time as storing)
  busy(id) { return [...this.active.values()].some((s) => s.id === id); },
  async begin(id) {
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch { /* ignore */ } }
    while (this.cleaning) await this.cleaning;
    const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const s = { id, audioKey: `${id}/audio@${gen}/`, epubKey: `${id}/epub@${gen}`, syncKey: `${id}/sync@${gen}`, aborted: false };
    this.active.set(s.audioKey, s);
    return s;
  },
  putFile(s, kind, buf) { return LocalDB.put('files', buf, kind === 'epub' ? s.epubKey : s.syncKey); },
  putAudio(s, n, buf) { return LocalDB.put('chunks', buf, s.audioKey + n); },
  async finish(s, meta, audioSize, otherBytes) {
    if (s.aborted || !this.active.has(s.audioKey)) throw new Error('Stopped.');
    // only switch the book over once every piece is really stored
    const [pieces, epub, sync] = await Promise.all([
      LocalDB.count('chunks', IDBKeyRange.bound(s.audioKey, s.audioKey + '\uffff')), LocalDB.count('files', s.epubKey), LocalDB.count('files', s.syncKey)]);
    if (pieces !== Math.ceil(audioSize / CHUNK) || !epub || !sync) throw new Error('Part of the book went missing while it was being stored. Please try again.');
    const old = await LocalDB.get('books', s.id);
    if (s.aborted) throw new Error('Stopped.');
    await LocalDB.put('books', {
      audioSize, audioType: 'audio/mp4', bytes: audioSize + (otherBytes || 0),
      audioKey: s.audioKey, epubKey: s.epubKey, syncKey: s.syncKey,
      id: meta.id, title: meta.title, author: meta.author || null, year: meta.year || null, description: meta.description || null,
      series: meta.series || null, seriesIndex: meta.seriesIndex ?? null, duration: meta.duration || null,
      syncMode: meta.syncMode || 'dense', added: Date.now(),
    });
    this.active.delete(s.audioKey);
    if (old) {                                                       // the copy it replaces (if this fails, cleanup frees it later)
      try {
        const oldAudio = old.audioKey || `${s.id}/audio/`;
        if (oldAudio !== s.audioKey) await LocalDB.delPrefix('chunks', oldAudio);
        for (const k of [old.epubKey || `${s.id}/epub`, old.syncKey || `${s.id}/sync`]) if (k !== s.epubKey && k !== s.syncKey) await LocalDB.del('files', k);
      } catch { /* ignore */ }
    }
    const u = Local.urls[s.id];
    if (u) Object.values(u).forEach((x) => { if (String(x).startsWith('blob:')) URL.revokeObjectURL(x); });
    delete Local.urls[s.id];
    coverCache.delete(s.id);
  },
  // an import that didn't finish: remove what it stored so far (any copy that was there stays). Never removes
  // a copy the book already uses (if it got as far as switching over, it is kept).
  async abort(s) {
    s.aborted = true;
    this.active.delete(s.audioKey);
    let b;
    try { b = await LocalDB.get('books', s.id); } catch { return; }      // (then cleanup frees it later)
    if (b && (b.audioKey === s.audioKey || b.epubKey === s.epubKey || b.syncKey === s.syncKey)) return;
    await LocalDB.delPrefix('chunks', s.audioKey);
    await LocalDB.del('files', s.epubKey);
    await LocalDB.del('files', s.syncKey);
  },
  // free the space of copies no book uses: left half-stored when the app was closed in the middle of adding
  // a book, or an old copy whose removal was interrupted (also ones stored by older versions of the app).
  // Never runs while a book is being stored.
  cleanup() {
    if (this.active.size || this.cleaning) return this.cleaning || Promise.resolve();
    const run = this.sweep().catch(() => {});
    this.cleaning = run.then(() => { this.cleaning = null; });
    return this.cleaning;
  },
  async sweep() {
    const used = new Set(), have = new Set((await LocalDB.keys('files')).map(String));
    for (const b of await LocalDB.all('books')) {
      const epub = b.epubKey || `${b.id}/epub`, sync = b.syncKey || `${b.id}/sync`;
      // a book whose files are gone can't be opened, and the library doesn't show it (an older version could
      // leave one behind when a Remove was interrupted): drop it, so its audio is freed below
      if (!have.has(epub) || !have.has(sync)) { await LocalDB.del('books', b.id); continue; }
      used.add(b.audioKey || `${b.id}/audio/`).add(epub).add(sync);
    }
    const stale = new Set();
    for (const k of await LocalDB.keys('chunks')) {
      const m = /^(.*\/audio(?:@[^/]+)?\/)\d+$/.exec(String(k));      // <book>/audio@<copy>/<n> (older versions: <book>/audio/<n>)
      if (m && !used.has(m[1])) stale.add(m[1]);
    }
    for (const p of stale) await LocalDB.delPrefix('chunks', p);
    for (const k of await LocalDB.keys('files')) {
      if (/\/(epub|sync)(@[^/]+)?$/.test(String(k)) && !used.has(String(k))) await LocalDB.del('files', k);
    }
  },
};

// adding, receiving or removing a book right now (a new version of the app waits until that's done)
function phoneBusy() {
  return ImportSink.active.size > 0 || ImportSink.importing > 0 || Local.removing.size > 0 || (typeof Receiver !== 'undefined' && Receiver.busy);
}
// a book was added, received or removed (or that failed): a new version of the app that arrived meanwhile
// switches in a moment (after the message has been read), if the library is showing with nothing open
function updateAfterBusy() {
  if (window.__reloadForUpdate && window.__switchToUpdate) setTimeout(() => { if (!phoneBusy()) window.__switchToUpdate(); }, 6000);
}
// a book was added, replaced or removed: refresh the library if it's showing. A book that's open (or still
// opening) is left alone, unless it's the very book that was just replaced or removed (its files changed).
// A new version of the app that's waiting doesn't switch here (the message comes first): updateAfterBusy.
async function libraryAfterChange(id) {
  // its info sheet, if open, still shows the copy that was just replaced or removed (its files are gone): close it
  if (!$('#info-dialog').hidden && infoBook && infoBook.id === id) $('#info-dialog').hidden = true;
  if ($('#library').hidden && !(S.meta && S.meta.id === id)) return;
  await showLibrary({ deferUpdate: true });
}
// phone app, the book info sheet: its Remove button says when the book shown is being removed
function showRemoveState(b) {
  const btn = $('#info-remove'), now = !!(b && Local.removing.has(b.id));
  btn.disabled = now;
  btn.textContent = now ? 'Removing…' : 'Remove from this device';
}

async function importPack(file, onStatus) {
  ImportSink.importing++;
  try { return await importPackNow(file, onStatus); } finally { ImportSink.importing--; }
}
async function importPackNow(file, onStatus) {
  onStatus('Reading the file…');
  await Local.checkSpace(file.size);
  const z = await readStoredZip(file);
  for (const need of ['book.epub', 'audio.m4a', 'sync.json', 'meta.json']) {
    if (!z[need]) throw new Error(`This file is missing ${need}.`);
  }
  const meta = JSON.parse(await z['meta.json'].text());
  if (!meta.id || !meta.title || /[\\/]/.test(meta.id)) throw new Error('This file is missing the book details.');
  const audio = z['audio.m4a'];
  const mb = (audio.size / 1048576).toFixed(0);
  const stage = await ImportSink.begin(meta.id);
  try {
    const epubBuf = await z['book.epub'].arrayBuffer(), syncBuf = await z['sync.json'].arrayBuffer();
    await ImportSink.putFile(stage, 'epub', epubBuf);
    await ImportSink.putFile(stage, 'sync', syncBuf);
    const pieces = Math.ceil(audio.size / CHUNK);
    for (let n = 0; n < pieces; n++) {
      onStatus(`Saving “${meta.title}” to this device… ${Math.floor((100 * n) / pieces)}% of ${mb} MB. Keep this screen open.`);
      await ImportSink.putAudio(stage, n, await audio.slice(n * CHUNK, (n + 1) * CHUNK).arrayBuffer());
    }
    await ImportSink.finish(stage, meta, audio.size, epubBuf.byteLength + syncBuf.byteLength);
  } catch (e) {
    try { await ImportSink.abort(stage); } catch { /* ignore */ }
    throw e;
  }
  return meta;
}

// ---------------------------------------------------------------- wiring (offline mode only)
if (OFFLINE) {
  document.body.classList.add('offline-app');

  // a new version of the app arrived in the background (the offline helper updated itself): switch to it
  // at a calm moment, now if the library is showing with nothing open, else when you're back in the library
  // (calm: the library showing, no book open, no window open, no book being stored or received)
  const calmNow = () => !S.book && !phoneBusy() && !$('#library').hidden && $$('.modal').every((m) => m.hidden);
  let switching = false;
  window.__switchToUpdate = async () => {
    if (switching) return;
    switching = true;
    try {
      try { await Promise.allSettled([...Local.pending]); } catch { /* ignore */ }   // let saving finish first
      try {          // the old helper may still be busy (the audio of a book just closed): give it a moment to hand
        const reg = await navigator.serviceWorker.getRegistration();         // over (if it can't yet, the page
        if (reg && reg.waiting) {                                            // after the reload notices: outdated())
          await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 3000); });
        }
      } catch { /* ignore */ }
      if (!calmNow()) { window.__reloadForUpdate = true; return; }    // something was opened meanwhile: next time
      // at most 4 of these reloads in 2 minutes (a switch can take two: the reload, and a catch-up if the old helper
      // was still in charge as the page loaded); if something keeps going wrong, it switches when the app is next opened
      let recent = [];
      try { recent = JSON.parse(sessionStorage.getItem('ra:update-reloads') || '[]').filter((t) => Date.now() - t < 120000); } catch { /* ignore */ }
      if (recent.length >= 4) return;
      try {
        sessionStorage.setItem('ra:update-reloads', JSON.stringify([...recent, Date.now()]));
        sessionStorage.setItem('ra:updated-at', String(Date.now()));
      } catch { /* ignore */ }
      location.reload();
    } finally { switching = false; }
  };
  if ('serviceWorker' in navigator) {
    const hadHelper = !!navigator.serviceWorker.controller;
    const ready = () => { if (calmNow()) window.__switchToUpdate(); else window.__reloadForUpdate = true; };
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadHelper) ready(); });   // (first visit: already newest)
    // is this page an older version than the helper now in charge? (a new helper deletes the older version's files
    // when it takes over; a page that was loading just then can still be the older version and miss the change)
    const outdated = async () => {
      if (!window.READALONG_BUILD || !window.caches || !navigator.serviceWorker.controller) return false;
      try {
        const keys = await caches.keys();
        return !keys.includes('read-along-' + window.READALONG_BUILD) && keys.some((k) => k.startsWith('read-along-'));
      } catch { return false; }
    };
    const checkOutdated = () => outdated().then((old) => { if (old) ready(); }).catch(() => {});
    navigator.serviceWorker.ready.then(checkOutdated).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkOutdated(); });
    // a new version is installed but still waiting (the old helper is busy, e.g. with the audio): same thing; just
    // after a switch, not at once again but at the next calm moment (e.g. back in the library)
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const waitingReady = () => {
        if (!navigator.serviceWorker.controller || !reg.waiting) return;
        let last = 0;
        try { last = +sessionStorage.getItem('ra:updated-at') || 0; } catch { /* ignore */ }
        if (Date.now() - last > 60000) ready(); else window.__reloadForUpdate = true;
      };
      const watch = (w) => { if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') waitingReady(); }); };
      waitingReady();
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }).catch(() => {});
  }
  api = async function (url, opts = {}) {
    if (String(url).startsWith('blob:')) {           // a book's file on this phone: if it fails, that's never "can't reach your PC"
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(String(r.status));
      return r;
    }
    const path = String(url).replace(/^.*?(api\/)/, '$1').split('?')[0];
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    if (path === 'api/books') return json(await Local.books());
    if (path === 'api/stats') return json(await Local.stats());
    if (path.startsWith('api/state/')) {
      const id = decodeURIComponent(path.slice('api/state/'.length));
      if (opts.method === 'POST') return json(await Local.apply(id, JSON.parse(opts.body || '[]')));
      await PhoneSync.pullBook(id);                          // newest progress from the other devices first
      return json(await Local.state(id));
    }
    if (path === 'api/ping') return json({ ok: true });
    throw new Error('404');
  };

  // if the audio can't be streamed through the offline helper, build it in memory instead
  audio.addEventListener('error', async () => {
    const src = audio.getAttribute('src') || '';
    if (!src.includes('local-audio/') || !S.meta) return;
    const t = S.audioReady ? audio.currentTime : ((store.get('pos:' + S.meta.id) || {}).time || 0);
    S.audioReady = false;                             // don't save the 0 a reload starts at
    const id = S.meta.id;
    try {
      const url = await Local.audioFallback(id);
      if (!S.meta || S.meta.id !== id) return;        // another book was opened meanwhile
      audio.addEventListener('loadedmetadata', () => {
        if (!S.meta || S.meta.id !== id) return;
        if (t) audio.currentTime = t;
        audioLoaded();                                // speed, length display
        S.audioReady = true;
      }, { once: true });
      audio.src = url;
      S.meta.audio = audio.src;
    } catch (e) { toast('This book\u2019s audio could not be loaded.'); }
  });

  // the "Add book" button imports a .readalong file
  const dlg = $('#pack-dialog');
  const pick = $('#pack-input');
  const status = $('#pack-status');
  const err = $('#pack-error');
  openAdd = function () {
    err.hidden = true;
    if (!pick.disabled) { status.textContent = ''; $('#pack-progress').hidden = true; }    // (a book still being added keeps its progress)
    dlg.hidden = false;
  };
  pick.addEventListener('change', async () => {
    const file = pick.files[0];
    pick.value = '';
    if (!file) return;
    err.hidden = true;
    $('#pack-progress').hidden = false;
    pick.disabled = true;                          // one at a time (a disabled input also keeps its label from opening it)
    try {
      const meta = await importPack(file, (t) => { status.textContent = t; });
      dlg.hidden = true;
      await libraryAfterChange(meta.id);           // (never interrupts another book you opened meanwhile)
      toast(`“${meta.title}” is on this device now and works offline.`, 4500);
    } catch (e) {
      err.hidden = false;
      err.textContent = e && (e.name === 'QuotaExceededError' || e.name === 'UnknownError')
        ? 'The phone ran out of space for this book. Remove a book you’ve finished (ⓘ → Remove from this device) and try again.'
        : 'Could not add this book: ' + (e && e.message ? e.message : e);
      if (dlg.hidden) toast(err.textContent, 8000);                 // (the window was closed meanwhile)
    } finally {
      $('#pack-progress').hidden = true;
      pick.disabled = false;
      updateAfterBusy();
    }
  });

  // info sheet: remove a book from the device
  $('#info-remove').hidden = false;
  $('#info-remove').addEventListener('click', async () => {
    const b = infoBook;                            // (the sheet can show another book by the time this is done)
    if (!b || Local.removing.has(b.id)) return;    // (already being removed)
    if (ImportSink.busy(b.id)) { toast('This book is being added to the phone right now. Remove it once that’s done.', 4500); return; }
    const syncing = PhoneSync.configured();
    if (!confirm(syncing
      ? `Remove “${b.title}” from this device? Your progress, bookmarks and notes stay in sync and come back if you add the book again.`
      : `Remove “${b.title}” from this device? Your bookmarks and notes for it are removed too.`)) return;
    const removing = Local.remove(b.id);           // (it may first send the book's latest notes: that can take a moment)
    showRemoveState(infoBook);
    let kept;
    try { kept = await removing; } catch (e) { toast(String((e && e.message) || e), 4500); return; } finally { showRemoveState(infoBook); }
    await libraryAfterChange(b.id);                // (closes its sheet; never interrupts another book you opened meanwhile)
    toast(kept ? 'Removed. Your latest progress and notes will be synced when there’s internet.' : 'Removed.', kept ? 4500 : 1800);
    updateAfterBusy();
  });

  setTimeout(() => ImportSink.cleanup().catch(() => {}), 8000);      // half-stored copies from an interrupted import
  window.addEventListener('DOMContentLoaded', () => {
    $('#shelf-empty').innerHTML = 'No books on this device yet. Tap <b>Add book</b> and choose a book’s <code>.readalong</code> file (made on your PC; it’s in the book’s folder).';
    $('#lib-sub').textContent = 'Your books are stored on this phone and work offline.';
  });
}
