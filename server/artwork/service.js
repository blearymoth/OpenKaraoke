// Artwork & metadata service (PLAN §12): looks songs and artists up with the online
// providers, caches metadata in data/meta.json and images in data/art/, and serves them.
//
// - Every provider has its own queue (3 priorities: now > visible > crawl), worker count and
//   rate limiter; errors back off exponentially and never count as "not found".
// - A song lookup walks SONG_CHAIN (Deezer → MusicBrainz/CAA → iTunes) until one matches;
//   misses remember which providers were asked and are retried after 30 days.
// - An artist lookup collects a picture (Deezer), fanart/logo/cutout (TheAudioDB, Fanart.tv).
// - The background crawler walks the catalogue, most popular songs first.
//
// Events: 'art' { songs: [songId], artists: [artistKey] } — images became available/changed;
//         'status' — crawler/provider status changed (throttled).
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from '../util/jsonfile.js';
import { Throttle } from '../util/throttle.js';
import { Lru, memoPromise } from '../util/lru.js';
import { UserError } from '../util/errors.js';
import { sendFile } from '../http/static.js';
import { logger } from '../util/log.js';
import { PROVIDERS, SONG_CHAIN, USER_AGENT, imageUrls, allowedImageUrl, placeholderRef } from './providers.js';
import { songQuery, pickBest, pickArtist, rankCandidates, artistNameScore, artistSearchName, sameSearchName, actsOf } from './match.js';
import { compact } from '../../shared/text.js';

const log = logger('artwork');

/** Bump when matching improves: older misses are retried. */
export const MATCH_VERSION = 2;
const DAY = 86_400_000;
const RETRY_MISS_MS = 30 * DAY;
export const PRIO = { now: 0, visible: 1, crawl: 2 };
const MAX_WAIT = [20_000, 5_000, Infinity]; // how long a lookup may wait for a rate-limited provider
const VISIBLE_CAP = 120; // on-demand lookups kept (newest first)
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const ARTIST_TYPES = ['picture', 'fanart', 'logo', 'cutout', 'banner'];
// What an artist entry gets only from searching an artist database by name (see artistEntry).
const SEARCHED = ['fanart', 'logo', 'cutout', 'banner', 'mbid', 'genre'];
const FILE_RE = /^([0-9a-f]{40})\.(jpg|png|webp|gif)$/;

/** ?s=250|500|1000 → 's' | 'm' | 'l'. */
export function sizeKey(s, def = 's') {
  const n = Number(s);
  if (!n) return def;
  return n >= 900 ? 'l' : n >= 400 ? 'm' : 's';
}

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  return null;
}

