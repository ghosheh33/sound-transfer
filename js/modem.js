// Acoustic modem: parallel M-FSK with chirp synchronisation.
//
// Frame on air:
//   [chirp 100ms] [gap 20ms] [mode slot 60ms] [data slots ...] [tail 30ms]
// Every data slot carries one tone in each of G frequency groups; each tone
// is one of `tones` frequencies (16 => 4 bits, 4 => 2 bits). A byte uses
// consecutive slots of one group (most significant symbol first).
// The codeword (Reed–Solomon, n bytes) is scrambled before modulation so the
// tones are evenly used; the receiver estimates each tone's gain from the
// frame itself (equalisation) and uses low-confidence bytes as erasures.

import { FFT } from './fft.js';
import { rsEncode, rsDecode } from './rs.js';
import { crc32 } from './crc32.js';

export const MODES = [
  { id: 0, key: 'robust', ts: 0.040, tg: 0.020, groups: 6, tones: 16, f0: 1500, n: 96, nsym: 32 },
  { id: 1, key: 'normal', ts: 0.024, tg: 0.008, groups: 8, tones: 16, f0: 1500, n: 160, nsym: 32 },
  { id: 2, key: 'fast', ts: 0.016, tg: 0.006, groups: 8, tones: 16, f0: 1500, n: 248, nsym: 40 },
  // 32 groups of 4-FSK packed side by side: twice the bits per slot of 'fast'.
  { id: 3, key: 'turbo', ts: 0.016, tg: 0.006, groups: 32, tones: 4, f0: 1500, n: 224, nsym: 48 },
  // Same as turbo over a wider band (1.5–13.5 kHz): needs speakers that reach high notes.
  { id: 4, key: 'ultra', ts: 0.016, tg: 0.006, groups: 48, tones: 4, f0: 1500, n: 240, nsym: 48 },
];

for (const m of MODES) {
  m.bits = Math.log2(m.tones);
  m.spb = 8 / m.bits; // symbols per byte
  m.spacing = 1 / m.ts;
  // 16-FSK groups keep one empty tone between them; 4-FSK groups are packed.
  m.groupWidth = (m.tones + (m.tones >= 16 ? 1 : 0)) * m.spacing;
  m.slotDur = m.ts + m.tg;
  if (m.n % m.groups) throw new Error('n must be a multiple of groups');
  m.slots = (m.n / m.groups) * m.spb;
  m.k = m.n - m.nsym; // bytes protected by RS
  m.content = m.k - 4; // bytes available to the protocol (CRC32 appended)
  m.freqs = [];
  for (let g = 0; g < m.groups; g++) {
    const row = [];
    for (let t = 0; t < m.tones; t++) row.push(m.f0 + g * m.groupWidth + t * m.spacing);
    m.freqs.push(row);
  }
  m.maxFreq = m.freqs[m.groups - 1][m.tones - 1];
}

const CHIRP_DUR = 0.1;
const CHIRP_F0 = 1000;
const CHIRP_F1 = 6000;
const GAP = 0.02;
const MODE_TS = 0.04;
const MODE_TG = 0.02;
const MODE_FREQS = [1400, 2200, 3000, 3800, 4600, 5400];
const RAMP = 0.002;
const TAIL = 0.03;
const DATA_START = CHIRP_DUR + GAP + MODE_TS + MODE_TG;

/** Seconds a frame occupies on air (without the pause between frames). */
export function frameDuration(mode) {
  return DATA_START + mode.slots * mode.slotDur + TAIL;
}

function scrambleSeq(n) {
  const s = new Uint8Array(n);
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    s[i] = x & 0xff;
  }
  return s;
}
const SCRAMBLE = scrambleSeq(255);

function chirp(sr) {
  const len = Math.round(CHIRP_DUR * sr);
  const out = new Float32Array(len);
  const k = (CHIRP_F1 - CHIRP_F0) / CHIRP_DUR;
  const taper = Math.round(0.005 * sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let a = 1;
    if (i < taper) a = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    else if (i > len - taper) a = 0.5 - 0.5 * Math.cos((Math.PI * (len - i)) / taper);
    out[i] = a * Math.sin(2 * Math.PI * (CHIRP_F0 * t + 0.5 * k * t * t));
  }
  return out;
}

