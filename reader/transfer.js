'use strict';
/* Immersive Reader: "Send to phone" — a book's phone version goes straight from the laptop app to the phone
 * app over the Wi-Fi (WebRTC data channel), with no cloud in between and no Files app.
 *
 *  - The two apps find each other through the private sync repository: the PC leaves a small "offer"
 *    (transfer/offer.json: which book, and how to reach the PC), the phone answers (transfer/answer.json).
 *    Only these connection details go through GitHub; the book itself never does.
 *  - Laptop (Sender): ⓘ → Send to phone. Reads the phone file from its own server in pieces and sends
 *    them, never faster than the phone can store them.
 *  - Phone (Receiver): notices the offer while its library (or a paused book) is showing and asks
 *    "Receive?". Stores the book next to any copy it already has (ImportSink), and only switches over
 *    once everything has arrived, so a broken transfer never costs the copy that was there.
 * The window shows the simplest way first: a code the iPhone camera scans to download the file over the
 * Wi-Fi, then Add book. Sending straight to the open phone app is the second option (some Wi-Fi networks
 * keep devices apart, and on Windows the PC must reach the phone first).
 */
const XFER_MSG = 64 * 1024;             // one message on the data channel (both engines accept up to 256 KB)
const XFER_HIGH = 4 * 1024 * 1024;      // pause while more than this waits in the browser's send queue (max 16 MB)
const XFER_WINDOW = 16 * 1024 * 1024;   // ...or while the phone is this far behind in storing the audio
const XFER_PIECE = 4 * 1024 * 1024;     // read the file from the server in pieces this big
const XFER_STALL = 20000;               // laptop: no progress for this long → the connection is gone
const XFER_QUIET = 30000;               // phone: nothing arrived for this long → the connection is gone
const XFER_FRESH = 30 * 60 * 1000;      // an offer older than this is ignored (generous: the clocks may differ)
const XFER_WAIT = 3 * 60 * 1000;        // the laptop waits this long for the phone to answer

