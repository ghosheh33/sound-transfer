import { MODES, frameDuration } from './modem.js';
import { KIND, FLAG_DEFLATE, FRAME_PAUSE, capacity } from './protocol.js';
import { SenderSession, ReceiverSession, estimate } from './session.js';
import { AudioLink, senderIO, receiverIO } from './audio.js';
import { maybeDeflate, inflate, canDeflate, loadImage, shrinkImage, supportsWebp } from './media.js';
import { addItem, listItems, deleteItem, clearItems } from './store.js';
import { t, applyLang, setLang, getLang, fmtBytes, fmtTime } from './i18n.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const modeName = (m) => t(`m_${m.key}`);
const bytesPerSec = (m) => capacity(m) / (frameDuration(m) + FRAME_PAUSE);

let memory = { mode: 3 };
try { memory = { ...memory, ...JSON.parse(localStorage.getItem('st-memory') || '{}') }; } catch { /* ignore */ }
const saveMemory = () => { try { localStorage.setItem('st-memory', JSON.stringify(memory)); } catch { /* ignore */ } };

function toast(msg, ms = 3500) {
  const e = $('#toast');
  e.textContent = msg;
  e.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { e.hidden = true; }, ms);
}

// ---------- Tabs, language ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${b.dataset.tab}`; });
  });
});

$('#langBtn').addEventListener('click', () => {
  setLang(getLang() === 'ar' ? 'en' : 'ar');
  renderStatic();
  refresh();
  renderHistory();
});

// ---------- Wake lock ----------
let wakeLock = null;
let wakeUsers = 0;
async function keepAwake(on) {
  wakeUsers = Math.max(0, wakeUsers + (on ? 1 : -1));
  try {
    if (wakeUsers > 0 && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (wakeUsers === 0 && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeUsers > 0 && !wakeLock) {
    wakeUsers--;
    keepAwake(true);
  }
});

// ---------- Audio link shared by both roles ----------
let sio = null; // sender I/O while sending
let listening = false;
let level = 0;
const link = new AudioLink({
  onFrame: (f) => {
    if (sio) sio.frame(f);
    if (listening) rxFrame(f);
  },
  onFail: () => { if (listening) rxFail(); },
  onSync: (m) => { if (listening && !rxBusy && currentId === null) $('#rxStatus').textContent = t('rxSync', { mode: modeName(m) }); },
  onLevel: (v) => { level = Math.max(level * 0.85, v); },
});

// ---------- Send ----------
const S = { kind: 'text', mode: 'auto', images: [], files: [], running: false };

function renderStatic() {
  applyLang();
  $('#langBtn').textContent = getLang() === 'ar' ? 'EN' : 'ع';
  // modes
  const modes = $('#modes');
  modes.innerHTML = '';
  const chip = (key, title, hint, sub) => {
    const b = el('button', 'mode' + (S.mode === key ? ' on' : ''));
    b.append(el('b', null, title), el('span', null, sub), el('span', null, hint));
    b.addEventListener('click', () => { S.mode = key; renderStatic(); refresh(); });
    modes.append(b);
  };
  chip('auto', t('m_auto'), t('h_auto'), '★');
  MODES.forEach((m) => chip(m.id, modeName(m), t(`h_${m.key}`), t('bps', { n: Math.round(bytesPerSec(m)) })));
  // image sizes
  const dim = $('#imgDim');
  const cur = dim.value || '200';
  dim.innerHTML = '';
  for (const n of [96, 160, 200, 240, 320, 480, 640, 1024]) {
    const o = el('option', null, t('px', { n }));
    o.value = n;
    if (String(n) === cur) o.selected = true;
    dim.append(o);
  }
  $('#redundancy').querySelector('[value="20"]').textContent = t('recommended', { n: 20 });
  // help table
  $('#modeTable').innerHTML = '';
  MODES.forEach((m) => {
    const tr = el('tr');
    tr.append(el('td', null, modeName(m)), el('td', null, `${Math.round(bytesPerSec(m) * 8)} bit/s`),
      el('td', null, fmtTime(estimate(3000, m, true, 10))));
    $('#modeTable').append(tr);
  });
  $('#sendBtn').textContent = S.running ? t('stop') : t('send');
  $('#listenBtn').textContent = listening ? t('stopListen') : t('listen');
  if (!S.running) $('#sendStatus').textContent = t('ready');
  if (!listening && !rxBusy) $('#rxStatus').textContent = t('rxIdle');
}

$('#kind').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.kind = b.dataset.kind;
  $('#kind').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-for]').forEach((x) => { x.hidden = x.dataset.for !== S.kind; });
  refresh();
});
$('#text').addEventListener('input', () => refresh());
$('#arq').addEventListener('change', () => { $('#oneWayOpts').hidden = $('#arq').checked; refresh(); });
$('#redundancy').addEventListener('change', () => refresh());
$('#passes').addEventListener('change', () => refresh());
$('#vol').addEventListener('input', () => {
  $('#volOut').textContent = `${Math.round($('#vol').value * 100)}%`;
  link.setVolume(Number($('#vol').value));
});

