import { MODES, Receiver, frameDuration } from './modem.js';
import {
  buildTransfer, passOrder, estimateSeconds, payloadSize, Assembler, KIND, FLAG_DEFLATE, FRAME_PAUSE,
} from './protocol.js';
import { startMic, Transmitter } from './audio.js';
import {
  maybeDeflate, inflate, canDeflate, loadImage, shrinkImage, supportsWebp, formatBytes, formatDuration,
} from './media.js';

const $ = (s) => document.querySelector(s);
const MODE_LABEL = ['متين', 'عادي', 'سريع'];
const MODE_HINT = ['للضوضاء والمسافة', 'متوازن', 'هاتفان متلاصقان'];

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

const bytesPerSec = (m) => payloadSize(m) / (frameDuration(m) + FRAME_PAUSE);

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${b.dataset.tab}`; });
  });
});

// ---------- Wake lock ----------
let wakeLock = null;
let wakeUsers = 0;
async function keepAwake(on) {
  wakeUsers += on ? 1 : -1;
  try {
    if (wakeUsers > 0 && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (wakeUsers <= 0 && wakeLock) {
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

// ---------- Send ----------
const state = { kind: 'text', mode: 1, image: null, imageOut: null, file: null, prepared: null };

const modesEl = $('#modes');
MODES.forEach((m, i) => {
  const b = document.createElement('button');
  b.className = 'mode' + (i === state.mode ? ' on' : '');
  b.innerHTML = `<b>${MODE_LABEL[i]}</b><span>${Math.round(bytesPerSec(m))} بايت/ث</span><span>${MODE_HINT[i]}</span>`;
  b.addEventListener('click', () => {
    state.mode = i;
    modesEl.querySelectorAll('.mode').forEach((x, j) => x.classList.toggle('on', j === i));
    refresh();
  });
  modesEl.appendChild(b);
});
$('#modeTable').innerHTML = MODES.map((m, i) =>
  `<tr><td>${MODE_LABEL[i]}</td><td>${Math.round(bytesPerSec(m) * 8)} بت/ث</td><td>${formatDuration(estimateSeconds(5000, m))}</td></tr>`,
).join('');

$('#kind').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.kind = b.dataset.kind;
  $('#kind').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== state.kind; });
  refresh();
});

$('#text').addEventListener('input', () => refresh());

supportsWebp().then((ok) => {
  if (!ok) {
    $('#imgFormat').value = 'jpeg';
    $('#imgFormat').querySelector('[value="webp"]').disabled = true;
  }
});

$('#imageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    state.image = await loadImage(f);
    state.imageName = f.name.replace(/\.[^.]+$/, '');
    $('#imgOpts').hidden = false;
    await reencode();
  } catch {
    toast('تعذّر فتح الصورة');
  }
});
['#imgDim', '#imgFormat', '#imgGray'].forEach((s) => $(s).addEventListener('change', reencode));
$('#imgQ').addEventListener('input', () => {
  $('#imgQOut').textContent = $('#imgQ').value;
  clearTimeout(reencode.t);
  reencode.t = setTimeout(reencode, 150);
});

async function reencode() {
  if (!state.image) return;
  const out = await shrinkImage(state.image, {
    maxDim: Number($('#imgDim').value),
    quality: Number($('#imgQ').value),
    format: $('#imgFormat').value,
    gray: $('#imgGray').checked,
  });
  if (state.imageOut) URL.revokeObjectURL(state.imageOut.url);
  out.url = URL.createObjectURL(out.blob);
  state.imageOut = out;
  $('#imgPreview').src = out.url;
  $('#imgInfo').textContent = `${out.width}×${out.height} — ${formatBytes(out.bytes.length)} (${out.mime.split('/')[1].toUpperCase()})`;
  refresh();
}

$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.file = { name: f.name, mime: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) };
  $('#fileInfo').textContent = `${f.name} — ${formatBytes(f.size)}`;
  refresh();
});

$('#vol').addEventListener('input', () => {
  $('#volOut').textContent = `${Math.round($('#vol').value * 100)}%`;
  tx.setVolume(Number($('#vol').value));
});
$('#passes').addEventListener('change', () => refresh());

/** Builds the bytes to send for the current input. */
async function payload() {
  if (state.kind === 'text') {
    const raw = new TextEncoder().encode($('#text').value);
    if (!raw.length) return null;
    const { bytes, deflated } = await maybeDeflate(raw);
    return { bytes, kind: KIND.TEXT, mime: 'text/plain', name: '', flags: deflated ? FLAG_DEFLATE : 0 };
  }
  if (state.kind === 'image') {
    if (!state.imageOut) return null;
    const ext = state.imageOut.mime === 'image/webp' ? 'webp' : 'jpg';
    return { bytes: state.imageOut.bytes, kind: KIND.IMAGE, mime: state.imageOut.mime, name: `${state.imageName || 'image'}.${ext}`, flags: 0 };
  }
  if (!state.file) return null;
  const { bytes, deflated } = await maybeDeflate(state.file.bytes);
  return { bytes, kind: KIND.FILE, mime: state.file.mime, name: state.file.name, flags: deflated ? FLAG_DEFLATE : 0 };
}

let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  const p = await payload();
  if (seq !== refreshSeq) return;
  state.prepared = p;
  const m = MODES[state.mode];
  const passes = Number($('#passes').value);
  if (!p) {
    $('#summary').textContent = 'أدخل نصاً أو اختر صورة أو ملفاً.';
    return;
  }
  const packets = Math.ceil(p.bytes.length / payloadSize(m));
  const one = estimateSeconds(p.bytes.length, m);
  $('#summary').innerHTML = `الحجم <b>${formatBytes(p.bytes.length)}</b>${p.flags & FLAG_DEFLATE ? ' (مضغوط)' : ''} · ${packets} حزمة · المدة <b>${formatDuration(one)}</b>${passes > 1 ? ` لكل دورة (الإجمالي ${formatDuration(one * passes)})` : ''}`;
}
refresh();

const tx = new Transmitter();
tx.setVolume(0.9);
$('#sendBtn').addEventListener('click', async () => {
  if (tx.running) {
    tx.stop();
    sendStopped('أُوقف الإرسال');
    return;
  }
  await refresh();
  const p = state.prepared;
  if (!p) { toast('لا يوجد ما يُرسل'); return; }
  const m = MODES[state.mode];
  let t;
  try {
    t = buildTransfer(p, m);
  } catch {
    toast('الملف كبير جداً');
    return;
  }
  const order = passOrder(t);
  const passes = Number($('#passes').value);
  $('#sendBtn').textContent = 'إيقاف';
  $('#sendBtn').classList.add('stop');
  keepAwake(true);
  const step = frameDuration(m) + FRAME_PAUSE;
  await tx.start(order, m, passes, ({ index, count, pass, done }) => {
    if (done) { sendStopped('اكتمل الإرسال ✓'); $('#sendBar').style.width = '100%'; return; }
    const frac = index / count;
    $('#sendBar').style.width = `${(frac * 100).toFixed(1)}%`;
    const left = (count - index) * step;
    const passTxt = passes === Infinity ? `الدورة ${pass + 1}` : `الدورة ${pass + 1} من ${passes}`;
    $('#sendStatus').textContent = `يرسل… ${passTxt} · الحزمة ${Math.min(count, Math.floor(index) + 1)}/${count} · متبقٍ ${formatDuration(left)}`;
  });
});

function sendStopped(msg) {
  $('#sendBtn').textContent = 'إرسال بالصوت';
  $('#sendBtn').classList.remove('stop');
  $('#sendStatus').textContent = msg;
  keepAwake(false);
}

// ---------- Receive ----------
let mic = null;
let rx = null;
const asm = new Assembler();
const stats = { ok: 0, bad: 0, quality: 0 };
let currentId = null;
let level = 0;
const finished = new Set();

$('#listenBtn').addEventListener('click', async () => {
  if (mic) { stopListening(); return; }
  try {
    mic = await startMic(onSamples);
  } catch (e) {
    mic = null;
    const insecure = !window.isSecureContext;
    $('#rxStatus').textContent = insecure
      ? 'الميكروفون يحتاج فتح التطبيق عبر https.'
      : 'لم يُسمح باستخدام الميكروفون. فعّل الإذن من إعدادات المتصفح.';
    return;
  }
  rx = new Receiver(mic.sampleRate, { onFrame, onEvent });
  $('#listenBtn').textContent = 'إيقاف الاستماع';
  $('#listenBtn').classList.add('stop');
  $('#rxStatus').textContent = 'يستمع… ابدأ الإرسال من الهاتف الآخر.';
  keepAwake(true);
  requestAnimationFrame(drawMeter);
});

function stopListening() {
  mic.stop();
  mic = null;
  rx = null;
  $('#listenBtn').textContent = 'ابدأ الاستماع';
  $('#listenBtn').classList.remove('stop');
  $('#rxStatus').textContent = 'متوقف.';
  $('#meter').style.width = '0';
  keepAwake(false);
}

function onSamples(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  level = Math.max(level * 0.85, Math.sqrt(s / x.length));
  rx && rx.push(x);
}

function drawMeter() {
  if (!mic) return;
  const db = 20 * Math.log10(level + 1e-6);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('#meter').style.width = `${pct}%`;
  requestAnimationFrame(drawMeter);
}

function showStats() {
  const total = stats.ok + stats.bad;
  $('#rxStats').textContent = total
    ? `حزم سليمة: ${stats.ok} · تالفة: ${stats.bad} · وضوح الإشارة: ${Math.round((stats.quality / 20) * 100)}%`
    : '';
}

function onEvent(e) {
  if (e.type === 'sync') {
    $('#rxStatus').textContent = `التُقطت إشارة (وضع ${MODE_LABEL[e.mode.id]})…`;
  } else if (e.type === 'fail' && e.reason === 'decode') {
    stats.bad++;
    if (e.quality) stats.quality = e.quality;
    $('#rxStatus').textContent = 'حزمة تالفة — قرّب الهاتفين أو ارفع الصوت.';
    if (stats.bad >= 4 && stats.bad > stats.ok && e.mode && e.mode.id > 0) {
      $('#rxStatus').textContent = 'حزم تالفة كثيرة — جرّب الوضع «متين» على المرسِل.';
    }
    showStats();
  }
}

function onFrame({ content, mode, quality }) {
  stats.ok++;
  stats.quality = quality;
  showStats();
  const t = asm.add(content, mode);
  if (!t || finished.has(t.id)) {
    $('#rxStatus').textContent = 'يستمع…';
    return;
  }
  if (currentId !== t.id) {
    currentId = t.id;
    $('#current').hidden = false;
    $('#curBody').innerHTML = '';
    $('#packets').innerHTML = '';
    lastPreview = 0;
  }
  renderCurrent(t);
  if (t.done) finish(t);
}

let lastPreview = 0;
let previewUrl = null;
function renderCurrent(t) {
  const m = t.meta;
  const got = t.packets.size;
  if (!m) {
    $('#curTitle').textContent = 'جاري الاستقبال…';
    $('#curInfo').textContent = `${got} حزمة — بانتظار معلومات الملف`;
    $('#rxStatus').textContent = 'يستقبل…';
    return;
  }
  const kindTxt = ['نص', 'صورة', 'ملف'][m.kind] || 'بيانات';
  $('#curTitle').textContent = `${kindTxt}${m.name ? ': ' + m.name : ''}`;
  const left = (m.total - got) * (frameDuration(t.mode) + FRAME_PAUSE);
  $('#curInfo').textContent = `${formatBytes(m.size)} · ${got}/${m.total} حزمة${got < m.total ? ` · متبقٍ نحو ${formatDuration(left)}` : ''}`;
  $('#rxBar').style.width = `${((got / m.total) * 100).toFixed(1)}%`;
  $('#rxStatus').textContent = 'يستقبل…';
  const grid = $('#packets');
  if (m.total <= 600) {
    if (grid.children.length !== m.total) {
      grid.innerHTML = '<i></i>'.repeat(m.total);
    }
    for (const seq of t.packets.keys()) if (grid.children[seq]) grid.children[seq].className = 'ok';
  }
  // Progressive preview for images (works best with JPEG).
  if (m.kind === KIND.IMAGE && !t.done && Date.now() - lastPreview > 1500) {
    lastPreview = Date.now();
    const pre = asm.prefix(t);
    if (pre.length) {
      const url = URL.createObjectURL(new Blob([pre], { type: m.mime }));
      const img = new Image();
      img.onload = () => {
        let el = $('#curBody img');
        if (!el) { el = document.createElement('img'); el.className = 'preview'; $('#curBody').append(el); el.style.maxWidth = '100%'; }
        el.src = url;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = url;
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }
  }
}

async function finish(t) {
  finished.add(t.id);
  currentId = null;
  $('#current').hidden = true;
  const m = t.meta;
  let bytes = t.result;
  let error = t.crcOk ? '' : 'فشل فحص السلامة — قد يكون الملف تالفاً';
  if (m.flags & FLAG_DEFLATE) {
    if (!canDeflate()) error = 'المتصفح لا يدعم فك الضغط';
    else {
      try { bytes = await inflate(bytes); } catch { error = 'تعذّر فك الضغط'; }
    }
  }
  $('#rxStatus').textContent = error ? `اكتمل مع خطأ: ${error}` : 'اكتمل الاستقبال ✓';
  if (navigator.vibrate) navigator.vibrate(120);
  addResult(m, bytes, error);
}

function addResult(m, bytes, error) {
  const card = document.createElement('div');
  card.className = 'card result';
  const time = new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  const kindTxt = ['نص', 'صورة', 'ملف'][m.kind] || 'بيانات';
  const head = document.createElement('div');
  head.innerHTML = `<b></b> <span class="tag"></span> <span class="muted small"></span>`;
  head.querySelector('b').textContent = m.name || (m.kind === KIND.TEXT ? 'رسالة' : kindTxt);
  head.querySelector('.tag').textContent = kindTxt;
  head.querySelector('.muted').textContent = `${formatBytes(bytes.length)} · ${time}`;
  if (error) {
    const bad = document.createElement('span');
    bad.className = 'tag bad';
    bad.textContent = error;
    head.append(' ', bad);
  }
  card.append(head);

  const mime = m.kind === KIND.TEXT ? 'text/plain;charset=utf-8' : (m.mime || 'application/octet-stream');
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const fileName = m.name || (m.kind === KIND.TEXT ? 'message.txt' : 'file.bin');
  const actions = document.createElement('div');
  actions.className = 'actions';

  if (m.kind === KIND.TEXT) {
    const text = new TextDecoder().decode(bytes);
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.dir = 'auto';
    card.append(pre);
    actions.append(button('نسخ', () => navigator.clipboard.writeText(text).then(() => toast('نُسخ النص'))));
  } else if (m.kind === KIND.IMAGE) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = m.name || 'صورة مستلمة';
    card.append(img);
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.className = 'secondary';
  a.textContent = 'حفظ';
  a.style.textDecoration = 'none';
  actions.append(a);
  if (navigator.canShare) {
    const file = new File([blob], fileName, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      actions.append(button('مشاركة', () => navigator.share({ files: [file] }).catch(() => {})));
    }
  }
  card.append(actions);
  $('#received').prepend(card);
}

function button(label, fn) {
  const b = document.createElement('button');
  b.className = 'secondary';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

// ---------- Offline support ----------
if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
