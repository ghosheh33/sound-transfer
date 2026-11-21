// Protocol tests (no audio unless noted).
import { MODES, modulate, Receiver } from '../js/modem.js';
import {
  buildTransfer, passOrder, Assembler, KIND, layout, parseFrame, rangeFrames, metaFrame,
  endFrame, reportFrame, REPORT_DONE, REPORT_HAVE_META, capacity,
} from '../js/protocol.js';
import assert from 'node:assert/strict';

let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rand = (n) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 0);

// 1) One pass through the real modem (48k -> 44.1k), ~15% of frames lost,
//    rebuilt from parity packets.
{
  const mode = MODES[3];
  const bytes = rand(3000);
  const t = buildTransfer({ bytes, kind: KIND.IMAGE, mime: 'image/webp', name: 'صورة الرحلة.webp' }, mode, 20);
  const order = passOrder(t);
  const asm = new Assembler();
  const rx = new Receiver(44100, { onFrame: ({ content }) => { const f = parseFrame(content); if (f) asm.add(f); } });
  const feed = (s48) => {
    const ratio = 48000 / 44100;
    const out = new Float32Array(Math.floor(s48.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio, k = Math.floor(p), f = p - k;
      out[i] = (s48[k] || 0) * (1 - f) + (s48[k + 1] || 0) * f;
    }
    for (let i = 0; i < out.length; i += 2048) rx.push(out.subarray(i, i + 2048));
  };
  let dropped = 0;
  order.forEach((c, i) => {
    if (i > 0 && c[0] !== 0 && i % 7 === 3) { dropped++; feed(new Float32Array(48000)); return; }
    feed(modulate(c, mode, 48000));
    feed(new Float32Array(48000 * 0.06));
  });
  feed(new Float32Array(48000));
  const tr = asm.transfers.get(t.id);
  assert.equal(tr.meta.name, 'صورة الرحلة.webp');
  assert.equal(tr.meta.mime, 'image/webp');
  assert.ok(tr.done && tr.crcOk, `incomplete ${tr.covered}/${bytes.length}`);
  assert.deepEqual(tr.result, bytes);
  console.log(`protocol/modem: ${t.total} data + ${t.parity.length} parity, ${dropped} lost, ${tr.recovered} rebuilt, ok`);
}

// 2) Multi-block, random losses, no audio.
{
  const mode = MODES[2];
  const bytes = rand(90000);
  const t = buildTransfer({ bytes, kind: KIND.FILE, name: 'big.bin' }, mode, 25);
  assert.ok(t.blocks.length >= 2);
  const asm = new Assembler();
  let lost = 0;
  for (const c of passOrder(t)) {
    if (c[0] !== 0 && rnd() < 0.12) { lost++; continue; }
    asm.add(parseFrame(c));
  }
  const tr = asm.transfers.get(t.id);
  assert.ok(tr.done && tr.crcOk);
  assert.deepEqual(tr.result, bytes);
  console.log(`protocol/blocks: ${t.total} data in ${t.blocks.length} blocks, ${lost} lost, ${tr.recovered} rebuilt, ok`);
}

// 3) Mode change mid-transfer: packets of one size, resent ranges in other modes,
//    data arriving before meta, missing-range report round trip.
{
  const bytes = rand(5000);
  const t = buildTransfer({ bytes, kind: KIND.FILE, name: 'x' }, MODES[3], 10, true);
  const asm = new Assembler();
  const frames = rangeFrames(t, 0, 2000, MODES[4]);
  frames.forEach((c, i) => { if (i !== 3) asm.add(parseFrame(c)); }); // before meta, one lost
  asm.add(parseFrame(metaFrame(t, MODES[0])));
  const tr = asm.transfers.get(t.id);
  const miss = asm.missing(tr, 2000);
  assert.equal(miss.length, 1);
  const cap4 = capacity(MODES[4]);
  assert.deepEqual(miss[0], [3 * cap4, 4 * cap4]);
  // report frame round trip
  const rep = parseFrame(reportFrame(t.id, { round: 2, flags: REPORT_HAVE_META, ok: 9, bad: 1, quality: 13.5, ranges: miss }));
  assert.equal(rep.type, 'report');
  assert.deepEqual(rep.ranges, miss);
  assert.equal(rep.quality, 13.5);
  const end = parseFrame(endFrame(t.id, { round: 7, sentUpTo: 123456, dataMode: 4 }));
  assert.deepEqual([end.type, end.round, end.sentUpTo, end.dataMode], ['end', 7, 123456, 4]);
  // fill the rest in the robust mode
  for (const [s, e] of miss) rangeFrames(t, s, e, MODES[0]).forEach((c) => asm.add(parseFrame(c)));
  rangeFrames(t, 2000, bytes.length, MODES[1]).forEach((c) => asm.add(parseFrame(c)));
  assert.ok(tr.done && tr.crcOk);
  assert.deepEqual(tr.result, bytes);
  assert.ok(REPORT_DONE !== REPORT_HAVE_META);
  console.log('protocol/ranges: mixed modes + late meta, ok');

  // ARQ layout: small first block, then larger ones
  const L = layout(100, 10, 16, 48).blocks.map((b) => b.K);
  assert.deepEqual(L, [16, 48, 36]);
  const t0 = buildTransfer({ bytes: bytes.subarray(0, 500), kind: KIND.FILE }, MODES[2], 0);
  assert.equal(layout(t0.total, 0).parityTotal, 0);
}
