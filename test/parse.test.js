import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseName, artistKeyOf, titleKeyOf, extractBrand } from '../server/library/parse.js';

const cases = [
  ['Adele - Someone Like You [SF Karaoke]', { artist: 'Adele', title: 'Someone Like You', brand: 'SF' }],
  ['Fats Domino - Be My Guest [#Z Karaaoke]', { artist: 'Fats Domino', title: 'Be My Guest', brand: '#Z' }],
  ['ACDC - Big Gun [L Karaolke]', { artist: 'ACDC', title: 'Big Gun', brand: 'L' }],
  ['Tammy Wynette - Almost Persuaded CB Karaoke]', { artist: 'Tammy Wynette', title: 'Almost Persuaded', brand: 'CB' }],
  ["Baby D - (Everybody's Got To Learn Sometime) I Need Your Loving [SBI Kar", { artist: 'Baby D', brand: 'SBI' }],
  ['Bloodhound Gang - A Lap Dance Is So Much Better When The Stripper Is Crying [SC K', { brand: 'SC' }],
  ['Celine Dion - A New Day Has Come [SCKaraoke]', { title: 'A New Day Has Come', brand: 'SC' }],
  ['Smashing Pumpkins - 1979 [Karaoke]', { title: '1979', brand: '' }],
  ['SC8123-05 - Adele - Hello', { artist: 'Adele', title: 'Hello', discId: 'SC8123-05' }],
  ['AX-28794 - A Sky Full Of Stars [Coldplay]', { artist: 'Coldplay', title: 'A Sky Full Of Stars', discId: 'AX-28794' }],
  ['Adele - Hello [Reggae Version] [DC Karaoke]', { title: 'Hello (Reggae Version)', brand: 'DC' }],
  ["Ariana Grande - Break Up With Your Girlfriend, I'm Bored [Explicit] (Zoom Karao", { brand: '#Z' }],
];

for (const [input, expected] of cases) {
  test(`parseName: ${input}`, () => {
    const p = parseName(input, '');
    for (const [k, v] of Object.entries(expected)) assert.equal(p[k], v, `${k} of "${input}"`);
  });
}

test('flags and tags from annotations', () => {
  const duet = parseName('ABBA (Duet) - Take A Chance On Me [SF Karaoke]');
  assert.equal(duet.artist, 'ABBA');
  assert.equal(duet.flags.duet, true);
  assert.ok(duet.tags.includes('Duets'));

  const bgv = parseName('Anne Murray (Wbgv) - Snowbird [CB Karaoke]');
  assert.equal(bgv.artist, 'Anne Murray');
  assert.equal(bgv.flags.bgv, true);

  const explicit = parseName("Ariana Grande - Break Up With Your Girlfriend, I'm Bored [Explicit] (Zoom Karao");
  assert.equal(explicit.flags.explicit, true);
  assert.equal(explicit.title, "Break Up With Your Girlfriend, I'm Bored");

  const spanish = parseName('Juanes - La Camisa Negra [Spanish Karaoke]');
  assert.ok(spanish.tags.includes('Spanish'));

  const xmas = parseName('Mariah Carey - All I Want For Christmas Is You [SF Karaoke]');
  assert.ok(xmas.tags.includes('Christmas'));

  const medley = parseName('Blondie Medley - Atomic+ Call Me+ Dreaming+ One Way Or Another [ST');
  assert.equal(medley.flags.medley, true);

  const live = parseName('Adele - Someone Like You (Live) [EZ Karaoke]');
  assert.deepEqual(live.variant, ['Live']);
  assert.equal(live.flags.live, true);
});

test('grouping keys ignore credit order, "feat." spelling and sub-titles', () => {
  const a = parseName('Alesso Feat. Tove Lo - Heroes [SF Karaoke]');
  const b = parseName('Alesso & Tove Lo - Heroes (We Could Be) [KV Karaoke]');
  assert.equal(artistKeyOf(a.baseArtist), artistKeyOf(b.baseArtist));
  assert.equal(titleKeyOf(a.baseTitle), titleKeyOf(b.baseTitle));

  const c = parseName('Beatles, The - Yesterday [SF Karaoke]');
  const d = parseName('The Beatles - Yesterday [SC Karaoke]');
  assert.equal(artistKeyOf(c.baseArtist), artistKeyOf(d.baseArtist));
});

test('part numbers stay in the grouping key', () => {
  const p1 = parseName('Pink Floyd - Another Brick In The Wall (Part 1) [SF Karaoke]');
  const p2 = parseName('Pink Floyd - Another Brick In The Wall (Part 2) [SF Karaoke]');
  assert.notEqual(titleKeyOf(p1.baseTitle), titleKeyOf(p2.baseTitle));
});

test('folder name is used when the file name has no artist', () => {
  const p = parseName('Just A Title [SF Karaoke]', 'Some Artist');
  assert.equal(p.artist, 'Some Artist');
  assert.equal(p.title, 'Just A Title');
});

test('extractBrand returns null for titles without a label tag', () => {
  assert.equal(extractBrand('Queen - Bohemian Rhapsody'), null);
});
