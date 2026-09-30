// Library service: owns the catalog, its on-disk cache, background rescans and
// the "is the USB drive plugged in?" watcher.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Catalog, PARSER_VERSION } from './catalog.js';
import { scanLibrary, previousKey } from './scanner.js';
import { readJson, writeJsonAtomic } from '../util/jsonfile.js';
import { hash32 } from '../../shared/text.js';
import { logger } from '../util/log.js';

/** Order independent fingerprint of a track set (detects added/removed/changed files). */
export function trackSignature(tracks, roots = []) {
  let sum = 0;
  let xor = 0;
  let n = 0;
  for (const t of tracks) {
    const s = `${t.root}\u0000${t.dir}\u0000${t.name}\u0000${t.kind}\u0000${t.size}\u0000${t.audio || t.video || t.zip || ''}`;
    sum = (sum + hash32(s)) >>> 0;
    xor = (xor ^ hash32(`#${s}`)) >>> 0;
    n++;
  }
  return `${n}:${sum.toString(36)}:${xor.toString(36)}:${hash32(roots.join('\u0000')).toString(36)}`;
}

export function normalizePaths(list) {
  const out = [];
  for (const p of list || []) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const abs = path.resolve(p.trim());
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export class LibraryService extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {import('../config.js').Settings} o.settings
   */
  constructor({ dataDir, settings, log = logger('library'), watchIntervalMs = 20000 }) {
    super();
    this.settings = settings;
    this.log = log;
    this.cacheFile = path.join(dataDir, 'library.json');
    this.catalog = new Catalog();
    this.signature = '';
    this.online = new Map(); // root path -> boolean
    this.rootCounts = [];
    this.scannedRoots = new Set();
    this.progress = null;
    this.lastScan = null;
    this.watchIntervalMs = watchIntervalMs;
    this._scanning = null;
    this._abort = null;
    this._timer = null;
    this._statusKey = '';
  }

  get paths() {
    return this.settings.get('library.paths') || [];
  }

  get scanning() { return !!this._scanning; }

  /** Loads the cached index, then (optionally) rescans in the background. */
  async init({ scan = this.settings.get('library.rescanOnStart'), watch = true } = {}) {
    const t0 = Date.now();
    const cache = await readJson(this.cacheFile, null);
    const raw = cache ? Catalog.rawFromCache(cache) : null;
    if (raw) {
      const tracks = this._remap(raw, cache.roots || []);
      if (tracks.length) {
        this._load(tracks);
        this.log.info(`loaded ${this.catalog.size} tracks / ${this.catalog.songs.size} songs from cache in ${Date.now() - t0} ms`);
      }
    }
    await this.checkOnline();
    if (watch) this.startWatcher();
    if (scan && this.paths.length) {
      this.scan({ reason: 'startup' }).catch((e) => this.log.error('scan failed', e));
    }
    return this;
  }

  /** Maps cached root indices onto the currently configured paths (drops removed roots). */
  _remap(tracks, fromRoots) {
    const paths = this.paths;
    const out = [];
    for (const t of tracks) {
      const idx = paths.indexOf(fromRoots[t.root]);
      if (idx < 0) continue;
      t.root = idx;
      out.push(t);
    }
    return out;
  }

  _load(tracks) {
    const paths = this.paths;
    this.catalog.load(tracks, [...paths]);
    this.signature = trackSignature(this.catalog.tracks.values(), paths);
    const counts = new Array(paths.length).fill(0);
    for (const t of this.catalog.tracks.values()) counts[t.root]++;
    this.rootCounts = counts;
  }

  /** Starts a rescan, or returns the one already running. */
  scan({ reason = 'manual' } = {}) {
    if (!this._scanning) {
      this._scanning = this._scan(reason).finally(() => {
        this._scanning = null;
        this._abort = null;
        this.progress = null;
        this._emitStatus(true);
      });
    }
    return this._scanning;
  }

  async _scan(reason) {
    const paths = [...this.paths];
    if (!paths.length) return { changed: false };
    const t0 = Date.now();
    this._abort = new AbortController();
    this.progress = { dirs: 0, tracks: 0, queued: 0, startedAt: t0 };
    this.log.info(`scanning ${paths.length} folder(s) (${reason})…`);
    this._emitStatus(true);

    const previous = new Map();
    for (const t of this.catalog.tracks.values()) previous.set(previousKey(t), t);
    const res = await scanLibrary(paths, {
      previous,
      signal: this._abort.signal,
      onProgress: (p) => {
        this.progress = { ...p, startedAt: t0 };
        this.emit('progress', this.progress);
      },
    });
    if (res.aborted) return { changed: false, aborted: true };

    // Reuse parse results for unchanged names (parsing 90k names takes seconds).
    for (const t of res.tracks) {
      if (t.p) continue;
      const prev = previous.get(previousKey(t));
      if (prev?.p && prev.pv === PARSER_VERSION) { t.p = prev.p; t.pv = prev.pv; }
    }
    // Keep the tracks of roots that are offline (drive unplugged) so the index stays usable.
    const online = new Set(res.rootsOnline);
    const tracks = res.tracks;
    for (const t of this.catalog.tracks.values()) {
      if (!online.has(t.root) && t.root < paths.length) tracks.push(t);
    }
    for (let i = 0; i < paths.length; i++) {
      this.online.set(paths[i], online.has(i));
      if (online.has(i)) this.scannedRoots.add(paths[i]);
    }

    const sig = trackSignature(tracks, paths);
    const changed = sig !== this.signature;
    const scanMs = Date.now() - t0;
    if (changed) {
      this._load(tracks);
      await this.saveCache();
      this.emit('changed', this.catalog);
    }
    this.lastScan = {
      at: Date.now(), reason, ms: Date.now() - t0, scanMs, dirs: res.dirs, tracks: this.catalog.size, changed,
      errorCount: res.errors.length, errors: res.errors.slice(0, 20),
    };
    this.log.info(`scan done: ${res.dirs} folders, ${res.tracks.length} tracks in ${(scanMs / 1000).toFixed(1)} s`
      + `${changed ? `, catalog rebuilt in ${this.catalog.buildMs} ms (${this.catalog.songs.size} songs)` : ', no changes'}`
      + `${res.errors.length ? `, ${res.errors.length} error(s): ${res.errors[0].path}: ${res.errors[0].error}` : ''}`);
    return { changed, errors: res.errors };
  }

  async saveCache() {
    try {
      await writeJsonAtomic(this.cacheFile, this.catalog.toCache());
    } catch (e) {
      this.log.error('could not save library cache', e.message);
    }
  }

  /** Replaces the library folders (host settings / CLI) and rescans. */
  async setPaths(list) {
    const next = normalizePaths(list);
    const before = [...this.paths];
    if (next.join('\u0000') === before.join('\u0000')) return this.status();
    if (this._scanning) {
      this._abort?.abort();
      await this._scanning.catch(() => {});
    }
    this.settings.update({ library: { paths: next } });
    const tracks = this._remap([...this.catalog.tracks.values()], before);
    this._load(tracks);
    this.emit('changed', this.catalog);
    await this.saveCache();
    await this.checkOnline();
    if (next.length) this.scan({ reason: 'folders changed' }).catch((e) => this.log.error('scan failed', e));
    this._emitStatus(true);
    return this.status();
  }

  /** Checks which library folders exist right now. Returns true if anything changed. */
  async checkOnline() {
    let changed = false;
    const cameBack = [];
    for (const p of this.paths) {
      let ok = false;
      try { ok = (await fs.stat(p)).isDirectory(); } catch { ok = false; }
      const before = this.online.get(p);
      if (before !== ok) {
        changed = true;
        if (before === false && ok) cameBack.push(p);
        if (before !== undefined) this.log.info(`library folder ${ok ? 'online' : 'OFFLINE'}: ${p}`);
      }
      this.online.set(p, ok);
    }
    for (const p of [...this.online.keys()]) if (!this.paths.includes(p)) this.online.delete(p);
    if (changed) this._emitStatus(true);
    if (cameBack.some((p) => !this.scannedRoots.has(p))) {
      this.scan({ reason: 'drive connected' }).catch((e) => this.log.error('scan failed', e));
    }
    return changed;
  }

  startWatcher() {
    if (this._timer || !this.watchIntervalMs) return;
    this._timer = setInterval(() => { this.checkOnline().catch(() => {}); }, this.watchIntervalMs);
    this._timer.unref?.();
  }

  /** Absolute path of one file of an indexed track (never from user input). */
  absPath(track, part) {
    const root = this.paths[track.root];
    const file = track[part];
    if (!root || typeof file !== 'string') return null;
    return path.join(root, track.dir, file);
  }

  isOnline(track) {
    return this.online.get(this.paths[track.root]) !== false;
  }

  status() {
    const paths = this.paths;
    const roots = paths.map((p, i) => ({ path: p, online: this.online.get(p) ?? null, tracks: this.rootCounts[i] || 0 }));
    const offline = roots.filter((r) => r.online === false).length;
    let state = 'ready';
    if (this._scanning) state = 'scanning';
    else if (!paths.length) state = 'unconfigured';
    else if (offline === roots.length) state = 'offline';
    else if (offline) state = 'partial';
    return {
      state,
      roots,
      tracks: this.catalog.size,
      songs: this.catalog.songs.size,
      artists: this.catalog.artists.size,
      builtAt: this.catalog.builtAt || null,
      progress: this.progress,
      lastScan: this.lastScan,
    };
  }

  _emitStatus(force = false) {
    const s = this.status();
    const key = JSON.stringify([s.state, s.roots, s.tracks, !!s.progress, s.lastScan?.at]);
    if (!force && key === this._statusKey) return;
    this._statusKey = key;
    this.emit('status', s);
  }

  async close() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._abort?.abort();
    if (this._scanning) await this._scanning.catch(() => {});
  }
}

/** Compact library status for clients. */
export function summaryStatus(s) {
  return {
    state: s.state, tracks: s.tracks, songs: s.songs, artists: s.artists,
    roots: s.roots, progress: s.progress, lastScan: s.lastScan && { at: s.lastScan.at, ms: s.lastScan.ms, errorCount: s.lastScan.errorCount, changed: s.lastScan.changed },
  };
}
