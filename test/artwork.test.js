import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, imageUrls, allowedImageUrl } from '../server/artwork/providers.js';
import { songQuery, pickBest, rankCandidates, scoreCandidate, titleCore, searchTitle, normalizeGenre, yearOf, pickArtist, creditsOf } from '../server/artwork/match.js';
import { ArtworkService, sizeKey } from '../server/artwork/service.js';
import { Throttle } from '../server/util/throttle.js';
import { Settings } from '../server/config.js';
import { Catalog } from '../server/library/catalog.js';
import { EventEmitter } from 'node:events';
import { tmpDir, rawTracks } from './helpers.js';
import { fakeArtFetch, offlineFetch, pngImage } from './fake-art.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'artwork');
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(FIX, `${name}.json`), 'utf8'));
const { deezer, musicbrainz, theaudiodb, itunes, fanarttv } = PROVIDERS;

// ---- providers (saved responses) ----------------------------------------------------------------

test('deezer: search results → candidates; the original album beats live and karaoke versions', async () => {
  const cands = deezer.parseSongs(await fixture('deezer-search-queen-bohemian'));
  assert.equal(cands.length, 3);
  const [orig] = cands;
  assert.equal(orig.title, 'Bohemian Rhapsody'); // title_short, not "(Remastered 2011)"
  assert.equal(orig.version, '(Remastered 2011)');
  assert.equal(orig.album, 'A Night At The Opera (Deluxe Remastered Version)');
  assert.equal(orig.albumId, '915785');
  assert.equal(orig.duration, 354);
  assert.equal(orig.explicit, false);
  assert.match(orig.cover, /^dz:https:\/\/e-cdns-images\.dzcdn\.net\/images\/cover\/4f3c.*\/1000x1000-/);
  assert.match(orig.artistPicture, /^dz:.*\/images\/artist\/9a0a/);
  assert.equal(cands[2].artistPicture, null, 'Deezer’s empty artist placeholder ("artist//…") is ignored');

  const q = songQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', duration: 356 });
  const best = pickBest(cands, q);
  assert.equal(best.candidate.id, '9997018');
  const ranked = rankCandidates(cands, q);
  assert.deepEqual(ranked.map((c) => c.id), ['9997018', '3135556', '77700011']);
  assert.ok(ranked[2].confidence < 0.62, 'karaoke version is never picked automatically');
});

test('deezer: loose search full of tributes, lullabies and karaoke picks the real song', async () => {
  const cands = deezer.parseSongs(await fixture('deezer-search-adele-loose'));
  const q = songQuery({ artist: 'Adele', title: 'Someone Like You', duration: 286 });
  assert.equal(pickBest(cands, q).candidate.album, '21');
  const scores = Object.fromEntries(rankCandidates(cands, q).map((c) => [c.id, c.confidence]));
  assert.equal(scores['6660101'], 0, 'tribute band: other artist');
  assert.equal(scores['6660201'], 0, 'lullaby version: other artist');
  assert.ok(scores['15000011'] < scores['1109739'], 'live version ranks below the studio version');
});

