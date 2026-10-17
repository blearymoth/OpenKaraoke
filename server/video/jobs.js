// Converted videos (server/video/ffmpeg.js) in the data folder, never on the music drive:
// data/video/<trackId>-<size and date>.webm, so a changed file is converted again. One conversion
// at a time, the song on stage first; the oldest conversions go when the folder grows too big.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash32 } from '../../shared/text.js';
import { logger } from '../util/log.js';
import { INSTALL_HINT, needsConversion } from './ffmpeg.js';

const log = logger('video');
const ID = /^[A-Za-z0-9_-]{4,64}$/;
export const CACHE_MAX_BYTES = 10 * 1024 ** 3; // 10 GB: a few hundred converted songs

export class VideoJobs {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {{ detect: Function, run: Function } | null} opts.tool ffmpeg (ffmpegTool) or a fake; null: none
   * @param {(track: object) => string | null} opts.sourceOf the video file's absolute path
   * @param {(trackId: string, view: object) => void} [opts.onChange]
   * @param {number} [opts.maxBytes]
   */
  constructor({ dataDir, tool, sourceOf, onChange, maxBytes = CACHE_MAX_BYTES }) {
    this.dir = path.join(dataDir, 'video');
    this.tool = tool || null;
    this.sourceOf = sourceOf;
    this.onChange = onChange || (() => {});
    this.maxBytes = maxBytes;
    this.memory = new Map(); // trackId → { key, status, progress, error }
    this.queue = []; // tracks waiting, the next one first
    this.running = null;
    this.child = null;
    this.pumping = false;
    this.closed = false;
    this.info = null; // what detect() found: { version, encoders } or { missing }
    this.detecting = null;
  }

  /** Whether ffmpeg is there (looked for once, on first need). */
  async detect() {
    if (this.info) return this.info;
    this.detecting ||= (this.tool ? this.tool.detect() : Promise.resolve({ missing: 'not set up' }))
      .catch((e) => ({ missing: e.message || 'ffmpeg could not be started' }))
      .then((info) => {
        this.info = info;
        log.info(info.missing ? `no video conversion: ${info.missing}` : `video conversion with ffmpeg ${info.version} (${info.encoders.video}, ${info.encoders.audio})`);
        return info;
      });
    return this.detecting;
  }

  /** For the host's settings: { ready: bool, version, missing, hint }. */
  status() {
    if (!this.info) return { ready: null };
    return this.info.missing ? { ready: false, missing: this.info.missing, hint: INSTALL_HINT } : { ready: true, version: this.info.version };
  }

  key(track) {
    if (!track || typeof track.id !== 'string' || !ID.test(track.id)) return null;
    return `${track.id}-${hash32(`${track.size || 0}:${track.mtime || 0}:${track.video || ''}`).toString(36)}`;
  }

  /** The converted file's path (it may not exist yet), or null. */
  file(track) {
    const key = this.key(track);
    return key ? path.join(this.dir, `${key}.webm`) : null;
  }

  /** { status: idle | queued | converting | ready | failed | unavailable, progress, error }. */
  view(track) {
    const m = track && this.memory.get(track.id);
    return m && m.key === this.key(track) ? m : { status: 'idle', progress: 0, error: '' };
  }

  publish(track, patch) {
    const prev = this.view(track);
    const next = { key: this.key(track), status: prev.status, progress: prev.progress || 0, error: '', ...patch };
    this.memory.set(track.id, next);
    if (prev.status !== next.status || prev.error !== next.error || Math.abs((prev.progress || 0) - next.progress) >= 0.05) this.onChange(track.id, next);
  }

  /** The converted file when it is there (touched: recently played videos are kept longest), else null. */
  async readyFile(track) {
    const file = this.file(track);
    if (!file) return null;
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size < 100) return null;
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => {});
      return file;
    } catch {
      return null;
    }
  }

  /**
   * Converts a track's video unless it is already converted, queued or failed. `urgent` (the song
   * on stage) goes first. Tracks that need no converting are left alone.
   */
  async ensure(track, { urgent = false } = {}) {
    if (this.closed || !track || track.kind !== 'video' || !needsConversion(track.video) || !this.key(track)) return;
    const cur = this.view(track);
    if (cur.status === 'queued' || cur.status === 'converting') {
      if (urgent && cur.status === 'queued') this.queue = [track, ...this.queue.filter((t) => t.id !== track.id)];
      return;
    }
    if (cur.status !== 'idle') return; // ready, failed or unavailable: settled
    this.publish(track, { status: 'queued', progress: 0 });
    const info = await this.detect();
    if (this.closed) return;
    if (info.missing) {
      this.publish(track, { status: 'unavailable', error: `This video needs ffmpeg. ${INSTALL_HINT}` });
      return;
    }
    if (await this.readyFile(track)) {
      this.publish(track, { status: 'ready', progress: 1 });
      return;
    }
    if (this.closed || this.view(track).status !== 'queued') return;
    if (urgent) this.queue.unshift(track);
    else this.queue.push(track);
    void this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        const track = this.queue.shift();
        if (this.view(track).status !== 'queued') continue;
        this.running = track.id;
        const file = this.file(track);
        const part = `${file}.part`;
        try {
          const src = this.sourceOf(track);
          if (!src) throw new Error('The video file isn’t in the library any more');
          await fs.mkdir(this.dir, { recursive: true });
          this.publish(track, { status: 'converting', progress: 0 });
          const t0 = Date.now();
          await this.tool.run({
            src,
            out: part,
            onProgress: (f) => this.publish(track, { status: 'converting', progress: f }),
            onChild: (child) => { this.child = child; },
          });
          if (this.closed) return;
          await fs.rename(part, file);
          log.info(`converted ${track.video} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          this.publish(track, { status: 'ready', progress: 1 });
          await this.trim(file);
        } catch (e) {
          await fs.rm(part, { force: true }).catch(() => {});
          if (!this.closed) {
            log.warn(`could not convert ${track.video}: ${e.message}`);
            this.publish(track, { status: 'failed', error: `This video could not be converted (${String(e.message || e).slice(0, 160)}).` });
          }
        } finally {
          this.child = null;
          this.running = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Keeps the folder under maxBytes: the least recently played conversions go first, never `keep`. */
  async trim(keep) {
    let names = [];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.webm'));
    } catch {
      return;
    }
    const files = [];
    for (const n of names) {
      const f = path.join(this.dir, n);
      const st = await fs.stat(f).catch(() => null);
      if (st?.isFile()) files.push({ f, size: st.size, at: st.mtimeMs });
    }
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files.sort((a, b) => a.at - b.at)) {
      if (total <= this.maxBytes) break;
      if (x.f === keep) continue;
      await fs.rm(x.f, { force: true }).catch(() => {});
      total -= x.size;
      for (const [id, m] of this.memory) if (path.join(this.dir, `${m.key}.webm`) === x.f) this.memory.delete(id);
    }
  }

  close() {
    this.closed = true;
    this.queue = [];
    if (this.child && this.child.exitCode == null && this.child.signalCode == null) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}
