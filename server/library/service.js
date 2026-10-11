// Library service: owns the in-memory catalog, persists it to data/library.json,
// rescans the configured folders in the background and watches whether the
// drive holding them is plugged in.
//
// Events:
//   'changed'  { reason }            the catalog was (re)built
//   'progress' { dirs, tracks, ... } scan progress (≈4/s while scanning)
//   'status'   status()              roots went on/offline, a scan started/finished
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanLibrary, previousKey, nestedRoots, inNestedRoot } from './scanner.js';
import { Catalog, PARSER_VERSION } from './catalog.js';
import { readJson, writeJsonAtomic } from '../util/jsonfile.js';
import { hash32 } from '../../shared/text.js';
import { logger } from '../util/log.js';

const log = logger('library');

export class LibraryService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {import('../config.js').Settings} opts.settings
   * @param {number} [opts.watchIntervalMs] how often to check that the library folders exist
   */
  constructor({ dataDir, settings, watchIntervalMs = 20000, statTimeoutMs = 5000 }) {
    super();
    this.settings = settings;
    this.cacheFile = path.join(dataDir, 'library.json');
    this.catalog = new Catalog();
    this.watchIntervalMs = watchIntervalMs;
    this.statTimeoutMs = statTimeoutMs;
    this.scanning = null; // promise while a scan runs
    this.scanOnly = null; // the folders (indexes) it scans, null = every folder
    this.next = null; // { reason, only } a scan asked for while another one ran (it follows)
    this.nextPromise = null;
    this.progress = null;
    this.lastScan = null;
    this.rootsOnline = [];
    this.rootCounts = [];
    this.signature = '';
    this.timer = null;
    this.abort = null;
    this.saving = Promise.resolve();
    this.hasCache = false;
  }

  /** Configured library folders (absolute paths). */
  get paths() {
    const p = this.settings.get('library.paths');
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string' && x) : [];
  }

  /**
   * Loads the cached catalog and starts a background scan when wanted.
   * @param {object} [opts]
   * @param {boolean} [opts.scan] true = always scan, false = never, undefined = settings.library.rescanOnStart
   *   (a library that has never been scanned is always scanned unless scan === false)
   */
  async init({ scan } = {}) {
    await this.loadCache();
    await this.checkOnline({ emit: false });
    const want = scan === false ? false : scan === true || this.settings.get('library.rescanOnStart') || !this.catalog.size;
    if (want && this.paths.length && this.rootsOnline.some(Boolean)) {
      this.scan({ reason: 'startup' }).catch((e) => log.error('scan failed', e));
    }
    return this;
  }

  async loadCache() {
    const t0 = Date.now();
    const cache = await readJson(this.cacheFile, null);
    const raw = cache ? Catalog.rawFromCache(cache) : null;
    const paths = this.paths;
    if (raw) {
      const tracks = remapRoots(raw, cache.roots || [], paths);
      this.catalog.load(tracks, paths);
      this.signature = trackSignature(tracks);
      this.lastScan = cache.lastScan || null;
      this.hasCache = true;
      log.info(`loaded ${tracks.length} tracks (${this.catalog.songs.size} songs) from cache in ${Date.now() - t0} ms`);
      // Re-parsed names (new parser) or dropped folders: store the result so the next start is fast.
      if (cache.parser !== PARSER_VERSION || tracks.length !== raw.length) this.saveCache();
    } else {
      this.catalog.load([], paths);
      this.signature = trackSignature([]);
    }
    this.countRoots();
    this.emit('changed', { reason: 'cache' });
  }

  /** Writes the catalog cache (serialised so overlapping saves can't interleave). */
  saveCache() {
    const data = this.catalog.toCache();
    data.lastScan = this.lastScan;
    this.saving = this.saving
      .then(() => writeJsonAtomic(this.cacheFile, data))
      .then(() => { this.hasCache = true; })
      .catch((e) => log.error('could not save the library cache', e));
    return this.saving;
  }

  /**
   * Rescans the library folders: `roots` (folder paths) = only those, the others keep what they
   * had; default every folder. A call while a scan runs shares it when that scan covers the same
   * folders, else it follows (folders asked for meanwhile are scanned together, once).
   */
  scan({ reason = 'manual', roots = null } = {}) {
    let only = null;
    if (roots) {
      const paths = this.paths.map((p) => path.resolve(p));
      only = [...new Set(roots.map((p) => paths.indexOf(typeof p === 'string' ? path.resolve(p) : '')).filter((i) => i >= 0))].sort((a, b) => a - b);
      if (!only.length) return Promise.resolve(this.lastScan);
    }
    if (this.scanning) {
      if (!this.scanOnly || (only && only.every((i) => this.scanOnly.includes(i)))) return this.scanning;
      const n = this.next;
      const merged = !n ? only : !n.only || !only ? null : [...new Set([...n.only, ...only])].sort((a, b) => a - b);
      this.next = { reason: n ? n.reason : reason, only: merged };
      this.nextPromise ??= this.scanning.catch(() => {}).then(() => {
        const job = this.next;
        this.next = null;
        this.nextPromise = null;
        if (!job) return this.lastScan;
        const paths = this.paths;
        return this.scan({ reason: job.reason, roots: job.only ? job.only.map((i) => paths[i]).filter(Boolean) : null });
      });
      return this.nextPromise;
    }
    this.scanOnly = only;
    // (started a tick later, so the 'status' it sends already says what is being scanned)
    this.scanning = Promise.resolve().then(() => this.runScan(reason, only)).finally(() => {
      this.scanning = null;
      this.scanOnly = null;
      this.progress = null;
      this.abort = null;
      this.emit('status', this.status());
    });
    return this.scanning;
  }

  async runScan(reason, only = null) {
    const paths = this.paths;
    const t0 = Date.now();
    if (!paths.length) {
      this.lastScan = { at: t0, ms: 0, reason, tracks: 0, dirs: 0, changed: false, errorCount: 1, errors: [{ path: '', error: 'No library folder configured' }] };
      return this.lastScan;
    }
    if (!sameRoots(this.catalog.roots, paths)) this.remapCatalog(paths);
    if (only) only = only.filter((i) => i < paths.length);

    const previous = new Map();
    for (const t of this.catalog.tracks.values()) previous.set(previousKey(t), t);
    this.abort = new AbortController();
    this.progress = { dirs: 0, tracks: 0, queued: 0, startedAt: t0 };
    this.emit('status', this.status());
    log.info(only ? `scanning ${only.map((i) => paths[i]).join(', ')} (${reason})…` : `scanning ${paths.length} folder(s) (${reason})…`);

    const res = await scanLibrary(paths, {
      previous,
      only,
      signal: this.abort.signal,
      onProgress: (p) => {
        this.progress = { ...p, startedAt: t0 };
        this.emit('progress', this.progress);
      },
    });

    // A folder that was offline, or vanished during the scan (USB unplugged), keeps the
    // tracks we already knew about instead of emptying the library.
    const online = await this.checkOnline({ emit: false });
    const scanned = new Set(res.rootsOnline.filter((r) => online[r]));
    const tracks = [];
    for (const t of res.tracks) {
      if (!scanned.has(t.root)) continue;
      const prev = previous.get(previousKey(t));
      if (prev?.p && prev.pv === PARSER_VERSION) { t.p = prev.p; t.pv = prev.pv; } // skip re-parsing
      tracks.push(t);
    }
    if (!res.aborted) {
      for (const t of this.catalog.tracks.values()) if (!scanned.has(t.root)) tracks.push(t);
    }

    const ms = Date.now() - t0;
    if (res.aborted) {
      this.lastScan = { at: Date.now(), ms, reason, aborted: true, tracks: this.catalog.size, dirs: res.dirs, changed: false, errorCount: res.errors.length, errors: res.errors.slice(0, 20) };
      log.info('scan aborted');
      return this.lastScan;
    }
    const sig = trackSignature(tracks);
    const changed = sig !== this.signature;
    const before = this.catalog.size;
    if (changed) {
      this.catalog.load(tracks, paths);
      this.signature = sig;
      this.countRoots();
    }
    const asked = only || paths.map((p, i) => i);
    this.lastScan = {
      at: Date.now(), ms, reason, changed, dirs: res.dirs,
      tracks: this.catalog.size, delta: this.catalog.size - before,
      ...(only ? { folders: only.map((i) => paths[i]) } : {}),
      offlineRoots: asked.filter((i) => !scanned.has(i)).map((i) => paths[i]),
      errorCount: res.errors.length, errors: res.errors.slice(0, 20),
    };
    log.info(`scan done in ${(ms / 1000).toFixed(1)} s: ${this.catalog.size} tracks, ${this.catalog.songs.size} songs`
      + `${changed ? '' : ' (no changes)'}${res.errors.length ? `, ${res.errors.length} error(s)` : ''}`);
    if (changed || !this.hasCache) await this.saveCache();
    if (changed) this.emit('changed', { reason: 'scan' });
    return this.lastScan;
  }

  /** Stops a running scan (used on shutdown). */
  cancelScan() {
    this.abort?.abort();
  }

  /**
   * Replaces the library folders, keeping tracks of folders that stay (rescanForPaths() says
   * which folders need a scan afterwards).
   */
  async setPaths(paths) {
    const clean = [...new Set((paths || []).filter((p) => typeof p === 'string' && p.trim()).map((p) => path.resolve(p.trim())))];
    this.next = null; // (a scan waiting for the old folders' indexes)
    this.cancelScan();
    if (this.scanning) await this.scanning.catch(() => {});
    this.settings.update({ library: { paths: clean } });
    this.remapCatalog(clean);
    await this.checkOnline({ emit: false });
    this.emit('changed', { reason: 'paths' });
    this.emit('status', this.status());
    return clean;
  }

  remapCatalog(newRoots) {
    const tracks = remapRoots([...this.catalog.tracks.values()], this.catalog.roots, newRoots);
    this.catalog.load(tracks, newRoots);
    this.signature = trackSignature(tracks);
    this.countRoots();
  }

  countRoots() {
    const counts = this.catalog.roots.map(() => 0);
    for (const t of this.catalog.tracks.values()) counts[t.root] = (counts[t.root] || 0) + 1;
    this.rootCounts = counts;
  }

  /** Checks which library folders are reachable. Returns one boolean per folder. */
  async checkOnline({ emit = true } = {}) {
    const paths = this.paths;
    const states = await Promise.all(paths.map((p) => folderOnline(p, this.statTimeoutMs)));
    const changed = states.length !== this.rootsOnline.length || states.some((s, i) => s !== this.rootsOnline[i]);
    const before = this.rootsOnline;
    this.rootsOnline = states;
    if (changed) {
      states.forEach((s, i) => {
        if (before[i] !== undefined && s !== before[i]) log.info(`library folder ${s ? 'is online' : 'went offline'}: ${paths[i]}`);
      });
      if (emit) this.emit('status', this.status());
    }
    return states;
  }

  startWatcher() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => log.warn('watcher', e.message)), this.watchIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelScan();
  }

  async tick() {
    if (this.scanning) return;
    const before = this.rootsOnline.slice();
    const states = await this.checkOnline();
    // A folder that appeared and has never been indexed (e.g. the drive was plugged in
    // after the server started) is scanned automatically — that folder only.
    const paths = this.paths;
    const appeared = paths.filter((p, i) => states[i] && before[i] === false && !this.rootCounts[i]);
    if (appeared.length) this.scan({ reason: 'drive connected', roots: appeared }).catch((e) => log.error('scan failed', e));
  }

  /** Absolute path of one file of an indexed track (`part` = cdg | audio | video | zip). */
  absPath(track, part) {
    const root = this.catalog.roots[track?.root];
    const file = track?.[part];
    if (!root || typeof file !== 'string' || !file) return null;
    return path.join(root, track.dir || '', file);
  }

  isTrackOnline(track) {
    return !!this.rootsOnline[track?.root];
  }

  status() {
    const paths = this.paths;
    return {
      tracks: this.catalog.size,
      songs: this.catalog.songs.size,
      artists: this.catalog.artists.size,
      roots: paths.map((p, i) => ({
        path: p, online: !!this.rootsOnline[i], tracks: this.rootCounts[i] || 0,
        scanning: !!this.scanning && (!this.scanOnly || this.scanOnly.includes(i)),
        ...(this.next && (!this.next.only || this.next.only.includes(i)) ? { waiting: true } : {}),
      })),
      offline: paths.length > 0 && this.rootsOnline.some((s) => !s),
      scanning: !!this.scanning,
      progress: this.progress,
      lastScan: this.lastScan,
      builtAt: this.catalog.builtAt,
    };
  }
}

