// Browse filters: several decades, genres, tags and version types (OR within a filter, AND
// across filters) — the shared helpers, the catalog and /api/browse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../server/library/catalog.js';
import { createApp } from '../server/app.js';
import { readFilters, cleanFilters, filterParams, filterCount, toggleFilter, emptyFilters, MAX_FILTER_VALUES } from '../shared/filters.js';
import { rawTracks, tmpDir, writeTree } from './helpers.js';
import { offlineFetch } from './fake-art.js';

const NAMES = [
  'Adele - Hello [SF Karaoke]',
  'Adele - Hello (Multiplex) [SC Karaoke]',
  'Queen - Bohemian Rhapsody (With Backing Vocals) [SF Karaoke]',
  'Queen - Bohemian Rhapsody (No Backing Vocals) [SC Karaoke]',
  'Mariah Carey - All I Want For Christmas Is You [SF Karaoke]',
  'Elton John & Kiki Dee - Don\'t Go Breaking My Heart (Duet) [SF Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
];
// Online song information for the tests: year and genre by title.
const META = {
  Hello: { year: 2015, genre: 'Pop' },
  'Bohemian Rhapsody': { year: 1975, genre: 'Rock' },
  'All I Want For Christmas Is You': { year: 1994, genre: 'Pop' },
  "Don't Go Breaking My Heart": { year: 1976, genre: 'Pop' },
  'Call Me': { year: 1980, genre: 'Rock' },
  Clip: { year: 2001, genre: 'Dance' },
};

function build() {
  const cat = new Catalog().load([
    ...rawTracks(NAMES),
    { root: 0, dir: 'V', name: 'Video Band - Clip', kind: 'video', video: 'Video Band - Clip.mp4', size: 1000, duration: 200 },
  ], ['/library']);
  cat.metaFor = (key) => META[[...cat.songs.values()].find((s) => s.key === key)?.title] || null;
  return cat;
}
const titles = (list) => list.map((s) => s.title).sort();

test('filters from URL parameters: several values each, cleaned, sorted and capped', () => {
  const q = new URLSearchParams('decade=1990&decade=1980&decade=1985&decade=abc&decade=1980&genre=Rock&genre=%20Pop%20&tag=Duets'
    + '&version=mpx&version=video&version=__proto__&version=hack');
  assert.deepEqual(readFilters(q), { decades: [1980, 1990], genres: ['Pop', 'Rock'], tags: ['Duets'], versions: ['mpx', 'video'] });
  assert.deepEqual(readFilters(new URLSearchParams('')), emptyFilters());
  assert.deepEqual(readFilters(null), emptyFilters());
  const many = new URLSearchParams(Array.from({ length: 40 }, (_, i) => `genre=G${i}`).join('&'));
  assert.equal(readFilters(many).genres.length, MAX_FILTER_VALUES);
  assert.equal(readFilters(new URLSearchParams(`tag=${'x'.repeat(200)}`)).tags[0].length, 60);

  const f = cleanFilters({ decades: [1990, '1980', 7], tags: ['Duets', 'Duets'], versions: ['bgv', 'nope'] });
  assert.deepEqual(f, { decades: [1980, 1990], genres: [], tags: ['Duets'], versions: ['bgv'] });
  assert.deepEqual(filterParams(f), { decade: ['1980', '1990'], tag: ['Duets'], version: ['bgv'] });
  assert.equal(filterCount(f), 4);
  assert.deepEqual(toggleFilter(f, 'tags', 'Christmas').tags, ['Christmas', 'Duets']);
  assert.deepEqual(toggleFilter(f, 'decades', 1990).decades, [1980]);
  // Round trip through a URL.
  const url = new URL('http://x/api/browse/popular');
  for (const [k, vs] of Object.entries(filterParams(f))) for (const v of vs) url.searchParams.append(k, v);
  assert.deepEqual(readFilters(url.searchParams), f);
});

