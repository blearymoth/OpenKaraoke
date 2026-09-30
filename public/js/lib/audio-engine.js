// Web Audio playback engine for the TV (PLAN §9.3).
//
// buffer mode (CDG tracks): fetch + decodeAudioData → Signalsmith Stretch (key + tempo)
// element mode (video / fallback): <video>/<audio> → MediaElementSource → (stretch live for key)
// Both → 2×2 channel matrix → track gain (loudness) → fade gain → master → destination.
import SignalsmithStretch from '/js/vendor/signalsmith-stretch.mjs';

const MATRIX = {
  // [L→L, L→R, R→L, R→R]
  stereo: [1, 0, 0, 1],
  left: [1, 1, 0, 0],
  right: [0, 0, 1, 1],
  mono: [0.5, 0.5, 0.5, 0.5],
  vocalcut: [1, 1, -1, -1], // L−R on both sides removes centre-panned vocals
};

const TARGET_DB = -17; // RMS target (≈ −16 LUFS for typical backing tracks)
const START_DELAY = 0.06;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stretch = null;
    this.liveStretch = null;
    this.mode = 'none'; // none | buffer | element
    this.duration = 0;
    this.playing = false;
    this.key = 0;
    this.tempo = 1;
    this.channel = 'stereo';
    this.volume = 0.9;
    this.normalize = true;
    this.trackGainDb = 0;
    this.anchor = { output: 0, input: 0, rate: 1 };
    this.pausedAt = 0;
    this.endedFired = false;
    this.onended = null;
    this.element = null;
    this.elementSource = null;
    this._tick = null;
    this._loadSeq = 0;
  }

  async init() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.stretch = await SignalsmithStretch(ctx);
    this.input = ctx.createGain();
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.matrix = [0, 1, 2, 3].map(() => ctx.createGain());
    const [ll, lr, rl, rr] = this.matrix;
    this.input.connect(this.splitter);
    this.splitter.connect(ll, 0); ll.connect(this.merger, 0, 0);
    this.splitter.connect(lr, 0); lr.connect(this.merger, 0, 1);
    this.splitter.connect(rl, 1); rl.connect(this.merger, 0, 0);
    this.splitter.connect(rr, 1); rr.connect(this.merger, 0, 1);
    this.trackGain = ctx.createGain();
    this.fade = ctx.createGain();
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.merger.connect(this.trackGain);
    this.trackGain.connect(this.fade);
    this.fade.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.stretch.connect(this.input);
    this.setChannel(this.channel);
    this.setVolume(this.volume);
    this._tick = setInterval(() => this._checkEnded(), 100);
  }

  get unlocked() { return this.ctx?.state === 'running'; }

  async unlock() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
    return this.unlocked;
  }

  /** Output latency of the sound card path (s). */
  get latency() {
    return (this.ctx?.outputLatency || 0) + (this.ctx?.baseLatency || 0);
  }

  /** Fetches + decodes an audio file. Returns { buffer, gainDb }. */
  async decode(url, { signal } = {}) {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    const data = await res.arrayBuffer();
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const buffer = await this.ctx.decodeAudioData(data);
    return { buffer, gainDb: loudnessGain(buffer) };
  }

  /** Makes a decoded buffer the current track (stopped at 0). */
  async useBuffer(decoded) {
    const seq = ++this._loadSeq;
    this.stopNow();
    this._detachElement();
    await this.stretch.dropBuffers();
    if (seq !== this._loadSeq) return false;
    const b = decoded.buffer;
    const L = new Float32Array(b.getChannelData(0));
    const R = new Float32Array(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0));
    await this.stretch.addBuffers([L, R], [L.buffer, R.buffer]);
    if (seq !== this._loadSeq) return false;
    this.mode = 'buffer';
    this.duration = b.duration;
    this.trackGainDb = decoded.gainDb;
    this._applyTrackGain();
    this.pausedAt = 0;
    this.endedFired = false;
    return true;
  }

  /** Uses a media element (video, or audio fallback) as the source. */
  async useElement(el, { gainDb = 0 } = {}) {
    ++this._loadSeq;
    this.stopNow();
    await this.stretch.dropBuffers();
    this._detachElement();
    this.element = el;
    if (!el._okSource) el._okSource = this.ctx.createMediaElementSource(el);
    this.elementSource = el._okSource;
    this.mode = 'element';
    this.duration = el.duration || 0;
    this.trackGainDb = gainDb;
    this._applyTrackGain();
    this.pausedAt = 0;
    this.endedFired = false;
    el.preservesPitch = true;
    el.playbackRate = this.tempo;
    await this._routeElement();
    return true;
  }

  async _routeElement() {
    const src = this.elementSource;
    if (!src) return;
    try { src.disconnect(); } catch { /* not connected */ }
    if (this.key !== 0) {
      if (!this.liveStretch) {
        this.liveStretch = await SignalsmithStretch(this.ctx);
        this.liveStretch.connect(this.input);
      }
      src.connect(this.liveStretch);
      this.liveStretch.schedule({ active: true, rate: 1, semitones: this.key, output: this.ctx.currentTime });
    } else {
      src.connect(this.input);
      this.liveStretch?.schedule({ active: false, output: this.ctx.currentTime });
    }
  }

  _detachElement() {
    if (this.elementSource) {
      try { this.elementSource.disconnect(); } catch { /* ignore */ }
    }
    if (this.element) {
      this.element.pause();
    }
    this.liveStretch?.schedule({ active: false, output: this.ctx.currentTime });
    this.element = null;
    this.elementSource = null;
  }

  unload() {
    ++this._loadSeq;
    this.stopNow();
    this._detachElement();
    this.stretch?.dropBuffers();
    this.mode = 'none';
    this.duration = 0;
    this.pausedAt = 0;
  }

  /** Audible position within the track (s). */
  get position() {
    if (this.mode === 'element') return this.element ? this.element.currentTime : 0;
    if (!this.playing) return this.pausedAt;
    const t = this.ctx.currentTime - this.latency;
    const a = this.anchor;
    const pos = a.input + Math.max(0, t - a.output) * a.rate;
    return Math.min(pos, this.duration);
  }

  /** Input position that will be heard at context time `t` (ignores sound-card latency). */
  _inputAt(t) {
    const a = this.anchor;
    return a.input + Math.max(0, t - a.output) * a.rate;
  }

  play(from = this.position) {
    if (this.mode === 'none') return;
    this.endedFired = false;
    if (this.mode === 'element') {
      if (Math.abs(this.element.currentTime - from) > 0.3) this.element.currentTime = from;
      this._fadeTo(1, 0.08);
      this.element.play().catch((e) => console.warn('play failed', e));
      this.playing = true;
      return;
    }
    const now = this.ctx.currentTime;
    const t0 = now + START_DELAY;
    const input = Math.max(0, Math.min(from, this.duration));
    this.anchor = { output: t0, input, rate: this.tempo };
    this.stretch.schedule({ active: true, output: t0, input, rate: this.tempo, semitones: this.key });
    this.fade.gain.cancelScheduledValues(now);
    this.fade.gain.setValueAtTime(0, now);
    this.fade.gain.linearRampToValueAtTime(1, t0 + 0.08);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    const pos = this.position;
    if (this.mode === 'element') {
      this._fadeTo(0, 0.06);
      const el = this.element;
      setTimeout(() => el?.pause(), 70);
      this.playing = false;
      this.pausedAt = pos;
      return;
    }
    const now = this.ctx.currentTime;
    this._fadeTo(0, 0.06);
    this.stretch.schedule({ active: false, output: now + 0.07 });
    this.playing = false;
    this.pausedAt = pos;
  }

  stopNow() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.fade.gain.cancelScheduledValues(now);
    this.fade.gain.setValueAtTime(0, now);
    this.stretch?.schedule({ active: false, output: now });
    if (this.element) this.element.pause();
    this.playing = false;
  }

  seek(pos) {
    pos = Math.max(0, Math.min(pos, this.duration || pos));
    this.endedFired = false;
    if (this.mode === 'element') {
      this.element.currentTime = pos;
      this.pausedAt = pos;
      return;
    }
    if (this.playing) {
      this._fadeTo(0, 0.03);
      const now = this.ctx.currentTime;
      const t0 = now + 0.04;
      this.anchor = { output: t0, input: pos, rate: this.tempo };
      this.stretch.schedule({ active: true, output: t0, input: pos, rate: this.tempo, semitones: this.key });
      this.fade.gain.linearRampToValueAtTime(1, t0 + 0.06);
    } else {
      this.pausedAt = pos;
    }
  }

  /** Re-anchors the time map at a point slightly in the future with new rate/key. */
  _reschedule() {
    if (this.mode !== 'buffer' || !this.playing) return;
    const t = this.ctx.currentTime + 0.05;
    const input = this._inputAt(t);
    this.anchor = { output: t, input, rate: this.tempo };
    this.stretch.schedule({ active: true, output: t, input, rate: this.tempo, semitones: this.key });
  }

  setKey(semitones) {
    const k = Math.round(semitones) || 0;
    if (k === this.key) return;
    this.key = k;
    if (this.mode === 'element') this._routeElement();
    else this._reschedule();
  }

  setTempo(rate) {
    const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
    if (r === this.tempo) return;
    this.tempo = r;
    if (this.mode === 'element' && this.element) this.element.playbackRate = r;
    else this._reschedule();
  }

  setChannel(mode) {
    const m = MATRIX[mode] ? mode : 'stereo';
    this.channel = m;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    MATRIX[m].forEach((g, i) => this.matrix[i].gain.setTargetAtTime(g, now, 0.03));
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v)));
    if (!this.ctx) return;
    // perceptual curve
    this.master.gain.setTargetAtTime(this.volume ** 2, this.ctx.currentTime, 0.05);
  }

  setNormalize(on) {
    this.normalize = !!on;
    this._applyTrackGain();
  }

  _applyTrackGain() {
    if (!this.ctx) return;
    const db = this.normalize ? this.trackGainDb : 0;
    this.trackGain.gain.setTargetAtTime(10 ** (db / 20), this.ctx.currentTime, 0.05);
  }

  _fadeTo(v, sec) {
    const now = this.ctx.currentTime;
    const g = this.fade.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v, now + sec);
  }

  /** Fades out over `sec` seconds (resolves when silent). */
  fadeOut(sec = 1.5) {
    if (!this.playing) return Promise.resolve();
    this._fadeTo(0, sec);
    return new Promise((r) => setTimeout(r, sec * 1000));
  }

  _checkEnded() {
    if (!this.playing || this.endedFired) return;
    const ended = this.mode === 'element' ? this.element?.ended : this.duration > 0 && this.position >= this.duration - 0.05;
    if (ended) {
      this.endedFired = true;
      this.stopNow();
      this.pausedAt = this.duration;
      this.onended?.();
    }
  }

  /** 0..1 loudness of the current output (for visualisers / applause meters). */
  level() {
    if (!this.analyser) return 0;
    const buf = this._lvl || (this._lvl = new Float32Array(this.analyser.fftSize));
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) sum += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(sum / (buf.length / 4)) * 3);
  }
}

/** Gain (dB) that brings the track's RMS to the target, clamped to ±9 dB. */
export function loudnessGain(buffer) {
  let sum = 0;
  let n = 0;
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 16) { sum += d[i] * d[i]; n++; }
  }
  if (!n || sum === 0) return 0;
  const rmsDb = 10 * Math.log10(sum / n);
  return Math.max(-9, Math.min(9, TARGET_DB - rmsDb));
}
