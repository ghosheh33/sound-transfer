// Browser audio: microphone capture and scheduled playback of frames.
import { modulate, frameDuration } from './modem.js';
import { FRAME_PAUSE } from './protocol.js';

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

function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch { /* not supported */ }
}

/** Starts the microphone. Returns { sampleRate, stop() }. */
export async function startMic(onSamples) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('no-mic-api');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  let ctx = new AudioContext();
  let src;
  try {
    src = ctx.createMediaStreamSource(stream);
  } catch {
    // Firefox: the context must run at the microphone's rate.
    await ctx.close();
    const rate = stream.getAudioTracks()[0].getSettings().sampleRate;
    ctx = new AudioContext({ sampleRate: rate });
    src = ctx.createMediaStreamSource(stream);
  }
  await ctx.resume();
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
  return {
    sampleRate: ctx.sampleRate,
    stop() {
      try { src.disconnect(); node.disconnect(); } catch { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    },
  };
}

/**
 * Plays a list of frame contents, `passes` times (Infinity = until stopped).
 * onProgress({ index, count, pass, done })
 */
export class Transmitter {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.timer = null;
    this.sources = [];
  }

  async _ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.value = v;
    this.volume = v;
  }

  get running() {
    return this.timer !== null;
  }

  async start(frames, mode, passes, onProgress) {
    this.stop();
    setAudioSession('playback');
    await this._ensure();
    this.gain.gain.value = this.volume ?? 0.9;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const step = frameDuration(mode) + FRAME_PAUSE;
    let next = ctx.currentTime + 0.25;
    let i = 0;
    let pass = 0;
    const schedule = [];
    const tick = () => {
      while (next < ctx.currentTime + 2.5 && pass < passes) {
        const samples = modulate(frames[i], mode, sr);
        const buf = ctx.createBuffer(1, samples.length, sr);
        buf.copyToChannel(samples, 0);
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(this.gain);
        s.start(next);
        s.onended = () => { this.sources = this.sources.filter((x) => x !== s); };
        this.sources.push(s);
        schedule.push({ at: next, index: i, pass });
        next += step;
        i++;
        if (i >= frames.length) { i = 0; pass++; }
      }
      const now = ctx.currentTime;
      while (schedule.length > 1 && schedule[1].at <= now) schedule.shift();
      const cur = schedule[0];
      if (pass >= passes && (!cur || now > next)) {
        this.stop();
        onProgress({ index: frames.length, count: frames.length, pass: passes - 1, done: true });
        return;
      }
      if (cur && cur.at <= now) {
        const frac = Math.min(1, (now - cur.at) / step);
        onProgress({ index: cur.index + frac, count: frames.length, pass: cur.pass, done: false });
      }
    };
    this.timer = setInterval(tick, 150);
    tick();
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.sources = [];
  }
}
