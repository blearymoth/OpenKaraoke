// Matching songs and artists to provider entries: placeholders, band names that the catalog
// splits into performers, surname credits, and junk words that are also real names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PROVIDERS, placeholderRef } from '../server/artwork/providers.js';
import { songQuery, scoreCandidate, artistSimilarity, pickArtist, pickBest, rankCandidates, artistSearchName, MIN_CONFIDENCE } from '../server/artwork/match.js';
import { ArtworkService } from '../server/artwork/service.js';
import { Settings } from '../server/config.js';
import { Catalog } from '../server/library/catalog.js';
import { hash32 } from '../shared/text.js';
import { tmpDir, rawTracks } from './helpers.js';
import { fakeArtFetch } from './fake-art.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'artwork');
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(FIX, `${name}.json`), 'utf8'));
const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const { deezer } = PROVIDERS;

const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const dzEmpty = (kind) => `dz:https://e-cdns-images.dzcdn.net/images/${kind}/${EMPTY_MD5}/1000x1000-000000-80-0-0.jpg`;
// What the fake TheAudioDB answers for an artist name.
const tadb = (name, file) => `tadb:https://r2.theaudiodb.com/images/media/artist/${hash32(name).toString(36)}/${file}`;

/** An artwork service over a catalog of `names`; `meta(catalog)` is written as meta.json first. */
async function makeService(names, { fetch = fakeArtFetch(), meta } = {}) {
  const dataDir = await tmpDir('ok-art-match-');
  if (meta) {
    const data = meta(new Catalog().load(rawTracks(names)));
    await fs.writeFile(path.join(dataDir, 'meta.json'), JSON.stringify({ version: 1, songs: {}, artists: {}, albums: {}, ...data }));
  }
  const settings = new Settings(dataDir);
  settings.update({ artwork: { crawl: false } });
  const library = new EventEmitter();
  library.catalog = new Catalog().load(rawTracks(names));
  const art = new ArtworkService({ dataDir, settings, library, fetch, crawlDelayMs: 5 });
  await art.init({ crawl: false });
  const song = (title) => [...library.catalog.songs.values()].find((s) => s.title === title);
  const artist = (name) => library.catalog.artistList.find((a) => a.name === name);
  return { art, library, song, artist, fetch };
}

/** Names searched for, in order: TheAudioDB (?s=) or Deezer's artist search (?q=). */
const searched = (fetch, provider) => fetch.calls
  .map((u) => new URL(u))
  .filter((u) => (provider === 'theaudiodb' ? u.hostname === 'www.theaudiodb.com' : u.pathname === '/search/artist'))
  .map((u) => u.searchParams.get(provider === 'theaudiodb' ? 's' : 'q'));

// ---- Deezer's "no picture" placeholders -------------------------------------------------------------

test('deezer: "no picture" placeholders (empty id or MD5 of "") are not pictures or covers', async () => {
  const artists = deezer.parseArtists(await fixture('deezer-search-artist'));
  assert.equal(artists[1].picture, null, 'images/artist//…');
  assert.equal(artists[2].name, 'Frank Turner');
  assert.equal(artists[2].picture, null, `images/artist/${EMPTY_MD5}/…`);
  assert.match(artists[0].picture, /^dz:/);
  const [t] = deezer.parseSongs(await fixture('deezer-search-nophoto'));
  assert.equal(t.title, 'Smooth Operator');
  assert.equal(t.cover, null);
  assert.equal(t.artistPicture, null);
  assert.equal(placeholderRef(dzEmpty('cover')), true);
  assert.equal(placeholderRef(dzEmpty('artist')), true);
  assert.equal(placeholderRef('dz:https://e-cdns-images.dzcdn.net/images/artist//250x250-000000-80-0-0.jpg'), true);
  assert.equal(placeholderRef('dz:https://e-cdns-images.dzcdn.net/images/cover/4f3c1a9e2b7d5c8a0e6f1b2d3c4a5e6f/1000x1000-000000-80-0-0.jpg'), false);
  assert.equal(placeholderRef('tadb:https://r2.theaudiodb.com/images/a.jpg'), false);
  assert.equal(placeholderRef(null), false);
});