/** Adds tones (Hz) at `amp` each over [start, start+dur) seconds with edge ramps. */
function addTones(buf, sr, start, dur, freqs, amp, phases) {
  const s0 = Math.round(start * sr);
  const s1 = Math.round((start + dur) * sr);
  const r = Math.round(RAMP * sr);
  const len = s1 - s0;
  for (let f = 0; f < freqs.length; f++) {
    const w = (2 * Math.PI * freqs[f]) / sr;
    const ph = phases ? phases[f] : 0;
    for (let i = 0; i < len; i++) {
      let a = amp;
      if (i < r) a *= 0.5 - 0.5 * Math.cos((Math.PI * i) / r);
      else if (i >= len - r) a *= 0.5 - 0.5 * Math.cos((Math.PI * (len - i)) / r);
      buf[s0 + i] += a * Math.sin(w * i + ph);
    }
  }
}

/** Wraps protocol content (mode.content bytes) into a scrambled RS codeword. */
export function encodeFrame(content, mode) {
  if (content.length !== mode.content) throw new Error('bad content length');
  const msg = new Uint8Array(mode.k);
  msg.set(content);
  const c = crc32(msg, 0, mode.content);
  msg[mode.content] = c >>> 24;
  msg[mode.content + 1] = (c >>> 16) & 0xff;
  msg[mode.content + 2] = (c >>> 8) & 0xff;
  msg[mode.content + 3] = c & 0xff;
  const cw = rsEncode(msg, mode.nsym);
  for (let i = 0; i < cw.length; i++) cw[i] ^= SCRAMBLE[i];
  return cw;
}

/** Builds the audio samples for one frame. */
export function modulate(content, mode, sr) {
  const cw = encodeFrame(content, mode);
  const out = new Float32Array(Math.ceil(frameDuration(mode) * sr) + 1);
  out.set(chirp(sr).map((v) => v * 0.9));
  addTones(out, sr, CHIRP_DUR + GAP, MODE_TS + MODE_TG, [MODE_FREQS[mode.id]], 0.9);
  const G = mode.groups;
  // Pseudo-random fixed phases keep the peak level down when tones add up.
  const phases = Array.from({ length: G }, (_, g) => (g * g * 2.399) % (2 * Math.PI));
  const { spb, bits } = mode;
  const mask = mode.tones - 1;
  for (let s = 0; s < mode.slots; s++) {
    const row = Math.floor(s / spb);
    const shift = bits * (spb - 1 - (s % spb));
    const freqs = [];
    for (let g = 0; g < G; g++) freqs.push(mode.freqs[g][(cw[row * G + g] >> shift) & mask]);
    addTones(out, sr, DATA_START + s * mode.slotDur, mode.slotDur, freqs, 1, phases);
  }
  // Scale the data section to its real peak (tones rarely all peak together),
  // which is several dB louder than dividing by the number of tones.
  const d0 = Math.round(DATA_START * sr);
  let peak = 0;
  for (let i = d0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = d0; i < out.length; i++) out[i] *= k;
  return out;
}

