// The year & genre checker: the host's own years and genres (data/songmeta.json, laid over the
// online song information everywhere), which songs get flagged and why, the suggestions, the
// first-release lookup and the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SongMeta, cleanYear, cleanGenre } from '../server/library/songmeta.js';
import { checkSongs, checkMatches, firstYearOf } from '../server/artwork/checker.js';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree } from './helpers.js';
import { fakeArtFetch } from './fake-art.js';

const NOW = Date.UTC(2026, 9, 18);

test('the host’s year and genre: cleaned, laid over the online entry, undone, kept in the file', async () => {
  assert.equal(cleanYear('1975', NOW), 1975);
  for (const bad of [1899, 2028, 1975.5, 'abc', null]) assert.equal(cleanYear(bad, NOW), null, String(bad));
  assert.equal(cleanYear(2027, NOW), 2027, 'next year is allowed (a release date)');
  assert.equal(cleanGenre('  Rock  &  Roll '), 'Rock & Roll');
  assert.equal(cleanGenre('R&B'), 'R&B');
  assert.equal(cleanGenre('<script>'), '');
  assert.equal(cleanGenre('x'.repeat(80)).length, 40);

  const dir = await tmpDir('ok-songmeta-');
  const file = path.join(dir, 'songmeta.json');
  const meta = await new SongMeta(file, { now: () => NOW }).load();
  const online = { year: 1999, genre: 'Pop', cover: 'dz:x' };
  assert.equal(meta.apply('queen|bohemian rhapsody', online), online, 'nothing of the host’s: the online entry itself');
  meta.set('queen|bohemian rhapsody', { year: 1975 });
  const merged = meta.apply('queen|bohemian rhapsody', online);
  assert.deepEqual([merged.year, merged.genre, merged.cover, merged.host], [1975, 'Pop', 'dz:x', { year: true }]);
  assert.equal(meta.apply('queen|bohemian rhapsody', online), merged, 'the same object while nothing changed');
  assert.equal(meta.apply('nobody|nothing', null), null);
  assert.deepEqual(meta.apply('queen|bohemian rhapsody', null).year, 1975, 'also with nothing online');
  assert.throws(() => meta.set('queen|bohemian rhapsody', { year: 1850 }), /A year from 1900/);
  assert.throws(() => meta.set('queen|bohemian rhapsody', { genre: '???' }), /odd characters/);
  assert.throws(() => meta.set('__proto__', { year: 1975 }), /Unknown song/);
  meta.set('abba|waterloo', { genre: 'Pop', year: 1974 });
  meta.set('abba|waterloo', { year: null });
  assert.deepEqual(meta.get('abba|waterloo'), { genre: 'Pop', at: NOW });
  meta.set('abba|waterloo', { genre: null });
  assert.equal(meta.get('abba|waterloo'), null, 'nothing left: the record goes');
  await meta.flush();

  // Kept, and a hand-edited file is cleaned.
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.songs['bad|year'] = { year: 1200 };
  raw.songs.__proto__ = { year: 1975 };
  raw.songs['odd|entry'] = 'nope';
  await fs.writeFile(file, JSON.stringify(raw));
  const again = await new SongMeta(file, { now: () => NOW }).load();
  assert.deepEqual(Object.keys(again.songs), ['queen|bohemian rhapsody']);
  assert.equal(again.get('queen|bohemian rhapsody').year, 1975);
});

