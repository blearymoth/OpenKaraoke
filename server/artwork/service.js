// Artwork & metadata service (PLAN §12): looks songs and artists up with the online
// providers, caches metadata in data/meta.json and images in data/art/, and serves them.
//
// - Every provider has its own queue (3 priorities: now > visible > crawl), worker count and
//   rate limiter; errors back off exponentially and never count as "not found". Urgent lookups
//   never wait for crawl jobs: those only use idle workers and don't sit out a back-off.
// - A song lookup walks SONG_CHAIN (Deezer → MusicBrainz/CAA → iTunes) until one matches;
//   misses remember which providers were asked and are retried after 30 days.
// - An artist lookup collects a picture (Deezer), fanart/logo/cutout (TheAudioDB, Fanart.tv).
// - Image downloads have their own prioritised queue; an image host that fails is left alone
//   for a while (the cached sizes or the placeholder are served meanwhile).
// - The background crawler walks the catalogue, most popular songs first, a slice per tick; songs
//   whose next provider is in a long back-off wait for the next pass.
//
// Events: 'art' { songs: [songId], artists: [artistKey] } — images became available/changed;
//         'status' — crawler/provider status changed (throttled).
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson } from '../util/jsonfile.js';
import { Throttle } from '../util/throttle.js';
import { Lru, memoPromise } from '../util/lru.js';
import { RateLimiter } from '../util/ratelimit.js';
import { UserError } from '../util/errors.js';
import { sendFile } from '../http/static.js';
import { logger } from '../util/log.js';
import { PROVIDERS, SONG_CHAIN, ARTIST_CHAIN, USER_AGENT, imageUrls, allowedImageUrl, placeholderRef } from './providers.js';
import { songQuery, pickBest, pickArtist, rankCandidates, artistNameScore, artistSearchName, sameSearchName, actsOf } from './match.js';
import { compact } from '../../shared/text.js';

const log = logger('artwork');

/** Bump when matching improves: older misses are retried. */
export const MATCH_VERSION = 2;
const DAY = 86_400_000;
const RETRY_MISS_MS = 30 * DAY;
export const PRIO = { now: 0, visible: 1, crawl: 2 };
// How long a lookup may wait for a rate-limited provider. Longer waits mean a back-off: urgent
// lookups try the next provider, crawl jobs step aside (see CRAWL_HOLD_MS).
const MAX_WAIT = [20_000, 5_000, 10_000];
const CRAWL_HOLD_MS = 30_000; // crawl jobs wait (queued) through shorter back-offs; longer ones drop them until the next pass
const CRAWL_SLICE = 1000; // catalogue entries the crawler looks at per tick (the event loop runs in between)
const VISIBLE_CAP = 120; // on-demand lookups kept (newest first)
const IMAGE_WORKERS = 4; // parallel image downloads (urgent ones may use as many again)
const IMAGE_VISIBLE_CAP = 60; // on-demand image downloads kept (newest first), ≈5 s of downloads
const IMAGE_TIMEOUT_MS = 20_000; // a whole download, redirects included
const HOST_BACKOFF_MS = [30_000, 10 * 60_000]; // an image host that failed: first and longest pause
const BIG_FILE = 64 * 1024; // cached images above this size are evicted before list thumbnails…
const RECENT_MS = 10 * 60_000; // …unless used this recently (just shown, prefetched for the TV): those go last
const IN_USE_MS = 60_000; // images used this recently are being sent: never evicted
const SAVE_MS = 10_000; // meta.json is written this long after a change…
const SAVE_CRAWL_MS = 120_000; // …or this long while the crawler is filling it
const SAVE_SLICE = 2000; // entries serialised per slice (the event loop runs in between)
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const ARTIST_TYPES = ['picture', 'fanart', 'logo', 'cutout', 'banner'];
// What an artist entry gets only from searching an artist database by name (see artistEntry).
const SEARCHED = ['fanart', 'logo', 'cutout', 'banner', 'mbid', 'genre'];
const FILE_RE = /^([0-9a-f]{40})\.(jpg|png|webp|gif)$/;
/** Song metadata the catalog ranks, filters or shows (a change must reach its caches). */
const CATALOG_FIELDS = ['cover', 'rank', 'explicit', 'genre', 'year'];

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

