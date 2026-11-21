// Transfer protocol on top of modem frames.
//
// Frame content (mode.content bytes):
//   [0] type: 0 = meta, 1 = data, 2 = parity
//   [1..2] transfer id
//   [3..4] seq (data packet index, or parity packet index)
//   [5] payload length
//   [6..] payload (zero padded)
// Meta payload:
//   total data packets (2) | size (4) | crc32 of data (4) | kind (1) | flags (1)
//   | redundancy % (1) | mime length (1) | mime | name length (1) | name
//
// Loss recovery without a back channel: data packets are split into blocks
// of up to ~200, and each block gets extra parity packets (Reed–Solomon
// across packets, one code per byte column). Any K of a block's K+M packets
// rebuild the block, so a single pass survives losing up to M packets per
// block. The meta frame is repeated so a receiver that starts late still
// learns what is being sent.

import { crc32 } from './crc32.js';
import { rsEncode, rsDecode } from './rs.js';
import { MODES, frameDuration } from './modem.js';

export const KIND = { TEXT: 0, IMAGE: 1, FILE: 2 };
export const FLAG_DEFLATE = 1;
const HEADER = 6;
export const META_EVERY = 12; // a meta frame after every N other frames
export const FRAME_PAUSE = 0.06; // seconds of silence between frames
const TYPE_META = 0;
const TYPE_DATA = 1;
const TYPE_PARITY = 2;

export function payloadSize(mode) {
  return mode.content - HEADER;
}

/** Block layout shared by sender and receiver. */
export function layout(total, redundancy) {
  const r = redundancy / 100;
  const maxK = Math.min(200, Math.floor(255 / (1 + r)));
  const nb = Math.ceil(total / maxK);
  const blocks = [];
  let start = 0;
  let pstart = 0;
  for (let b = 0; b < nb; b++) {
    const K = Math.floor(total / nb) + (b < total % nb ? 1 : 0);
    const M = r > 0 ? Math.min(255 - K, Math.max(1, Math.ceil(K * r))) : 0;
    blocks.push({ start, K, pstart, M });
    start += K;
    pstart += M;
  }
  return { blocks, parityTotal: pstart };
}

function frame(mode, type, id, seq, payload) {
  const c = new Uint8Array(mode.content);
  c[0] = type;
  c[1] = id >> 8; c[2] = id & 0xff;
  c[3] = seq >> 8; c[4] = seq & 0xff;
  c[5] = payload.length;
  c.set(payload, HEADER);
  return c;
}

const enc = new TextEncoder();
function truncUtf8(str, maxBytes) {
  let out = new Uint8Array(0);
  let acc = '';
  for (const ch of str) {
    const next = enc.encode(acc + ch);
    if (next.length > maxBytes) break;
    acc += ch;
    out = next;
  }
  return out;
}

/** Computes parity packets for one block (all packets padded to P bytes). */
function encodeBlock(packets, M, P) {
  const parity = Array.from({ length: M }, () => new Uint8Array(P));
  const col = new Uint8Array(packets.length);
  for (let c = 0; c < P; c++) {
    for (let i = 0; i < packets.length; i++) col[i] = packets[i][c];
    const cw = rsEncode(col, M);
    for (let j = 0; j < M; j++) parity[j][c] = cw[packets.length + j];
  }
  return parity;
}

/**
 * Splits data into frames for a mode.
 * @returns {{ id, mode, meta, data: Uint8Array[], parity: Uint8Array[], total, blocks }}
 */
export function buildTransfer({ bytes, kind, mime = '', name = '', flags = 0 }, mode, redundancy = 20) {
  const P = payloadSize(mode);
  const total = Math.max(1, Math.ceil(bytes.length / P));
  const { blocks, parityTotal } = layout(total, redundancy);
  if (total > 65535 || parityTotal > 65535) throw new Error('too large');
  const id = (Math.random() * 65536) | 0;
  const mimeB = truncUtf8(mime, 40);
  const fixed = 15 + mimeB.length;
  const nameB = truncUtf8(name, Math.max(0, P - fixed - 1));
  const mp = new Uint8Array(fixed + 1 + nameB.length);
  const dv = new DataView(mp.buffer);
  dv.setUint16(0, total);
  dv.setUint32(2, bytes.length);
  dv.setUint32(6, crc32(bytes));
  mp[10] = kind;
  mp[11] = flags;
  mp[12] = redundancy;
  mp[13] = mimeB.length;
  mp.set(mimeB, 14);
  mp[14 + mimeB.length] = nameB.length;
  mp.set(nameB, 15 + mimeB.length);
  const meta = frame(mode, TYPE_META, id, 0, mp.subarray(0, Math.min(mp.length, P)));

  const padded = [];
  for (let i = 0; i < total; i++) {
    const p = new Uint8Array(P);
    p.set(bytes.subarray(i * P, (i + 1) * P));
    padded.push(p);
  }
  const data = padded.map((p, i) => frame(mode, TYPE_DATA, id, i, bytes.subarray(i * P, (i + 1) * P)));
  const parity = [];
  for (const b of blocks) {
    if (!b.M) continue;
    encodeBlock(padded.slice(b.start, b.start + b.K), b.M, P)
      .forEach((p, j) => parity.push(frame(mode, TYPE_PARITY, id, b.pstart + j, p)));
  }
  return { id, mode, meta, data, parity, total, blocks };
}

