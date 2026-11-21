// Transfer sessions over a half-duplex acoustic link.
//
// Sender, with a back channel (arq):
//   round r: [meta] [missing ranges] [next block + its parity] [END]
//   then it listens for the receiver's REPORT (missing ranges + how many
//   frames arrived), adapts the mode, and starts the next round. The first
//   block is small so the channel is measured early.
// Sender, one way: full passes (data + parity), no END.
//
// The I/O object hides the audio:
//   io.play(frames, onFrame) -> Promise<boolean>   frames: [{ content, mode }]
//   io.listen(ms, accept)    -> Promise<parsed frame | null>
//   io.stopped               -> true once the user pressed stop

import { MODES, frameDuration } from './modem.js';
import {
  TYPE, CONTROL_MODE, META_EVERY, FRAME_PAUSE, REPORT_DONE, REPORT_HAVE_META,
  buildTransfer, metaFrame, rangeFrames, parityFrames, blockRange, passOrder, endFrame, reportFrame,
  parseFrame, Assembler, capacity,
} from './protocol.js';

export const FASTEST = MODES.length - 1;
const REPLY_WAIT = 7000; // ms the sender listens for a REPORT
const END_TRIES = 4; // first in the control mode, the rest in the robust mode

export class SenderSession {
  constructor(payload, io, opts = {}) {
    this.payload = payload;
    this.io = io;
    this.auto = opts.auto ?? true;
    this.mode = opts.mode ?? 3;
    this.arq = opts.arq ?? true;
    this.redundancy = opts.redundancy ?? (this.arq ? 10 : 20);
    this.passes = opts.passes ?? 1;
    this.maxRounds = opts.maxRounds ?? 20;
    this.onStatus = opts.onStatus || (() => {});
    this.memory = opts.memory || {};
  }

  status(s) {
    this.onStatus({ ...s, mode: MODES[this.mode] });
  }

  async run() {
    if (!this.arq) return this._oneWay();
    return this._rounds();
  }

  async _oneWay() {
    const t = buildTransfer(this.payload, MODES[this.mode], this.redundancy, false);
    const pass = passOrder(t);
    for (let p = 0; p < this.passes; p++) {
      this.status({ phase: 'sending', pass: p, passes: this.passes, sent: 0, count: pass.length });
      const ok = await this.io.play(pass.map((c) => ({ content: c, mode: MODES[this.mode] })),
        (i) => this.status({ phase: 'sending', pass: p, passes: this.passes, sent: i, count: pass.length }));
      if (!ok) return { ok: false, reason: 'stopped' };
    }
    return { ok: true, confirmed: false };
  }

  async _rounds() {
    const t = buildTransfer(this.payload, MODES[this.mode], this.redundancy, true);
    this.transfer = t;
    const size = t.bytes.length;
    let nextBlock = 0;
    let sentUpTo = 0;
    let missing = [];
    let needMeta = true;
    let ultraBad = false;
    let ctrl = CONTROL_MODE;
    let lastLoss = 0;
    for (let round = 1; round <= this.maxRounds; round++) {
      const m = MODES[this.mode];
      const frames = [];
      if (needMeta) frames.push(metaFrame(t, m));
      for (const [s, e] of missing) frames.push(...rangeFrames(t, s, Math.min(e, size), m));
      // After a bad round only the missing data goes out until a working mode is found.
      if (nextBlock < t.blocks.length && (lastLoss <= 0.5 || !missing.length)) {
        const b = t.blocks[nextBlock++];
        const [s, e] = blockRange(t, b);
        frames.push(...rangeFrames(t, s, e, m), ...parityFrames(t, b, m));
        sentUpTo = e;
      }
      // Long rounds repeat the meta frame so a late listener still learns it.
      const withMeta = [];
      frames.forEach((f, i) => {
        withMeta.push(f);
        if (needMeta && i > 0 && i % META_EVERY === 0) withMeta.push(metaFrame(t, m));
      });
      const list = withMeta.map((c) => ({ content: c, mode: m }));
      const progressBase = sentUpTo;
      this.status({ phase: 'sending', round, sent: 0, count: list.length, bytes: size, confirmed: this.confirmed || 0, upTo: progressBase });
      const ok = await this.io.play(list, (i) => this.status({ phase: 'sending', round, sent: i, count: list.length, bytes: size, confirmed: this.confirmed || 0, upTo: progressBase }));
      if (!ok) return { ok: false, reason: 'stopped' };

      // Hand over and wait for the answer.
      let report = null;
      let viaRobust = false;
      for (let tries = 0; tries < END_TRIES && !report; tries++) {
        if (tries > 0) ctrl = 0; // retries use the most robust mode
        viaRobust = ctrl === 0;
        const end = endFrame(t.id, { round, sentUpTo, dataMode: this.mode }, MODES[ctrl]);
        if (!(await this.io.play([{ content: end, mode: MODES[ctrl] }]))) return { ok: false, reason: 'stopped' };
        this.status({ phase: 'waiting', round, bytes: size, confirmed: this.confirmed || 0 });
        report = await this.io.listen(REPLY_WAIT, (f) => f.type === 'report' && f.id === t.id && f.round === (round & 0xff));
        if (this.io.stopped) return { ok: false, reason: 'stopped' };
      }
      if (!report) return { ok: false, reason: 'no-reply' };

      needMeta = !(report.flags & REPORT_HAVE_META);
      if (report.flags & REPORT_DONE) {
        this.memory.mode = this.mode;
        this.status({ phase: 'done', round, bytes: size, confirmed: size });
        return { ok: true, confirmed: true, rounds: round };
      }
      missing = needMeta ? [[0, sentUpTo]] : report.ranges;
      const missingBytes = missing.reduce((a, [s, e]) => a + (e - s), 0);
      this.confirmed = needMeta ? 0 : sentUpTo - missingBytes;
      if (!missing.length && nextBlock >= t.blocks.length) {
        // Receiver is not done but reports nothing missing: resend everything it lacks.
        missing = [[0, size]];
      }

      // Adapt the mode to what arrived.
      if (this.auto) {
        const sent = list.length;
        const loss = sent ? Math.max(0, 1 - report.ok / sent) : 0;
        lastLoss = loss;
        const before = this.mode;
        if (viaRobust && loss > 0.15) this.mode = 0; // even 'normal' did not get through
        else if (loss > 0.6) this.mode = Math.max(0, this.mode - 2);
        else if (loss > 0.15) this.mode = Math.max(0, this.mode - 1);
        else if (loss === 0 && report.quality >= 14 && sent >= 3 && this.mode < FASTEST) {
          if (!(this.mode + 1 === FASTEST && ultraBad)) this.mode++;
        }
        if (before === FASTEST && this.mode < before) ultraBad = true;
        if (this.mode !== before) this.status({ phase: 'mode', round, from: MODES[before], bytes: size, confirmed: this.confirmed });
        this.memory.mode = Math.min(this.mode, 3);
      }
      this.status({ phase: 'resending', round, missing: missingBytes, bytes: size, confirmed: this.confirmed });
    }
    return { ok: false, reason: 'rounds' };
  }
}

