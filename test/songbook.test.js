import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../server/library/catalog.js';
import { songbookSongs, songbookCsv, songbookHtml } from '../server/http/songbook.js';
import { rawTracks } from './helpers.js';
import { THEMES } from '../shared/themes.js';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';

const catalog = new Catalog().load(rawTracks([
  'ABBA - Waterloo [SF Karaoke]',
  'ABBA - Dancing Queen [SF Karaoke]',
  'ABBA - Dancing Queen [SC Karaoke]',
  'The Beatles - Let It Be [SF Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
  'Queen - Killer Queen (Explicit) [SF Karaoke]',
  '=cmd|calc - "Tricky, Title" [SF Karaoke]',
  'Elton John & Kiki Dee - Don\'t Go Breaking My Heart [SF Karaoke]',
]));

test('songbook: order by artist ("The" ignored) or title, filters, popular top N', () => {
  const byArtist = songbookSongs(catalog, {}).map((s) => `${s.artist}|${s.title}`);
  assert.deepEqual(byArtist.slice(0, 4), ['ABBA|Dancing Queen', 'ABBA|Waterloo', 'The Beatles|Let It Be', 'Blondie|Call Me']);
  const byTitle = songbookSongs(catalog, { sort: 'title' }).map((s) => s.title);
  assert.equal(byTitle[0], 'Call Me');
  assert.ok(byTitle.indexOf('Dancing Queen') < byTitle.indexOf('Let It Be'));
  assert.deepEqual(songbookSongs(catalog, { letter: 'B' }).map((s) => s.artist), ['The Beatles', 'Blondie']);
  assert.ok(songbookSongs(catalog, { explicit: false }).every((s) => s.title !== 'Killer Queen'));
  assert.equal(songbookSongs(catalog, { popular: 1 })[0].title, 'Dancing Queen', 'two versions = most popular');
  assert.equal(songbookSongs(catalog, { tag: 'Duets' }).length, 1);
});

test('songbook: CSV is spreadsheet-safe; HTML escapes names and carries the join QR code', async () => {
  const songs = songbookSongs(catalog, {});
  const csv = await songbookCsv(catalog, songs);
  assert.ok(csv.startsWith('﻿Artist,Title,Versions,Length,Year,Genre,Tags\r\n'));
  assert.match(csv, /\r\n"'=cmd\|calc","""Tricky, Title""",1,/, 'formula-looking cells are neutralised and quotes escaped');
  assert.match(csv, /ABBA,Dancing Queen,2,3:\d\d,,,/);
  const html = await songbookHtml(catalog, songs, { title: 'Party <3', joinUrl: 'http://192.168.1.2:8080/j/ABCD', roomCode: 'ABCD' });
  assert.match(html, /<title>Party &lt;3 · Songbook<\/title>/);
  assert.match(html, /&quot;Tricky, Title&quot;/);
  assert.doesNotMatch(html, /<3/);
  assert.match(html, /<svg[^>]*>/);
  assert.match(html, /192\.168\.1\.2:8080\/j\/ABCD/);
  assert.match(html, /<h2>A<\/h2>/);
  assert.match(html, /<i title="Explicit">E<\/i>/);
  assert.match(html, /<i title="Duet">♥<\/i>/);
});

test('songbook: with the party hotspot on, joining its Wi-Fi is step 1', async () => {
  const songs = songbookSongs(catalog, {});
  const html = await songbookHtml(catalog, songs, { title: 'P', joinUrl: 'http://10.42.0.1:6527/j/ABCD', roomCode: 'ABCD', wifi: { ssid: 'OpenKaraoke-ABCD', password: 'pass:word;1' } });
  assert.match(html, /1 · Join the Wi-Fi <b class="url">OpenKaraoke-ABCD<\/b><br>Password <span class="pw">pass:word;1<\/span>/);
  assert.match(html, /2 · Scan to request songs/);
  assert.equal((html.match(/<svg/g) || []).length, 2, 'two QR codes');
  const plain = await songbookHtml(catalog, songs, { title: 'P', joinUrl: 'http://192.168.1.2:6527/j/ABCD', roomCode: 'ABCD' });
  assert.doesNotMatch(plain, /Join the Wi-Fi|2 · /);
});