test('which songs are flagged, why, and what is suggested', () => {
  const song = (id, artist, title) => ({ id, key: `${artist}|${title}`, artistKeys: [artist] });
  const songs = [
    song('a1', 'abba', 'waterloo'), song('a2', 'abba', 'sos'), song('a3', 'abba', 'mamma mia'), song('a4', 'abba', 'fernando'),
    song('a5', 'abba', 'the winner'), // 1999: a compilation's year
    song('a6', 'abba', 'chiquitita'), // 2004: much later than ABBA's other songs
    song('q1', 'queen', 'killer queen'), // no year, no genre: Queen's genre from the artist
    song('q2', 'queen', 'radio gaga'),
    song('z1', 'zed', 'lost'), // no genre, nothing to suggest
    song('z2', 'zed', 'odd'), // a year that can't be right
    song('h1', 'host', 'checked'), // the host's own year and genre: never flagged
  ];
  const online = {
    'abba|waterloo': { year: 1974, genre: 'Pop' },
    'abba|sos': { year: 1975, genre: 'Pop' },
    'abba|mamma mia': { year: 1975, genre: 'Pop' },
    'abba|fernando': { year: 1976, genre: 'Pop' },
    'abba|the winner': { year: 1999, genre: 'Pop', album: 'ABBA Gold: Greatest Hits' },
    'abba|chiquitita': { year: 2004, genre: 'Pop', p: 'deezer', albumId: 7 },
    'queen|killer queen': {},
    'queen|radio gaga': { year: 1984 },
    'zed|lost': { year: 1990 },
    'zed|odd': { year: 1066, genre: 'Folk' },
    'host|checked': { album: 'Remastered Collection' },
  };
  const own = { 'host|checked': { year: 1980, genre: 'Rock' } };
  const res = checkSongs({
    songs,
    online: (k) => online[k] || null,
    own: (k) => own[k] || null,
    albumType: (e) => (e.albumId === 7 ? 'album' : ''),
    artistGenre: (a) => (a === 'queen' ? 'Rock' : ''),
    now: NOW,
  });
  const why = Object.fromEntries([...res].map(([id, r]) => [id, r.why]));
  assert.deepEqual(why, {
    a5: ['compilation', 'late'],
    a6: ['late'],
    q1: ['no-year', 'no-genre'],
    q2: ['no-genre'],
    z1: ['no-genre'],
    z2: ['range'],
  });
  assert.deepEqual(res.get('q1').suggest, { genre: 'Rock' });
  assert.deepEqual(res.get('z1').suggest, {}, 'Zed: no genre anywhere to suggest');
  // An album type of 'compile' (Deezer) flags it too, whatever its title.
  const comp = checkSongs({ songs: [songs[0]], online: () => ({ year: 2001, genre: 'Pop', p: 'deezer', albumId: 1 }), own: () => null, albumType: () => 'compile', artistGenre: () => '', now: NOW });
  assert.deepEqual(comp.get('a1').why, ['compilation']);
  // The genre suggestion from the artist's other songs needs two that agree.
  const two = checkSongs({
    songs: [song('b1', 'bee', 'one'), song('b2', 'bee', 'two'), song('b3', 'bee', 'three')],
    online: (k) => ({ 'bee|one': { year: 1977, genre: 'Disco' }, 'bee|two': { year: 1978, genre: 'Disco' }, 'bee|three': { year: 1979 } })[k],
    own: () => null, albumType: () => '', artistGenre: () => '', now: NOW,
  });
  assert.deepEqual(two.get('b3').suggest, { genre: 'Disco' });

  assert.equal(checkMatches(res.get('a5'), 'year'), true);
  assert.equal(checkMatches(res.get('a5'), 'genre'), false);
  assert.equal(checkMatches(res.get('q2'), 'genre'), true);
  assert.equal(checkMatches(res.get('q2'), 'year'), false);
  assert.equal(checkMatches(res.get('q1'), 'any'), true);
  assert.equal(checkMatches(undefined, 'any'), false);
});

test('the first release: the earliest confident match that is not another version', () => {
  const c = (year, confidence, extra = {}) => ({ year, confidence, album: `A${year}`, provider: 'P', ...extra });
  assert.deepEqual(firstYearOf([c(1999, 0.95), c(1975, 0.9), c(1970, 0.5), c(1972, 0.95, { version: 'Live' }), c(0, 1), c(3000, 1)], { now: NOW }),
    { year: 1975, album: 'A1975', provider: 'P' });
  assert.equal(firstYearOf([c(1975, 0.5)], { now: NOW }), null);
  assert.equal(firstYearOf([], { now: NOW }), null);
});

