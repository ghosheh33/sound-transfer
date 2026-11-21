// Browser audio: microphone capture, frame decoding and scheduled playback.
// The microphone is switched off while this phone plays (iOS lowers or
// reroutes the speaker while it records), so the link is half duplex.
import { modulate, frameDuration, Receiver } from './modem.js';
import { FRAME_PAUSE, parseFrame } from './protocol.js';

const TAP_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

function audioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* unsupported */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AudioLink {
  /**
   * handlers: onFrame({ content, mode, quality }), onFail(event), onSync(mode), onLevel(rms)
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.mic = null;
    this.ctx = null;
    this.gain = null;
    this.volume = 0.9;
    this.sources = [];
    this.playing = null;
  }

  get micActive() {
    return !!this.mic;
  }

  async micOn() {
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-mic-api');
    audioSession('play-and-record');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    let ctx = new AudioContext();
    let src;
    try {
      src = ctx.createMediaStreamSource(stream);
    } catch {
      await ctx.close(); // Firefox: the context must run at the microphone's rate
      ctx = new AudioContext({ sampleRate: stream.getAudioTracks()[0].getSettings().sampleRate });
      src = ctx.createMediaStreamSource(stream);
    }
    await ctx.resume();
    const rx = new Receiver(ctx.sampleRate, {
      onFrame: (f) => this.h.onFrame?.(f),
      onEvent: (e) => {
        if (e.type === 'sync') this.h.onSync?.(e.mode);
        else if (e.type === 'fail' && e.reason === 'decode') this.h.onFail?.(e);
      },
    });
    const onSamples = (x) => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      this.h.onLevel?.(Math.sqrt(s / x.length));
      rx.push(x);
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node;
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'tap');
      node.port.onmessage = (e) => onSamples(e.data);
    } else {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    src.connect(node);
    node.connect(sink);
    this.mic = { stream, ctx, src, node };
  }

  micOff() {
    const m = this.mic;
    if (!m) return;
    this.mic = null;
    try { m.src.disconnect(); m.node.disconnect(); } catch { /* ignore */ }
    m.stream.getTracks().forEach((t) => t.stop());
    m.ctx.close();
    this.h.onLevel?.(0);
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  async _ensureOut() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    this.gain.gain.value = this.volume;
    await this.ctx.resume();
  }

  /** Must be called from a user gesture once, so later playback is allowed (iOS). */
  async unlock() {
    await this._ensureOut();
  }

  /**
   * Plays frames [{ content, mode }] back to back. onFrame(i) is called as
   * frame i (1-based) finishes. Resolves true when done, false if stopped.
   */
  async play(frames, onFrame) {
    this.stop();
    audioSession('playback');
    await this._ensureOut();
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    return new Promise((resolve) => {
      let next = ctx.currentTime + 0.15;
      let i = 0;
      const ends = [];
      let reported = 0;
      const finish = (ok) => {
        clearInterval(timer);
        this.playing = null;
        resolve(ok);
      };
      const tick = () => {
        while (i < frames.length && next < ctx.currentTime + 2.5) {
          const { content, mode } = frames[i];
          const samples = modulate(content, mode, sr);
          const buf = ctx.createBuffer(1, samples.length, sr);
          buf.copyToChannel(samples, 0);
          const s = ctx.createBufferSource();
          s.buffer = buf;
          s.connect(this.gain);
          s.start(next);
          this.sources.push(s);
          s.onended = () => { this.sources = this.sources.filter((x) => x !== s); };
          next += frameDuration(mode) + FRAME_PAUSE;
          ends.push(next);
          i++;
        }
        const now = ctx.currentTime;
        while (reported < ends.length && ends[reported] <= now) {
          reported++;
          onFrame?.(reported);
        }
        if (reported >= frames.length) finish(true);
      };
      const timer = setInterval(tick, 100);
      this.playing = { stop: () => finish(false) };
      tick();
    });
  }

  stop() {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.sources = [];
    if (this.playing) this.playing.stop();
  }
}

/** I/O for the sending phone: microphone only while waiting for a reply. */
export function senderIO(link) {
  const io = {
    stopped: false,
    listener: null,
    async play(frames, onFrame) {
      link.micOff();
      if (io.stopped) return false;
      const ok = await link.play(frames, onFrame);
      return ok && !io.stopped;
    },
    async listen(ms, accept) {
      if (io.stopped) return null;
      try {
        await link.micOn();
      } catch {
        return null;
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => done(null), ms);
        const done = (v) => {
          clearTimeout(timer);
          io.listener = null;
          link.micOff();
          resolve(v);
        };
        io.listener = (f) => { if (accept(f)) done(f); };
        io.cancel = () => done(null);
      });
    },
    stop() {
      io.stopped = true;
      link.stop();
      io.cancel?.();
    },
    /** Route decoded frames here while listening. */
    frame({ content }) {
      if (!io.listener) return;
      const f = parseFrame(content);
      if (f) io.listener(f);
    },
  };
  return io;
}

/** I/O for the receiving phone: answers after a pause, then keeps listening. */
export function receiverIO(link, { replyDelay = 1300 } = {}) {
  return {
    async reply(content, mode) {
      const wasOn = link.micActive;
      await sleep(replyDelay); // let the sender switch its microphone on
      link.micOff();
      try {
        await link.play([{ content, mode }]);
      } finally {
        if (wasOn) {
          try { await link.micOn(); } catch { /* permission lost */ }
        }
      }
    },
  };
}