test('service: a Deezer match with only placeholders is a miss; other providers get their turn', async () => {
  const nophoto = await fixture('deezer-search-nophoto');
  const fetch = fakeArtFetch({
    override: (u) => {
      if (u.hostname !== 'api.deezer.com') return undefined;
      if (u.pathname === '/search') return json(nophoto);
      if (u.pathname === '/search/artist') return json({ data: [{ id: 1520, name: 'Sade', picture_xl: dzEmpty('artist').slice(3), type: 'artist' }], total: 1 });
      return undefined;
    },
  });
  const { art, song, artist } = await makeService(['Sade - Smooth Operator [SF Karaoke]'], { fetch });
  const s = song('Smooth Operator');
  assert.equal(await art.request('song', s, 'now'), false);
  const e = art.songs.get(s.key);
  assert.equal(e.cover, undefined);
  assert.deepEqual(e.tried, ['deezer', 'musicbrainz'], 'the Cover Art Archive was asked after Deezer');
  const a = artist('Sade');
  assert.equal(art.artists.get(a.key)?.picture, undefined, 'the track’s silhouette is not kept');
  assert.deepEqual(art.artistChain(a.key), ['deezer', 'theaudiodb']);
  assert.equal(await art.request('artist', a, 'now'), true);
  assert.equal(art.artists.get(a.key).picture, tadb('Sade', 'thumb.jpg'), 'TheAudioDB’s picture, not Deezer’s silhouette');
  await art.close();
});

test('service: placeholders saved by an older version are dropped on load and looked up again', async () => {
  const names = ['Sade - Smooth Operator [SF Karaoke]', 'Sade - No Ordinary Love [SF Karaoke]'];
  const now = Date.now();
  const { art, song, artist } = await makeService(names, {
    meta: (catalog) => {
      const [a, b] = catalog.songList;
      return {
        songs: {
          [a.key]: { p: 'deezer', id: '1', cover: dzEmpty('cover'), album: 'Diamond Life', year: 1984, genre: 'Pop', confidence: 1, at: now, v: 1 },
          [b.key]: { p: 'deezer', id: '2', cover: dzEmpty('cover'), manual: true, confidence: 1, at: now, v: 1 },
        },
        artists: { sade: { picture: dzEmpty('artist'), tried: ['deezer', 'theaudiodb'], genre: 'Soul & Funk', at: now, v: 1 } },
      };
    },
  });
  const smooth = song('Smooth Operator');
  const e = art.songs.get(smooth.key);
  assert.equal(e.cover, undefined);
  assert.equal(e.miss, true);
  assert.equal(e.year, 1984, 'year and genre are kept meanwhile');
  assert.deepEqual(art.songChain(smooth.key), ['deezer', 'musicbrainz'], 'looked up again');
  assert.equal(art.songs.get(song('No Ordinary Love').key).cover, dzEmpty('cover'), 'the host’s own choice is left alone');
  const a = art.artists.get(artist('Sade').key);
  assert.equal(a.picture, undefined);
  assert.equal(a.genre, 'Soul & Funk');
  assert.deepEqual(art.artistChain('sade'), ['deezer', 'theaudiodb']);
  await art.close();
});

// ---- credits ------------------------------------------------------------------------------------------------

test('matching: duos credited by surname, number words, and names that only look alike', () => {
  const rich = songQuery({ artist: 'Hall & Oates', title: 'Rich Girl' });
  assert.ok(scoreCandidate({ artist: 'Daryl Hall & John Oates', title: 'Rich Girl' }, rich) >= MIN_CONFIDENCE);
  assert.ok(artistSimilarity('Daryl Hall & John Oates', songQuery({ artist: 'Hall And Oates', title: 'x' })) >= 0.75);
  assert.ok(artistSimilarity('Hall & Oates', songQuery({ artist: 'Daryl Hall & John Oates', title: 'x' })) >= 0.75, 'either way round');
  assert.ok(artistSimilarity('Paul Simon & Art Garfunkel', songQuery({ artist: 'Simon & Garfunkel', title: 'x' })) >= 0.75);
  assert.ok(artistSimilarity('The Jackson 5', songQuery({ artist: 'Jackson Five', title: 'x' })) >= 0.75);
  assert.ok(artistSimilarity('Queen Latifah', songQuery({ artist: 'Queen', title: 'x' })) < 0.75);
  assert.ok(artistSimilarity('John Oates', songQuery({ artist: 'Oates', title: 'x' })) < 0.75);
  assert.ok(artistSimilarity('Daryl Hall & John Oates & Friends', songQuery({ artist: 'Hall & Oates', title: 'x' })) < 0.75, 'same number of performers');
  assert.ok(artistSimilarity('Daryl Hall', songQuery({ artist: 'Hall & Oates', title: 'x' })) < 0.75);
  assert.equal(pickArtist([{ name: 'Daryl Hall' }, { name: 'Daryl Hall & John Oates' }], 'Hall & Oates').name, 'Daryl Hall & John Oates');
  assert.equal(pickArtist([{ name: 'The Jackson 5' }], 'Jackson Five').name, 'The Jackson 5');
  assert.equal(pickArtist([{ name: 'Elton John & Kiki Dee' }], 'Kiki Dee'), null, 'a duo is not a picture of one of them');
  assert.equal(pickArtist([{ name: 'Dave' }], 'Sam & Dave'), null);
});