/** "Couldn't ask right now" (offline, back-off, turned off): never recorded as "not found". */
const unavailable = (message) => Object.assign(new Error(message), { code: 'unavailable' });
const busy = (message) => Object.assign(new Error(message), { code: 'busy' });

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function writeAll(fh, text) {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length;) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
}

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
    this.indexing = null; // the image index being read from disk (image() waits for it)
    this.downloads = new Map(); // sha1(url) → { url, key, prio, queued, promise }
    this.imageQueues = [[], [], []];
    this.imageRunning = 0;
    this.imageRunningCrawl = 0;
    this.imageHosts = new Map(); // image host → { fails, until } while it is failing
    this.badUrls = new Map(); // url → time of a 404 (not asked again for a day)
    // Guests (not the host) may start only so many lookups and downloads (per address).
    this.guestLimit = new RateLimiter({ capacity: 120, perMs: 60_000 });
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
    this.crawl = { timer: null, order: null, list: null, artistList: null, index: 0, artistIndex: 0, version: -1, requested: 0, heldUntil: 0, inFlight: 0, state: 'idle', recent: [], restartAt: 0 };
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
      this.dropUntrusted();
    }
    this.installMeta();
    this.library.on('changed', () => {
      this.installMeta();
      this.wakeCrawl(); // new songs: a new pass now, not after the pause between passes
    });
    this.loaded = true;
    // Serving starts right away; image() waits for the index so cached files aren't missed.
    this.indexing = this.indexFiles()
      .catch((e) => log.warn('could not index the artwork cache', e.message))
      .finally(() => { this.indexing = null; });
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

  /**
   * Art saved by older versions that can't be trusted is looked up again: Deezer's "no picture"
   * images (not recognised before), and artist pictures that came with a matched song before
   * `pictureFor` (version 1 gave the track artist's picture to every performer in its credit:
   * "Elton John" got the "Elton John & Kiki Dee" one). Those carry no mark, but Deezer's
   * pictures only came that way or from a Deezer search, which `tried` records.
   */
  dropUntrusted() {
    let n = 0;
    for (const [key, e] of this.songs) {
      if (e.manual || !placeholderRef(e.cover)) continue;
      this.songs.set(key, compactEntry({ miss: true, year: e.year, genre: e.genre, v: MATCH_VERSION })); // no `at`: retried
      n++;
    }
    for (const [key, e] of this.artists) {
      const songPicture = (e.v || 0) < MATCH_VERSION && !e.pictureFor && String(e.picture || '').startsWith('dz:') && !e.tried?.includes('deezer');
      if (!songPicture && !placeholderRef(e.picture)) continue;
      // No `at`: every provider is asked again (Deezer and TheAudioDB for a picture too), for the
      // current search name. `tried` stays: it tells artistEntry that the rest was found by
      // searching for the artist's name.
      const { picture, pictureFor, at, ...rest } = e;
      this.artists.set(key, rest);
      n++;
    }
    if (n) {
      log.info(`${n} unchecked pictures dropped`);
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
    const index = async (name) => {
      if (name.endsWith('.tmp')) {
        fsp.unlink(path.join(this.artDir, name)).catch(() => {});
        return;
      }
      const m = FILE_RE.exec(name);
      if (!m || this.files.has(m[1])) return;
      try {
        const st = await fsp.stat(path.join(this.artDir, name));
        if (this.files.has(m[1])) return; // downloaded meanwhile
        this.files.set(m[1], { ext: m[2], size: st.size, used: st.mtimeMs, pinned: pinned.has(m[1]) || undefined });
        this.bytes += st.size;
      } catch { /* removed meanwhile */ }
    };
    for (let i = 0; i < names.length; i += 64) await Promise.all(names.slice(i, i + 64).map(index));
    this.evict();
  }

  async close() {
    this.closed = true;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    clearTimeout(this.crawl.timer);
    for (const job of [...this.jobs.values()]) this.settle(job, null);
    for (const qs of Object.values(this.queues)) for (const q of qs) q.length = 0;
    for (const q of this.imageQueues) for (const d of q.splice(0)) this.dropImage(d, unavailable('closed'));
    for (const t of [...Object.values(this.throttles), this.imageThrottle]) t.cancel();
    if (this.dirty) this.save();
    await this.saving?.catch((e) => log.error('could not save meta.json', e));
  }

  // ---- persistence -------------------------------------------------------------------------

  /** Writes meta.json after `ms` (an earlier pending write is kept; a later one is brought forward). */
  saveSoon(ms = this.crawl.state === 'running' ? SAVE_CRAWL_MS : SAVE_MS) {
    this.dirty = true;
    const due = Date.now() + ms;
    if (this.timers.save && this.saveDue <= due) return;
    clearTimeout(this.timers.save);
    this.saveDue = due;
    this.timers.save = setTimeout(() => {
      this.timers.save = null;
      this.save().catch((e) => log.error('could not save meta.json', e));
    }, ms);
    this.timers.save.unref?.();
  }

  async save() {
    this.dirty = false;
    const prev = this.saving || Promise.resolve();
    this.saving = prev.catch(() => {}).then(() => this.writeMeta());
    return this.saving;
  }

  /**
   * Writes meta.json (tens of MB for a big library) in slices, so the event loop keeps serving
   * the party in between, then renames it into place.
   */
  async writeMeta() {
    const sections = { songs: [...this.songs], artists: [...this.artists], albums: [...this.albums] };
    await fsp.mkdir(path.dirname(this.metaFile), { recursive: true });
    const tmp = `${this.metaFile}.${process.pid}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await writeAll(fh, `{"version":1,"savedAt":${this.now()}`);
      for (const [name, entries] of Object.entries(sections)) {
        let text = `,${JSON.stringify(name)}:{`;
        for (let i = 0; i < entries.length; i += SAVE_SLICE) {
          text += entries.slice(i, i + SAVE_SLICE).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');
          if (i + SAVE_SLICE < entries.length) text += ',';
          await writeAll(fh, text);
          text = '';
        }
        await writeAll(fh, `${text}}`);
      }
      await writeAll(fh, '}');
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, this.metaFile);
  }

  /**
   * Rankings, filters and facets in the catalog use the metadata: tell it. A lookup shows up
   * within 3 s; while the crawler keeps finding things, at most every 30 s (each change means
   * re-sorting the popular list and re-filtering the genre/decade pages on the next request).
   */
  metaChangedSoon() {
    if (this.timers.meta) return;
    const wait = Math.max(3000, (this.metaChangedAt || 0) + 30_000 - Date.now());
    this.timers.meta = setTimeout(() => {
      this.timers.meta = null;
      this.metaChangedAt = Date.now();
      this.catalog.metaChanged();
    }, wait);
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
    this.saveSoon(entry.manual ? SAVE_MS : undefined); // the host's own choices are written soon
    if (CATALOG_FIELDS.some((f) => (prev?.[f] || 0) !== (entry[f] || 0))) this.metaChangedSoon();
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

  async getJson(name, url, prio, { maxWaitMs = MAX_WAIT[prio] ?? Infinity } = {}) {
    await this.throttles[name].wait({ maxWaitMs, prio });
    // Turned off (or shut down) while waiting: nothing more goes out.
    if (!this.providerOn(name)) throw unavailable(`${PROVIDERS[name].label} is turned off`);
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
    const th = this.throttles[name];
    // Requests that were already on their way when the back-off began don't lengthen it.
    if (!th.pausedFor()) h.fails++;
    h.status = status;
    h.lastError = String(message || 'error').slice(0, 200);
    h.at = this.now();
    const base = status === 'offline' ? 30_000 : status === 'limited' ? 5_000 : 60_000;
    const cap = status === 'limited' ? 120_000 : 15 * 60_000;
    th.pause(retryMs || Math.min(cap, base * 2 ** Math.min(8, Math.max(0, h.fails - 1))));
    if (h.fails === 1 || h.fails % 10 === 0) log.warn(`${PROVIDERS[name].label}: ${h.lastError} — backing off`);
    // Crawl jobs don't sit out a long back-off (it would hold up the crawler): the next pass asks again.
    if (th.pausedFor() > CRAWL_HOLD_MS) this.dropCrawl(name);
    this.statusChanged();
    return unavailable(`${PROVIDERS[name].label}: ${h.lastError}`);
  }

  dropCrawl(name) {
    for (const job of this.queues[name][PRIO.crawl].splice(0)) {
      job.queued = null;
      job.skipped = true;
      this.settle(job, job.found ? true : null);
    }
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

  /**
   * The image file for `ref` at `size` ('s' | 'm' | 'l'), downloading it when needed; null when
   * there is none. Options:
   * - `strict`: a download that failed for a passing reason (network, server error, back-off,
   *   queue full, turned off) rejects with `code: 'unavailable' | 'busy'` instead of giving
   *   null, so a lookup can tell "this image doesn't exist" from "couldn't ask".
   * - `mayDownload()`: asked before a new download starts (guests have a budget).
   */
  async image(ref, size = 's', prio = PRIO.visible, { strict = false, mayDownload } = {}) {
    if (this.indexing) await this.indexing;
    const url = imageUrls(ref)?.[size];
    if (!url) return null;
    const hit = this.cached(url);
    if (hit) return hit;
    const p = this.fetchImage(url, prio, mayDownload);
    if (strict) return p;
    return p.catch((e) => {
      log.debug(`image download failed: ${e.message}`);
      return null;
    });
  }

  fetchImage(url, prio, mayDownload) {
    if (!this.enabled()) return Promise.reject(unavailable('Online artwork is turned off'));
    const bad = this.badUrls.get(url);
    if (bad && this.now() - bad < DAY) return Promise.resolve(null);
    const key = this.fileKey(url);
    let d = this.downloads.get(key);
    if (d) {
      const q = this.imageQueues[d.prio];
      if (prio < d.prio && d.queued && q.includes(d)) {
        q.splice(q.indexOf(d), 1);
        d.prio = prio;
        this.queueImage(d);
      }
      return d.promise;
    }
    const host = hostOf(url);
    if (this.hostHold(host)) return Promise.reject(unavailable(`${host} is not answering`));
    if (mayDownload && !mayDownload()) return Promise.resolve(null);
    d = { url, key, prio, queued: false };
    d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
    this.downloads.set(key, d);
    this.queueImage(d);
    return d.promise;
  }

  queueImage(d) {
    const q = this.imageQueues[d.prio];
    d.queued = true;
    if (d.prio === PRIO.visible) {
      q.unshift(d); // newest first: what is on screen now
      while (q.length > IMAGE_VISIBLE_CAP) this.dropImage(q.pop(), busy('Too many pictures are waiting'));
    } else {
      q.push(d);
    }
    this.pumpImages();
  }

  dropImage(d, err) {
    d.queued = false;
    if (this.downloads.get(d.key) === d) this.downloads.delete(d.key);
    d.reject(err);
  }

  pumpImages() {
    while (!this.closed) {
      // Like the providers: urgent downloads never wait for crawl downloads to finish.
      const urgent = this.imageRunning - this.imageRunningCrawl < IMAGE_WORKERS;
      const idle = this.imageRunning < IMAGE_WORKERS;
      const [now, visible, crawl] = this.imageQueues;
      const q = urgent && now.length ? now : urgent && visible.length ? visible : idle && crawl.length ? crawl : null;
      if (!q) return;
      const d = q.shift();
      d.queued = false;
      const isCrawl = d.prio === PRIO.crawl;
      this.imageRunning++;
      if (isCrawl) this.imageRunningCrawl++;
      this.download(d).then(d.resolve, d.reject).finally(() => {
        if (this.downloads.get(d.key) === d) this.downloads.delete(d.key);
        this.imageRunning--;
        if (isCrawl) this.imageRunningCrawl--;
        this.pumpImages();
      });
    }
  }

  /** Milliseconds an image host is still left alone after failing (0 = ask it). */
  hostHold(host) {
    const h = this.imageHosts.get(host);
    return h ? Math.max(0, h.until - this.now()) : 0;
  }

  /** An image host failed (network, timeout, server error): leave it alone for a while. */
  hostFailed(host, message) {
    const h = this.imageHosts.get(host) || { fails: 0, until: 0 };
    if (h.until <= this.now()) h.fails++; // downloads already on their way don't lengthen the pause
    h.until = this.now() + Math.min(HOST_BACKOFF_MS[1], HOST_BACKOFF_MS[0] * 2 ** Math.min(8, h.fails - 1));
    this.imageHosts.set(host, h);
    if (h.fails === 1 || h.fails % 10 === 0) log.warn(`pictures from ${host}: ${message} — backing off`);
    return unavailable(`${host}: ${message}`);
  }

  /**
   * Downloads `d.url` into the cache. Resolves to the file, or null when there is no such image
   * (404, not an image, not allowed, too big: remembered in badUrls); rejects with
   * `code: 'unavailable'` when it couldn't be fetched now.
   */
  async download(d) {
    const { url, key } = d;
    const signal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
    let current = url;
    let res = null;
    let host = '';
    for (let hop = 0; hop < 4; hop++) {
      if (!allowedImageUrl(current)) {
        this.badUrls.set(url, this.now());
        return null;
      }
      host = hostOf(current);
      if (this.hostHold(host)) throw unavailable(`${host} is not answering`);
      await this.imageThrottle.wait({ prio: d.prio });
      if (!this.enabled()) throw unavailable('Online artwork is turned off');
      try {
        res = await this.fetch(current, { redirect: 'manual', headers: { 'user-agent': this.ua, accept: 'image/*' }, signal });
      } catch (e) {
        throw this.hostFailed(host, e.cause?.code || e.message);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      res.body?.cancel?.().catch?.(() => {});
      current = new URL(location, current).href;
      res = null;
    }
    if (!res) throw unavailable('Too many redirects');
    if (!res.ok) {
      res.body?.cancel?.().catch?.(() => {});
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        this.badUrls.set(url, this.now()); // there is no such image
        return null;
      }
      throw this.hostFailed(host, `HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      res.body?.cancel?.().catch?.(() => {});
      this.badUrls.set(url, this.now());
      return null;
    }
    let buf;
    try {
      buf = await readLimited(res, MAX_IMAGE_BYTES);
    } catch (e) {
      throw this.hostFailed(host, e.cause?.code || e.message);
    }
    const ext = buf && sniff(buf);
    if (!ext) {
      this.badUrls.set(url, this.now());
      return null;
    }
    this.imageHosts.delete(host);
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

  cacheMax() {
    return Math.max(20, Number(this.cfg().maxCacheMB) || 3072) * 1024 * 1024;
  }

  /**
   * Keeps the image cache under `artwork.maxCacheMB`, least recently used files first: big
   * pictures (TV, song sheets) before the small list thumbnails that keep lists working offline,
   * but pictures used in the last few minutes (the TV's prefetches) only after both. A picture
   * used in the last minute — the one just downloaded, ones being sent — is never removed.
   */
  evict() {
    const max = this.cacheMax();
    if (this.bytes <= max) return;
    const target = max * 0.9;
    const t = this.now();
    const rank = (f) => (t - f.used < RECENT_MS ? 2 : f.size > BIG_FILE ? 0 : 1);
    const list = [...this.files]
      .filter(([, f]) => !f.pinned && t - f.used >= IN_USE_MS)
      .sort((a, b) => rank(a[1]) - rank(b[1]) || a[1].used - b[1].used);
    for (const [key, f] of list) {
      if (this.bytes <= target) break;
      this.files.delete(key);
      this.bytes -= f.size;
      fsp.unlink(path.join(this.artDir, `${key}.${f.ext}`)).catch(() => {});
    }
    this.statusChanged();
  }

  /** Downloads `ref` at `size` in the background unless it is cached or can't be fetched now; true when started. */
  prefetch(ref, size, prio = PRIO.crawl) {
    // A full cache is not topped up in the background (it would evict and fetch again forever).
    if (!ref || !this.enabled() || this.indexing || this.bytes > this.cacheMax() * 0.85) return false;
    const url = imageUrls(ref)?.[size];
    if (!url) return false;
    const key = this.fileKey(url);
    const bad = this.badUrls.get(url);
    if (this.files.has(key) || this.downloads.has(key) || (bad && this.now() - bad < DAY) || this.hostHold(hostOf(url))) return false;
    this.image(ref, size, prio);
    return true;
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
      if (p < job.prio) this.reprioritize(job, p);
      if (kind === 'artist' && want === 'all' && job.want !== 'all') {
        // A picture-only lookup is running: the fanart/logo lookup follows it, at the priority of
        // whoever asked for it, and this caller hears about that one.
        job.upgradePrio = Math.min(job.upgradePrio ?? p, p);
        job.upgraded ||= new Promise((resolve) => { job.resolveUpgrade = resolve; });
        return job.upgraded;
      }
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
    while (job.chain.length && !this.providerOn(job.chain[0])) job.chain.shift(); // turned off meanwhile
    const name = job.chain[0];
    if (!name) return this.settle(job, job.found ? true : null);
    if (job.prio === PRIO.crawl && this.throttles[name].pausedFor() > CRAWL_HOLD_MS) {
      job.skipped = true; // backing off for long: the next pass asks again
      return this.settle(job, job.found ? true : null);
    }
    const q = this.queues[name][job.prio];
    if (job.prio === PRIO.visible) {
      q.unshift(job);
      while (q.length > VISIBLE_CAP) {
        const old = q.pop();
        old.queued = null;
        this.settle(old, null, { dropped: true });
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

  /**
   * Starts queued jobs. Urgent (now/visible) jobs may use every worker whatever the crawler is
   * doing, so they never wait for a crawl step to finish; crawl jobs only use idle workers, and
   * none while the provider backs off (they would sit on a worker for the whole pause).
   */
  pump(name) {
    const workers = PROVIDERS[name].workers || 1;
    const [now, visible, crawl] = this.queues[name];
    while (!this.closed) {
      const urgent = this.running[name] - this.runningCrawl[name] < workers;
      const idle = this.running[name] < workers && !this.throttles[name].pausedFor();
      const q = urgent && now.length ? now : urgent && visible.length ? visible : idle && crawl.length ? crawl : null;
      if (!q) break;
      const job = q.shift();
      job.queued = null;
      const isCrawl = job.prio === PRIO.crawl;
      this.running[name]++;
      if (isCrawl) this.runningCrawl[name]++;
      this.run(job, name).finally(() => {
        this.running[name]--;
        if (isCrawl) this.runningCrawl[name]--;
        this.pump(name);
      });
    }
    // Crawl jobs held back by a pause start when it ends.
    const paused = this.throttles[name].pausedFor();
    const timer = `pump:${name}`;
    if (paused && crawl.length && !this.closed && !this.timers[timer]) {
      this.timers[timer] = setTimeout(() => {
        delete this.timers[timer];
        this.pump(name);
      }, paused + 50);
      this.timers[timer].unref?.();
    }
  }

  async run(job, name) {
    let result;
    if (!this.providerOn(name)) {
      result = 'off'; // turned off since the job was queued
    } else {
      try {
        result = job.kind === 'song' ? await this.songStep(job, name) : await this.artistStep(job, name);
      } catch (e) {
        if (e.code !== 'unavailable' && e.code !== 'busy' && !this.closed) log.warn(`${name} lookup of ${job.key} failed:`, e.message);
        result = e.code === 'busy' ? 'busy' : 'unavailable';
      }
    }
    if (result === 'found' || result === 'next') job.asked = true; // a provider answered
    if (this.closed) return this.settle(job, null);
    if (result === 'found') return this.settle(job, true);
    // A crawl job that met a short back-off waits for it in the queue (not on a worker).
    if (result === 'busy' && job.prio === PRIO.crawl && this.providerOn(name) && this.throttles[name].pausedFor() <= CRAWL_HOLD_MS) {
      this.queues[name][PRIO.crawl].unshift(job);
      job.queued = name;
      return;
    }
    job.chain.shift();
    if (result === 'unavailable' || result === 'busy') job.skipped = true;
    // Busy providers are skipped by urgent lookups; the crawler asks them again later.
    if (job.chain.length && (result === 'next' || result === 'off' || job.prio < PRIO.crawl)) return this.enqueue(job);
    this.settle(job, job.found ? true : job.skipped ? null : false);
  }

  /** `dropped`: pushed out of a full queue (nothing was asked; no follow-up lookup either). */
  settle(job, value, { dropped = false } = {}) {
    if (this.jobs.get(job.id) !== job) return;
    this.jobs.delete(job.id);
    if (job.prio === PRIO.crawl) {
      this.crawl.inFlight--;
      // The rate shown to the host counts lookups that asked a provider, not skipped ones.
      if (job.asked) this.crawl.recent.push(this.now());
    }
    job.resolve(value);
    if (job.upgraded) {
      const prio = Object.keys(PRIO).find((k) => PRIO[k] === job.upgradePrio) || 'visible';
      job.resolveUpgrade(dropped || this.closed ? null : this.request('artist', job.obj, prio, 'all'));
    }
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
      // Cover Art Archive: take the first release group that really has a front cover. If the
      // archive couldn't be asked, nothing is known yet: no miss is recorded.
      try {
        c.cover = await this.coverOf(c, job.prio);
      } catch (e) {
        if (e.code === 'busy' || !this.providerOn(name)) throw e;
        throw this.failed(name, 'error', `Cover Art Archive: ${e.message}`);
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
      album = await this.album(name, c.albumId, job.prio).catch((e) => {
        if (e.code === 'busy' && job.prio === PRIO.crawl) throw e; // back-off: the crawler comes back for genre and year
        return null;
      });
      const cur = this.songs.get(song.key);
      if (cur && cur !== prev && (cur.manual || !cur.miss)) return 'found'; // chosen by the host meanwhile
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

  /**
   * The first of a candidate's covers that really has an image (Cover Art Archive release
   * groups often have none), or null when none has. Throws `code: 'unavailable' | 'busy'` when
   * none was found but some couldn't be checked (archive down, offline, back-off).
   */
  async coverOf(c, prio) {
    let failure = null;
    for (const ref of new Set([c.cover, ...(c.covers || [])].filter(Boolean))) {
      try {
        if (await this.image(ref, 's', prio, { strict: true })) return ref;
      } catch (e) {
        failure ||= e;
      }
    }
    if (failure) throw failure;
    return null;
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
    if (job.want !== 'all' && e.picture) {
      if (job.prio === PRIO.crawl) await this.image(e.picture, 's', job.prio); // artist lists work offline later
      return 'found';
    }
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
      const artists = (song.artistKeys || []).map((key) => this.catalog.artist(key)).filter(Boolean);
      Promise.all(artists.map((artist) => this.request('artist', artist, 'now', 'all'))).then(() => {
        // Only what the TV will show (artFor), which depends on all of the song's artists, in
        // the sizes the TV asks for.
        const art = this.artFor(song);
        const fanart = art.fanart && this.artists.get(art.fanart)?.fanart?.[0];
        const logo = art.logo && this.artists.get(art.logo)?.logo;
        if (fanart) this.image(fanart, 'l', PRIO.now);
        if (logo) this.image(logo, 'm', PRIO.now);
      });
    });
  }

  /**
   * The song's artists whose fanart and logo fit it. Art found for one of the song's own acts
   * ("Peter & Gordon", "Sam & Dave") comes first. Art found under a performer's own name is only
   * a stand-in for an act the providers don't know ("Elton John" for "Elton John & Kiki Dee"):
   * when the act was found, or is still to be looked up, a member's own name may well be a
   * namesake ("Dave" the rapper next to "Sam & Dave" in one catalog artist), so it is left out.
   * A band member holding another act's art never fits: "Peter" is looked up as "Peter, Paul &
   * Mary", which is not who sings "A World Without Love".
   */
  songArtists(song) {
    const acts = actsOf(song.artist);
    const exact = [];
    const own = [];
    let known = false;
    let pending = false;
    for (const key of song.artistKeys || []) {
      const artist = this.catalog.artist(key);
      if (!artist) continue;
      const e = this.artistEntry(artist); // only what was found for its current search name
      const name = this.searchName(artist);
      if (acts.some((act) => sameSearchName(act, name))) {
        if (e && (e.picture || SEARCHED.some((k) => e[k]?.length))) known = true;
        else if (this.artistChain(key, 'all').length) pending = true;
        if (e) exact.push(key);
      } else if (e && sameSearchName(name, artist.name)) {
        own.push(key);
      }
    }
    return known || pending ? exact : [...exact, ...own];
  }

  /** What the TV can show for a song: { cover, fanart: artistKey?, logo: artistKey? }. */
  artFor(song) {
    if (!song) return null;
    const out = { cover: !!this.songs.get(song.key)?.cover };
    // Either the act's own art or the stand-ins (see songArtists), never one of each.
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

  /**
   * Guests may start only so many lookups and downloads per minute (per address): a phone
   * script can't make the server download everything or push the TV's lookups back.
   */
  mayFetch(ctx) {
    return !!ctx.isHost || this.guestLimit.take(String(ctx.ip));
  }

  /** An on-demand lookup for an HTTP request (joining one that is queued anyway is free). */
  lookupFor(ctx, kind, obj, want) {
    const job = this.jobs.get(`${kind}:${obj.key}`);
    const free = job && !(want === 'all' && job.want !== 'all' && !job.upgraded);
    if (free || this.mayFetch(ctx)) this.request(kind, obj, 'visible', want);
  }

  /** Sends the cover of `song`; false when there is none (the caller sends a placeholder). */
  async serveSong(ctx, song) {
    const e = this.songs.get(song.key);
    if (this.songChain(song.key).length) this.lookupFor(ctx, 'song', song);
    if (!e?.cover) return false;
    const img = (await this.image(e.cover, sizeKey(ctx.query.get('s')), PRIO.visible, { mayDownload: () => this.mayFetch(ctx) })) || this.anyImage(e.cover);
    if (!img) return false;
    return this.sendImage(ctx, img);
  }

  /**
   * Sends a cached image file. The image behind a cover/artist URL changes when the host picks
   * another cover or "No cover", so browsers must ask again every time (a cheap 304 on the LAN):
   * no max-age, and an ETag that names the file (each image URL has its own cache file).
   * False when the file is gone from the disk after all (evicted meanwhile, deleted by hand): it
   * is dropped from the cache index and the caller sends the placeholder. Candidate thumbnails
   * never change for the same URL and pass their own `cacheControl`.
   */
  async sendImage(ctx, img, cacheControl = 'no-cache') {
    let st;
    try {
      st = await fsp.stat(img.abs);
    } catch {
      const m = FILE_RE.exec(path.basename(img.abs));
      const f = m && this.files.get(m[1]);
      if (f && f.ext === m[2]) {
        this.files.delete(m[1]);
        this.bytes -= f.size;
      }
      return false;
    }
    const etag = `W/"${path.basename(img.abs).slice(0, 16)}-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    await sendFile(ctx.req, ctx.res, img.abs, { st, contentType: img.type, cacheControl, etag });
    return true;
  }

  /** ?type=picture|fanart|logo|cutout|banner (&i=n for the n-th fanart). */
  async serveArtist(ctx, artist) {
    const type = ARTIST_TYPES.includes(ctx.query.get('type')) ? ctx.query.get('type') : 'picture';
    const want = type === 'picture' ? 'picture' : 'all';
    if (this.artistChain(artist.key, want).length) this.lookupFor(ctx, 'artist', artist, want);
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
    const img = (await this.image(ref, size, PRIO.visible, { mayDownload: () => this.mayFetch(ctx) })) || this.anyImage(ref);
    if (!img) return false;
    return this.sendImage(ctx, img);
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
    const cur = this.songs.get(song.key);
    const all = [];
    const errors = [];
    // All providers at once, none waiting out a back-off: the host is watching a spinner.
    await Promise.all(SONG_CHAIN.filter((name) => this.providerOn(name)).map(async (name) => {
      const prov = PROVIDERS[name];
      const urls = prov.songUrls(q);
      try {
        const json = await this.getJson(name, urls[urls.length - 1], PRIO.now, { maxWaitMs: MAX_WAIT[PRIO.visible] });
        for (const c of rankCandidates(json ? prov.parseSongs(json) : [], q)) {
          // Cover Art Archive candidates: which release group has a cover is checked when the
          // thumbnail is shown or the candidate chosen (the current one is known already).
          if (!c.cover && cur?.cover && cur.p === c.provider && cur.id === c.id) c.cover = cur.cover;
          if (c.cover || c.covers?.length) all.push(c);
        }
      } catch (e) {
        errors.push(e.code === 'busy' ? `${prov.label} is busy — try again in a minute.` : e.message);
      }
    }));
    all.sort((a, b) => b.confidence - a.confidence);
    const list = all.slice(0, 24);
    this.candidateCache.set(song.key, list);
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
    const ref = c && (await this.coverOf(c, PRIO.now).catch(() => null));
    if (ref) c.cover = ref;
    const img = ref ? await this.image(ref, 's', PRIO.now) : null;
    if (!img) return false;
    return this.sendImage(ctx, img, 'private, max-age=600');
  }

  async choose(song, candidateId) {
    const c = (this.candidateCache.get(song.key) || []).find((x) => `${x.provider}:${x.id}` === candidateId);
    if (!c) throw new UserError('That choice has expired — search again.', { code: 'expired' });
    // Only a cover that really downloads is kept (a manual choice is never looked at again).
    let cover;
    try {
      cover = await this.coverOf(c, PRIO.now);
    } catch {
      throw new UserError('That cover can’t be downloaded right now — try again in a moment.', { code: 'unavailable', status: 503 });
    }
    if (!cover) throw new UserError('That one has no picture — pick another cover.', { code: 'no_image' });
    c.cover = cover;
    const album = PROVIDERS[c.provider].albumUrl && c.albumId ? await this.album(c.provider, c.albumId, PRIO.now).catch(() => null) : null;
    this.setSong(song, {
      p: c.provider, id: c.id, cover, album: c.album, albumId: c.albumId,
      genre: album?.genre || c.genre, year: album?.year || c.year, explicit: c.explicit, rank: c.rank,
      confidence: 1, manual: true, at: this.now(), v: MATCH_VERSION,
    });
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
    if (CATALOG_FIELDS.some((f) => prev?.[f])) this.metaChangedSoon();
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
    this.imageHosts.clear();
    this.wakeCrawl();
    this.saveSoon();
    this.metaChangedSoon();
    this.statusChanged();
    return { cleared: n };
  }

  settingsChanged() {
    // Queued lookups for providers that are off now move on to the next provider (or end), so
    // nothing more is sent to them; with artwork off nothing is sent at all.
    for (const [name, qs] of Object.entries(this.queues)) {
      if (this.providerOn(name)) continue;
      for (const q of qs) {
        const jobs = q.splice(0);
        if (q === qs[PRIO.visible]) jobs.reverse(); // enqueue() puts visible jobs first: keep their order
        for (const job of jobs) {
          job.queued = null;
          this.enqueue(job);
        }
      }
    }
    if (!this.enabled()) for (const q of this.imageQueues) for (const d of q.splice(0)) this.dropImage(d, unavailable('Online artwork is turned off'));
    if (!this.cfg().crawl) for (const name of Object.keys(this.queues)) this.dropCrawl(name); // crawler paused
    this.wakeCrawl();
    this._status = null;
    this.statusChanged();
  }

  /** Starts a new crawl pass right away (new songs, retried misses, providers turned on). */
  wakeCrawl() {
    const c = this.crawl;
    c.list = null;
    c.artistList = null;
    c.restartAt = 0;
    if (c.timer && !this.closed) {
      clearTimeout(c.timer);
      c.timer = setTimeout(() => this.crawlTick(), 0);
      c.timer.unref?.();
    }
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
    if (this.indexing) return 1000; // what is cached decides what to prefetch
    if (!c.list || c.version !== this.catalog.version) {
      if (c.version === this.catalog.version && now < c.restartAt) return Math.min(30_000, c.restartAt - now);
      const o = c.order;
      if (o?.catalog !== this.catalog || o.version !== this.catalog.version) {
        // Sorting a big catalogue takes a while: the order is kept for every pass over it.
        c.order = {
          catalog: this.catalog,
          version: this.catalog.version,
          songs: this.catalog.popular({ limit: Infinity }).items,
          artists: [...this.catalog.artistList].sort((a, b) => b.trackCount - a.trackCount),
        };
      }
      c.list = c.order.songs;
      c.artistList = c.order.artists;
      c.index = 0;
      c.artistIndex = 0;
      c.version = this.catalog.version;
      c.requested = 0;
      c.heldUntil = 0;
    }
    // Keep the primary provider busy, but don't let fallback queues (1 request/s) grow without
    // bound. Providers that are off don't count (long back-offs drop their crawl jobs anyway).
    const crawlLoad = (names) => names.reduce((n, p) => n + this.queues[p][PRIO.crawl].length + this.runningCrawl[p], 0);
    const load = () => crawlLoad([primary]);
    const fallbacks = SONG_CHAIN.filter((n) => n !== primary && this.providerOn(n));
    const backlog = () => fallbacks.reduce((sum, n) => sum + this.queues[n][PRIO.crawl].length, 0);
    const imagesFree = () => this.imageQueues[PRIO.crawl].length < 8;
    // Songs and artists whose next provider is in a long back-off are left alone (a lookup would
    // end at once); `heldUntil` is when the first of those back-offs ends.
    const held = (name) => {
      const ms = this.throttles[name].pausedFor();
      if (ms <= CRAWL_HOLD_MS) return false;
      c.heldUntil = Math.min(c.heldUntil || Infinity, now + ms);
      return true;
    };
    // A big catalogue is walked a slice per tick, so a pass never blocks the party.
    let budget = CRAWL_SLICE;
    while (budget > 0 && load() < 6 && backlog() < 200 && imagesFree() && c.index < c.list.length) {
      budget--;
      const song = c.list[c.index++];
      const chain = this.songChain(song.key);
      if (chain.length) {
        if (held(chain[0])) continue;
        c.requested++;
        this.request('song', song, 'crawl');
      } else if (this.prefetch(this.songs.get(song.key)?.cover, 's')) {
        c.requested++; // found while on screen: the list thumbnail (offline) too
      }
    }
    if (c.index >= c.list.length) {
      // Every artist provider's queue counts: TheAudioDB answers only 30 times a minute.
      const artistLoad = () => crawlLoad(ARTIST_CHAIN);
      while (budget > 0 && artistLoad() < 6 && imagesFree() && c.artistIndex < c.artistList.length) {
        budget--;
        const artist = c.artistList[c.artistIndex++];
        const chain = this.artistChain(artist.key, 'picture');
        if (chain.length) {
          if (held(chain[0])) continue;
          c.requested++;
          this.request('artist', artist, 'crawl', 'picture');
        } else if (this.prefetch(this.artists.get(artist.key)?.picture, 's')) {
          c.requested++; // pictures that came with song results
        }
      }
    }
    const done = c.index >= c.list.length && c.artistIndex >= c.artistList.length;
    if (done && c.inFlight <= 0) {
      // A pass ended: look again later for new songs or lookups that were skipped (offline).
      c.list = null;
      if (c.requested) {
        this.setCrawlState('running');
        c.restartAt = now + 60_000;
      } else if (c.heldUntil) {
        // All that is left waits for a provider that backs off: look again when it is back.
        this.setCrawlState('waiting');
        c.restartAt = c.heldUntil + 500;
      } else {
        this.setCrawlState('done');
        c.restartAt = now + 30 * 60_000;
      }
      return 1000;
    }
    // A pass that so far only met held or known songs keeps showing 'waiting' or 'done'.
    if (c.requested || (c.state !== 'waiting' && c.state !== 'done')) this.setCrawlState('running');
    return budget > 0 ? 500 : 10; // a slice used up: the next one soon
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
