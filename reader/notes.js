'use strict';
/* Immersive Reader: things you keep while reading.
 *  - Shared: reading state stored on the PC (position, bookmarks, highlights, listening time), so the
 *    PC and paired phones all see the same thing
 *  - Notes: bookmarks, highlights with notes, the selection menu, the notes panel and export
 *  - playFromPoint: double-click a word to start the audio there
 *  - Search: find text in the book and jump the reading + audio there
 * Uses globals from reader.js (S, $, $$, audio, api, toast, settings, ...).
 */

const deviceName = () => (isLocal ? 'your PC'
  : /iPhone|iPad/.test(navigator.userAgent) ? (OFFLINE ? 'your iPhone app' : 'your iPhone')
    : /Android/.test(navigator.userAgent) ? (OFFLINE ? 'your phone app' : 'your phone') : 'another device');
// a random id for this window of the app, so a synced place can be recognised as this window's own
// (two windows on one PC are told apart too: a forgotten window gets the 'Go there' offer, not the last word)
const myId = (() => {
  const make = () => Math.random().toString(36).slice(2, 10);
  try { let v = sessionStorage.getItem('ra:winid'); if (!v) { v = make(); sessionStorage.setItem('ra:winid', v); } return v; } catch { return make(); }
})();
const fromHere = (p) => (p && p.from ? p.from === myId : !!p && p.device === deviceName());
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// shorten text without cutting an emoji (or other 2-part character) in half
const cut = (s, n) => { s = String(s); if (s.length <= n) return s; const c = s.charCodeAt(n - 1); return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n); };
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ================================================================ shared state
const Shared = {
  state: null, lastPushT: -1, lastPushAt: 0, listenAcc: 0, lastTick: 0,
  lastMoveAt: 0,          // when this device last moved the listening position (its own clock)
  offeredAt: 0,           // the other device's position we last offered to jump to

  async load(id) {
    try { this.state = await (await api('api/state/' + encodeURIComponent(id))).json(); } catch { this.state = null; }
    return this.state;
  },
  async send(ops) {
    if (!S.meta) return null;
    try {
      const r = await api('api/state/' + encodeURIComponent(S.meta.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' }, body: JSON.stringify(ops),
      });
      this.state = await r.json();
      return this.state;
    } catch { return null; }
  },
  // a book was opened at pos: that place is not news, so it is not sent again until the listening moves
  // (re-sending an unchanged place as "newest" would override progress made on another device)
  resetPush(pos) {
    this.lastPushT = pos && pos.time != null ? pos.time : -1;
    this.lastPushW = pos && pos.word != null ? pos.word : null;     // (a place reached by reading on: its word)
    this.lastPushAt = 0;
    this.listenAcc = 0; this.lastTick = 0;     // (listening time left over from another book isn't this book's)
    this.lastMoveAt = (pos && pos.moved) || 0;
    this.openedWith = this.lastMoveAt;        // the place's time stamp when the book was opened
    this.offeredAt = 0;
    this.pendingOffer = null;
    this.hold = false;
    this.resuming = false;
    this.resumeFrom = null;                   // (back in the app: was this device playing then?)
    this.owedPos = false;                     // a place held back while coming back, sent when the news is in
    this.flushOwed = false;
    this.unsent = null;
    this.unsentListen = [];
  },
  // the book was opened before the newest progress could be fetched (slow connection): don't send this
  // device's place until it arrives, then offer the other device's place if it is newer
  holdUntil(pending) {
    this.hold = true;
    const book = S.meta && S.meta.id;
    const release = async () => {
      if (!this.hold || !S.meta || S.meta.id !== book) return;
      await this.refresh();
      this.hold = false;
      this.checkAhead(true);
    };
    Promise.resolve(pending).then(release, release);
    setTimeout(release, 30000);               // never hold back for long
  },
  unsent: null,           // a place that could not be sent (no connection): sent again later, unchanged
  unsentListen: [],       // listening-time reports that could not be sent: sent again as they were (counted once)
  flushOwed: false,       // something was sent without asking for an immediate sync: the session's end asks for it
  // force: the end of a reading session (or a jump while paused): send now, and (when paused, or opts.end: the
  // window closes) ask for an immediate sync. opts.lazy: a place reached by reading on, sent at most every 5 min.
  // opts.carried / word / stamp: that place (it counts as new however small the step; stamped when it was reached).
  pushPosition(force, opts = {}) {
    if (!S.meta || !audio.getAttribute('src') || !S.audioReady || audio.readyState < 1) return;
    // just opened before the newest progress could be fetched: nothing is sent until it is (the place shown may be
    // behind; a newer one is then offered). Just back in the app, newer news may be on its way: only the end of a
    // session is sent meanwhile. Its place goes out only if this device was still playing when it came back
    // (listening in the background), stamped when it was reached; a place reached after coming back waits until
    // the news is in (Shared.resume sends it then, after offering any newer place)
    if (this.hold || (this.resuming && !force)) return;
    const held = this.resuming;
    const t = audio.currentTime, now = Date.now();
    if (!force && now - this.lastPushAt < (opts.lazy ? 300000 : 15000)) return;
    const ops = [];
    let posOp = null;
    const movedOn = Math.abs(t - this.lastPushT) >= 2 || (opts.carried && opts.word !== this.lastPushW);
    const wait = held && movedOn && !opts.carried && !(this.resumeFrom && this.resumeFrom.playing);
    if (wait) this.owedPos = true;
    else if (movedOn) {
      // stamped later than the place it replaces, even if this device's clock is a little behind
      const stamp = opts.stamp != null ? opts.stamp
        : held ? Math.max((store.get('pos:' + S.meta.id) || {}).moved || now, this.lastMoveAt + 1)
          : Math.max(now, ((this.state && this.state.position && this.state.position.updated) || 0) + 1);
      posOp = { op: 'position', v: 2, from: myId, time: t, cfi: S.loc && S.loc.start ? S.loc.start.cfi : null, dur: audio.duration || null,
        chapter: currentChapter(t).title || null, device: deviceName(), updated: stamp };
      this.lastPushT = t; this.lastPushW = opts.carried ? opts.word : null;
      this.lastMoveAt = Math.max(this.lastMoveAt, stamp);
      if (!(this.pendingOffer && stamp < this.pendingOffer.at)) this.pendingOffer = null;   // (an older place doesn't answer it)
    } else if (this.unsent) posOp = this.unsent;   // keeps its own time stamp, so it never beats newer news
    if (posOp) ops.push(posOp);
    const secs = this.listenAcc >= 1 ? Math.round(this.listenAcc) : 0;
    const listenOps = [...this.unsentListen];
    if (secs) { listenOps.push({ op: 'listened', id: uid(), date: today(), seconds: secs }); this.listenAcc = 0; }
    ops.push(...listenOps);
    // a reading session ended (pause, close, leave, the window closes): sync it now, also when what it changed
    // was already sent (e.g. a place reached by reading on, sent by the regular save)
    const ending = force && (audio.paused || !!opts.end);
    if (!ops.length && !(ending && this.flushOwed)) return;
    if (ending) ops.push({ op: 'flush' });
    this.flushOwed = !ending;
    this.lastPushAt = now;
    const book = S.meta.id;
    this.send(ops).then((r) => {
      if (r) {
        if (posOp) this.unsent = null;
        this.unsentListen = this.unsentListen.filter((x) => !listenOps.includes(x));
        return;
      }
      if (!S.meta || S.meta.id !== book) return;           // another book by now
      if (ending) this.flushOwed = true;                   // (still owed: asked for again at the next session end)
      if (posOp && (!this.unsent || (this.unsent.updated || 0) <= posOp.updated)) this.unsent = posOp;
      for (const x of listenOps) if (!this.unsentListen.includes(x)) this.unsentListen.push(x);
    });
  },
  // another device (or window) got further while this one sat paused: offer to go there (never jump by itself).
  // afterPull: the newest progress arrived late (slow connection at open, or just back in the app): also while
  // playing, against the place this device had then (base; at open: the place the book was opened with)
  checkAhead(afterPull, base) {
    const r = this.state && this.state.position;
    if (!r || !S.book || (!audio.paused && !afterPull) || !r.device || fromHere(r) || r.time == null) return;
    const at = r.updated || 0;
    const mine = afterPull ? Math.max(base != null ? base : (this.openedWith || 0), 0) : this.lastMoveAt;
    if (at <= mine + 1000 || at <= this.offeredAt || Math.abs(r.time - audio.currentTime) < 30) return;
    this.offeredAt = at;
    this.pendingOffer = { r, at };
    this.showOffer();
  },
  showOffer() {
    const o = this.pendingOffer;
    if (!o || !S.book) return;
    const { r, at } = o;
    const ch = chapterLabel(currentChapter(r.time).title || '');
    const what = r.time > audio.currentTime ? 'You got further on' : r.time < 5 ? 'You started over on' : 'You went back to an earlier place on';
    toast(`${what} ${r.device}${ch ? ` (${ch})` : ''}.`, 15000, {
      label: 'Go there',
      run: () => {
        // if this device already sent its own place over the offered one, send the offered one again as the newest
        // (otherwise the other devices would keep this device's older place)
        const over = this.lastMoveAt > at;
        audio.currentTime = r.time; setFollow(true);
        this.lastPushT = over ? -Infinity : r.time;
        if (!over) this.lastMoveAt = at;
        this.pendingOffer = null;
        if (over) savePos();
      },
    });
  },
  // pressing play while an offer was missed: show it once more before this device's place takes over
  remindOffer() {
    const o = this.pendingOffer;
    if (o && o.at > this.lastMoveAt + 1000 && !o.reminded) { o.reminded = true; this.showOffer(); }
  },
  tickListen() {                                   // wall-clock time spent listening
    const now = performance.now();
    if (!audio.paused && this.lastTick && now - this.lastTick < 2000) this.listenAcc += (now - this.lastTick) / 1000;
    this.lastTick = now;
  },
};

