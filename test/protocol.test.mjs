// Protocol round trip through the real modem (clean channel, 48k -> 44.1k),
// with frames lost on the first pass and recovered on the second.
import { MODES, modulate, Receiver } from '../js/modem.js';
import { buildTransfer, passOrder, Assembler, KIND, estimateSeconds } from '../js/protocol.js';
import assert from 'node:assert/strict';

const mode = MODES[1];
const bytes = Uint8Array.from({ length: 1500 }, (_, i) => (i * 13 + (i >> 4)) & 0xff);
const t = buildTransfer({ bytes, kind: KIND.IMAGE, mime: 'image/webp', name: 'صورة الرحلة.webp' }, mode);
const order = passOrder(t);

const asm = new Assembler();
let doneAt = -1;
const rx = new Receiver(44100, {
  onFrame: ({ content, mode: m }) => {
    const tr = asm.add(content, m);
    if (tr && tr.done && doneAt < 0) doneAt = tr.packets.size;
  },
});

function feed(samples48) {
  const ratio = 48000 / 44100;
  const out = new Float32Array(Math.floor(samples48.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio, k = Math.floor(p), f = p - k;
    out[i] = (samples48[k] || 0) * (1 - f) + (samples48[k + 1] || 0) * f;
  }
  for (let i = 0; i < out.length; i += 2048) rx.push(out.subarray(i, i + 2048));
}

const pause = new Float32Array(48000 * 0.08);
for (let pass = 0; pass < 2; pass++) {
  order.forEach((c, i) => {
    // First pass: drop every 3rd frame (simulates noise bursts).
    if (pass === 0 && i % 3 === 2) { feed(new Float32Array(48000 * 1.5)); return; }
    feed(modulate(c, mode, 48000));
    feed(pause);
  });
}
feed(new Float32Array(48000));

const tr = asm.transfers.get(t.id);
assert.ok(tr, 'transfer seen');
assert.equal(tr.meta.name, 'صورة الرحلة.webp');
assert.equal(tr.meta.mime, 'image/webp');
assert.equal(tr.meta.kind, KIND.IMAGE);
assert.ok(tr.done, `incomplete: ${tr.packets.size}/${t.total}`);
assert.ok(tr.crcOk, 'crc');
assert.deepEqual(tr.result, bytes);
console.log(`protocol: ${t.total} packets, ${order.length} frames per pass, estimate ${estimateSeconds(bytes.length, mode).toFixed(1)} s/pass, ok`);
