// Transfer protocol on top of modem frames.
//
// Frame content (mode.content bytes):
//   [0] type: 0 = meta, 1 = data
//   [1..2] transfer id
//   [3..4] seq (data packet index; 0 for meta)
//   [5] payload length
//   [6..] payload (zero padded)
// Meta payload:
//   total packets (2) | size (4) | crc32 of data (4) | kind (1) | flags (1)
//   | mime length (1) | mime | name length (1) | name (UTF-8, truncated)
// The sender repeats the meta frame regularly, so a receiver that starts
// late still learns what is being sent; data frames can arrive in any order
// and on any pass of the carousel.

import { crc32 } from './crc32.js';
import { MODES, frameDuration } from './modem.js';

export const KIND = { TEXT: 0, IMAGE: 1, FILE: 2 };
export const FLAG_DEFLATE = 1;
const HEADER = 6;
export const META_EVERY = 8; // a meta frame after every N data frames
export const FRAME_PAUSE = 0.08; // seconds of silence between frames

export function payloadSize(mode) {
  return mode.content - HEADER;
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

/**
 * Splits data into frames for a mode.
 * @returns {{ id, mode, meta: Uint8Array, data: Uint8Array[], total }}
 */
export function buildTransfer({ bytes, kind, mime = '', name = '', flags = 0 }, mode) {
  const P = payloadSize(mode);
  const total = Math.max(1, Math.ceil(bytes.length / P));
  if (total > 65535) throw new Error('too large');
  const id = (Math.random() * 65536) | 0;
  const mimeB = truncUtf8(mime, 40);
  const fixed = 14 + mimeB.length;
  const nameB = truncUtf8(name, Math.max(0, P - fixed - 1));
  const mp = new Uint8Array(fixed + 1 + nameB.length);
  const dv = new DataView(mp.buffer);
  dv.setUint16(0, total);
  dv.setUint32(2, bytes.length);
  dv.setUint32(6, crc32(bytes));
  mp[10] = kind;
  mp[11] = flags;
  mp[12] = mimeB.length;
  mp.set(mimeB, 13);
  mp[13 + mimeB.length] = nameB.length;
  mp.set(nameB, 14 + mimeB.length);
  const meta = frame(mode, 0, id, 0, mp.subarray(0, Math.min(mp.length, P)));
  const data = [];
  for (let i = 0; i < total; i++) data.push(frame(mode, 1, id, i, bytes.subarray(i * P, (i + 1) * P)));
  return { id, mode, meta, data, total };
}

/** Order of frames for one pass: meta first and again every META_EVERY frames. */
export function passOrder(t) {
  const out = [t.meta];
  t.data.forEach((d, i) => {
    out.push(d);
    if ((i + 1) % META_EVERY === 0 && i + 1 < t.data.length) out.push(t.meta);
  });
  return out;
}

export function estimateSeconds(bytes, mode, passes = 1) {
  const total = Math.max(1, Math.ceil(bytes / payloadSize(mode)));
  const frames = total + 1 + Math.floor((total - 1) / META_EVERY);
  return frames * (frameDuration(mode) + FRAME_PAUSE) * passes;
}

export function parseFrame(content) {
  const type = content[0];
  const id = (content[1] << 8) | content[2];
  const seq = (content[3] << 8) | content[4];
  const len = content[5];
  if (type > 1 || HEADER + len > content.length) return null;
  const payload = content.slice(HEADER, HEADER + len);
  if (type === 1) return { type: 'data', id, seq, payload };
  if (len < 15) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const mimeLen = payload[12];
  const nameLen = payload[13 + mimeLen];
  const dec = new TextDecoder();
  return {
    type: 'meta',
    id,
    total: dv.getUint16(0),
    size: dv.getUint32(2),
    crc: dv.getUint32(6),
    kind: payload[10],
    flags: payload[11],
    mime: dec.decode(payload.subarray(13, 13 + mimeLen)),
    name: dec.decode(payload.subarray(14 + mimeLen, 14 + mimeLen + (nameLen || 0))),
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
      t = { id, meta: null, packets: new Map(), done: false, result: null, updated: Date.now() };
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
    t.updated = Date.now();
    if (f.type === 'meta') {
      if (!t.meta) t.meta = f;
    } else if (!t.packets.has(f.seq)) {
      t.packets.set(f.seq, f.payload);
    }
    t.lastFrame = f.type;
    if (!t.done && t.meta && t.packets.size >= t.meta.total) this._finish(t);
    return t;
  }

  _finish(t) {
    const { total, size, crc } = t.meta;
    const out = new Uint8Array(size);
    let o = 0;
    for (let i = 0; i < total; i++) {
      const p = t.packets.get(i);
      if (!p) return;
      out.set(p.subarray(0, Math.min(p.length, size - o)), o);
      o += p.length;
    }
    t.done = true;
    t.crcOk = crc32(out) === crc;
    t.result = out;
  }

  /** Bytes of the contiguous prefix received so far (for progressive previews). */
  prefix(t) {
    const parts = [];
    for (let i = 0; t.packets.has(i); i++) parts.push(t.packets.get(i));
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export { MODES };
