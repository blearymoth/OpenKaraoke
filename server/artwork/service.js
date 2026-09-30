// Artwork & metadata service (PLAN §12): finds covers/artist pictures online, caches them in
// data/art/, keeps metadata (genre, year, explicit, rank) in data/meta.json and feeds it to the
// catalog. Work is prioritised: songs on stage/next (0) > on screen (1) > background crawl (2).
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonDoc } from '../util/jsonfile.js';
import { logger } from '../util/log.js';
import { sendFile } from '../http/static.js';
import { text, redirect } from '../http/router.js';
import { placeholderSvg } from './placeholder.js';
import {
  UA, ProviderError, best, deezerSearch, deezerAlbum, deezerArtist, musicbrainzSearch, itunesSearch, audiodbArtist, primaryArtist,
} from './providers.js';

const DAY = 24 * 3600 * 1000;
const MISS_RETRY_MS = 30 * DAY;
const MAX_IMAGE_BYTES = 8 << 20;

/** Token bucket: `rate` requests per second, `burst` at once; `pause(ms)` after a 429/quota. */
export class RateLimiter {
  constructor(rate, burst = 1, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = now();
    this.until = 0;
    this.now = now;
    this.sleep = sleep;
    this.chain = Promise.resolve();
  }

  take() {
    const run = async () => {
      for (;;) {
        const t = this.now();
        if (t < this.until) { await this.sleep(this.until - t); continue; }
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
        this.at = t;
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  pause(ms) {
    this.until = Math.max(this.until, this.now() + ms);
  }
}

/** Image type from magic bytes. */
export function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

const DEFAULT_LIMITS = { deezer: [8, 8], musicbrainz: [1, 1], itunes: [0.3, 2], audiodb: [0.45, 2], img: [12, 12] };

export class ArtworkService extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {import('../config.js').Settings} o.settings
   * @param {import('../library/service.js').LibraryService} o.library
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ dataDir, settings, library, fetch = globalThis.fetch, log = logger('artwork'), limits = {}, concurrency = 3, crawlDelayMs = 60000, offlinePauseMs = 5 * 60000, maxRetryMs = 60000 }) {
    super();
    this.settings = settings;
    this.library = library;
    this.fetch = fetch;
    this.log = log;
    this.dir = path.join(dataDir, 'art');
    this.doc = new JsonDoc(path.join(dataDir, 'meta.json'), { version: 1, songs: {}, artists: {}, albums: {} }, { debounceMs: 2000 });
    this.limits = {};
    for (const [k, [rate, burst]] of Object.entries({ ...DEFAULT_LIMITS, ...limits })) this.limits[k] = new RateLimiter(rate, burst);
    this.concurrency = concurrency;
    this.crawlDelayMs = crawlDelayMs;
    this.offlinePauseMs = offlinePauseMs;
    this.maxRetryMs = maxRetryMs;
    this.queue = [[], [], []]; // by priority
    this.queued = new Map(); // job key -> job
    this.running = 0;
    this.downloads = new Map(); // url -> Promise<file>
    this.crawl = { enabled: false, index: 0, list: null, retry: [], done: 0, found: 0, missed: 0, startedAt: 0 };
    this.offlineUntil = 0;
    this.cacheBytes = 0;
    this.errors = 0;
    this._artIds = new Set();
    this._artTimer = null;
    this._metaTimer = null;
    this._crawlTimer = null;
    this._idle = [];
  }

  get s() { return this.settings.data.artwork; }
  get enabled() { return !!this.s.enabled; }
  get catalog() { return this.library.catalog; }

  async init({ crawl = true } = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    await this.doc.load();
    this.cacheBytes = await this._dirBytes();
    this.catalog.metaFor = (key) => {
      const m = this.doc.data.songs[key];
      return m && !m.miss ? m : null;
    };
    this.catalog.metaChanged();
    this.library.on('changed', () => { this.crawl.list = null; this.catalog.metaChanged(); });
    if (crawl && this.s.crawl !== false) {
      this._crawlTimer = setTimeout(() => this.startCrawl(), this.crawlDelayMs);
      this._crawlTimer.unref?.();
    }
    return this;
  }

  async close() {
    clearTimeout(this._crawlTimer);
    clearTimeout(this._resumeTimer);
    clearTimeout(this._artTimer);
    clearTimeout(this._metaTimer);
    this.crawl.enabled = false;
    await this.doc.flush();
  }

