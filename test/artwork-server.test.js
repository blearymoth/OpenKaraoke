// The artwork service inside the running server: HTTP images and placeholders, host-only
// controls over WebSocket, `art` events, and what the TV gets. The network is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from '../server/vendor/ws.mjs';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree } from './helpers.js';
import { fakeArtFetch } from './fake-art.js';

let app;
let base;
let fetchFake;

before(async () => {
  const lib = await tmpDir('ok-art-lib-');
  const files = {};
  for (const name of ['Queen - Bohemian Rhapsody [SF Karaoke]', 'Queen - Bohemian Rhapsody [SC Karaoke]', 'Adele - Hello [SF Karaoke]', 'Nobody Knows - Unknown Tune [SF Karaoke]', 'Blondie - Call Me [SC Karaoke]']) {
    const artist = name.split(' - ')[0];
    files[`${artist[0]}/${artist}/${name}.cdg`] = 7200 * 200;
    files[`${artist[0]}/${artist}/${name}.mp3`] = 100;
  }
  await writeTree(lib, files);
  const dataDir = await tmpDir('ok-art-data-');
  fetchFake = fakeArtFetch({ unknown: new Set(['nobody knows']) });
  app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch: fetchFake, crawl: false });
  await app.library.scan();
  app.settings.update({ playback: { countdown: 30 }, artwork: { crawl: false } });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  await app?.close();
});

const songId = (title) => [...app.library.catalog.songs.values()].find((s) => s.title === title).id;
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

function ws(hello) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const inbox = [];
    const waiters = [];
    let rid = 0;
    sock.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.t === 'state' || msg.t === 'welcome') sock.state = msg.state || sock.state;
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else inbox.push(msg);
      if (msg.t === 'welcome') resolve(sock);
    });
    sock.next = (pred) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res) => waiters.push({ pred, resolve: res }));
    };
    sock.req = async (t, body = {}) => {
      const id = ++rid;
      sock.send(JSON.stringify({ t, rid: id, ...body }));
      const res = await sock.next((m) => m.t === 'res' && m.rid === id);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    };
    sock.on('open', () => sock.send(JSON.stringify({ t: 'hello', ...hello })));
    sock.on('error', reject);
  });
}

