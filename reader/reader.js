'use strict';
/* Immersive Reader: an EPUB reader that turns pages and highlights words with the audiobook.
 *
 * Sync data (<audio>.sync.json, built by make_sync.py) maps audio time to "word number":
 * the count of whitespace-separated words in the book's <body> text, in spine order. It must
 * match indexSection() below exactly. v2 files store anchors as delta-encoded columns
 * (at: centiseconds, aw: word numbers); v1 files store [[seconds, word], ...].
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const audio = $('#audio');
const isTouch = matchMedia('(pointer: coarse)').matches;
const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname) && !window.READALONG_OFFLINE;
const OFFLINE = !!window.READALONG_OFFLINE;     // the stand-alone phone version (see offline.js)

// ---------------------------------------------------------------- storage
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('ra:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ra:' + k, JSON.stringify(v)); } catch { /* private mode / quota */ } },
};
const DEFAULTS = { theme: 'light', font: 100, rate: 1, highlight: 'phrase', spread: false, fontFamily: 'book', lineHeight: 'book', width: 'normal',
  keepAwake: true };
const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
if (settings.highlight === true) settings.highlight = 'phrase';      // older setting format
if (settings.highlight === false) settings.highlight = 'off';
const saveSettings = () => store.set('settings', settings);

// ---------------------------------------------------------------- state
const S = {
  meta: null, book: null, rendition: null, sync: null,
  at: null, aw: null,          // anchor times (s) / word numbers, strictly increasing
  spineW: [],
  follow: true, busy: false, pending: false, lastW: -1, loc: null,
  hl: [], sections: new Map(), coverUrl: null,
  saveTimer: null, syncTimer: null, tickTimer: null,
  sleep: null,                 // { until: ms } or { chapterEnd: seconds }
  audioReady: false,           // the audio is loaded and at the book's place (until then, the place isn't saved)
  // reading on with the audio paused (see pageTurn):
  pin: null,                   // { w, from, to }: while the audio time is in [from, to], the place is word w exactly
  armed: null,                 // { cfi, t }: this page was reached by reading on from the place (it can carry it on)
  pageShownAt: 0,              // when the page on screen appeared (performance.now())
  navSeq: 0,                   // counts other moves of the book (display, follow on/off) that cancel a carry
  dwellMs: 3000,               // a page shown at least this long counts as read (a quick flip to peek ahead doesn't)
  turnWaitMs: 3000,            // longest wait for epub.js to turn a page (it can leave a turn unsettled at closing)
};

const fmt = (t) => {
  if (!isFinite(t)) t = 0;
  t = Math.max(0, Math.floor(t));
  return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const mins = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);
