'use strict';
/* Read-Along library screen: continue / up next, listening stats, series shelves, book info, and
 * adding new books (drag & drop or file picker → upload → background preparation with progress).
 * Uses globals from reader.js and notes.js.
 */

const fmtDur = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const lastActivity = (b) => Math.max((store.get('pos:' + b.id) || {}).opened || 0, (b.position && b.position.updated) || 0);
const progressOf = (b) => {
  const local = store.get('pos:' + b.id) || {};
  const remote = b.position || {};
  const pos = (remote.updated || 0) > (local.moved || 0) ? remote : local;    // this device's own place only if it moved there later
  const dur = b.duration || local.dur || remote.dur;
  return { time: pos.time || 0, dur, chapter: pos.chapter || local.chapter, pct: dur && pos.time ? Math.min(100, (100 * pos.time) / dur) : 0 };
};

let jobsCache = [];

function renderLibrary(books, stats) {
  renderStats(stats);
  const jobFolders = new Set(jobsCache.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.folder));

  // ---------------- continue / up next
  const cont = $('#continue');
  cont.innerHTML = '';
  const recent = books.filter((b) => lastActivity(b) > 0 && !jobFolders.has(b.id)).sort((a, b) => lastActivity(b) - lastActivity(a))[0];
  if (recent) {
    let target = recent, eyebrow = 'Continue';
    if (recent.finished && recent.series) {
      const next = books.filter((b) => b.series === recent.series && b.seriesIndex > recent.seriesIndex)
        .sort((a, b) => a.seriesIndex - b.seriesIndex)[0];
      if (next && !next.finished) { target = next; eyebrow = `Up next in ${recent.series}`; }
    }
    const pr = progressOf(target);
    const el = document.createElement('button');
    el.className = 'continue';
    const status = target === recent
      ? [pr.chapter ? chapterLabel(pr.chapter) : null, pr.pct ? `${Math.round(pr.pct)}%` : null,
        pr.dur && pr.time ? `${mins(pr.dur - pr.time)} left` : null].filter(Boolean).join(' · ')
      : `Book ${target.seriesIndex} · ${fmtDur(target.duration)}`;
    el.innerHTML = `<div class="cover"><div class="ph"></div></div>
      <div><div class="eyebrow"></div><div class="name"></div><div class="author muted"></div>
      <div class="status"></div><div class="bar"><i style="width:${pr.pct.toFixed(1)}%"></i></div>
      <span class="go">▶&nbsp; ${target === recent ? 'Resume' : 'Start'}</span></div>`;
    el.querySelector('.eyebrow').textContent = eyebrow;
    el.querySelector('.ph').textContent = target.title;
    el.querySelector('.name').textContent = target.title;
    el.querySelector('.author').textContent = target.author || '';
    el.querySelector('.status').textContent = status;
    el.addEventListener('click', () => openBook(target));
    cont.appendChild(el);
    loadCover(target, el.querySelector('.cover'));
  }

  // ---------------- shelves, grouped by series
  const shelves = $('#shelves');
  shelves.innerHTML = '';
  $('#shelf-empty').hidden = books.length > 0;
  const groups = new Map();
  for (const b of books) {
    const key = b.series || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  for (const key of keys) {
    const list = groups.get(key).sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0) || a.title.localeCompare(b.title));
    const sec = document.createElement('section');
    sec.className = 'shelf-group';
    const h = document.createElement('h2');
    h.className = 'shelf-title';
    h.textContent = key ? `${key} · ${list.length} book${list.length === 1 ? '' : 's'}` : (keys.length > 1 ? 'More books' : 'Your books');
    sec.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'shelf';
    for (const b of list) grid.appendChild(bookCard(b, jobFolders.has(b.id)));
    sec.appendChild(grid);
    shelves.appendChild(sec);
  }
  if (isLocal) pollJobs();
}

