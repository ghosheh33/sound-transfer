// Protocol tests.
// 1) Through the real modem (48k -> 44.1k): ONE pass, ~15% of frames lost,
//    everything rebuilt from the parity packets.
// 2) Without audio: a large multi-block transfer with random losses.
import { MODES, modulate, Receiver } from '../js/modem.js';
import { buildTransfer, passOrder, Assembler, KIND, estimateSeconds, layout } from '../js/protocol.js';
import assert from 'node:assert/strict';

let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ---------- 1) through the modem ----------
{
  const mode = MODES[3];
  const bytes = Uint8Array.from({ length: 3000 }, (_, i) => (i * 13 + (i >> 4)) & 0xff);
  const t = buildTransfer({ bytes, kind: KIND.IMAGE, mime: 'image/webp', name: 'صورة الرحلة.webp' }, mode, 20);
  const order = passOrder(t);
  const asm = new Assembler();
  const rx = new Receiver(44100, { onFrame: ({ content, mode: m }) => asm.add(content, m) });
  const feed = (samples48) => {
    const ratio = 48000 / 44100;
    const out = new Float32Array(Math.floor(samples48.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio, k = Math.floor(p), f = p - k;
      out[i] = (samples48[k] || 0) * (1 - f) + (samples48[k + 1] || 0) * f;
    }
    for (let i = 0; i < out.length; i += 2048) rx.push(out.subarray(i, i + 2048));
  };
  let dropped = 0;
  order.forEach((c, i) => {
    if (i > 0 && c !== t.meta && i % 7 === 3) { dropped++; feed(new Float32Array(48000)); return; }
    feed(modulate(c, mode, 48000));
    feed(new Float32Array(48000 * 0.06));
  });
  feed(new Float32Array(48000));
  const tr = asm.transfers.get(t.id);
  assert.ok(tr, 'transfer seen');
  assert.equal(tr.meta.name, 'صورة الرحلة.webp');
  assert.equal(tr.meta.mime, 'image/webp');
  assert.ok(tr.done, `incomplete: ${tr.packets.size}/${t.total}`);
  assert.ok(tr.crcOk, 'crc');
  assert.deepEqual(tr.result, bytes);
  console.log(`protocol/modem: ${t.total} data + ${t.parity.length} parity, ${dropped} frames lost, ${tr.recovered.size} rebuilt, one pass ${estimateSeconds(bytes.length, mode).toFixed(1)} s, ok`);
}

// ---------- 2) multi-block, no audio ----------
{
  const mode = MODES[2];
  const bytes = Uint8Array.from({ length: 90000 }, () => (rnd() * 256) | 0);
  const t = buildTransfer({ bytes, kind: KIND.FILE, mime: 'application/octet-stream', name: 'big.bin' }, mode, 25);
  assert.ok(t.blocks.length >= 2, 'several blocks');
  const order = passOrder(t);
  const asm = new Assembler();
  let lost = 0;
  for (const c of order) {
    if (c !== t.meta && rnd() < 0.12) { lost++; continue; }
    asm.add(c, mode);
  }
  const tr = asm.transfers.get(t.id);
  assert.ok(tr.done && tr.crcOk, `multi-block incomplete ${tr.packets.size}/${t.total}`);
  assert.deepEqual(tr.result, bytes);
  console.log(`protocol/blocks: ${t.total} data in ${t.blocks.length} blocks, ${lost} lost, ${tr.recovered.size} rebuilt, ok`);

  // No parity at all: must still work when nothing is lost.
  const t0 = buildTransfer({ bytes: bytes.subarray(0, 500), kind: KIND.FILE }, mode, 0);
  assert.equal(layout(t0.total, 0).parityTotal, 0);
  const a0 = new Assembler();
  passOrder(t0).forEach((c) => a0.add(c, mode));
  assert.ok(a0.transfers.get(t0.id).done);
}
