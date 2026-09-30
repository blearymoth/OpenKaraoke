import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import {
  scoreMatch, cleanTitle, primaryArtist, deezerTracks, musicbrainzCandidates, audiodbArtistFrom, best, ProviderError,
} from '../server/artwork/providers.js';
import { sniffImage, RateLimiter } from '../server/artwork/service.js';
import { tmpDir, writeTree } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`fake-jpeg:${tag}`)]);

// ---- fixtures in the shape of the real APIs (RESEARCH §3) -----------------------------------------
const deezerTrack = (o) => ({
  id: o.id, title: o.title, title_short: o.title, duration: o.duration, rank: o.rank || 500000, explicit_lyrics: !!o.explicit,
  artist: { id: o.artistId || 1, name: o.artist, picture_xl: `https://img.test/artist/${o.artistId || 1}.jpg` },
  album: { id: o.albumId, title: o.album, cover_medium: `https://img.test/cover/${o.albumId}-250.jpg`, cover_xl: `https://img.test/cover/${o.albumId}-1000.jpg` },
});
const HELLO = [
  deezerTrack({ id: 11, title: 'Hello (Karaoke Version)', artist: 'Karaoke Hits Band', album: 'Karaoke Hits 2015', albumId: 900, duration: 296, rank: 900000 }),
  deezerTrack({ id: 12, title: 'Hello', artist: 'Adele', album: '25', albumId: 25, duration: 295, rank: 800000, artistId: 75798 }),
];
const MB_QUEEN = {
  recordings: [{
    id: 'rec-1', title: 'Bohemian Rhapsody', length: 354000, 'first-release-date': '1975-10-31',
    'artist-credit': [{ name: 'Queen' }],
    releases: [
      { title: 'Greatest Hits', date: '1981', 'release-group': { id: 'rg-hits', 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
      { title: 'A Night at the Opera', date: '1975-11-21', 'release-group': { id: 'rg-opera', 'primary-type': 'Album' } },
    ],
  }],
};

let calls;
let quotaOnce;
let offline;
function fakeFetch(url) {
  calls.push(url);
  if (offline) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  const u = new URL(url);
  const json = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
  if (u.host === 'img.test' || u.host === 'coverartarchive.org') {
    if (u.pathname.includes('rg-hits')) return Promise.resolve(new Response('', { status: 404 }));
    return Promise.resolve(new Response(jpeg(u.pathname), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  }
  if (u.host === 'api.deezer.com') {
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/search') {
      if (/Killer Queen/i.test(q) && quotaOnce) { quotaOnce = false; return json({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }); }
      if (/hello/i.test(q)) return json({ data: HELLO, total: 2 });
      if (/killer queen/i.test(q)) return json({ data: [deezerTrack({ id: 31, title: 'Killer Queen', artist: 'Queen', album: 'Sheer Heart Attack', albumId: 31, duration: 180 })] });
      return json({ data: [], total: 0 });
    }
    if (u.pathname === '/album/25') return json({ id: 25, release_date: '2015-11-20', genres: { data: [{ id: 132, name: 'Pop' }] } });
    if (u.pathname === '/album/31') return json({ id: 31, release_date: '1974-11-08', genres: { data: [{ id: 152, name: 'Rock' }] } });
    if (u.pathname === '/search/artist') return json({ data: [] });
    return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
  }
  if (u.host === 'musicbrainz.org') {
    if (/Bohemian/i.test(u.searchParams.get('query'))) return json(MB_QUEEN);
    return json({ recordings: [] });
  }
  if (u.host === 'www.theaudiodb.com') {
    if (/adele/i.test(u.searchParams.get('s'))) {
      return json({ artists: [{ strArtist: 'Adele', strArtistThumb: 'https://img.test/adb/adele-thumb.jpg', strArtistFanart: 'https://img.test/adb/adele-fanart.jpg', strGenre: 'Soul' }] });
    }
    return json({ artists: null });
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

let app;
let base;
before(async () => {
  const lib = await tmpDir();
  const files = {};
  for (const n of ['Adele - Hello [SF Karaoke]', 'Queen - Bohemian Rhapsody [SC Karaoke]', 'Queen - Killer Queen [SF Karaoke]', 'Blur - Song 2 [SF Karaoke]']) {
    const artist = n.split(' - ')[0];
    files[`${artist[0]}/${artist}/${n}.cdg`] = 7200 * 295;
    files[`${artist[0]}/${artist}/${n}.mp3`] = 10;
  }
  await writeTree(lib, files);
  const fast = Object.fromEntries(['deezer', 'musicbrainz', 'itunes', 'audiodb', 'img'].map((k) => [k, [1000, 1000]]));
  app = await createApp({
    dataDir: await tmpDir(), args: { library: [lib], noCrawl: true }, log: quiet, watchIntervalMs: 0,
    fetch: (url) => fakeFetch(url), artworkOptions: { limits: fast, maxRetryMs: 30, offlinePauseMs: 60000, log: quiet },
  });
  app.library.log = quiet;
  await app.listen(0, '127.0.0.1');
  await app.start({ scan: false });
  await app.library.scan();
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => { await app.close(); });
beforeEach(() => {
  calls = [];
  quotaOnce = false;
  offline = false;
  app.artwork.offlineUntil = 0;
  app.settings.update({ artwork: { enabled: true, providers: { deezer: true, musicbrainz: true, theaudiodb: true, itunes: false } } });
});

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const songId = (q) => app.library.catalog.search(q).items[0].id;

// ---- unit ------------------------------------------------------------------------------------------

test('matching prefers the original recording over karaoke covers', () => {
  const want = { artist: 'Adele', title: 'Hello', duration: 295 };
  const [karaoke, original] = deezerTracks({ data: HELLO });
  assert.equal(scoreMatch(want, karaoke), 0, 'artist does not match at all');
  const cover = { ...karaoke, artist: 'Adele' };
  assert.ok(scoreMatch(want, original) > scoreMatch(want, cover) + 0.2);
  assert.equal(best(want, [karaoke, original]).id, '12');
  assert.equal(cleanTitle('Hello (Karaoke Version) [Live]'), 'Hello');
  assert.equal(primaryArtist('Queen & David Bowie (Duet)'), 'Queen');
  assert.ok(scoreMatch({ artist: 'Queen & David Bowie', title: 'Under Pressure' }, { artist: 'Queen', title: 'Under Pressure' }) > 0.8);
});

test('provider parsers: deezer quota error, MusicBrainz original album, TheAudioDB', () => {
  assert.throws(() => deezerTracks({ error: { code: 4, message: 'Quota limit exceeded' } }), (e) => e instanceof ProviderError && e.quota);
  const [mb] = musicbrainzCandidates(MB_QUEEN);
  assert.equal(mb.albumId, 'rg-opera', 'studio album preferred over a compilation');
  assert.equal(mb.year, 1975);
  assert.equal(mb.duration, 354);
  const a = audiodbArtistFrom({ artists: [{ strArtist: 'Adele', strArtistFanart: 'https://x/f.jpg', strArtistLogo: '' }] }, 'adele');
  assert.equal(a.fanart, 'https://x/f.jpg');
  assert.equal(a.logo, null);
  assert.equal(audiodbArtistFrom({ artists: null }, 'x'), null);
});

test('sniffImage and RateLimiter spacing', async () => {
  assert.equal(sniffImage(jpeg('x')), 'jpg');
  assert.equal(sniffImage(Buffer.from('<html>')), null);
  const lim = new RateLimiter(20, 1);
  const t0 = Date.now();
  await Promise.all([lim.take(), lim.take(), lim.take()]);
  assert.ok(Date.now() - t0 >= 90, 'three requests at 20/s take ≥ 100 ms');
});

// ---- service ---------------------------------------------------------------------------------------

test('cover art is looked up on demand, cached and then served', async () => {
  const id = songId('adele hello');
  const arts = [];
  app.artwork.on('art', (ids) => arts.push(...ids));
  const first = await get(`/api/art/song/${id}?s=250`);
  assert.match(first.headers['content-type'], /svg/);
  assert.equal(first.headers['cache-control'], 'no-store', 'placeholder not cached while looking up');
  await app.artwork.idle();
  const second = await get(`/api/art/song/${id}?s=250`);
  assert.equal(second.headers['content-type'], 'image/jpeg');
  assert.deepEqual(second.body, jpeg('/cover/25-250.jpg'));
  const big = await get(`/api/art/song/${id}?s=1000`);
  assert.deepEqual(big.body, jpeg('/cover/25-1000.jpg'));
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(arts.includes(id), 'art event for clients');

  const search = JSON.parse((await get('/api/search?q=hello')).body);
  assert.equal(search.items[0].art, 1);
  assert.equal(search.items[0].year, 2015);
  const facets = JSON.parse((await get('/api/browse/facets')).body);
  assert.deepEqual(facets.genres.map((g) => g.genre), ['Pop']);
  const pop = JSON.parse((await get('/api/search?q=&genre=Pop')).body);
  assert.equal(pop.items[0].title, 'Hello');
  const d2010 = JSON.parse((await get('/api/search?q=&decade=2010')).body);
  assert.equal(d2010.total, 1);

  const before = calls.length;
  await get(`/api/art/song/${id}?s=250`);
  await app.artwork.idle();
  assert.equal(calls.length, before, 'no new requests once cached');
});

test('MusicBrainz + Cover Art Archive when Deezer has nothing; misses are remembered', async () => {
  const queen = songId('bohemian rhapsody');
  app.artwork.want(queen, 0);
  const blur = songId('song 2');
  app.artwork.want(blur, 0);
  await app.artwork.idle();
  const m = app.artwork.songMeta(app.library.catalog.song(queen));
  assert.equal(m.provider, 'musicbrainz');
  assert.equal(m.year, 1975);
  const img = await get(`/api/art/song/${queen}`);
  assert.deepEqual(img.body, jpeg('/release-group/rg-opera/front-250'));

  const miss = app.artwork.songMeta(app.library.catalog.song(blur));
  assert.equal(miss.miss, true);
  const n = calls.length;
  assert.equal(app.artwork.want(blur, 0), false, 'not retried within 30 days');
  const ph = await get(`/api/art/song/${blur}`);
  assert.match(ph.headers['content-type'], /svg/);
  assert.notEqual(ph.headers['cache-control'], 'no-store');
  assert.equal(calls.length, n);
});

test('quota errors are retried, not recorded as misses', async () => {
  quotaOnce = true;
  const id = songId('killer queen');
  app.artwork.want(id, 0);
  await app.artwork.idle();
  const m = app.artwork.songMeta(app.library.catalog.song(id));
  assert.equal(m.miss, undefined);
  assert.equal(m.genre, 'Rock');
  assert.equal(calls.filter((u) => /Killer/.test(decodeURIComponent(u))).length >= 2, true);
});

test('artist fanart for TV backgrounds, with fallbacks', async () => {
  const key = app.library.catalog.listArtists({ q: 'adele' }).items[0].key;
  const first = await get(`/api/art/artist/${key}?type=fanart`);
  assert.match(first.headers['content-type'], /svg/);
  await app.artwork.idle();
  const fan = await get(`/api/art/artist/${key}?type=fanart`);
  assert.deepEqual(fan.body, jpeg('/adb/adele-fanart.jpg'));
  const logo = await get(`/api/art/artist/${key}?type=logo`);
  assert.equal(logo.status, 404);
  const blurKey = app.library.catalog.listArtists({ q: 'blur' }).items[0].key;
  await get(`/api/art/artist/${blurKey}?type=fanart`);
  await app.artwork.idle();
  const hello = songId('adele hello');
  const fallback = await get(`/api/art/artist/${blurKey}?type=fanart&song=${hello}`);
  assert.equal(fallback.headers['content-type'], 'image/jpeg', 'falls back to the song cover');
});

test('offline: nothing is marked missing; disabled: no network at all', async () => {
  offline = true;
  const id = songId('queen killer');
  const song = app.library.catalog.song(id);
  delete app.artwork.doc.data.songs[song.key];
  app.artwork.want(id, 0);
  await app.artwork.idle();
  assert.equal(app.artwork.songMeta(song), null);
  assert.equal(app.artwork.status().offline, true);

  offline = false;
  app.artwork.offlineUntil = 0;
  app.settings.update({ artwork: { enabled: false } });
  calls = [];
  assert.equal(app.artwork.want(id, 0), false);
  const r = await get(`/api/art/song/${id}`);
  assert.match(r.headers['content-type'], /svg/);
  assert.equal(calls.length, 0);
});

test('background crawl looks up the library, popular first', async () => {
  for (const s of app.library.catalog.songList) delete app.artwork.doc.data.songs[s.key];
  app.artwork.startCrawl();
  await app.artwork.idle();
  const st = app.artwork.status();
  assert.equal(st.crawling, false);
  assert.equal(st.known + st.missing, app.library.catalog.songs.size);
  assert.equal(st.crawl.found + st.crawl.missed, app.library.catalog.songs.size);
});

test('repeated provider errors (e.g. HTTP 403 from a firewall) pause lookups instead of skipping songs', async () => {
  const realFetch = app.artwork.fetch;
  app.artwork.fetch = (url) => { calls.push(url); return Promise.resolve(new Response('blocked', { status: 403 })); };
  try {
    for (const s of app.library.catalog.songList) delete app.artwork.doc.data.songs[s.key];
    app.artwork.errors = 0;
    for (const s of app.library.catalog.songList) app.artwork.want(s.id, 1);
    await app.artwork.idle();
    assert.equal(app.artwork.status().known + app.artwork.status().missing, 0, 'nothing recorded as found or missing');
    // fewer than 5 songs in this library: after 4 errors we are not paused yet, add more failures
    app.artwork.errors = 4;
    app.artwork.want(app.library.catalog.songList[0].id, 1);
    await app.artwork.idle();
    assert.equal(app.artwork.status().offline, true);
  } finally {
    app.artwork.fetch = realFetch;
    app.artwork.errors = 0;
    app.artwork.offlineUntil = 0;
  }
});
