// Library service: owns the in-memory catalog, persists it to data/library.json,
// rescans the configured folders in the background and watches whether the
// drive holding them is plugged in.
//
// Events:
//   'changed'  { reason }            the catalog was (re)built
//   'progress' { dirs, tracks, ... } scan progress (≈4/s while scanning)
//   'status'   status()              roots went on/offline, a scan started/finished
//   'ids'      [{ from, to }]        the same file's track id changed (a folder split or folded)
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanLibrary, previousKey, nestedRoots, inNestedRoot } from './scanner.js';
import { Catalog, PARSER_VERSION, trackIdAssigner } from './catalog.js';
import { placer, trackReturns, idMoves } from './ids.js';
import { readJson, writeTextAtomic } from '../util/jsonfile.js';
import { hash32 } from '../../shared/text.js';
import { logger } from '../util/log.js';
import { slicer, abortError } from '../util/slice.js';

const log = logger('library');

export class LibraryService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {import('../config.js').Settings} opts.settings
   * @param {number} [opts.watchIntervalMs] how often to check that the library folders exist
   * @param {number} [opts.workerMinTracks] a rescan rebuilds a catalog this big in a worker thread
   * @param {number} [opts.cacheWorkerMinBytes] a library.json this big (≈5,000 tracks) is loaded
   *   after init() returns, through worker threads (`loading`)
   */
  constructor({ dataDir, settings, watchIntervalMs = 20000, statTimeoutMs = 5000, workerMinTracks = 5000, cacheWorkerMinBytes = 1_500_000 }) {
    super();
    this.settings = settings;
    this.cacheFile = path.join(dataDir, 'library.json');
    this.catalog = new Catalog();
    this.watchIntervalMs = watchIntervalMs;
    this.statTimeoutMs = statTimeoutMs;
    this.workerMinTracks = workerMinTracks;
    this.cacheWorkerMinBytes = cacheWorkerMinBytes;
    this.loading = null; // promise while the cache loads in the background
    this.loadAbort = null;
    this.stopped = false;
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
    // Files that left because a folder was split off or folded back, place → id, until they return.
    this.departed = new Map();
    // Id moves not yet applied by the party (a restart finishes them). `pendingMoves` is the
    // part emitted before anyone was listening.
    this.unacked = [];
    this.pendingMoves = [];
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
    await this.checkOnline({ emit: false });
    if (await this.bigCache()) {
      // Read and built in worker threads while the server already answers (≈3 s at 90k tracks
      // otherwise before it listens): the party's state and the pages come at once, requests
      // that need the catalog wait for it (app.js), and 'changed' says when it is in.
      const abort = new AbortController();
      this.loadAbort = abort;
      this.loading = this.loadCache({ signal: abort.signal })
        .catch((e) => {
          if (e.name !== 'AbortError') log.error('could not load the library cache', e);
        })
        .then(() => {
          this.loading = null;
          this.loadAbort = null;
          if (abort.signal.aborted) return; // (stopped)
          this.emit('status', this.status());
          this.startupScan(scan); // (an empty catalog — the cache couldn't be loaded — is scanned)
        });
      return this;
    }
    await this.loadCache();
    this.startupScan(scan);
    return this;
  }

  /** Resolves once the catalog cache is in (at once unless it loads in the background). */
  ready() {
    return this.loading || Promise.resolve();
  }

  startupScan(scan) {
    const want = scan === false ? false : scan === true || this.settings.get('library.rescanOnStart') || !this.catalog.size;
    if (want && this.paths.length && this.rootsOnline.some(Boolean)) {
      this.scan({ reason: 'startup' }).catch((e) => log.error('scan failed', e));
    }
  }

  async bigCache() {
    try {
      return (await fs.stat(this.cacheFile)).size >= this.cacheWorkerMinBytes;
    } catch {
      return false;
    }
  }

  /**
   * Loads library.json. With `signal` (a big cache, see init()) it is read and built in worker
   * threads and the loops here run in slices; `signal` stops it (an AbortError).
   */
  async loadCache({ signal = null } = {}) {
    const t0 = Date.now();
    const background = !!signal;
    const tick = background ? slicer(signal) : async () => {};
    let cache, raw;
    if (background) ({ cache, raw } = await readCacheAsync(this.cacheFile, signal));
    else {
      cache = await readJson(this.cacheFile, null);
      raw = cache ? Catalog.rawFromCache(cache) : null;
    }
    const paths = this.paths;
    this.departed = departedFromCache(cache);
    this.unacked = [];
    this.pendingMoves = [];
    this.keepMoves(movesFromCache(cache));
    if (raw) {
      // Ids are not in the cache. The same list, in this order, is how they were assigned
      // last time — before a nested folder is dropped, so a split can still find the old id.
      const oldRoots = Array.isArray(cache.roots) ? cache.roots : [];
      const assign = trackIdAssigner();
      const oldSnap = [];
      for (let i = 0; i < raw.length; i++) {
        assign(raw[i]);
        oldSnap.push(snapOf(raw[i]));
        if (i % 1000 === 999) await tick();
      }
      const tracks = remapRoots(raw, oldRoots, paths);
      await tick();
      if (background) {
        if (await this.rebuild(tracks, paths, signal) === 'aborted') throw abortError('The library load was stopped');
      } else this.catalog.load(tracks, paths);
      const sign = signer();
      for (let i = 0; i < tracks.length; i++) {
        sign.add(tracks[i]);
        if (i % 1000 === 999) await tick();
      }
      this.signature = sign.done();
      this.lastScan = cache.lastScan || null;
      this.hasCache = true;
      log.info(`loaded ${tracks.length} tracks (${this.catalog.songs.size} songs) from cache in ${Date.now() - t0} ms${background ? ' (worker threads)' : ''}`);
      // The same folders and every track kept: the same ids as last time, nothing moved
      // (≈90 ms at 90k tracks saved).
      if (this.departed.size || tracks.length !== raw.length || !sameRoots(oldRoots, paths)) this.settleIds(oldRoots, oldSnap, paths);
      // Re-parsed names (new parser) or dropped folders: store the result so the next start is fast.
      if (cache.parser !== PARSER_VERSION || tracks.length !== raw.length || this.departed.size || this.unacked.length) this.saveCache();
    } else {
      this.catalog.load([], paths);
      this.signature = trackSignature([]);
    }
    this.countRoots();
    this.emit('changed', { reason: 'cache' });
  }

  /**
   * Writes the catalog cache (serialised so overlapping saves can't interleave). What is written
   * is the state when its turn comes, made a few ms at a time.
   */
  saveCache() {
    this.saving = this.saving
      .then(() => this.writeCache())
      .then(() => { this.hasCache = true; })
      .catch((e) => log.error('could not save the library cache', e));
    return this.saving;
  }

  async writeCache() {
    for (;;) {
      const extra = { lastScan: this.lastScan };
      if (this.departed.size) extra.departed = Object.fromEntries(this.departed);
      if (this.unacked.length) extra.idMoves = this.unacked.map((m) => ({ from: m.from, to: m.to }));
      const text = await this.catalog.toCacheText(extra);
      if (text) return writeTextAtomic(this.cacheFile, text); // (else rebuilt meanwhile: again)
    }
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
    // (after the cache's background load: the scan compares with what it had)
    this.scanning = Promise.resolve(this.loading).then(() => (this.stopped ? this.lastScan : this.runScan(reason, only))).finally(() => {
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

    this.abort = new AbortController(); // (before the first await: cancelScan() works from here on)
    // (Loops over every track yield now and then: at 90k tracks they would stall the server.)
    const tick = slicer();
    const oldRoots = this.catalog.roots.slice();
    const oldSnap = [];
    const previous = new Map();
    for (const t of this.catalog.tracks.values()) {
      oldSnap.push(snapOf(t));
      previous.set(previousKey(t), t);
      if (oldSnap.length % 1000 === 0) await tick();
    }
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
      if (tracks.length % 1000 === 0) await tick();
    }
    if (!res.aborted) {
      for (const t of this.catalog.tracks.values()) if (!scanned.has(t.root)) tracks.push(t);
    }

    const ms = Date.now() - t0;
    const aborted = () => {
      this.lastScan = { at: Date.now(), ms, reason, aborted: true, tracks: this.catalog.size, dirs: res.dirs, changed: false, errorCount: res.errors.length, errors: res.errors.slice(0, 20) };
      log.info('scan aborted');
      return this.lastScan;
    };
    if (res.aborted) return aborted();
    const sign = signer();
    for (let i = 0; i < tracks.length; i++) {
      sign.add(tracks[i]);
      if (i % 1000 === 999) await tick();
    }
    const sig = sign.done();
    const changed = sig !== this.signature;
    const before = this.catalog.size;
    if (changed) {
      // A big library is rebuilt in a worker thread, so the party's pages keep answering.
      if (await this.rebuild(tracks, paths) === 'aborted') return aborted();
      this.signature = sig;
      this.countRoots();
      this.settleIds(oldRoots, oldSnap, paths);
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

  /** catalog.load(), in a worker thread for a big library. 'aborted' when the scan (or load) was stopped meanwhile. */
  async rebuild(tracks, paths, signal = this.abort?.signal) {
    if (tracks.length < this.workerMinTracks) {
      this.catalog.load(tracks, paths);
      return 'done';
    }
    try {
      await this.catalog.loadAsync(tracks, paths, { signal });
      log.info(`catalog rebuilt in a worker thread in ${this.catalog.buildMs} ms`);
    } catch (e) {
      if (e.name === 'AbortError') return 'aborted';
      log.warn(`the worker thread could not rebuild the catalog (${e.message}); rebuilding here`);
      this.catalog.load(tracks, paths);
    }
    return 'done';
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
    await this.loading;
    this.settings.update({ library: { paths: clean } });
    this.remapCatalog(clean);
    await this.checkOnline({ emit: false });
    this.emit('changed', { reason: 'paths' });
    this.emit('status', this.status());
    return clean;
  }

  remapCatalog(newRoots) {
    const oldRoots = this.catalog.roots.slice();
    const oldSnap = snapTracks(this.catalog.tracks.values());
    const tracks = remapRoots([...this.catalog.tracks.values()], oldRoots, newRoots);
    this.catalog.load(tracks, newRoots);
    this.signature = trackSignature(tracks);
    this.countRoots();
    this.settleIds(oldRoots, oldSnap, newRoots);
  }

  /**
   * After the catalog was rebuilt: the same file under a new root (a split, or a fold back
   * into a parent) gets `{ from, to }` on the `ids` event. Files that will come back stay
   * in `departed` until that scan. Anything else that disappeared keeps its old id.
   */
  settleIds(oldRoots, oldSnap, newRoots) {
    if (!this.departed.size && sameRoots(oldRoots, newRoots)) this.settleSameRoots(oldSnap, newRoots);
    else this.settleByPlace(oldRoots, oldSnap, newRoots);
  }

  /**
   * settleIds() for a rescan of the same folders with no file waiting to come back (the usual
   * case): a file keeps its root, folder and name, so it is found by those, without building a
   * path for each of 90k tracks (≈0.5–1.5 s). Same result as settleByPlace().
   */
  settleSameRoots(oldSnap, roots) {
    const usable = (t) => t?.id && typeof t.name === 'string' && t.name && typeof roots[t.root] === 'string' && roots[t.root];
    const was = new Map(); // root → dir → name → the old snapshot's entry (the first one wins)
    for (const t of oldSnap) {
      if (!usable(t)) continue;
      let dirs = was.get(t.root);
      if (!dirs) was.set(t.root, (dirs = new Map()));
      let names = dirs.get(t.dir || '');
      if (!names) dirs.set(t.dir || '', (names = new Map()));
      if (!names.has(t.name)) names.set(t.name, t);
    }
    const moves = [];
    const used = new Set();
    for (const t of this.catalog.tracks.values()) {
      if (!usable(t)) continue;
      const names = was.get(t.root)?.get(t.dir || '');
      const old = names?.get(t.name);
      if (!old) continue;
      names.delete(t.name); // still here
      if (old.id === t.id || used.has(old.id)) continue;
      used.add(old.id);
      moves.push({ from: old.id, to: t.id });
    }
    // What is left went away; a file that only moved to another library folder will come back.
    for (const dirs of was.values()) {
      for (const names of dirs.values()) {
        for (const t of names.values()) if (trackReturns(roots, t, roots)) this.departed.set(placer(roots)(t), t.id);
      }
    }
    this.keepMoves(moves);
  }

  /** settleIds() by each file's absolute path: the folders changed, or files are waiting to come back. */
  settleByPlace(oldRoots, oldSnap, newRoots) {
    const oldPlace = placer(oldRoots);
    const newPlace = placer(newRoots);
    const prior = [];
    const seen = new Set();
    // The catalog's own id wins when a place is also in `departed` (a stale note).
    for (const t of oldSnap) {
      const place = oldPlace(t);
      if (!place || !t.id || seen.has(place)) continue;
      seen.add(place);
      prior.push({ id: t.id, place });
    }
    for (const [place, id] of this.departed) {
      if (!place || !id || seen.has(place)) continue;
      seen.add(place);
      prior.push({ id, place });
    }
    const now = [];
    const nowPlaces = new Set();
    for (const t of this.catalog.tracks.values()) {
      const place = newPlace(t);
      if (!place || !t.id) continue;
      now.push({ id: t.id, place });
      nowPlaces.add(place);
    }
    const moves = idMoves(null, prior, newRoots, now);
    for (const t of oldSnap) {
      const place = oldPlace(t);
      if (!place || !t.id) continue;
      if (nowPlaces.has(place)) this.departed.delete(place);
      else if (trackReturns(oldRoots, t, newRoots)) this.departed.set(place, t.id);
      else this.departed.delete(place);
    }
    for (const place of [...this.departed.keys()]) {
      if (nowPlaces.has(place) || !placeHeld(place, newRoots)) this.departed.delete(place);
    }
    this.keepMoves(moves);
  }

  /** Queues id moves until the party applies them (`ackIdMoves`). Emits when someone is listening. */
  keepMoves(moves) {
    const fresh = [];
    for (const m of moves || []) {
      if (!m || typeof m.from !== 'string' || typeof m.to !== 'string' || m.from === m.to) continue;
      if (!TRACK_ID_RE.test(m.from) || !TRACK_ID_RE.test(m.to)) continue;
      if (this.unacked.some((x) => x.from === m.from && x.to === m.to)) continue;
      const rec = { from: m.from, to: m.to };
      this.unacked.push(rec);
      fresh.push(rec);
    }
    if (!fresh.length) return;
    log.info(`track ids follow their files: ${fresh.length}`);
    if (this.listenerCount('ids')) this.emit('ids', fresh);
    else this.pendingMoves.push(...fresh);
  }

  /** Moves emitted before a listener existed (startup, while the party is still loading). */
  takeIdMoves() {
    const m = this.pendingMoves;
    this.pendingMoves = [];
    return m;
  }

  /** The party has copied the records. Drops them so the next start does not apply them again. */
  ackIdMoves(moves) {
    const done = new Set((moves || []).map((m) => `${m.from}\0${m.to}`));
    if (!done.size || !this.unacked.length) return;
    const before = this.unacked.length;
    this.unacked = this.unacked.filter((m) => !done.has(`${m.from}\0${m.to}`));
    this.pendingMoves = this.pendingMoves.filter((m) => !done.has(`${m.from}\0${m.to}`));
    if (this.unacked.length !== before && this.hasCache && !this.scanning) this.saveCache();
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
    this.stopped = true;
    this.loadAbort?.abort();
    this.cancelScan();
  }

  async tick() {
    if (this.scanning || this.loading) return;
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
      loading: !!this.loading,
      scanning: !!this.scanning,
      progress: this.progress,
      lastScan: this.lastScan,
      builtAt: this.catalog.builtAt,
    };
  }
}

/** Catalog.readCache(), or readJson() when the worker thread can't (it falls back, like rebuild()). */
async function readCacheAsync(file, signal) {
  try {
    return await Catalog.readCache(file, { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`a worker thread could not read the library cache (${e.message}); reading it here`);
    const cache = await readJson(file, null);
    return { cache, raw: cache ? Catalog.rawFromCache(cache) : null };
  }
}

/** Order-independent fingerprint of a track set (detects added/removed/resized files). */
export function trackSignature(tracks) {
  const sign = signer();
  for (const t of tracks) sign.add(t);
  return sign.done();
}

/** trackSignature() one track at a time. */
function signer() {
  let n = 0;
  let sum = 0;
  let mix = 0;
  return {
    add(t) {
      const h = hash32(`${t.root}\u0000${t.dir}\u0000${t.name}\u0000${t.kind}\u0000${t.size}\u0000${t.cdg || ''}\u0000${t.audio || ''}\u0000${t.video || ''}\u0000${t.zip || ''}`);
      sum = (sum + h) >>> 0;
      mix = (mix ^ Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)) >>> 0;
      n++;
    },
    done: () => `${n}:${sum.toString(36)}:${mix.toString(36)}`,
  };
}

const TRACK_ID_RE = /^[0-9a-z]{1,16}$/;

function snapTracks(tracks) {
  const out = [];
  for (const t of tracks) out.push(snapOf(t));
  return out;
}

function snapOf(t) {
  return { id: t.id, root: t.root, dir: t.dir || '', name: t.name };
}

/** A missing file can still come back when one of the library folders holds its path. */
function placeHeld(place, roots) {
  for (const r of roots || []) {
    if (typeof r !== 'string' || !r) continue;
    const root = path.resolve(r);
    if (place === root || place.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

function departedFromCache(cache) {
  const out = new Map();
  const src = cache?.departed;
  if (!src || typeof src !== 'object') return out;
  for (const [place, id] of Object.entries(src)) {
    if (typeof place !== 'string' || !path.isAbsolute(place) || typeof id !== 'string' || !TRACK_ID_RE.test(id)) continue;
    out.set(place, id);
  }
  return out;
}

function movesFromCache(cache) {
  if (!Array.isArray(cache?.idMoves)) return [];
  return cache.idMoves.filter((m) => m && typeof m.from === 'string' && typeof m.to === 'string');
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