// "12" -> "Chapter 12"; "PART ONE: Legacy" -> "Part One: Legacy"; "PROLOGUE" -> "Prologue"
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
const chapterLabel = (t) => {
  if (!t) return '';
  if (/^\d+$/.test(t)) return 'Chapter ' + t;
  let first = true;
  return t.replace(/\b([A-Z])([A-Z']+)\b/g, (m, a, b, pos) => {
    const w = (a + b).toLowerCase();
    const out = !first && pos > 0 && SMALL_WORDS.has(w) ? w : a + b.toLowerCase();
    first = false;
    return out;
  });
};

let toastTimer = null;
function toast(msg, ms = 3200, action) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  if (action) {                                   // optional button, e.g. { label: 'Go there', run() {} }
    const b = document.createElement('button');
    b.className = 'toast-act'; b.textContent = action.label;
    b.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.append(' ', b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(url, opts) {
  try {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts));
    if (!r.ok) throw new Error(r.status);
    $('#offline').hidden = true;
    return r;
  } catch (e) {
    if (!(e instanceof Error && /^\d+$/.test(e.message))) $('#offline').hidden = false;   // network failure
    throw e;
  }
}

// ================================================================ library
async function showLibrary(opts) {
  closeBook();
  // phone app: a new version is ready. The library shows meanwhile; it switches once the new version has taken
  // over, if the library is still showing with nothing open (not right after a book was added or removed: its
  // message is shown first, see updateAfterBusy)
  if (!(opts && opts.deferUpdate) && window.__reloadForUpdate && window.__switchToUpdate) window.__switchToUpdate();
  document.body.classList.remove('immersive');
  $('#toast').hidden = true;
  $('#reader').hidden = true;
  $('#library').hidden = false;
  document.title = 'Immersive Reader';
  $('#btn-phone').hidden = !isLocal;
  $('#btn-add').hidden = !(isLocal || OFFLINE);
  let books, stats = null;
  try {
    [books, stats] = await Promise.all([
      api('api/books').then((r) => r.json()),
      api('api/stats').then((r) => r.json()).catch(() => null),
      isLocal ? fetch('api/jobs', { cache: 'no-store' }).then((r) => r.json()).then((j) => { jobsCache = j; }).catch(() => {}) : null,
    ]);
  } catch { return; }
  S.books = books;
  renderLibrary(books, stats);                    // library-ui.js
}

const coverCache = new Map();
async function loadCover(b, el) {
  try {
    if (!coverCache.has(b.id)) {
      coverCache.set(b.id, (async () => {
        const bk = ePub(b.epub, { openAs: 'epub' });
        const url = await bk.coverUrl();
        return url;
      })());
    }
    const url = await coverCache.get(b.id);
    if (url) el.innerHTML = `<img alt="" src="${url}">`;
  } catch { /* keep the placeholder */ }
}

// ================================================================ open / close
async function openBook(meta) {
  const my = S.openSeq = (S.openSeq || 0) + 1;      // a newer openBook/closeBook makes this one stop
  const stale = () => my !== S.openSeq;
  S.meta = meta;
  S.audioReady = false;
  S.follow = true; S.lastW = -1; S.loc = null; S.hl = []; S.sections = new Map(); S.sleep = null;
  S.pin = null; S.armed = null; S.pageShownAt = 0;
  Turns.reset();
  updateSleepUI();
  $('#library').hidden = true;
  $('#reader').hidden = false;
  $('#loading').hidden = false;
  $('#book-title').textContent = meta.title;
  $('#chapter-title').textContent = '';
  document.title = meta.title + ' · Immersive Reader';
  updateFollowUI();
  let pos = store.get('pos:' + meta.id) || {};
  const shared = await Shared.load(meta.id);         // notes.js: state shared by all devices
  if (stale()) return;
  const remote = shared && shared.position;
  let catchUp = null;
  // pos.moved = when this device itself last moved the place (by listening or jumping). Places saved by
  // older versions have no such time (they were re-stamped just for being open), so the synced place wins.
  if (remote && remote.time != null && (remote.updated || 0) > (pos.moved || 0) + 1000) {
    const here = pos.time;                            // (the same place, just sent a little later: nothing to say)
    pos = Object.assign(pos, { time: remote.time, cfi: remote.cfi || pos.cfi, moved: remote.updated || 0, word: null });
    if (remote.device && !fromHere(remote) && remote.time > 5 && !(here != null && Math.abs(remote.time - here) < 2)) {
      toast(`Picking up where you left off on ${remote.device}.`);
    }
  } else if (pos.time != null && pos.moved && (!remote || Math.abs((remote.time || 0) - pos.time) >= 2
             || (pos.word != null && Math.abs((remote.time || 0) - pos.time) > 1e-3))) {     // (a page reached by reading on: however small)
    // this device has a newer place the others never got (e.g. closed before it was sent): send it now,
    // with the time it was really reached, so it never beats something newer from another device
    catchUp = { op: 'position', v: 2, from: myId, time: pos.time, cfi: pos.cfi || null, dur: pos.dur || null,
      chapter: pos.chapter || null, device: deviceName(), updated: pos.moved };
  }
  Shared.resetPush(pos);
  if (catchUp) Shared.unsent = catchUp;             // [14] sent by the next save, and again until it arrives
  // the newest progress could not be fetched in time (slow connection): hold this device's place back until it is
  const pull = OFFLINE ? PhoneSync.pulls[meta.id] : (shared && shared.syncPending ? new Promise((res) => setTimeout(res, 4000)) : null);
  if (pull) Shared.holdUntil(pull);
  store.set('pos:' + meta.id, Object.assign(pos, { opened: Date.now() }));

  try {
    await loadSync();
    if (stale()) return;
    S.book = ePub(meta.epub, { openAs: 'epub' });
    // a book file that can't be opened (damaged, or gone): epub.js only reports it, "ready" never comes
    const openFailed = new Promise((res, rej) => S.book.on('openFailed', rej));
    S.rendition = S.book.renderTo('viewer', {
      width: '100%', height: '100%', flow: 'paginated',
      spread: settings.spread && !isTouch ? 'auto' : 'none', minSpreadWidth: 1100, allowScriptedContent: false,
    });
    registerThemes();
    S.rendition.hooks.content.register((contents) => { applyTypography(contents); wireContent(contents); });
    applySettings(false);
    S.rendition.on('relocated', (loc) => { S.loc = loc; S.pageShownAt = performance.now(); onRelocated(); });
    S.rendition.on('displayed', () => { S.navSeq++; });        // the book was shown somewhere (not a page turn)
    S.rendition.on('keydown', onKey);
    await Promise.race([S.book.ready, openFailed]);
    if (stale()) return;
    buildToc();
    Notes.attach();                                  // notes.js: highlights, selection menu
    S.book.coverUrl().then((u) => { S.coverUrl = u; setupMediaSession(); }).catch(() => {});
  } catch (e) {
    console.error(e);
    if (stale()) return;                             // (another book was opened, or the library shown, meanwhile)
    $('#loading').hidden = true;
    toast('Could not open this book.');
    return;
  }

  if (meta.audio) {
    audio.src = meta.audio;
    audio.playbackRate = settings.rate;
    $('#speed').value = String(settings.rate);
    await new Promise((res) => {
      const done = () => { audio.removeEventListener('loadedmetadata', done); audio.removeEventListener('error', done); res(); };
      audio.addEventListener('loadedmetadata', done); audio.addEventListener('error', done);
      setTimeout(done, 15000);
    });
    if (stale()) return;
    $('#scrub').max = String(Math.floor(audio.duration || 0));
    $('#t-dur').textContent = fmt(audio.duration);
    setupMediaSession();
    audio.currentTime = pos.time != null ? pos.time : 0;     // always explicit: never a place left from another book
    // a place reached by reading on (pageTurn) is that page's first word, also where many words share a moment
    if (S.sync && pos.word != null && pos.time != null && Math.abs(audio.currentTime - pos.time) < 0.05) {
      S.pin = { w: pos.word, from: audio.currentTime, to: audio.currentTime, carry: true, stamp: pos.moved || Date.now() };
    }
  }
  S.savedT = meta.audio ? (pos.time != null ? pos.time : 0) : null;    // where this window is; savePos compares with it
  S.savedW = S.pin ? S.pin.w : null;                                   // (and the word, for a place reached by reading on)
  S.audioReady = true;

  if (S.sync && meta.audio) {
    await S.rendition.display();
    await followAudio(true);
  } else {
    await S.rendition.display(pos.cfi || undefined);
  }
  if (stale()) return;
  $('#loading').hidden = true;
  onTime();
  drawTicks();
  Notes.updateBookmarkBtn();
  clearInterval(S.saveTimer);
  S.saveTimer = setInterval(() => savePos({ tick: true }), 5000);
  clearInterval(S.syncTimer);
  S.syncTimer = setInterval(() => { if (S.sync && !S.sync.complete) loadSync(true); }, 60000);
  if (isTouch && !store.get('tip-touch')) { toast('Tip: tap the left or right side to turn pages, the middle for full screen.', 5000); store.set('tip-touch', true); }
}

function closeBook() {
  S.openSeq = (S.openSeq || 0) + 1;                  // a book still opening stops here
  if (S.reloadDone) { audio.removeEventListener('loadedmetadata', S.reloadDone); S.reloadDone = null; }
  S.reloadTo = null;
  Turns.reset();                                     // page turns still waiting: dropped
  if (!S.book) return;
  audio.pause();                                     // first: a reading session that ends is synced right away
  savePos();
  Shared.pushPosition(true);
  Notes.hideMenu();
  audio.removeAttribute('src');
  audio.load();
  clearInterval(S.saveTimer); clearInterval(S.syncTimer); stopTick();
  S.sleep = null; audio.volume = 1;
  try { S.book.destroy(); } catch { /* ignore */ }
  S.book = S.rendition = S.sync = null; S.at = S.aw = null; S.audioReady = false; S.savedT = null;
  S.pin = null; S.armed = null;
  try { audio.currentTime = 0; } catch { /* clears a start position still pending from this book */ }
  $('#viewer').innerHTML = '';
  closePanels();
  Awake.update();                                    // (the screen may sleep again)
}

// opts.tick: the regular save every 5 s. opts.end: the window is closing. Any other save (the 'pause' event,
// leaving the app, closing the book) ends a reading session: it is sent at once.
function savePos(opts) {
  if (!S.meta || !S.book) return;
  // while the audio is still loading (or reloading) its time is 0, not the book's place: save nothing
  if (S.meta.audio && !(S.audioReady && audio.readyState >= 1)) return;
  const tick = !!(opts && opts.tick === true), end = !!(opts && opts.end === true);
  const prev = store.get('pos:' + S.meta.id) || {};
  const time = audio.src ? audio.currentTime : null;
  // a place reached by reading on stays one only while the audio stays there: once it moved away (play, a jump),
  // coming back to that time later is a new move, sent and stamped as such
  if (S.pin && S.pin.carry && !carriedPlace()) S.pin.carry = false;
  const carried = carriedPlace();
  // "moved" = the place really changed in THIS window (listening, a jump, or reading on), compared with where this
  // window was, not with the saved place (another window of the app may have saved a newer one). Just being open
  // is not a move, and then nothing but "still open" is written, so a forgotten window can't undo progress.
  // A place reached by reading on counts however small the step (from a page's last word, or where many words
  // share a moment of the audio): it is compared by its word (media clocks round times differently).
  const moved = time != null && S.savedT != null && (Math.abs(time - S.savedT) >= 1 || (carried && S.pin.w !== S.savedW));
  if (moved) {
    S.savedT = time;
    S.savedW = carried ? S.pin.w : null;
    store.set('pos:' + S.meta.id, Object.assign(prev, {
      time, dur: audio.duration || prev.dur || null,
      cfi: S.loc && S.loc.start ? S.loc.start.cfi : prev.cfi, chapter: currentChapter(audio.currentTime).title || prev.chapter,
      word: carried ? S.pin.w : null,
      opened: Date.now(), moved: carried ? S.pin.stamp : Date.now(),     // (reading on: when that page was reached)
    }));
  } else {
    store.set('pos:' + S.meta.id, Object.assign(prev, { opened: Date.now() }));
  }
  // reading on with the audio paused: the regular save sends the place at most every 5 minutes (not a GitHub
  // update per page); the end of the session sends it at once. Either way it is stamped with when that page was
  // reached, so it can never beat something newer from another device (e.g. a window left open)
  const place = carried ? { carried, stamp: S.pin.stamp, word: S.pin.w } : {};
  if (tick && audio.paused && carried) Shared.pushPosition(false, Object.assign({ lazy: true }, place));
  else Shared.pushPosition(audio.paused || end, Object.assign({ end }, place));
}

// ================================================================ sync data
async function loadSync(quiet) {
  const pill = $('#sync-pill');
  if (!S.meta.sync) { S.sync = null; pill.hidden = false; pill.textContent = 'No sync'; pill.title = 'Run align.bat to sync this book.'; return; }
  try {
    const s = await (await api(S.meta.sync)).json();
    let pts;
    if (s.at && s.aw) {
      pts = new Array(s.at.length);
      let t = 0, w = 0;
      for (let i = 0; i < s.at.length; i++) { t += s.at[i]; w += s.aw[i]; pts[i] = [t / 100, w]; }
    } else {
      pts = (s.anchors || []).slice();
    }
    pts.unshift([0, 0]);
    pts.push([s.duration, s.total_words]);
    pts.sort((a, b) => a[0] - b[0]);
    const at = new Float64Array(pts.length), aw = new Float64Array(pts.length);
    let n = 0;
    for (const [t, w] of pts) {                   // keep strictly increasing
      if (n && (w <= aw[n - 1] || t <= at[n - 1])) continue;
      at[n] = t; aw[n] = w; n++;
    }
    S.sync = s; S.at = at.subarray(0, n); S.aw = aw.subarray(0, n);
    S.spineW = s.spine.map((x) => x.word);
    S.dense = s.mode === 'dense';
    pill.hidden = false;
    pill.textContent = !s.complete ? 'Syncing…' : S.dense ? 'Word sync' : 'Page sync';
    pill.title = !s.complete ? 'The sync map is still being built; it refines itself while you read.'
      : S.dense ? `Every word is synced to the audio (${(s.points || n).toLocaleString()} points).`
        : 'Pages turn with the audio. Word highlighting is approximate.';
  } catch {
    if (!quiet) { pill.hidden = false; pill.textContent = 'Sync unavailable'; }
  }
}

function interp(xs, ys, x) {
  if (!xs || !xs.length) return null;
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[hi]) return ys[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
}
const wordAt = (t) => interp(S.at, S.aw, t);
const timeAt = (w) => interp(S.aw, S.at, w);

function currentChapter(t) {
  const ch = (S.sync && S.sync.chapters) || [];
  let i = -1;
  for (let k = 0; k < ch.length; k++) { if (ch[k].start <= t + 0.5) i = k; else break; }
  if (i < 0) return {};
  return { title: ch[i].title, start: ch[i].start, end: i + 1 < ch.length ? ch[i + 1].start : (S.sync.duration || audio.duration) };
}

// ---------------------------------------------------------------- words <-> DOM
function spineEntryFor(w) {
  let lo = 0, hi = S.spineW.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (S.spineW[m] <= w) { ans = m; lo = m + 1; } else hi = m - 1; }
  return S.sync.spine[ans];
}