async function readLimited(res, limit) {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) {
      res.body.cancel?.().catch?.(() => {});
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const compactEntry = (e) => {
  for (const k of Object.keys(e)) if (e[k] === '' || e[k] === null || e[k] === undefined || e[k] === 0 || e[k] === false || (Array.isArray(e[k]) && !e[k].length)) delete e[k];
  return e;
};

export class ArtworkService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {import('../config.js').Settings} opts.settings
   * @param {import('../library/service.js').LibraryService} opts.library
   * @param {typeof fetch} [opts.fetch] injected in tests (no network)
   * @param {string} [opts.version] app version for the User-Agent
   * @param {number} [opts.crawlDelayMs] wait after start before crawling
   */
  constructor({ dataDir, settings, library, fetch = globalThis.fetch, version = '0', now = () => Date.now(), crawlDelayMs = 20_000 }) {
    super();
    this.metaFile = path.join(dataDir, 'meta.json');
    this.artDir = path.join(dataDir, 'art');
    this.settings = settings;
    this.library = library;
    this.fetch = fetch;
    this.now = now;
    this.ua = USER_AGENT(version);
    this.crawlDelayMs = crawlDelayMs;
    this.songs = new Map(); // song key → { p, id, cover, album, genre, year, explicit, rank, confidence, at, v } | { miss, tried[], at, v }
    // artist key → { picture, pictureFor?, fanart[], logo, cutout, banner, mbid, genre, n, tried[], at, v }
    // n: the name searched for (see searchName); pictureFor: the picture came with a matched song
    // and was accepted for that name.
    this.artists = new Map();
    this.nameSearches = new Lru({ max: 64 }); // "provider|name" → artist search result (band members share one)
    this.albums = new Map(); // "provider:id" → { genre, year, type }
    this.files = new Map(); // sha1(url) → { ext, size, used }
    this.bytes = 0;
    this.downloads = new Map();
    this.badUrls = new Map(); // url → time of a 404 (not asked again for a day)
    this.throttles = {};
    this.health = {};
    this.queues = {};
    this.running = {};
    this.runningCrawl = {};
    for (const [name, p] of Object.entries(PROVIDERS)) {
      this.throttles[name] = new Throttle({ ...p.throttle, now });
      this.health[name] = { status: 'ok', fails: 0, lastError: '', at: 0 };
      this.queues[name] = [[], [], []];
      this.running[name] = 0;
      this.runningCrawl[name] = 0;
    }
    this.imageThrottle = new Throttle({ capacity: 12, perMs: 1000, now });
    this.jobs = new Map();
    this.pendingArt = { songs: new Set(), artists: new Set() };
    this.candidateCache = new Lru({ max: 40 });
    this.crawl = { timer: null, list: null, artistList: null, index: 0, artistIndex: 0, version: -1, requested: 0, inFlight: 0, state: 'idle', recent: [], restartAt: 0 };
    this.timers = {};
    this.lastFocus = '';
    this.closed = false;
    this.loaded = false;
  }

  get catalog() {
    return this.library.catalog;
  }

  cfg() {
    return this.settings.data.artwork || {};
  }

  enabled() {
    return !!this.cfg().enabled && !this.closed;
  }

  providerOn(name) {
    const c = this.cfg();
    if (!this.enabled() || !c.providers?.[name]) return false;
    if (name === 'fanarttv') return /^[\w-]{8,64}$/.test(c.fanartKey || '');
    return true;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async init({ crawl = true } = {}) {
    await fsp.mkdir(this.artDir, { recursive: true });
    const data = await readJson(this.metaFile, null);
    if (data && data.version === 1) {
      const load = (map, obj) => {
        for (const [k, v] of Object.entries(obj || {})) if (v && typeof v === 'object' && !Array.isArray(v)) map.set(k, v);
      };
      load(this.songs, data.songs);
      load(this.artists, data.artists);
      load(this.albums, data.albums);
      this.dropPlaceholders();
    }
    this.installMeta();
    this.library.on('changed', () => {
      this.installMeta();
      this.crawl.list = null;
      this.crawl.artistList = null;
    });
    this.loaded = true;
    this.indexFiles().catch((e) => log.warn('could not index the artwork cache', e.message));
    if (crawl) this.timers.crawl = setTimeout(() => this.crawlTick(), this.crawlDelayMs);
    this.timers.crawl?.unref?.();
    log.info(`${this.songs.size} songs and ${this.artists.size} artists with metadata`);
    return this;
  }

  installMeta() {
    this.catalog.metaFor = (key) => this.songs.get(key) || null;
    this.catalog.metaChanged();
    // Artists found under a name that no longer applies (see artistEntry) lose that art now.
    for (const key of [...this.artists.keys()]) {
      const artist = this.catalog.artist(key);
      if (artist) this.artistEntry(artist);
    }
  }

  /** Deezer's "no picture" images saved as art before they were recognised: look those up again. */
  dropPlaceholders() {
    let n = 0;
    for (const [key, e] of this.songs) {
      if (e.manual || !placeholderRef(e.cover)) continue;
      this.songs.set(key, compactEntry({ miss: true, year: e.year, genre: e.genre, v: MATCH_VERSION })); // no `at`: retried
      n++;
    }
    for (const [key, e] of this.artists) {
      if (!placeholderRef(e.picture)) continue;
      // No `at`: every provider is asked again, TheAudioDB for a picture too. `tried` stays: it
      // tells artistEntry that the rest was found by searching for the artist's name.
      const { picture, pictureFor, at, ...rest } = e;
      this.artists.set(key, rest);
      n++;
    }
    if (n) {
      log.info(`${n} placeholder pictures dropped`);
      this.saveSoon();
    }
  }

  async indexFiles() {
    let names = [];
    try {
      names = await fsp.readdir(this.artDir);
    } catch {
      return;
    }
    const pinned = this.customKeys();
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        fsp.unlink(path.join(this.artDir, name)).catch(() => {});
        continue;
      }
      const m = FILE_RE.exec(name);
      if (!m || this.files.has(m[1])) continue;
      try {
        const st = await fsp.stat(path.join(this.artDir, name));
        this.files.set(m[1], { ext: m[2], size: st.size, used: st.mtimeMs, pinned: pinned.has(m[1]) || undefined });
        this.bytes += st.size;
      } catch { /* removed meanwhile */ }
    }
    this.evict();
  }

  async close() {
    this.closed = true;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    clearTimeout(this.crawl.timer);
    for (const job of [...this.jobs.values()]) this.settle(job, null);
    for (const qs of Object.values(this.queues)) for (const q of qs) q.length = 0;
    if (this.dirty) await this.save();
  }

  // ---- persistence -------------------------------------------------------------------------

  saveSoon() {
    this.dirty = true;
    if (this.timers.save) return;
    this.timers.save = setTimeout(() => {
      this.timers.save = null;
      this.save().catch((e) => log.error('could not save meta.json', e));
    }, 10_000);
    this.timers.save.unref?.();
  }

  async save() {
    this.dirty = false;
    const data = {
      version: 1,
      savedAt: this.now(),
      songs: Object.fromEntries(this.songs),
      artists: Object.fromEntries(this.artists),
      albums: Object.fromEntries(this.albums),
    };
    const prev = this.saving || Promise.resolve();
    this.saving = prev.catch(() => {}).then(() => writeJsonAtomic(this.metaFile, data));
    return this.saving;
  }

  /** Rankings / facets in the catalog use the metadata: tell it (at most every 3 s). */
  metaChangedSoon() {
    if (this.timers.meta) return;
    this.timers.meta = setTimeout(() => {
      this.timers.meta = null;
      this.catalog.metaChanged();
    }, 3000);
    this.timers.meta.unref?.();
  }

  artChanged({ songs = [], artists = [] }) {
    for (const s of songs) this.pendingArt.songs.add(s);
    for (const a of artists) this.pendingArt.artists.add(a);
    if (this.timers.art) return;
    this.timers.art = setTimeout(() => {
      this.timers.art = null;
      const out = { songs: [...this.pendingArt.songs], artists: [...this.pendingArt.artists] };
      this.pendingArt.songs.clear();
      this.pendingArt.artists.clear();
      if (out.songs.length || out.artists.length) this.emit('art', out);
    }, 700);
  }

  statusChanged() {
    if (this.timers.status) return;
    this.timers.status = setTimeout(() => {
      this.timers.status = null;
      this._status = null;
      if (!this.closed) this.emit('status');
    }, 1000);
    this.timers.status.unref?.();
  }

  setSong(song, entry) {
    const prev = this.songs.get(song.key);
    this.songs.set(song.key, compactEntry(entry));
    this.saveSoon();
    this.metaChangedSoon();
    if ((prev?.cover || null) !== (entry.cover || null)) this.artChanged({ songs: [song.id] });
    this.statusChanged();
  }

  setArtist(key, entry, changed) {
    this.artists.set(key, compactEntry(entry));
    this.saveSoon();
    if (changed) this.artChanged({ artists: [key] });
  }

  stale(e) {
    return this.now() - (e.at || 0) > RETRY_MISS_MS || (e.v || 0) < MATCH_VERSION;
  }

  // ---- provider requests -------------------------------------------------------------------------

  async getJson(name, url, prio) {
    await this.throttles[name].wait({ maxWaitMs: MAX_WAIT[prio] ?? Infinity });
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'unavailable' });
    let res;
    try {
      res = await this.fetch(url, { headers: { 'user-agent': this.ua, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw this.failed(name, 'offline', e.cause?.code || e.message);
    }
    if (res.status === 404) {
      this.ok(name);
      return null;
    }
    if (res.status === 429 || res.status === 503) {
      const retry = Number(res.headers.get('retry-after'));
      throw this.failed(name, 'limited', `HTTP ${res.status}`, retry > 0 ? Math.min(600, retry) * 1000 : 0);
    }
    if (!res.ok) throw this.failed(name, 'error', `HTTP ${res.status}`);
    let json;
    try {
      json = await res.json();
    } catch {
      throw this.failed(name, 'error', 'The answer was not JSON');
    }
    const apiError = PROVIDERS[name].apiError?.(json);
    if (apiError) {
      if (apiError.notFound) {
        this.ok(name);
        return null;
      }
      throw this.failed(name, apiError.quota ? 'limited' : 'error', apiError.message);
    }
    this.ok(name);
    return json;
  }

  failed(name, status, message, retryMs = 0) {
    const h = this.health[name];
    h.fails++;
    h.status = status;
    h.lastError = String(message || 'error').slice(0, 200);
    h.at = this.now();
    const base = status === 'offline' ? 30_000 : status === 'limited' ? 5_000 : 60_000;
    const cap = status === 'limited' ? 120_000 : 15 * 60_000;
    this.throttles[name].pause(retryMs || Math.min(cap, base * 2 ** Math.min(8, h.fails - 1)));
    if (h.fails === 1 || h.fails % 10 === 0) log.warn(`${PROVIDERS[name].label}: ${h.lastError} — backing off`);
    this.statusChanged();
    return Object.assign(new Error(`${PROVIDERS[name].label}: ${h.lastError}`), { code: 'unavailable' });
  }

  ok(name) {
    const h = this.health[name];
    if (h.status !== 'ok' || h.fails) {
      h.status = 'ok';
      h.fails = 0;
      this.statusChanged();
    }
  }

  // ---- images ------------------------------------------------------------------------------------

  fileKey(url) {
    return crypto.createHash('sha1').update(url).digest('hex');
  }

  cached(url) {
    const key = this.fileKey(url);
    const f = this.files.get(key);
    if (!f) return null;
    f.used = this.now();
    return { abs: path.join(this.artDir, `${key}.${f.ext}`), type: IMAGE_TYPES[f.ext] };
  }

  /** A cached image of `ref` in any size (medium, large, small), or null. */
  anyImage(ref) {
    const urls = imageUrls(ref);
    if (!urls) return null;
    return this.cached(urls.m) || this.cached(urls.l) || this.cached(urls.s);
  }

  /** The image file for `ref` at `size` ('s' | 'm' | 'l'), downloading it when needed. */
  async image(ref, size = 's', prio = PRIO.visible) {
    const urls = imageUrls(ref);
    const url = urls?.[size];
    if (!url) return null;
    const hit = this.cached(url);
    if (hit) return hit;
    if (!this.enabled()) return null;
    const bad = this.badUrls.get(url);
    if (bad && this.now() - bad < DAY) return null;
    const key = this.fileKey(url);
    let p = this.downloads.get(key);
    if (!p) {
      p = this.download(url, key, prio).catch((e) => {
        log.debug(`image download failed: ${e.message}`);
        return null;
      }).finally(() => this.downloads.delete(key));
      this.downloads.set(key, p);
    }
    return p;
  }

  async download(url, key, prio) {
    let current = url;
    let res = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!allowedImageUrl(current)) {
        this.badUrls.set(url, this.now());
        return null;
      }
      await this.imageThrottle.wait({ maxWaitMs: MAX_WAIT[prio] ?? Infinity });
      res = await this.fetch(current, { redirect: 'manual', headers: { 'user-agent': this.ua, accept: 'image/*' }, signal: AbortSignal.timeout(20_000) });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      res.body?.cancel?.().catch?.(() => {});
      current = new URL(location, current).href;
      res = null;
    }
    if (!res || !res.ok) {
      if (res && [403, 404, 410].includes(res.status)) this.badUrls.set(url, this.now());
      res?.body?.cancel?.().catch?.(() => {});
      return null;
    }
    if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      res.body?.cancel?.().catch?.(() => {});
      return null;
    }
    const buf = await readLimited(res, MAX_IMAGE_BYTES);
    const ext = buf && sniff(buf);
    if (!ext) {
      this.badUrls.set(url, this.now());
      return null;
    }
    const abs = path.join(this.artDir, `${key}.${ext}`);
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
    const prev = this.files.get(key);
    if (prev) {
      this.bytes -= prev.size;
      if (prev.ext !== ext) fsp.unlink(path.join(this.artDir, `${key}.${prev.ext}`)).catch(() => {});
    }
    this.files.set(key, { ext, size: buf.length, used: this.now() });
    this.bytes += buf.length;
    this.evict();
    return { abs, type: IMAGE_TYPES[ext] };
  }

  /** Keeps the image cache under `artwork.maxCacheMB` (least recently used files go first). */
  evict() {
    const max = Math.max(20, Number(this.cfg().maxCacheMB) || 3072) * 1024 * 1024;
    if (this.bytes <= max) return;
    const target = max * 0.9;
    const list = [...this.files].filter(([, f]) => !f.pinned).sort((a, b) => a[1].used - b[1].used);
    for (const [key, f] of list) {
      if (this.bytes <= target) break;
      this.files.delete(key);
      this.bytes -= f.size;
      fsp.unlink(path.join(this.artDir, `${key}.${f.ext}`)).catch(() => {});
    }
    this.statusChanged();
  }

  // ---- lookups -----------------------------------------------------------------------------------------

  /** Providers still to ask for a song (empty when it is known or everything was tried). */
  songChain(key) {
    const e = this.songs.get(key);
    if (e && (e.manual || !e.miss)) return [];
    const tried = e && !this.stale(e) ? new Set(e.tried || []) : new Set();
    return SONG_CHAIN.filter((n) => this.providerOn(n) && !tried.has(n));
  }

  artistChain(key, want = 'picture') {
    const artist = this.catalog.artist(key);
    const e = artist ? this.artistEntry(artist) : this.artists.get(key);
    const tried = e && !this.stale(e) ? new Set(e.tried || []) : new Set();
    const steps = [];
    if (this.providerOn('deezer') && !tried.has('deezer') && !e?.picture) steps.push('deezer');
    if (this.providerOn('theaudiodb') && !tried.has('theaudiodb') && (want === 'all' || !e?.picture)) steps.push('theaudiodb');
    if (want === 'all' && this.providerOn('fanarttv') && !tried.has('fanarttv')) steps.push('fanarttv');
    return steps;
  }

  /**
   * Queues a lookup. Resolves to true (found something), false (nothing found) or null
   * (not asked now: disabled, providers busy/offline, or dropped from the queue).
   * @param {'song'|'artist'} kind
   * @param {object} obj catalog song or artist
   * @param {'now'|'visible'|'crawl'} prio
   * @param {'picture'|'all'} [want] artists: just a picture, or fanart/logos too
   */
  request(kind, obj, prio = 'visible', want = 'picture') {
    if (!this.enabled() || !obj?.key) return Promise.resolve(null);
    const p = PRIO[prio] ?? PRIO.visible;
    const id = `${kind}:${obj.key}`;
    let job = this.jobs.get(id);
    if (job) {
      if (kind === 'artist' && want === 'all' && job.want !== 'all') job.upgrade = true;
      if (p < job.prio) this.reprioritize(job, p);
      return job.promise;
    }
    const chain = kind === 'song' ? this.songChain(obj.key) : this.artistChain(obj.key, want);
    if (!chain.length) {
      if (kind === 'song') return Promise.resolve(this.songs.get(obj.key)?.cover ? true : this.songs.has(obj.key) ? false : null);
      const a = this.artists.get(obj.key);
      return Promise.resolve(a ? !!(a.picture || a.fanart?.length || a.logo) : null);
    }
    job = { id, kind, key: obj.key, obj, prio: p, want, chain, queued: null, found: false, skipped: false };
    job.promise = new Promise((resolve) => { job.resolve = resolve; });
    this.jobs.set(id, job);
    if (p === PRIO.crawl) this.crawl.inFlight++;
    this.enqueue(job);
    return job.promise;
  }

  enqueue(job) {
    const name = job.chain[0];
    const q = this.queues[name][job.prio];
    if (job.prio === PRIO.visible) {
      q.unshift(job);
      while (q.length > VISIBLE_CAP) {
        const old = q.pop();
        old.queued = null;
        this.settle(old, null);
      }
    } else {
      q.push(job);
    }
    job.queued = name;
    this.pump(name);
  }

  reprioritize(job, p) {
    if (job.prio === PRIO.crawl) this.crawl.inFlight--;
    if (job.queued) {
      const q = this.queues[job.queued][job.prio];
      const i = q.indexOf(job);
      if (i >= 0) q.splice(i, 1);
      job.prio = p;
      job.queued = null;
      this.enqueue(job);
    } else {
      job.prio = p; // running: applies from the next provider on
    }
  }

  pump(name) {
    const workers = PROVIDERS[name].workers || 1;
    while (!this.closed && this.running[name] < workers) {
      const job = this.takeJob(name);
      if (!job) break;
      this.running[name]++;
      const crawl = job.prio === PRIO.crawl;
      if (crawl) this.runningCrawl[name]++;
      this.run(job, name).finally(() => {
        this.running[name]--;
        if (crawl) this.runningCrawl[name]--;
        this.pump(name);
      });
    }
  }

  takeJob(name) {
    for (const q of this.queues[name]) {
      if (q.length) {
        const job = q.shift();
        job.queued = null;
        return job;
      }
    }
    return null;
  }

  async run(job, name) {
    let result;
    try {
      result = job.kind === 'song' ? await this.songStep(job, name) : await this.artistStep(job, name);
    } catch (e) {
      if (e.code !== 'unavailable' && e.code !== 'busy') log.warn(`${name} lookup of ${job.key} failed:`, e.message);
      result = 'unavailable';
    }
    if (this.closed) return this.settle(job, null);
    if (result === 'found') return this.settle(job, true);
    job.chain.shift();
    if (result === 'unavailable') job.skipped = true;
    // Busy providers are skipped by urgent lookups; the crawler asks them again later.
    if (job.chain.length && (result === 'next' || job.prio < PRIO.crawl)) return this.enqueue(job);
    this.settle(job, job.found ? true : job.skipped ? null : false);
  }

  settle(job, value) {
    if (this.jobs.get(job.id) !== job) return;
    this.jobs.delete(job.id);
    if (job.prio === PRIO.crawl) {
      this.crawl.inFlight--;
      this.crawl.recent.push(this.now());
    }
    job.resolve(value);
    if (job.upgrade && !this.closed) this.request('artist', job.obj, 'now', 'all');
    this.statusChanged();
  }

  async songStep(job, name) {
    const prov = PROVIDERS[name];
    const song = job.obj;
    const q = songQuery(song);
    let best = null;
    for (const url of prov.songUrls(q)) {
      const json = await this.getJson(name, url, job.prio);
      best = pickBest(json ? prov.parseSongs(json) : [], q);
      if (best) break;
    }
    const c = best?.candidate;
    if (c && !c.cover && c.covers?.length) {
      // Cover Art Archive: take the first release group that really has a front cover.
      for (const ref of c.covers) {
        if (await this.image(ref, 's', job.prio)) {
          c.cover = ref;
          break;
        }
      }
    }
    const prev = this.songs.get(song.key);
    if (prev && (prev.manual || !prev.miss)) return 'found'; // chosen by the host meanwhile
    if (!c?.cover) {
      const fresh = prev?.miss && !this.stale(prev);
      const tried = new Set(fresh ? prev.tried || [] : []);
      tried.add(name);
      const entry = { miss: true, tried: [...tried], at: this.now(), v: MATCH_VERSION };
      // A match without a cover still tells us the year and genre (decade browsing).
      entry.year = c?.year || (fresh ? prev.year : 0);
      entry.genre = c?.genre || (fresh ? prev.genre : '');
      this.setSong(song, entry);
      return 'next';
    }
    let album = null;
    if (prov.albumUrl && c.albumId) {
      album = await this.album(name, c.albumId, job.prio).catch(() => null);
    }
    this.setSong(song, {
      p: name,
      id: c.id,
      cover: c.cover,
      album: c.album,
      albumId: c.albumId,
      genre: album?.genre || c.genre,
      year: album?.year || c.year,
      explicit: c.explicit,
      rank: c.rank,
      confidence: best.confidence,
      at: this.now(),
      v: MATCH_VERSION,
    });
    this.harvestArtistPicture(song, c);
    job.found = true;
    if (job.prio === PRIO.crawl) await this.image(c.cover, 's', job.prio); // list thumbnails work offline later
    return 'found';
  }

  async album(name, id, prio) {
    const key = `${name}:${id}`;
    if (this.albums.has(key)) return this.albums.get(key);
    const url = PROVIDERS[name].albumUrl(id);
    if (!url) return null;
    const json = await this.getJson(name, url, prio);
    const info = json ? PROVIDERS[name].parseAlbum(json) : null;
    const rec = compactEntry({ genre: info?.genre, year: info?.year, type: info?.type });
    this.albums.set(key, rec);
    this.saveSoon();
    return rec;
  }

  /** Deezer track results carry the artist's picture: keep it when the credit clearly matches. */
  harvestArtistPicture(song, c) {
    if (!c.artistPicture) return;
    for (const key of song.artistKeys || []) {
      const artist = this.catalog.artist(key);
      const e = artist && this.artistEntry(artist);
      if (!artist || e?.picture) continue;
      // The track's artist must be the one we'd search for: "Sam & Dave" for Sam, but a track
      // credited to "Elton John & Kiki Dee" is not a picture of Elton John alone.
      const name = this.searchName(artist);
      if (artistNameScore(c.artist, name) < 0.9) continue;
      this.setArtist(key, { ...(e || { at: this.now(), v: MATCH_VERSION }), picture: c.artistPicture, pictureFor: name }, true);
    }
  }

  /**
   * The name artist databases are searched for (see artistSearchName), cached per catalog version.
   * Always worked out from the current catalog's artist: a queued lookup may hold an older one.
   */
  searchName(artist) {
    const { catalog } = this;
    const credits = (a) => (a.songIds || []).map((id) => catalog.song(id)?.artist).filter(Boolean);
    const current = catalog.artist(artist.key);
    if (!current) return artistSearchName(artist, credits(artist)); // not in the library (any more)
    const memo = this._searchNames;
    if (memo?.catalog !== catalog || memo.version !== catalog.version) this._searchNames = { catalog, version: catalog.version, map: new Map() };
    const map = this._searchNames.map;
    let name = map.get(current.key);
    if (name === undefined) {
      name = artistSearchName(current, credits(current));
      map.set(current.key, name);
    }
    return name;
  }

  /**
   * The stored entry of a catalog artist. What was found by searching for another name (a band
   * member's own name before, or the library changed) is dropped first, and so is a picture from
   * a matched song that was accepted for another name. Entries saved without `n` were searched
   * for the artist's own name when they have anything only a name search gives.
   */
  artistEntry(artist) {
    const current = this.catalog.artist(artist.key) || artist;
    const e = this.artists.get(current.key);
    if (!e) return null;
    const name = this.searchName(current);
    const searched = e.n || (e.tried?.length || SEARCHED.some((k) => e[k]?.length) ? current.name : '');
    const searchOk = searched && sameSearchName(searched, name);
    const pictureOk = !e.pictureFor || sameSearchName(e.pictureFor, name);
    if ((!searched || searchOk) && pictureOk) return e;
    let next = searchOk ? { ...e } : e.pictureFor ? { picture: e.picture, pictureFor: e.pictureFor } : {};
    if (!pictureOk) {
      // Deezer may have been asked while that picture was there: ask again.
      const { picture, pictureFor, tried, ...rest } = next;
      next = rest;
    }
    this.setArtist(current.key, next, true);
    return this.artists.get(current.key);
  }

  /** Searches provider `name`'s artist database for `query`; null when no artist matches. */
  searchArtist(name, query, prio) {
    return memoPromise(this.nameSearches, `${name}|${compact(query)}`, async () => {
      const prov = PROVIDERS[name];
      for (const url of prov.artistUrls(query, { key: this.cfg().theaudiodbKey })) {
        const json = await this.getJson(name, url, prio);
        const info = pickArtist(json ? prov.parseArtists(json) : [], query);
        if (info) return info;
      }
      return null;
    });
  }

  async artistStep(job, name) {
    // The current catalog's artist and entry: job.obj may be from before a library change.
    const artist = this.catalog.artist(job.key);
    if (!artist) return 'unavailable'; // no longer in the library
    const start = this.artistEntry(artist);
    if (name === 'theaudiodb' && job.want !== 'all' && start?.picture) return 'next'; // got one already
    const query = this.searchName(artist);
    const mbid = start?.mbid;
    // Fanart.tv is asked by MusicBrainz id, which comes from TheAudioDB: not asked before that answer.
    const audiodbAsked = start && !this.stale(start) && start.tried?.includes('theaudiodb');
    if (name === 'fanarttv' && !mbid && !audiodbAsked && this.providerOn('theaudiodb')) return 'unavailable';
    let info = null;
    if (name === 'fanarttv') {
      const url = mbid ? PROVIDERS.fanarttv.artistUrl(mbid, this.cfg().fanartKey) : null;
      info = url ? PROVIDERS.fanarttv.parseArtist(await this.getJson(name, url, job.prio)) : null;
    } else {
      info = await this.searchArtist(name, query, job.prio);
    }
    // The library may have changed meanwhile: an answer for a name that no longer applies is
    // not kept (asked again later), and it goes into the entry as it is now.
    const current = this.catalog.artist(job.key);
    if (!current || !sameSearchName(query, this.searchName(current))) return 'unavailable';
    const prev = this.artistEntry(current);
    if (name === 'fanarttv' && prev?.mbid !== mbid) return 'unavailable';
    const fresh = prev && !this.stale(prev);
    const e = { ...(prev || {}), tried: fresh ? [...(prev.tried || [])] : [] };
    const signature = (x) => JSON.stringify([x.picture, x.fanart, x.logo, x.cutout, x.banner, x.mbid, x.genre]);
    const before = signature(e);
    e.n = query;
    if (info && name === 'fanarttv') {
      if (info.fanart.length) e.fanart = [...new Set([...(e.fanart || []), ...info.fanart])].slice(0, 8);
      e.logo ||= info.logo;
      e.picture ||= info.picture;
      e.banner ||= info.banner;
    } else if (info) {
      e.picture ||= info.picture;
      if (info.fanart?.length) e.fanart = [...new Set([...(e.fanart || []), ...info.fanart])].slice(0, 8);
      e.logo ||= info.logo;
      e.cutout ||= info.cutout;
      e.banner ||= info.banner;
      e.mbid ||= info.mbid;
      e.genre ||= info.genre;
    }
    if (!e.tried.includes(name)) e.tried.push(name);
    e.at = this.now();
    e.v = MATCH_VERSION;
    const changed = signature(e) !== before;
    this.setArtist(current.key, e, changed);
    if (changed) job.found = true;
    if (job.want !== 'all' && e.picture) return 'found';
    return 'next';
  }

  // ---- priorities from the party ----------------------------------------------------------------------

  /** Current and upcoming songs: look them (and the singer's artists) up first, prefetch big images. */
  focus(songs = []) {
    const list = songs.filter(Boolean);
    const sig = list.map((s) => s.id).join(',');
    if (sig === this.lastFocus || !this.enabled()) return;
    this.lastFocus = sig;
    list.forEach((song, i) => {
      this.request('song', song, 'now').then((found) => {
        const e = this.songs.get(song.key);
        if (found && e?.cover) this.image(e.cover, 'm', PRIO.now);
      });
      if (i > 1) return;
      for (const key of song.artistKeys || []) {
        const artist = this.catalog.artist(key);
        if (!artist) continue;
        this.request('artist', artist, 'now', 'all').then(() => {
          // Only what the TV will show (artFor): not a band member's art of another act.
          const art = this.artFor(song);
          const a = this.artists.get(key);
          if (art.fanart === key && a?.fanart?.[0]) this.image(a.fanart[0], 'l', PRIO.now);
          if (art.logo === key && a?.logo) this.image(a.logo, 'l', PRIO.now);
        });
      }
    });
  }

  /**
   * The song's artists whose fanart and logo fit it, best first: art found for one of the song's
   * own acts ("Peter & Gordon"), then art found under a performer's own name ("Elton John" for
   * "Elton John & Kiki Dee"). A band member holding another act's art is left out: "Peter" is
   * looked up as "Peter, Paul & Mary", which is not who sings "A World Without Love".
   */
  songArtists(song) {
    const acts = actsOf(song.artist);
    const exact = [];
    const own = [];
    for (const key of song.artistKeys || []) {
      const e = this.artists.get(key);
      const artist = this.catalog.artist(key);
      if (!e || !artist) continue;
      const name = e.n || artist.name;
      if (acts.some((act) => sameSearchName(act, name))) exact.push(key);
      else if (sameSearchName(name, artist.name)) own.push(key);
    }
    return [...exact, ...own];
  }

  /** What the TV can show for a song: { cover, fanart: artistKey?, logo: artistKey? }. */
  artFor(song) {
    if (!song) return null;
    const out = { cover: !!this.songs.get(song.key)?.cover };
    for (const key of this.songArtists(song)) {
      const a = this.artists.get(key);
      if (a?.fanart?.length && !out.fanart) {
        out.fanart = key;
        out.fanartCount = a.fanart.length;
      }
      if (a?.logo && !out.logo) out.logo = key;
    }
    return out;
  }

  /** Song metadata as shown in the song details. */
  publicSongMeta(key) {
    const e = this.songs.get(key);
    if (!e) return null;
    return compactEntry({
      provider: e.p === 'custom' ? 'your own picture' : e.p ? PROVIDERS[e.p]?.label || e.p : '',
      album: e.album,
      year: e.year,
      genre: e.genre,
      explicit: e.explicit,
      confidence: e.confidence,
      manual: e.manual,
      cover: !!e.cover,
      miss: e.miss,
    });
  }

  publicArtist(key) {
    const e = this.artists.get(key);
    if (!e) return null;
    return compactEntry({ picture: !!e.picture, fanart: e.fanart?.length || 0, logo: !!e.logo, cutout: !!e.cutout, banner: !!e.banner, genre: e.genre });
  }

  // ---- serving -----------------------------------------------------------------------------------

  /** Sends the cover of `song`; false when there is none (the caller sends a placeholder). */
  async serveSong(ctx, song) {
    const e = this.songs.get(song.key);
    if (this.songChain(song.key).length) this.request('song', song, 'visible');
    if (!e?.cover) return false;
    const img = (await this.image(e.cover, sizeKey(ctx.query.get('s')), PRIO.visible)) || this.anyImage(e.cover);
    if (!img) return false;
    await sendFile(ctx.req, ctx.res, img.abs, { contentType: img.type, cacheControl: 'public, max-age=3600' });
    return true;
  }

  /** ?type=picture|fanart|logo|cutout|banner (&i=n for the n-th fanart). */
  async serveArtist(ctx, artist) {
    const type = ARTIST_TYPES.includes(ctx.query.get('type')) ? ctx.query.get('type') : 'picture';
    const want = type === 'picture' ? 'picture' : 'all';
    if (this.artistChain(artist.key, want).length) this.request('artist', artist, 'visible', want);
    const e = this.artists.get(artist.key);
    let ref = null;
    if (type === 'fanart') {
      const list = e?.fanart || [];
      ref = list.length ? list[Math.abs(Math.trunc(Number(ctx.query.get('i')) || 0)) % list.length] : null;
    } else {
      ref = e?.[type] || null;
    }
    if (!ref && type === 'picture') ref = this.artistCoverFallback(artist);
    if (!ref) return false;
    const size = sizeKey(ctx.query.get('s'), type === 'picture' ? 'm' : 'l');
    const img = (await this.image(ref, size, PRIO.visible)) || this.anyImage(ref);
    if (!img) return false;
    await sendFile(ctx.req, ctx.res, img.abs, { contentType: img.type, cacheControl: 'public, max-age=3600' });
    return true;
  }

  /** No artist picture: use the cover of their most popular song that has one. */
  artistCoverFallback(artist) {
    let best = null;
    let bestPop = -1;
    for (const id of artist.songIds || []) {
      const s = this.catalog.song(id);
      const e = s && this.songs.get(s.key);
      if (!e?.cover) continue;
      const pop = this.catalog.popularity(s);
      if (pop > bestPop) { best = e.cover; bestPop = pop; }
    }
    return best;
  }

  // ---- the host's "fix artwork" ---------------------------------------------------------------------------

  /** Candidates from every enabled song provider (loosest search), best first. */
  async candidates(song) {
    if (!this.enabled()) throw new UserError('Online artwork is turned off in the settings.');
    const q = songQuery(song);
    const all = [];
    const errors = [];
    for (const name of SONG_CHAIN) {
      if (!this.providerOn(name)) continue;
      const prov = PROVIDERS[name];
      const urls = prov.songUrls(q);
      try {
        const json = await this.getJson(name, urls[urls.length - 1], PRIO.now);
        for (const c of rankCandidates(json ? prov.parseSongs(json) : [], q)) {
          if (!c.cover && c.covers?.length) c.cover = c.covers[0];
          if (c.cover) all.push(c);
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    all.sort((a, b) => b.confidence - a.confidence);
    const list = all.slice(0, 24);
    this.candidateCache.set(song.key, list);
    const cur = this.songs.get(song.key);
    return {
      items: list.map((c) => ({
        id: `${c.provider}:${c.id}`,
        provider: PROVIDERS[c.provider].label,
        title: c.title,
        version: c.version || '',
        artist: c.artist,
        album: c.album || '',
        year: c.year || 0,
        duration: Math.round(c.duration || 0),
        confidence: c.confidence,
        thumb: `/api/art/candidate/${encodeURIComponent(song.id)}/${encodeURIComponent(`${c.provider}:${c.id}`)}`,
        current: !!cur && cur.p === c.provider && cur.id === c.id,
      })),
      errors,
    };
  }

  /** Thumbnail of a "fix artwork" candidate, downloaded by the server (the browser never goes online). */
  async serveCandidate(ctx, song, candidateId) {
    const c = (this.candidateCache.get(song.key) || []).find((x) => `${x.provider}:${x.id}` === candidateId);
    const img = c ? await this.image(c.cover, 's', PRIO.now) : null;
    if (!img) return false;
    await sendFile(ctx.req, ctx.res, img.abs, { contentType: img.type, cacheControl: 'private, max-age=600' });
    return true;
  }

  async choose(song, candidateId) {
    const c = (this.candidateCache.get(song.key) || []).find((x) => `${x.provider}:${x.id}` === candidateId);
    if (!c) throw new UserError('That choice has expired — search again.', { code: 'expired' });
    const album = PROVIDERS[c.provider].albumUrl && c.albumId ? await this.album(c.provider, c.albumId, PRIO.now).catch(() => null) : null;
    this.setSong(song, {
      p: c.provider, id: c.id, cover: c.cover, album: c.album, albumId: c.albumId,
      genre: album?.genre || c.genre, year: album?.year || c.year, explicit: c.explicit, rank: c.rank,
      confidence: 1, manual: true, at: this.now(), v: MATCH_VERSION,
    });
    await this.image(c.cover, 's', PRIO.now);
    return { ok: true };
  }

  /** Cache keys of covers the host uploaded (never evicted). */
  customKeys() {
    const keys = new Set();
    for (const e of this.songs.values()) if (e.p === 'custom' && e.cover) keys.add(this.fileKey(imageUrls(e.cover).s));
    return keys;
  }

  /** The host's own picture as the cover (stored with the image cache, never evicted). */
  async setCustomCover(song, buf) {
    const ext = sniff(buf);
    if (!ext) throw new UserError('Send a JPEG, PNG, WebP or GIF picture.', { status: 415, code: 'bad_type' });
    const url = `custom://${encodeURIComponent(song.key)}/${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}`;
    const key = this.fileKey(url);
    const abs = path.join(this.artDir, `${key}.${ext}`);
    await fsp.mkdir(this.artDir, { recursive: true });
    await fsp.writeFile(abs, buf);
    const prevFile = this.files.get(key);
    if (prevFile) this.bytes -= prevFile.size;
    this.files.set(key, { ext, size: buf.length, used: this.now(), pinned: true });
    this.bytes += buf.length;
    const prev = this.songs.get(song.key);
    this.setSong(song, {
      p: 'custom', cover: `url:${url}`, album: prev?.album, genre: prev?.genre, year: prev?.year, explicit: prev?.explicit, rank: prev?.rank,
      confidence: 1, manual: true, at: this.now(), v: MATCH_VERSION,
    });
    return { ok: true };
  }

  /** "No cover for this song": the placeholder is shown and the crawler leaves it alone. */
  setNone(song) {
    this.setSong(song, { miss: true, manual: true, at: this.now(), v: MATCH_VERSION });
    return { ok: true };
  }

  /** Forget what we know and look the song up again now. */
  async refresh(song) {
    const prev = this.songs.get(song.key);
    this.songs.delete(song.key);
    if (prev?.cover) this.artChanged({ songs: [song.id] });
    const found = await this.request('song', song, 'now');
    return { found: !!found, meta: this.publicSongMeta(song.key) };
  }

  /** Forget every miss (e.g. after the internet came back) and wake the providers. */
  retryMisses() {
    let n = 0;
    for (const [k, e] of this.songs) {
      if (e.miss && !e.manual) {
        this.songs.delete(k);
        n++;
      }
    }
    for (const t of Object.values(this.throttles)) t.resume();
    for (const h of Object.values(this.health)) Object.assign(h, { status: 'ok', fails: 0 });
    this.crawl.list = null;
    this.crawl.artistList = null;
    this.saveSoon();
    this.metaChangedSoon();
    this.statusChanged();
    return { cleared: n };
  }

  settingsChanged() {
    this.crawl.list = null;
    this.crawl.artistList = null;
    this._status = null;
    this.statusChanged();
  }

  // ---- background crawler -------------------------------------------------------------------------------

  crawlTick() {
    this.crawl.timer = null;
    if (this.closed) return;
    let delay = 1000;
    const primary = SONG_CHAIN.find((n) => this.providerOn(n));
    if (!this.enabled() || !this.cfg().crawl || !primary) {
      this.setCrawlState(!this.enabled() || !primary ? 'off' : 'paused');
      delay = 5000;
    } else if (this.health[primary].status !== 'ok' && this.throttles[primary].pausedFor() > 0) {
      this.setCrawlState('waiting');
      delay = Math.min(30_000, this.throttles[primary].pausedFor() + 500);
    } else {
      delay = this.fillCrawl(primary);
    }
    this.crawl.timer = setTimeout(() => this.crawlTick(), delay);
    this.crawl.timer.unref?.();
  }

  setCrawlState(state) {
    if (this.crawl.state === state) return;
    this.crawl.state = state;
    this.statusChanged();
  }

  fillCrawl(primary) {
    const c = this.crawl;
    const now = this.now();
    if (!c.list || c.version !== this.catalog.version) {
      if (now < c.restartAt) return Math.min(30_000, c.restartAt - now);
      c.list = this.catalog.popular({ limit: Infinity }).items;
      c.artistList = [...this.catalog.artistList].sort((a, b) => b.trackCount - a.trackCount);
      c.index = 0;
      c.artistIndex = 0;
      c.version = this.catalog.version;
      c.requested = 0;
    }
    // Keep the primary provider busy, but don't let fallback queues (1 request/s) grow without bound.
    const load = () => this.queues[primary][PRIO.crawl].length + this.runningCrawl[primary];
    const backlog = () => SONG_CHAIN.filter((n) => n !== primary).reduce((sum, n) => sum + this.queues[n][PRIO.crawl].length, 0);
    while (load() < 6 && backlog() < 200 && c.index < c.list.length) {
      const song = c.list[c.index++];
      if (!this.songChain(song.key).length) continue;
      c.requested++;
      this.request('song', song, 'crawl');
    }
    if (c.index >= c.list.length) {
      while (load() < 4 && c.artistIndex < c.artistList.length) {
        const artist = c.artistList[c.artistIndex++];
        if (!this.artistChain(artist.key, 'picture').length) continue;
        c.requested++;
        this.request('artist', artist, 'crawl', 'picture');
      }
    }
    const done = c.index >= c.list.length && c.artistIndex >= c.artistList.length;
    if (done && c.inFlight <= 0) {
      // A pass ended: look again later for new songs or lookups that were skipped (offline).
      this.setCrawlState(c.requested ? 'running' : 'done');
      c.list = null;
      c.restartAt = now + (c.requested ? 60_000 : 30 * 60_000);
      return 1000;
    }
    this.setCrawlState('running');
    return 500;
  }

  // ---- status ------------------------------------------------------------------------------------------

  status() {
    const now = this.now();
    if (this._status && now - this._status.at < 1000) return this._status.value;
    let found = 0;
    let missed = 0;
    let pending = 0;
    for (const s of this.catalog.songList) {
      const e = this.songs.get(s.key);
      if (e?.cover) found++;
      else if (this.songChain(s.key).length) pending++;
      else missed++;
    }
    let pictures = 0;
    for (const a of this.catalog.artistList) if (this.artists.get(a.key)?.picture) pictures++;
    const recent = this.crawl.recent.filter((t) => now - t < 5 * 60_000);
    this.crawl.recent = recent;
    const perMin = recent.length ? recent.length / Math.max(1, Math.min(5, (now - recent[0]) / 60_000)) : 0;
    const cfg = this.cfg();
    const value = {
      enabled: !!cfg.enabled,
      crawl: !!cfg.crawl,
      state: this.crawl.state,
      songs: { total: this.catalog.songList.length, found, missed, pending },
      artists: { total: this.catalog.artistList.length, pictures },
      perMin: Math.round(perMin),
      etaSec: perMin > 0 && pending ? Math.round((pending / perMin) * 60) : null,
      queued: Object.values(this.queues).reduce((n, qs) => n + qs.reduce((m, q) => m + q.length, 0), 0),
      providers: Object.values(PROVIDERS).map((p) => ({
        name: p.name,
        label: p.label,
        kinds: p.kinds,
        on: this.providerOn(p.name),
        status: this.health[p.name].status,
        lastError: this.health[p.name].lastError,
        pausedSec: Math.ceil(this.throttles[p.name].pausedFor() / 1000),
      })),
      cache: { files: this.files.size, mb: Math.round((this.bytes / 1048576) * 10) / 10, maxMb: Number(cfg.maxCacheMB) || 3072 },
    };
    this._status = { at: now, value };
    return value;
  }
}