supportsWebp().then((ok) => {
  if (!ok) {
    $('#imgFormat').value = 'jpeg';
    $('#imgFormat').querySelector('[value="webp"]').disabled = true;
  }
});

$('#imageInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    try {
      S.images.push({ name: f.name.replace(/\.[^.]+$/, ''), img: await loadImage(f), out: null });
    } catch {
      toast(t('badImage'));
    }
  }
  e.target.value = '';
  $('#imgOpts').hidden = !S.images.length;
  await reencode();
});
['#imgDim', '#imgFormat', '#imgGray'].forEach((s) => $(s).addEventListener('change', reencode));
$('#imgQ').addEventListener('input', () => {
  $('#imgQOut').textContent = $('#imgQ').value;
  clearTimeout(reencode.t);
  reencode.t = setTimeout(reencode, 200);
});

async function reencode() {
  const opts = {
    maxDim: Number($('#imgDim').value),
    quality: Number($('#imgQ').value),
    format: $('#imgFormat').value,
    gray: $('#imgGray').checked,
  };
  for (const it of S.images) {
    const out = await shrinkImage(it.img, opts);
    if (it.out) URL.revokeObjectURL(it.out.url);
    out.url = URL.createObjectURL(out.blob);
    it.out = out;
  }
  refresh();
}

$('#fileInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    S.files.push({ name: f.name, mime: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  e.target.value = '';
  refresh();
});

function renderQueue() {
  const q = $('#queue');
  q.innerHTML = '';
  const list = S.kind === 'image' ? S.images : S.kind === 'file' ? S.files : [];
  list.forEach((it, i) => {
    const li = el('li');
    if (it.out) {
      const img = el('img');
      img.src = it.out.url;
      img.alt = '';
      li.append(img);
    } else {
      li.append(el('span', 'file-ico', '📄'));
    }
    const info = el('div', 'q-info');
    info.append(el('b', null, it.out ? `${it.name}` : it.name));
    const size = it.out ? `${it.out.width}×${it.out.height} · ${fmtBytes(it.out.bytes.length)}` : fmtBytes(it.bytes.length);
    info.append(el('span', 'muted small', size));
    li.append(info);
    const rm = el('button', 'icon-btn', '✕');
    rm.title = t('remove');
    rm.setAttribute('aria-label', t('remove'));
    rm.disabled = S.running;
    rm.addEventListener('click', () => {
      if (it.out) URL.revokeObjectURL(it.out.url);
      list.splice(i, 1);
      if (S.kind === 'image') $('#imgOpts').hidden = !S.images.length;
      refresh();
    });
    li.append(rm);
    q.append(li);
  });
}

/** Payloads to send for the current selection. */
async function payloads() {
  if (S.kind === 'text') {
    const raw = new TextEncoder().encode($('#text').value);
    if (!raw.length) return [];
    const { bytes, deflated } = await maybeDeflate(raw);
    return [{ bytes, kind: KIND.TEXT, mime: 'text/plain', name: '', flags: deflated ? FLAG_DEFLATE : 0, label: t('message') }];
  }
  if (S.kind === 'image') {
    return S.images.filter((it) => it.out).map((it) => {
      const ext = it.out.mime === 'image/webp' ? 'webp' : 'jpg';
      return { bytes: it.out.bytes, kind: KIND.IMAGE, mime: it.out.mime, name: `${it.name}.${ext}`, flags: 0, label: it.name };
    });
  }
  const out = [];
  for (const f of S.files) {
    const { bytes, deflated } = await maybeDeflate(f.bytes);
    out.push({ bytes, kind: KIND.FILE, mime: f.mime, name: f.name, flags: deflated ? FLAG_DEFLATE : 0, label: f.name });
  }
  return out;
}