function bookCard(b, preparing) {
  const pr = progressOf(b);
  const card = document.createElement('div');
  card.className = 'card' + (b.finished ? ' finished' : '');
  card.tabIndex = 0;
  let status;
  if (preparing) status = 'Preparing…';
  else if (!b.audio) status = 'No audiobook yet';
  else if (!b.sync) status = b.aligned ? 'Not synced yet' : 'Not prepared yet';
  else if (b.finished) status = 'Finished ✓';
  else if (pr.pct > 0.2) status = `${Math.round(pr.pct)}% · ${mins(pr.dur - pr.time)} left`;
  else status = [b.seriesIndex ? `Book ${b.seriesIndex}` : null, fmtDur(b.duration)].filter(Boolean).join(' · ');
  card.innerHTML = `<div class="cover"><div class="ph"></div>${b.finished ? '<span class="done-badge">✓</span>' : ''}
      <button class="info-btn" title="About this book" aria-label="About this book"><svg><use href="#i-info"/></svg></button></div>
    <div><div class="name"></div><div class="author"></div><div class="status"></div></div>
    <div class="bar"><i style="width:${b.finished ? 100 : pr.pct.toFixed(1)}%"></i></div>`;
  card.querySelector('.ph').textContent = b.title;
  card.querySelector('.name').textContent = b.title;
  card.querySelector('.author').textContent = b.author || '';
  card.querySelector('.status').textContent = status;
  const open = () => { if (preparing) toast('This book is still being prepared.'); else openBook(b); };
  card.addEventListener('click', (e) => { if (e.target.closest('.info-btn')) showInfo(b); else open(); });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  loadCover(b, card.querySelector('.cover'), true);
  return card;
}

// keep the info button / badge when the cover image arrives
const _loadCover = loadCover;
loadCover = async function (b, el, keepExtras) {
  if (!keepExtras) return _loadCover(b, el);
  try {
    if (!coverCache.has(b.id)) coverCache.set(b.id, (async () => ePub(b.epub, { openAs: 'epub' }).coverUrl())());
    const url = await coverCache.get(b.id);
    if (url) { const ph = el.querySelector('.ph'); if (ph) ph.outerHTML = `<img alt="" src="${url}">`; }
  } catch { /* keep placeholder */ }
};

// ---------------- listening stats
function renderStats(st) {
  const el = $('#stats');
  if (!st || st.total < 60) { el.hidden = true; return; }
  el.hidden = false;
  const maxDay = Math.max(60, ...st.days.map((d) => d.seconds));
  const bars = st.days.map((d) => `<i title="${new Date(d.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmtDur(d.seconds) || '0 min'}" style="height:${Math.max(6, (100 * d.seconds) / maxDay).toFixed(0)}%"${d.seconds >= 60 ? '' : ' class="zero"'}></i>`).join('');
  el.innerHTML = `
    <div class="stat"><b>${fmtDur(st.today) || '0 min'}</b><span>today</span></div>
    <div class="stat"><b>${fmtDur(st.week) || '0 min'}</b><span>this week</span></div>
    <div class="stat"><b><svg class="flame"><use href="#i-flame"/></svg>${st.streak}</b><span>day streak</span></div>
    <div class="stat wide"><b>${fmtDur(st.total)}</b><span>listened in total</span></div>
    <div class="spark" aria-label="Listening over the last two weeks">${bars}</div>`;
}