function sectionFor(entry) {
  const sp = S.book.spine;
  let sec = sp.get(entry.index);
  const same = (a, b) => decodeURIComponent(a || '') === decodeURIComponent(b || '');
  if (!sec || !same(sec.href, entry.href)) sec = sp.get(entry.href) || sp.get(encodeURI(entry.href)) || sec;
  return sec;
}

function loadSection(sec) {
  if (!S.sections.has(sec.index)) {
    S.sections.set(sec.index, sec.load(S.book.load.bind(S.book)).then(() => indexSection(sec)));
  }
  return S.sections.get(sec.index);
}

function indexSection(sec) {
  const doc = sec.document;
  const nodes = [], starts = [], offs = [];
  let count = 0;
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = (n.parentNode && n.parentNode.nodeName || '').toLowerCase();
    if (p === 'script' || p === 'style' || p === 'title') continue;
    const o = [];
    const re = /\S+/g; let m;
    while ((m = re.exec(n.data))) o.push(m.index);
    nodes.push(n); starts.push(count); offs.push(o);
    count += o.length;
  }
  return { sec, doc, nodes, starts, offs, count };
}

function pointOf(ix, local) {
  local = Math.max(0, Math.min(local, ix.count - 1));
  let lo = 0, hi = ix.nodes.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ix.starts[m] <= local) { k = m; lo = m + 1; } else hi = m - 1; }
  while (k < ix.nodes.length - 1 && ix.offs[k].length === 0) k++;
  const j = Math.max(0, Math.min(local - ix.starts[k], ix.offs[k].length - 1));
  const node = ix.nodes[k], off = ix.offs[k][j] || 0;
  const end = off + ((node.data.slice(off).match(/^\S+/) || [''])[0].length);
  return { node, off, end };
}

// CFIs for word w: the point before it, and ranges covering [a, b] (inclusive) for highlights
async function locate(w, ranges = []) {
  const entry = spineEntryFor(w);
  const sec = sectionFor(entry);
  if (!sec) return null;
  const ix = await loadSection(sec);
  if (!ix.count) return null;
  const local = w - entry.word;
  const p = pointOf(ix, local);
  const r = ix.doc.createRange();
  r.setStart(p.node, p.off); r.setEnd(p.node, p.off);
  const out = { cfi: sec.cfiFromRange(r), ranges: [] };
  for (const [a, b] of ranges) {
    const pa = pointOf(ix, a - entry.word), pb = pointOf(ix, Math.max(a, b) - entry.word);
    const rr = ix.doc.createRange();
    try { rr.setStart(pa.node, pa.off); rr.setEnd(pb.node, pb.end); out.ranges.push(sec.cfiFromRange(rr)); } catch { out.ranges.push(null); }
  }
  return out;
}

async function wordAtCfi(cfiStr) {
  const cfi = new ePub.CFI(cfiStr);
  const sec = S.book.spine.get(cfi.spinePos);
  if (!sec || !S.sync) return null;
  const ix = await loadSection(sec);
  let range;
  try { range = cfi.toRange(ix.doc); } catch { range = null; }
  const entry = S.sync.spine.find((e) => e.index === sec.index) ||
                S.sync.spine.find((e) => decodeURIComponent(e.href) === decodeURIComponent(sec.href));
  if (!entry) return null;
  if (!range) return entry.word;
  return entry.word + localWordAt(ix, range.startContainer, range.startOffset);
}

function localWordAt(ix, container, offset) {
  const pt = ix.doc.createRange();
  pt.setStart(container, offset);
  pt.collapse(true);
  for (let k = 0; k < ix.nodes.length; k++) {
    const n = ix.nodes[k];
    if (n === container) {
      let j = 0;
      while (j < ix.offs[k].length && ix.offs[k][j] < offset) j++;
      if (j > 0) {
        const s = ix.offs[k][j - 1];
        const len = (n.data.slice(s).match(/^\S+/) || [''])[0].length;
        if (offset < s + len) j--;
      }
      return ix.starts[k] + j;
    }
    if (pt.comparePoint(n, 0) > 0) return ix.starts[k];
  }
  return ix.count;
}

// ================================================================ following the audio
// the word of the place in the audio. +0.1 s: measured (verify_sync.py) to best match the word being spoken with
// Whisper's timestamps (page-level sync: none). A place set for a word (reading on, Read from here) is exactly
// that word while the time is still there (also where many words share a moment of the audio)
const leadTime = () => (S.dense ? 0.1 : 0);
function placeWord() {
  if (!S.sync) return null;
  const t = audio.currentTime;
  if (S.pin && t >= S.pin.from - 0.05 && t <= S.pin.to + 0.05) return S.pin.w;
  const wf = wordAt(t + leadTime());
  return wf == null ? null : Math.floor(wf);
}
// is the place one reached by reading on (pageTurn), with the audio still there?
function carriedPlace() { return !!(S.pin && S.pin.carry && Math.abs(audio.currentTime - S.pin.to) < 0.05); }
// the audio time that stands for word w: just inside its start, so the word it shows and highlights is w itself
// (a little earlier would be the word before, often on the previous page). null if there's no such time
function timeForWord(w) {
  if (!S.sync || w == null || !isFinite(w)) return null;
  const lead = leadTime(), a = timeAt(w), b = timeAt(w + 1);
  if (a == null || !isFinite(a) || b == null || !isFinite(b)) return null;
  const end = Math.min(audio.duration || Infinity, S.sync.duration || Infinity) - 0.05;
  const t = Math.max(0, Math.min(end, a - lead + Math.min(0.02, Math.max(0, b - a) / 2)));
  return Math.floor(wordAt(t + lead)) === w ? t : null;
}

