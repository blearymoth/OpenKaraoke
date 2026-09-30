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
