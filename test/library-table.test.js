// The host's Library table: one row per song, sorted by a column (both ways, ties A–Z, unknown
// years and genres last), narrowed by the browse filters and a text, a page at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, TABLE_SORTS } from '../server/library/catalog.js';
import { createApp } from '../server/app.js';
import { rawTracks, tmpDir, writeTree } from './helpers.js';
import { offlineFetch } from './fake-art.js';

const NAMES = [
  'Adele - Hello [SF Karaoke]',
  'Adele - Hello [ZM Karaoke]',
  'Adele - Hello [SC Karaoke]',
  'The Beatles - Help [SC Karaoke]',
  'Blondie - Call Me [SF Karaoke]',
  'Blondie - Call Me [ZM Karaoke]',
  'Queen - Bohemian Rhapsody [SF Karaoke]',
  'Abba - Waterloo [ZM Karaoke]',
  'Toto - Africa [SC Karaoke]',
  'Toto - Hold The Line [SF Karaoke]',
];
const META = {
  Hello: { year: 2015, genre: 'Pop' },
  Help: { year: 1965, genre: 'Rock' },
  'Call Me': { year: 1980, genre: 'Rock' },
  'Bohemian Rhapsody': { year: 1975, genre: 'Rock' },
  Africa: { year: 1982, genre: 'Pop' },
  // Waterloo and Hold The Line: not looked up yet.
};

function build() {
  const cat = new Catalog().load(rawTracks(NAMES), ['/library']);
  const titleOf = new Map(cat.songList.map((s) => [s.key, s.title]));
  cat.metaFor = (key) => META[titleOf.get(key)] || null;
  const id = (title) => cat.songList.find((s) => s.title === title).id;
  cat.plays.set(id('Africa'), 5);
  cat.plays.set(id('Hello'), 2);
  cat.plays.set(id('Call Me'), 2);
  return cat;
}
const titles = (r) => r.items.map((s) => s.title);

test('every column sorts both ways; ties A–Z by artist, then title', () => {
  const cat = build();
  const by = (sort, dir = 'asc') => titles(cat.table({ sort, dir }));
  // Artist: "The Beatles" under B.
  assert.deepEqual(by('artist'), ['Waterloo', 'Hello', 'Help', 'Call Me', 'Bohemian Rhapsody', 'Africa', 'Hold The Line']);
  assert.deepEqual(by('artist', 'desc'), ['Africa', 'Hold The Line', 'Bohemian Rhapsody', 'Call Me', 'Help', 'Hello', 'Waterloo'],
    'artists Z–A, each artist’s songs still A–Z');
  assert.deepEqual(by('title'), ['Africa', 'Bohemian Rhapsody', 'Call Me', 'Hello', 'Help', 'Hold The Line', 'Waterloo']);
  assert.deepEqual(by('title', 'desc'), ['Waterloo', 'Hold The Line', 'Help', 'Hello', 'Call Me', 'Bohemian Rhapsody', 'Africa']);
  // Year and genre: unknown last, both ways.
  assert.deepEqual(by('year'), ['Help', 'Bohemian Rhapsody', 'Call Me', 'Africa', 'Hello', 'Waterloo', 'Hold The Line']);
  assert.deepEqual(by('year', 'desc'), ['Hello', 'Africa', 'Call Me', 'Bohemian Rhapsody', 'Help', 'Waterloo', 'Hold The Line']);
  assert.deepEqual(by('genre'), ['Hello', 'Africa', 'Help', 'Call Me', 'Bohemian Rhapsody', 'Waterloo', 'Hold The Line']);
  assert.deepEqual(by('genre', 'desc'), ['Help', 'Call Me', 'Bohemian Rhapsody', 'Hello', 'Africa', 'Waterloo', 'Hold The Line']);
  // Versions and plays: numbers; ties A–Z.
  assert.deepEqual(by('versions', 'desc'), ['Hello', 'Call Me', 'Waterloo', 'Help', 'Bohemian Rhapsody', 'Africa', 'Hold The Line']);
  assert.deepEqual(by('plays', 'desc'), ['Africa', 'Hello', 'Call Me', 'Waterloo', 'Help', 'Bohemian Rhapsody', 'Hold The Line']);
  // Label: the song's first label (the library's most common first: SF on four songs), A–Z.
  assert.deepEqual(by('label'), ['Help', 'Africa', 'Hello', 'Call Me', 'Bohemian Rhapsody', 'Hold The Line', 'Waterloo']);
  assert.deepEqual(by('label', 'desc'), ['Waterloo', 'Hello', 'Call Me', 'Bohemian Rhapsody', 'Hold The Line', 'Help', 'Africa']);
  // An unknown column is the artist order.
  assert.deepEqual(by('__proto__'), by('artist'));
  assert.deepEqual(TABLE_SORTS, ['artist', 'title', 'label', 'year', 'genre', 'versions', 'plays']);
});