test('songbook: a big library is built in slices, so the server keeps answering meanwhile', async () => {
  const words = ['Love', 'Night', 'Heart', 'Dance', 'Fire', 'Rain', 'Star', 'River'];
  const names = Array.from({ length: 12000 }, (_, i) => `${i % 7 ? '' : 'The '}${words[i % 8]} Band ${i % 3000} - ${words[(i * 5) % 8]} Song ${i} [SF Karaoke]`);
  const big = new Catalog().load(rawTracks(names));
  const byArtist = songbookSongs(big, {});
  assert.equal(byArtist.length, 12000);
  const key = (s) => `${s.artistFold.replace(/^the /, '')}\0${s.titleFold}`;
  assert.ok(byArtist.every((s, i) => !i || key(byArtist[i - 1]) <= key(s)), 'in artist order ("The" ignored)');
  assert.deepEqual(songbookSongs(big, {}), byArtist, 'same order from the kept sort');
  assert.equal(songbookSongs(big, { letter: 'L' }).length, byArtist.filter((s) => s.letter === 'L').length);
  for (const build of [() => songbookHtml(big, byArtist, { title: 'Big' }), () => songbookCsv(big, byArtist)]) {
    let turns = 0;
    let building = true;
    const spin = () => { if (building) { turns++; setImmediate(spin); } };
    setImmediate(spin);
    const text = await build();
    building = false;
    assert.ok(text.length > 12000 * 10);
    assert.ok(turns >= 4, `the event loop turned ${turns} times during the build`);
  }
});

test('songbook endpoint: host only, HTML or CSV download', async () => {
  const { app } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const html = await fetch(`${base}/api/export/songbook?popular=5&columns=2`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const text = await html.text();
    assert.match(text, /column-count: 2/);
    assert.equal((text.match(/<li>/g) || []).length, 5);
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`${base}/api/export/songbook?sort=title`).then((r) => r.text())));
    assert.equal(a, b, 'two clicks at once: one book');
    assert.equal((a.match(/<p class="t">/g) || []).length, app.library.catalog.songList.length);
    const csv = await fetch(`${base}/api/export/songbook?format=csv`);
    assert.match(csv.headers.get('content-disposition'), /songbook\.csv/);
    assert.equal((await csv.text()).trim().split('\r\n').length, 1 + app.library.catalog.songList.length);
    app.auth.isHostRequest = () => false; // a phone on the LAN
    app.settings.update({ party: { adminPin: '1234' } });
    assert.equal((await fetch(`${base}/api/export/songbook`)).status, 401);
  } finally {
    await app.close();
  }
});

test('songbook: the toolbar and headings follow the skin; Party prints as it always did', async () => {
  const songs = songbookSongs(catalog, {});
  const party = await songbookHtml(catalog, songs, { title: 'P', appearance: { theme: 'party', accent: '' } });
  // the exact rules the songbook had before skins existed
  assert.ok(party.includes("header h1 { font: 800 22pt/1 'Bricolage', 'Figtree', system-ui, sans-serif; margin: 0; flex: 1; }"));
  assert.ok(party.includes("section.letter h2 { font: 800 15pt/1 'Bricolage', system-ui, sans-serif; margin: 6px 0 3px;"));
  assert.ok(party.includes('.toolbar { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: #150f26; color: #fff; font: 14px system-ui, sans-serif; }'));
  assert.ok(party.includes('.toolbar button { font: inherit; font-weight: 700; padding: 8px 16px; border: 0; border-radius: 99px; background: #ff3d8b; color: #fff; cursor: pointer; }'));

  const studio = await songbookHtml(catalog, songs, { title: 'S' });
  assert.doesNotMatch(studio, /Bricolage/, 'Studio headings are Figtree');
  assert.ok(studio.includes(`background: ${THEMES.studio.themeColor}; color: #fff; font: 14px 'Figtree', system-ui, sans-serif; }`), 'Studio toolbar');
  assert.ok(studio.includes(`border-radius: 10px; background: ${THEMES.studio.accent}; color: ${THEMES.studio.accentInk};`), 'Studio print button');
  assert.match(studio, /@font-face \{ font-family: 'Figtree';[^}]*url\(\/fonts\/figtree-latin\.woff2\)/, 'Studio loads its font (no system fallback)');
  assert.doesNotMatch(party, /@font-face/, 'Party names the fonts it always did');
  // a long join address wraps instead of running into the QR code (either skin)
  const withQr = await songbookHtml(catalog, songs, { title: 'Q', joinUrl: 'http://192.168.100.200:8080/j/ABCD', roomCode: 'ABCD' });
  assert.match(withQr, /or open <b class="url">192\.168\.100\.200:8080\/j\/ABCD<\/b>/);
  assert.match(withQr, /header \.join \.url \{[^}]*overflow-wrap: anywhere;/);
  assert.match(withQr, /header \.qr \{ flex: none;/);

  // an accent the owner picked brings the text colour that reads best on it, in either skin
  assert.match(await songbookHtml(catalog, songs, { appearance: { theme: 'party', accent: '#00c2ff' } }), /background: #00c2ff; color: #111;/);
  assert.match(await songbookHtml(catalog, songs, { appearance: { theme: 'studio', accent: '#1368ce' } }), /background: #1368ce; color: #fff;/);
});