test('covers: placeholder first (revalidated), then the real image once it is looked up; art event', async () => {
  const guest = await ws({ role: 'guest', room: app.settings.get('party.roomCode') });
  const id = songId('Call Me');
  const first = await fetch(`${base}/api/art/song/${id}?s=250`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/svg+xml');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const event = await guest.next((m) => m.t === 'art' && m.songs.includes(id));
  assert.ok(event.artists.length <= 1, 'the artist picture came with the search result');
  const real = await fetch(`${base}/api/art/song/${id}?s=500`, { headers: { 'if-none-match': etag } });
  assert.equal(real.status, 200);
  assert.equal(real.headers.get('content-type'), 'image/png');
  assert.equal(real.headers.get('cache-control'), 'no-cache', 'the host may change the cover behind this URL');
  const again = await fetch(`${base}/api/art/song/${id}?s=500`, { headers: { 'if-none-match': real.headers.get('etag') } });
  assert.equal(again.status, 304);
  // Unknown songs keep the placeholder, which answers 304 while unchanged.
  const unknown = songId('Unknown Tune');
  const ph = await fetch(`${base}/api/art/song/${unknown}`);
  await until(() => app.artwork.songs.get(app.library.catalog.song(unknown).key)?.miss);
  const ph2 = await fetch(`${base}/api/art/song/${unknown}`, { headers: { 'if-none-match': ph.headers.get('etag') } });
  assert.equal(ph2.status, 304);
  guest.close();
});

test('song details and search results carry the metadata; genre/decade browsing works', async () => {
  const id = songId('Hello');
  await fetch(`${base}/api/art/song/${id}`);
  await until(() => app.artwork.songs.get(app.library.catalog.song(id).key)?.cover);
  app.library.catalog.metaChanged();
  const detail = await (await fetch(`${base}/api/songs/${id}`)).json();
  assert.equal(detail.meta.provider, 'Deezer');
  assert.ok(detail.meta.year > 1900);
  assert.ok(detail.meta.genre);
  assert.equal(detail.meta.cover, true);
  assert.equal(detail.art, 1);
  const facets = await (await fetch(`${base}/api/browse/facets`)).json();
  assert.ok(facets.genres.some((g) => g.genre === detail.meta.genre));
  const decade = Math.floor(detail.meta.year / 10) * 10;
  assert.ok(facets.decades.some((d) => d.decade === decade));
  const byDecade = await (await fetch(`${base}/api/browse/popular?decade=${decade}`)).json();
  assert.ok(byDecade.items.some((s) => s.id === id));
  const byGenre = await (await fetch(`${base}/api/browse/popular?genre=${encodeURIComponent(detail.meta.genre)}`)).json();
  assert.ok(byGenre.items.every((s) => app.artwork.songs.get(app.library.catalog.song(s.id).key)?.genre === detail.meta.genre));
});

test('artist images: picture, fanart; 404 for a missing fanart; artist page reports what exists', async () => {
  const key = app.library.catalog.artistList.find((a) => a.name === 'Blondie').key;
  const pic = await fetch(`${base}/api/art/artist/${key}`);
  assert.equal(pic.status, 200);
  await until(() => app.artwork.artists.get(key)?.picture);
  assert.equal((await fetch(`${base}/api/art/artist/${key}`)).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/art/artist/${key}?type=fanart`)).status, 404, 'first ask queues the TheAudioDB lookup');
  await until(() => app.artwork.artists.get(key)?.fanart);
  const fan = await fetch(`${base}/api/art/artist/${key}?type=fanart&i=1`);
  assert.equal(fan.headers.get('content-type'), 'image/png');
  const page = await (await fetch(`${base}/api/artists/${key}`)).json();
  assert.equal(page.artist.art.fanart, 2);
  assert.equal(page.artist.art.logo, true);
});

test('host controls over WebSocket; guests may not use them; status is host-only over HTTP', async () => {
  const host = await ws({ role: 'host' });
  const guest = await ws({ role: 'guest', room: app.settings.get('party.roomCode') });
  const st = await host.req('artwork.status');
  assert.equal(st.enabled, true);
  assert.equal(st.songs.total, 4);
  assert.ok(st.providers.find((p) => p.name === 'deezer').on);
  await assert.rejects(guest.req('artwork.status'), /not allowed/);
  await assert.rejects(guest.req('artwork.retry'), /not allowed/);
  const id = songId('Bohemian Rhapsody');
  const cands = await host.req('artwork.candidates', { songId: id });
  assert.ok(cands.items.length > 0);
  await host.req('artwork.choose', { songId: id, candidateId: cands.items[0].id });
  assert.equal(app.artwork.songs.get(app.library.catalog.song(id).key).manual, true);
  await host.req('artwork.none', { songId: id });
  await assert.rejects(host.req('artwork.none', { songId: 'nope' }), /not found/);
  const r = await host.req('artwork.refresh', { songId: id });
  assert.equal(r.found, true);
  assert.deepEqual(await host.req('artwork.crawl', { on: false }), { crawl: false });
  assert.equal(app.settings.get('artwork.crawl'), false);
  // HTTP status: only for the host (the test client is localhost = trusted).
  assert.equal((await fetch(`${base}/api/artwork`)).status, 200);
  host.close();
  guest.close();
});

test('changed covers reach every page: images are revalidated, and a page that was offline gets what it missed', async () => {
  const id = songId('Call Me');
  const song = app.library.catalog.song(id);
  await fetch(`${base}/api/art/song/${id}`);
  await until(() => app.artwork.songs.get(song.key)?.cover);
  const room = app.settings.get('party.roomCode');
  const phone = await ws({ role: 'guest', room });
  const { art } = await phone.next((m) => m.t === 'welcome');
  assert.ok(Number.isSafeInteger(art.seq) && !art.songs, 'the first welcome only says where the changes are');
  const real = await fetch(`${base}/api/art/song/${id}?s=250`);
  assert.equal(real.headers.get('content-type'), 'image/png');
  phone.close(); // the phone sleeps…
  // …while the host says the cover was wrong.
  app.artwork.setNone(song);
  await until(() => app.artFeed.seq > art.seq);
  // A page opened now (or reloaded) asks again and gets the placeholder, not its cached image.
  const again = await fetch(`${base}/api/art/song/${id}?s=250`, { headers: { 'if-none-match': real.headers.get('etag') } });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('content-type'), 'image/svg+xml');
  // The phone wakes up: its welcome carries what changed meanwhile.
  const woke = await ws({ role: 'guest', room, artSeq: art.seq });
  const welcome = await woke.next((m) => m.t === 'welcome');
  assert.equal(welcome.art.seq, app.artFeed.seq);
  assert.ok(welcome.art.songs.includes(id));
  // A page from before the server started can't be told what changed: everything did.
  const old = await ws({ role: 'guest', room, artSeq: art.seq - 1e9 });
  assert.equal((await old.next((m) => m.t === 'welcome')).art.all, true);
  woke.close();
  old.close();
  // Another cover (here: looked up again) is another file with another ETag.
  await app.artwork.refresh(song);
  const back = await fetch(`${base}/api/art/song/${id}?s=250`, { headers: { 'if-none-match': again.headers.get('etag') } });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'image/png');
});

test('the TV: current song is looked up first, its art flags and a lobby mosaic are in the view', async () => {
  const tv = await ws({ role: 'tv' });
  const host = await ws({ role: 'host' });
  await until(() => tv.state?.mosaic?.length > 0);
  assert.ok(tv.state.mosaic.every((id) => app.library.catalog.song(id)));
  // Forget Queen's fanart so the "now" lookup is visible.
  const queenKey = app.library.catalog.artistList.find((a) => a.name === 'Queen').key;
  app.artwork.artists.delete(queenKey);
  await host.req('queue.add', { songId: songId('Bohemian Rhapsody'), singerName: 'Ann', position: 'now' });
  await until(() => tv.state?.current?.art?.fanart === queenKey);
  assert.equal(tv.state.current.art.cover, true);
  assert.equal(tv.state.current.art.logo, queenKey);
  assert.deepEqual(tv.state.mosaic, [], 'no mosaic while a song is on');
  tv.close();
  host.close();
});

test('the host can upload their own cover; it is kept (never evicted) and served', async () => {
  const id = songId('Hello');
  const song = app.library.catalog.song(id);
  const png = (await import('./fake-art.js')).pngImage('custom-cover', 64);
  const bad = await fetch(`${base}/api/art/song/${id}/cover`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('<svg/>') });
  assert.equal(bad.status, 415);
  const res = await fetch(`${base}/api/art/song/${id}/cover`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(res.status, 200);
  const e = app.artwork.songs.get(song.key);
  assert.equal(e.p, 'custom');
  assert.equal(e.manual, true);
  const img = await fetch(`${base}/api/art/song/${id}?s=1000`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.equal((await (await fetch(`${base}/api/songs/${id}`)).json()).meta.provider, 'your own picture');
  // Eviction never removes it.
  app.artwork.bytes += 1e12;
  app.artwork.evict();
  assert.ok(app.artwork.anyImage(e.cover), 'still cached');
  app.artwork.bytes -= 1e12;
  assert.equal(app.artwork.customKeys().size, 1);
});
