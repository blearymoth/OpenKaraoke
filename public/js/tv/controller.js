// Keeps the TV's local playback in step with the party state from the server.
// The server decides WHAT plays and whether it should be playing; this display decides
// WHEN (it owns the media clock) and reports its position back (PLAN §3, §6.2).
import { AudioEngine } from '../lib/audio-engine.js';
import { CdgRenderer } from '../lib/cdg-canvas.js';

export class TvController extends EventTarget {
  constructor({ conn, canvas, video, audio }) {
    super();
    this.conn = conn;
    this.engine = new AudioEngine();
    this.cdg = new CdgRenderer(canvas);
    this.video = video;
    this.audio = audio;
    this.display = 'main';
    this.state = null;
    this.entryId = null;
    this.kind = null; // 'cdg' | 'video'
    this.loaded = false;
    this.error = null;
    this.seekSeq = null;
    this.readySent = null;
    this.mirror = null; // { pos, at, playing }
    this.cdgCache = new Map();
    this.loadedTrackId = null;
    this.reloadSeen = null;
    this.gameAudio = null; // { key, tempo, channel } while a game plays clips and no song is on
    this.engine.addEventListener('ended', (e) => {
      // Only the track this entry loaded may end it (a late event from an old track must not).
      if (this.display === 'main' && this.entryId && this.loaded && e.detail?.id === this.loadedTrackId) {
        this.conn.sendReliable('tv.ended', { entryId: this.entryId });
      }
    });
    this.engine.addEventListener('error', (e) => this.fail(e.detail?.error || 'Playback failed'));
    setInterval(() => this.report(), 250);
  }

  /** After every (re)connect the server has forgotten that we're ready: tell it again. */
  onWelcome() {
    this.readySent = null;
    this.lastReportPaused = false;
    this.audioSent = null;
    this.reportAudio();
    this.sendReady();
  }

  /** Lets the host know when this screen still needs a click before it can play sound. */
  reportAudio() {
    if (this.display !== 'main') return;
    const unlocked = this.engine.running;
    if (unlocked === this.audioSent) return;
    this.audioSent = unlocked;
    this.conn.send('tv.audio', { unlocked });
  }

  get unlocked() {
    return this.engine.running;
  }

  /** Must run inside a click/keypress (browser autoplay rules). */
  async unlock() {
    await this.engine.unlock();
    this.sendReady();
    if (this.state) this.sync(this.state.player);
    this.changed();
    return this.engine.running;
  }

  /** Stops all local playback (this screen was refused); the next apply() loads the song again. */
  stop() {
    this.entryId = null;
    this.loaded = false;
    this.loadedTrackId = null;
    this.readySent = null;
    this.mirror = null;
    this.engine.unload();
    this.cdg.unload();
    this.video.pause();
    this.video.hidden = true;
    this.changed();
  }

  setDisplay(kind) {
    if (kind === this.display) return;
    this.display = kind;
    this.entryId = null; // reload in the new role
    if (this.state) this.apply(this.state);
  }

  apply(state) {
    this.state = state;
    const p = state.player;
    const cur = state.current;
    this.cdg.setOptions({ smoothing: state.display.cdgSmoothing !== false, transparent: state.display.cdgTransparent !== false });
    this.engine.normalize = state.playback.normalize !== false;
    // A game playing its own clips between songs (music quiz) sets key/tempo/channels itself.
    const fx = (!cur && this.gameAudio) || p;
    if (this.engine.ctx) {
      this.engine.setNormalize(state.playback.normalize !== false);
      this.engine.setVolume(this.display === 'main' ? p.volume : 0);
      this.engine.setKey(fx.key);
      this.engine.setTempo(fx.tempo);
      this.engine.setChannelMode(fx.channel);
    } else {
      Object.assign(this.engine, { volume: p.volume, key: p.key, rate: p.tempo, channelMode: p.channel });
    }
    const id = cur?.id || null;
    const reload = cur && this.reloadSeen !== null && p.reload !== this.reloadSeen;
    this.reloadSeen = p.reload ?? 0;
    if (id !== this.entryId || reload) this.load(cur, p);
    else if (this.loaded) this.sync(p);
    this.preloadNext(state);
  }

  async load(cur, p) {
    this.entryId = cur?.id || null;
    this.loaded = false;
    this.loadedTrackId = null;
    this.error = null;
    this.readySent = null;
    this.clipEnding = null;
    this.seekSeq = p.seek?.seq ?? null;
    this.mirror = null;
    this.engine.unload();
    this.cdg.unload();
    this.video.hidden = true;
    this.kind = cur?.media?.kind || null;
    this.changed();
    if (!cur) return;
    const entryId = cur.id;
    try {
      const media = cur.media;
      if (!media) throw new Error('This song is not in the library any more');
      if (media.kind === 'video') {
        this.video.hidden = false;
        this.video.muted = this.display !== 'main';
        if (this.display === 'main') await this.engine.loadElement(cur.trackId, this.video, media.video);
        else this.video.src = media.video;
      } else if (this.display === 'main') {
        const [, bytes] = await Promise.all([
          this.engine.load(cur.trackId, media.audio).catch((e) => {
            if (e.superseded || e.status || this.entryId !== entryId) throw e;
            // The browser couldn't decode the file in one go: stream it through <audio> instead.
            return this.engine.loadElement(cur.trackId, this.audio, media.audio);
          }),
          this.fetchCdg(media.cdg),
        ]);
        if (this.entryId !== entryId) return;
        this.cdg.load(bytes);
      } else {
        const bytes = await this.fetchCdg(media.cdg);
        if (this.entryId !== entryId) return;
        this.cdg.load(bytes);
      }
      if (this.entryId !== entryId) return;
      const start = this.state.player.pos || 0; // resume after a display reconnect
      if (start > 0.5 && this.display === 'main') this.engine.seek(start);
      this.loaded = true;
      this.loadedTrackId = this.display === 'main' ? this.engine.track?.id ?? null : cur.trackId;
      this.sendReady();
      this.sync(this.state.player);
    } catch (e) {
      if (e.superseded || this.entryId !== entryId) return;
      this.fail(e.message);
    }
    this.changed();
  }