/** Frames for one pass: block by block (data then its parity), meta regularly. */
export function passOrder(t) {
  const out = [t.meta];
  let since = 0;
  const push = (f) => {
    out.push(f);
    if (++since === META_EVERY) { out.push(t.meta); since = 0; }
  };
  for (const b of t.blocks) {
    for (let i = 0; i < b.K; i++) push(t.data[b.start + i]);
    for (let j = 0; j < b.M; j++) push(t.parity[b.pstart + j]);
  }
  if (out[out.length - 1] === t.meta) out.pop();
  return out;
}

export function estimateSeconds(bytes, mode, passes = 1, redundancy = 20) {
  const total = Math.max(1, Math.ceil(bytes / payloadSize(mode)));
  const frames0 = total + layout(total, redundancy).parityTotal;
  const frames = frames0 + 1 + Math.floor((frames0 - 1) / META_EVERY);
  return frames * (frameDuration(mode) + FRAME_PAUSE) * passes;
}

export function parseFrame(content) {
  const type = content[0];
  const id = (content[1] << 8) | content[2];
  const seq = (content[3] << 8) | content[4];
  const len = content[5];
  if (type > 2 || HEADER + len > content.length) return null;
  const payload = content.slice(HEADER, HEADER + len);
  if (type === TYPE_DATA) return { type: 'data', id, seq, payload };
  if (type === TYPE_PARITY) return { type: 'parity', id, seq, payload };
  if (len < 16) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const mimeLen = payload[13];
  const nameLen = payload[14 + mimeLen] || 0;
  const dec = new TextDecoder();
  return {
    type: 'meta',
    id,
    total: dv.getUint16(0),
    size: dv.getUint32(2),
    crc: dv.getUint32(6),
    kind: payload[10],
    flags: payload[11],
    redundancy: payload[12],
    mime: dec.decode(payload.subarray(14, 14 + mimeLen)),
    name: dec.decode(payload.subarray(15 + mimeLen, 15 + mimeLen + nameLen)),
  };
}

/** Collects frames from any number of transfers and reassembles them. */
export class Assembler {
  constructor() {
    this.transfers = new Map();
  }

  _get(id) {
    let t = this.transfers.get(id);
    if (!t) {
      t = { id, meta: null, packets: new Map(), parity: new Map(), recovered: new Set(), done: false, result: null };
      this.transfers.set(id, t);
    }
    return t;
  }

  /** Returns the transfer touched by this frame, or null for invalid frames. */
  add(content, mode) {
    const f = parseFrame(content);
    if (!f) return null;
    const t = this._get(f.id);
    t.mode = mode;
    t.P = payloadSize(mode);
    t.updated = Date.now();
    if (f.type === 'meta') {
      if (!t.meta) {
        t.meta = f;
        t.blocks = layout(f.total, f.redundancy).blocks;
      }
    } else {
      const map = f.type === 'data' ? t.packets : t.parity;
      if (!map.has(f.seq)) {
        const p = new Uint8Array(t.P);
        p.set(f.payload);
        map.set(f.seq, p);
      }
    }
    if (!t.done && t.meta) {
      this._recover(t);
      if (t.packets.size >= t.meta.total) this._finish(t);
    }
    return t;
  }

  /** Packets usable so far, counting at most K per block (progress). */
  have(t) {
    if (!t.meta) return t.packets.size;
    let n = 0;
    for (const b of t.blocks) {
      let got = 0;
      for (let i = 0; i < b.K; i++) if (t.packets.has(b.start + i)) got++;
      for (let j = 0; j < b.M; j++) if (t.parity.has(b.pstart + j)) got++;
      n += Math.min(b.K, got);
    }
    return n;
  }

  _recover(t) {
    for (const b of t.blocks) {
      const missing = [];
      for (let i = 0; i < b.K; i++) if (!t.packets.has(b.start + i)) missing.push(i);
      if (!missing.length || !b.M) continue;
      const erase = [...missing];
      for (let j = 0; j < b.M; j++) if (!t.parity.has(b.pstart + j)) erase.push(b.K + j);
      if (erase.length > b.M) continue;
      const out = missing.map(() => new Uint8Array(t.P));
      const cw = new Uint8Array(b.K + b.M);
      let ok = true;
      for (let c = 0; c < t.P && ok; c++) {
        for (let i = 0; i < b.K; i++) cw[i] = t.packets.get(b.start + i)?.[c] ?? 0;
        for (let j = 0; j < b.M; j++) cw[b.K + j] = t.parity.get(b.pstart + j)?.[c] ?? 0;
        const msg = rsDecode(cw, b.M, erase);
        if (!msg) { ok = false; break; }
        missing.forEach((i, k) => { out[k][c] = msg[i]; });
      }
      if (!ok) continue;
      missing.forEach((i, k) => {
        t.packets.set(b.start + i, out[k]);
        t.recovered.add(b.start + i);
      });
    }
  }

  _finish(t) {
    const { total, size, crc } = t.meta;
    const out = new Uint8Array(size);
    let o = 0;
    for (let i = 0; i < total; i++) {
      const p = t.packets.get(i);
      if (!p) return;
      const n = Math.min(p.length, size - o);
      out.set(p.subarray(0, n), o);
      o += n;
    }
    t.done = true;
    t.crcOk = crc32(out) === crc;
    t.result = out;
  }

  /** Bytes of the contiguous prefix received so far (for progressive previews). */
  prefix(t) {
    const parts = [];
    for (let i = 0; t.packets.has(i); i++) parts.push(t.packets.get(i));
    let len = parts.length * (t.P || 0);
    if (t.meta) len = Math.min(len, t.meta.size);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      const n = Math.min(p.length, len - o);
      out.set(p.subarray(0, n), o);
      o += n;
    }
    return out;
  }
}

export { MODES };
