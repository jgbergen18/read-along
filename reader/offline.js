'use strict';
/* Read-Along offline mode: the version that runs on its own on a phone (installed from the web,
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
        r.onblocked = () => { try { toast('Close Read-Along in your other tabs to finish updating it.', 8000); } catch { /* ignore */ } };
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
};

// ---------------------------------------------------------------- the local "server"
const Local = {
  urls: {},          // id -> { epub, audio, sync } object URLs for the stored files
  locks: {},         // id -> promise: one change to a book's reading data at a time
  replicaId: null,

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
      const [epub, sync] = await Promise.all(['epub', 'sync'].map((k) => LocalDB.get('files', `${id}/${k}`)));
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
    for (let n = 0; n * CHUNK < book.audioSize; n++) parts.push(await LocalDB.get('chunks', `${id}/audio/${n}`));
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
  async remove(id) {
    const syncing = PhoneSync.configured();
    const sent = await PhoneSync.forget(id);          // try to send what's new first
    for (const k of ['epub', 'sync']) await LocalDB.del('files', `${id}/${k}`);
    await LocalDB.delPrefix('chunks', `${id}/audio/`);
    await LocalDB.del('books', id);
    if (!syncing) await LocalDB.del('state', id);     // with sync on, its reading data stays in sync (and comes back with the book)
    const keep = syncing && !sent;
    const u = this.urls[id];
    if (u) Object.values(u).forEach((x) => { if (x.startsWith('blob:')) URL.revokeObjectURL(x); });
    delete this.urls[id];
    coverCache.delete(id);
    return keep;
  },
};

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

async function importPack(file, onStatus) {
  onStatus('Reading the file…');
  const z = await readStoredZip(file);
  for (const need of ['book.epub', 'audio.m4a', 'sync.json', 'meta.json']) {
    if (!z[need]) throw new Error(`This file is missing ${need}.`);
  }
  const meta = JSON.parse(await z['meta.json'].text());
  if (!meta.id || !meta.title) throw new Error('This file is missing the book details.');
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch { /* ignore */ } }
  const audio = z['audio.m4a'];
  const mb = (audio.size / 1048576).toFixed(0);
  await LocalDB.delPrefix('chunks', `${meta.id}/audio/`);            // replacing an older copy
  await LocalDB.put('files', await z['book.epub'].arrayBuffer(), `${meta.id}/epub`);
  await LocalDB.put('files', await z['sync.json'].arrayBuffer(), `${meta.id}/sync`);
  const pieces = Math.ceil(audio.size / CHUNK);
  for (let n = 0; n < pieces; n++) {
    onStatus(`Saving “${meta.title}” to this device… ${Math.floor((100 * n) / pieces)}% of ${mb} MB. Keep this screen open.`);
    await LocalDB.put('chunks', await audio.slice(n * CHUNK, (n + 1) * CHUNK).arrayBuffer(), `${meta.id}/audio/${n}`);
  }
  await LocalDB.put('books', {
    audioSize: audio.size, audioType: 'audio/mp4',
    id: meta.id, title: meta.title, author: meta.author || null, year: meta.year || null, description: meta.description || null,
    series: meta.series || null, seriesIndex: meta.seriesIndex ?? null, duration: meta.duration || null,
    syncMode: meta.syncMode || 'dense', added: Date.now(),
  });
  delete Local.urls[meta.id];
  coverCache.delete(meta.id);
  return meta;
}

// ---------------------------------------------------------------- wiring (offline mode only)
if (OFFLINE) {
  document.body.classList.add('offline-app');

  // a new version of the app arrived in the background (the offline helper updated itself): switch to it
  // at a calm moment, now if the library is showing with nothing open, else when you're back in the library
  window.__switchToUpdate = async () => {
    try { await Promise.allSettled([...Local.pending]); } catch { /* ignore */ }   // let saving finish first
    try {            // the old helper may still be busy (audio of a book just closed): give it a moment to hand over
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.waiting) {
        await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 3000); });
      }
    } catch { /* ignore */ }
    try { sessionStorage.setItem('ra:updated-at', String(Date.now())); } catch { /* ignore */ }
    location.reload();
  };
  if ('serviceWorker' in navigator) {
    const hadHelper = !!navigator.serviceWorker.controller;
    const ready = () => {
      const calm = !S.book && ['#pack-dialog', '#info-dialog', '#sync-dialog'].every((s) => !$(s) || $(s).hidden);
      if (calm) window.__switchToUpdate(); else window.__reloadForUpdate = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadHelper) ready(); });   // (first visit: already newest)
    // a new version is installed but still waiting (the old helper is busy, e.g. with the audio): same thing,
    // but never reload for it twice in a row (if it keeps waiting, it takes over when the app is next opened)
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const waitingReady = () => {
        let last = 0;
        try { last = +sessionStorage.getItem('ra:updated-at') || 0; } catch { /* ignore */ }
        if (navigator.serviceWorker.controller && reg.waiting && Date.now() - last > 60000) ready();
      };
      const watch = (w) => { if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') waitingReady(); }); };
      waitingReady();
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }).catch(() => {});
  }
  const viaNetwork = api;
  api = async function (url, opts = {}) {
    if (String(url).startsWith('blob:')) return viaNetwork(url, opts);
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
    err.hidden = true; status.textContent = ''; $('#pack-progress').hidden = true;
    dlg.hidden = false;
  };
  pick.addEventListener('change', async () => {
    const file = pick.files[0];
    pick.value = '';
    if (!file) return;
    err.hidden = true;
    $('#pack-progress').hidden = false;
    $('#pack-choose').disabled = true;
    try {
      const meta = await importPack(file, (t) => { status.textContent = t; });
      dlg.hidden = true;
      await showLibrary();
      toast(`“${meta.title}” is on this device now and works offline.`, 4500);
    } catch (e) {
      err.hidden = false;
      err.textContent = e && e.name === 'QuotaExceededError'
        ? 'There isn’t enough free space on this device for this book.'
        : 'Could not add this book: ' + (e && e.message ? e.message : e);
    } finally {
      $('#pack-progress').hidden = true;
      $('#pack-choose').disabled = false;
    }
  });

  // info sheet: remove a book from the device
  $('#info-remove').hidden = false;
  $('#info-remove').addEventListener('click', async () => {
    if (!infoBook) return;
    const syncing = PhoneSync.configured();
    if (!confirm(syncing
      ? `Remove “${infoBook.title}” from this device? Your progress, bookmarks and notes stay in sync and come back if you add the book again.`
      : `Remove “${infoBook.title}” from this device? Your bookmarks and notes for it are removed too.`)) return;
    const kept = await Local.remove(infoBook.id);
    $('#info-dialog').hidden = true;
    await showLibrary();
    toast(kept ? 'Removed. Your latest progress and notes will be synced when there’s internet.' : 'Removed.', kept ? 4500 : 1800);
  });

  // how much space the books take
  window.addEventListener('DOMContentLoaded', async () => {
    $('#shelf-empty').innerHTML = 'No books on this device yet. Tap <b>Add book</b> and choose a book’s <code>.readalong</code> file (made on your PC; it’s in the book’s folder).';
    try {
      const est = await navigator.storage.estimate();
      if (est && est.usage > 5e6) $('#lib-sub').textContent = `Your books are stored on this device and work offline · ${(est.usage / 1073741824).toFixed(2)} GB used`;
      else $('#lib-sub').textContent = 'Your books are stored on this device and work offline.';
    } catch { /* ignore */ }
  });
}