test('matching: junk words in our own artist or in a real album name are no penalty', () => {
  const star = songQuery({ artist: 'Cover Girls', title: 'Wishing On A Star', duration: 250 });
  assert.ok(scoreCandidate({ artist: 'The Cover Girls', title: 'Wishing On A Star', album: 'Show Me', duration: 251 }, star) > 0.9);
  assert.ok(scoreCandidate({ artist: 'The Cover Girls', title: 'Wishing On A Star (Karaoke Version)', album: 'Show Me' }, star) < MIN_CONFIDENCE, 'other junk words still count');
  assert.ok(scoreCandidate({ artist: 'The Cover Girls', title: 'Wishing On A Star', album: 'Workout Hits' }, star) < MIN_CONFIDENCE);
  assert.ok(scoreCandidate({ artist: 'Cover Drive', title: 'Twilight', album: 'Bajan Style' }, songQuery({ artist: 'Cover Drive', title: 'Twilight' })) > 0.9);

  const hero = songQuery({ artist: 'Mariah Carey', title: 'Hero', duration: 260 });
  const original = { id: 'orig', artist: 'Mariah Carey', title: 'Hero', album: 'Music Box', duration: 259, rank: 600000 };
  const hits = { id: 'hits', artist: 'Mariah Carey', title: 'Hero', album: '#1\'s', duration: 259, rank: 700000 };
  assert.ok(scoreCandidate(original, hero) > 0.9, '"Music Box" is a real album');
  assert.equal(pickBest([hits, original], hero).candidate.id, 'orig', 'the original album beats the compilation');
  assert.ok(scoreCandidate({ artist: 'Mariah Carey', title: 'Hero (Music Box Version)', album: 'Music Box' }, hero) < MIN_CONFIDENCE);
  assert.ok(scoreCandidate({ artist: 'Mariah Carey', title: 'Hero', album: 'Music Box Versions of Mariah Carey' }, hero) < MIN_CONFIDENCE);
  assert.ok(scoreCandidate({ artist: 'Mariah Carey', title: 'Hero (Karaoke Version)', album: 'Music Box' }, hero) < MIN_CONFIDENCE);
  const box = songQuery({ artist: 'Music Box Mania', title: 'Hero' });
  assert.ok(scoreCandidate({ artist: 'Music Box Mania', title: 'Hero', album: 'Lullaby Renditions' }, box) < MIN_CONFIDENCE, 'our artist excuses only its own words');
});

test('matching: a perfect match on a compilation still ranks below the original album', () => {
  const q = songQuery({ artist: 'Queen', title: 'Bohemian Rhapsody', duration: 356 });
  const hits = { id: 'hits', artist: 'Queen', title: 'Bohemian Rhapsody', album: 'Greatest Hits', duration: 355, rank: 900000 };
  const opera = { id: 'opera', artist: 'Queen', title: 'Bohemian Rhapsody', album: 'A Night at the Opera', duration: 355, rank: 800000 };
  assert.equal(scoreCandidate(hits, q), 1, 'both are certain matches');
  assert.equal(pickBest([hits, opera], q).candidate.id, 'opera');
  assert.equal(pickBest([hits, opera], q).confidence, 1);
  assert.deepEqual(rankCandidates([hits, opera], q).map((c) => [c.id, c.confidence]), [['opera', 1], ['hits', 1]]);
});