async function followAudio(force = false) {
  if (!S.sync || !S.rendition) return;
  const w = placeWord();
  if (w == null) return;
  if (!force && w === S.lastW) return;
  if (S.busy) { S.pending = true; return; }
  S.busy = true;
  try {
    // page-level (non-GPU) sync is only accurate to a few seconds: show a soft band instead of exact words
    const mode = settings.highlight === 'off' ? 'off' : S.dense ? settings.highlight : 'band';
    const ranges = mode === 'phrase' ? [[w - 2, w + 2], [w, w]] : mode === 'word' ? [[w, w]] : mode === 'band' ? [[w - 4, w + 10]] : [];
    const loc = await locate(w, ranges);
    if (!loc) return;
    // turn the page if the spoken word isn't on screen (at most about once a second, so a page that
    // epub.js mis-measures can never cause a display loop)
    const jumped = Math.abs(w - (S.lastDisplayW ?? -1e9)) > 400;          // a seek, not the next page
    const tooSoon = performance.now() - (S.lastDisplayAt || 0) < 900;
    if (S.follow && !onCurrentPage(loc.cfi) && tooSoon && !jumped) {
      clearTimeout(S.retryTimer);                                          // try again shortly
      S.retryTimer = setTimeout(() => { S.lastW = -1; followAudio(true); }, 950);
    } else if (S.follow && !onCurrentPage(loc.cfi)) {
      S.lastDisplayAt = performance.now();
      S.lastDisplayW = w;
      const v = $('#viewer');
      v.classList.add('turning');                 // brief fade so automatic page turns aren't jarring
      Overlay.clear('narration'); Overlay.clear('user');
      try { await S.rendition.display(loc.cfi); } finally { requestAnimationFrame(() => v.classList.remove('turning')); }
    }
    S.lastW = w;
    drawHighlight(loc.ranges, mode);
  } catch (e) {
    console.warn('follow failed', e);
  } finally {
    S.busy = false;
    if (S.pending) { S.pending = false; followAudio(); }
  }
}

// Is this position visible right now? Measured on screen: epub.js's page start/end can be wrong on
// chapter-opening pages (end before start), which used to make the reader re-show the page endlessly.
function onCurrentPage(cfi) {
  const seen = onScreen(cfi);
  if (seen != null) return seen;
  const loc = S.loc;                                   // fallback: epub.js's own idea of the page
  if (!loc || !loc.start || !loc.end) return false;
  const cmp = new ePub.CFI();
  try { return cmp.compare(cfi, loc.start.cfi) >= 0 && cmp.compare(cfi, loc.end.cfi) <= 0; } catch { return false; }
}
// the measuring part: true/false, or null when the position isn't in a shown section or can't be measured
function onScreen(cfi) {
  const side = screenSide(cfi);
  return side == null ? null : side === 0;
}
// where a position is: -1 before the page shown (left of it), 0 on it, 1 after it; null if it can't be measured
function screenSide(cfi) {
  let spinePos;
  try { spinePos = new ePub.CFI(cfi).spinePos; } catch { return null; }
  const viewer = $('#viewer').getBoundingClientRect();
  for (const c of S.rendition ? S.rendition.getContents() : []) {
    if (c.sectionIndex !== spinePos) continue;
    let r = null;
    try { r = c.range(cfi); } catch { r = null; }
    if (!r) continue;
    let rect = r.getBoundingClientRect();
    if (!rect.width && !rect.height && r.startContainer.nodeType === 3 && r.startOffset < r.startContainer.length) {
      const rr = r.cloneRange(); rr.setEnd(r.startContainer, r.startOffset + 1);   // collapsed: measure one character
      rect = rr.getBoundingClientRect();
    }
    if (!rect.width && !rect.height && !rect.left && !rect.top) return null;      // can't measure
    const x = c.window.frameElement.getBoundingClientRect().left + rect.left + Math.min(rect.width, 2);
    return x < viewer.left - 1 ? -1 : x > viewer.right + 1 ? 1 : 0;
  }
  return null;
}

// ---------------------------------------------------------------- highlight overlay
// Highlights are small boxes drawn over the visible words only. (epub.js draws its highlights on one
// SVG as wide as the whole chapter, which iPhones silently refuse to draw for longer chapters.)
const Overlay = {
  layer(name) {
    let el = document.getElementById('ov-' + name);
    if (!el) {
      el = document.createElement('div');
      el.id = 'ov-' + name; el.className = 'ov-layer';
      $('.stage').appendChild(el);
    }
    return el;
  },
  // on-screen rectangles (relative to .stage) of a CFI range in the rendered page(s)
  rects(cfi) {
    let spinePos;
    try { spinePos = new ePub.CFI(cfi).spinePos; } catch { return []; }
    const stage = $('.stage').getBoundingClientRect(), viewer = $('#viewer').getBoundingClientRect();
    for (const c of S.rendition ? S.rendition.getContents() : []) {
      if (c.sectionIndex !== spinePos) continue;
      let r = null;
      try { r = c.range(cfi); } catch { r = null; }
      if (!r) continue;
      const f = c.window.frameElement.getBoundingClientRect();
      const out = [];
      for (const q of r.getClientRects()) {
        if (q.width < 1 || q.height < 1) continue;
        const x = f.left + q.left, y = f.top + q.top;
        if (x + q.width / 2 < viewer.left || x + q.width / 2 > viewer.right) continue;       // other pages
        out.push({ x: x - stage.left, y: y - stage.top, w: q.width, h: q.height });
      }
      return out;
    }
    return [];
  },
  draw(name, items) {            // items: [{ cfi, color, opacity, cls, data }]
    const layer = this.layer(name);
    const dark = effTheme() === 'dark';
    const html = [];
    const boxes = [];
    for (const it of items) {
      for (const b of this.rects(it.cfi)) {
        boxes.push({ ...b, item: it });
        html.push(`<i class="ov-box ${it.cls || ''}" style="left:${b.x - 1}px;top:${b.y}px;width:${b.w + 2}px;height:${b.h}px;` +
          `background:${it.color};opacity:${it.opacity};mix-blend-mode:${dark ? 'screen' : 'multiply'}"></i>`);
      }
    }
    layer.innerHTML = html.join('');
    return boxes;
  },
  clear(name) { const el = document.getElementById('ov-' + name); if (el) el.innerHTML = ''; },
};

function clearHighlight() {
  Overlay.clear('narration');
  S.hl = [];
}

function drawHighlight(ranges, mode) {
  S.hl = [];
  if (!S.rendition || mode === 'off' || !ranges || !ranges.length) { Overlay.clear('narration'); return; }
  const dark = effTheme() === 'dark';
  const color = dark ? '#d39a5c' : '#e3a94a';
  const soft = dark ? 0.16 : 0.2, strong = dark ? 0.38 : 0.5;
  const opac = mode === 'band' ? [dark ? 0.15 : 0.2] : mode === 'phrase' ? [soft, strong] : [strong];
  const items = [];
  ranges.forEach((cfi, i) => { if (cfi) { items.push({ cfi, color, opacity: opac[i] ?? opac[0] }); S.hl.push(cfi); } });
  Overlay.draw('narration', items);
}

function setFollow(on) {
  S.follow = on;
  S.navSeq++;                                          // (a page turn that is still carrying the place stops)
  updateFollowUI();
  if (on) { S.lastW = -1; followAudio(true); }
}
function updateFollowUI() {
  $('#return-chip').hidden = S.follow || audio.paused || !S.sync;
  const b = $('#btn-follow');
  b.classList.toggle('on', S.follow);
  b.querySelector('span').textContent = S.follow ? 'Following' : 'Back to audio';
  b.title = S.follow ? 'Pages turn with the audio. Turning a page yourself pauses this. (F)'
    : 'Jump back to where the audio is and keep following (F)';
}

// play from the top of the page on screen. The audio starts a moment before its first word; meanwhile the page
// stays (that moment belongs to the previous page's last word, which used to flip the page back for a second)
async function readFromHere() {
  if (!S.sync || !S.rendition) return;
  let w = await firstWordShown();
  if (w == null && S.rendition) {                      // a page without words (a picture): from the text after it
    const l = S.rendition.currentLocation();
    w = l && l.start ? await wordAtCfi(l.start.cfi) : null;
    // (epub.js gives such a page the start of the text after it inside a chapter, but on a chapter's last pages
    // the start of its last text, before the page: then from the next chapter)
    if (w != null && S.rendition) {
      const last = l.end && l.end.displayed && l.end.displayed.page === l.end.displayed.total;
      const lc = await locate(w);
      if (last || (lc && screenSide(lc.cfi) < 0)) {
        const next = S.sync.spine.find((e) => e.index > l.start.index);
        if (next) w = next.word;
      }
    }
  }
  if (w == null || !S.rendition) return;
  const at = timeForWord(w);
  const to = at != null ? at : Math.max(0, timeAt(w) - leadTime());
  audio.currentTime = Math.max(0, to - 0.25);
  S.pin = { w, from: audio.currentTime, to };
  setFollow(true);
  audio.play().catch(() => {});
  Awake.update(true);
}

