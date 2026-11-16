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
        const r = indexedDB.open('read-along', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const [name, opts] of [['books', { keyPath: 'id' }], ['files', undefined], ['state', undefined], ['chunks', undefined]]) {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts);
          }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
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
        position: st.position, finished: st.finished, bookmarks: st.bookmarks.length, highlights: st.highlights.length });
    }
    return out;
  },

  async state(id) {
    const st = (await LocalDB.get('state', id)) || {};
    return { position: null, bookmarks: [], highlights: [], listened: {}, finished: null, ...st };
  },

  // same rules as library.apply_ops on the laptop
  async apply(id, ops) {
    const st = await this.state(id);
    for (const op of Array.isArray(ops) ? ops : [ops]) {
      const k = op.op;
      if (k === 'position') {
        const pos = { time: op.time, cfi: op.cfi, dur: op.dur, chapter: op.chapter, device: op.device, updated: op.updated };
        if (!st.position || (pos.updated || 0) >= (st.position.updated || 0)) st.position = pos;
        if (op.dur && op.time >= op.dur - 90 && !st.finished) st.finished = Date.now();
      } else if ((k === 'add' || k === 'update') && (op.kind === 'bookmarks' || op.kind === 'highlights')) {
        const item = op.item || {};
        if (!item.id) continue;
        const list = st[op.kind];
        const i = list.findIndex((x) => x.id === item.id);
        if (i < 0) list.push(item); else list[i] = { ...list[i], ...item };
      } else if (k === 'remove' && (op.kind === 'bookmarks' || op.kind === 'highlights')) {
        st[op.kind] = st[op.kind].filter((x) => x.id !== op.id);
      } else if (k === 'listened') {
        const day = String(op.date).slice(0, 10);
        st.listened[day] = Math.round(((st.listened[day] || 0) + Math.max(0, Math.min(+op.seconds || 0, 3600))) * 10) / 10;
      } else if (k === 'finished') {
        st.finished = op.value ? Date.now() : null;
      } else if (k === 'restart') {
        st.position = { time: 0, cfi: null, updated: Date.now(), device: op.device };
        st.finished = null;
      }
    }
    await LocalDB.put('state', st, id);
    return st;
  },

  async stats() {
    const perDay = {};
    for (const b of await LocalDB.all('books')) {
      for (const [d, s] of Object.entries((await this.state(b.id)).listened)) perDay[d] = (perDay[d] || 0) + s;
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

  async remove(id) {
    for (const k of ['epub', 'sync']) await LocalDB.del('files', `${id}/${k}`);
    await LocalDB.delPrefix('chunks', `${id}/audio/`);
    await LocalDB.del('books', id);
    await LocalDB.del('state', id);
    const u = this.urls[id];
    if (u) Object.values(u).forEach((x) => { if (x.startsWith('blob:')) URL.revokeObjectURL(x); });
    delete this.urls[id];
    coverCache.delete(id);
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
  const viaNetwork = api;
  api = async function (url, opts = {}) {
    if (String(url).startsWith('blob:')) return viaNetwork(url, opts);
    const path = String(url).replace(/^.*?(api\/)/, '$1').split('?')[0];
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    if (path === 'api/books') return json(await Local.books());
    if (path === 'api/stats') return json(await Local.stats());
    if (path.startsWith('api/state/')) {
      const id = decodeURIComponent(path.slice('api/state/'.length));
      return json(opts.method === 'POST' ? await Local.apply(id, JSON.parse(opts.body || '[]')) : await Local.state(id));
    }
    if (path === 'api/ping') return json({ ok: true });
    throw new Error('404');
  };

  // if the audio can't be streamed through the offline helper, build it in memory instead
  audio.addEventListener('error', async () => {
    const src = audio.getAttribute('src') || '';
    if (!src.includes('local-audio/') || !S.meta) return;
    const t = audio.currentTime;
    try {
      audio.src = await Local.audioFallback(S.meta.id);
      S.meta.audio = audio.src;
      audio.addEventListener('loadedmetadata', () => { if (t) audio.currentTime = t; }, { once: true });
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
      toast(`“${meta.title}” is on this device now and works offline.`, 4500);
      showLibrary();
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
    if (!confirm(`Remove “${infoBook.title}” from this device? Your bookmarks and notes for it are removed too.`)) return;
    await Local.remove(infoBook.id);
    $('#info-dialog').hidden = true;
    toast('Removed.', 1800);
    showLibrary();
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