  fail(message) {
    this.error = message;
    if (this.display === 'main' && this.entryId) this.conn.sendReliable('tv.error', { entryId: this.entryId, error: message });
    this.changed();
  }

  /** Tells the server the media is ready — only once audio can actually play. */
  sendReady() {
    if (this.display !== 'main' || !this.loaded || !this.entryId || !this.engine.running) return;
    if (this.readySent === this.entryId) return;
    this.readySent = this.entryId;
    this.conn.send('tv.ready', { entryId: this.entryId, dur: this.engine.duration });
  }

  sync(p) {
    if (this.display !== 'main') {
      if (this.kind === 'video') {
        if (p.state === 'playing' && this.video.paused) this.video.play().catch(() => {});
        if (p.state !== 'playing' && !this.video.paused) this.video.pause();
      }
      return;
    }
    if (!this.loaded) return;
    if (p.seek && p.seek.seq !== this.seekSeq) {
      this.seekSeq = p.seek.seq;
      this.engine.seek(p.seek.pos);
    }
    const want = p.state === 'playing' && this.engine.running;
    if (want && !this.engine.playing && !this.engine.ended) this.engine.play();
    else if (!want && this.engine.playing) this.engine.pause();
  }

  onTime(msg) {
    if (msg.entryId !== this.entryId) return;
    this.mirror = { pos: msg.pos, at: performance.now(), playing: msg.playing };
    if (this.display !== 'main' && this.kind === 'video' && Math.abs(this.video.currentTime - msg.pos) > 0.4) this.video.currentTime = msg.pos;
  }

  /** Current song position in seconds (the media clock on the main display, an estimate on mirrors). */
  position() {
    if (!this.entryId) return 0;
    if (this.display === 'main') return this.loaded ? this.engine.position : this.state?.player.pos || 0;
    const m = this.mirror;
    if (!m) return this.state?.player.pos || 0;
    return m.pos + (m.playing ? ((performance.now() - m.at) / 1000) * (this.state?.player.tempo || 1) : 0);
  }

  duration() {
    const dur = (this.loaded && this.display === 'main' ? this.engine.duration : 0) || this.state?.player.dur || this.state?.current?.dur || 0;
    const clipEnd = this.state?.current?.clipEnd;
    return clipEnd ? Math.min(dur || clipEnd, clipEnd) : dur;
  }

  /** Draws the lyrics for the current time (call every animation frame). */
  frame() {
    if (!this.cdg.loaded) return;
    const offset = (this.state?.playback.lyricOffsetMs || 0) / 1000;
    this.cdg.render(this.position() + offset);
  }

  report() {
    if (this.display !== 'main' || !this.loaded || !this.entryId) return;
    this.checkClipEnd();
    const playing = this.engine.playing;
    if (!playing && this.lastReportPaused) return;
    this.lastReportPaused = !playing;
    this.conn.send('tv.status', { entryId: this.entryId, pos: Math.round(this.engine.position * 100) / 100, dur: this.engine.duration, playing });
  }

  /** Song snippets (battle rounds): fade out at `clipEnd` seconds and report the end. */
  checkClipEnd() {
    const clipEnd = this.state?.current?.clipEnd;
    if (!clipEnd || this.clipEnding === this.entryId || !this.engine.playing || this.engine.position < clipEnd) return;
    const id = this.entryId;
    this.clipEnding = id;
    this.engine.fadeOut(2).then(() => {
      if (this.entryId === id) this.conn.sendReliable('tv.ended', { entryId: id });
    });
  }

  preloadNext(state) {
    const next = state.next;
    if (!next?.media || next.media.kind !== 'cdg' || this.display !== 'main' || !this.loaded) return;
    if (this.preloaded === next.trackId) return;
    this.preloaded = next.trackId;
    // Decode while the current song plays so the next intro is instant.
    setTimeout(() => {
      this.engine.prepare(next.trackId, next.media.audio).catch(() => { this.preloaded = null; });
      this.fetchCdg(next.media.cdg).catch(() => {});
    }, 3000);
  }

  fetchCdg(url) {
    if (this.cdgCache.has(url)) return this.cdgCache.get(url);
    const p = fetch(url).then(async (r) => {
      if (!r.ok) {
        let msg = `Could not load the lyrics (HTTP ${r.status})`;
        try {
          msg = (await r.json()).error || msg;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      return new Uint8Array(await r.arrayBuffer());
    });
    this.cdgCache.set(url, p);
    p.catch(() => this.cdgCache.delete(url));
    while (this.cdgCache.size > 3) this.cdgCache.delete(this.cdgCache.keys().next().value);
    return p;
  }

  changed() {
    this.reportAudio();
    this.dispatchEvent(new Event('change'));
  }
}
