// Builds the OpenKaraoke server: settings, library, HTTP routes, WebSocket hub.
// `createApp()` is used by server/index.js and by the tests (listen on port 0).
import http from 'node:http';
import path from 'node:path';
import { Settings, makeRoomCode, VERSION, PUBLIC_DIR, SHARED_DIR } from './config.js';
import { LibraryService } from './library/service.js';
import { Auth } from './room/auth.js';
import { Router, json, sendError, sendText } from './http/router.js';
import { serveStatic } from './http/static.js';
import { apiRoutes } from './http/api.js';
import { mediaRoutes } from './http/media.js';
import { Hub } from './ws/hub.js';
import { Room } from './room/room.js';
import { ArtworkService } from './artwork/service.js';
import { ArtFeed } from './artwork/feed.js';
import { lanAddresses, isLocalAddress } from './util/net.js';
import { HttpError } from './util/errors.js';


/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {object} [opts.args] parsed CLI args (library, pin)
 * @param {boolean} [opts.scan] see LibraryService.init
 * @param {boolean} [opts.watch] poll library folders for USB plug/unplug
 * @param {typeof fetch} [opts.fetch] outgoing HTTP for artwork providers (tests inject a fake)
 * @param {boolean} [opts.crawl] run the background artwork crawler (default true)
 */
export async function createApp({ dataDir, args = {}, scan, watch = true, fetch = globalThis.fetch, crawl = true } = {}) {
  const settings = new Settings(dataDir);
  await settings.load();
  if (args.library?.length) settings.update({ library: { paths: [...new Set(args.library.map((p) => path.resolve(p)))] } });
  if (args.pin !== undefined) settings.update({ party: { adminPin: String(args.pin) } });
  if (!/^[A-Z]{4}$/.test(settings.get('party.roomCode') || '')) settings.update({ party: { roomCode: makeRoomCode() } });

  const auth = new Auth({ dataDir, settings });
  await auth.load();
  const library = new LibraryService({ dataDir, settings });
  await library.init({ scan });
  if (watch) library.startWatcher();
  const artwork = new ArtworkService({ dataDir, settings, library, fetch, version: VERSION });
  await artwork.init({ crawl });

  const router = new Router();
  const hub = new Hub();
  const app = { dataDir, settings, library, artwork, auth, router, hub, version: VERSION, port: 0, server: null, closers: [] };

  app.info = () => {
    const port = app.port || settings.get('server.port');
    const code = settings.get('party.roomCode');
    const lanUrls = lanAddresses().map((a) => `http://${a.address}:${port}`);
    const pub = String(settings.get('server.publicUrl') || '').trim().replace(/\/+$/, '');
    const baseUrl = pub || lanUrls[0] || `http://localhost:${port}`;
    const st = library.status();
    return {
      name: settings.get('party.name'),
      roomCode: code,
      joinUrl: `${baseUrl}/j/${code}`,
      baseUrl,
      lanUrls,
      version: VERSION,
      library: { tracks: st.tracks, songs: st.songs, artists: st.artists, offline: st.offline, scanning: st.scanning },
    };
  };

  apiRoutes(router, app);
  mediaRoutes(router, app);
  pageRoutes(router);

  const server = http.createServer((req, res) => handleRequest(app, req, res));
  server.keepAliveTimeout = 30_000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });
  app.server = server;
  hub.checkOrigin = (req) => auth.trustedOrigin(req.headers.origin);
  hub.attach(server);

  const room = new Room(app);
  await room.load();
  app.room = room;
  const artFeed = new ArtFeed({ hub, secrets: () => room.artSecrets() });
  app.artFeed = artFeed;
  hub.onHello = async (client, msg) => {
    const res = await room.hello(client, msg);
    // Artwork that changed while this page was offline (it sends the last `seq` it saw).
    if (res?.ok) res.welcome = { ...res.welcome, art: artFeed.replay(res.role, msg.artSeq) };
    return res;
  };
  hub.onRequest = (client, msg) => room.request(client, msg);
  hub.on('join', (client) => room.onJoin(client));
  hub.on('leave', (client) => room.onLeave(client));
  app.closers.push(() => room.close());
  app.closers.push(() => artwork.close());

  library.on('changed', () => room.onLibraryChanged());
  library.on('status', () => room.markDirty());
  library.on('progress', (progress) => hub.broadcast({ t: 'lib', progress }, (c) => c.role === 'host'));
  artwork.on('art', (m) => {
    artFeed.publish(m);
    room.onArt(m);
  });
  // Which stored art a song shows changed, no image did: the TV's view, nothing to load again.
  artwork.on('artChoice', (m) => room.onArt(m));
  artwork.on('status', () => hub.broadcast({ t: 'artwork', status: artwork.status() }, (c) => c.role === 'host'));

  app.listen = (port, host) => new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      app.port = server.address().port;
      resolve(app);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  app.close = async () => {
    library.stop();
    hub.close();
    for (const fn of app.closers) await fn();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await settings.flush();
    await library.saving;
  };

  return app;
}

async function handleRequest(app, req, res) {
  let url = null;
  try {
    url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress;
    // Pages of other web sites must not change anything here (CSRF / DNS rebinding).
    if (req.method !== 'GET' && req.method !== 'HEAD' && !app.auth.trustedOrigin(req.headers.origin)) {
      throw new HttpError(403, 'Requests from other web sites are not allowed');
    }
    const ctx = {
      app, req, res, url, ip,
      path: url.pathname,
      query: url.searchParams,
      isLocal: isLocalAddress(ip),
      isHost: app.auth.isHostRequest(req),
      params: {},
    };
    const m = app.router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.allowed) {
      res.setHeader('allow', [...m.allowed, ...(m.allowed.includes('GET') ? ['HEAD'] : [])].join(', '));
      throw new HttpError(405, 'Method not allowed');
    }
    ctx.params = m.params;
    const out = await m.handler(ctx);
    if (out !== undefined && !res.headersSent) json(res, 200, out);
  } catch (e) {
    const isPage = url && !/^\/(?:api|media)\//.test(url.pathname);
    if (isPage && e?.status === 404 && !res.headersSent) {
      sendText(res, 404, NOT_FOUND_PAGE, 'text/html; charset=utf-8');
    } else {
      sendError(res, e);
    }
  }
}

function pageRoutes(router) {
  const shell = (file) => async ({ req, res }) => {
    res.setHeader('referrer-policy', 'same-origin');
    if (!(await serveStatic(req, res, PUBLIC_DIR, file))) throw new HttpError(404, 'Page not found');
  };
  router.get('/', shell('index.html'));
  router.get('/host', shell('host.html'));
  router.get('/tv', shell('tv.html'));
  router.get('/j', shell('guest.html'));
  router.get('/j/:code', shell('guest.html'));
  router.get('/guest', shell('guest.html'));
  const folder = (dir) => async ({ req, res, params }) => {
    if (!(await serveStatic(req, res, dir, params.rest))) throw new HttpError(404, 'Not found');
  };
  for (const dir of ['js', 'css', 'img', 'fonts']) router.get(`/${dir}/*`, folder(path.join(PUBLIC_DIR, dir)));
  router.get('/shared/*', folder(SHARED_DIR));
  router.get('/favicon.ico', ({ res }) => {
    res.writeHead(301, { location: '/img/icon.svg' });
    res.end();
  });
}

const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found · OpenKaraoke</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0b16;color:#eee;font:16px system-ui,sans-serif;text-align:center">
<div><div style="font-size:64px">🎤</div><h1 style="margin:.2em 0">Page not found</h1><p><a href="/" style="color:#ff3d8b">Go to the start page</a></p></div></body></html>`;
