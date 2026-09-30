// JSON API (PLAN §8). Everything here is read-only except the host-only endpoints.
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { json, text, intParam, readJsonBody, HttpError } from './router.js';
import { qrSvg } from '../util/qr.js';
import { placeholderSvg } from '../artwork/placeholder.js';
import { defaultMusicDirs } from '../config.js';

const HEX = /^#?[0-9a-f]{3,8}$/i;

/**
 * @param {import('./router.js').Router} router
 * @param {object} ctx
 * @param {import('../library/service.js').LibraryService} ctx.library
 * @param {import('../config.js').Settings} ctx.settings
 * @param {import('../room/auth.js').Auth} ctx.auth
 * @param {(req) => object} ctx.info
 * @param {(song) => object} [ctx.decorate] extra per-song fields (e.g. "sung tonight")
 */
export function registerApi(router, ctx) {
  const { library, settings, auth } = ctx;
  const cat = () => library.catalog;
  const isHost = (req) => auth.isHostRequest(req);
  const requireHost = (req) => {
    if (!isHost(req)) throw new HttpError(403, 'Host access required');
  };
  const summary = (s) => cat().songSummary(s, ctx.decorate?.(s));
  const page = (r) => ({ total: r.total, fuzzy: r.fuzzy || undefined, items: r.items.map(summary) });

  /** Guests never see explicit songs when the explicit filter is on. */
  const filterFor = (req, query) => {
    const f = {};
    const tag = query.get('tag');
    const letter = query.get('letter');
    const artist = query.get('artist');
    if (tag) f.tag = tag;
    if (letter) f.letter = letter.toUpperCase();
    if (artist) f.artist = artist;
    if (settings.get('queue.explicitFilter') && !isHost(req)) f.noExplicit = true;
    const maxDur = settings.get('queue.maxDuration');
    if (maxDur > 0 && query.get('fits') === '1') f.maxDuration = maxDur;
    return Object.keys(f).length ? f : null;
  };

  router.get('/api/info', (req, res) => json(res, 200, ctx.info(req)));

  router.get('/api/library/status', (req, res) => json(res, 200, library.status()));

  // Remote host login: PIN -> host token (the PC itself never needs it).
  router.post('/api/auth/pin', async (req, res) => {
    const body = await readJsonBody(req, 4096);
    const r = auth.checkPin(body.pin, req.socket.remoteAddress);
    if (!r.ok) throw new HttpError(403, r.error);
    json(res, 200, { token: auth.sign('host', String(body.deviceId || 'web').slice(0, 40)) });
  });

  router.post('/api/library/rescan', (req, res) => {
    requireHost(req);
    library.scan({ reason: 'host' }).catch(() => {});
    json(res, 202, library.status());
  });

  router.get('/api/search', (req, res, { query }) => {
    const q = (query.get('q') || '').slice(0, 200);
    const limit = intParam(query, 'limit', 60, 1, 500);
    const offset = intParam(query, 'offset', 0, 0, 1e6);
    const filter = filterFor(req, query);
    const sort = query.get('sort') || 'popular';
    let r;
    if (q.trim()) r = cat().search(q, { limit, offset, filter });
    else if (sort === 'popular') r = cat().popular({ limit, offset, filter });
    else r = cat().filterSongs(filter || {}, { limit, offset, sort });
    json(res, 200, page(r));
  });

  router.get('/api/songs/:id', (req, res, { params }) => {
    const d = cat().songDetail(params.id);
    if (!d) throw new HttpError(404, 'Unknown song');
    const song = cat().song(params.id);
    const best = cat().bestTrack(song, settings.get('library.brandPriority') || []);
    const noExplicit = settings.get('queue.explicitFilter') && !isHost(req);
    if (noExplicit && d.x) throw new HttpError(404, 'Unknown song');
    Object.assign(d, ctx.decorate?.(song) || {});
    d.best = best?.id || null;
    if (!isHost(req)) for (const v of d.versions) delete v.file;
    json(res, 200, d);
  });

  router.get('/api/artists', (req, res, { query }) => {
    const r = cat().listArtists({
      letter: (query.get('letter') || '').toUpperCase(),
      q: (query.get('q') || '').slice(0, 100),
      limit: intParam(query, 'limit', 200, 1, 2000),
      offset: intParam(query, 'offset', 0, 0, 1e6),
      sort: query.get('sort') === 'count' ? 'count' : 'name',
      minSongs: intParam(query, 'min', 1, 1, 1000),
    });
    json(res, 200, { total: r.total, items: r.items.map((a) => ({ key: a.key, name: a.name, count: a.count, letter: a.letter })) });
  });

  router.get('/api/artists/:key', (req, res, { params }) => {
    const a = cat().artist(params.key);
    if (!a) throw new HttpError(404, 'Unknown artist');
    const noExplicit = settings.get('queue.explicitFilter') && !isHost(req);
    const songs = cat().songsOfArtist(a.key).filter((s) => !noExplicit || !cat().isExplicit(s));
    json(res, 200, { artist: { key: a.key, name: a.name, count: a.count, letter: a.letter }, songs: songs.map(summary) });
  });

  router.get('/api/browse/popular', (req, res, { query }) => {
    const r = cat().popular({
      limit: intParam(query, 'limit', 100, 1, 500),
      offset: intParam(query, 'offset', 0, 0, 1e6),
      filter: filterFor(req, query),
    });
    json(res, 200, page(r));
  });

  router.get('/api/browse/facets', (req, res) => {
    const letters = {};
    for (const a of cat().artistList) letters[a.letter] = (letters[a.letter] || 0) + 1;
    json(res, 200, { ...cat().facets(), letters, brands: cat().brandCounts.slice(0, 40) });
  });

  router.get('/api/browse/tag/:tag', (req, res, { params, query }) => {
    const r = cat().byTag(params.tag, {
      limit: intParam(query, 'limit', 100, 1, 500),
      offset: intParam(query, 'offset', 0, 0, 1e6),
      sort: query.get('sort') === 'title' ? 'title' : 'popular',
      filter: filterFor(req, query),
    });
    json(res, 200, page(r));
  });

  router.get('/api/random', (req, res, { query }) => {
    const n = intParam(query, 'n', 10, 1, 100);
    const items = cat().random(n, filterFor(req, query));
    json(res, 200, { total: items.length, items: items.map(summary) });
  });

  router.get('/api/qr.svg', (req, res, { query }) => {
    const t = query.get('text') || ctx.info(req).joinUrl;
    if (t.length > 512) throw new HttpError(400, 'Text too long');
    const dark = query.get('dark');
    const light = query.get('light');
    const svg = qrSvg(t, {
      dark: dark && HEX.test(dark) ? `#${dark.replace('#', '')}` : '#000000',
      light: light === 'transparent' ? 'transparent' : light && HEX.test(light) ? `#${light.replace('#', '')}` : '#ffffff',
      margin: intParam(query, 'margin', 2, 0, 8),
    });
    text(res, 200, svg, 'image/svg+xml', { 'cache-control': 'no-cache' });
  });

  // Artwork: placeholders until the artwork service (M5) provides real covers.
  router.get('/api/art/song/:id', (req, res, { params, query }) => {
    if (ctx.art?.song) return ctx.art.song(req, res, params.id);
    const s = cat().song(params.id);
    const svg = placeholderSvg({ artist: s?.artist || '', title: s?.title || '', plain: query.get('plain') === '1' });
    text(res, 200, svg, 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
  });

  router.get('/api/art/artist/:key', (req, res, { params }) => {
    if (ctx.art?.artist) return ctx.art.artist(req, res, params.key);
    const a = cat().artist(params.key);
    const svg = placeholderSvg({ artist: a?.name || params.key });
    text(res, 200, svg, 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
  });

  // Host-only: folder picker for the library settings.
  router.get('/api/fs/list', async (req, res, { query }) => {
    requireHost(req);
    json(res, 200, await listFolders(query.get('path') || ''));
  });

  router.get('/api/settings', (req, res) => {
    requireHost(req);
    json(res, 200, settings.data);
  });

  router.post('/api/settings', async (req, res) => {
    requireHost(req);
    const patch = await readJsonBody(req);
    const applied = ctx.updateSettings ? await ctx.updateSettings(patch) : settings.update(patch);
    json(res, 200, { applied, settings: settings.data });
  });
}

/** Lists sub-folders of `dir`; without a path, suggests mount points and the home folder. */
export async function listFolders(dir) {
  if (!dir) {
    const suggestions = [];
    for (const d of [...defaultMusicDirs(), os.homedir()]) {
      try {
        if ((await fsp.stat(d)).isDirectory() && !suggestions.some((s) => s.path === d)) {
          suggestions.push({ name: d, path: d });
        }
      } catch { /* not there */ }
    }
    return { path: '', parent: null, dirs: suggestions };
  }
  const abs = path.resolve(dir);
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(e.code === 'ENOENT' ? 404 : 400, `Cannot open folder: ${e.code || e.message}`);
  }
  const dirs = [];
  let karaokeFiles = 0;
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory() || ent.isSymbolicLink()) {
      if (ent.isSymbolicLink()) {
        try { if (!(await fsp.stat(path.join(abs, ent.name))).isDirectory()) continue; } catch { continue; }
      }
      dirs.push({ name: ent.name, path: path.join(abs, ent.name) });
    } else if (/\.(cdg|zip|mp4|webm|mkv)$/i.test(ent.name)) karaokeFiles++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs: dirs.slice(0, 3000), karaokeFiles };
}
