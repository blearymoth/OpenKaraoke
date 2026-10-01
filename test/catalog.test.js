import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../server/library/catalog.js';
import { rawTracks } from './helpers.js';

const NAMES = [
  'Adele - Someone Like You [SF Karaoke]',
  'Adele - Someone Like You [#Z Karaoke]',
  'Adele - Someone Like Yo [KV Karaoke]', // truncated title -> same song
  'Adele - Someone Like You (Live) [EZ Karaoke]',
  'Adele - Hello [SF Karaoke]',
  'Adele - Hello [DC Karaoke]',
  'Alanis Morissette - Ironic [SF Karaoke]',
  'Alanis Morissette - Ironic [SC Karaoke]',
  'Alanis Morissette - You Oughta Know [SF Karaoke]',
  'Alanis Morissette - Hand In My Pocket [SF Karaoke]',
  'Alanis Morisette - Ironic [CB Karaoke]', // artist typo -> same artist
  'Queen - Bohemian Rhapsody [SF Karaoke]',
  'Queen - Bohemian Rhapsody [SC Karaoke]',
  'Queen - Killer Queen [SF Karaoke]',
  'Queen & David Bowie - Under Pressure [SF Karaoke]',
  'Lionel Richie - Hello [SC Karaoke]',
  'Alesso Feat. Tove Lo - Heroes [SF Karaoke]',
  'Alesso & Tove Lo - Heroes (We Could Be) [KV Karaoke]',
  'Juanes - La Camisa Negra [Spanish Karaoke]',
];

function build() {
  return new Catalog().load(rawTracks(NAMES), ['/library']);
}

test('groups label versions into songs', () => {
  const cat = build();
  assert.equal(cat.tracks.size, NAMES.length);
  const someone = cat.search('someone like you').items[0];
  assert.equal(someone.artist, 'Adele');
  assert.equal(someone.title, 'Someone Like You');
  assert.equal(someone.versions, 4);
  const heroes = cat.search('heroes').items[0];
  assert.equal(heroes.versions, 2);
});

test('clusters artist spelling variants', () => {
  const cat = build();
  const ironic = cat.search('ironic').items[0];
  assert.equal(ironic.artist, 'Alanis Morissette');
  assert.equal(ironic.versions, 3);
  const artists = cat.listArtists({ q: 'alanis' }).items;
  assert.equal(artists.length, 1);
});

test('search ranks exact artist matches and tolerates typos', () => {
  const cat = build();
  const queen = cat.search('queen').items;
  assert.equal(queen[0].artist, 'Queen');
  assert.equal(queen[0].title, 'Bohemian Rhapsody');
  const fuzzy = cat.search('bohemain rapsody');
  assert.ok(fuzzy.items.some((s) => s.title === 'Bohemian Rhapsody'));
  assert.equal(cat.search('').total, 0);
});

test('collaborations appear on each artist page', () => {
  const cat = build();
  const bowie = cat.listArtists({ q: 'bowie' }).items[0];
  assert.ok(bowie);
  const songs = cat.songsOfArtist(bowie.key).map((s) => s.title);
  assert.deepEqual(songs, ['Under Pressure']);
  const queen = cat.listArtists({ q: 'queen' }).items.find((a) => a.name === 'Queen');
  assert.equal(cat.songsOfArtist(queen.key).length, 3);
});

test('tags, filters, details and best version', () => {
  const cat = build();
  assert.ok(cat.tagCounts.some((t) => t.tag === 'Spanish'));
  assert.equal(cat.byTag('Spanish').items[0].title, 'La Camisa Negra');
  const s = cat.search('someone like you').items[0];
  const detail = cat.songDetail(s.id);
  assert.equal(detail.versions.length, 4);
  assert.equal(detail.versions.at(-1).variant, 'Live'); // variants listed last
  const best = cat.bestTrack(s, ['#Z']);
  assert.equal(best.p.brand, '#Z');
  const noLive = cat.bestTrack(s, []);
  assert.equal(noLive.p.variant.length, 0);
});