function settings() {
  const arq = $('#arq').checked;
  const auto = S.mode === 'auto';
  return {
    arq,
    auto,
    mode: auto ? memory.mode : S.mode,
    redundancy: arq ? 10 : Number($('#redundancy').value),
    passes: arq ? 1 : Number($('#passes').value),
  };
}

let refreshSeq = 0;
async function refresh() {
  renderQueue();
  const seq = ++refreshSeq;
  const list = await payloads();
  if (seq !== refreshSeq) return;
  if (!list.length) {
    $('#summary').textContent = t('enterSomething');
    return;
  }
  const st = settings();
  const m = MODES[st.mode];
  const size = list.reduce((a, p) => a + p.bytes.length, 0);
  const time = list.reduce((a, p) => a + estimate(p.bytes.length, m, st.arq, st.redundancy), 0) * (st.arq ? 1 : st.passes);
  $('#summary').textContent = t('summary', { items: t('items', { n: list.length }), size: fmtBytes(size), time: fmtTime(time) });
}

$('#sendBtn').addEventListener('click', async () => {
  if (S.running) {
    sio?.stop();
    return;
  }
  const list = await payloads();
  if (!list.length) { toast(t('nothingToSend')); return; }
  const st = settings();
  await link.unlock();
  if (st.arq) {
    // Ask for the microphone now (needed to hear the answers).
    try {
      await link.micOn();
      link.micOff();
    } catch {
      toast(window.isSecureContext ? t('micDenied') : t('micInsecure'), 6000);
      st.arq = false;
      st.redundancy = 20;
    }
  }
  S.running = true;
  $('#sendBtn').textContent = t('stop');
  $('#sendBtn').classList.add('stop');
  renderQueue();
  keepAwake(true);
  let delivered = 0;
  let final = '';
  for (let idx = 0; idx < list.length; idx++) {
    const p = list[idx];
    sio = senderIO(link);
    let frac = 0;
    const session = new SenderSession(p, sio, {
      ...st,
      memory,
      onStatus: (s) => {
        const item = list.length > 1 ? `${p.label} (${idx + 1}/${list.length})` : p.label;
        if (s.phase === 'sending') {
          if (s.round) {
            const base = (s.confirmed || 0) / s.bytes;
            const top = (s.upTo || s.bytes) / s.bytes;
            frac = Math.max(frac, base + (top - base) * (s.sent / s.count));
            $('#sendStatus').textContent = t('st_sending', { item, round: s.round, mode: modeName(s.mode), sent: s.sent, count: s.count });
          } else {
            frac = isFinite(s.passes) ? (s.pass + s.sent / s.count) / s.passes : s.sent / s.count;
            $('#sendStatus').textContent = t('st_sendingPass', { item, pass: s.pass + 1, sent: s.sent, count: s.count });
          }
        } else if (s.phase === 'waiting') {
          $('#sendStatus').textContent = t('st_waiting');
        } else if (s.phase === 'resending') {
          $('#sendStatus').textContent = t('st_resending', { size: fmtBytes(s.missing) });
        } else if (s.phase === 'mode') {
          toast(t('st_mode', { mode: modeName(s.mode) }));
        } else if (s.phase === 'done') {
          frac = 1;
        }
        $('#sendBar').style.width = `${(((idx + Math.min(1, frac)) / list.length) * 100).toFixed(1)}%`;
      },
    });
    let res;
    try {
      res = await session.run();
    } catch {
      res = { ok: false, reason: 'error' };
    }
    saveMemory();
    if (res.ok) {
      delivered++;
      final = res.confirmed ? t('st_done') : t('st_doneOneWay');
      continue;
    }
    final = res.reason === 'stopped' ? t('st_stopped') : res.reason === 'no-reply' ? t('st_noReply') : t('st_failed');
    break;
  }
  if (list.length > 1 && delivered === list.length) final = t('st_allDone', { n: delivered, total: list.length });
  sio = null;
  S.running = false;
  link.micOff();
  if (listening) link.micOn().catch(() => {});
  keepAwake(false);
  $('#sendBtn').textContent = t('send');
  $('#sendBtn').classList.remove('stop');
  $('#sendStatus').textContent = final;
  if (delivered === list.length) $('#sendBar').style.width = '100%';
  renderQueue();
});

