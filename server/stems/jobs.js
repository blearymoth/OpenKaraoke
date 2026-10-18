// Stem cache and one-at-a-time separation jobs, under the data folder (never the music drive):
// data/stems/<trackId>/vocal.wav and music.wav (the rest). A multiplex track's vocal is for the
// headphone preview (its music isn't needed); any other track is separated only when the host
// asks, and needs both files (the room then plays music + vocal at a level — PLAN §30).
import fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../util/log.js';

const log = logger('stems');
const ID = /^[A-Za-z0-9_-]{4,64}$/;

/** Absolute directory for one track's vocal stem, or null when the id could leave the data folder. */
export function stemTrackDir(dataDir, trackId) {
  if (typeof trackId !== 'string' || !ID.test(trackId)) return null;
  const root = path.resolve(dataDir, 'stems');
  const dir = path.resolve(root, trackId);
  if (dir !== path.join(root, trackId)) return null;
  return dir;
}

export class StemJobs {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {Function|null} opts.run  async ({ src, vocal, music, trackId, onChild }) — null disables jobs
   * @param {(trackId: string) => boolean} opts.allowed  multiplex tracks, and those the host asked for
   * @param {(trackId: string) => boolean} [opts.needsMusic]  music.wav must be there too (not multiplex)
   * @param {(trackId: string) => Promise<string|null>} opts.sourceOf  absolute audio path in the library, or a copy under the data folder
   * @param {(trackId: string, state: object) => void} [opts.onChange]
   */
  constructor({ dataDir, run, allowed, sourceOf, onChange, needsMusic = () => false }) {
    this.dataDir = dataDir;
    this.run = typeof run === 'function' ? run : null;
    this.allowed = allowed;
    this.needsMusic = needsMusic;
    this.sourceOf = sourceOf;
    this.onChange = onChange || (() => {});
    this.memory = new Map();
    this.queue = [];
    this.running = null;
    this.child = null;
    this.pumping = false;
    this.closed = false;
  }

  get enabled() {
    return !!this.run;
  }

  /** { status, gen, error } or a quiet idle when this track has not been asked yet. */
  view(trackId) {
    return this.memory.get(trackId) || { status: 'idle', gen: 0, error: '' };
  }

  /** vocal.wav (or `name`: music.wav) inside the cache, or null. Does not check that the file exists. */
  file(trackId, name = 'vocal.wav') {
    const dir = stemTrackDir(this.dataDir, trackId);
    if (!dir) return null;
    return path.join(dir, name);
  }

  publish(trackId, patch) {
    const prev = this.memory.get(trackId) || { status: 'idle', gen: 0, error: '' };
    const next = { ...prev, ...patch };
    if (patch.status === 'ready' && prev.status !== 'ready') next.gen = prev.gen + 1;
    if (patch.status !== 'failed') next.error = patch.error || '';
    const same = prev.status === next.status && prev.gen === next.gen && prev.error === next.error;
    this.memory.set(trackId, next);
    if (!same) this.onChange(trackId, next);
  }

  /** The stems a track needs are on disk: the vocal, and the music unless it is multiplex. */
  async filesReady(trackId) {
    const ok = async (name) => {
      const file = this.file(trackId, name);
      if (!file) return false;
      try {
        const st = await fs.stat(file);
        return st.isFile() && st.size >= 45;
      } catch {
        return false;
      }
    };
    return (await ok('vocal.wav')) && (!this.needsMusic(trackId) || (await ok('music.wav')));
  }

  /** Start separation unless this track is not multiplex, already cached, or already queued. */
  async ensure(trackId) {
    if (!stemTrackDir(this.dataDir, trackId) || this.closed) return;
    if (await this.filesReady(trackId)) { // (separated before: usable even with the separator gone)
      this.publish(trackId, { status: 'ready' });
      return;
    }
    if (!this.run) return;
    if (!this.allowed(trackId)) {
      this.publish(trackId, { status: 'skipped' });
      return;
    }
    const cur = this.memory.get(trackId);
    if (cur?.status === 'separating' || cur?.status === 'failed') return;
    if (this.running === trackId || this.queue.includes(trackId)) return;
    this.queue.push(trackId);
    this.publish(trackId, { status: 'separating' });
    void this.pump();
  }

  /** Forget a failed attempt and run again. A job that is already running is left alone. */
  async retry(trackId) {
    if (!this.run || this.closed || this.running === trackId) return;
    this.queue = this.queue.filter((id) => id !== trackId);
    this.memory.delete(trackId);
    const dir = stemTrackDir(this.dataDir, trackId);
    if (dir) {
      await Promise.all(['vocal.wav', 'vocal.wav.part', 'music.wav', 'music.wav.part'].map((name) => fs.rm(path.join(dir, name), { force: true })));
    }
    await this.ensure(trackId);
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        const trackId = this.queue.shift();
        this.running = trackId;
        try {
          if (!this.allowed(trackId)) {
            this.publish(trackId, { status: 'skipped' });
            continue;
          }
          if (await this.filesReady(trackId)) {
            this.publish(trackId, { status: 'ready' });
            continue;
          }
          const src = await this.sourceOf(trackId);
          if (!src) throw new Error('This track has no audio file to separate');
          const dir = stemTrackDir(this.dataDir, trackId);
          await fs.mkdir(dir, { recursive: true });
          const vocal = path.join(dir, 'vocal.wav');
          const music = path.join(dir, 'music.wav');
          await this.run({
            src, vocal, music, trackId, onChild: (child) => { this.child = child; },
          });
          if (this.closed) return;
          if (!(await this.filesReady(trackId))) throw new Error('Separator finished without the stems');
          await this.removeSource(dir);
          this.publish(trackId, { status: 'ready' });
        } catch (e) {
          if (!this.closed) {
            log.info(`could not separate ${trackId}: ${e.message}`);
            this.publish(trackId, { status: 'failed', error: 'Could not separate the vocals.' });
          }
        } finally {
          this.child = null;
          this.running = null;
        }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length && !this.closed) void this.pump();
    }
  }

  async removeSource(dir) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.startsWith('source.')).map((n) => fs.rm(path.join(dir, n), { force: true })));
  }

  /** The same file got a new track id (a library folder was split or folded). The cache moves with it. */
  rekey(moves) {
    const list = (Array.isArray(moves) ? moves : []).filter((m) => m && m.from !== m.to);
    let n = 0;
    for (const m of list) {
      const from = stemTrackDir(this.dataDir, m.from);
      const to = stemTrackDir(this.dataDir, m.to);
      if (!from || !to) continue;
      try {
        fsRename(from, to);
      } catch (e) {
        if (e.code !== 'ENOENT') log.info(`could not move stems ${m.from} → ${m.to}: ${e.message}`);
        continue;
      }
      const mem = this.memory.get(m.from);
      if (mem) {
        this.memory.delete(m.from);
        this.memory.set(m.to, mem);
      }
      n++;
    }
    return n;
  }

  close() {
    this.closed = true;
    this.queue = [];
    if (this.child && this.child.exitCode == null && this.child.signalCode == null) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}

function fsRename(from, to) {
  renameSync(from, to);
}