// ---------------- book info sheet
let infoBook = null;
function showInfo(b) {
  infoBook = b;
  const pr = progressOf(b);
  $('#info-title').textContent = b.title;
  $('#info-author').textContent = [b.author, b.year].filter(Boolean).join(' · ');
  const facts = [];
  if (b.series) facts.push(`Book ${b.seriesIndex} of ${b.series}`);
  if (b.duration) facts.push(`${fmtDur(b.duration)} audiobook`);
  if (b.syncInfo && b.syncInfo.complete) facts.push(b.syncInfo.mode === 'dense' ? 'Word-by-word sync' : 'Page sync');
  if (b.finished) facts.push('Finished ✓');
  else if (pr.pct > 0.2) facts.push(`${Math.round(pr.pct)}% · ${mins(pr.dur - pr.time)} left`);
  if (b.bookmarks || b.highlights) facts.push([b.bookmarks ? `${b.bookmarks} bookmark${b.bookmarks === 1 ? '' : 's'}` : null, b.highlights ? `${b.highlights} highlight${b.highlights === 1 ? '' : 's'}` : null].filter(Boolean).join(', '));
  $('#info-facts').innerHTML = facts.map((f) => `<span>${esc(f)}</span>`).join('');
  $('#info-bar').style.width = (b.finished ? 100 : pr.pct) + '%';
  $('#info-desc').textContent = b.description || '';
  $('#info-read').querySelector('span').textContent = pr.pct > 0.2 && !b.finished ? 'Continue' : 'Read';
  $('#info-finished').textContent = b.finished ? 'Mark as not finished' : 'Mark as finished';
  $('#info-restart').hidden = !(pr.pct > 0.2 || b.finished);
  const pack = $('#info-pack');
  pack.hidden = OFFLINE || !b.pack;
  if (b.pack) { pack.href = b.pack; pack.setAttribute('download', decodeURIComponent(b.pack.split('/').pop())); }
  const cov = $('#info-cover');
  cov.innerHTML = '<div class="ph"></div>';
  cov.querySelector('.ph').textContent = b.title;
  loadCover(b, cov);
  $('#info-dialog').hidden = false;
}
async function infoOp(op) {
  const b = infoBook; if (!b) return;
  await api('api/state/' + encodeURIComponent(b.id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' }, body: JSON.stringify([op]) });
  if (op.op === 'restart') {
    const p = store.get('pos:' + b.id) || {};
    store.set('pos:' + b.id, Object.assign(p, { time: 0, cfi: null, updated: Date.now() }));
  }
  $('#info-dialog').hidden = true;
  showLibrary();
}
$('#info-read').addEventListener('click', () => { $('#info-dialog').hidden = true; if (infoBook) openBook(infoBook); });
$('#info-restart').addEventListener('click', () => { if (confirm('Start this book from the beginning? Your bookmarks and highlights are kept.')) infoOp({ op: 'restart', device: deviceName() }); });
$('#info-finished').addEventListener('click', () => infoOp({ op: 'finished', value: !(infoBook && infoBook.finished) }));

// ---------------- adding books
const Add = { epub: null, audio: null, busy: false };

function openAdd(files) {
  if (!isLocal) return;
  if (!Add.busy) { Add.epub = null; Add.audio = null; $('#add-title').value = ''; $('#add-series').value = ''; $('#add-num').value = ''; }
  $('#add-error').hidden = true;
  $('#add-progress').hidden = !Add.busy;
  $('#add-dialog').hidden = false;
  if (files) takeFiles(files);
  renderAdd();
}

async function takeFiles(files) {
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.epub')) Add.epub = f;
    else if (n.endsWith('.m4b') || n.endsWith('.m4a')) Add.audio = f;
  }
  renderAdd();
  if (Add.epub && !$('#add-title').value) {
    try {
      const bk = ePub(await Add.epub.arrayBuffer());
      await bk.opened;                               // let it finish loading before reading (and never destroy mid-load)
      const md = await bk.loaded.metadata;
      $('#add-title').value = (md.title || Add.epub.name.replace(/\.epub$/i, '')).trim();
    } catch { $('#add-title').value = Add.epub.name.replace(/\.epub$/i, ''); }
    // "Series N - Title" style guesses from the file names
    const m = (Add.audio ? Add.audio.name : '').match(/^(.+?)[,\s]+Book\s+(\d+)/i) || (Add.epub.name).match(/^(.+?)\s+(\d+)\s*-/);
    if (m && !$('#add-series').value) { $('#add-series').value = m[1].replace(/\s*-\s*$/, '').split(' - ')[0].trim(); $('#add-num').value = m[2]; }
    renderAdd();
  }
}

function addFolderName() {
  const clean = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  const title = clean($('#add-title').value), series = clean($('#add-series').value), num = $('#add-num').value.trim();
  if (!title) return '';
  return (series && num ? `${series} ${num} - ${title}` : title).slice(0, 110).replace(/[ .]+$/, '');
}

function renderAdd() {
  const row = (f, kind) => `<div class="file ${f ? 'ok' : 'missing'}"><span class="k">${kind}</span><span>${f ? esc(f.name) + ` <span class="muted">(${(f.size / 1048576).toFixed(f.size > 1e8 ? 0 : 1)} MB)</span>` : 'not chosen yet'}</span></div>`;
  $('#add-files').innerHTML = row(Add.epub, 'Book (.epub)') + row(Add.audio, 'Audiobook (.m4b)');
  $('#add-form').hidden = !Add.epub;
  const folder = addFolderName();
  $('#add-folder').textContent = folder || '…';
  const exists = (S.books || []).some((b) => b.id.toLowerCase() === folder.toLowerCase());
  const err = $('#add-error');
  if (exists && !Add.busy) { err.hidden = false; err.textContent = 'You already have a book with this name. Change the title or series.'; } else if (!Add.busy) err.hidden = true;
  $('#add-go').disabled = Add.busy || !Add.epub || !Add.audio || !folder || exists;
}

function upload(file, folder, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `api/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`);
    x.setRequestHeader('X-Read-Along', '1');
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status === 200 ? resolve() : reject(new Error('upload failed (' + x.status + ')')));
    x.onerror = () => reject(new Error('upload failed'));
    x.send(file);
  });
}