  // ---- lookups -------------------------------------------------------------------------------

  songMeta(song) { return song ? this.doc.data.songs[song.key] || null : null; }
  artistMeta(key) { return this.doc.data.artists[key] || null; }

  fresh(m) {
    if (!m) return false;
    if (m.miss) return Date.now() - (m.fetchedAt || 0) < MISS_RETRY_MS;
    return true;
  }

  /** Asks for a song's artwork (no-op when known, disabled or offline). */
  want(songId, priority = 1) {
    const song = this.catalog.song(songId);
    if (!song || !this.enabled) return false;
    if (this.fresh(this.songMeta(song))) return false;
    return this._enqueue({ key: `s:${song.key}`, kind: 'song', songId, priority });
  }

  wantArtist(artistKey, priority = 1) {
    if (!this.enabled || !this.catalog.artist(artistKey)) return false;
    const m = this.artistMeta(artistKey);
    if (m && (Date.now() - (m.fetchedAt || 0) < (m.miss ? MISS_RETRY_MS : 180 * DAY))) return false;
    return this._enqueue({ key: `a:${artistKey}`, kind: 'artist', artistKey, priority });
  }

  _enqueue(job) {
    const existing = this.queued.get(job.key);
    if (existing) {
      if (job.priority < existing.priority && !existing.started) {
        this.queue[existing.priority] = this.queue[existing.priority].filter((j) => j !== existing);
        existing.priority = job.priority;
        this.queue[job.priority].push(existing);
      }
      return true;
    }
    this.queued.set(job.key, job);
    this.queue[job.priority].push(job);
    this._pump();
    return true;
  }

  _next() {
    for (const q of this.queue) if (q.length) return q.shift();
    // feed the crawler lazily so we never hold 50k jobs
    if (this.crawl.enabled && Date.now() >= this.offlineUntil) {
      while (this.crawl.retry.length) {
        const songId = this.crawl.retry.shift();
        const song = this.catalog.song(songId);
        if (!song || this.fresh(this.songMeta(song)) || this.queued.has(`s:${song.key}`)) continue;
        const job = { key: `s:${song.key}`, kind: 'song', songId, priority: 2, crawl: true };
        this.queued.set(job.key, job);
        return job;
      }
      const list = this._crawlList();
      while (this.crawl.index < list.length) {
        const song = list[this.crawl.index++];
        if (this.fresh(this.songMeta(song)) || this.queued.has(`s:${song.key}`)) continue;
        const job = { key: `s:${song.key}`, kind: 'song', songId: song.id, priority: 2, crawl: true };
        this.queued.set(job.key, job);
        return job;
      }
      if (this.crawl.index >= list.length) this._finishCrawl();
    }
    return null;
  }

  _pump() {
    while (this.running < this.concurrency) {
      if (Date.now() < this.offlineUntil && !this.queue[0].length && !this.queue[1].length) break;
      const job = this._next();
      if (!job) break;
      job.started = true;
      this.running++;
      this._run(job).finally(() => {
        this.running--;
        this.queued.delete(job.key);
        this._pump();
        if (!this.running && !this.queue.some((q) => q.length)) this._resolveIdle();
      });
    }
    if (!this.running && !this.queue.some((q) => q.length)) this._resolveIdle();
  }