/** Estimated seconds for a transfer in a mode (one round trip per block in ARQ mode). */
export function estimate(bytes, mode, arq, redundancy) {
  const frames = Math.ceil(bytes / capacity(mode)) * (1 + redundancy / 100) + 1;
  const air = frames * (frameDuration(mode) + FRAME_PAUSE);
  if (!arq) return air;
  const rounds = 1 + Math.ceil(Math.max(0, frames - 16) / 48);
  const ctrl = 2 * (frameDuration(MODES[CONTROL_MODE]) + FRAME_PAUSE) + 2.5;
  return air + rounds * ctrl;
}

/**
 * Receiving side. Feed every decoded frame to handleFrame and every failed
 * decode to handleFail. When the sender hands over (END), the session
 * answers through io.reply(frame, mode).
 */
export class ReceiverSession {
  constructor(io, { onUpdate = () => {}, onReply = () => {} } = {}) {
    this.io = io;
    this.asm = new Assembler();
    this.onUpdate = onUpdate;
    this.onReply = onReply;
    this.stats = new Map(); // id -> { ok, qsum, bad }
    this.lastReport = new Map(); // id -> { round, stats }
    this.bad = 0;
    this.lastId = null;
    this.replying = false;
  }

  _stats(id) {
    let s = this.stats.get(id);
    if (!s) { s = { ok: 0, qsum: 0, bad: 0 }; this.stats.set(id, s); }
    return s;
  }

  handleFail() {
    this.bad++;
    if (this.lastId !== null) this._stats(this.lastId).bad++;
  }

  handleFrame({ content, mode, quality }) {
    const f = parseFrame(content);
    if (!f) return null;
    if (f.type === 'report') return f; // our own echo or another pair's answer
    if (f.type === 'end') {
      this._answer(f, mode);
      return f;
    }
    this.lastId = f.id;
    const s = this._stats(f.id);
    s.ok++;
    s.qsum += quality;
    const t = this.asm.add(f);
    t.mode = mode;
    this.onUpdate(t, f);
    return f;
  }

  async _answer(end, endMode) {
    if (this.replying) return;
    const t = this.asm.get(end.id);
    let snap;
    const last = this.lastReport.get(end.id);
    if (last && last.round === end.round) {
      snap = last.stats; // repeated END: answer with the same numbers
    } else {
      const s = this._stats(end.id);
      snap = { ok: s.ok, bad: s.bad, quality: s.ok ? s.qsum / s.ok : 0 };
      this.stats.set(end.id, { ok: 0, qsum: 0, bad: 0 });
      this.lastReport.set(end.id, { round: end.round, stats: snap });
    }
    const flags = (t.done ? REPORT_DONE : 0) | (t.meta ? REPORT_HAVE_META : 0);
    const ranges = t.done ? [] : this.asm.missing(t, end.sentUpTo);
    // Answer in the mode the END arrived in (the sender falls back to robust).
    const replyMode = endMode || MODES[CONTROL_MODE];
    const frame = reportFrame(end.id, { round: end.round, flags, ...snap, ranges }, replyMode);
    this.replying = true;
    this.onReply({ transfer: t, end, ranges, done: t.done });
    try {
      await this.io.reply(frame, replyMode);
    } finally {
      this.replying = false;
    }
  }
}

export { TYPE };
