// End-to-end simulation: modulate frames, pass them through a simulated
// acoustic channel, and decode them with the streaming receiver.
import { MODES, modulate, Receiver } from '../js/modem.js';
import assert from 'node:assert/strict';

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function channel(x, { srIn, srOut, drift, snrDb, reverb, eq }) {
  // resample (linear) with clock drift
  const ratio = (srIn / srOut) * (1 + drift);
  const n = Math.floor(x.length / ratio);
  let y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const k = Math.floor(t);
    const f = t - k;
    y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f;
  }
  // frequency response: a resonant peak + low-pass + high-pass
  if (eq) {
    const out = new Float32Array(n);
    let lp = 0, hp = 0, prev = 0, d1 = 0, d2 = 0;
    const w = (2 * Math.PI * 2800) / srOut, r = 0.97;
    const a1 = 2 * r * Math.cos(w), a2 = -r * r;
    for (let i = 0; i < n; i++) {
      hp = 0.97 * (hp + y[i] - prev); prev = y[i];
      lp += 0.6 * (hp - lp);
      const res = 0.05 * lp + a1 * d1 + a2 * d2; d2 = d1; d1 = res;
      out[i] = lp + 0.4 * res;
    }
    y = out;
  }
  // room: direct path + discrete echoes + diffuse exponential tail
  if (reverb) {
    const ir = new Float32Array(Math.round(0.25 * srOut));
    ir[0] = 1;
    ir[Math.round(0.0031 * srOut)] += 0.5;
    ir[Math.round(0.0087 * srOut)] -= 0.35;
    // `reverb` = energy of the diffuse tail relative to the direct sound
    const amp = Math.sqrt(reverb / (0.025 * srOut));
    for (let i = Math.round(0.01 * srOut); i < ir.length; i++) {
      ir[i] += amp * gauss() * Math.exp(-i / (0.05 * srOut));
    }
    const out = new Float32Array(n + ir.length);
    const taps = [];
    for (let i = 0; i < ir.length; i++) if (Math.abs(ir[i]) > 1e-4) taps.push(i);
    for (let i = 0; i < n; i++) {
      const v = y[i];
      if (v === 0) continue;
      for (const t of taps) out[i + t] += v * ir[t];
    }
    y = out;
  }
  let p = 0;
  for (const v of y) p += v * v;
  p /= y.length;
  const sigma = Math.sqrt(p / 10 ** (snrDb / 10));
  const g = 0.2;
  for (let i = 0; i < y.length; i++) y[i] = g * (y[i] + sigma * gauss());
  return y;
}

function makeContent(mode, i) {
  const c = new Uint8Array(mode.content);
  for (let j = 0; j < c.length; j++) c[j] = (j * 31 + i * 7 + (j >> 3)) & 0xff;
  c[0] = i;
  return c;
}

function run(mode, cfg, frames = 6) {
  const srIn = 48000;
  const parts = [new Float32Array(srIn * 0.7)];
  for (let i = 0; i < frames; i++) {
    parts.push(modulate(makeContent(mode, i), mode, srIn));
    parts.push(new Float32Array(Math.round(srIn * 0.08)));
  }
  parts.push(new Float32Array(srIn));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const tx = new Float32Array(total);
  let o = 0;
  for (const p of parts) { tx.set(p, o); o += p.length; }
  let peak = 0;
  for (const v of tx) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1, `clipping: peak ${peak}`);

  const rx = channel(tx, { srIn, ...cfg });
  const got = [];
  let fails = 0;
  const reasons = [];
  const r = new Receiver(cfg.srOut, {
    onFrame: (f) => got.push(f),
    onEvent: (e) => { if (e.type === 'fail') { fails++; reasons.push(e.reason + (e.quality ? ':' + e.quality.toFixed(1) : '')); } },
  });
  const t0 = performance.now();
  for (let i = 0; i < rx.length; i += 1024) r.push(rx.subarray(i, i + 1024));
  const ms = performance.now() - t0;
  const okIdx = got.filter((f) => f.content.every((v, j) => v === makeContent(mode, f.content[0])[j]));
  return { decoded: okIdx.length, frames, fails, ms, q: got.map((f) => f.quality.toFixed(1)).join(','), reasons: reasons.join(' ') };
}

const scenarios = [
  { name: 'clean 48k', srOut: 48000, drift: 0, snrDb: 40 },
  { name: '44.1k + drift 80ppm', srOut: 44100, drift: 80e-6, snrDb: 25 },
  { name: 'room + eq, 20 dB', srOut: 44100, drift: -60e-6, snrDb: 20, reverb: 0.3, eq: true },
  { name: 'room + eq, 12 dB', srOut: 48000, drift: 50e-6, snrDb: 12, reverb: 1.0, eq: true },
];

let failed = false;
for (const mode of MODES) {
  for (const sc of scenarios) {
    const res = run(mode, sc);
    const line = `${mode.key.padEnd(6)} | ${sc.name.padEnd(22)} | ${res.decoded}/${res.frames} decoded, ${res.fails} fails, ${res.ms.toFixed(0)} ms cpu, quality ${res.q} ${res.reasons}`;
    console.log(line);
    // Every mode must survive the realistic scenarios; only robust is required in the harshest one.
    // Ultra needs speakers that reach 13 kHz: not required through the simulated low-pass room.
    const required = (mode.key !== 'robust' && sc.snrDb <= 12) || (mode.key === 'ultra' && sc.eq) ? 0 : res.frames;
    if (res.decoded < required) failed = true;
  }
}
assert.ok(!failed, 'some scenarios failed');
console.log('sim: ok');