test('the checker through the API: flagged rows, setting and undoing, the filters follow, first release', async () => {
  const lib = await tmpDir('ok-lib-');
  const files = {};
  for (const name of ['Queen - Bohemian Rhapsody [SF Karaoke]', 'Queen - Killer Queen [SF Karaoke]', 'Abba - Waterloo [SC Karaoke]']) {
    const artist = name.split(' - ')[0];
    files[`${artist[0]}/${artist}/${name}.cdg`] = Buffer.alloc(7200 * 10);
    files[`${artist[0]}/${artist}/${name}.mp3`] = Buffer.alloc(100);
  }
  await writeTree(lib, files);
  // MusicBrainz knows when Bohemian Rhapsody first came out; Deezer only a compilation.
  const artFetch = fakeArtFetch({
    override: (url) => {
      if (url.hostname !== 'musicbrainz.org' || !/Bohemian/i.test(url.search)) return undefined;
      return new Response(JSON.stringify({ recordings: [
        { id: 'r1', title: 'Bohemian Rhapsody', 'artist-credit': [{ name: 'Queen' }], 'first-release-date': '1975-10-31', length: 355000, releases: [] },
        { id: 'r2', title: 'Bohemian Rhapsody', disambiguation: 'live', 'artist-credit': [{ name: 'Queen' }], 'first-release-date': '1974-01-01', releases: [] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const dataDir = await tmpDir('ok-data-');
  let app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch: artFetch, crawl: false });
  await app.library.scan();
  await app.listen(0, '127.0.0.1');
  const cat = () => app.library.catalog;
  const base = () => `http://127.0.0.1:${app.port}`;
  const id = (title) => cat().songList.find((s) => s.title === title).id;
  const keyOf = (title) => cat().songList.find((s) => s.title === title).key;
  const get = async (p) => (await fetch(`${base()}${p}`)).json();
  const post = (p, body) => fetch(`${base()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // What the lookup found: Bohemian Rhapsody dated by a greatest-hits album, Killer Queen
    // without a genre, Waterloo fine.
    const art = app.artwork;
    art.songs.set(keyOf('Bohemian Rhapsody'), { year: 1981, genre: 'Rock', album: 'Greatest Hits', at: 1, v: 9 });
    art.songs.set(keyOf('Killer Queen'), { year: 1974, at: 1, v: 9 });
    art.songs.set(keyOf('Waterloo'), { year: 1974, genre: 'Pop', at: 1, v: 9 });
    art.artists.set(cat().songList.find((s) => s.title === 'Killer Queen').artistKeys[0], { genre: 'Rock', at: 1, v: 9 });
    cat().metaChanged();

    let r = await get('/api/library/songs?check=any&sort=title');
    assert.deepEqual(r.items.map((s) => [s.title, s.check.why, s.check.suggest]), [
      ['Bohemian Rhapsody', ['compilation'], {}],
      ['Killer Queen', ['no-genre'], { genre: 'Rock' }],
    ]);
    assert.deepEqual((await get('/api/library/songs?check=genre')).items.map((s) => s.title), ['Killer Queen']);
    assert.deepEqual((await get('/api/library/songs?check=year')).items.map((s) => s.title), ['Bohemian Rhapsody']);
    assert.equal((await get('/api/library/songs?check=year&decade=1980')).total, 1, 'with the browse filters');

    // The first release, from MusicBrainz (the live recording left out): suggested.
    let res = await post('/api/library/meta/first-year', { songId: id('Bohemian Rhapsody') });
    assert.equal(res.status, 200);
    const found = await res.json();
    assert.deepEqual([found.found.year, found.check.suggest], [1975, { year: 1975 }]);

    // Setting a year: the row says it is the host's, the decade filter follows, it isn't flagged.
    res = await post('/api/library/meta', { songId: id('Bohemian Rhapsody'), year: 1975 });
    assert.equal(res.status, 200);
    const set = await res.json();
    assert.deepEqual([set.row.year, set.row.own, set.check], [1975, { year: true }, null]);
    assert.deepEqual((await get('/api/browse/popular?decade=1970')).items.map((s) => s.title).sort(), ['Bohemian Rhapsody', 'Killer Queen', 'Waterloo']);
    assert.equal((await get('/api/browse/popular?decade=1980')).total, 0);
    assert.deepEqual((await get('/api/library/songs?check=any')).items.map((s) => s.title), ['Killer Queen']);
    // Undo: the online year (and the flag) are back.
    await post('/api/library/meta', { songId: id('Bohemian Rhapsody'), year: null });
    assert.equal((await get('/api/library/songs?sort=year&dir=desc&limit=1')).items[0].year, 1981);

    // Accept all: every suggestion in the view (Bohemian Rhapsody's year, Killer Queen's genre).
    res = await post('/api/library/meta/accept', { check: 'any' });
    assert.deepEqual(await res.json(), { changed: 2 });
    assert.equal((await get('/api/library/songs?check=any')).total, 0);
    assert.deepEqual((await get('/api/browse/facets')).genres.find((g) => g.genre === 'Rock').count, 2);

    // Bad input; guests may not.
    assert.equal((await post('/api/library/meta', { songId: 'nope', year: 1975 })).status, 404);
    assert.equal((await post('/api/library/meta', { songId: id('Waterloo'), year: 1500 })).status, 400);
    assert.equal((await post('/api/library/meta', { songId: id('Waterloo') })).status, 400);
    assert.equal((await post('/api/library/meta/accept', { check: 'everything' })).status, 400);
    const text = await fetch(`${base()}/api/library/meta`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(text.status, 415);
    app.settings.update({ party: { trustLocalhost: false } });
    assert.equal((await post('/api/library/meta', { songId: id('Waterloo'), year: 1975 })).status, 403);
    assert.equal((await fetch(`${base()}/api/library/songs?check=any`)).status, 403);
    app.settings.update({ party: { trustLocalhost: true } });

    // Kept across a restart.
    await app.close();
    app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch: artFetch, crawl: false });
    await app.library.scan();
    await app.listen(0, '127.0.0.1');
    assert.deepEqual(app.songMeta.get(keyOf('Killer Queen')), { genre: 'Rock', at: app.songMeta.get(keyOf('Killer Queen')).at });
    assert.equal(cat().metaFor(keyOf('Bohemian Rhapsody')).year, 1975);
  } finally {
    await app.close();
  }
});