test('cache round trip keeps ids stable', () => {
  const cat = build();
  const cache = JSON.parse(JSON.stringify(cat.toCache()));
  const again = new Catalog().load(Catalog.rawFromCache(cache), ['/library']);
  assert.deepEqual([...again.songs.keys()].sort(), [...cat.songs.keys()].sort());
  assert.deepEqual([...again.tracks.keys()].sort(), [...cat.tracks.keys()].sort());
  const t = [...again.tracks.values()][0];
  assert.ok(t.audio.endsWith('.mp3'));
  assert.ok(t.cdg.endsWith('.cdg'));
});

test('random and popular respect filters', () => {
  const cat = build();
  const r = cat.random(3, { tag: 'Spanish' });
  assert.equal(r.length, 1);
  const pop = cat.popular({ limit: 3 }).items;
  assert.equal(pop.length, 3);
  assert.ok(pop[0].versions >= pop[2].versions);
});

test('popularity order: same as sorting by popularity (ties keep the catalogue order)', () => {
  const names = [];
  for (let i = 0; i < 3000; i++) {
    const versions = 1 + (i % 3);
    for (let v = 0; v < versions; v++) names.push(`Artist ${i % 400} - Song Number ${i} [${['SF', 'SC', 'ZM'][v]} Karaoke]`);
  }
  const cat = new Catalog().load(rawTracks(names), ['/library']);
  const meta = new Map();
  cat.songList.forEach((s, i) => { if (i % 3) meta.set(s.key, { rank: (i * 7919) % 900000, cover: i % 2 ? 'dz:x' : '', explicit: i % 11 === 0, genre: i % 4 ? 'Pop' : 'Rock' }); });
  cat.metaFor = (k) => meta.get(k) || null;
  cat.plays = new Map([[cat.songList[10].id, 20]]);
  cat.metaChanged();
  const expected = [...cat.songList].sort((a, b) => cat.popularity(b) - cat.popularity(a));
  assert.deepEqual(cat.popularList().map((s) => s.id), expected.map((s) => s.id));
  assert.equal(cat.popularList()[0].id, cat.songList[10].id, 'plays count most');
  // Filters keep that order, also for filterSongs and topSongs.
  const rock = cat.popular({ limit: 5000, filter: { genre: 'Rock' } }).items;
  assert.deepEqual(rock.map((s) => s.id), expected.filter((s) => meta.get(s.key)?.genre === 'Rock').map((s) => s.id));
  assert.deepEqual(cat.filterSongs({ genre: 'Rock' }, { limit: 5000 }).items, rock);
  assert.deepEqual(cat.topSongs(7, { hasArt: true, noExplicit: true }).map((s) => s.id),
    expected.filter((s) => meta.get(s.key)?.cover && !meta.get(s.key)?.explicit).slice(0, 7).map((s) => s.id));
  // Odd metadata (a NaN popularity) doesn't lose songs.
  meta.set(cat.songList[0].key, { rank: 'lots' });
  cat.metaChanged();
  assert.equal(new Set(cat.popularList()).size, cat.songList.length);
});

test('filtered popular lists are cached for paging and rebuilt when the metadata changes', () => {
  const cat = build();
  const meta = new Map();
  cat.metaFor = (k) => meta.get(k) || null;
  let calls = 0;
  const passes = cat._passes.bind(cat);
  cat._passes = (s, f) => { calls++; return passes(s, f); };
  const page1 = cat.popular({ limit: 2, filter: { noExplicit: true } });
  const scans = calls;
  const page2 = cat.popular({ limit: 2, offset: 2, filter: { noExplicit: true } });
  assert.equal(calls, scans, 'the second page comes from the cache');
  assert.equal(page1.total, page2.total);
  // New metadata: the song is explicit now and leaves the filtered list.
  const hello = cat.search('adele hello').items[0];
  meta.set(hello.key, { explicit: true });
  assert.ok(cat.popular({ limit: 50, filter: { noExplicit: true } }).items.includes(hello), 'not told yet');
  cat.metaChanged();
  assert.ok(!cat.popular({ limit: 50, filter: { noExplicit: true } }).items.includes(hello));
  // Filters with a set of ids to leave out are never cached.
  const exclude = new Set([cat.popularList()[0].id]);
  assert.ok(!cat.popular({ limit: 50, filter: { exclude } }).items.some((s) => exclude.has(s.id)));
  exclude.clear();
  exclude.add(cat.popularList()[1].id);
  assert.ok(!cat.popular({ limit: 50, filter: { exclude } }).items.some((s) => exclude.has(s.id)));
});
