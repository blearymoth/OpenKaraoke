// Wires settings, auth, library, HTTP (API + media + static) and the WebSocket hub.
// server/index.js is the CLI entry; tests create apps directly.
import http from 'node:http';
import path from 'node:path';
import { Settings, PUBLIC_DIR, SHARED_DIR, VERSION, makeRoomCode } from './config.js';
import { LibraryService, normalizePaths } from './library/service.js';
import { Router, text, redirect } from './http/router.js';
import { serveStatic } from './http/static.js';
import { MediaService } from './http/media.js';
import { registerApi } from './http/api.js';
import { Hub, WsError } from './ws/hub.js';
import { Auth } from './room/auth.js';
import { lanAddresses } from './util/net.js';
import { logger } from './util/log.js';

const PAGES = { '/': 'index.html', '/host': 'host.html', '/tv': 'tv.html', '/guest': 'guest.html' };

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} [o.args] parsed CLI args (see config.parseArgs)
 */
export async function createApp({ dataDir, args = {}, log = logger('server'), watchIntervalMs = 20000 } = {}) {
  const settings = new Settings(dataDir);
  await settings.load();
  if (args.library?.length) settings.update({ library: { paths: normalizePaths(args.library) } });
  if (args.pin != null) settings.update({ party: { adminPin: String(args.pin) } });
  if (!/^[A-Z]{4}$/.test(settings.get('party.roomCode') || '')) settings.update({ party: { roomCode: makeRoomCode() } });

  const auth = await new Auth({ dataDir, settings }).init();
  const library = new LibraryService({ dataDir, settings, watchIntervalMs });
  const media = new MediaService({ library });
  const router = new Router();
  let port = Number(args.port || process.env.PORT || settings.get('server.port')) || 8080;

  const app = {
    settings, auth, library, media, router, dataDir, hub: null, server: null, room: null,
    get port() { return port; },
  };

  /** Public addresses, join URL and room code. */
  app.info = (req) => {
    const lan = lanAddresses();
    const lanUrls = lan.map((a) => `http://${a.address}:${port}`);
    const publicUrl = String(settings.get('server.publicUrl') || '').replace(/\/+$/, '');
    const base = publicUrl || lanUrls[0] || `http://localhost:${port}`;
    const roomCode = settings.get('party.roomCode');
    return {
      name: settings.get('party.name'),
      version: VERSION,
      roomCode,
      baseUrl: base,
      joinUrl: `${base}/j/${roomCode}`,
      lanUrls,
      localUrl: `http://localhost:${port}`,
      library: summaryStatus(library.status()),
      host: req ? auth.isHostRequest(req) : false,
      pinSet: auth.pinConfigured(),
    };
  };

  media.register(router);
  registerApi(router, {
    library, settings, auth,
    info: (req) => app.info(req),
    decorate: (song) => app.room?.decorate(song),
    updateSettings: (patch) => (app.room ? app.room.updateSettings(patch) : settings.update(patch)),
  });

  // App shells and static folders
  for (const [route, file] of Object.entries(PAGES)) {
    router.get(route, (req, res) => serveStatic(req, res, PUBLIC_DIR, file));
  }
  router.get('/j', (req, res) => redirect(res, `/j/${settings.get('party.roomCode')}`));
  router.get('/join', (req, res) => redirect(res, `/j/${settings.get('party.roomCode')}`));
  router.get('/j/:code', (req, res) => serveStatic(req, res, PUBLIC_DIR, 'guest.html'));
  for (const dir of ['js', 'css', 'img', 'fonts']) {
    router.get(`/${dir}/*`, (req, res, { params }) => serveStatic(req, res, path.join(PUBLIC_DIR, dir), params.rest));
  }
  router.get('/shared/*', (req, res, { params }) => serveStatic(req, res, SHARED_DIR, params.rest));
  router.get('/favicon.ico', (req, res) => serveStatic(req, res, PUBLIC_DIR, 'img/icon.svg'));
  router.get('/manifest.webmanifest', (req, res) => serveStatic(req, res, PUBLIC_DIR, 'manifest.webmanifest'));

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { text(res, 400, 'Bad request'); return; }
    try {
      if (await router.handle(req, res, url)) return;
      text(res, 404, 'Not found');
    } catch (e) {
      log.error('request failed', req.url, e);
      if (!res.headersSent) text(res, 500, 'Internal error');
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 65000;
  app.server = server;

  const hub = new Hub({ server });
  app.hub = hub;
  hub.onHello = (client, msg) => (app.room ? app.room.hello(client, msg) : basicHello(app, client, msg));

  // Library progress for host screens (the Room adds richer state later).
  let lastProgress = 0;
  library.on('progress', (p) => {
    const now = Date.now();
    if (now - lastProgress < 500) return;
    lastProgress = now;
    hub.broadcast({ t: 'lib', status: { ...summaryStatus(library.status()), progress: p } }, (c) => c.role === 'host');
  });
  library.on('status', (s) => hub.broadcast({ t: 'lib', status: summaryStatus(s) }, (c) => c.role === 'host' || c.role === 'tv'));

  app.listen = (p = port, host = args.host || settings.get('server.host') || '0.0.0.0') => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => {
      server.off('error', onError);
      port = server.address().port;
      resolve(app);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });

  app.start = async ({ scan = !args.noScan && settings.get('library.rescanOnStart') } = {}) => {
    await library.init({ scan, watch: watchIntervalMs > 0 });
    return app;
  };

  app.close = async () => {
    hub.close();
    await new Promise((r) => server.close(() => r()));
    server.closeAllConnections?.();
    await library.close();
    if (app.room) await app.room.close();
    await settings.flush();
  };

  return app;
}

export function summaryStatus(s) {
  return {
    state: s.state, tracks: s.tracks, songs: s.songs, artists: s.artists,
    roots: s.roots, progress: s.progress, lastScan: s.lastScan && { at: s.lastScan.at, ms: s.lastScan.ms, errorCount: s.lastScan.errorCount, changed: s.lastScan.changed },
  };
}

/** Minimal role check used before the Room is attached. */
function basicHello(app, client, msg) {
  const role = msg.role;
  if (role === 'host') {
    if (app.auth.trustsLocal(client.ip) || app.auth.verify(msg.token, 'host')) return { role };
    throw new WsError('PIN required', 'pin');
  }
  if (role === 'tv') return { role };
  if (role === 'guest') {
    if (String(msg.room || '').toUpperCase() !== app.settings.get('party.roomCode')) throw new WsError('Unknown room code', 'room');
    return { role };
  }
  throw new WsError('Unknown role');
}
