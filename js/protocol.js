// Transfer protocol on top of modem frames.
//
// Frame content (mode.content bytes):
//   [0] type   [1..2] transfer id   [3..5] 24-bit field   [6] payload length   [7..] payload
// The 24-bit field is the byte offset for DATA, the parity index for PARITY,
// and 0 for the other types.
//
// Data frames carry a byte range of the file, so a sender can change mode
// between rounds and resend only the missing ranges in whatever mode works.
//
// Loss recovery:
//   * Parity packets (Reed–Solomon across packets of P bytes, one code per
//     byte column) rebuild lost packets without any reply: any K of a
//     block's K+M packets rebuild the block.
//   * With a back channel, the receiver answers each round with a REPORT of
//     the byte ranges it still misses, and the sender resends just those.

import { crc32 } from './crc32.js';
import { rsEncode, rsDecode } from './rs.js';
import { MODES, frameDuration } from './modem.js';

export const KIND = { TEXT: 0, IMAGE: 1, FILE: 2 };
export const FLAG_DEFLATE = 1;
export const TYPE = { META: 0, DATA: 1, PARITY: 2, END: 3, REPORT: 4 };
const HEADER = 7;
export const META_EVERY = 12; // a meta frame after every N other frames
export const FRAME_PAUSE = 0.06; // seconds of silence between frames
export const CONTROL_MODE = 1; // END and REPORT frames use the 'normal' mode
// Block sizes (packets) when a back channel is used: a small first block to
// learn the channel quickly, then larger ones.
export const ARQ_FIRST_K = 16;
export const ARQ_K = 48;

export function capacity(mode) {
  return mode.content - HEADER;
}
/** Old name kept for callers estimating sizes. */
export const payloadSize = capacity;

/** Block layout shared by sender and receiver. */
export function layout(total, redundancy, firstK = 0, K = 0) {
  const r = redundancy / 100;
  const maxK = Math.min(200, Math.floor(255 / (1 + r)));
  const k0 = firstK ? Math.min(firstK, maxK) : maxK;
  const k1 = K ? Math.min(K, maxK) : maxK;
  const sizes = [];
  if (firstK || K) {
    let left = total;
    sizes.push(Math.min(left, k0));
    left -= sizes[0];
    while (left > 0) { sizes.push(Math.min(left, k1)); left -= sizes[sizes.length - 1]; }
  } else {
    const nb = Math.ceil(total / maxK);
    for (let b = 0; b < nb; b++) sizes.push(Math.floor(total / nb) + (b < total % nb ? 1 : 0));
  }
  const blocks = [];
  let start = 0;
  let pstart = 0;
  for (const K_ of sizes) {
    const M = r > 0 ? Math.min(255 - K_, Math.max(1, Math.ceil(K_ * r))) : 0;
    blocks.push({ start, K: K_, pstart, M });
    start += K_;
    pstart += M;
  }
  return { blocks, parityTotal: pstart };
}