function goertzel(x, start, len, freq, sr) {
  const w = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = start, e = start + len; i < e; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Demodulates and decodes a frame whose data slots start at `pos`. */
export function demodulate(x, pos, mode, sr) {
  const G = mode.groups;
  const TONES = mode.tones;
  const W = Math.round(mode.ts * sr);
  const E = new Array(mode.slots);
  for (let s = 0; s < mode.slots; s++) {
    const start = pos + Math.round((s * mode.slotDur + mode.tg - RAMP) * sr);
    const row = new Float64Array(G * TONES);
    for (let g = 0; g < G; g++) {
      for (let t = 0; t < TONES; t++) row[g * TONES + t] = goertzel(x, start, W, mode.freqs[g][t], sr);
    }
    E[s] = row;
  }
  // Per-tone gain estimate, smoothed across neighbouring tones of a group.
  const mean = new Float64Array(G * TONES);
  for (const row of E) for (let i = 0; i < row.length; i++) mean[i] += row[i];
  const gain = new Float64Array(G * TONES);
  for (let g = 0; g < G; g++) {
    for (let t = 0; t < TONES; t++) {
      let sum = 0;
      let cnt = 0;
      // Few tones per group: each tone repeats often enough to measure alone.
      const R = TONES >= 16 ? 2 : 0;
      for (let d = -R; d <= R; d++) {
        const tt = t + d;
        if (tt < 0 || tt >= TONES) continue;
        sum += mean[g * TONES + tt];
        cnt++;
      }
      gain[g * TONES + t] = sum / cnt + 1e-12;
    }
  }
  const sym = new Uint8Array(mode.slots * G);
  const conf = new Float64Array(mode.slots * G);
  for (let s = 0; s < mode.slots; s++) {
    const row = E[s];
    for (let g = 0; g < G; g++) {
      let best = -1;
      let b1 = 0;
      let b2 = 0;
      for (let t = 0; t < TONES; t++) {
        const v = row[g * TONES + t] / gain[g * TONES + t];
        if (v > b1) { b2 = b1; b1 = v; best = t; } else if (v > b2) b2 = v;
      }
      sym[s * G + g] = best;
      conf[s * G + g] = b1 / (b2 + 1e-12);
    }
  }
  const cw = new Uint8Array(mode.n);
  const bconf = new Float64Array(mode.n);
  for (let b = 0; b < mode.n; b++) {
    const g = b % G;
    const r = Math.floor(b / G);
    let v = 0;
    let c = Infinity;
    for (let j = 0; j < mode.spb; j++) {
      const idx = (r * mode.spb + j) * G + g;
      v = (v << mode.bits) | sym[idx];
      c = Math.min(c, conf[idx]);
    }
    cw[b] = v ^ SCRAMBLE[b];
    bconf[b] = c;
  }
  // Signal quality, 0..20: share of bytes decided with a clear margin.
  let clear = 0;
  for (const c of bconf) if (c > 2.5) clear++;
  const quality = (20 * clear) / mode.n;

  const order = Array.from(bconf.keys()).sort((a, b) => bconf[a] - bconf[b]);
  for (const nErase of [0, mode.nsym / 4, mode.nsym / 2, (3 * mode.nsym) / 4, mode.nsym - 2]) {
    const msg = rsDecode(cw, mode.nsym, order.slice(0, Math.round(nErase)));
    if (!msg) continue;
    const c = crc32(msg, 0, mode.content);
    const got = ((msg[mode.content] << 24) | (msg[mode.content + 1] << 16) |
      (msg[mode.content + 2] << 8) | msg[mode.content + 3]) >>> 0;
    if (c === got) return { content: msg.slice(0, mode.content), quality };
  }
  return { content: null, quality };
}

/**
 * Streaming receiver. Feed microphone samples with push(); decoded frames
 * are reported through the callbacks.
 *   onFrame({ content, mode, quality })
 *   onEvent({ type: 'sync' | 'fail', mode?, quality? })
 */
export class Receiver {
  constructor(sr, { onFrame, onEvent, threshold = 0.2 } = {}) {
    this.sr = sr;
    this.onFrame = onFrame || (() => {});
    this.onEvent = onEvent || (() => {});
    this.threshold = threshold;
    this.tpl = chirp(sr);
    this.L = this.tpl.length;
    this.B = 8192;
    this.N = 1;
    while (this.N < this.B + this.L) this.N <<= 1;
    this.fft = new FFT(this.N);
    this.tRe = new Float64Array(this.N);
    this.tIm = new Float64Array(this.N);
    let tn = 0;
    for (let i = 0; i < this.L; i++) { this.tRe[i] = this.tpl[i]; tn += this.tpl[i] ** 2; }
    this.tNorm = Math.sqrt(tn);
    this.fft.transform(this.tRe, this.tIm);
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.cum = new Float64Array(this.B + this.L + 1);

    this.buf = new Float32Array(sr * 30);
    this.len = 0; // samples held in buf
    this.base = 0; // absolute index of buf[0]
    this.searchPos = 0; // absolute
    this.pending = null; // { pos } absolute chirp start
    this.maxFrame = Math.ceil(Math.max(...MODES.map(frameDuration)) * sr) + 16;
  }

  push(samples) {
    this._append(samples);
    this._process();
  }

  _append(x) {
    if (this.len + x.length > this.buf.length) {
      const keepFrom = Math.max(0, (this.pending ? this.pending.pos : this.searchPos) - this.base - 1024);
      if (keepFrom > 0) {
        this.buf.copyWithin(0, keepFrom, this.len);
        this.len -= keepFrom;
        this.base += keepFrom;
      }
      if (this.len + x.length > this.buf.length) {
        const nb = new Float32Array((this.len + x.length) * 2);
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
      }
    }
    this.buf.set(x, this.len);
    this.len += x.length;
  }

  get end() {
    return this.base + this.len;
  }

  _process() {
    for (;;) {
      if (this.pending) {
        if (!this._tryFrame()) return;
        continue;
      }
      if (this.searchPos < this.base) this.searchPos = this.base;
      if (this.searchPos + this.N > this.end) return;
      this._search();
    }
  }

  _search() {
    const { N, B, L } = this;
    const off = this.searchPos - this.base;
    const x = this.buf;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < N; i++) { re[i] = x[off + i]; im[i] = 0; }
    this.fft.transform(re, im);
    for (let i = 0; i < N; i++) {
      // multiply by conj(template spectrum)
      const a = re[i]; const b = im[i];
      const c = this.tRe[i]; const d = -this.tIm[i];
      re[i] = a * c - b * d;
      im[i] = a * d + b * c;
    }
    this.fft.transform(re, im, true);
    const cum = this.cum;
    cum[0] = 0;
    for (let i = 0; i < B + L; i++) cum[i + 1] = cum[i] + x[off + i] * x[off + i];
    let best = 0;
    let bestLag = -1;
    for (let lag = 0; lag < B; lag++) {
      const e = cum[lag + L] - cum[lag];
      const v = re[lag] / N / (this.tNorm * Math.sqrt(e) + 1e-3);
      if (v > best) { best = v; bestLag = lag; }
    }
    if (best >= this.threshold) {
      if (bestLag > B - 256) {
        // Peak may continue into the next block: re-centre and look again.
        this.searchPos += bestLag - L;
        return;
      }
      this.pending = { pos: this.searchPos + bestLag, score: best };
      return;
    }
    this.searchPos += B;
  }

  _tryFrame() {
    const p = this.pending.pos;
    const sr = this.sr;
    const modeEnd = p + Math.round(DATA_START * sr);
    if (modeEnd > this.end) return false;
    let mode = this.pending.mode;
    if (mode === undefined) {
      const start = p - this.base + Math.round((CHIRP_DUR + GAP + MODE_TG - RAMP) * sr);
      const W = Math.round(MODE_TS * sr);
      const e = MODE_FREQS.map((f) => goertzel(this.buf, start, W, f, sr));
      let bi = 0;
      for (let i = 1; i < e.length; i++) if (e[i] > e[bi]) bi = i;
      const second = Math.max(...e.filter((_, i) => i !== bi));
      if (bi >= MODES.length || e[bi] < 4 * second) {
        this.onEvent({ type: 'fail', reason: 'mode' });
        this.searchPos = p + this.L;
        this.pending = null;
        return true;
      }
      mode = this.pending.mode = bi;
      this.onEvent({ type: 'sync', mode: MODES[bi] });
    }
    const m = MODES[mode];
    const endAbs = p + Math.ceil(frameDuration(m) * sr);
    if (endAbs > this.end) return false;
    const res = demodulate(this.buf, p - this.base + Math.round(DATA_START * sr), m, sr);
    this.pending = null;
    if (res.content) {
      this.searchPos = endAbs - Math.round(TAIL * sr);
      this.onFrame({ content: res.content, mode: m, quality: res.quality });
    } else {
      this.searchPos = p + this.L;
      this.onEvent({ type: 'fail', reason: 'decode', mode: m, quality: res.quality });
    }
    return true;
  }
}