// ================================================================ bookmarks & highlights
const HL_COLORS = { yellow: '#f2d24b', green: '#8fd18b', blue: '#7fb6f0', pink: '#f19ac0' };

const Notes = {
  drawn: [],
  tab: 'bookmarks',
  sel: null,              // { cfiRange, contents, text }
  editing: null,

  attach() {
    S.rendition.on('selected', (cfiRange, contents) => this.onSelect(cfiRange, contents));
    S.rendition.on('relocated', () => { this.hideMenu(); this.updateBookmarkBtn(); this.renderAll(); });
    this.renderAll();
  },

  list(kind) { return ((Shared.state && Shared.state[kind]) || []).filter((x) => !x.deleted); },   // hide deleted ones

  // ---- drawing the reader's own highlights
  boxes: [],
  renderAll() {                                   // drawn as small boxes over the visible words (see Overlay)
    if (!S.rendition) return;
    const dark = effTheme() === 'dark';
    this.boxes = Overlay.draw('user', this.list('highlights').map((h) => ({
      cfi: h.cfi, color: HL_COLORS[h.color] || HL_COLORS.yellow, opacity: dark ? 0.32 : 0.42, data: h })));
  },
  draw() { this.renderAll(); },
  // a tap/click at (clientX, clientY) inside a page: is it on one of your highlights?
  hitAt(contents, clientX, clientY) {
    const f = contents.window.frameElement.getBoundingClientRect(), st = $('.stage').getBoundingClientRect();
    const x = f.left + clientX - st.left, y = f.top + clientY - st.top;
    const b = this.boxes.find((q) => x >= q.x - 2 && x <= q.x + q.w + 2 && y >= q.y - 2 && y <= q.y + q.h + 2);
    return b ? b.item.data : null;
  },

  // ---- where in the audio is a piece of text?
  async place(cfi) {
    const out = { word: null, time: null, chapter: null };
    try {
      const w = await wordAtCfi(cfi);
      if (w != null) {
        out.word = w;
        if (S.sync) out.time = timeAt(w);
        const ch = (S.sync && S.sync.chapters) || [];
        for (const c of ch) { if (c.word <= w) out.chapter = c.title; else break; }
      }
    } catch { /* ignore */ }
    return out;
  },

  // ---- selection menu
  onSelect(cfiRange, contents) {
    const selObj = contents.window.getSelection();
    const text = String(selObj || '').trim();
    if (!text) return this.hideMenu();
    this.sel = { cfiRange, contents, text };
    const r = selObj.getRangeAt(0).getBoundingClientRect();
    const frame = contents.window.frameElement.getBoundingClientRect();
    const menu = $('#sel-menu');
    menu.hidden = false;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = frame.left + r.left + r.width / 2 - mw / 2;
    let y = frame.top + r.top - mh - 10;
    if (y < 60) y = frame.top + r.bottom + 10;
    x = Math.max(8, Math.min(window.innerWidth - mw - 8, x));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  },
  hideMenu() { $('#sel-menu').hidden = true; this.sel = null; },
  clearSelection() {
    try { this.sel && this.sel.contents.window.getSelection().removeAllRanges(); } catch { /* ignore */ }
    this.hideMenu();
  },

  async addHighlight(color, withNote) {
    if (!this.sel) return;
    const { cfiRange, text } = this.sel;
    const where = await this.place(cfiRange);
    const h = { id: uid(), cfi: cfiRange, text: cut(text, 2000), color, note: '', created: Date.now(), ...where };
    this.clearSelection();
    await Shared.send([{ op: 'add', kind: 'highlights', item: h }]);
    this.draw(h);
    if (withNote) this.edit(h);
    else toast('Highlighted. Click it to add a note.', 1800);
  },

  async playSelection() {
    if (!this.sel || !S.sync) return;
    const where = await this.place(this.sel.cfiRange);
    this.clearSelection();
    if (where.time != null) playAt(where.time);
  },

  async copySelection() {
    if (!this.sel) return;
    const t = this.sel.text;
    this.clearSelection();
    try { await navigator.clipboard.writeText(t); toast('Copied.', 1200); } catch {
      const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied.', 1200); } catch { /* ignore */ }
      ta.remove();
    }
  },

  // ---- note editor
  edit(h) {
    this.editing = h;
    $('#note-quote').textContent = h.text;
    $('#note-text').value = h.note || '';
    $$('#note-colors .dot').forEach((d) => d.classList.toggle('on', d.dataset.color === (h.color || 'yellow')));
    $('#note-dialog').hidden = false;
    setTimeout(() => $('#note-text').focus(), 50);
  },
  async saveEdit() {
    const h = this.editing; if (!h) return;
    const color = ($('#note-colors .dot.on') || {}).dataset ? $('#note-colors .dot.on').dataset.color : h.color;
    const item = { id: h.id, note: $('#note-text').value.trim(), color };
    $('#note-dialog').hidden = true;
    await Shared.send([{ op: 'update', kind: 'highlights', item }]);
    this.renderAll();
    if (!$('#notes-panel').hidden) this.renderPanel();
  },
  async deleteEdit() {
    const h = this.editing; if (!h) return;
    $('#note-dialog').hidden = true;
    await Shared.send([{ op: 'remove', kind: 'highlights', id: h.id }]);
    this.renderAll();
    if (!$('#notes-panel').hidden) this.renderPanel();
  },

  // ---- bookmarks
  pageBookmark() { return this.list('bookmarks').find((b) => onCurrentPage(b.cfi)); },
  updateBookmarkBtn() {
    const on = !!(S.book && this.pageBookmark());
    const b = $('#btn-bookmark');
    b.classList.toggle('active', on);
    b.title = on ? 'Remove this bookmark (B)' : 'Bookmark this page (B)';
  },
  async toggleBookmark() {
    if (!S.loc || !S.loc.start) return;
    const existing = this.pageBookmark();
    if (existing) {
      await Shared.send([{ op: 'remove', kind: 'bookmarks', id: existing.id }]);
      toast('Bookmark removed.', 1400);
    } else {
      const cfi = S.loc.start.cfi;
      const where = await this.place(cfi);
      let text = '';
      try { text = (await S.book.getRange(S.loc.start.cfi + '')).toString(); } catch { /* ignore */ }
      if (!text && where.word != null) text = await snippetAt(where.word, 18);
      await Shared.send([{ op: 'add', kind: 'bookmarks', item: { id: uid(), cfi, text: cut(text, 300), created: Date.now(), ...where } }]);
      toast('Bookmarked.', 1400);
    }
    this.updateBookmarkBtn();
    if (!$('#notes-panel').hidden) this.renderPanel();
  },

  // ---- notes panel
  openPanel(tab) {
    if (tab) this.tab = tab;
    closePanels();
    $('#notes-panel').hidden = false;
    this.renderPanel();
  },
  renderPanel() {
    $$('#notes-panel .tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const items = this.list(this.tab).slice().sort((a, b) => (a.word ?? 1e12) - (b.word ?? 1e12));
    const el = $('#notes-list');
    if (!items.length) {
      el.innerHTML = `<p class="empty muted">${this.tab === 'bookmarks'
        ? 'No bookmarks yet. Press the ribbon button (or B) to bookmark the page you\'re on.'
        : 'No highlights yet. Select some text to highlight it or add a note.'}</p>`;
      return;
    }
    el.innerHTML = items.map((x) => `
      <div class="item" data-id="${esc(x.id)}">
        <button class="go">
          <span class="meta">${esc(x.chapter ? chapterLabel(x.chapter) : '')}${x.time != null ? ' · ' + fmt(x.time) : ''}</span>
          <span class="txt${this.tab === 'highlights' ? ' hl' : ''}" ${this.tab === 'highlights' ? `style="--c:${HL_COLORS[x.color] || HL_COLORS.yellow}"` : ''}>${esc((x.text || '').slice(0, 220))}${(x.text || '').length > 220 ? '…' : ''}</span>
          ${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}
        </button>
        <div class="acts">
          ${this.tab === 'highlights' ? '<button class="icon edit" title="Edit note"><svg><use href="#i-pen"/></svg></button>' : ''}
          <button class="icon del" title="Delete"><svg><use href="#i-trash"/></svg></button>
        </div>
      </div>`).join('');
  },
  async onPanelClick(e) {
    const item = e.target.closest('.item'); if (!item) return;
    const x = this.list(this.tab).find((i) => i.id === item.dataset.id); if (!x) return;
    if (e.target.closest('.del')) {
      await Shared.send([{ op: 'remove', kind: this.tab, id: x.id }]);
      if (this.tab === 'highlights') this.renderAll();
      this.updateBookmarkBtn();
      this.renderPanel();
    } else if (e.target.closest('.edit')) {
      this.edit(x);
    } else if (e.target.closest('.go')) {
      closePanels();
      if (x.time != null && S.sync && S.meta.audio) playAt(x.time, !audio.paused);
      else { setFollow(false); await S.rendition.display(x.cfi); }
    }
  },

  // ---- export everything as a Markdown file
  exportMarkdown() {
    const title = S.meta.title, author = S.meta.author || '';
    const all = [...this.list('bookmarks').map((b) => ({ ...b, kind: 'bookmark' })), ...this.list('highlights').map((h) => ({ ...h, kind: 'highlight' }))]
      .sort((a, b) => (a.word ?? 1e12) - (b.word ?? 1e12));
    let md = `# ${title}\n${author ? `*${author}*\n` : ''}\nNotes exported from Immersive Reader on ${new Date().toLocaleDateString()}.\n`;
    let chapter = null;
    for (const x of all) {
      if (x.chapter !== chapter) { chapter = x.chapter; md += `\n## ${chapter ? chapterLabel(chapter) : 'Front matter'}\n`; }
      const at = x.time != null ? ` (${fmt(x.time)})` : '';
      if (x.kind === 'bookmark') md += `\n- 🔖 Bookmark${at}: ${(x.text || '').trim().slice(0, 160)}…\n`;
      else md += `\n> ${(x.text || '').trim().replace(/\n+/g, ' ')}${at}\n${x.note ? `\n${x.note}\n` : ''}`;
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[\\/:*?"<>|]/g, '')} - notes.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
};

// ================================================================ playing from a word
function playAt(t, keepPlaying = true) {
  audio.currentTime = Math.max(0, t - 0.05);
  setFollow(true);
  if (keepPlaying) audio.play().catch(() => {});
}

function caretAt(doc, x, y) {
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  return null;
}

async function playFromPoint(contents, e) {
  if (!S.sync || !S.meta.audio) return;
  const doc = contents.document;
  const pos = caretAt(doc, e.clientX, e.clientY);
  if (!pos) return;
  const sec = S.book.spine.get(contents.sectionIndex);
  if (!sec) return;
  const ix = await loadSection(sec);
  const entry = S.sync.spine.find((x) => x.index === sec.index);
  if (!entry) return;
  // map the caret in the live page to the same text node in our indexed copy of the section
  const path = [];
  for (let n = pos.node; n && n !== doc.body; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
  let node = ix.doc.body;
  for (const i of path) node = node && node.childNodes[i];
  if (!node) return;
  const w = entry.word + localWordAt(ix, node, pos.offset);
  try { contents.window.getSelection().removeAllRanges(); } catch { /* ignore */ }
  Notes.hideMenu();
  playAt(timeAt(w));
}

async function snippetAt(w, n) {
  try {
    const entry = spineEntryFor(w);
    const ix = await loadSection(sectionFor(entry));
    const a = pointOf(ix, w - entry.word), b = pointOf(ix, w - entry.word + n);
    const r = ix.doc.createRange(); r.setStart(a.node, a.off); r.setEnd(b.node, b.end);
    return r.toString();
  } catch { return ''; }
}

// ================================================================ search
const Search = { token: 0, results: [] };

function openSearch() {
  if (!S.book) return;
  closePanels();
  $('#search-panel').hidden = false;
  const inp = $('#search-input');
  inp.focus(); inp.select();
}

async function runSearch(q) {
  const my = ++Search.token;
  const status = $('#search-status'), out = $('#search-results');
  q = q.trim();
  if (q.length < 3) { status.textContent = q ? 'Type at least 3 letters.' : ''; out.innerHTML = ''; return; }
  status.textContent = 'Searching…';
  out.innerHTML = '';
  const needle = q.toLowerCase();
  const results = [];
  const items = S.book.spine.spineItems || [];
  for (const sec of items) {
    if (my !== Search.token) return;
    let ix;
    try { ix = await loadSection(sec); } catch { continue; }
    // one long string per section, remembering where each text node starts
    let text = '';
    const starts = [];
    for (const n of ix.nodes) { if (text && !/\s$/.test(text)) text += ' '; starts.push(text.length); text += n.data; }
    const lower = text.toLowerCase();
    const entry = S.sync && S.sync.spine.find((x) => x.index === sec.index);
    for (let at = lower.indexOf(needle); at >= 0 && results.length < 300; at = lower.indexOf(needle, at + needle.length)) {
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1] <= at) k++;
      const off = at - starts[k];
      const r = ix.doc.createRange();
      r.setStart(ix.nodes[k], off);
      let k2 = k, end = at + needle.length;
      while (k2 + 1 < starts.length && starts[k2 + 1] < end) k2++;
      r.setEnd(ix.nodes[k2], Math.min(ix.nodes[k2].data.length, end - starts[k2]));
      let word = null;
      if (entry) { let j = 0; while (j < ix.offs[k].length && ix.offs[k][j] <= off) j++; word = entry.word + ix.starts[k] + Math.max(0, j - 1); }
      const before = text.slice(Math.max(0, at - 70), at).replace(/\s+/g, ' ');
      const after = text.slice(end, end + 90).replace(/\s+/g, ' ');
      results.push({ cfi: sec.cfiFromRange(r), word, before, match: text.slice(at, end), after });
    }
    if (results.length >= 300) break;
  }
  if (my !== Search.token) return;
  Search.results = results;
  const chapterOf = (w) => { let t = null; for (const c of (S.sync && S.sync.chapters) || []) { if (c.word <= w) t = c.title; else break; } return t; };
  status.textContent = results.length ? `${results.length >= 300 ? '300+' : results.length} result${results.length === 1 ? '' : 's'}` : 'No matches.';
  out.innerHTML = results.map((x, i) => `
    <div class="item result" data-i="${i}">
      <button class="go">
        <span class="meta">${esc(x.word != null && chapterOf(x.word) ? chapterLabel(chapterOf(x.word)) : '')}${x.word != null && S.sync ? ' · ' + fmt(timeAt(x.word)) : ''}</span>
        <span class="txt">…${esc(x.before)}<mark>${esc(x.match)}</mark>${esc(x.after)}…</span>
      </button>
      ${x.word != null && S.sync && S.meta.audio ? '<div class="acts"><button class="icon res-play" title="Play from here"><svg><use href="#i-play"/></svg></button></div>' : ''}
    </div>`).join('');
}

async function onSearchClick(e) {
  const item = e.target.closest('.result'); if (!item) return;
  const x = Search.results[+item.dataset.i]; if (!x) return;
  if (e.target.closest('.res-play')) { closePanels(); playAt(timeAt(x.word)); return; }
  if (isTouch) closePanels();
  setFollow(false);
  await S.rendition.display(x.cfi);
  // flash the match so it's easy to spot
  setTimeout(() => Overlay.draw('flash', [{ cfi: x.cfi, color: '#ffd54a', opacity: 0.6 }]), 120);
  setTimeout(() => Overlay.clear('flash'), 2400);
}

// ================================================================ wiring
$('#sel-menu').addEventListener('mousedown', (e) => e.preventDefault());       // keep the selection while clicking
$('#sel-menu').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.color) Notes.addHighlight(b.dataset.color, false);
  else if (b.dataset.act === 'note') Notes.addHighlight('yellow', true);
  else if (b.dataset.act === 'play') Notes.playSelection();
  else if (b.dataset.act === 'copy') Notes.copySelection();
});
$('#note-colors').addEventListener('click', (e) => {
  const d = e.target.closest('.dot'); if (!d) return;
  $$('#note-colors .dot').forEach((x) => x.classList.toggle('on', x === d));
});
$('#note-save').addEventListener('click', () => Notes.saveEdit());
$('#note-delete').addEventListener('click', () => Notes.deleteEdit());
$('#note-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) Notes.saveEdit(); });
$('#btn-bookmark').addEventListener('click', () => Notes.toggleBookmark());
$('#btn-notes').addEventListener('click', () => ($('#notes-panel').hidden ? Notes.openPanel() : closePanels()));
$('#notes-panel .tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { Notes.tab = b.dataset.tab; Notes.renderPanel(); } });
$('#notes-list').addEventListener('click', (e) => Notes.onPanelClick(e));
$('#btn-export').addEventListener('click', () => Notes.exportMarkdown());
$('#btn-search').addEventListener('click', () => ($('#search-panel').hidden ? openSearch() : closePanels()));
let searchTimer = null;
$('#search-input').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 350); });
$('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); } });
$('#search-results').addEventListener('click', onSearchClick);
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#sel-menu')) Notes.hideMenu(); });
// other devices may have added notes: refresh now and then
setInterval(async () => {
  if (!S.book || !S.meta || document.hidden) return;
  const before = JSON.stringify([Shared.state && Shared.state.highlights, Shared.state && Shared.state.bookmarks]);
  await Shared.load(S.meta.id);
  Shared.afterLoad(before);
}, 60000);
// fresh reading data arrived (from this or another device): redraw notes, offer the newer place
Shared.afterLoad = function (before) {
  if (!S.book) return;
  if (JSON.stringify([Shared.state && Shared.state.highlights, Shared.state && Shared.state.bookmarks]) !== before) {
    Notes.renderAll(); Notes.updateBookmarkBtn();
    if (!$('#notes-panel').hidden) Notes.renderPanel();
  }
  Shared.checkAhead();
};
Shared.refresh = async function () {
  if (!S.book || !S.meta) return;
  const before = JSON.stringify([Shared.state && Shared.state.highlights, Shared.state && Shared.state.bookmarks]);
  await Shared.load(S.meta.id);
  Shared.afterLoad(before);
};
// back to the app after a while: other devices may have moved on meanwhile. Until their news is in, this device's
// place isn't sent (and reading on doesn't move it), so a newer place is offered, never overwritten
Shared.resume = async function () {
  const book = S.meta && S.meta.id;
  if (!book || !S.book) return;
  const my = (this.resumeSeq = (this.resumeSeq || 0) + 1);
  const base = this.lastMoveAt;                           // this device's place when it came back
  this.resumeFrom = { playing: !audio.paused };           // (still listening in the background: an ongoing session)
  this.resuming = true;
  const done = () => { if (this.resumeSeq === my) this.resuming = false; };
  const timer = setTimeout(done, 15000);                  // never hold back for long
  try {
    await this.refresh();
    const same = () => S.meta && S.meta.id === book;
    if (this.state && this.state.syncPending && same()) {    // the PC is still asking GitHub
      await new Promise((res) => setTimeout(res, 4000));
      await this.refresh();
    } else if (OFFLINE && PhoneSync.pulls[book] && same()) { // the phone is still asking GitHub
      await PhoneSync.pulls[book];
      if (same()) await this.refresh();
    }
  } catch { /* offline: nothing newer to know */ } finally { clearTimeout(timer); done(); }
  // newer progress from another device: offered also if this device started playing meanwhile; then the place held
  // back meanwhile is sent (as new: 'Go there' still wins the offered one back)
  if (this.resumeSeq === my && S.meta && S.meta.id === book) {
    this.checkAhead(true, base);
    if (this.owedPos && S.book) { this.owedPos = false; savePos(); }
  }
};