test('the catalog: OR within a filter, AND across filters', () => {
  const cat = build();
  const pick = (filter) => titles(cat.popular({ limit: 100, filter }).items);
  assert.deepEqual(pick({ decades: [1970] }), ['Bohemian Rhapsody', "Don't Go Breaking My Heart"]);
  assert.deepEqual(pick({ decades: [1970, 1980] }), ['Bohemian Rhapsody', 'Call Me', "Don't Go Breaking My Heart"]);
  assert.deepEqual(pick({ genres: ['Rock', 'Dance'] }), ['Bohemian Rhapsody', 'Call Me', 'Clip']);
  assert.deepEqual(pick({ decades: [1970, 1980], genres: ['Pop'] }), ["Don't Go Breaking My Heart"]);
  assert.deepEqual(pick({ tags: ['Christmas', 'Duets'] }), ['All I Want For Christmas Is You', "Don't Go Breaking My Heart"]);
  assert.deepEqual(pick({ tags: ['Christmas'], genres: ['Rock'] }), []);
  // Version types: a song passes when one of its versions has it.
  assert.deepEqual(pick({ versions: ['mpx'] }), ['Hello']);
  assert.deepEqual(pick({ versions: ['bgv'] }), ['Bohemian Rhapsody']);
  assert.deepEqual(pick({ versions: ['nobgv'] }), ['Bohemian Rhapsody']);
  assert.deepEqual(pick({ versions: ['video'] }), ['Clip']);
  assert.deepEqual(pick({ versions: ['mpx', 'video'] }), ['Clip', 'Hello']);
  assert.deepEqual(pick({ versions: ['mpx'], decades: [1970] }), []);
  // A song without online information never passes a decade or genre filter.
  cat.metaFor = () => null;
  cat.metaChanged();
  assert.deepEqual(pick({ decades: [1970] }), []);
  assert.deepEqual(pick({ tags: ['Duets'] }), ["Don't Go Breaking My Heart"], 'tags come from the file names');
});

test('facets count the songs with each version type', () => {
  const cat = build();
  assert.deepEqual(cat.facets().versions, [{ id: 'mpx', count: 1 }, { id: 'bgv', count: 1 }, { id: 'nobgv', count: 1 }, { id: 'video', count: 1 }]);
  const plain = new Catalog().load(rawTracks(['Blondie - Call Me [SC Karaoke]']), ['/library']);
  assert.deepEqual(plain.facets().versions, [], 'none: no version filters to offer');
});

test('/api/browse/popular and /api/random take the filters; facets list the version types', async () => {
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
    cat.metaFor = (key) => META[[...cat.songs.values()].find((s) => s.key === key)?.title] || null;
    cat.metaChanged();
    const get = async (p) => {
      const r = await fetch(`http://127.0.0.1:${app.port}${p}`);
      assert.equal(r.status, 200, p);
      return r.json();
    };
    const facets = await get('/api/browse/facets');
    assert.deepEqual(facets.versions.map((v) => v.id), ['mpx', 'bgv', 'nobgv']);
    assert.deepEqual(facets.decades.map((d) => d.decade), [1970, 1980, 1990, 2010]);

    const browse = async (qs) => titles((await get(`/api/browse/popular?${qs}`)).items);
    assert.deepEqual(await browse('decade=1970&decade=1980'), ['Bohemian Rhapsody', 'Call Me', "Don't Go Breaking My Heart"]);
    assert.deepEqual(await browse('decade=1970&decade=1980&genre=Rock&version=bgv'), ['Bohemian Rhapsody']);
    assert.deepEqual(await browse('tag=Christmas&tag=Duets'), ['All I Want For Christmas Is You', "Don't Go Breaking My Heart"]);
    assert.deepEqual(await browse('genre=Pop'), ['All I Want For Christmas Is You', "Don't Go Breaking My Heart", 'Hello'], 'one value, as before');
    assert.deepEqual(await browse('version=bogus'), titles(cat.songList), 'an unknown version type is ignored');
    const total = (await get('/api/browse/popular?decade=1970&decade=1980&limit=1')).total;
    assert.equal(total, 3, 'the total counts every match (the filter sheet shows it)');
    const random = await get('/api/random?n=10&version=mpx');
    assert.deepEqual(titles(random.items), ['Hello']);
  } finally {
    await app.close();
  }
});