test('rows: labels (most common first), genre, plays; text, filters and pages', () => {
  const cat = build();
  const hello = cat.tableRow(cat.songList.find((s) => s.title === 'Hello'));
  // (SF labels four songs; SC and ZM three each, so their order is the library's tie.)
  assert.deepEqual([hello.labels[0], [...hello.labels].sort(), hello.genre, hello.plays, hello.year, hello.v], ['SF', ['SC', 'SF', 'ZM'], 'Pop', 2, 2015, 3]);
  const line = cat.tableRow(cat.songList.find((s) => s.title === 'Hold The Line'));
  assert.deepEqual([line.labels, line.genre, line.plays, line.year], [['SF'], undefined, 0, undefined]);

  // Text: every word, in the title or the artist, any order; the column sort stays.
  assert.deepEqual(titles(cat.table({ q: 'toto', sort: 'title', dir: 'desc' })), ['Hold The Line', 'Africa']);
  assert.deepEqual(titles(cat.table({ q: 'he', sort: 'title' })), ['Bohemian Rhapsody', 'Hello', 'Help', 'Hold The Line'], 'part of a word (Bohemian, Hello, “The”)');
  assert.deepEqual(titles(cat.table({ q: 'line toto' })), ['Hold The Line']);
  assert.deepEqual(titles(cat.table({ q: 'zzz' })), []);
  // With the browse filters.
  assert.deepEqual(titles(cat.table({ filter: { genres: ['Rock'] }, sort: 'year', dir: 'desc' })), ['Call Me', 'Bohemian Rhapsody', 'Help']);
  assert.deepEqual(titles(cat.table({ filter: { decades: [1970, 1980] }, q: 'toto', sort: 'title' })), ['Africa'], 'Hold The Line has no year');
  // Pages: the same sorted list.
  const all = titles(cat.table({ sort: 'title' }));
  const pages = [0, 3, 6].flatMap((offset) => titles(cat.table({ sort: 'title', limit: 3, offset })));
  assert.deepEqual(pages, all);
  assert.equal(cat.table({ sort: 'title', limit: 3 }).total, 7);
});

test('the sorted lists follow the metadata and the plays', () => {
  const cat = build();
  assert.equal(titles(cat.table({ sort: 'year' })).at(-1), 'Hold The Line');
  META['Hold The Line'] = { year: 1950, genre: 'Rock' };
  cat.metaChanged(); // (the artwork service calls it when song information arrives)
  assert.equal(titles(cat.table({ sort: 'year' }))[0], 'Hold The Line');
  delete META['Hold The Line'];
});

test('/api/library/songs: host only; sort, direction, text and filters from the address', async () => {
  const lib = await tmpDir('ok-lib-');
  const files = {};
  for (const name of NAMES) {
    const artist = name.split(' - ')[0];
    files[`${artist[0]}/${artist}/${name}.cdg`] = Buffer.alloc(7200 * 10);
    files[`${artist[0]}/${artist}/${name}.mp3`] = Buffer.alloc(100);
  }
  await writeTree(lib, files);
  const app = await createApp({ dataDir: await tmpDir('ok-data-'), args: { library: [lib] }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  await app.library.scan();
  await app.listen(0, '127.0.0.1');
  try {
    const cat = app.library.catalog;
    const titleOf = new Map(cat.songList.map((s) => [s.key, s.title]));
    cat.metaFor = (key) => META[titleOf.get(key)] || null;
    cat.metaChanged();
    const get = (p) => fetch(`http://127.0.0.1:${app.port}${p}`);
    const json = async (p) => {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      return r.json();
    };
    const r = await json('/api/library/songs?sort=year&dir=desc&limit=2');
    assert.equal(r.total, 7);
    assert.deepEqual(titles(r), ['Hello', 'Africa']);
    assert.deepEqual([r.items[0].labels[0], r.items[0].genre, r.items[0].plays, r.items[0].year], ['SF', 'Pop', 0, 2015]);
    assert.deepEqual(titles(await json('/api/library/songs?sort=title&q=toto')), ['Africa', 'Hold The Line']);
    assert.deepEqual(titles(await json('/api/library/songs?sort=title&genre=Rock&decade=1970&decade=1980')), ['Bohemian Rhapsody', 'Call Me']);
    assert.deepEqual(titles(await json('/api/library/songs?sort=nonsense&dir=sideways&limit=1')), ['Waterloo'], 'odd values: A–Z by artist');

    // Not for guests (or anyone else without the host's trust).
    app.settings.update({ party: { trustLocalhost: false } });
    assert.equal((await get('/api/library/songs')).status, 403);
  } finally {
    await app.close();
  }
});