  /** Resolves when the queue is empty (tests, scripts). */
  idle() {
    const busy = () => this.running || this.queue.some((q) => q.length) || this._retrying;
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => (busy() ? setTimeout(check, 10) : resolve());
      this._idle.push(() => setTimeout(check, 10));
    });
  }

  _resolveIdle() {
    const list = this._idle.splice(0);
    for (const r of list) r();
  }

  async _run(job) {
    try {
      if (job.kind === 'song') await this._song(job);
      else await this._artist(job);
      this.errors = 0;
    } catch (e) {
      if (e instanceof ProviderError && e.quota) {
        // try again later, not a miss
        this.queued.delete(job.key);
        this._retrying = (this._retrying || 0) + 1;
        setTimeout(() => { this._retrying--; this._enqueue({ ...job, started: false }); }, Math.min(this.maxRetryMs, e.retryAfter || 5000)).unref?.();
        return;
      }
      this.errors++;
      if (job.crawl && job.kind === 'song' && this.crawl.retry.length < 1000) this.crawl.retry.push(job.songId);
      // Unreachable network, or several failures in a row (firewall, captive portal, outage):
      // pause instead of burning through the library.
      if (isNetworkError(e) || this.errors >= 5) {
        if (this.offlineUntil < Date.now()) this.log.warn(`artwork providers unreachable (${e.cause?.code || e.message}) — pausing ${Math.round(this.offlinePauseMs / 60000)} min`);
        this.offlineUntil = Date.now() + this.offlinePauseMs;
        clearTimeout(this._resumeTimer);
        this._resumeTimer = setTimeout(() => this._pump(), this.offlinePauseMs + 100);
        this._resumeTimer.unref?.();
        return;
      }
      this.log.debug(`artwork job ${job.key} failed:`, e.message);
    }
  }

  /** Rate-limited JSON GET for one provider. */
  async _get(provider, url) {
    const lim = this.limits[provider];
    await lim.take();
    const res = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get?.('retry-after')) * 1000 || 5000;
      lim.pause(ra);
      throw new ProviderError(`${provider}: HTTP ${res.status}`, { quota: true, retryAfter: ra });
    }
    if (res.status === 404) return {};
    if (!res.ok) throw new ProviderError(`${provider}: HTTP ${res.status}`);
    const json = await res.json();
    if (json?.error?.code === 4) lim.pause(5000);
    return json;
  }

  async _song(job) {
    const song = this.catalog.song(job.songId);
    if (!song) return;
    const want = { artist: song.artist, title: song.title, duration: song.duration };
    const p = this.s.providers || {};
    const tries = [];
    if (p.deezer) tries.push(['deezer', deezerSearch]);
    if (p.musicbrainz) tries.push(['musicbrainz', musicbrainzSearch]);
    if (p.itunes) tries.push(['itunes', itunesSearch]);
    let match = null;
    for (const [name, search] of tries) {
      const candidates = await search((url) => this._get(name, url), want);
      match = best(want, candidates);
      if (match && match.provider === 'musicbrainz') {
        // Cover Art Archive may not have a picture for this release group
        const file = await this._download(match.cover.m).catch(() => null);
        if (!file) { match = null; continue; }
        match.files = { m: file };
      }
      if (match) break;
    }
    const meta = { fetchedAt: Date.now() };
    if (match) {
      Object.assign(meta, {
        provider: match.provider, id: match.id, album: match.album || null, cover: match.cover, remote: !!match.remote,
        artistPic: match.artistPic || null, explicit: match.explicit || false, rank: match.rank || 0,
        year: match.year || null, genre: match.genre || null, confidence: match.confidence, files: match.files || {},
      });
      if (match.provider === 'deezer' && match.albumId) {
        const album = await this._album(match.albumId).catch(() => null);
        if (album) { meta.genre = album.genre; meta.year = album.year; }
      }
      if (!meta.remote && !meta.files.m) meta.files.m = await this._download(meta.cover.m);
    } else {
      meta.miss = true;
    }
    this.doc.data.songs[song.key] = meta;
    this.doc.save();
    if (job.crawl) {
      this.crawl.done++;
      if (meta.miss) this.crawl.missed++;
      else this.crawl.found++;
      const now = Date.now();
      if (now - (this._statusAt || 0) > 3000) { this._statusAt = now; this.emit('status', this.status()); }
    }
    this._changed(song.id, !job.crawl);
  }

  async _album(albumId) {
    const cache = this.doc.data.albums;
    if (cache[albumId]) return cache[albumId];
    const a = await deezerAlbum((url) => this._get('deezer', url), albumId);
    cache[albumId] = a;
    return a;
  }

  async _artist(job) {
    const artist = this.catalog.artist(job.artistKey);
    if (!artist) return;
    const name = primaryArtist(artist.name);
    const meta = { fetchedAt: Date.now(), files: {} };
    const p = this.s.providers || {};
    if (p.theaudiodb) {
      const a = await audiodbArtist((url) => this._get('audiodb', url), name, this.s.theaudiodbKey);
      if (a) Object.assign(meta, { picture: a.picture, fanart: a.fanart, logo: a.logo, cutout: a.cutout, genre: a.genre, mbid: a.mbid });
    }
    if (!meta.picture && p.deezer) {
      const d = await deezerArtist((url) => this._get('deezer', url), name);
      if (d) meta.picture = d.picture;
    }
    if (!meta.picture && !meta.fanart) meta.miss = true;
    if (meta.picture) meta.files.picture = await this._download(meta.picture).catch(() => null);
    this.doc.data.artists[job.artistKey] = meta;
    this.doc.save();
    this.emit('artist', job.artistKey);
  }

  _changed(songId, notify = true) {
    if (notify) this._artIds.add(songId);
    if (notify && !this._artTimer) {
      this._artTimer = setTimeout(() => {
        this._artTimer = null;
        const ids = [...this._artIds];
        this._artIds.clear();
        this.emit('art', ids);
      }, 400);
    }
    if (!this._metaTimer) {
      this._metaTimer = setTimeout(() => { this._metaTimer = null; this.catalog.metaChanged(); }, 1000);
    }
  }

  // ---- image cache ------------------------------------------------------------------------------

  /** Downloads an image once; resolves to the cached file name. */
  _download(url) {
    if (!url) return Promise.resolve(null);
    let p = this.downloads.get(url);
    if (!p) {
      p = this._fetchImage(url).finally(() => this.downloads.delete(url));
      this.downloads.set(url, p);
    }
    return p;
  }

  async _fetchImage(url) {
    const base = crypto.createHash('sha1').update(url).digest('hex');
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      try { await fs.access(path.join(this.dir, `${base}.${ext}`)); return `${base}.${ext}`; } catch { /* not cached */ }
    }
    await this.limits.img.take();
    const res = await this.fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new ProviderError(`image HTTP ${res.status}`);
    const len = Number(res.headers.get?.('content-length'));
    if (len > MAX_IMAGE_BYTES) throw new ProviderError('image too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new ProviderError('image too large');
    const ext = sniffImage(buf);
    if (!ext) throw new ProviderError('not an image');
    const name = `${base}.${ext}`;
    const tmp = path.join(this.dir, `${name}.${process.pid}.tmp`);
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, path.join(this.dir, name));
    this.cacheBytes += buf.length;
    this._maybeEvict();
    return name;
  }

  async _dirBytes() {
    let total = 0;
    for (const f of await fs.readdir(this.dir).catch(() => [])) {
      try { total += (await fs.stat(path.join(this.dir, f))).size; } catch { /* gone */ }
    }
    return total;
  }

  _maybeEvict() {
    const max = Math.max(50, Number(this.s.maxCacheMB) || 3072) * 1024 * 1024;
    if (this.cacheBytes <= max || this._evicting) return;
    this._evicting = (async () => {
      const files = [];
      for (const f of await fs.readdir(this.dir)) {
        try {
          const st = await fs.stat(path.join(this.dir, f));
          files.push({ f, size: st.size, used: st.atimeMs || st.mtimeMs });
        } catch { /* gone */ }
      }
      files.sort((a, b) => a.used - b.used);
      let total = files.reduce((a, x) => a + x.size, 0);
      const target = max * 0.9;
      for (const x of files) {
        if (total <= target) break;
        await fs.rm(path.join(this.dir, x.f), { force: true });
        total -= x.size;
      }
      this.cacheBytes = total;
    })().finally(() => { this._evicting = null; });
  }

  /** Absolute path of a cached file, re-downloading it if it was evicted. */
  async _file(name, url) {
    if (name) {
      const abs = path.join(this.dir, name);
      try { await fs.access(abs); return abs; } catch { /* evicted */ }
    }
    if (!url || !this.enabled) return null;
    const again = await this._download(url).catch(() => null);
    return again ? path.join(this.dir, again) : null;
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  /** GET /api/art/song/:id?s=250|500|1000 — cached cover or a placeholder (never 404). */
  async serveSong(req, res, id, query) {
    const song = this.catalog.song(id);
    const m = this.songMeta(song);
    const size = Number(query?.get('s')) || 250;
    if (m && !m.miss && m.cover) {
      if (m.remote) return redirect(res, size >= 500 ? m.cover.l : m.cover.m);
      const large = size >= 500 && m.cover.l && m.cover.l !== m.cover.m;
      let file = null;
      if (large) {
        file = await this._file(m.files?.l, m.cover.l);
        if (file && !m.files.l) { m.files.l = path.basename(file); this.doc.save(); }
      }
      if (!file) file = await this._file(m.files?.m, m.cover.m);
      if (file) return sendFile(req, res, file, { cacheControl: 'public, max-age=604800' });
    }
    if (song && !m) this.want(song.id, 1);
    return this._placeholder(res, { artist: song?.artist, title: song?.title, plain: query?.get('plain') === '1', pending: !!song && this.enabled && !m });
  }

  /**
   * GET /api/art/artist/:key?type=picture|fanart|logo[&song=<id>] — fanart falls back to the
   * artist picture, then to the song's cover (TV backgrounds), then a plain placeholder.
   */
  async serveArtist(req, res, key, query) {
    const type = ['picture', 'fanart', 'logo', 'cutout'].includes(query?.get('type')) ? query.get('type') : 'picture';
    const artist = this.catalog.artist(key);
    const m = this.artistMeta(key);
    if (artist && !m) this.wantArtist(key, 1);
    const order = type === 'fanart' ? ['fanart', 'picture'] : [type];
    for (const t of order) {
      if (!m?.[t]) continue;
      const file = await this._file(m.files?.[t], m[t]);
      if (file) {
        if (!m.files[t]) { m.files[t] = path.basename(file); this.doc.save(); }
        return sendFile(req, res, file, { cacheControl: 'public, max-age=604800' });
      }
    }
    const songId = query?.get('song');
    if (songId) return this.serveSong(req, res, songId, new URLSearchParams({ s: '1000', plain: '1' }));
    if (type === 'logo' || type === 'cutout') return text(res, 404, 'No image');
    return this._placeholder(res, { artist: artist?.name || key, plain: type === 'fanart', pending: !!artist && !m && this.enabled });
  }

  _placeholder(res, { artist, title, plain, pending }) {
    const svg = placeholderSvg({ artist: artist || '', title: title || '', plain });
    // while a lookup is pending, don't let the browser keep the placeholder
    text(res, 200, svg, 'image/svg+xml', { 'cache-control': pending ? 'no-store' : 'public, max-age=3600' });
  }

  // ---- crawler -----------------------------------------------------------------------------------

  _crawlList() {
    if (!this.crawl.list) this.crawl.list = this.catalog.popular({ limit: Infinity }).items;
    return this.crawl.list;
  }

  startCrawl() {
    if (!this.enabled || this.s.crawl === false || this.crawl.enabled) return this.status();
    const list = this._crawlList();
    Object.assign(this.crawl, { enabled: true, index: 0, retry: [], done: 0, found: 0, missed: 0, startedAt: Date.now(), total: list.length });
    this.log.info(`artwork crawl started (${list.length} songs, popular first)`);
    this._pump();
    this.emit('status', this.status());
    return this.status();
  }

  stopCrawl() {
    this.crawl.enabled = false;
    this.emit('status', this.status());
    return this.status();
  }

  _finishCrawl() {
    if (!this.crawl.enabled) return;
    this.crawl.enabled = false;
    this.log.info(`artwork crawl finished: ${this.crawl.found} found, ${this.crawl.missed} not found`);
    this.emit('status', this.status());
  }

  /** Clears "not found" marks so those songs are looked up again. */
  retryMisses() {
    let n = 0;
    for (const [k, m] of Object.entries(this.doc.data.songs)) if (m.miss) { delete this.doc.data.songs[k]; n++; }
    this.doc.save();
    this.crawl.list = null;
    return n;
  }

  status() {
    const songs = Object.values(this.doc.data.songs);
    const found = songs.filter((m) => !m.miss).length;
    return {
      enabled: this.enabled,
      crawling: this.crawl.enabled,
      crawl: { index: this.crawl.index, total: this.crawl.total || this.catalog.songs.size, found: this.crawl.found, missed: this.crawl.missed },
      known: found,
      missing: songs.length - found,
      songs: this.catalog.songs.size,
      queue: this.queue.reduce((a, q) => a + q.length, 0) + this.running,
      offline: Date.now() < this.offlineUntil,
      cacheMB: Math.round(this.cacheBytes / 1048576),
    };
  }
}

function isNetworkError(e) {
  const code = e?.cause?.code || e?.code;
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' || /fetch failed/i.test(e?.message || '')
    || ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}