test('deezer: album details, artist search, empty results and error objects', async () => {
  assert.deepEqual(deezer.parseAlbum(await fixture('deezer-album')), { genre: 'Rock', year: 1975, label: 'EMI Catalogue', type: 'album' });
  const artists = deezer.parseArtists(await fixture('deezer-search-artist'));
  assert.equal(artists[0].name, 'Coldplay');
  assert.match(artists[0].picture, /^dz:.*\/images\/artist\/6c7d/);
  assert.equal(artists[1].picture, null);
  assert.equal(pickArtist(artists, 'Coldplay').id, '892');
  assert.equal(pickArtist(artists, 'Oasis'), null);
  assert.deepEqual(deezer.parseSongs(await fixture('deezer-search-empty')), []);
  assert.deepEqual(deezer.apiError(await fixture('deezer-error-quota')), { quota: true, notFound: false, message: 'Exception: Quota limit exceeded (4)' });
  assert.equal(deezer.apiError(await fixture('deezer-error-nodata')).notFound, true);
  assert.equal(deezer.apiError({ data: [] }), null);
  assert.equal(deezer.albumUrl('915785'), 'https://api.deezer.com/album/915785');
  assert.equal(deezer.albumUrl('../x'), null);
  const urls = deezer.songUrls(songQuery({ artist: 'Elton John & Kiki Dee', title: 'Don\'t Go Breaking My Heart (Duet)' }));
  assert.equal(urls.length, 3);
  assert.equal(decodeURIComponent(urls[0].split('q=')[1].split('&')[0]), 'artist:"Elton John & Kiki Dee" track:"Don\'t Go Breaking My Heart"');
  assert.match(decodeURIComponent(urls[1]), /artist:"Elton John" track:/);
  assert.doesNotMatch(urls[2], /strict=on/);
});

test('musicbrainz: recordings → candidates with Cover Art Archive release groups (studio album first)', async () => {
  const cands = musicbrainz.parseSongs(await fixture('musicbrainz-recording-search'));
  const q = songQuery({ artist: 'Adele', title: 'Someone Like You', duration: 286 });
  const best = pickBest(cands, q).candidate;
  assert.equal(best.id, '0f2a7a6e-3c1d-4b2e-9f4a-8d7c6b5a4e3f');
  assert.equal(best.year, 2011);
  assert.equal(best.genre, 'Pop');
  assert.equal(best.duration, 285.24);
  assert.equal(best.cover, null);
  assert.deepEqual(best.covers, ['caa:2b3c4d5e-2222-4222-8222-222222222222', 'caa:3c4d5e6f-3333-4333-8333-333333333333', 'caa:1a2b3c4d-1111-4111-8111-111111111111']);
  assert.equal(cands[2].artist, 'Tribute Singers & Friends', 'artist credits are joined with their join phrases');
  assert.deepEqual(musicbrainz.parseSongs(await fixture('musicbrainz-recording-empty')), []);
  const url = decodeURIComponent(musicbrainz.songUrls(q)[0]);
  assert.match(url, /recording:"Someone Like You" AND artist:"Adele"/);
  assert.match(url, /fmt=json/);
});

