// JSON API (PLAN §8). Handlers return plain objects, which the app sends as JSON.
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HttpError } from '../util/errors.js';
import { intParam, readJsonBody, readBody, sendText } from './router.js';
import { MAX_PHOTO_BYTES } from '../room/photos.js';
import { sendFile } from './static.js';
import { qrSvg } from '../util/qr.js';
import { placeholderSvg } from '../artwork/placeholder.js';
import { hash32 } from '../../shared/text.js';
import { MAX_LIST_SONGS } from '../../shared/protocol.js';
import { leadKind } from '../../shared/vocals.js';
import { HOST_VOTER } from '../room/versions.js';
import { songbookRoutes } from './songbook.js';
import { RateLimiter } from '../util/ratelimit.js';
import { Lru } from '../util/lru.js';
import { defaultMusicDirs } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('api');
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

export function apiRoutes(router, app) {
  const { library, settings, auth } = app;
  const cat = () => library.catalog;
  /** Song summaries marked with the party state: sung tonight (tn), waiting in the queue (qd). */
  const summaries = (list) => {
    const room = app.room?.s;
    const sung = new Set(room?.tonight.sung || []);
    const queued = new Set(room ? [...room.queue, ...(room.current ? [room.current] : [])].filter((e) => !e.mystery).map((e) => e.songId) : []);
    return list.map((s) => {
      const out = cat().songSummary(s);
      if (sung.has(s.id)) out.tn = 1;
      if (queued.has(s.id)) out.qd = 1;
      return out;
    });
  };
  const artistSummary = (a) => ({ key: a.key, name: a.name, letter: a.letter, count: a.count, solo: a.solo });

  /** Guests never see explicit songs when the explicit filter is on. */
  const filterFor = (ctx, extra = {}) => {
    const f = { ...extra };
    if (!ctx.isHost && settings.get('queue.explicitFilter')) f.noExplicit = true;
    return Object.keys(f).length ? f : null;
  };
  const queryFilter = (q) => {
    const f = {};
    const tag = q.get('tag');
    const letter = q.get('letter');
    const genre = q.get('genre');
    const decade = Number(q.get('decade'));
    if (tag) f.tag = tag.slice(0, 60);
    if (letter) f.letter = letter.slice(0, 1).toUpperCase();
    if (genre) f.genre = genre.slice(0, 60);
    if (decade) f.decade = decade;
    return f;
  };
  const page = (q, def = 60) => ({ limit: intParam(q, 'limit', def, 1, 200), offset: intParam(q, 'offset', 0, 0, 1e6) });
  const requireHost = (ctx) => {
    if (ctx.isHost) return;
    throw new HttpError(auth.pin ? 401 : 403, auth.pin ? 'Host PIN required' : 'Only the computer running OpenKaraoke can do this', { code: auth.pin ? 'pin_required' : 'host_only' });
  };

  let lettersCache = null;
  const letterCounts = () => {
    if (lettersCache?.v === cat().version) return lettersCache.data;
    const songs = new Map();
    const artists = new Map();
    for (const s of cat().songList) songs.set(s.letter, (songs.get(s.letter) || 0) + 1);
    for (const a of cat().artistList) artists.set(a.letter, (artists.get(a.letter) || 0) + 1);
    const data = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => ({ letter: l, songs: songs.get(l) || 0, artists: artists.get(l) || 0 }));
    lettersCache = { v: cat().version, data };
    return data;
  };

  router.get('/api/info', () => app.info());
  // Is this OpenKaraoke up, and is it this very process (the hotspot checks it through the
  // hotspot's address)? Nothing secret.
  router.get('/api/health', () => ({ ok: true, version: app.version, instance: app.instance }));

  // Many phones typing at once on a 90k-track library: identical searches are answered from a
  // small cache, and each phone gets a generous but finite number of searches.
  const searchCache = new Lru({ max: 300 });
  const searchLimit = new RateLimiter({ capacity: 40, perMs: 10_000 });
  const cachedSearch = (q, opts) => {
    const key = `${cat().version}:${cat().metaVersion}|${q}|${opts.limit}|${opts.offset}|${JSON.stringify(opts.filter)}`;
    let r = searchCache.get(key);
    if (!r) searchCache.set(key, (r = cat().search(q, opts)));
    return r;
  };

  router.get('/api/search', (ctx) => {
    const q = (ctx.query.get('q') || '').slice(0, 200);
    const { limit, offset } = page(ctx.query);
    if (!q.trim()) return { total: 0, fuzzy: false, items: [], artists: [] };
    if (!ctx.isHost && !searchLimit.take(String(ctx.ip))) throw new HttpError(429, 'Too many searches — wait a few seconds.');
    const r = cachedSearch(q, { limit, offset, filter: filterFor(ctx, queryFilter(ctx.query)) });
    const out = { total: r.total, fuzzy: r.fuzzy, items: summaries(r.items) };
    if (offset === 0 && q.trim().length >= 2) {
      out.artists = cat().listArtists({ q, limit: 200 }).items
        .sort((a, b) => b.trackCount - a.trackCount)
        .slice(0, 6)
        .map(artistSummary);
    }
    return out;
  });

  // A whole playlist or favourites list in one call.
  router.get('/api/songs', (ctx) => {
    const ids = (ctx.query.get('ids') || '').split(',').filter(Boolean).slice(0, MAX_LIST_SONGS);
    return { items: summaries(ids.map((id) => cat().song(id)).filter(Boolean)) };
  });

  router.get('/api/songs/:id', (ctx) => {
    const detail = cat().songDetail(ctx.params.id);
    if (!detail) throw new HttpError(404, 'Song not found');
    detail.meta = app.artwork?.publicSongMeta(detail.key) || null;
    // What each version allows for the vocals (shared/vocals.js): a guide singer that can be
    // turned up or down, one mixed in, backing vocals with or without.
    for (const v of detail.versions) {
      const voc = app.room?.trackVocals(v.id);
      if (voc) v.vocals = { lead: leadKind(voc), side: voc.side, bgv: voc.bgv };
    }
    const many = detail.versions.length > 1;
    detail.vocalOptions = {
      lead: detail.versions.some((v) => v.vocals?.lead === 'adjustable' || v.vocals?.lead === 'multiplex'),
      bgv: many && detail.versions.some((v) => v.vocals?.bgv === 'without'),
    };
    // Plays and votes per version. A valid guest token counts first: a guest page on this
    // computer (trusted as the host over HTTP) still gets the guest's view and its own vote.
    const guestId = auth.verify(String(ctx.req.headers['x-guest-token'] || ''), 'guest')?.id || null;
    const guest = !!guestId || !ctx.isHost;
    const voter = guestId || (ctx.isHost ? HOST_VOTER : null);
    return app.room ? app.room.decorateVersions(detail, { voter, guest }) : detail;
  });

  router.get('/api/artists', (ctx) => {
    const { limit, offset } = page(ctx.query, 200);
    const r = cat().listArtists({
      letter: (ctx.query.get('letter') || '').slice(0, 1).toUpperCase(),
      q: (ctx.query.get('q') || '').slice(0, 100),
      sort: ctx.query.get('sort') === 'count' ? 'count' : 'name',
      limit,
      offset,
    });
    return { total: r.total, items: r.items.map(artistSummary) };
  });

  router.get('/api/artists/:key', (ctx) => {
    const a = cat().artist(ctx.params.key);
    if (!a) throw new HttpError(404, 'Artist not found');
    const songs = cat().filterSongs(filterFor(ctx, { artist: a.key }), { limit: 5000, sort: 'title' }).items;
    app.artwork?.request('artist', a, 'visible', 'all'); // the artist page shows fanart and the logo
    return { artist: { ...artistSummary(a), art: app.artwork?.publicArtist(a.key) || null }, songs: summaries(songs) };
  });

  router.get('/api/browse/popular', (ctx) => {
    const args = { ...page(ctx.query), filter: filterFor(ctx, queryFilter(ctx.query)) };
    const r = ctx.query.get('sort') === 'plays' ? cat().mostSung(args) : cat().popular(args);
    return { total: r.total, items: summaries(r.items) };
  });

  router.get('/api/browse/facets', () => ({
    ...cat().facets(),
    letters: letterCounts(),
    brands: cat().brandCounts.slice(0, 60),
  }));

  router.get('/api/browse/tag/:tag', (ctx) => {
    const sort = ctx.query.get('sort') === 'title' ? 'title' : 'popular';
    const r = cat().byTag(ctx.params.tag, { ...page(ctx.query), sort, filter: filterFor(ctx) });
    return { total: r.total, items: summaries(r.items) };
  });

  router.get('/api/browse/letter/:letter', (ctx) => {
    const sort = ctx.query.get('sort') === 'artist' ? 'artist' : 'title';
    const r = cat().filterSongs(filterFor(ctx, { letter: ctx.params.letter.slice(0, 1).toUpperCase() }), { ...page(ctx.query, 100), sort });
    return { total: r.total, items: summaries(r.items) };
  });

  router.get('/api/random', (ctx) => {
    const n = intParam(ctx.query, 'n', 10, 1, 50);
    return { items: summaries(cat().random(n, filterFor(ctx, queryFilter(ctx.query)))) };
  });

  router.get('/api/qr.svg', (ctx) => {
    const text = ctx.query.get('text') || app.info().joinUrl;
    if (text.length > 512) throw new HttpError(400, 'QR text is too long (max 512 characters)');
    const dark = COLOR_RE.test(ctx.query.get('dark') || '') ? ctx.query.get('dark') : '#000000';
    const lightParam = ctx.query.get('light') || '';
    const light = lightParam === 'transparent' || COLOR_RE.test(lightParam) ? lightParam : '#ffffff';
    const svg = qrSvg(text, { dark, light, margin: intParam(ctx.query, 'margin', 2, 0, 8) });
    sendText(ctx.res, 200, svg, 'image/svg+xml', { 'cache-control': 'public, max-age=3600' });
  });

  // Cover art from the artwork service; for every miss a deterministic placeholder, so an
  // <img> never breaks. Placeholders are revalidated (no-cache + ETag) because real art may
  // arrive at any time; clients also get an `art` event and reload the image.
  const placeholder = (ctx, opts) => {
    const svg = placeholderSvg(opts);
    const etag = `W/"ph-${hash32(svg).toString(36)}"`;
    const headers = { 'cache-control': 'no-cache', etag };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return;
    }
    sendText(ctx.res, 200, svg, 'image/svg+xml', headers);
  };

  router.get('/api/art/song/:id', async (ctx) => {
    const song = cat().song(ctx.params.id);
    if (app.artwork && song && (await app.artwork.serveSong(ctx, song))) return;
    placeholder(ctx, { artist: song?.artist || '', title: song?.title || ctx.params.id });
  });

  router.get('/api/art/artist/:key', async (ctx) => {
    const artist = cat().artist(ctx.params.key);
    if (app.artwork && artist && (await app.artwork.serveArtist(ctx, artist))) return;
    if (ctx.query.get('type') && ctx.query.get('type') !== 'picture') throw new HttpError(404, 'No image of this kind');
    placeholder(ctx, { artist: artist?.name || ctx.params.key });
  });

  router.get('/api/art/candidate/:songId/:cid', async (ctx) => {
    requireHost(ctx);
    const song = cat().song(ctx.params.songId);
    if (song && (await app.artwork.serveCandidate(ctx, song, ctx.params.cid))) return;
    placeholder(ctx, { artist: song?.artist || '', title: song?.title || '' });
  });

  // The host's own cover picture for a song (resized in the browser).
  router.post('/api/art/song/:id/cover', async (ctx) => {
    requireHost(ctx);
    if (!/^image\//i.test(ctx.req.headers['content-type'] || '')) throw new HttpError(415, 'Send a picture');
    const song = cat().song(ctx.params.id);
    if (!song) throw new HttpError(404, 'Song not found');
    const buf = await readBody(ctx.req, 8 * 1024 * 1024);
    return app.artwork.setCustomCover(song, buf);
  });

  router.get('/api/artwork', (ctx) => {
    requireHost(ctx);
    return app.artwork.status();
  });

  // ---- library management (host) -------------------------------------------------

  router.get('/api/library', (ctx) => {
    const st = library.status();
    if (!ctx.isHost) {
      st.roots = st.roots.map((r) => ({ online: r.online, tracks: r.tracks }));
      st.lastScan = st.lastScan ? { at: st.lastScan.at, tracks: st.lastScan.tracks } : null; // no folder paths
    }
    return st;
  });

  router.post('/api/library/scan', (ctx) => {
    requireHost(ctx);
    library.scan({ reason: 'host' }).catch((e) => log.error('scan failed', e));
    return library.status();
  });

  router.post('/api/library/paths', async (ctx) => {
    requireHost(ctx);
    const body = await readJsonBody(ctx.req);
    if (!Array.isArray(body.paths) || body.paths.length > 20) throw new HttpError(400, 'Send { "paths": ["/folder", …] }');
    for (const p of body.paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new HttpError(400, `Not an absolute folder path: ${p}`);
    }
    await library.setPaths(body.paths);
    library.scan({ reason: 'folders changed' }).catch((e) => log.error('scan failed', e));
    return library.status();
  });

  router.get('/api/fs/list', async (ctx) => {
    requireHost(ctx);
    return listFolders(ctx.query.get('path') || '');
  });

  songbookRoutes(router, app, { requireHost });

  // Guest photos: raw image body (resized on the phone), identified by the signed guest token.
  router.post('/api/photos', async (ctx) => {
    if (!/^image\/(?:jpeg|png|webp)$/i.test(ctx.req.headers['content-type'] || '')) throw new HttpError(415, 'Send a JPEG, PNG or WebP picture');
    const deviceId = auth.verify(String(ctx.req.headers['x-guest-token'] || ''), 'guest')?.id;
    if (!deviceId) throw new HttpError(401, 'Join the party first');
    if (Number(ctx.req.headers['content-length']) > MAX_PHOTO_BYTES) throw new HttpError(413, `That photo is too big (max ${MAX_PHOTO_BYTES >> 20} MB)`);
    // Everything that can refuse the photo (switched off, banned, rate limit, too many at once)
    // runs before its bytes are read and held in memory; a stalled or crawling upload is cut off.
    const photos = app.room.photos;
    const upload = photos.admit(deviceId, ctx.ip);
    try {
      const body = await photos.receive(upload, ctx.req).catch((e) => {
        ctx.res.setHeader('connection', 'close'); // cut off: answer now, not after the rest arrives
        throw e;
      });
      return { photo: await photos.store(deviceId, body, ctx.ip) };
    } finally {
      upload.release();
    }
  });

  router.get('/api/photos/:id', async (ctx) => {
    const f = app.room.photos.fileFor(ctx.params.id, { host: ctx.isHost });
    if (!f) throw new HttpError(404, 'Photo not found');
    try {
      await sendFile(ctx.req, ctx.res, f.abs, { contentType: f.type, cacheControl: 'private, max-age=86400' });
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'Photo not found');
      throw e;
    }
  });

  // Break music from the music folder (only files found by the break-music scan).
  router.get('/media/break/:id', async (ctx) => {
    const abs = app.room.breakMusic.folderFile(ctx.params.id);
    if (!abs) throw new HttpError(404, 'Not found');
    try {
      await sendFile(ctx.req, ctx.res, abs, { cacheControl: 'private, max-age=3600' });
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'Not found');
      throw e;
    }
  });

  // Remote TV displays: the screen asks for a pairing code, then polls until the host approves.
  router.post('/api/pair', async (ctx) => {
    await readJsonBody(ctx.req, 1024);
    return app.room.pairRequest(ctx.ip);
  });
  // The waiting screen follows the skin too (it has no WebSocket state yet).
  router.get('/api/pair/:id', (ctx) => ({ ...app.room.pairStatus(ctx.params.id), appearance: app.settings.get('appearance') }));

  router.post('/api/auth/pin', async (ctx) => {
    const body = await readJsonBody(ctx.req, 4096);
    const token = auth.loginWithPin(String(body.pin ?? ''), ctx.ip);
    ctx.res.setHeader('set-cookie', `ok_host=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    return { token };
  });
}

/** Folder picker data: sub-folders of `p`, or likely drive/music locations when `p` is empty. */
export async function listFolders(p) {
  if (!p) {
    const seen = new Set();
    const out = [];
    const add = (dir, label) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      out.push({ name: label || dir, path: dir });
    };
    for (const d of defaultMusicDirs()) {
      const isMountParent = /^\/(?:run\/media|media|mnt)(?:\/|$)/.test(d);
      try {
        const entries = await fsp.readdir(d, { withFileTypes: true });
        if (isMountParent) {
          for (const e of entries) {
            if (!e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())) add(path.join(d, e.name), `💾 ${e.name}`);
          }
        } else {
          add(d);
        }
      } catch { /* not there */ }
    }
    add(os.homedir(), `🏠 ${os.homedir()}`);
    return { path: '', parent: null, dirs: out, karaokeFiles: 0 };
  }
  const abs = path.resolve(p);
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, 'Folder not found');
    throw new HttpError(400, `Cannot open this folder (${e.code || e.message})`);
  }
  const dirs = [];
  let karaokeFiles = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = await fsp.stat(path.join(abs, e.name)).then((s) => s.isDirectory(), () => false);
    if (isDir) dirs.push(e.name);
    else if (/\.(cdg|mp4|webm|mkv|zip)$/i.test(e.name)) karaokeFiles++;
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? null : parent,
    dirs: dirs.slice(0, 5000).map((name) => ({ name, path: path.join(abs, name) })),
    karaokeFiles,
  };
}
