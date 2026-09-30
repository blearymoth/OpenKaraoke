#!/usr/bin/env node
// Checks the artwork providers against the live APIs: one request each, what the parsers make
// of it, and which expected fields are missing. Run it on a machine with internet access.
//
//   node scripts/artwork-check.js [--save <dir>] [--artist "Queen" --title "Bohemian Rhapsody"]
//                                 [--band "Coldplay"] [--fanart-key <key>] [--itunes]
//
// --save writes the raw responses (same names as test/fixtures/artwork/*.json) so the
// hand-made fixtures can be replaced with real captures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROVIDERS, USER_AGENT, imageUrls, allowedImageUrl } from '../server/artwork/providers.js';
import { songQuery, rankCandidates, pickArtist } from '../server/artwork/match.js';
import { VERSION } from '../server/config.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const saveDir = opt('save', '');
const artist = opt('artist', 'Queen');
const title = opt('title', 'Bohemian Rhapsody');
const band = opt('band', 'Coldplay');
const fanartKey = opt('fanart-key', '');
const withItunes = args.includes('--itunes');
const UA = USER_AGENT(VERSION);
let problems = 0;

const say = (...a) => console.log(...a);
const bad = (msg) => {
  problems++;
  say(`  ✘ ${msg}`);
};
const good = (msg) => say(`  ✔ ${msg}`);