// ---------- Receive ----------
let rxBusy = false;
const stats = { ok: 0, bad: 0, quality: 0 };
let currentId = null;
const finished = new Set();
const rx = new ReceiverSession(receiverIO(link), {
  onUpdate: (tr) => onTransfer(tr),
  onReply: ({ done }) => {
    rxBusy = true;
    $('#rxStatus').textContent = t('rxReplying');
    setTimeout(() => {
      rxBusy = false;
      if (listening) $('#rxStatus').textContent = done ? t('rxDone') : t('rxListening');
    }, 4500);
  },
});

$('#listenBtn').addEventListener('click', async () => {
  if (listening) {
    listening = false;
    link.micOff();
    $('#listenBtn').textContent = t('listen');
    $('#listenBtn').classList.remove('stop');
    $('#rxStatus').textContent = t('rxStopped');
    keepAwake(false);
    return;
  }
  try {
    await link.unlock();
    await link.micOn();
  } catch {
    $('#rxStatus').textContent = window.isSecureContext ? t('micDenied') : t('micInsecure');
    return;
  }
  listening = true;
  $('#listenBtn').textContent = t('stopListen');
  $('#listenBtn').classList.add('stop');
  $('#rxStatus').textContent = t('rxListening');
  keepAwake(true);
  requestAnimationFrame(drawMeter);
});

function drawMeter() {
  const db = 20 * Math.log10(level + 1e-6);
  $('#meter').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  level *= 0.9;
  if (listening || sio) requestAnimationFrame(drawMeter);
}

function showStats() {
  $('#rxStats').textContent = stats.ok + stats.bad
    ? t('rxStats', { ok: stats.ok, bad: stats.bad, q: Math.round((stats.quality / 20) * 100) })
    : '';
}

function rxFail() {
  stats.bad++;
  rx.handleFail();
  if (!rxBusy) $('#rxStatus').textContent = t('rxBad');
  showStats();
}

function rxFrame(f) {
  const parsed = rx.handleFrame(f);
  if (!parsed || parsed.type === 'report' || parsed.type === 'end') return;
  stats.ok++;
  stats.quality = f.quality;
  showStats();
}

