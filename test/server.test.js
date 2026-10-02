import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocket } from '../server/vendor/ws.mjs';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree, makeZip } from './helpers.js';
import { offlineFetch } from './fake-art.js';

const CDG = Buffer.alloc(7200 * 30); // 30 s of mostly-empty CDG
for (let i = 0; i < CDG.length; i += 24 * 50) { CDG[i] = 9; CDG[i + 1] = 1; }
const MP3 = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) & 255));
const ZIP_MP3 = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 13) & 255));

let app;
let base;
let lib;

before(async () => {
  lib = await tmpDir('ok-lib-');
  await writeTree(lib, {
    'A/Adele/Adele - Hello [SF Karaoke].cdg': CDG,
    'A/Adele/Adele - Hello [SF Karaoke].mp3': MP3,
    'A/Adele/Adele - Hello [ZM Karaoke].cdg': CDG,
    'A/Adele/Adele - Hello [ZM Karaoke].mp3': MP3,
    'Q/Queen/Queen - Bohemian Rhapsody [SF Karaoke].cdg': CDG,
    'Q/Queen/Queen - Bohemian Rhapsody [SF Karaoke].mp3': MP3,
    'Q/Queen/Queen - Killer Queen (Explicit) [SF Karaoke].cdg': CDG,
    'Q/Queen/Queen - Killer Queen (Explicit) [SF Karaoke].mp3': MP3,
    'Z/Zipped - Stored Audio [SC Karaoke].zip': makeZip([
      { name: 'Zipped - Stored Audio.cdg', data: CDG, deflate: true },
      { name: 'Zipped - Stored Audio.mp3', data: ZIP_MP3 },
    ]),
    'Z/Zipped - Deflated Audio [SC Karaoke].zip': makeZip([
      { name: 'Zipped - Deflated Audio.cdg', data: CDG },
      { name: 'Zipped - Deflated Audio.mp3', data: ZIP_MP3, deflate: true },
    ]),
    'V/Video Band - Clip [KV Karaoke].mp4': MP3,
  });
  const data = await tmpDir('ok-data-');
  app = await createApp({ dataDir: data, args: { library: [lib] }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  await app.library.scan();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  await app?.close();
});

const get = (p, headers) => fetch(base + p, { headers });
const postJson = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const getJson = async (p) => {
  const r = await get(p);
  assert.equal(r.status, 200, `${p} → ${r.status}`);
  return r.json();
};
const trackOf = (name) => [...app.library.catalog.tracks.values()].find((t) => t.name.startsWith(name));

/** Raw request without automatic decompression. */
function raw(p, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('info and search', async () => {
  const info = await getJson('/api/info');
  assert.match(info.roomCode, /^[A-Z]{4}$/);
  assert.ok(info.joinUrl.endsWith(`/j/${info.roomCode}`));
  assert.equal(info.library.tracks, 7);

  const res = await getJson('/api/search?q=helo');
  assert.equal(res.items[0].title, 'Hello');
  assert.equal(res.items[0].v, 2, 'two label versions');
  const q = await getJson('/api/search?q=queen');
  assert.equal(q.artists[0].name, 'Queen');
  assert.deepEqual(await getJson('/api/search?q='), { total: 0, fuzzy: false, items: [], artists: [] });
});

test('song, artist and browse endpoints', async () => {
  const hello = (await getJson('/api/search?q=hello')).items[0];
  const detail = await getJson(`/api/songs/${hello.id}`);
  assert.equal(detail.versions.length, 2);
  assert.equal((await get('/api/songs/nope')).status, 404);

  const artists = await getJson('/api/artists?letter=Q');
  assert.deepEqual(artists.items.map((a) => a.name), ['Queen']);
  const queen = await getJson(`/api/artists/${artists.items[0].key}`);
  assert.deepEqual(queen.songs.map((s) => s.title), ['Bohemian Rhapsody', 'Killer Queen']);

  const facets = await getJson('/api/browse/facets');
  assert.equal(facets.letters.length, 27);
  assert.equal(facets.letters.find((l) => l.letter === 'A').songs, 1);
  assert.ok(facets.tags.some((t) => t.tag === 'Explicit'));
  assert.equal((await getJson('/api/browse/popular?limit=2')).items.length, 2);
  assert.equal((await getJson('/api/browse/letter/q')).total, 2);
  assert.equal((await getJson('/api/random?n=3')).items.length, 3);
});

test('explicit filter hides explicit songs from guests only', async () => {
  app.settings.update({ queue: { explicitFilter: true } });
  try {
    // Requests from this computer count as the host, so pretend to be a guest by
    // turning off localhost trust.
    app.settings.update({ party: { trustLocalhost: false } });
    const guest = await getJson('/api/search?q=queen');
    assert.deepEqual(guest.items.map((s) => s.title), ['Bohemian Rhapsody']);
    app.settings.update({ party: { trustLocalhost: true } });
    const host = await getJson('/api/search?q=queen');
    assert.equal(host.items.length, 2);
    assert.ok(host.items.find((s) => s.title === 'Killer Queen').x);
  } finally {
    app.settings.update({ queue: { explicitFilter: false }, party: { trustLocalhost: true } });
  }
});

test('audio streams with byte ranges', async () => {
  const t = trackOf('Adele - Hello [SF');
  const full = await get(`/media/${t.id}/audio`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), MP3);

  const part = await get(`/media/${t.id}/audio`, { range: 'bytes=10-19' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${MP3.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), MP3.subarray(10, 20));

  const tail = await get(`/media/${t.id}/audio`, { range: 'bytes=-5' });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), MP3.subarray(-5));

  const bad = await get(`/media/${t.id}/audio`, { range: 'bytes=999999-' });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${MP3.length}`);

  const head = await raw(`/media/${t.id}/audio`, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), MP3.length);
  assert.equal(head.body.length, 0);

  const etag = full.headers.get('etag');
  assert.equal((await get(`/media/${t.id}/audio`, { 'if-none-match': etag })).status, 304);
});

test('CDG is served gzipped when accepted', async () => {
  const t = trackOf('Adele - Hello [SF');
  const gz = await raw(`/media/${t.id}/cdg`, { 'accept-encoding': 'gzip' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(gz.body.length < CDG.length / 10);
  assert.deepEqual(zlib.gunzipSync(gz.body), CDG);
  const plain = await raw(`/media/${t.id}/cdg`);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, CDG);
  const viaFetch = await get(`/media/${t.id}/cdg`);
  assert.deepEqual(Buffer.from(await viaFetch.arrayBuffer()), CDG);
});

test('zipped tracks: stored and deflated entries support ranges', async () => {
  for (const name of ['Zipped - Stored Audio', 'Zipped - Deflated Audio']) {
    const t = trackOf(name);
    assert.equal(t.kind, 'zip');
    const whole = await get(`/media/${t.id}/audio`);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), ZIP_MP3, name);
    const part = await get(`/media/${t.id}/audio`, { range: 'bytes=100-199' });
    assert.equal(part.status, 206, name);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), ZIP_MP3.subarray(100, 200), name);
    const cdg = await get(`/media/${t.id}/cdg`);
    assert.deepEqual(Buffer.from(await cdg.arrayBuffer()), CDG, name);
  }
});

test('video tracks and media errors', async () => {
  const v = trackOf('Video Band');
  const r = await get(`/media/${v.id}/video`, { range: 'bytes=0-3' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await get(`/media/${v.id}/audio`)).status, 404);
  assert.equal((await get('/media/unknown/audio')).status, 404);
  const t = trackOf('Adele - Hello [SF');
  assert.equal((await get(`/media/${t.id}/lyrics`)).status, 404);
  assert.equal((await get(`/media/${t.id}/audio.mp3`)).status, 200, 'extension suffix allowed');
});

test('missing drive gives 503', async () => {
  const t = trackOf('Queen - Bohemian');
  const moved = `${lib}-away`;
  await fs.rename(lib, moved);
  try {
    const r = await get(`/media/${t.id}/audio`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'library_offline');
  } finally {
    await fs.rename(moved, lib);
    await app.library.checkOnline();
  }
});

test('static files, pages and caching', async () => {
  const js = await raw('/js/vendor/preact.js', { 'accept-encoding': 'gzip' });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-encoding'], 'gzip');
  assert.match(js.headers['content-type'], /javascript/);
  const again = await raw('/js/vendor/preact.js', { 'accept-encoding': 'gzip', 'if-none-match': js.headers.etag });
  assert.equal(again.status, 304);

  assert.equal((await get('/shared/text.js')).status, 200);
  assert.equal((await get('/css/base.css')).status, 200);
  assert.equal((await raw('/js/..%2F..%2Fpackage.json')).status, 404);
  assert.equal((await raw('/js/../../package.json')).status, 404);
  assert.equal((await raw('/shared/%2e%2e/package.json')).status, 404);

  for (const p of ['/', '/host', '/tv', '/j/ABCD', '/j']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/, p);
  }
  const missing = await get('/definitely-not-here');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);
  const apiMissing = await get('/api/nope');
  assert.equal(apiMissing.status, 404);
  assert.equal((await apiMissing.json()).code, 'not_found');
  assert.equal((await fetch(`${base}/api/info`, { method: 'DELETE' })).status, 405);
});

test('qr code and placeholder art', async () => {
  const qr = await get('/api/qr.svg?text=hello&dark=%23ff0000');
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  assert.match(await qr.text(), /fill="#ff0000"/);
  assert.equal((await get(`/api/qr.svg?text=${'x'.repeat(600)}`)).status, 400);
  const hello = (await getJson('/api/search?q=hello')).items[0];
  const art = await get(`/api/art/song/${hello.id}`);
  assert.equal(art.status, 200);
  assert.match(await art.text(), /<svg/);
  assert.equal((await get('/api/art/song/unknown')).status, 200, 'never 404');
});

test('host-only endpoints: localhost trust, PIN and tokens', async () => {
  const list = await getJson(`/api/fs/list?path=${encodeURIComponent(lib)}`);
  assert.deepEqual(list.dirs.map((d) => d.name), ['A', 'Q', 'V', 'Z']);
  assert.equal(list.parent, path.dirname(lib));
  const roots = await getJson('/api/fs/list');
  assert.ok(Array.isArray(roots.dirs));

  app.settings.update({ party: { trustLocalhost: false, adminPin: '' } });
  try {
    const denied = await get('/api/fs/list');
    assert.equal(denied.status, 403);
    app.settings.update({ party: { adminPin: '4321' } });
    assert.equal((await get('/api/fs/list')).status, 401);
    const wrong = await postJson('/api/auth/pin', { pin: '1111' });
    assert.equal(wrong.status, 401);
    const ok = await postJson('/api/auth/pin', { pin: '4321' });
    const { token } = await ok.json();
    assert.match(ok.headers.get('set-cookie'), /ok_host=/);
    assert.equal((await get('/api/fs/list', { authorization: `Bearer ${token}` })).status, 200);
    assert.equal((await get('/api/fs/list', { cookie: `ok_host=${encodeURIComponent(token)}` })).status, 200);
    const scan = await fetch(`${base}/api/library/scan`, { method: 'POST' });
    assert.equal(scan.status, 401);
  } finally {
    app.settings.update({ party: { trustLocalhost: true, adminPin: '' } });
  }
});

test('library status and rescan', async () => {
  const st = await getJson('/api/library');
  assert.equal(st.roots[0].path, lib);
  assert.equal(st.roots[0].online, true);
  const r = await fetch(`${base}/api/library/scan`, { method: 'POST' });
  assert.equal(r.status, 200);
  await app.library.scanning;
  const big = await postJson('/api/library/paths', { paths: ['relative/path'] });
  assert.equal(big.status, 400);
});

function wsOpen() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else inbox.push(msg);
    });
    ws.next = (pred = () => true) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res) => waiters.push({ pred, resolve: res }));
    };
    ws.json = (m) => ws.send(JSON.stringify(m));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('websocket hello, roles and ping', async () => {
  const code = app.settings.get('party.roomCode');
  const bad = await wsOpen();
  bad.json({ t: 'hello', role: 'guest', room: 'ZZZZ' });
  assert.deepEqual(await bad.next(), { t: 'denied', reason: 'bad_room' });
  await new Promise((r) => bad.on('close', r));

  const guest = await wsOpen();
  guest.json({ t: 'hello', role: 'guest', room: code.toLowerCase() });
  const welcome = await guest.next();
  assert.equal(welcome.t, 'welcome');
  assert.equal(welcome.role, 'guest');
  assert.equal(welcome.state.info.roomCode, code);
  assert.ok(welcome.token, 'new guests get a device token');
  guest.json({ t: 'ping', c: 42 });
  const pong = await guest.next((m) => m.t === 'pong');
  assert.equal(pong.c, 42);
  assert.ok(Math.abs(pong.s - Date.now()) < 5000);
  guest.json({ t: 'nonsense', rid: 7 });
  const res = await guest.next((m) => m.t === 'res');
  assert.equal(res.rid, 7);
  assert.equal(res.ok, false);
  guest.close();

  const host = await wsOpen();
  host.json({ t: 'hello', role: 'host' });
  assert.equal((await host.next()).role, 'host', 'this computer is trusted as host');
  host.close();

  const early = await wsOpen();
  early.json({ t: 'queue.add' });
  assert.deepEqual(await early.next(), { t: 'denied', reason: 'hello_expected' });
  early.close();
});

test('security: bad cookies, foreign sites, DNS rebinding and oversized messages', async () => {
  const r = await raw('/api/info', { cookie: 'ok_host=%' });
  assert.equal(r.status, 200, 'a malformed cookie is ignored instead of crashing');
  assert.equal((await get('/api/info')).status, 200, 'server still up');

  const csrf = await fetch(`${base}/api/library/scan`, { method: 'POST', headers: { origin: 'http://evil.example' } });
  assert.equal(csrf.status, 403, 'POST from another site refused');
  const plain = await fetch(`${base}/api/library/paths`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"paths":["/"]}' });
  assert.equal(plain.status, 415, 'no-preflight text/plain POST refused');

  const rebound = await raw('/api/fs/list', { host: 'evil.example:8080' });
  assert.equal(rebound.status, 403, 'a foreign Host name never gets host rights');
  assert.equal((await raw('/api/fs/list', { host: `127.0.0.1:${app.port}` })).status, 200);

  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { origin: 'http://evil.example' } });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  }), /403/, 'WebSocket from another site refused');

  const ws = await wsOpen();
  ws.json({ t: 'ping', c: 'x'.repeat(1000) });
  const early = await ws.next();
  assert.equal(early.t, 'denied', 'no pings before hello');
  const big = await wsOpen();
  const closed = new Promise((resolve) => big.on('close', (code) => resolve(code)));
  big.send(JSON.stringify({ t: 'hello', role: 'guest', pad: 'x'.repeat(64 * 1024) }));
  assert.equal(await closed, 1009, 'oversized message closes the socket');
});

test('song detail: plays and votes per version — the host’s view, a guest’s view (with its token)', async () => {
  const hello = (await getJson('/api/search?q=hello')).items[0];
  const song = app.library.catalog.song(hello.id);
  const [a, b] = song.trackIds;
  const guestId = 'guest-device-1';
  app.room.versions.vote(a, guestId, -1);
  app.room.versions.vote(b, '@host', 1);
  app.room.versions.addPlay(b);
  const host = await getJson(`/api/songs/${hello.id}`);
  assert.equal(host.defaultTrackId, b, 'the host’s pick plays by default');
  assert.equal(host.defaultWhy, 'host');
  assert.equal(host.versions[0].id, b, 'the default first');
  const vb = host.versions[0];
  assert.deepEqual([vb.plays, vb.up, vb.down, vb.mine, vb.host, vb.status, vb.heard], [1, 1, 0, 1, 1, 'liked', false]);
  assert.ok(vb.file, 'the host sees the file');
  assert.equal(host.votable, true);
  const token = app.auth.sign('guest', guestId);
  const r = await get(`/api/songs/${hello.id}`, { 'x-guest-token': token });
  const guest = await r.json();
  const va = guest.versions.find((v) => v.id === a);
  assert.deepEqual([va.mine, va.down, 'file' in va, 'discId' in va, 'host' in va], [-1, 1, false, false, false]);
  app.room.versions.vote(a, guestId, 0);
  app.room.versions.vote(b, '@host', 0);
});

test('settings: version votes on by default; lyrics timing kept within ±2 s', () => {
  assert.equal(app.settings.get('guests.versionVotes'), true);
  for (const [v, want] of [[5000, 2000], [-9999, -2000], [12.6, 13]]) {
    app.settings.update({ playback: { lyricOffsetMs: v } });
    assert.equal(app.settings.get('playback.lyricOffsetMs'), want);
  }
  app.settings.update({ guests: { versionVotes: 0 }, playback: { lyricOffsetMs: 0 } });
  assert.equal(app.settings.get('guests.versionVotes'), false);
  app.settings.update({ guests: { versionVotes: true } });
});