// the first word shown on the page now; null if it shows none (e.g. a picture). epub.js's own idea of the page's
// start is a hint: it can be a word or two off, or point at the next section
async function firstWordShown(loc) {
  if (!S.sync || !S.rendition) return null;
  loc = loc || S.rendition.currentLocation();
  const hint = loc && loc.start && loc.start.cfi;
  if (!hint) return null;
  let w = await wordAtCfi(hint);
  if (w == null || !S.rendition) return null;
  const last = S.sync.total_words != null ? S.sync.total_words - 1 : Infinity;
  const shown = async (x) => {
    if (x < 0 || x > last) return false;
    const l = await locate(x);
    return !!(l && onScreen(l.cfi) === true);         // measured only (S.loc can still be the page before)
  };
  let k = 0;
  while (!(await shown(w))) { if (++k > 50 || !S.rendition) return null; w++; }
  for (let b = 0; b < 10 && (await shown(w - 1)); b++) w--;
  return w;
}

// smooth updates while playing (timeupdate alone fires only ~4x a second)
function startTick() {
  stopTick();
  S.tickTimer = setInterval(() => { followAudio(); checkSleep(); Shared.tickListen(); Awake.tick(); }, 90);
}
function stopTick() { clearInterval(S.tickTimer); S.tickTimer = null; }

// chapter marks on the progress bar
function drawTicks() {
  const el = $('#ticks');
  el.innerHTML = '';
  const dur = audio.duration;
  if (!dur || !S.sync || !S.sync.chapters) return;
  for (const c of S.sync.chapters) {
    if (c.start < 5) continue;
    const i = document.createElement('i');
    i.style.left = (100 * c.start / dur).toFixed(3) + '%';
    i.title = chapterLabel(c.title);
    el.appendChild(i);
  }
}

// ================================================================ UI updates
let lastSlow = 0;
function onTime() {
  const t = audio.currentTime || 0;
  $('#t-cur').textContent = fmt(t);
  if (!scrubbing) $('#scrub').value = String(Math.floor(t));
  const now = performance.now();
  if (now - lastSlow > 1000) { lastSlow = now; updateChapter(t); updatePosition(); }
  if (audio.paused) followAudio();
}

let lastChapterTitle = null;
function updateChapter(t) {
  const c = currentChapter(t);
  const el = $('#chapter-title');
  let txt = c.title ? chapterLabel(c.title) : '';
  if (c.title && c.end) txt += ` · ${mins((c.end - t) / (audio.playbackRate || 1))} left`;
  if (el.textContent !== txt) el.textContent = txt;
  if (c.title !== lastChapterTitle) {
    lastChapterTitle = c.title;
    $$('#toc a').forEach((a) => a.classList.toggle('current', !!c.title && a.dataset.title === c.title));
  }
}

function onRelocated() {
  const loc = S.loc;
  $('#zone-prev').style.visibility = loc && loc.atStart ? 'hidden' : '';
  $('#zone-next').style.visibility = loc && loc.atEnd ? 'hidden' : '';
  if (S.lastW >= 0 && settings.highlight !== 'off') { S.lastW = -1; followAudio(true); }
}

function buildToc() {
  const nav = $('#toc');
  nav.innerHTML = '';
  const chapterTimes = new Map();
  if (S.sync && S.sync.chapters) for (const c of S.sync.chapters) chapterTimes.set(c.title, c.start);
  const walk = (items, lvl) => {
    for (const it of items) {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'lvl' + Math.min(lvl, 2);
      const label = (it.label || '').trim();
      a.dataset.title = label;
      const l = document.createElement('span'); l.className = 'l'; l.textContent = chapterLabel(label); a.appendChild(l);
      if (chapterTimes.has(label)) {
        const s = document.createElement('span'); s.className = 't'; s.textContent = fmt(chapterTimes.get(label)); a.appendChild(s);
      }
      a.addEventListener('click', (e) => { e.preventDefault(); gotoTocItem(it, label); });
      nav.appendChild(a);
      if (it.subitems && it.subitems.length) walk(it.subitems, lvl + 1);
    }
  };
  walk(S.book.navigation.toc, 0);
  lastChapterTitle = null;
}

async function gotoTocItem(it, label) {
  closePanels();
  const ch = S.sync && S.sync.chapters.find((c) => c.title === label);
  if (ch && S.meta.audio) {
    audio.currentTime = ch.start;
    setFollow(true);
  } else {
    setFollow(false);
    await S.rendition.display(it.href);
  }
}

// ================================================================ themes, typography, settings
const THEME_COLORS = { light: ['#1f1d1a', '#fbfaf7'], sepia: ['#3b2f22', '#f4ecd8'], dark: ['#dedbd5', '#18181b'] };
function registerThemes() {
  for (const [name, [fg, bg]] of Object.entries(THEME_COLORS)) {
    S.rendition.themes.register(name, {
      body: { color: `${fg} !important`, background: `${bg} !important` },
      a: { color: 'inherit !important' },
      img: name === 'dark' ? { 'max-width': '100% !important', opacity: '.85' } : { 'max-width': '100% !important' },
    });
  }
}

const FONTS = {
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};
function typographyCss() {
  let css = '';
  if (settings.fontFamily !== 'book') css += `body, p, div, span, blockquote, li { font-family: ${FONTS[settings.fontFamily]} !important; }\n`;
  if (settings.lineHeight !== 'book') css += `body, p, div, blockquote, li { line-height: ${settings.lineHeight} !important; }\n`;
  css += 'body { -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; }\n';
  return css;
}
function applyTypography(contents) {
  const doc = contents.document;
  let st = doc.getElementById('ra-typo');
  if (!st) { st = doc.createElement('style'); st.id = 'ra-typo'; (doc.head || doc.documentElement).appendChild(st); }
  st.textContent = typographyCss();
}

// touch gestures inside the book page (taps and swipes)
function wireContent(contents) {
  const doc = contents.document;
  if (doc.__raWired) return;                     // the hook can run again for the same page after a resize
  doc.__raWired = true;
  // Does the app hear anything on the book page? On iPhones (WebKit) it doesn't: the page is a sandboxed frame
  // without scripts, so these listeners never run. Then the page edges become invisible tap strips (reader.css,
  // body.frame-blind); elsewhere the page keeps its own taps (also selecting text, links, highlights).
  let heard = false;
  doc.addEventListener('ra-probe', () => { heard = true; });
  doc.dispatchEvent(new Event('ra-probe'));
  document.body.classList.toggle('frame-blind', !heard);
  doc.addEventListener('dblclick', (e) => playFromPoint(contents, e));
  doc.addEventListener('click', (e) => {
    if (isTouch || String(doc.getSelection ? doc.getSelection() : '')) return;
    const h = Notes.hitAt(contents, e.clientX, e.clientY);
    if (h) Notes.edit(h);
  });
  let sx = 0, sy = 0, st = 0;
  doc.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  doc.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
    if (doc.getSelection && String(doc.getSelection())) return;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 700) { pageTurn(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 350) {
      if (e.target.closest && e.target.closest('a[href]')) return;      // real links only (calibre wraps text in <a id>)
      const hit = Notes.hitAt(contents, t.clientX, t.clientY);
      if (hit) { Notes.edit(hit); return; }
      // the book frame is wider than the screen (one column per page) and shifted; convert to screen position
      const frame = doc.defaultView && doc.defaultView.frameElement;
      const left = frame ? frame.getBoundingClientRect().left : 0;
      const x = (left + t.clientX) / (window.innerWidth || 1);
      if (x < 0.28) pageTurn(-1);
      else if (x > 0.72) pageTurn(1);
      else document.body.classList.toggle('immersive');
    }
  }, { passive: true });
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const effTheme = () => (settings.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme);
darkQuery.addEventListener && darkQuery.addEventListener('change', () => { if (settings.theme === 'auto') { applySettings(false); S.lastW = -1; followAudio(true); } });

