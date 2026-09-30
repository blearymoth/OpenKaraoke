import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createApp } from '../server/app.js';
import { Router, readBody } from '../server/http/router.js';
import { parseRange, safeJoin } from '../server/http/static.js';
import { WebSocket } from '../server/vendor/ws.mjs';
import { tmpDir, writeTree, makeZip } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const pattern = (n, seed = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255));

const AUDIO = pattern(50000, 1);
const CDG = Buffer.alloc(7200 * 30); // zeros compress well
const ZIP_AUDIO = pattern(30000, 3);
const ZIP_CDG = pattern(7200 * 5, 5);

let app;
let base;

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const getJson = async (path, headers) => {
  const r = await get(path, headers);
  return { ...r, json: JSON.parse(r.body.toString()) };
};

before(async () => {
  const lib = await tmpDir();
  const data = await tmpDir();
  await writeTree(lib, {
    'A/Adele/Adele - Hello [SF Karaoke].cdg': CDG,
    'A/Adele/Adele - Hello [SF Karaoke].mp3': AUDIO,
    'Q/Queen/Queen - Bohemian Rhapsody [SC Karaoke].cdg': 7200 * 20,
    'Q/Queen/Queen - Bohemian Rhapsody [SC Karaoke].mp3': 100,
    'Z/Zipped/Zipped Band - Song [SC Karaoke].zip': makeZip([
      { name: 'Zipped Band - Song.cdg', data: ZIP_CDG, deflate: true },
      { name: 'Zipped Band - Song.mp3', data: ZIP_AUDIO },
    ]),
    'Z/Zipped/Deflated - Tune [SF Karaoke].zip': makeZip([
      { name: 'Deflated - Tune.cdg', data: ZIP_CDG, deflate: true },
      { name: 'Deflated - Tune.mp3', data: ZIP_AUDIO, deflate: true },
    ]),
    'V/Video Artist - Clip [KV Karaoke].mp4': pattern(4000, 9),
  });
  app = await createApp({ dataDir: data, args: { library: [lib], port: 0 }, log: quiet, watchIntervalMs: 0 });
  app.library.log = quiet;
  await app.listen(0, '127.0.0.1');
  await app.start({ scan: false });
  await app.library.scan();
  base = `http://127.0.0.1:${app.port}`;
});

after(async () => { await app.close(); });

async function trackOf(query) {
  const s = await getJson(`/api/search?q=${encodeURIComponent(query)}`);
  const d = await getJson(`/api/songs/${s.json.items[0].id}`);
  return d.json.best;
}

test('router params, wildcard and 405', async () => {
  const r = new Router();
  const seen = [];
  r.get('/a/:id/x', (req, res, { params }) => { seen.push(params.id); res.end(); });
  r.get('/files/*', (req, res, { params }) => { seen.push(params.rest); res.end(); });
  const fake = (method, url) => ({ method, url, headers: {} });
  const res = () => ({ end() {}, writeHead() {}, headersSent: false, req: {} });
  assert.equal(await r.handle(fake('GET', '/a/42/x'), res()), true);
  assert.equal(await r.handle(fake('GET', '/files/js/app.js'), res()), true);
  assert.equal(await r.handle(fake('GET', '/nope'), res()), false);
  assert.deepEqual(seen, ['42', 'js/app.js']);
});

test('readBody enforces the size limit', async () => {
  const { Readable } = await import('node:stream');
  const req = Readable.from([Buffer.alloc(10), Buffer.alloc(10)]);
  req.headers = {};
  await assert.rejects(readBody(req, 15), /too large/);
});

test('parseRange and safeJoin', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
  assert.equal(safeJoin('/srv/public', '../etc/passwd'), '/srv/public/etc/passwd');
  assert.equal(safeJoin('/srv/public', 'js/app.js'), '/srv/public/js/app.js');
  assert.equal(safeJoin('/srv/public', 'a\0b'), null);
});

test('info, search, song, artists, browse', async () => {
  const info = await getJson('/api/info');
  assert.match(info.json.roomCode, /^[A-Z]{4}$/);
  assert.ok(info.json.joinUrl.endsWith(`/j/${info.json.roomCode}`));
  assert.equal(info.json.library.tracks, 5);

  const s = await getJson('/api/search?q=helo');
  assert.equal(s.json.items[0].title, 'Hello');
  const song = await getJson(`/api/songs/${s.json.items[0].id}`);
  assert.equal(song.json.versions.length, 1);
  assert.ok(song.json.best);
  assert.equal((await get('/api/songs/nope')).status, 404);

  const artists = await getJson('/api/artists?letter=Q');
  assert.equal(artists.json.items[0].name, 'Queen');
  const page = await getJson(`/api/artists/${encodeURIComponent(artists.json.items[0].key)}`);
  assert.equal(page.json.songs[0].title, 'Bohemian Rhapsody');

  const pop = await getJson('/api/browse/popular?limit=2');
  assert.equal(pop.json.items.length, 2);
  const facets = await getJson('/api/browse/facets');
  assert.ok(facets.json.letters.A >= 1);
  const rnd = await getJson('/api/random?n=3');
  assert.equal(rnd.json.items.length, 3);
  const all = await getJson('/api/search?q=');
  assert.equal(all.json.total, 5);
});