let lastPreview = 0;
let previewUrl = null;
function onTransfer(tr) {
  if (finished.has(tr.id)) return;
  if (currentId !== tr.id) {
    currentId = tr.id;
    $('#current').hidden = false;
    $('#curBody').innerHTML = '';
    $('#packets').innerHTML = '';
    lastPreview = 0;
  }
  if (!rxBusy) $('#rxStatus').textContent = t('rxReceiving');
  const m = tr.meta;
  if (!m) {
    $('#curTitle').textContent = t('receiving');
    $('#curInfo').textContent = t('waitingMeta', { n: tr.pending.length });
    return;
  }
  const kindTxt = [t('kText'), t('kImage'), t('kFile')][m.kind] || '';
  $('#curTitle').textContent = `${kindTxt}${m.name ? ': ' + m.name : ''}`;
  const pct = Math.floor((tr.covered / m.size) * 100);
  const rate = tr.mode ? bytesPerSec(tr.mode) : 50;
  const left = tr.covered < m.size ? t('leftAbout', { t: fmtTime((m.size - tr.covered) / rate) }) : '';
  $('#curInfo').textContent = t('curInfo', { size: fmtBytes(m.size), pct, left });
  $('#rxBar').style.width = `${pct}%`;
  const grid = $('#packets');
  if (tr.total <= 600) {
    if (grid.children.length !== tr.total) grid.innerHTML = '<i></i>'.repeat(tr.total);
    for (let i = 0; i < tr.total; i++) {
      const full = tr.pc[i] >= Math.min(m.P, m.size - i * m.P);
      grid.children[i].className = full ? 'ok' : tr.pc[i] ? 'part' : '';
    }
  }
  if (m.kind === KIND.IMAGE && !tr.done && Date.now() - lastPreview > 1500) {
    lastPreview = Date.now();
    const pre = rx.asm.prefix(tr);
    if (pre.length) {
      const url = URL.createObjectURL(new Blob([pre.slice()], { type: m.mime }));
      const img = new Image();
      img.onload = () => {
        let e = $('#curBody img');
        if (!e) { e = el('img', 'preview'); $('#curBody').append(e); }
        e.src = url;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = url;
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }
  }
  if (tr.done) finish(tr);
}

async function finish(tr) {
  finished.add(tr.id);
  currentId = null;
  $('#current').hidden = true;
  const m = tr.meta;
  let bytes = tr.result.slice();
  let error = tr.crcOk ? '' : t('errCrc');
  if (m.flags & FLAG_DEFLATE) {
    if (!canDeflate()) error = t('errNoInflate');
    else {
      try { bytes = await inflate(bytes); } catch { error = t('errInflate'); }
    }
  }
  if (!rxBusy) $('#rxStatus').textContent = error ? t('rxDoneErr', { e: error }) : t('rxDone');
  if (navigator.vibrate) navigator.vibrate(120);
  const mime = m.kind === KIND.TEXT ? 'text/plain;charset=utf-8' : (m.mime || 'application/octet-stream');
  await addItem({ name: m.name, kind: m.kind, mime, blob: new Blob([bytes], { type: mime }), size: bytes.length, time: Date.now(), error });
  renderHistory();
}

// ---------- History ----------
const urls = [];
async function renderHistory() {
  const items = await listItems();
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const box = $('#received');
  box.innerHTML = '';
  $('#clearAll').hidden = !items.length;
  if (!items.length) { box.append(el('p', 'muted', t('empty'))); return; }
  for (const it of items) box.append(await resultCard(it));
}

async function resultCard(it) {
  const card = el('div', 'card result');
  const kindTxt = [t('kText'), t('kImage'), t('kFile')][it.kind] || '';
  const head = el('div', 'r-head');
  head.append(el('b', null, it.name || (it.kind === KIND.TEXT ? t('message') : kindTxt)), ' ', el('span', 'tag', kindTxt), ' ');
  const when = new Date(it.time).toLocaleString(getLang() === 'ar' ? 'ar' : 'en', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  head.append(el('span', 'muted small', `${fmtBytes(it.size)} · ${when}`));
  if (it.error) head.append(' ', el('span', 'tag bad', it.error));
  card.append(head);
  const url = URL.createObjectURL(it.blob);
  urls.push(url);
  const fileName = it.name || (it.kind === KIND.TEXT ? 'message.txt' : 'file.bin');
  const actions = el('div', 'actions');
  if (it.kind === KIND.TEXT) {
    const text = await it.blob.text();
    const pre = el('pre', null, text);
    pre.dir = 'auto';
    card.append(pre);
    actions.append(button(t('copy'), () => navigator.clipboard.writeText(text).then(() => toast(t('copied')))));
  } else if (it.kind === KIND.IMAGE) {
    const img = el('img');
    img.src = url;
    img.alt = it.name || '';
    card.append(img);
  }
  const a = el('a', 'secondary', t('save'));
  a.href = url;
  a.download = fileName;
  actions.append(a);
  if (navigator.canShare) {
    const file = new File([it.blob], fileName, { type: it.mime });
    if (navigator.canShare({ files: [file] })) {
      actions.append(button(t('share'), () => navigator.share({ files: [file] }).catch(() => {})));
    }
  }
  actions.append(button(t('del'), async () => { await deleteItem(it.key); renderHistory(); }, 'danger'));
  card.append(actions);
  return card;
}

function button(label, fn, extra = '') {
  const b = el('button', `secondary ${extra}`.trim(), label);
  b.addEventListener('click', fn);
  return b;
}

$('#clearAll').addEventListener('click', async () => {
  if (!confirm(t('confirmClear'))) return;
  await clearItems();
  renderHistory();
});

// ---------- Start ----------
renderStatic();
refresh();
renderHistory();

if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