function applySettings(relayout = true) {
  document.body.dataset.theme = effTheme();
  document.body.classList.toggle('spread', !!settings.spread && !isTouch);
  document.documentElement.style.setProperty('--page-w', { narrow: '640px', normal: '780px', wide: '1020px' }[settings.width] || '780px');
  document.querySelector('meta[name="theme-color"]').content = { light: '#fffdf9', sepia: '#f7f0e1', dark: '#1d1d21' }[effTheme()];
  $$('.seg[data-setting]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(settings[seg.dataset.setting]) === b.dataset.v));
  });
  $('#font-val').textContent = settings.font + '%';
  $('#opt-spread').checked = !!settings.spread;
  $('#opt-awake').checked = settings.keepAwake !== false;
  if (S.rendition) {
    S.rendition.themes.select(effTheme());
    if (typeof Notes !== 'undefined') Notes.renderAll();
    S.rendition.themes.fontSize(settings.font + '%');
    S.rendition.getContents().forEach(applyTypography);
    if (relayout) {
      try { S.rendition.resize(); } catch { /* ignore */ }
      setTimeout(() => { S.lastW = -1; followAudio(true); }, 250);
    }
  }
}

// ================================================================ sleep timer
function setSleep(v) {
  if (v === '0') S.sleep = null;
  else if (v === 'chapter') {
    const c = currentChapter(audio.currentTime);
    S.sleep = c.end ? { chapterEnd: c.end } : null;
  } else S.sleep = { until: Date.now() + (+v) * 60000 };
  audio.volume = 1;
  updateSleepUI();
  Awake.update();                                       // (with a sleep timer the screen may turn off)
  closePanels();
  if (S.sleep) toast(v === 'chapter' ? 'Will pause at the end of this chapter.' : `Will pause in ${v} minutes.`);
}
function sleepLeft() {
  if (!S.sleep) return null;
  if (S.sleep.until) return (S.sleep.until - Date.now()) / 1000;
  return (S.sleep.chapterEnd - audio.currentTime) / (audio.playbackRate || 1);
}
function checkSleep() {
  const left = sleepLeft();
  if (left == null) return;
  if (left <= 0) { audio.pause(); audio.volume = 1; S.sleep = null; updateSleepUI(); toast('Sleep timer: paused.'); return; }
  audio.volume = left < 8 ? Math.max(0.05, left / 8) : 1;          // gentle fade-out
}
function updateSleepUI() {
  const left = sleepLeft();
  const badge = $('#sleep-badge');
  $('#btn-sleep').classList.toggle('active', left != null);
  badge.hidden = left == null;
  if (left != null) badge.textContent = S.sleep.chapterEnd ? 'ch' : String(Math.ceil(left / 60));
  $('#sleep-status').textContent = left == null ? 'Pause the audio after a while. The sound fades out gently.'
    : S.sleep.chapterEnd ? `Pausing at the end of this chapter (in about ${mins(left)}).` : `Pausing in ${mins(left)}.`;
  $$('#sleep-choices button').forEach((b) => b.classList.toggle('on',
    (left == null && b.dataset.sleep === '0') || (S.sleep && S.sleep.chapterEnd && b.dataset.sleep === 'chapter')));
}
setInterval(() => { if (S.sleep) updateSleepUI(); }, 15000);

// ================================================================ keeping the screen on while the audio plays
// Reading along, you don't touch the screen, so it would turn off (Auto-Lock). While the audio plays with a book
// open, and the setting is on, the app asks to keep it on. Not with a sleep timer (you're falling asleep), and never
// while paused or with the library showing. iPhones only allow this from iOS 18.4, and only after a tap: a play
// started by a tap asks right away; otherwise the next tap anywhere (also on the book page) asks again.
const Awake = {
  s: null, asking: 0, askedAt: 0,
  wanted() {
    return settings.keepAwake !== false && 'wakeLock' in navigator && !!S.book && !audio.paused && !audio.error
      && !S.sleep && document.visibilityState === 'visible';
  },
  held() { return !!this.s && !this.s.released; },
  update(gesture = false) {
    if (!this.wanted()) { this.drop(); return; }
    if (this.held()) return;
    if (this.asking > 0 && !gesture && Date.now() - this.askedAt < 5000) return;   // one at a time (unless from a tap)
    this.asking++; this.askedAt = Date.now();
    let req;
    try { req = navigator.wakeLock.request('screen'); } catch { this.asking--; return; }
    Promise.resolve(req).then((s) => {
      this.asking--;
      if (!s || s.released) return;
      if (!this.wanted() || this.held()) { s.release().catch(() => {}); return; }   // paused or hidden meanwhile
      this.s = s;
      s.addEventListener('release', () => { if (this.s === s) this.s = null; });     // (the browser lets go when hidden)
    }, () => { this.asking--; });                       // not allowed now: asked again on the next tap
  },
  drop() { const s = this.s; this.s = null; if (s && !s.released) s.release().catch(() => {}); },
  // while playing (every 90 ms): ask again after a tap (a tap on the book page counts, though it never reaches us)
  tick() {
    if (this.held() || this.asking > 0 || Date.now() - this.askedAt < 1000 || !this.wanted()) return;
    const tapped = navigator.userActivation ? navigator.userActivation.isActive : Date.now() - this.askedAt > 3000;
    if (tapped) this.update(true);
  },
};
['touchend', 'click', 'keydown'].forEach((type) => document.addEventListener(type, () => {
  if (!Awake.held() && Awake.wanted()) Awake.update(true);
}, { capture: true, passive: true }));

// ================================================================ media session (lock screen, headset buttons)
function setupMediaSession() {
  if (!('mediaSession' in navigator) || !S.meta) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S.meta.title, artist: 'Immersive Reader',
      artwork: S.coverUrl ? [{ src: S.coverUrl, sizes: '512x768', type: 'image/jpeg' }] : [{ src: 'reader/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch { /* ignore */ }
  const h = {
    play: () => audio.play(), pause: () => audio.pause(),
    seekbackward: () => skip(-15), seekforward: () => skip(30),
    seekto: (d) => { audio.currentTime = d.seekTime; },
    previoustrack: () => jumpChapter(-1), nexttrack: () => jumpChapter(1),
  };
  for (const [k, f] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, f); } catch { /* unsupported */ } }
}
function updatePosition() {
  if (!('mediaSession' in navigator) || !audio.duration || !navigator.mediaSession.setPositionState) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* ignore */ }
}
function jumpChapter(d) {
  const ch = (S.sync && S.sync.chapters) || [];
  const t = audio.currentTime;
  let i = ch.findIndex((c, k) => c.start <= t && (k + 1 >= ch.length || ch[k + 1].start > t));
  if (d < 0 && i >= 0 && t - ch[i].start > 5) d = 0;              // "previous" restarts the chapter first
  const target = ch[Math.max(0, Math.min(ch.length - 1, i + d))];
  if (target) { audio.currentTime = target.start; setFollow(true); }
}

function skip(d) { audio.currentTime = Math.max(0, Math.min((audio.duration || 0) - 1, audio.currentTime + d)); }
function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) { audio.play().catch(() => toast('Tap play again to start the audio.')); Awake.update(true); } else audio.pause();
}

// ================================================================ page turns, and reading on with the audio paused
// While the audio is paused, reading on page by page moves your place along: when you turn forward from the page
// that shows the place, the place becomes the next page's first word (its time in the audio), so it is saved and
// synced, and play continues from there. Only a page you stayed on for a moment counts (S.dwellMs: a quick flip to
// peek ahead doesn't, though it keeps the chain going), and turning back never moves it (to look something up).
// Turns are done one after another (a queue), and a closed book drops the ones still waiting.
const Turns = {
  q: [], busy: false, seq: 0,
  reset() { const q = this.q; this.q = []; this.seq++; this.busy = false; q.forEach((t) => t.done(false)); },
  async pump() {
    if (this.busy) return;
    const t = this.q.shift();
    if (!t) return;
    this.busy = true;
    const my = this.seq;
    let r = false;
    try { r = await turnStep(t.dir, my); } catch (e) { console.warn('page turn failed', e); }
    t.done(r);
    if (my !== this.seq) return;                         // the book was closed (or another opened) meanwhile
    this.busy = false;
    this.pump();
  },
};
function pageTurn(dir) {
  return new Promise((done) => {
    // (not while the book is still opening; and a key held down doesn't pile up turns)
    if (!S.rendition || !$('#loading').hidden || Turns.q.length >= 2) { done(false); return; }
    Turns.q.push({ dir, done });
    Turns.pump();
  });
}
// a promise, or false after ms (epub.js can leave a turn unsettled when the book is closed meanwhile)
const within = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(false), ms))]);