export function frame(mode, type, id, field, payload = new Uint8Array(0)) {
  const c = new Uint8Array(mode.content);
  c[0] = type;
  c[1] = id >> 8; c[2] = id & 0xff;
  c[3] = (field >> 16) & 0xff; c[4] = (field >> 8) & 0xff; c[5] = field & 0xff;
  c[6] = payload.length;
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
 * Prepares a transfer. Packets have the capacity of `mode`; with arq=true
 * the blocks follow the ARQ round sizes.
 */
export function buildTransfer({ bytes, kind, mime = '', name = '', flags = 0 }, mode, redundancy = 20, arq = false) {
  if (bytes.length >= 1 << 24) throw new Error('too large');
  const P = capacity(mode);
  const total = Math.max(1, Math.ceil(bytes.length / P));
  const firstK = arq ? ARQ_FIRST_K : 0;
  const K = arq ? ARQ_K : 0;
  const { blocks, parityTotal } = layout(total, redundancy, firstK, K);
  if (parityTotal >= 1 << 24) throw new Error('too large');
  const id = (Math.random() * 65536) | 0;
  const mimeB = truncUtf8(mime, 40);
  const fixed = 16 + mimeB.length;
  const nameB = truncUtf8(name, Math.max(0, capacity(MODES[0]) - fixed - 1));
  const mp = new Uint8Array(fixed + 1 + nameB.length);
  const dv = new DataView(mp.buffer);
  dv.setUint32(0, bytes.length);
  dv.setUint32(4, crc32(bytes));
  mp[8] = kind;
  mp[9] = flags;
  mp[10] = redundancy;
  mp[11] = P;
  mp[12] = firstK;
  mp[13] = K;
  mp[14] = 0; // reserved
  mp[15] = mimeB.length;
  mp.set(mimeB, 16);
  mp[16 + mimeB.length] = nameB.length;
  mp.set(nameB, 17 + mimeB.length);
  const metaPayload = mp;

  const padded = [];
  for (let i = 0; i < total; i++) {
    const p = new Uint8Array(P);
    p.set(bytes.subarray(i * P, (i + 1) * P));
    padded.push(p);
  }
  const parity = [];
  for (const b of blocks) {
    if (b.M) parity.push(...encodeBlock(padded.slice(b.start, b.start + b.K), b.M, P));
  }
  return { id, bytes, P, total, blocks, parity, metaPayload, mode };
}

export function metaFrame(t, mode) {
  return frame(mode, TYPE.META, t.id, 0, t.metaPayload);
}

/** Data frames covering [start, end) in chunks that fit `mode`. */
export function rangeFrames(t, start, end, mode) {
  const cap = capacity(mode);
  const out = [];
  for (let o = start; o < end; o += cap) {
    out.push(frame(mode, TYPE.DATA, t.id, o, t.bytes.subarray(o, Math.min(end, o + cap))));
  }
  return out;
}

/** Parity frames of a block (only when the mode can carry a whole packet). */
export function parityFrames(t, b, mode) {
  if (capacity(mode) < t.P) return [];
  const out = [];
  for (let j = 0; j < b.M; j++) out.push(frame(mode, TYPE.PARITY, t.id, b.pstart + j, t.parity[b.pstart + j]));
  return out;
}

export function blockRange(t, b) {
  return [b.start * t.P, Math.min(t.bytes.length, (b.start + b.K) * t.P)];
}

/** Frames of one full pass (one-way mode): meta regularly, block data then parity. */
export function passOrder(t) {
  const m = t.mode;
  const meta = metaFrame(t, m);
  const out = [meta];
  let since = 0;
  const push = (f) => {
    out.push(f);
    if (++since === META_EVERY) { out.push(meta); since = 0; }
  };
  for (const b of t.blocks) {
    const [s, e] = blockRange(t, b);
    rangeFrames(t, s, e, m).forEach(push);
    parityFrames(t, b, m).forEach(push);
  }
  if (out[out.length - 1] === meta && out.length > 1) out.pop();
  return out;
}

export function estimateSeconds(bytes, mode, passes = 1, redundancy = 20) {
  const total = Math.max(1, Math.ceil(bytes / capacity(mode)));
  const frames0 = total + layout(total, redundancy).parityTotal;
  const frames = frames0 + 1 + Math.floor((frames0 - 1) / META_EVERY);
  return frames * (frameDuration(mode) + FRAME_PAUSE) * passes;
}

// ---------- control frames ----------

/** END: the sender's turn is over. */
export function endFrame(id, { round, sentUpTo, dataMode }, mode = MODES[CONTROL_MODE]) {
  const p = new Uint8Array(5);
  p[0] = round & 0xff;
  p[1] = (sentUpTo >> 16) & 0xff; p[2] = (sentUpTo >> 8) & 0xff; p[3] = sentUpTo & 0xff;
  p[4] = dataMode;
  return frame(mode, TYPE.END, id, 0, p);
}

export const REPORT_DONE = 1;
export const REPORT_HAVE_META = 2;
const REPORT_FIXED = 7;
const RANGE_BYTES = 5;

/** REPORT: the receiver's answer. ranges = [[start, end), ...] still missing. */
export function reportFrame(id, { round, flags, ok, bad, quality, ranges }, mode = MODES[CONTROL_MODE]) {
  const maxRanges = Math.floor((capacity(mode) - REPORT_FIXED) / RANGE_BYTES);
  const list = [];
  for (const [s, e] of ranges) {
    for (let o = s; o < e && list.length < maxRanges; o += 0xffff) list.push([o, Math.min(e, o + 0xffff)]);
    if (list.length >= maxRanges) break;
  }
  const p = new Uint8Array(REPORT_FIXED + list.length * RANGE_BYTES);
  p[0] = round & 0xff;
  p[1] = flags;
  p[2] = Math.min(255, ok);
  p[3] = Math.min(255, bad);
  p[4] = Math.round(Math.min(20, quality) * 10);
  p[5] = 0;
  p[6] = list.length;
  list.forEach(([s, e], i) => {
    const o = REPORT_FIXED + i * RANGE_BYTES;
    p[o] = (s >> 16) & 0xff; p[o + 1] = (s >> 8) & 0xff; p[o + 2] = s & 0xff;
    const len = e - s;
    p[o + 3] = len >> 8; p[o + 4] = len & 0xff;
  });
  return frame(mode, TYPE.REPORT, id, 0, p);
}

export function parseFrame(content) {
  const type = content[0];
  const id = (content[1] << 8) | content[2];
  const field = (content[3] << 16) | (content[4] << 8) | content[5];
  const len = content[6];
  if (type > TYPE.REPORT || HEADER + len > content.length) return null;
  const p = content.slice(HEADER, HEADER + len);
  switch (type) {
    case TYPE.DATA: return { type: 'data', id, offset: field, payload: p };
    case TYPE.PARITY: return { type: 'parity', id, index: field, payload: p };
    case TYPE.END:
      if (len < 5) return null;
      return { type: 'end', id, round: p[0], sentUpTo: (p[1] << 16) | (p[2] << 8) | p[3], dataMode: p[4] };
    case TYPE.REPORT: {
      if (len < REPORT_FIXED) return null;
      const n = p[6];
      if (REPORT_FIXED + n * RANGE_BYTES > len) return null;
      const ranges = [];
      for (let i = 0; i < n; i++) {
        const o = REPORT_FIXED + i * RANGE_BYTES;
        const s = (p[o] << 16) | (p[o + 1] << 8) | p[o + 2];
        ranges.push([s, s + ((p[o + 3] << 8) | p[o + 4])]);
      }
      return { type: 'report', id, round: p[0], flags: p[1], ok: p[2], bad: p[3], quality: p[4] / 10, ranges };
    }
    default: {
      if (len < 18) return null;
      const dv = new DataView(p.buffer, p.byteOffset, p.length);
      const mimeLen = p[15];
      const nameLen = p[16 + mimeLen] || 0;
      const dec = new TextDecoder();
      return {
        type: 'meta',
        id,
        size: dv.getUint32(0),
        crc: dv.getUint32(4),
        kind: p[8],
        flags: p[9],
        redundancy: p[10],
        P: p[11],
        firstK: p[12],
        K: p[13],
        mime: dec.decode(p.subarray(16, 16 + mimeLen)),
        name: dec.decode(p.subarray(17 + mimeLen, 17 + mimeLen + nameLen)),
      };
    }
  }
}

// ---------- receiving side ----------

/** Collects frames from any number of transfers and reassembles them. */
export class Assembler {
  constructor() {
    this.transfers = new Map();
  }

  get(id) {
    let t = this.transfers.get(id);
    if (!t) {
      t = { id, meta: null, pending: [], parity: new Map(), recovered: 0, covered: 0, done: false, result: null };
      this.transfers.set(id, t);
    }
    return t;
  }

  /** Adds a parsed data/meta/parity frame. Returns the transfer. */
  add(f) {
    const t = this.get(f.id);
    t.updated = Date.now();
    if (f.type === 'meta') {
      if (!t.meta) this._setMeta(t, f);
    } else if (!t.meta) {
      t.pending.push(f);
    } else if (f.type === 'data') {
      this._write(t, f.offset, f.payload);
    } else if (f.type === 'parity' && !t.parity.has(f.index)) {
      const p = new Uint8Array(t.meta.P);
      p.set(f.payload.subarray(0, t.meta.P));
      t.parity.set(f.index, p);
    }
    if (t.meta && !t.done) {
      this._recover(t);
      if (t.covered >= t.meta.size) this._finish(t);
    }
    return t;
  }

  _setMeta(t, m) {
    t.meta = m;
    const total = Math.max(1, Math.ceil(m.size / m.P));
    t.total = total;
    t.blocks = layout(total, m.redundancy, m.firstK, m.K).blocks;
    t.buf = new Uint8Array(m.size);
    t.cov = new Uint8Array(m.size);
    t.pc = new Uint16Array(total); // covered bytes per packet
    const pend = t.pending;
    t.pending = [];
    for (const f of pend) this.add(f);
  }

  _write(t, offset, data) {
    const end = Math.min(t.meta.size, offset + data.length);
    for (let i = offset; i < end; i++) {
      if (t.cov[i]) continue;
      t.cov[i] = 1;
      t.buf[i] = data[i - offset];
      t.covered++;
      t.pc[Math.floor(i / t.meta.P)]++;
    }
  }

  _packetLen(t, i) {
    return Math.min(t.meta.P, t.meta.size - i * t.meta.P);
  }

  _recover(t) {
    const P = t.meta.P;
    for (const b of t.blocks) {
      if (!b.M) continue;
      const missing = [];
      for (let i = 0; i < b.K; i++) if (t.pc[b.start + i] < this._packetLen(t, b.start + i)) missing.push(i);
      if (!missing.length) continue;
      const erase = [...missing];
      for (let j = 0; j < b.M; j++) if (!t.parity.has(b.pstart + j)) erase.push(b.K + j);
      if (erase.length > b.M) continue;
      const out = missing.map(() => new Uint8Array(P));
      const cw = new Uint8Array(b.K + b.M);
      let ok = true;
      for (let c = 0; c < P && ok; c++) {
        for (let i = 0; i < b.K; i++) {
          const pos = (b.start + i) * P + c;
          cw[i] = pos < t.meta.size ? t.buf[pos] : 0;
        }
        for (let j = 0; j < b.M; j++) cw[b.K + j] = t.parity.get(b.pstart + j)?.[c] ?? 0;
        const msg = rsDecode(cw, b.M, erase);
        if (!msg) { ok = false; break; }
        missing.forEach((i, k) => { out[k][c] = msg[i]; });
      }
      if (!ok) continue;
      missing.forEach((i, k) => {
        this._write(t, (b.start + i) * P, out[k].subarray(0, this._packetLen(t, b.start + i)));
        t.recovered++;
      });
    }
  }

  _finish(t) {
    t.done = true;
    t.result = t.buf;
    t.crcOk = crc32(t.buf) === t.meta.crc;
  }

  /** Missing byte ranges below `upTo`. */
  missing(t, upTo) {
    const out = [];
    if (!t.meta) return upTo > 0 ? [[0, upTo]] : [];
    const end = Math.min(upTo, t.meta.size);
    let s = -1;
    for (let i = 0; i < end; i++) {
      if (!t.cov[i]) { if (s < 0) s = i; } else if (s >= 0) { out.push([s, i]); s = -1; }
    }
    if (s >= 0) out.push([s, end]);
    return out;
  }

  progress(t) {
    return t.meta ? t.covered / t.meta.size : 0;
  }

  /** Bytes of the contiguous prefix received so far (for progressive previews). */
  prefix(t) {
    if (!t.meta) return new Uint8Array(0);
    let n = 0;
    while (n < t.meta.size && t.cov[n]) n++;
    return t.buf.subarray(0, n);
  }
}

export { MODES };
