// Two-way session test: real modem in both directions over a simulated room.
import { MODES, modulate, Receiver } from '../js/modem.js';
import { parseFrame, KIND, FRAME_PAUSE } from '../js/protocol.js';
import { SenderSession, ReceiverSession } from '../js/session.js';
import assert from 'node:assert/strict';

let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const SR = 48000;

/** Room: echoes + diffuse tail, low-pass speaker, noise. Applied per buffer. */
function room(x, { snrDb, reverb = 0, lowpass = 0.6 }) {
  const n = x.length;
  let y = new Float32Array(n);
  let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    hp = 0.97 * (hp + x[i] - prev); prev = x[i];
    lp += lowpass * (hp - lp);
    y[i] = lp;
  }
  if (reverb) {
    const L = Math.round(0.2 * SR);
    const out = new Float32Array(n + L);
    const taps = [[0, 1], [Math.round(0.0031 * SR), 0.5], [Math.round(0.0087 * SR), -0.35]];
    const amp = Math.sqrt(reverb / (0.025 * SR));
    for (let i = Math.round(0.01 * SR); i < L; i += 29) taps.push([i, amp * Math.sqrt(29) * gauss() * Math.exp(-i / (0.05 * SR))]);
    for (let i = 0; i < n; i++) { const v = y[i]; if (v) for (const [d, g] of taps) out[i + d] += v * g; }
    y = out;
  }
  let p = 0, cnt = 0;
  for (const v of y) if (v) { p += v * v; cnt++; }
  const sigma = Math.sqrt((p / Math.max(1, cnt)) / 10 ** (snrDb / 10));
  for (let i = 0; i < y.length; i++) y[i] = 0.3 * (y[i] + sigma * gauss());
  return y;
}

function makeLink(cfg) {
  const clock = { t: 0 };
  // Receiver side
  const rxInbox = [];
  const rx = { stopped: false };
  let sender; // filled below
  const recvSession = new ReceiverSession({
    reply: async (content, mode) => {
      clock.t += 1.3; // reply delay
      const samples = modulate(content, mode, SR);
      clock.t += samples.length / SR;
      if (cfg.deafReplies) return;
      air(samples, senderRx, cfg.back || cfg);
    },
  });
  const receiverRx = new Receiver(SR, {
    onFrame: (f) => recvSession.handleFrame(f),
    onEvent: (e) => { if (e.type === 'fail' && e.reason === 'decode') recvSession.handleFail(); },
  });
  // Sender side
  const senderRx = new Receiver(SR, { onFrame: (f) => { const p = parseFrame(f.content); if (p) rxInbox.push(p); } });
  function air(samples, target, c) {
    const y = room(samples, c);
    for (let i = 0; i < y.length; i += 4096) target.push(y.subarray(i, i + 4096));
    target.push(new Float32Array(Math.round(0.4 * SR)));
  }
  const io = {
    stopped: false,
    async play(frames, onFrame) {
      rxInbox.length = 0;
      frames.forEach((f, i) => {
        const s = modulate(f.content, f.mode, SR);
        clock.t += s.length / SR + FRAME_PAUSE;
        const drop = cfg.dropRate && f.content[0] !== 3 && rnd() < cfg.dropRate;
        air(drop ? new Float32Array(s.length) : s, receiverRx, cfg);
        onFrame && onFrame(i + 1);
      });
      return true;
    },
    async listen(ms, accept) {
      clock.t += 0.6;
      const i = rxInbox.findIndex(accept);
      if (i < 0) { clock.t += ms / 1000; return null; }
      clock.t += 0.4;
      return rxInbox.splice(i, 1)[0];
    },
  };
  return { io, recvSession, clock, get sender() { return sender; } };
}

const bytes = Uint8Array.from({ length: 6000 }, () => (rnd() * 256) | 0);
const payload = { bytes, kind: KIND.IMAGE, mime: 'image/webp', name: 'test.webp' };

async function scenario(name, cfg, opts, expect) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  if (process.env.QUICK && name.startsWith('harsh')) return; // slow (robust mode), skipped in CI
  const link = makeLink(cfg);
  const modes = [];
  const s = new SenderSession(payload, link.io, {
    ...opts,
    onStatus: (st) => {
      if (st.phase !== 'sending' || st.sent !== 0) return;
      modes.push(st.mode.key);
      if (process.env.V) console.log(`  round ${st.round} ${st.mode.key} confirmed=${st.confirmed} air=${link.clock.t.toFixed(0)}s`);
    },
  });
  const res = await s.run();
  const t = [...link.recvSession.asm.transfers.values()].find((x) => x.meta);
  const got = t && t.done && t.crcOk && Buffer.compare(Buffer.from(t.result), Buffer.from(bytes)) === 0;
  console.log(`${name.padEnd(28)} | ${res.ok ? 'ok' : 'ended: ' + res.reason} confirmed=${!!res.confirmed} received=${!!got} rounds=${modes.length} air≈${link.clock.t.toFixed(0)}s modes=${[...new Set(modes)].join('>')}`);
  expect(res, got);
}

await scenario('good room, auto', { snrDb: 25, reverb: 0.3 }, { auto: true, mode: 3 },
  (r, got) => { assert.ok(r.ok && r.confirmed && got); });
await scenario('clean, auto, climbs to ultra', { snrDb: 35, lowpass: 0.9 }, { auto: true, mode: 3 },
  (r, got) => { assert.ok(r.ok && got); });
await scenario('15% frames lost, auto', { snrDb: 30, reverb: 0.2, dropRate: 0.15 }, { auto: true, mode: 3 },
  (r, got) => { assert.ok(r.ok && r.confirmed && got); });
await scenario('harsh room, auto', { snrDb: 12, reverb: 1.0 }, { auto: true, mode: 3, maxRounds: 30 },
  (r, got) => { assert.ok(r.ok && r.confirmed && got); });
await scenario('replies never arrive', { snrDb: 25, reverb: 0.3, deafReplies: true }, { auto: true, mode: 3 },
  (r) => { assert.equal(r.reason, 'no-reply'); });
await scenario('one way, 20% parity, 10% lost', { snrDb: 25, reverb: 0.3, dropRate: 0.1 }, { arq: false, mode: 3, redundancy: 20 },
  (r, got) => { assert.ok(r.ok && !r.confirmed && got); });
console.log('session: ok');