async function turnStep(dir, my) {
  const live = () => my === Turns.seq && !!S.rendition;
  const r = S.rendition;
  if (!r) return false;
  const carry = dir > 0 ? await carryFrom() : null;     // decided on the page being left
  if (!live()) return false;
  const follow0 = S.follow;
  if (carry) S.follow = false;                            // (quietly: the button stays as it is if the place moves on)
  else if (S.follow) setFollow(false);
  const nav0 = S.navSeq;
  try {
    await within(dir > 0 ? r.next() : r.prev(), S.turnWaitMs);
  } catch (e) {                                           // the page couldn't be turned: as it was
    if (carry && live()) { S.follow = follow0; updateFollowUI(); }
    throw e;
  }
  if (!live()) return false;
  S.pageShownAt = performance.now();                     // (a turn waiting right behind this one hasn't read it)
  if (!carry) return true;
  const settle = () => { if (!S.follow) updateFollowUI(); };
  // anything else moving the book or the audio meanwhile (a jump, a seek, play) wins over this turn
  const same = () => live() && S.navSeq === nav0 && audio.paused && Math.abs(audio.currentTime - carry.t) < 0.01;
  const loc = r.currentLocation();                       // (the page now shown; 'relocated' only comes a frame later)
  const start = loc && loc.start && loc.start.cfi, page = pageOf(loc);
  // (did the page turn? Its start alone can't tell: epub.js gives a page without words the start of a neighbour)
  if (!same() || !start || (start === carry.start && page === carry.page)) { settle(); return true; }
  const arm = () => { S.armed = { cfi: start, page, t: audio.currentTime }; settle(); return true; };
  if (!carry.now) {
    if (carry.remind) Shared.remindOffer();
    return arm();
  }
  const w = await firstWordShown(loc);
  if (!same()) { settle(); return true; }
  if (w == null) return arm();                           // a page without words (a map, a picture): carried on past it
  if (carry.wp != null && w <= carry.wp) { settle(); return true; }
  const t = timeForWord(w);
  if (t == null) return arm();                           // no audio time stands for this word (e.g. after the narration)
  audio.currentTime = t;
  // stamped now, when the page is reached (later than anything known now, like any move): sent later, it can't
  // beat what another device does meanwhile
  const known = (Shared.state && Shared.state.position && Shared.state.position.updated) || 0;
  S.pin = { w, from: audio.currentTime, to: audio.currentTime, carry: true, stamp: Math.max(Date.now(), known + 1) };
  S.armed = null;
  S.loc = loc;                                           // (the page now shown, for the place's saved CFI)
  setFollow(true);
  savePos({ tick: true });                               // kept on this device at once (sent later, see savePos)
  return true;
}

// Does a forward turn from the page shown now carry the place along? null if not; otherwise what the turn needs:
// { t: the audio time now, start: this page's start, wp: the place's word, now: carry it now (or only keep the
// chain going: a quick flip, or newer progress from another device not yet known or answered), remind }
async function carryFrom() {
  if (!S.sync || !S.meta || !S.meta.audio || !audio.paused || !S.audioReady || audio.readyState < 1 || S.reloadTo != null) return null;
  const loc = S.rendition.currentLocation();
  const start = loc && loc.start && loc.start.cfi, page = pageOf(loc);
  if (!start) return null;
  const t = audio.currentTime, wp = placeWord();
  // (an armed page still counts after the text was laid out again, e.g. turned sideways or a new text size, as long
  // as its first words are still on screen)
  let holds = !!(S.armed && Math.abs(S.armed.t - t) < 0.01
    && ((S.armed.page === page && S.armed.cfi === start) || onScreen(S.armed.cfi) === true));
  if (!holds && wp != null) {
    const l = await locate(wp);
    holds = !!(l && onScreen(l.cfi) === true);
  }
  if (!holds || !S.rendition) return null;
  // newer progress from another device may be on its way (just opened, or back to the app) or was offered and not
  // answered: the first such turn shows the offer again, and only a further one takes over
  const waiting = !!(Shared.hold || Shared.resuming);
  const o = Shared.pendingOffer;
  const remind = !waiting && !!(o && !o.reminded && o.at > Shared.lastMoveAt + 1000);
  const read = performance.now() - (S.pageShownAt || 0) >= S.dwellMs;
  return { t, start, page, wp, now: read && !waiting && !remind, remind };
}
// which page is shown: its section and page number there
const pageOf = (l) => (l && l.start && l.start.displayed ? l.start.index + ':' + l.start.displayed.page : null);
function closePanels() { $$('.panel').forEach((p) => { p.hidden = true; }); }
function togglePanel(id) { const p = $(id); const open = p.hidden; closePanels(); p.hidden = !open; if (open && id === '#toc-panel') { const c = $('#toc a.current'); if (c) c.scrollIntoView({ block: 'center' }); } }

// ================================================================ phone pairing (PC only)
async function openPhone() {
  $('#phone-dialog').hidden = false;
  await refreshPhone();
}
async function refreshPhone(st) {
  try { st = st || await (await api('api/phone')).json(); } catch { return; }
  $('#opt-lan').checked = st.lan;
  $('#opt-startup').checked = st.startup;
  $('#phone-on').hidden = !(st.lan && st.listening);
  const err = $('#phone-error');
  err.hidden = !st.error || !st.lan;
  err.textContent = st.error || '';
  const choices = st.choices || [];
  $('#ip-row').hidden = !(st.lan && choices.length > 1);
  $('#ip-choice').innerHTML = choices.map((ip) => `<option value="${ip}"${ip === st.ip ? ' selected' : ''}>${ip}</option>`).join('');
  if (st.lan && st.listening && st.pairUrl) {
    $('#phone-url').textContent = st.url;
    const qr = qrcode(0, 'M');
    qr.addData(st.pairUrl);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
  }
}
async function setPhone(body) {
  try {
    const st = await (await api('api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' }, body: JSON.stringify(body) })).json();
    await refreshPhone(st);
  } catch { toast('Could not change phone access.'); }
}

// ================================================================ events
function onKey(e) {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.key !== 'Escape') return;
  if (e.key === 'Escape') {
    const modal = $$('.modal').find((m) => !m.hidden && m.id !== 'offline');
    if (modal) { closeModal(modal); return; }
    if (!$('#sel-menu').hidden) { Notes.hideMenu(); return; }
    if ($$('.panel').some((p) => !p.hidden)) { closePanels(); return; }
    if (S.book) showLibrary();
    return;
  }
  if (e.key === '?' && !S.book) { $('#keys-dialog').hidden = false; return; }
  if (!S.book || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': case 'PageDown': e.preventDefault(); pageTurn(1); break;
    case 'ArrowLeft': case 'PageUp': e.preventDefault(); pageTurn(-1); break;
    case 'j': case 'J': skip(-15); break;
    case 'l': case 'L': skip(30); break;
    case 'f': case 'F': setFollow(true); break;
    case 'c': case 'C': togglePanel('#toc-panel'); break;
    case 'b': case 'B': Notes.toggleBookmark(); break;
    case 'n': case 'N': Notes.openPanel(); break;
    case '/': e.preventDefault(); openSearch(); break;
    case '?': $('#keys-dialog').hidden = false; break;
    case '[': case ']': {
      const opts = $$('#speed option').map((o) => +o.value);
      const i = opts.indexOf(settings.rate);
      const next = opts[Math.max(0, Math.min(opts.length - 1, (i < 0 ? 2 : i) + (e.key === ']' ? 1 : -1)))];
      settings.rate = next; audio.playbackRate = next; $('#speed').value = String(next); saveSettings(); toast(`Speed ${next}×`, 1200);
      break;
    }
  }
}
document.addEventListener('keydown', onKey);