const Xfer = {
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  // wait until the browser has found its network addresses (sent all at once to the other side)
  gathered(pc, ms = 3000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      let t = null;
      const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); res(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      t = setTimeout(done, ms);
    });
  },
  // browsers hide their addresses behind random ".local" names; also list the PC's real Wi-Fi addresses
  // (helps where the PC's firewall lets the phone in; harmless otherwise)
  withIps(sdp, ips) {
    const out = [];
    for (const line of sdp.split('\r\n')) {
      out.push(line);
      const m = /^a=candidate:(\S+) (\d+) (udp|UDP) (\d+) (\S+\.local) (\d+) typ host(.*)$/.exec(line);
      if (m) ips.forEach((ip, i) => out.push(`a=candidate:${m[1]}x${i} ${m[2]} ${m[3]} ${Math.max(1, +m[4] - 1 - i)} ${ip} ${m[6]} typ host${m[7]}`));
    }
    return out.join('\r\n');
  },
  // resolves when the channel opens; rejects if the connection fails or takes too long
  opened(dc, pc, ms) {
    if (dc.readyState === 'open') return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('noconnect')), ms);
      dc.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') { clearTimeout(t); rej(new Error('noconnect')); }
      });
    });
  },
  hasCandidates: (sdp) => /\r\na=candidate:/.test('\r\n' + (sdp || '')),
  // why a direct connection didn't come about (for a clearer message)
  async why(pc) {
    try {
      let pairs = 0, asked = 0, answered = 0;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'candidate-pair') { pairs++; asked += r.requestsSent || 0; answered += r.responsesReceived || 0; }
      });
      if (!pairs) return 'The PC couldn’t find the phone on the network (the Wi-Fi may keep devices apart, or a VPN is on).';
      if (asked && !answered) return 'Something on the network or this PC’s firewall blocked the connection.';
    } catch { /* ignore */ }
    return '';
  },
  // storage refused a write: say so plainly
  storageError(e) {
    const n = e && e.name;
    if (n === 'QuotaExceededError' || n === 'UnknownError') {
      return new Error('The phone ran out of space for this book. Remove a book you’ve finished (ⓘ → Remove from this device) and try again.');
    }
    return e;
  },
  size: (n) => (n >= 1e9 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`),
  supported: () => typeof RTCPeerConnection === 'function',
};

// ================================================================ laptop: send
const Sender = {
  run: null,                                     // the transfer in progress: { id, pc, cancelled, book }
  lastBook: null,
  closeTimer: null,                              // closes the window a moment after a successful send
  hasCode: false,                                // the window shows the download code

  // what to do instead when sending straight to the phone app doesn't work
  otherWay() {
    return this.hasCode ? 'Use the code above instead.'
      : 'Instead, turn on Use on phone (top right of the library) and open this window again for a download code.';
  },

  available() { return isLocal && !OFFLINE; },          // (the download code works in any browser)

  // ⓘ → Send to phone: the download code comes first (it works on any home Wi-Fi); sending straight to the
  // open phone app is the other option (it needs the PC to be able to reach the phone directly)
  async open(book) {
    clearTimeout(this.closeTimer);
    if (this.run) { this.ui({ open: true }); return; }
    this.lastBook = book;
    $('#send-what').textContent = `Put “${book.title}” on your phone:`;
    $('#send-direct-box').hidden = true;
    $('#send-direct').hidden = !Xfer.supported();
    $('#send-error').hidden = true;
    $('#send-cancel').textContent = 'Close';
    $('#send-dialog').hidden = false;
    await this.showOther();
  },

  ui(state) {
    const d = $('#send-dialog');
    if (state.open) d.hidden = false;
    if ('status' in state) $('#send-status').textContent = state.status;
    if ('error' in state) { $('#send-error').hidden = !state.error; $('#send-error').textContent = state.error || ''; }
    if (state.error || state.done) $('#send-dialog .row-start').scrollIntoView({ block: 'nearest' });
    if ('pct' in state) {
      $('#send-progress').hidden = state.pct == null;
      if (state.pct != null) { $('#send-bar').style.width = `${state.pct.toFixed(1)}%`; $('#send-pct').textContent = state.detail || ''; }
    }
    if ('steps' in state) $('#send-steps').hidden = !state.steps;
    if ('done' in state) {
      $('#send-cancel').textContent = state.done ? 'Close' : 'Cancel';
      $('#send-direct').hidden = !state.done;                   // (can try again once this attempt is over)
    }
  },

  async start(book) {
    clearTimeout(this.closeTimer);
    if (this.run) { this.ui({ open: true }); return; }     // one at a time: show the one that's running
    this.lastBook = book;
    const run = { id: null, pc: null, cancelled: false, book };
    this.run = run;
    $('#send-direct-box').hidden = false;
    this.ui({ open: true, status: 'Getting ready…', error: '', pct: null, steps: true, done: false });
    $('#send-direct-box').scrollIntoView({ block: 'nearest' });       // (it's below the code: keep it in view)
    try {
      const sync = await (await api('api/sync')).json();
      if (!sync.configured) throw new Error('Turn on sync first (the Sync button on the library). The PC and the phone use it to find each other; the book itself goes straight over your Wi-Fi.');
      const info = await (await api('api/pack/' + encodeURIComponent(book.id))).json();
      if (info.error) throw new Error(info.error);
      const pc = new RTCPeerConnection({ iceServers: [] });
      run.pc = pc;
      const dc = pc.createDataChannel('book', { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 1024 * 1024;
      await pc.setLocalDescription(await pc.createOffer());
      await Xfer.gathered(pc);
      if (!Xfer.hasCandidates(pc.localDescription.sdp)) {
        throw Object.assign(new Error(`This browser isn’t allowing direct connections (a privacy setting or extension may block them). ${this.otherWay()}`), { other: true });
      }
      const ips = ((await (await api('api/lan-ips')).json()).ips || []).slice(0, 3);
      const files = info.members.map((m) => ({ name: m.name, size: m.size }));
      const offer = { type: 'offer', sdp: Xfer.withIps(pc.localDescription.sdp, ips) };
      if (run.cancelled) return;                                 // cancelled while getting ready: nothing offered
      const r = await (await api('api/transfer', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' },
        body: JSON.stringify({ offer, book: { id: book.id, title: book.title, author: book.author || null, size: info.size, files } }),
      })).json();
      if (r.error) throw new Error(r.error);
      run.id = r.id;
      if (run.cancelled) { this.finish(run, false); return; }   // cancelled meanwhile: withdraw the offer
      this.ui({ status: 'Waiting for your phone: open Immersive Reader on it (sync on, same Wi-Fi) and tap Receive.' });
      const ans = await this.waitAnswer(run);
      if (!ans || this.run !== run) return;                     // cancelled (the window may show a newer attempt now)
      if (ans.declined) {
        this.ui({ status: (ans.reason || 'Your phone said “Not now”.').replace(/Use the (other way below|code above)\./, this.otherWay()), done: true, steps: false });
        return this.finish(run, false);
      }
      this.ui({ status: 'Connecting to your phone…', steps: false });
      await pc.setRemoteDescription(ans.answer);
      try {
        await Xfer.opened(dc, pc, 15000);
      } catch {
        const why = await Xfer.why(pc);
        throw Object.assign(new Error(`Your PC and phone couldn’t connect directly. ${why || 'Some Wi-Fi networks keep devices apart.'} ${this.otherWay()}`), { other: true });
      }
      await this.send(run, dc, info);
      this.ui({ status: `Done: “${book.title}” is on your phone now.`, pct: 100, detail: Xfer.size(info.size), done: true });
      this.finish(run, true);
    } catch (e) {
      if (run.cancelled) return;
      this.ui({ status: 'Not sent.', error: String((e && e.message) || e), done: true, other: !!(e && e.other), steps: false });
      this.finish(run, false);
    }
  },

  async waitAnswer(run) {
    const end = Date.now() + XFER_WAIT;
    while (!run.cancelled && Date.now() < end) {
      await Xfer.sleep(1500);
      let a;
      try { a = await (await api('api/transfer?id=' + encodeURIComponent(run.id))).json(); } catch { continue; }
      if (run.cancelled) return null;
      if (a.error) continue;                                    // e.g. no internet for a moment
      if (a.answer || a.declined) return a;
    }
    if (!run.cancelled) {
      throw Object.assign(new Error('No answer from your phone. Check that the Immersive Reader app on the phone is open (on its library), '
        + `has sync on (Sync shows “In sync”), and is on the same Wi-Fi with internet, then try again. ${this.otherWay()}`), { other: true });
    }
    return null;
  },

  // send the parts of the phone file; the phone says how much audio it has stored, and we never get too
  // far ahead of it (the smaller parts are kept whole in its memory until they're complete)
  send(run, dc, info) {
    return new Promise((resolve, reject) => {
      let stored = 0, ready = false, settled = false, lastProgress = Date.now(), wake = null, stall = null;
      const total = info.members.reduce((a, m) => a + m.size, 0);
      const settle = (fn, v) => { if (settled) return; settled = true; clearInterval(stall); if (wake) wake(); fn(v); };
      dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'ready') { ready = true; lastProgress = Date.now(); if (wake) wake(); }
        else if (m.t === 'ack') {
          stored = m.bytes; lastProgress = Date.now();
          if (this.run === run) this.ui({ pct: (100 * stored) / total, detail: `${Xfer.size(stored)} of ${Xfer.size(total)}` });
          if (wake) wake();
        } else if (m.t === 'stored') settle(resolve);
        else if (m.t === 'error') settle(reject, new Error(m.message || 'The phone could not store the book.'));
      };
      dc.onclose = () => settle(reject, new Error('The connection to your phone was lost (was the phone app closed or the screen locked?). Try again.'));
      stall = setInterval(() => {
        if (Date.now() - lastProgress > XFER_STALL) {
          settle(reject, new Error('The transfer stopped (no progress for 20 seconds). Was the phone app closed or the screen locked? Try again.'));
          try { dc.close(); } catch { /* ignore */ }
        }
      }, 2000);
      const waitFor = (cond) => new Promise((res) => {
        const check = () => { if (cond() || settled || run.cancelled || dc.readyState !== 'open') { wake = null; res(); } else wake = check; };
        check();
      });
      const drained = () => new Promise((res) => {
        if (dc.bufferedAmount <= XFER_HIGH) return res();
        const done = () => { clearInterval(t); dc.removeEventListener('bufferedamountlow', done); res(); };
        const t = setInterval(() => { if (dc.bufferedAmount <= XFER_HIGH || dc.readyState !== 'open' || run.cancelled || settled) done(); }, 250);
        dc.addEventListener('bufferedamountlow', done);
      });
      const live = () => !(run.cancelled || settled || dc.readyState !== 'open');
      (async () => {
        try {
          dc.send(JSON.stringify({ t: 'start', id: run.id, total, files: info.members.map((m) => ({ name: m.name, size: m.size })) }));
          await waitFor(() => ready);
          if (!live()) return;
          let sent = 0;
          this.ui({ status: 'Sending… keep both apps open.', pct: 0, detail: `0 MB of ${Xfer.size(total)}` });
          for (const m of info.members) {
            if (!live()) return;
            dc.send(JSON.stringify({ t: 'file', name: m.name, size: m.size }));
            const audio = m.name === 'audio.m4a';
            for (let pos = 0; pos < m.size; pos += XFER_PIECE) {
              if (!live()) return;
              const len = Math.min(XFER_PIECE, m.size - pos);
              const res = await fetch(info.url, { headers: { Range: `bytes=${m.offset + pos}-${m.offset + pos + len - 1}` }, cache: 'no-store' });
              if (res.status !== 206 && res.status !== 200) throw new Error(`Couldn’t read the phone file (${res.status}).`);
              const buf = await res.arrayBuffer();
              if (buf.byteLength !== len) throw new Error('Couldn’t read the phone file.');
              for (let o = 0; o < len; o += XFER_MSG) {
                if (audio) await waitFor(() => sent - stored < XFER_WINDOW);
                await drained();
                if (!live()) return;
                dc.send(buf.slice(o, Math.min(len, o + XFER_MSG)));
                sent += Math.min(XFER_MSG, len - o);
                lastProgress = Date.now();
              }
            }
          }
          if (live()) dc.send(JSON.stringify({ t: 'end' }));
        } catch (e) {
          if (!run.cancelled) settle(reject, e);
        }
      })();
    });
  },

  finish(run, ok) {
    if (run.pc) { try { run.pc.close(); } catch { /* ignore */ } }
    if (run.id) api('api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Read-Along': '1' }, body: JSON.stringify({ cancel: run.id }) }).catch(() => {});
    if (this.run !== run) return;                  // an earlier attempt that was cancelled: the window belongs to the current one
    this.run = null;
    $('#send-direct').hidden = false;
    clearTimeout(this.closeTimer);
    if (ok) this.closeTimer = setTimeout(() => { if (!this.run) $('#send-dialog').hidden = true; }, 4000);
  },

  cancel() {
    const run = this.run;
    if (run) { run.cancelled = true; this.finish(run, false); }
    $('#send-dialog').hidden = true;
  },

  // Esc / a tap outside the dialog: only closes it when nothing is going on (use Cancel to stop a transfer)
  dismiss() { if (!this.run) $('#send-dialog').hidden = true; },

  // the download code: scan it with the iPhone camera, then Add book in the app
  async showOther() {
    const box = $('#send-other');
    box.hidden = false;
    const b = (this.run && this.run.book) || this.lastBook;
    let st = null;
    try { st = await (await api('api/lan-ips')).json(); } catch { /* ignore */ }
    const qrEl = $('#send-qr');
    qrEl.innerHTML = '';
    this.hasCode = false;
    if (st && st.listening && st.pairUrl && b && b.pack) {
      const url = st.pairUrl.replace('/?key=', b.pack + '?key=');      // http://<PC>:8765/books/<book>/<file>?key=…
      const qr = qrcode(0, 'L'); qr.addData(url); qr.make();
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      $('#send-other-steps').innerHTML = '<li>Point the <b>iPhone camera</b> at this code and tap the link: the book downloads over your Wi-Fi.</li>'
        + '<li>In the Immersive Reader app tap <b>Add book</b> → <b>Choose file</b>, and pick it where it was saved (<b>Downloads</b>, or <b>On My iPhone → Chrome</b>).</li>'
        + '<li>Afterwards you can delete the downloaded file: the app keeps its own copy.</li>';
      this.hasCode = true;
    } else {                                     // (phone access is off: the phone can't download from this PC)
      $('#send-other-steps').innerHTML = '<li>Turn on <b>Use on phone</b> (top right of the library), then open this window again: '
        + 'a code for the iPhone camera appears here.</li>';
    }
    qrEl.hidden = !this.hasCode;
  },
};

// ================================================================ phone: receive
const Receiver = {
  seen: new Set(),
  busy: false,
  cur: null,                                     // the receive in progress: { stopped, answered, pc, cancelStore }
  timer: null,
  lastCheck: 0,
  offer: null,

  init() {
    if (!OFFLINE || !Xfer.supported()) return;
    const tick = () => { this.check(); this.timer = setTimeout(tick, 10000); };
    this.timer = setTimeout(tick, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => this.check(), 1500); });
  },

  // is the PC offering a book? (while the library, or a paused book, is showing and no dialog is open)
  async check() {
    if (this.busy || !PhoneSync.configured() || !navigator.onLine || document.hidden) return;
    if (S.book ? !audio.paused : $('#library').hidden) return;
    if ($$('.modal').some((m) => !m.hidden)) return;
    if (Date.now() - this.lastCheck < 5000) return;
    this.lastCheck = Date.now();
    let r;
    try { r = await GH.call(PhoneSync.cfg, 'GET', 'contents/transfer/offer.json', null, 10000); } catch { return; }
    if (r.status !== 200 || !r.data || !r.data.content) return;
    let offer;
    try { offer = JSON.parse(b64dec(r.data.content)); } catch { return; }
    if (!offer || !offer.id || !offer.book || !offer.offer || this.seen.has(offer.id)) return;
    if (typeof offer.book.id !== 'string' || !offer.book.id || /[\\/]/.test(offer.book.id)) return;
    if (Math.abs(Date.now() - (offer.created || 0)) > XFER_FRESH) return;
    this.seen.add(offer.id);
    this.ask(offer);
  },

  async ask(offer) {
    this.offer = offer;
    const b = offer.book;
    const here = await LocalDB.get('books', b.id).catch(() => null);
    const title = String(b.title || b.id);
    $('#recv-what').textContent = here
      ? `Your PC wants to send “${title}” (${Xfer.size(+b.size || 0)}). It’s already on this phone: receive it again to replace it? (The copy you have stays until the new one has fully arrived.)`
      : `Your PC wants to send “${title}” (${Xfer.size(+b.size || 0)}).`;
    $('#recv-error').hidden = true;
    $('#recv-progress').hidden = true;
    $('#recv-status').textContent = '';
    $('#recv-yes').hidden = false; $('#recv-no').hidden = false; $('#recv-no').textContent = 'Not now';
    $('#receive-dialog').hidden = false;
  },

  answer(offer, obj) {
    return GH.putJson(PhoneSync.cfg, 'contents/transfer/answer.json', { id: offer.id, ...obj }, 'Immersive Reader: phone answer');
  },

  async decline(reason) {
    const offer = this.offer;
    $('#receive-dialog').hidden = true;
    this.offer = null;
    if (offer && !this.busy) { try { await this.answer(offer, { declined: true, reason: reason || null }); } catch { /* ignore */ } }
  },

  status(text) { $('#recv-status').textContent = text; },

  async receive() {
    const offer = this.offer;
    if (!offer || this.busy) return;
    this.busy = true;
    const run = this.cur = { stopped: false, answered: false, pc: null, cancelStore: null };
    const halt = () => { if (run.stopped) throw new Error('Stopped.'); };
    $('#recv-yes').hidden = true; $('#recv-no').textContent = 'Stop';
    $('#recv-progress').hidden = false; $('#recv-bar').style.width = '0%'; $('#recv-pct').textContent = '';
    $('#recv-error').hidden = true;
    let wake = null, stage = null;
    const lock = async () => { try { if (navigator.wakeLock && !document.hidden) wake = await navigator.wakeLock.request('screen'); } catch { /* not available */ } };
    const relock = () => { if (this.busy && !document.hidden && (!wake || wake.released)) lock(); };
    lock();                                          // right from the tap (iOS 18.4+ keeps the screen on)
    document.addEventListener('visibilitychange', relock);
    try {
      try { await Local.checkSpace(+offer.book.size || 0); } catch (e) {
        await this.answer(offer, { declined: true, reason: 'There isn’t enough room for this book in Immersive Reader on the phone.' }).catch(() => {});
        throw e;
      }
      halt();
      this.status('Connecting to your PC…');
      const pc = run.pc = new RTCPeerConnection({ iceServers: [] });
      const channel = new Promise((res) => { pc.ondatachannel = (e) => res(e.channel); });
      await pc.setRemoteDescription(offer.offer); halt();
      await pc.setLocalDescription(await pc.createAnswer()); halt();
      await Xfer.gathered(pc); halt();
      if (!Xfer.hasCandidates(pc.localDescription.sdp)) {
        await this.answer(offer, { declined: true, reason: 'The phone isn’t allowing direct connections. Use the code above.' }).catch(() => {});
        throw new Error('This phone isn’t allowing direct connections. The laptop shows another way to get the book.');
      }
      await this.answer(offer, { answer: { type: 'answer', sdp: pc.localDescription.sdp } });
      run.answered = true; halt();
      const dc = await Promise.race([channel, Xfer.sleep(25000).then(() => null)]); halt();
      if (!dc) throw new Error('Couldn’t connect to your PC directly. Keep both on the same Wi-Fi; the laptop shows another way to get the book.');
      dc.binaryType = 'arraybuffer';
      await Xfer.opened(dc, pc, 20000).catch(() => { throw new Error('Couldn’t connect to your PC directly. The laptop shows another way to get the book.'); });
      halt();
      this.status('Receiving… keep Immersive Reader open and the screen on.');
      const meta = await this.store(dc, offer, run, (s) => { stage = s; });
      stage = null;                                  // stored: nothing to undo
      this.status('Done.');
      $('#receive-dialog').hidden = true;
      await libraryAfterChange(meta.id);             // offline.js (never interrupts another book that's open)
      toast(`“${meta.title}” is on this phone now and works offline.`, 4500);
    } catch (e) {
      if (stage) { try { await ImportSink.abort(stage); } catch { /* ignore */ } }
      if (run.stopped) {
        $('#receive-dialog').hidden = true;
      } else {
        $('#receive-dialog').hidden = false;
        $('#recv-error').hidden = false;
        $('#recv-error').textContent = String((e && e.message) || e);
        this.status('Not received.');
        $('#recv-no').textContent = 'Close';
      }
    } finally {
      this.busy = false; this.offer = null; this.cur = null;
      document.removeEventListener('visibilitychange', relock);
      if (wake) { try { await wake.release(); } catch { /* ignore */ } }
      if (run.pc) { try { run.pc.close(); } catch { /* ignore */ } }
      if (typeof updateAfterBusy === 'function') updateAfterBusy();
    }
  },

  // receive the parts and store them like "Add book" does (the audio in CHUNK-sized pieces as it arrives),
  // next to any copy already on the phone; it only takes that copy's place when everything is in
  store(dc, offer, run, onStage) {
    return new Promise((resolve, reject) => {
      const id = offer.book.id;
      let stage = null, meta = null, file = null, parts = [], audio = null, fill = 0, n = 0;
      let stored = 0, audioSize = 0, other = 0, total = 0, failed = false, done = false, finishing = false, lastMsg = Date.now();
      let q = Promise.resolve();
      const quiet = setInterval(() => {
        if (Date.now() - lastMsg > XFER_QUIET) fail(new Error('The transfer stopped (nothing arrived for 30 seconds). Keep both apps open and try again.'));
      }, 3000);
      const fail = (e) => {
        if (failed || done || finishing) return;           // (switching the book over to the new copy isn't interrupted)
        failed = true;
        clearInterval(quiet);
        try { dc.send(JSON.stringify({ t: 'error', message: String((e && e.message) || e) })); } catch { /* ignore */ }
        reject(Xfer.storageError(e));
      };
      run.cancelStore = fail;
      const step = (fn) => { q = q.then(() => (failed ? null : fn())).catch(fail); };
      const ack = () => {
        try { dc.send(JSON.stringify({ t: 'ack', bytes: stored })); } catch { /* ignore */ }
        $('#recv-bar').style.width = `${total ? ((100 * stored) / total).toFixed(1) : 0}%`;
        $('#recv-pct').textContent = `${Xfer.size(stored)} of ${Xfer.size(total)}`;
      };
      const flushAudio = () => {
        const piece = audio, k = n++;
        audio = null; fill = 0;
        step(async () => { await ImportSink.putAudio(stage, k, piece.buffer); stored += piece.length; ack(); });
      };
      dc.onmessage = (e) => {
        lastMsg = Date.now();
        if (failed || done) return;
        if (typeof e.data === 'string') {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'start') {
            total = +m.total || 0;
            step(async () => {
              const s = await ImportSink.begin(id);             // (it may wait for a cleanup to finish)
              if (failed) { await ImportSink.abort(s); return; }  // the receive ended meanwhile
              stage = s; onStage(s); dc.send(JSON.stringify({ t: 'ready' }));
            });
          } else if (m.t === 'file') {
            const size = +m.size;
            if (!(size >= 0) || size > 4e9) return fail(new Error('The PC sent something unexpected.'));
            file = { name: String(m.name), size, got: 0 };
            parts = [];
            if (file.name === 'audio.m4a') audioSize = size;
          } else if (m.t === 'end') {
            step(async () => {
              if (!meta || meta.id !== id) throw new Error('The book details are missing from what was sent.');
              if (!audioSize || n * CHUNK < audioSize) throw new Error('Not all of the audio arrived.');
              finishing = true;
              clearInterval(quiet);
              try { await ImportSink.finish(stage, meta, audioSize, other); } catch (e) { finishing = false; throw e; }
              done = true;
              try { dc.send(JSON.stringify({ t: 'stored' })); } catch { /* ignore */ }
              resolve(meta);
            });
          }
          return;
        }
        if (!file) return;
        const bytes = new Uint8Array(e.data);
        if (file.got + bytes.length > file.size) return fail(new Error('The PC sent more than expected.'));
        file.got += bytes.length;
        if (file.name === 'audio.m4a') {
          let o = 0;
          while (o < bytes.length) {
            if (!audio) audio = new Uint8Array(Math.min(CHUNK, file.size - n * CHUNK));
            const take = Math.min(audio.length - fill, bytes.length - o);
            audio.set(bytes.subarray(o, o + take), fill);
            fill += take; o += take;
            if (fill === audio.length) flushAudio();
          }
        } else {
          parts.push(bytes);
          if (file.got === file.size) {
            const buf = new Uint8Array(file.size);
            let p = 0;
            for (const x of parts) { buf.set(x, p); p += x.length; }
            parts = [];
            const name = file.name;
            step(async () => {
              if (name === 'meta.json') meta = JSON.parse(new TextDecoder().decode(buf));
              else if (name === 'book.epub') { await ImportSink.putFile(stage, 'epub', buf.buffer); other += buf.length; }
              else if (name === 'sync.json') { await ImportSink.putFile(stage, 'sync', buf.buffer); other += buf.length; }
              stored += buf.length;
              ack();
            });
          }
        }
      };
      dc.onclose = () => { if (!done) fail(new Error('The connection to your PC was lost. Keep Immersive Reader open and the screen on while it receives, and try again.')); };
    });
  },

  // the Stop / Not now button
  stop() {
    const run = this.cur;
    if (run && this.busy) {
      run.stopped = true;
      if (!run.answered && this.offer) this.answer(this.offer, { declined: true, reason: 'Stopped on the phone.' }).catch(() => {});
      if (run.cancelStore) run.cancelStore(new Error('Stopped.'));
      if (run.pc) { try { run.pc.close(); } catch { /* ignore */ } }
      $('#receive-dialog').hidden = true;
      return;
    }
    this.decline();
  },

  // Esc / a tap outside the dialog: while asking it means "Not now"; while receiving it does nothing
  dismiss() { if (!this.busy) this.stop(); },
};

// ---------------------------------------------------------------- wiring
$('#info-send').addEventListener('click', () => { if (infoBook) { $('#info-dialog').hidden = true; Sender.open(infoBook); } });
$('#send-cancel').addEventListener('click', () => Sender.cancel());
$('#send-close').addEventListener('click', () => Sender.cancel());
$('#send-direct').addEventListener('click', () => { if (Sender.lastBook && !Sender.run) { $('#send-direct').hidden = true; Sender.start(Sender.lastBook); } });
$('#recv-yes').addEventListener('click', () => Receiver.receive());
$('#recv-no').addEventListener('click', () => Receiver.stop());
Receiver.init();