async function get(url, name) {
  say(`\n→ ${url}`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    bad(`request failed: ${e.cause?.code || e.message}`);
    return null;
  }
  const text = await res.text();
  say(`  HTTP ${res.status} in ${Date.now() - t0} ms, ${text.length} bytes`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    bad('not JSON');
    return null;
  }
  if (saveDir && name) {
    await fs.mkdir(saveDir, { recursive: true });
    await fs.writeFile(path.join(saveDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
    say(`  saved ${path.join(saveDir, `${name}.json`)}`);
  }
  return json;
}

function expectFields(obj, fields, where) {
  if (!obj || typeof obj !== 'object') return bad(`${where}: missing`);
  const missing = fields.filter((f) => !(f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) !== undefined));
  if (missing.length) bad(`${where}: missing fields ${missing.join(', ')}`);
  else good(`${where}: ${fields.length} expected fields present`);
}

async function checkImage(ref, label) {
  const urls = imageUrls(ref);
  if (!urls) return bad(`${label}: no image`);
  const url = urls.s;
  if (!allowedImageUrl(url)) return bad(`${label}: host not on the allow-list: ${url}`);
  try {
    let current = url;
    let res;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      current = new URL(loc, current).href;
      if (!allowedImageUrl(current)) return bad(`${label}: redirects to a host that is not on the allow-list: ${current}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.ok && buf.length > 100) good(`${label}: ${res.headers.get('content-type')} ${buf.length} bytes from ${new URL(current).hostname}`);
    else bad(`${label}: HTTP ${res.status}, ${buf.length} bytes`);
  } catch (e) {
    bad(`${label}: ${e.message}`);
  }
}

const q = songQuery({ artist, title, duration: 0 });
say(`OpenKaraoke ${VERSION} artwork check — "${title}" by ${artist}, artist "${band}"`);

// Deezer
say('\n== Deezer');
const dz = await get(PROVIDERS.deezer.songUrls(q)[0], 'deezer-search-queen-bohemian');
if (dz) {
  const err = PROVIDERS.deezer.apiError(dz);
  if (err) bad(`API error: ${err.message}`);
  expectFields(dz.data?.[0], ['id', 'title', 'title_short', 'title_version', 'duration', 'rank', 'explicit_lyrics', 'md5_image', 'artist.name', 'artist.picture_xl', 'album.id', 'album.title', 'album.cover_xl'], 'track');
  const ranked = rankCandidates(PROVIDERS.deezer.parseSongs(dz), q);
  for (const c of ranked.slice(0, 3)) say(`  ${c.confidence.toFixed(2)}  ${c.artist} — ${c.title} ${c.version} [${c.album}]`);
  if (ranked[0]?.cover) await checkImage(ranked[0].cover, 'cover');
  if (ranked[0]?.albumId) {
    const album = await get(PROVIDERS.deezer.albumUrl(ranked[0].albumId), 'deezer-album');
    expectFields(album, ['genre_id', 'genres.data', 'release_date', 'record_type', 'label'], 'album');
    say(`  parsed: ${JSON.stringify(PROVIDERS.deezer.parseAlbum(album))}`);
  }
}
const dzArtist = await get(PROVIDERS.deezer.artistUrls(band)[0], 'deezer-search-artist');
if (dzArtist) {
  expectFields(dzArtist.data?.[0], ['id', 'name', 'picture_xl'], 'artist');
  const a = pickArtist(PROVIDERS.deezer.parseArtists(dzArtist), band);
  if (a?.picture) await checkImage(a.picture, 'artist picture');
  else bad('no matching artist with a picture');
}

// MusicBrainz + Cover Art Archive
say('\n== MusicBrainz + Cover Art Archive');
const mb = await get(PROVIDERS.musicbrainz.songUrls(q)[0], 'musicbrainz-recording-search');
if (mb) {
  expectFields(mb.recordings?.[0], ['id', 'title', 'length', 'artist-credit', 'first-release-date', 'releases'], 'recording');
  const ranked = rankCandidates(PROVIDERS.musicbrainz.parseSongs(mb), q);
  for (const c of ranked.slice(0, 3)) say(`  ${c.confidence.toFixed(2)}  ${c.artist} — ${c.title} [${c.album}] ${c.year || ''} covers: ${c.covers.length}`);
  if (ranked[0]?.covers?.[0]) await checkImage(ranked[0].covers[0], 'Cover Art Archive front');
}

// TheAudioDB
say('\n== TheAudioDB');
const tadb = await get(PROVIDERS.theaudiodb.artistUrls(band, { key: '123' })[0], 'theaudiodb-artist');
if (tadb) {
  expectFields(tadb.artists?.[0], ['idArtist', 'strArtist', 'strArtistThumb', 'strArtistLogo', 'strArtistFanart', 'strMusicBrainzID', 'strGenre'], 'artist');
  const a = pickArtist(PROVIDERS.theaudiodb.parseArtists(tadb), band);
  if (a) {
    say(`  parsed: picture ${!!a.picture}, fanart ${a.fanart.length}, logo ${!!a.logo}, cutout ${!!a.cutout}, mbid ${a.mbid || '—'}, genre ${a.genre}`);
    if (a.fanart[0]) await checkImage(a.fanart[0], 'fanart (/small)');
    if (fanartKey && a.mbid) {
      say('\n== Fanart.tv');
      const ftv = await get(PROVIDERS.fanarttv.artistUrl(a.mbid, fanartKey), 'fanarttv-artist');
      const f = PROVIDERS.fanarttv.parseArtist(ftv);
      say(`  parsed: fanart ${f?.fanart.length || 0}, logo ${!!f?.logo}`);
      if (f?.fanart[0]) await checkImage(f.fanart[0], 'fanart.tv background');
    }
  } else {
    bad('no matching artist');
  }
}

if (withItunes) {
  say('\n== iTunes');
  const it = await get(PROVIDERS.itunes.songUrls(q)[0], 'itunes-search');
  if (it) {
    expectFields(it.results?.[0], ['trackId', 'trackName', 'artistName', 'collectionName', 'artworkUrl100', 'releaseDate', 'primaryGenreName', 'trackExplicitness', 'trackTimeMillis'], 'result');
    const ranked = rankCandidates(PROVIDERS.itunes.parseSongs(it), q);
    if (ranked[0]?.cover) await checkImage(ranked[0].cover, 'artwork 250');
  }
}

say(problems ? `\n${problems} problem(s) found — see ✘ above.` : '\nAll providers look fine.');
process.exitCode = problems ? 1 : 0;