$('#btn-back').addEventListener('click', showLibrary);
$('#btn-play').addEventListener('click', togglePlay);
$('#btn-back15').addEventListener('click', () => skip(-15));
$('#btn-fwd30').addEventListener('click', () => skip(30));
$('#zone-prev').addEventListener('click', () => pageTurn(-1));
$('#zone-next').addEventListener('click', () => pageTurn(1));
$('#btn-follow').addEventListener('click', () => setFollow(true));
$('#return-chip').addEventListener('click', () => setFollow(true));
$('#btn-here').addEventListener('click', readFromHere);
$('#btn-toc').addEventListener('click', () => togglePanel('#toc-panel'));
$('#btn-settings').addEventListener('click', () => togglePanel('#settings-panel'));
$('#btn-sleep').addEventListener('click', () => { updateSleepUI(); togglePanel('#sleep-panel'); });
$('#sleep-choices').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSleep(b.dataset.sleep); });
$$('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
$$('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { b.closest('.modal').hidden = true; }));
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'offline') closeModal(m); }));
// Esc or a tap outside a dialog: most just close; Sync also turns the camera off; a book transfer is only
// stopped by its own buttons (and the phone's "Receive?" counts as "Not now")
function closeModal(m) {
  if (m.id === 'sync-dialog') SyncUI.close();
  else if (m.id === 'receive-dialog' && typeof Receiver !== 'undefined') Receiver.dismiss();
  else if (m.id === 'send-dialog' && typeof Sender !== 'undefined') Sender.dismiss();
  else m.hidden = true;
}
$('#btn-phone').addEventListener('click', openPhone);
$('#opt-lan').addEventListener('change', (e) => setPhone({ lan: e.target.checked }));
$('#opt-startup').addEventListener('change', (e) => setPhone({ lan: true, startup: e.target.checked }));
$('#ip-choice').addEventListener('change', (e) => setPhone({ lan: true, ip: e.target.value }));
$('#btn-newkey').addEventListener('click', () => { if (confirm('Make a new key? Phones you already paired will need to scan the new code.')) setPhone({ lan: true, newKey: true }); });
$('#btn-retry').addEventListener('click', () => { $('#offline').hidden = true; if (S.book) { loadSync(true); reloadAudio(); } else showLibrary(); });
// reload the audio (e.g. after the PC was out of reach) without losing the place: a reload starts at 0
function reloadAudio() {
  const id = S.meta.id;
  if (S.reloadTo == null) S.reloadTo = S.audioReady ? audio.currentTime : ((store.get('pos:' + id) || {}).time || 0);
  const wasPlaying = !audio.paused;
  S.audioReady = false;
  if (S.reloadDone) audio.removeEventListener('loadedmetadata', S.reloadDone);   // one reload at a time
  S.reloadDone = () => {
    S.reloadDone = null;
    if (!S.meta || S.meta.id !== id) return;          // another book was opened meanwhile
    const t = S.reloadTo; S.reloadTo = null;
    if (t) audio.currentTime = t;
    audioLoaded();
    S.audioReady = true;
    if (wasPlaying) audio.play().catch(() => {});
  };
  audio.addEventListener('loadedmetadata', S.reloadDone, { once: true });
  audio.load();
  if (wasPlaying) audio.dispatchEvent(new Event('pause'));   // load() pauses without saying so: update the controls
}
// after the audio (re)loaded: speed, length, chapter marks, lock-screen info
function audioLoaded() {
  audio.playbackRate = settings.rate;
  $('#speed').value = String(settings.rate);
  $('#scrub').max = String(Math.floor(audio.duration || 0));
  $('#t-dur').textContent = fmt(audio.duration);
  try { drawTicks(); setupMediaSession(); } catch { /* ignore */ }
}

$('#speed').addEventListener('change', (e) => { settings.rate = +e.target.value; audio.playbackRate = settings.rate; saveSettings(); });
$('#font-dn').addEventListener('click', () => { settings.font = Math.max(70, settings.font - 10); saveSettings(); applySettings(); });
$('#font-up').addEventListener('click', () => { settings.font = Math.min(200, settings.font + 10); saveSettings(); applySettings(); });
$$('.seg[data-setting]').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const key = seg.dataset.setting;
  settings[key] = b.dataset.v;
  saveSettings();
  applySettings(key !== 'highlight' && key !== 'theme');
  if (key === 'highlight' || key === 'theme') { S.lastW = -1; followAudio(true); }
}));
$('#opt-spread').addEventListener('change', (e) => {
  settings.spread = e.target.checked; saveSettings(); applySettings(false);
  if (S.rendition) { S.rendition.spread(settings.spread ? 'auto' : 'none', 1100); setTimeout(() => { S.lastW = -1; followAudio(true); }, 300); }
});
$('#opt-awake').addEventListener('change', (e) => { settings.keepAwake = e.target.checked; saveSettings(); Awake.update(true); });
// (a browser that can't keep the screen on, e.g. the phone's browser over plain http: no such setting)
if (!('wakeLock' in navigator)) $('#row-awake').hidden = true;

// phones and touch screens: the page edges are invisible tap strips (on iPhones, taps on the book page itself never
// reach the app). A sideways swipe that starts on them turns the page too.
$$('.zone').forEach((z) => {
  let sx = 0, sy = 0, st = 0;
  z.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  z.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 700) { e.preventDefault(); pageTurn(dx < 0 ? 1 : -1); }
  });
});

let scrubbing = false;
const scrub = $('#scrub');
scrub.addEventListener('input', () => { scrubbing = true; $('#t-cur').textContent = fmt(+scrub.value); });
scrub.addEventListener('change', () => { scrubbing = false; audio.currentTime = +scrub.value; setFollow(true); });

audio.addEventListener('timeupdate', onTime);
audio.addEventListener('seeked', () => { S.lastW = -1; followAudio(true); updatePosition(); updateChapter(audio.currentTime); });
audio.addEventListener('play', () => { $('#ico-play').hidden = true; $('#ico-pause').hidden = false; $('#btn-play').setAttribute('aria-label', 'Pause'); startTick(); updateFollowUI(); Shared.remindOffer(); Awake.update(); });
audio.addEventListener('pause', () => {
  $('#ico-play').hidden = false; $('#ico-pause').hidden = true; $('#btn-play').setAttribute('aria-label', 'Play');
  stopTick(); savePos(); updateFollowUI(); Awake.update();
  S.pageShownAt = performance.now();                   // (reading on counts from here: listening isn't reading the page)
});
audio.addEventListener('ratechange', updatePosition);
audio.addEventListener('waiting', () => $('#btn-play').classList.add('buffering'));
['playing', 'pause', 'canplay', 'seeked'].forEach((ev) => audio.addEventListener(ev, () => $('#btn-play').classList.remove('buffering')));
audio.addEventListener('error', () => {
  if (audio.getAttribute('src') && !audio.getAttribute('src').includes('local-audio/')) toast("The audiobook couldn't be loaded. Check that the PC is reachable.");
  Awake.update();                                      // (nothing plays: the screen may turn off)
});
// the window closes: send the place now (also while playing), and sync it right away
window.addEventListener('beforeunload', () => savePos({ end: true }));
window.addEventListener('pagehide', () => savePos({ end: true }));
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.book) { S.lastW = -1; followAudio(true); Notes.renderAll(); } }, 250); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) savePos();
  else if (S.book) {
    S.lastW = -1; followAudio(true);
    S.pageShownAt = performance.now();                 // (time away from the app isn't time reading the page)
    Shared.resume();                                   // and see if another device got further
  }
  Awake.update();
});

// heartbeat: lets the background server know a reader window is still open
setInterval(() => { fetch('api/ping', { cache: 'no-store' }).then(() => { $('#offline').hidden = true; }).catch(() => {}); }, 20000);

window.addEventListener('DOMContentLoaded', () => { applySettings(false); showLibrary(); });