async function startAdd() {
  const folder = addFolderName();
  if (!folder || !Add.epub || !Add.audio) return;
  Add.busy = true;
  renderAdd();
  $('#add-progress').hidden = false;
  const total = Add.epub.size + Add.audio.size;
  let done = 0;
  const show = (n) => {
    const pct = (100 * (done + n)) / total;
    $('#add-bar').style.width = pct.toFixed(1) + '%';
    $('#add-status').textContent = `Copying into your library… ${Math.floor(pct)}%`;
  };
  try {
    await upload(Add.epub, folder, show); done += Add.epub.size;
    await upload(Add.audio, folder, show); done += Add.audio.size;
    $('#add-status').textContent = 'Starting preparation…';
    await api('api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' }, body: JSON.stringify({ folder }) });
    Add.busy = false;
    $('#add-dialog').hidden = true;
    toast('Added! It\'s being prepared in the background; you can keep reading.', 5000);
    showLibrary();
  } catch (e) {
    Add.busy = false;
    const err = $('#add-error'); err.hidden = false; err.textContent = 'Something went wrong: ' + e.message;
    renderAdd();
  }
}

// background preparation progress
let jobsTimer = null;
async function pollJobs() {
  clearTimeout(jobsTimer);
  let jobs;
  try { jobs = await (await fetch('api/jobs', { cache: 'no-store' })).json(); } catch { return; }
  const wasRunning = new Set(jobsCache.filter((j) => j.state === 'running' || j.state === 'queued').map((j) => j.folder));
  jobsCache = jobs;
  const el = $('#jobs');
  el.innerHTML = jobs.map((j) => `
    <div class="job ${j.state}">
      <div class="job-head"><b>${esc(((S.books || []).find((b) => b.id === j.folder) || {}).title || j.folder)}</b><span class="muted">${j.state === 'queued' ? 'Waiting for the current book to finish' : j.state === 'error' ? 'Could not be prepared' : j.state === 'done' ? 'Ready to read ✓' : esc(j.stage)}</span></div>
      ${j.state === 'running' || j.state === 'queued' ? `<div class="bar"><i style="width:${(100 * j.progress).toFixed(1)}%"></i></div>` : ''}
      <div class="muted tiny">${esc(j.state === 'error' ? j.message : j.state === 'running' ? `${j.message || ''}${j.eta ? ` · about ${mins(j.eta)} left` : ''}` : '')}</div>
    </div>`).join('');
  const finishedNow = jobs.filter((j) => j.state === 'done' && wasRunning.has(j.folder));
  if (finishedNow.length && !$('#library').hidden) { toast(`${finishedNow.map((j) => j.folder).join(', ')} is ready to read.`, 5000); showLibrary(); return; }
  if (jobs.some((j) => j.state === 'running' || j.state === 'queued')) jobsTimer = setTimeout(pollJobs, 3000);
}

$('#btn-add').addEventListener('click', () => openAdd());
$('#add-input').addEventListener('change', (e) => { takeFiles([...e.target.files]); e.target.value = ''; });
['#add-title', '#add-series', '#add-num'].forEach((s) => $(s).addEventListener('input', renderAdd));
$('#add-go').addEventListener('click', startAdd);

// drag & drop onto the library
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!isLocal || !hasFiles(e) || $('#library').hidden) return; dragDepth++; $('#drop-zone').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-zone').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('#drop-zone').hidden = true;
  if (!isLocal || $('#library').hidden) return;
  openAdd([...e.dataTransfer.files]);
});