/** Order-independent fingerprint of a track set (detects added/removed/resized files). */
export function trackSignature(tracks) {
  let n = 0;
  let sum = 0;
  let mix = 0;
  for (const t of tracks) {
    const h = hash32(`${t.root}\u0000${t.dir}\u0000${t.name}\u0000${t.kind}\u0000${t.size}\u0000${t.cdg || ''}\u0000${t.audio || ''}\u0000${t.video || ''}\u0000${t.zip || ''}`);
    sum = (sum + h) >>> 0;
    mix = (mix ^ Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)) >>> 0;
    n++;
  }
  return `${n}:${sum.toString(36)}:${mix.toString(36)}`;
}

function sameRoots(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Re-indexes `t.root` from one list of folders to another; drops tracks of removed folders, and
 * tracks inside a folder that is now a library folder of its own (found there instead: a track is
 * never in the library twice).
 */
export function remapRoots(tracks, oldRoots, newRoots) {
  const norm = (p) => path.resolve(String(p));
  const index = new Map(newRoots.map((p, i) => [norm(p), i]));
  const map = oldRoots.map((p) => index.get(norm(p)));
  const nested = nestedRoots(newRoots);
  const out = [];
  for (const t of tracks) {
    const r = map[t.root];
    if (r === undefined || inNestedRoot(t.dir || '', nested[r])) continue;
    t.root = r;
    out.push(t);
  }
  return out;
}

/**
 * The folders to scan after the library folders changed from `before` to `after`: the new ones,
 * and a remaining folder that held a removed one (its sub-folder is its own again).
 */
export function rescanForPaths(before, after) {
  const norm = (p) => path.resolve(String(p));
  const old = new Set(before.map(norm));
  const now = after.map(norm);
  const removed = [...old].filter((p) => !now.includes(p));
  const inside = (outer, p) => {
    const rel = path.relative(outer, p);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  return now.filter((p) => !old.has(p) || removed.some((r) => inside(p, r)));
}

const pendingChecks = new Set(); // folders whose previous check hasn't returned yet

/**
 * True when the folder exists and isn't an empty mount point. A hung mount (dead USB or
 * network drive) makes fs calls block a libuv thread, so while one check for a folder is
 * still stuck we report it offline instead of starting another.
 */
async function folderOnline(p, timeoutMs) {
  if (pendingChecks.has(p)) return false;
  pendingChecks.add(p);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const check = (async () => {
    try {
      const st = await fs.stat(p);
      if (!st.isDirectory()) return false;
      const dir = await fs.opendir(p);
      const first = await dir.read();
      await dir.close();
      return first !== null; // an empty mount point means the drive isn't there
    } catch {
      return false;
    }
  })().finally(() => pendingChecks.delete(p));
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