test('audio supports HTTP Range', async () => {
  const id = await trackOf('adele hello');
  const full = await get(`/media/${id}/audio`);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/mpeg');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.deepEqual(full.body, AUDIO);

  const part = await get(`/media/${id}/audio`, { range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 0-99/${AUDIO.length}`);
  assert.deepEqual(part.body, AUDIO.subarray(0, 100));

  const tail = await get(`/media/${id}/audio`, { range: 'bytes=-10' });
  assert.deepEqual(tail.body, AUDIO.subarray(-10));
  const bad = await get(`/media/${id}/audio`, { range: `bytes=${AUDIO.length}-` });
  assert.equal(bad.status, 416);

  const cached = await get(`/media/${id}/audio`, { 'if-none-match': full.headers.etag });
  assert.equal(cached.status, 304);
});

test('CDG is gzipped when accepted', async () => {
  const id = await trackOf('adele hello');
  const gz = await get(`/media/${id}/cdg`, { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(gz.body.length < CDG.length / 10);
  assert.deepEqual(zlib.gunzipSync(gz.body), CDG);
  const plain = await get(`/media/${id}/cdg`);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.length, CDG.length);
  assert.equal((await get(`/media/${id}/video`)).status, 404);
  assert.equal((await get(`/media/${id}/bogus`)).status, 404);
  assert.equal((await get('/media/unknown/audio')).status, 404);
});

test('zipped tracks: stored and deflated entries with Range', async () => {
  const stored = await trackOf('zipped band song');
  const r1 = await get(`/media/${stored}/audio`, { range: 'bytes=100-199' });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers['content-range'], `bytes 100-199/${ZIP_AUDIO.length}`);
  assert.deepEqual(r1.body, ZIP_AUDIO.subarray(100, 200));
  const cdg = await get(`/media/${stored}/cdg`);
  assert.deepEqual(cdg.body, ZIP_CDG);

  const deflated = await trackOf('deflated tune');
  const r2 = await get(`/media/${deflated}/audio`, { range: 'bytes=29990-' });
  assert.equal(r2.status, 206);
  assert.deepEqual(r2.body, ZIP_AUDIO.subarray(29990));
  const whole = await get(`/media/${deflated}/audio`);
  assert.deepEqual(whole.body, ZIP_AUDIO);
});

test('video files stream with Range', async () => {
  const id = await trackOf('video artist clip');
  const r = await get(`/media/${id}/video`, { range: 'bytes=10-19' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.deepEqual(r.body, pattern(4000, 9).subarray(10, 20));
});

test('static files cannot escape the public folder', async () => {
  const r = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: app.port, path: '/js/../../package.json' }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(r, 404);
  const qr = await get('/api/qr.svg?text=hello');
  assert.match(qr.body.toString(), /^<svg/);
  const art = await get('/api/art/song/whatever');
  assert.equal(art.status, 200);
  assert.match(art.headers['content-type'], /svg/);
  const redirect = await get('/j');
  assert.equal(redirect.status, 302);
});

test('host-only endpoints trust localhost', async () => {
  const r = await getJson('/api/fs/list');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.dirs));
});

test('websocket hello, ping and request/response', async () => {
  const code = app.settings.get('party.roomCode');
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const inbox = [];
  const waitFor = (pred) => new Promise((resolve) => {
    const check = () => {
      const i = inbox.findIndex(pred);
      if (i >= 0) { resolve(inbox.splice(i, 1)[0]); return true; }
      return false;
    };
    if (check()) return;
    const timer = setInterval(() => { if (check()) clearInterval(timer); }, 5);
  });
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', role: 'guest', room: 'ZZZZ', deviceId: 'device-one' }));
  const denied = await waitFor((m) => m.t === 'denied');
  assert.equal(denied.code, 'room');

  const ws2 = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  ws2.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ t: 'hello', role: 'guest', room: code.toLowerCase(), deviceId: 'device-two' }));
  const welcome = await waitFor((m) => m.t === 'welcome');
  assert.equal(welcome.role, 'guest');
  ws2.send(JSON.stringify({ t: 'ping', c: 123 }));
  const pong = await waitFor((m) => m.t === 'pong');
  assert.equal(pong.c, 123);
  ws2.send(JSON.stringify({ t: 'no.such.thing', rid: 7 }));
  const res = await waitFor((m) => m.t === 'res' && m.rid === 7);
  assert.equal(res.ok, false);
  ws.close();
  ws2.close();
});
