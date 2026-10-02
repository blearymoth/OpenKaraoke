// Playback engine for the TV display (PLAN §9.3).
//
// Audio files are decoded once and played by Signalsmith Stretch (an AudioWorklet), which
// gives high-quality key change (±semitones) and tempo change. Video, and audio the browser
// can't decode in one piece, play through a media element routed into the same node in
// "live input" mode (key change only; tempo via playbackRate).
//
// Graph: source → stretch → 2×2 channel matrix → track gain (loudness) → fade → master → out
// The matrix gives the channel modes and, on multiplex tracks, the guide singer's level
// (shared/vocals.js); decoding also analyses the two channels (is one of them "music + singer"?).
//
// Timing (measured): a buffer segment scheduled as { input, output, rate } emits input time x
// at context time output + (x − input) / rate. The audible position is therefore
// input + (heardContextTime − output) · rate, where heardContextTime comes from
// getOutputTimestamp(). The CDG renderer is driven by this position.
import SignalsmithStretch from '../vendor/signalsmith-stretch.mjs';
import { mixMatrix, analyseChannelsAsync } from '/shared/vocals.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.stretch = null;
    this.ready = null;
    this.cache = new Map(); // track id → Promise<prepared>
    this.track = null; // { id, duration, gainDb, mode }
    this.map = { active: false, input: 0, output: 0, rate: 1 };
    this.key = 0;
    this.rate = 1;
    this.volume = 0.9;
    this.normalize = true;
    this.mix = { channel: 'stereo', vocals: null, lead: 0 }; // what the matrix is made from
    this.element = null; // media element in element mode
    this.sources = new WeakMap(); // element → MediaElementAudioSourceNode
    this.ended = false;
    this.loadSeq = 0;
  }

  /** Builds the audio graph. The context may start suspended until a user gesture. */
  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      this.ctx = ctx;
      this.input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      this.matrix = [0, 1, 2, 3].map(() => ctx.createGain());
      const [ll, rl, lr, rr] = this.matrix;
      this.input.connect(split);
      split.connect(ll, 0);
      split.connect(rl, 1);
      split.connect(lr, 0);
      split.connect(rr, 1);
      ll.connect(merge, 0, 0);
      rl.connect(merge, 0, 0);
      lr.connect(merge, 0, 1);
      rr.connect(merge, 0, 1);
      this.trackGain = ctx.createGain();
      this.fadeGain = ctx.createGain();
      this.master = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.75;
      merge.connect(this.trackGain).connect(this.fadeGain).connect(this.master).connect(ctx.destination);
      this.master.connect(this.analyser);
      this.stretch = await SignalsmithStretch(ctx);
      this.stretch.connect(this.input);
      this.setMix(this.mix);
      this.setVolume(this.volume);
      this.ticker = setInterval(() => this.checkEnd(), 100);
    })();
    return this.ready;
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  /** Call from a click/keypress: browsers only start audio after a user gesture. */
  async unlock() {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.running;
  }

  // ---- loading -----------------------------------------------------------------------

  /** Fetches and decodes a track in the background (used to preload the next song). */
  prepare(id, url) {
    if (this.cache.has(id)) return this.cache.get(id);
    const p = (async () => {
      await this.init();
      const res = await fetch(url);
      if (!res.ok) {
        let msg = `Could not load the song (HTTP ${res.status})`;
        try {
          msg = (await res.json()).error || msg;
        } catch { /* not JSON */ }
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const bytes = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(bytes);
      const channels = [];
      for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
        const data = new Float32Array(buf.length);
        buf.copyFromChannel(data, c);
        channels.push(data);
      }
      if (channels.length === 2 && sameChannels(channels[0], channels[1])) channels.pop(); // mono in stereo
      // Is one channel the other plus a guide singer (a multiplex track)? In chunks, so the
      // lyrics keep drawing; never the cause of a failed load.
      const analysis = channels.length === 2
        ? await analyseChannelsAsync(channels[0], channels[1], buf.sampleRate, { yieldEvery: buf.sampleRate * 2 }).catch(() => null)
        : { l: 'mono', s: '', lean: '', a: 1, c: 'high' };
      if (analysis) this.emit('analysis', { id, info: analysis });
      return { id, duration: buf.duration, channels, gainDb: loudnessGainDb(channels), analysis };
    })();
    this.cache.set(id, p);
    p.catch(() => this.cache.delete(id));
    while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value);
    return p;
  }

  /** Loads a decoded audio track into the stretcher (stops whatever was playing). */
  async load(id, url) {
    const seq = ++this.loadSeq;
    const superseded = () => {
      if (seq !== this.loadSeq) throw Object.assign(new Error('superseded'), { superseded: true });
    };
    const prepared = await this.prepare(id, url);
    superseded();
    this.stopNow();
    this.detachElement();
    this.track = null;
    await this.stretch.dropBuffers();
    superseded(); // a newer load started while the old buffers were being dropped
    // Hand the sample arrays to the worklet without copying them.
    await this.stretch.addBuffers(prepared.channels, prepared.channels.map((c) => c.buffer));
    this.cache.delete(id);
    superseded();
    this.track = { id, duration: prepared.duration, gainDb: prepared.gainDb, mode: 'buffer' };
    this.map = { active: false, input: 0, output: 0, rate: this.rate };
    this.ended = false;
    this.applyTrackGain();
    return this.track;
  }

  /**
   * Loads sample arrays that are already decoded (at the context's sample rate), e.g. a quiz
   * clip cut out of a prepared track. The arrays are handed to the worklet (detached here).
   */
  async loadChannels(id, channels, { gainDb = 0 } = {}) {
    await this.init();
    const seq = ++this.loadSeq;
    const duration = channels[0].length / this.ctx.sampleRate; // measure before the arrays are transferred (detached)
    this.stopNow();
    this.detachElement();
    this.track = null;
    await this.stretch.dropBuffers();
    if (seq !== this.loadSeq) throw Object.assign(new Error('superseded'), { superseded: true });
    await this.stretch.addBuffers(channels, channels.map((c) => c.buffer));
    if (seq !== this.loadSeq) throw Object.assign(new Error('superseded'), { superseded: true });
    this.track = { id, duration, gainDb, mode: 'buffer' };
    this.map = { active: false, input: 0, output: 0, rate: this.rate };
    this.ended = false;
    this.applyTrackGain();
    return this.track;
  }

  /** Plays through a media element instead (video, or audio that failed to decode). */
  async loadElement(id, element, url) {
    const seq = ++this.loadSeq;
    const superseded = () => {
      if (seq !== this.loadSeq) throw Object.assign(new Error('superseded'), { superseded: true });
    };
    await this.init();
    superseded();
    this.stopNow();
    this.detachElement();
    this.track = null;
    await this.stretch.dropBuffers();
    superseded();
    element.preservesPitch = true;
    element.crossOrigin = 'anonymous';
    if (element.src !== new URL(url, location.href).href) element.src = url;
    element.load();
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('The browser could not play this file')); };
      const cleanup = () => { element.removeEventListener('loadedmetadata', ok); element.removeEventListener('error', bad); };
      element.addEventListener('loadedmetadata', ok);
      element.addEventListener('error', bad);
    });
    superseded();
    let source = this.sources.get(element);
    if (!source) {
      source = this.ctx.createMediaElementSource(element);
      this.sources.set(element, source);
    }
    this.element = element;
    this.elementSource = source;
    this.routeElement();
    this.onElementEnded = () => this.finish();
    element.addEventListener('ended', this.onElementEnded);
    element.playbackRate = this.rate;
    this.track = { id, duration: element.duration || 0, gainDb: 0, mode: 'element' };
    this.ended = false;
    this.applyTrackGain();
    return this.track;
  }

  /**
   * Element audio goes straight to the mixer while the key is unchanged; with a key change
   * it goes through the stretcher (a connected input switches it to live mode), which adds
   * about 0.1 s of delay.
   */
  routeElement() {
    const src = this.elementSource;
    if (!src) return;
    try {
      src.disconnect();
    } catch { /* not connected */ }
    if (this.key === 0) {
      src.connect(this.input);
    } else {
      src.connect(this.stretch);
      this.stretch.schedule({ active: true, output: this.ctx.currentTime, semitones: this.key, rate: 1 });
    }
  }

  detachElement() {
    if (!this.element) return;
    this.element.pause();
    this.element.removeEventListener('ended', this.onElementEnded);
    try {
      this.elementSource.disconnect();
    } catch { /* already disconnected */ }
    this.element = null;
    this.elementSource = null;
    // Live mode may have left an active segment: switch the stretcher off again.
    this.stretch?.schedule({ active: false, output: this.ctx.currentTime });
  }

  /** Stops and forgets the current track; any load still in flight is abandoned. */
  unload() {
    this.loadSeq++;
    this.stopNow();
    this.detachElement();
    this.track = null;
    this.stretch?.dropBuffers();
  }

  // ---- transport --------------------------------------------------------------------------

  get playing() {
    if (this.track?.mode === 'element') return !!this.element && !this.element.paused;
    return this.map.active;
  }

  get duration() {
    if (this.track?.mode === 'element') return this.element?.duration || 0;
    return this.track?.duration || 0;
  }

  /** Context time of the sample reaching the speakers right now. */
  heardTime() {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
  }

  /** Audible position in seconds within the song. */
  get position() {
    if (!this.track) return 0;
    if (this.track.mode === 'element') return this.element ? this.element.currentTime : 0;
    const m = this.map;
    if (!m.active) return m.input;
    const t = m.input + (this.heardTime() - m.output) * m.rate;
    return clamp(t, m.input, this.track.duration);
  }

  /** Input position that will be emitted at context time `t` (for seamless re-scheduling). */
  inputAt(t) {
    const m = this.map;
    return m.active ? clamp(m.input + (t - m.output) * m.rate, 0, this.track.duration) : m.input;
  }

  play(from) {
    if (!this.track) return;
    this.ended = false;
    if (this.track.mode === 'element') {
      if (from !== undefined) this.element.currentTime = from;
      this.rampFade(1, 0.03);
      this.element.play().catch((e) => this.emit('error', { error: e.message }));
      return;
    }
    const start = clamp(from ?? this.map.input, 0, this.track.duration);
    const t = this.ctx.currentTime + 0.05;
    this.stretch.schedule({ active: true, input: start, output: t, rate: this.rate, semitones: this.key });
    this.map = { active: true, input: start, output: t, rate: this.rate };
    this.rampFade(1, 0.03, t);
  }

  pause() {
    if (!this.track) return;
    if (this.track.mode === 'element') {
      this.element.pause();
      return;
    }
    if (!this.map.active) return;
    const t = this.ctx.currentTime + 0.06;
    const pos = this.inputAt(t);
    this.rampFade(0, 0.05);
    this.stretch.schedule({ active: false, output: t });
    this.map = { active: false, input: pos, output: 0, rate: this.rate };
  }

  stopNow() {
    if (this.track?.mode === 'element') this.element?.pause();
    else if (this.map.active) this.stretch?.schedule({ active: false, output: this.ctx.currentTime });
    this.map = { active: false, input: 0, output: 0, rate: this.rate };
  }

  seek(pos) {
    if (!this.track) return;
    const to = clamp(pos, 0, Math.max(0, this.duration - 0.05));
    this.ended = false;
    if (this.track.mode === 'element') {
      this.element.currentTime = to;
      return;
    }
    if (!this.map.active) {
      this.map.input = to;
      return;
    }
    const now = this.ctx.currentTime;
    const t = now + 0.05;
    this.rampFade(0, 0.03);
    this.stretch.schedule({ active: true, input: to, output: t, rate: this.rate, semitones: this.key });
    this.map = { active: true, input: to, output: t, rate: this.rate };
    this.rampFade(1, 0.03, t);
  }

  /** Re-schedules the current segment with new key/tempo without a jump. */
  reschedule() {
    if (!this.track) return;
    if (this.track.mode === 'element') {
      this.element.playbackRate = this.rate;
      this.routeElement();
      return;
    }
    if (!this.map.active) {
      this.map.rate = this.rate;
      return;
    }
    const t = this.ctx.currentTime + 0.03;
    const input = this.inputAt(t);
    this.stretch.schedule({ active: true, input, output: t, rate: this.rate, semitones: this.key });
    this.map = { active: true, input, output: t, rate: this.rate };
  }

  setKey(semitones) {
    if (semitones === this.key) return;
    this.key = semitones;
    this.reschedule();
  }

  setTempo(rate) {
    if (rate === this.rate) return;
    this.rate = rate;
    this.reschedule();
  }

  /** A channel mode (no lead vocal control). */
  setChannelMode(mode) {
    this.setMix({ channel: mode, vocals: null, lead: 0 });
  }

  /**
   * The channel mode, or on a multiplex track (`vocals` adjustable) the guide singer's level:
   * the four gains glide together, so the music level never dips.
   */
  setMix({ channel = 'stereo', vocals = null, lead = 0 } = {}) {
    this.mix = { channel, vocals, lead };
    if (!this.matrix) return;
    const m = mixMatrix(this.mix);
    const t = this.ctx.currentTime;
    this.matrix.forEach((g, i) => g.gain.setTargetAtTime(m[i], t, 0.02));
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.03);
  }

  setNormalize(on) {
    this.normalize = !!on;
    this.applyTrackGain();
  }

  applyTrackGain() {
    if (!this.trackGain) return;
    const db = this.normalize && this.track ? this.track.gainDb : 0;
    this.trackGain.gain.setTargetAtTime(10 ** (db / 20), this.ctx.currentTime, 0.05);
  }

  rampFade(to, seconds, at = this.ctx.currentTime) {
    const g = this.fadeGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (at > now) g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(to, Math.max(at, now) + seconds);
  }

  /** Fades out over `seconds`, then pauses. */
  async fadeOut(seconds = 1.5) {
    if (!this.playing) return;
    this.rampFade(0, seconds);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    this.pause();
  }

  checkEnd() {
    if (!this.track || this.ended || this.track.mode === 'element') return;
    if (this.map.active && this.position >= this.track.duration - 0.03) this.finish();
  }

  finish() {
    if (this.ended || !this.track) return;
    this.ended = true;
    if (this.track.mode !== 'element' && this.map.active) {
      this.stretch.schedule({ active: false, output: this.ctx.currentTime });
      this.map = { active: false, input: this.track.duration, output: 0, rate: this.rate };
    }
    this.emit('ended', { id: this.track.id });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** 0..1 energy of the music right now (for visualisers). */
  level() {
    if (!this.analyser) return 0;
    const data = this.levelBuf ||= new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 2; i < 96; i++) sum += data[i];
    return sum / (94 * 255);
  }
}

function sameChannels(a, b) {
  const step = Math.max(1, Math.floor(a.length / 5000));
  for (let i = 0; i < a.length; i += step) if (Math.abs(a[i] - b[i]) > 1e-4) return false;
  return true;
}

/**
 * Gain (dB) that brings the track to about −16 LUFS: gated mean-square loudness over
 * 400 ms blocks (absolute gate −70 dB, relative gate −10 dB), clamped to ±9 dB.
 */
export function loudnessGainDb(channels, target = -16) {
  const n = channels[0]?.length || 0;
  const block = 17640; // 400 ms at 44.1 kHz (close enough at 48 kHz)
  const energies = [];
  for (let start = 0; start + block <= n; start += block) {
    let sum = 0;
    for (const ch of channels) for (let i = start; i < start + block; i += 3) sum += ch[i] * ch[i];
    energies.push(sum / ((block / 3) * channels.length));
  }
  const gated = energies.filter((e) => e > 1e-7);
  if (!gated.length) return 0;
  const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
  const loud = gated.filter((e) => e > mean * 0.1);
  const m = loud.reduce((a, b) => a + b, 0) / loud.length;
  const lufs = -0.691 + 10 * Math.log10(m);
  return clamp(target - lufs, -9, 9);
}