// ---- band names split into performers ------------------------------------------------------------------

test('matching: performers never credited alone are searched by the act they belong to', () => {
  const name = (n, solo, credits) => artistSearchName({ name: n, solo }, credits);
  assert.equal(name('Dave', 0, ['Sam & Dave', 'Sam & Dave']), 'Sam & Dave');
  assert.equal(name('Earth', 0, ['Earth, Wind & Fire', 'Earth, Wind & Fire feat. The Emotions']), 'Earth, Wind & Fire');
  assert.equal(name('The Emotions', 0, ['Earth, Wind & Fire feat. The Emotions']), 'The Emotions', 'a whole act next to "feat."');
  assert.equal(name('Lil Jon', 0, ['DJ Snake feat. Lil Jon']), 'Lil Jon');
  assert.equal(name('The Machine', 0, ['Florence + The Machine']), 'Florence + The Machine');
  assert.equal(name('DC', 0, ['AC/DC']), 'AC/DC');
  assert.equal(name('Kiki Dee', 0, ['Elton John & Kiki Dee']), 'Elton John & Kiki Dee');
  assert.equal(name('Elton John', 2, ['Elton John & Kiki Dee', 'Elton John']), 'Elton John', 'credited alone somewhere');
  assert.equal(name('The Heartbreakers', 0, ['Tom Petty & The Heartbreakers', 'Tom Petty & The Heartbreakers', 'Stevie Nicks & The Heartbreakers']), 'Tom Petty & The Heartbreakers', 'the most common act');
  assert.equal(name('Nobody', 0, []), 'Nobody');
});

const BANDS = [
  'Sam & Dave - Soul Man [SF Karaoke]',
  'Sam & Dave - Hold On Im Comin [SC Karaoke]',
  'Earth, Wind & Fire - September [SF Karaoke]',
  'DJ Snake feat. Lil Jon - Turn Down For What [SF Karaoke]',
  'Elton John & Kiki Dee - True Love [SF Karaoke]',
  'Elton John - Rocket Man [SF Karaoke]',
];

test('service: artists split out of a band name get the band’s art, never a namesake’s', async () => {
  const { art, library, song, artist, fetch } = await makeService(BANDS);
  const soulMan = song('Soul Man');
  assert.deepEqual(soulMan.artistKeys, ['sam', 'dave']);
  assert.equal(artist('Dave').solo, 0);
  // The TV asks for everything about the current song's artists.
  art.focus([soulMan]);
  const lookups = soulMan.artistKeys.map((k) => art.request('artist', library.catalog.artist(k), 'now', 'all'));
  assert.deepEqual(await Promise.all(lookups), [true, true]);
  assert.deepEqual(searched(fetch, 'deezer'), ['Sam & Dave'], 'one Deezer search for both, never "Dave"');
  assert.deepEqual(searched(fetch, 'theaudiodb'), ['Sam & Dave'], 'one TheAudioDB search for both, never "Dave"');
  const out = art.artFor(soulMan);
  assert.deepEqual(art.artists.get(out.fanart).fanart, [tadb('Sam & Dave', 'fanart1.jpg'), tadb('Sam & Dave', 'fanart2.jpg')]);
  assert.equal(art.artists.get(out.logo).logo, tadb('Sam & Dave', 'logo.png'));
  for (const k of soulMan.artistKeys) assert.equal(art.artists.get(k).n, 'Sam & Dave');

  await Promise.all(song('September').artistKeys.map((k) => art.request('artist', library.catalog.artist(k), 'now', 'all')));
  assert.deepEqual(searched(fetch, 'theaudiodb'), ['Sam & Dave', 'Earth, Wind & Fire']);
  assert.equal(art.artists.get('wind').logo, tadb('Earth, Wind & Fire', 'logo.png'));

  // A featured artist is a whole act of its own: searched by name.
  assert.equal(await art.request('artist', artist('Lil Jon'), 'now', 'all'), true);
  assert.equal(art.artists.get('liljon').logo, tadb('Lil Jon', 'logo.png'));

  // The library changes and "Dave" now also sings alone: what was found for Sam & Dave goes.
  library.catalog = new Catalog().load(rawTracks([...BANDS, 'Dave - Location [SF Karaoke]']));
  art.installMeta();
  assert.equal(art.artists.get('dave').fanart, undefined);
  assert.deepEqual(art.artistChain('dave', 'all'), ['deezer', 'theaudiodb']);
  assert.equal(art.artists.get('sam').n, 'Sam & Dave', 'Sam is still only credited with Dave');
  await art.close();
});