test('theaudiodb, itunes and fanart.tv parsers', async () => {
  const [a] = theaudiodb.parseArtists(await fixture('theaudiodb-artist'));
  assert.equal(a.name, 'Coldplay');
  assert.equal(a.mbid, 'cc197bad-dc9c-440d-a5b5-d52ba2e14234');
  assert.equal(a.fanart.length, 3);
  assert.match(a.logo, /^tadb:https:\/\/r2\.theaudiodb\.com\/.*\/logo\//);
  assert.equal(a.genre, 'Alternative');
  assert.deepEqual(theaudiodb.parseArtists(await fixture('theaudiodb-artist-empty')), []);
  assert.match(theaudiodb.artistUrls('AC/DC', { key: '123' })[0], /\/json\/123\/search\.php\?s=AC%2FDC$/);
  assert.match(theaudiodb.artistUrls('x', { key: '../../evil' })[0], /\/json\/123\//, 'a bad key falls back to the free key');

  const it = itunes.parseSongs(await fixture('itunes-search'));
  const q = songQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', duration: 356 });
  const best = pickBest(it, q).candidate;
  assert.equal(best.id, '1440806768');
  assert.equal(best.year, 1975);
  assert.equal(best.genre, 'Rock');
  assert.match(imageUrls(best.cover).m, /600x600bb\.jpg$/);
  assert.deepEqual(itunes.parseSongs(await fixture('itunes-search-empty')), []);

  const f = fanarttv.parseArtist(await fixture('fanarttv-artist'));
  assert.match(f.fanart[0], /coldplay-2\.jpg$/, 'most liked background first');
  assert.match(f.logo, /hdmusiclogo/);
  assert.equal(fanarttv.artistUrl('not-an-mbid', 'abcdefgh1234'), null);
  assert.equal(fanarttv.artistUrl('cc197bad-dc9c-440d-a5b5-d52ba2e14234', ''), null);
});

test('image refs expand to sizes; only allow-listed image hosts are fetched', () => {
  assert.deepEqual(imageUrls('dz:https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg'), {
    s: 'https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg',
    m: 'https://e-cdns-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg',
    l: 'https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg',
  });
  assert.deepEqual(imageUrls('caa:2b3c4d5e-2222-4222-8222-222222222222').m, 'https://coverartarchive.org/release-group/2b3c4d5e-2222-4222-8222-222222222222/front-500');
  assert.equal(imageUrls('caa:../../x'), null);
  assert.equal(imageUrls('tadb:https://r2.theaudiodb.com/a.jpg').s, 'https://r2.theaudiodb.com/a.jpg/small');
  assert.equal(imageUrls('nope'), null);
  assert.equal(imageUrls(null), null);
  for (const bad of ['http://127.0.0.1:8080/api/info', 'http://localhost/x.jpg', 'file:///etc/passwd', 'https://evil.example/x.jpg', 'https://user:pw@e-cdns-images.dzcdn.net/x.jpg', 'https://dzcdn.net.evil.example/x.jpg']) {
    assert.equal(allowedImageUrl(bad), false, bad);
  }
  for (const good of ['https://e-cdns-images.dzcdn.net/images/cover/a/250x250-000000-80-0-0.jpg', 'https://coverartarchive.org/release-group/x/front-250', 'https://ia800.us.archive.org/1/items/x.jpg', 'https://r2.theaudiodb.com/images/a.jpg']) {
    assert.equal(allowedImageUrl(good), true, good);
  }
  // A user-edited wiki entry pointing at the LAN is dropped by the parser.
  const [a] = theaudiodb.parseArtists({ artists: [{ strArtist: 'X', strArtistThumb: 'http://192.168.1.1/admin.jpg', strArtistFanart: 'https://r2.theaudiodb.com/ok.jpg' }] });
  assert.equal(a.picture, null);
  assert.equal(a.fanart.length, 1);
  assert.equal(sizeKey('1000'), 'l');
  assert.equal(sizeKey('500'), 'm');
  assert.equal(sizeKey('250'), 's');
  assert.equal(sizeKey(null, 'm'), 'm');
});

// ---- matching -------------------------------------------------------------------------------------------

test('matching: titles, credits, spelling and genres', () => {
  assert.equal(titleCore('Hello (Live) [Karaoke]'), 'Hello');
  assert.equal(titleCore('(I Can\'t Get No) Satisfaction'), 'Satisfaction');
  assert.equal(titleCore('Hey Ya! - Radio Mix'), 'Hey Ya!');
  assert.equal(searchTitle('(I Can\'t Get No) Satisfaction (Live)'), '(I Can\'t Get No) Satisfaction');
  assert.equal(searchTitle('Stay (feat. Justin Bieber)'), 'Stay');
  assert.deepEqual(creditsOf('The Beatles'), ['Beatles']);
  assert.deepEqual(creditsOf('Elton John & Kiki Dee'), ['Elton John', 'Kiki Dee']);
  const pink = songQuery({ artist: 'Pink', title: 'So What' });
  assert.ok(scoreCandidate({ artist: 'P!nk', title: 'So What' }, pink) > 0.9, 'P!nk = Pink');
  const kesha = songQuery({ artist: 'Kesha', title: 'Tik Tok' });
  assert.ok(scoreCandidate({ artist: 'Ke$ha', title: 'TiK ToK' }, kesha) > 0.9, 'Ke$ha = Kesha');
  assert.ok(scoreCandidate({ artist: 'The Beatles', title: 'Let It Be' }, songQuery({ artist: 'Beatles', title: 'Let It Be' })) > 0.95);
  assert.equal(scoreCandidate({ artist: 'Queen', title: 'Radio Ga Ga' }, songQuery({ artist: 'Queen', title: 'Bohemian Rhapsody' })), 0);
  const duet = songQuery({ artist: 'Elton John & Kiki Dee', title: 'Don\'t Go Breaking My Heart' });
  assert.ok(scoreCandidate({ artist: 'Elton John', title: 'Don\'t Go Breaking My Heart' }, duet) > 0.9, 'one of the credited singers is enough');
  const long = songQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', duration: 356 });
  assert.ok(scoreCandidate({ artist: 'Queen', title: 'Bohemian Rhapsody', duration: 355 }, long) > scoreCandidate({ artist: 'Queen', title: 'Bohemian Rhapsody', duration: 600 }, long));
  assert.ok(scoreCandidate({ artist: 'Queen', title: 'Bohemian Rhapsody', album: 'Greatest Hits' }, long) < scoreCandidate({ artist: 'Queen', title: 'Bohemian Rhapsody', album: 'A Night at the Opera' }, long));
  assert.ok(scoreCandidate({ artist: 'Queen', title: 'Bohemian Rhapsody', album: 'Karaoke Party' }, long) < 0.62);
  assert.ok(scoreCandidate({ artist: 'Adele', title: 'Hello (Karaoke Version)' }, songQuery({ artist: 'Adele', title: 'Hello (Karaoke Version)' })) > 0.9, 'asked for karaoke → no penalty');
  assert.equal(normalizeGenre('Hip-Hop/Rap'), 'Rap/Hip Hop');
  assert.equal(normalizeGenre('R&B/Soul'), 'R&B');
  assert.equal(normalizeGenre('  Pop '), 'Pop');
  assert.equal(normalizeGenre('Polka'), 'Polka');
  assert.equal(normalizeGenre(''), '');
  assert.equal(yearOf('1975-11-21'), 1975);
  assert.equal(yearOf('0000-00-00'), 0);
  assert.equal(yearOf(undefined), 0);
});

test('throttle: bursts up to capacity, then paces; pauses; urgent callers give up', async () => {
  let t = 0;
  const th = new Throttle({ capacity: 2, perMs: 1000, now: () => t });
  assert.equal(th.delay(), 0);
  await th.wait();
  await th.wait();
  assert.equal(th.delay(), 500);
  t += 500;
  assert.equal(th.delay(), 0);
  th.pause(10_000);
  assert.equal(th.pausedFor(), 10_000);
  await assert.rejects(th.wait({ maxWaitMs: 1000 }), (e) => e.code === 'busy');
  th.resume();
  assert.equal(th.pausedFor(), 0);
});

// ---- the service (fake network) ------------------------------------------------------------------------------

const NAMES = [
  'Queen - Bohemian Rhapsody [SF Karaoke]',
  'Queen - Bohemian Rhapsody [SC Karaoke]',
  'Queen - Bohemian Rhapsody [ZM Karaoke]',
  'Adele - Hello [SF Karaoke]',
  'Adele - Hello [ZM Karaoke]',
  'Nobody Knows - Unknown Tune [SF Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
];

async function makeService({ fetch = fakeArtFetch({ unknown: new Set(['nobody knows']) }), settings: patch, dataDir } = {}) {
  dataDir ||= await tmpDir('ok-art-');
  const settings = new Settings(dataDir);
  settings.update({ artwork: { crawl: false }, ...patch });
  const library = new EventEmitter();
  library.catalog = new Catalog().load(rawTracks(NAMES));
  const art = new ArtworkService({ dataDir, settings, library, fetch, crawlDelayMs: 5 });
  await art.init({ crawl: false });
  const song = (title) => [...library.catalog.songs.values()].find((s) => s.title === title);
  const artist = (name) => library.catalog.artistList.find((a) => a.name === name);
  return { art, settings, library, catalog: library.catalog, song, artist, dataDir, fetch };
}

const nextArt = (art) => new Promise((resolve) => art.once('art', resolve));

test('service: a song lookup stores cover, genre, year and rank; art event; images cached; persisted', async () => {
  const { art, song, catalog, dataDir, fetch } = await makeService();
  const s = song('Bohemian Rhapsody');
  const event = nextArt(art);
  assert.equal(await art.request('song', s, 'now'), true);
  const meta = catalog.metaFor(s.key);
  assert.equal(meta.p, 'deezer');
  assert.match(meta.cover, /^dz:/);
  assert.ok(['Pop', 'Rock', 'Dance', 'R&B'].includes(meta.genre));
  assert.ok(meta.year >= 1970 && meta.year < 2020);
  assert.ok(meta.rank > 0);
  assert.equal(meta.confidence, 1);
  assert.deepEqual((await event).songs, [s.id]);
  // The artist picture came with the search result (no extra request).
  assert.ok(art.artists.get(s.artistKeys[0]).picture);
  // Same request again: answered from memory.
  const n = fetch.calls.length;
  assert.equal(await art.request('song', s, 'visible'), true);
  assert.equal(fetch.calls.length, n);
  // Catalog uses the metadata: summaries, facets, filters.
  catalog.metaChanged();
  assert.equal(catalog.songSummary(s).art, 1);
  assert.equal(catalog.songSummary(s).year, meta.year);
  assert.equal(catalog.facets().genres[0].genre, meta.genre);
  assert.equal(catalog.filterSongs({ decade: Math.floor(meta.year / 10) * 10 }).items[0].id, s.id);
  const img = await art.image(meta.cover, 'm');
  assert.equal(img.type, 'image/png');
  assert.ok((await fs.stat(img.abs)).size > 50);
  await art.close();

  // A new service loads meta.json and the image index.
  const again = await makeService({ dataDir });
  assert.equal(again.catalog.metaFor(s.key).cover, meta.cover);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(again.art.files.size >= 1);
  assert.ok(again.art.anyImage(meta.cover));
  await again.art.close();
});

test('service: misses walk the provider chain and are remembered; retryMisses forgets them', async () => {
  const { art, song, fetch } = await makeService();
  const s = song('Unknown Tune');
  assert.equal(await art.request('song', s, 'now'), false);
  const e = art.songs.get(s.key);
  assert.equal(e.miss, true);
  assert.deepEqual(e.tried, ['deezer', 'musicbrainz']); // iTunes is off by default
  assert.ok(fetch.calls.some((u) => u.startsWith('https://musicbrainz.org/ws/2/recording/')));
  assert.deepEqual(art.songChain(s.key), []);
  const n = fetch.calls.length;
  assert.equal(await art.request('song', s, 'visible'), false, 'not asked again');
  assert.equal(fetch.calls.length, n);
  // Turning iTunes on makes it worth asking again (only iTunes).
  art.settings.update({ artwork: { providers: { itunes: true } } });
  assert.deepEqual(art.songChain(s.key), ['itunes']);
  art.settings.update({ artwork: { providers: { itunes: false } } });
  assert.equal(art.retryMisses().cleared, 1);
  assert.equal(art.songs.has(s.key), false);
  await art.close();
});

test('service: no internet → back-off, provider marked offline, nothing recorded as missing', async () => {
  const { art, song } = await makeService({ fetch: offlineFetch });
  const s = song('Hello');
  assert.equal(await art.request('song', s, 'now'), null);
  assert.equal(art.songs.has(s.key), false);
  const st = art.status();
  const dz = st.providers.find((p) => p.name === 'deezer');
  assert.equal(dz.status, 'offline');
  assert.ok(dz.pausedSec > 0);
  assert.match(dz.lastError, /ENOTFOUND/);
  // A visible lookup doesn't wait for the back-off.
  const t0 = Date.now();
  assert.equal(await art.request('song', song('Call Me'), 'visible'), null);
  assert.ok(Date.now() - t0 < 1000);
  await art.close();
});

test('service: Deezer quota errors and HTTP 503 pause the provider', async () => {
  const quota = await fixture('deezer-error-quota');
  const fetch = fakeArtFetch({ override: (u) => (u.hostname === 'api.deezer.com' ? new Response(JSON.stringify(quota), { status: 200 }) : u.hostname === 'musicbrainz.org' ? new Response('slow down', { status: 503, headers: { 'retry-after': '7' } }) : undefined) });
  const { art, song } = await makeService({ fetch });
  assert.equal(await art.request('song', song('Hello'), 'now'), null);
  const st = art.status();
  assert.equal(st.providers.find((p) => p.name === 'deezer').status, 'limited');
  const mb = st.providers.find((p) => p.name === 'musicbrainz');
  assert.equal(mb.status, 'limited');
  assert.ok(mb.pausedSec >= 6 && mb.pausedSec <= 7, 'Retry-After is honoured');
  assert.equal(art.songs.has(song('Hello').key), false);
  await art.close();
});

test('service: Cover Art Archive — follows redirects to archive.org, skips release groups without art', async () => {
  const mbJson = await fixture('musicbrainz-recording-search');
  const png = pngImage('caa');
  const fetch = fakeArtFetch({
    unknown: new Set(['adele']),
    override: (u) => {
      if (u.hostname === 'musicbrainz.org') return new Response(JSON.stringify(mbJson), { status: 200 });
      if (u.pathname === '/release-group/2b3c4d5e-2222-4222-8222-222222222222/front-250') return new Response('', { status: 404 });
      if (u.pathname === '/release-group/3c4d5e6f-3333-4333-8333-333333333333/front-250') return new Response(null, { status: 307, headers: { location: 'https://ia800.us.archive.org/items/single.png' } });
      if (u.hostname === 'ia800.us.archive.org') return new Response(png, { status: 200 });
      return undefined;
    },
  });
  // The karaoke title is "Hello" but the MB fixture is "Someone Like You": use a matching song.
  const { art, library } = await makeService({ fetch });
  library.catalog = new Catalog().load(rawTracks(['Adele - Someone Like You [SF Karaoke]']));
  art.installMeta();
  const s = [...library.catalog.songs.values()][0];
  assert.equal(await art.request('song', s, 'now'), true);
  const e = art.songs.get(s.key);
  assert.equal(e.p, 'musicbrainz');
  assert.equal(e.cover, 'caa:3c4d5e6f-3333-4333-8333-333333333333');
  assert.equal(e.year, 2011);
  assert.ok(fetch.calls.includes('https://ia800.us.archive.org/items/single.png'));
  await art.close();
});

test('service: redirects to hosts outside the allow-list and non-images are refused', async () => {
  const fetch = fakeArtFetch({
    override: (u) => {
      if (u.hostname.endsWith('dzcdn.net') && u.pathname.includes('/cover/')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/api/info' } });
      if (u.hostname.endsWith('dzcdn.net')) return new Response('<html>not an image</html>', { status: 200 });
      return undefined;
    },
  });
  const { art, song } = await makeService({ fetch });
  const s = song('Hello');
  assert.equal(await art.request('song', s, 'now'), true);
  const e = art.songs.get(s.key);
  assert.equal(await art.image(e.cover, 's'), null);
  assert.ok(!fetch.calls.some((u) => u.includes('127.0.0.1')), 'never fetched the LAN address');
  const picture = art.artists.get(s.artistKeys[0]).picture;
  assert.equal(await art.image(picture, 'm'), null, 'HTML is not stored as an image');
  assert.equal(art.files.size, 0);
  await art.close();
});

test('service: artists get a picture (Deezer) and fanart/logo (TheAudioDB) when the TV needs them', async () => {
  const { art, artist } = await makeService();
  const a = artist('Blondie');
  assert.equal(await art.request('artist', a, 'visible', 'picture'), true);
  let e = art.artists.get(a.key);
  assert.ok(e.picture);
  assert.equal(e.fanart, undefined, 'a picture alone doesn’t ask TheAudioDB');
  assert.equal(await art.request('artist', a, 'now', 'all'), true);
  e = art.artists.get(a.key);
  assert.equal(e.fanart.length, 2);
  assert.ok(e.logo);
  assert.equal(e.genre, 'Pop');
  assert.deepEqual(art.publicArtist(a.key), { picture: true, fanart: 2, logo: true, genre: 'Pop' });
  assert.deepEqual(art.artistChain(a.key, 'all'), [], 'fanart.tv is off without a key');
  await art.close();
});

test('service: the crawler works through popular songs first and reports progress', async () => {
  const { art, catalog } = await makeService();
  art.settings.update({ artwork: { crawl: true } });
  const order = catalog.popular({ limit: 10 }).items.map((s) => s.key);
  const seen = [];
  const orig = art.songStep.bind(art);
  art.songStep = (job, name) => {
    if (name === 'deezer') seen.push(job.key);
    return orig(job, name);
  };
  art.crawlTick();
  for (let i = 0; i < 100 && art.status().songs.pending; i++) {
    await new Promise((r) => setTimeout(r, 30));
    art._status = null;
  }
  const st = art.status();
  assert.deepEqual(st.songs, { total: 4, found: 3, missed: 1, pending: 0 });
  assert.equal(seen[0], order[0], 'most popular first (3 label versions)');
  assert.equal(st.state, 'running');
  await art.close();
});

test('service: the image cache stays under its size limit (least recently used go first)', async () => {
  const { art } = await makeService({ settings: { artwork: { crawl: false, maxCacheMB: 20 } } });
  await art.indexing; // the startup index is complete (it would count the files below once more)
  const mb = 1024 * 1024;
  for (let i = 0; i < 5; i++) {
    const key = String(i).repeat(40).slice(0, 40);
    await fs.writeFile(path.join(art.artDir, `${key}.png`), 'x');
    art.files.set(key, { ext: 'png', size: 6 * mb, used: 1000 + i });
    art.bytes += 6 * mb;
  }
  art.evict();
  assert.ok(art.bytes <= 18 * mb);
  assert.deepEqual([...art.files.keys()].map((k) => k[0]), ['2', '3', '4'], 'oldest removed until ≤ 90 %');
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(fs.stat(path.join(art.artDir, `${'0'.repeat(40)}.png`)));
  await art.close();
});

test('service: fix artwork — candidates, choose one, or no cover at all', async () => {
  const { art, song } = await makeService();
  const s = song('Call Me');
  const { items, errors } = await art.candidates(s);
  assert.deepEqual(errors, []);
  assert.ok(items.length >= 1);
  assert.match(items[0].thumb, /^\/api\/art\/candidate\/.*\/deezer%3A/, 'thumbnails are served by our server, not the CDN');
  await assert.rejects(art.choose(s, 'deezer:nope'), /expired/);
  await art.choose(s, items[0].id);
  const e = art.songs.get(s.key);
  assert.equal(e.manual, true);
  assert.equal(e.confidence, 1);
  art.setNone(s);
  assert.equal(art.songs.get(s.key).cover, undefined);
  assert.deepEqual(art.songChain(s.key), [], 'the crawler leaves manual choices alone');
  assert.equal(art.retryMisses().cleared, 0, 'manual "no cover" is not a miss to retry');
  const r = await art.refresh(s);
  assert.equal(r.found, true);
  await art.close();
});

test('service: turned off → no network at all, cached images still served', async () => {
  const fetch = fakeArtFetch();
  const { art, song } = await makeService({ fetch, settings: { artwork: { enabled: false, crawl: false } } });
  assert.equal(await art.request('song', song('Hello'), 'now'), null);
  assert.equal(fetch.calls.length, 0);
  await assert.rejects(art.candidates(song('Hello')), /turned off/);
  await art.close();
});
