// Keeps the TV's local playback in line with the server's desired player state.
// The server is authoritative for *what* plays and play/pause/key/tempo;
// the main display is authoritative for media time (it reports position ~4×/s).
import { AudioEngine } from '/js/lib/audio-engine.js';
import { CdgView } from '/js/lib/cdg-canvas.js';
import { createStore } from '/js/lib/store.js';

export class TvPlayer {
  constructor({ conn, canvas, video }) {
    this.conn = conn;
    this.engine = new AudioEngine();
    this.cdg = new CdgView(canvas);
    this.video = video;
    this.tv = null;
    this.entryId = null;
    this.media = null;
    this.ready = false;
    this.lastSeekSeq = 0;
    this.preloaded = new Map(); // entryId -> Promise<{ decoded, cdg }>
    this.mirrorTime = null; // { pos, at, playing }
    this.status = createStore({ loading: false, error: null, playing: false, entryId: null, kind: null });
    this._loadSeq = 0;
    this._lastReport = 0;
    this.lyricOffset = 0;
  }

  async init() {
    await this.engine.init();
    this.engine.onended = () => {
      if (this.isMain && this.entryId) this.conn.send('tv.ended', { entryId: this.entryId });
      this.status.set({ playing: false });
    };
    this.conn.on('time', (m) => {
      if (!this.isMain) this.mirrorTime = { pos: m.pos, at: m.at, playing: m.playing, entryId: m.entryId };
    });
    setInterval(() => this.report(), 250);
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get isMain() { return !!this.tv?.main; }

  /** Current song position (s), from the engine (main) or estimated from time messages (mirror). */
  get position() {
    if (this.isMain) return this.engine.position;
    const m = this.mirrorTime;
    if (!m || m.entryId !== this.entryId) return 0;
    const tempo = this.tv?.player?.tempo || 1;
    return m.pos + (m.playing ? Math.max(0, (this.conn.now() - m.at) / 1000) * tempo : 0);
  }

  get duration() {
    return this.engine.duration || this.tv?.current?.dur || 0;
  }

  apply(tv) {
    const wasMain = this.isMain;
    this.tv = tv;
    const d = tv.display || {};
    this.cdg.setOptions({ smoothing: d.cdgSmoothing !== false, transparent: d.cdgTransparent !== false });
    this.lyricOffset = (tv.playback?.lyricOffsetMs || 0) / 1000;
    this.engine.setNormalize(tv.playback?.normalize !== false);
    const cur = tv.current;
    if ((cur?.id || null) !== this.entryId || wasMain !== this.isMain) {
      this.load(cur);
      return;
    }
    if (this.ready) this.sync();
    this.maybePreload();
  }

  async load(entry) {
    const seq = ++this._loadSeq;
    this.entryId = entry?.id || null;
    this.media = entry?.media || null;
    this.ready = false;
    this.engine.stopNow();
    this.cdg.clear();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.status.set({ loading: !!entry, error: null, playing: false, entryId: this.entryId, kind: this.media?.kind || null });
    if (!entry) {
      this.engine.unload();
      return;
    }
    try {
      if (this.media.kind === 'video') {
        await this.loadVideo(this.media.video, seq);
      } else if (this.isMain) {
        const pre = this.preloaded.get(entry.id);
        this.preloaded.delete(entry.id);
        const { decoded, cdg } = await (pre || this.fetchCdgTrack(this.media));
        if (seq !== this._loadSeq) return;
        const ok = await this.engine.useBuffer(decoded);
        if (!ok || seq !== this._loadSeq) return;
        this.cdg.load(cdg);
      } else {
        // mirror: graphics only
        const cdg = await fetchBytes(this.media.cdg);
        if (seq !== this._loadSeq) return;
        this.cdg.load(cdg);
      }
      this.preloaded.clear();
      this.ready = true;
      const p = this.tv.player;
      this.lastSeekSeq = p.seekSeq;
      if (this.isMain && p.position > 1) this.engine.seek(p.position);
      this.status.set({ loading: false });
      this.sync();
    } catch (e) {
      if (seq !== this._loadSeq || e.name === 'AbortError') return;
      console.error('load failed', e);
      this.status.set({ loading: false, error: e.message || String(e) });
      if (this.isMain) this.conn.send('tv.error', { entryId: entry.id, error: e.message || String(e) });
    }
  }

  async fetchCdgTrack(media) {
    const [decoded, cdg] = await Promise.all([this.engine.decode(media.audio), fetchBytes(media.cdg)]);
    return { decoded, cdg };
  }

  async loadVideo(url, seq) {
    const v = this.video;
    v.muted = !this.isMain;
    v.src = url;
    v.preload = 'auto';
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error(v.error?.message || 'This video format cannot be played in the browser')); };
      const cleanup = () => { v.removeEventListener('canplay', ok); v.removeEventListener('error', bad); };
      v.addEventListener('canplay', ok);
      v.addEventListener('error', bad);
    });
    if (seq !== this._loadSeq) return;
    if (this.isMain) await this.engine.useElement(v);
    v.onended = () => this.engine.onended?.();
  }

  /** Applies play/pause/seek/key/tempo/channel/volume from the server state. */
  sync() {
    const p = this.tv?.player;
    if (!p || !this.ready) return;
    const e = this.engine;
    if (!this.isMain) {
      // mirrors: the video (if any) follows the reported time, muted
      if (this.media?.kind === 'video') {
        const want = this.position;
        if (Math.abs(this.video.currentTime - want) > 0.5) this.video.currentTime = want;
        if (p.state === 'playing' && this.video.paused) this.video.play().catch(() => {});
        if (p.state !== 'playing' && !this.video.paused) this.video.pause();
      }
      return;
    }
    e.setKey(p.key || 0);
    e.setTempo(p.tempo || 1);
    e.setChannel(p.channel || 'stereo');
    e.setVolume(p.volume ?? 0.9);
    if (p.seekSeq !== this.lastSeekSeq) {
      this.lastSeekSeq = p.seekSeq;
      e.seek(p.seekPos || 0);
    }
    if (p.state === 'playing' && !e.playing && !e.endedFired) e.play();
    else if (p.state !== 'playing' && e.playing) e.pause();
    this.status.set({ playing: p.state === 'playing' });
  }

  /** Decodes the next song while the current one is ending. */
  maybePreload() {
    if (!this.isMain || !this.ready) return;
    const next = this.tv?.next?.[0];
    if (!next?.media || next.media.kind !== 'cdg' || this.preloaded.has(next.id)) return;
    const remaining = this.duration - this.engine.position;
    if (remaining > 45) return;
    const job = this.fetchCdgTrack(next.media).catch(() => null);
    this.preloaded.set(next.id, job.then((r) => r || this.fetchCdgTrack(next.media)));
  }

  report() {
    if (!this.isMain || !this.entryId || !this.ready) return;
    const now = performance.now();
    if (now - this._lastReport < 200) return;
    this._lastReport = now;
    this.conn.send('tv.status', { entryId: this.entryId, pos: Math.round(this.engine.position * 100) / 100, dur: this.engine.duration, playing: this.engine.playing });
    this.maybePreload();
  }

  frame() {
    if (!this.ready || this.media?.kind === 'video') return;
    this.cdg.render(this.position + this.lyricOffset);
  }

  unlock() {
    return this.engine.unlock();
  }
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.arrayBuffer();
}