test('service: pictures from matched songs go to the artists the track is credited to', async () => {
  const { art, song, artist } = await makeService(BANDS);
  assert.equal(await art.request('song', song('Soul Man'), 'now'), true);
  const sam = art.artists.get('sam');
  assert.match(sam.picture, /^dz:/);
  assert.equal(sam.pictureFrom, 'song');
  assert.equal(art.artists.get('dave').picture, sam.picture, 'the duo’s picture for both');

  // Deezer credits the duet to "Elton John & Kiki Dee": that is not a picture of Elton John.
  assert.equal(await art.request('song', song('True Love'), 'now'), true);
  assert.match(art.artists.get('kikidee').picture, /^dz:/);
  assert.equal(art.artists.get('eltonjohn')?.picture, undefined);
  assert.equal(await art.request('song', song('Rocket Man'), 'now'), true);
  const elton = art.artists.get(artist('Elton John').key).picture;
  assert.match(elton, /^dz:/);
  assert.notEqual(elton, art.artists.get('kikidee').picture);
  await art.close();
});

test('service: art found for a band member’s own name by an older version is dropped on load', async () => {
  const now = Date.now();
  const rapper = (f) => `tadb:https://r2.theaudiodb.com/images/media/artist/dave-rapper/${f}`;
  const { art, song, fetch } = await makeService(BANDS, {
    meta: () => ({
      artists: {
        // searched for "Dave" alone: the UK rapper's pictures
        dave: { picture: rapper('thumb.jpg'), fanart: [rapper('fanart.jpg')], logo: rapper('logo.png'), mbid: '11111111-2222-4333-8444-555555555555', genre: 'Rap/Hip Hop', tried: ['deezer', 'theaudiodb'], at: now, v: 1 },
        // only a picture that came with a matched song: kept
        sam: { picture: 'dz:https://e-cdns-images.dzcdn.net/images/artist/0123456789abcdef0123456789abcdef/1000x1000-000000-80-0-0.jpg', at: now, v: 1 },
        // searched for "Wind" after a song gave it a picture: the song's picture stays
        wind: { picture: 'dz:https://e-cdns-images.dzcdn.net/images/artist/abcdefabcdefabcdefabcdefabcdefab/1000x1000-000000-80-0-0.jpg', pictureFrom: 'song', n: 'Wind', fanart: [rapper('wind.jpg')], tried: ['theaudiodb'], at: now, v: 2 },
        // a solo artist searched for its own name: kept
        eltonjohn: { picture: tadb('Elton John', 'thumb.jpg'), fanart: [tadb('Elton John', 'fanart1.jpg')], tried: ['deezer', 'theaudiodb'], at: now, v: 1 },
      },
    }),
  });
  assert.deepEqual(art.artists.get('dave'), {});
  assert.match(art.artists.get('sam').picture, /0123456789abcdef/);
  assert.deepEqual(Object.keys(art.artists.get('wind')).sort(), ['at', 'picture', 'pictureFrom', 'v']);
  assert.deepEqual(art.artists.get('eltonjohn').fanart, [tadb('Elton John', 'fanart1.jpg')]);
  const soulMan = song('Soul Man');
  assert.equal(art.artFor(soulMan).fanart, undefined, 'the rapper’s fanart is gone from the TV');
  assert.equal(await art.request('artist', art.catalog.artist('dave'), 'now', 'all'), true);
  assert.equal(art.artFor(soulMan).fanart, 'dave');
  assert.deepEqual(art.artists.get('dave').fanart, [tadb('Sam & Dave', 'fanart1.jpg'), tadb('Sam & Dave', 'fanart2.jpg')]);
  assert.ok(!searched(fetch, 'theaudiodb').includes('Dave'));
  await art.close();
});
