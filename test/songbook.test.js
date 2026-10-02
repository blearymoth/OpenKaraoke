import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../server/library/catalog.js';
import { songbookSongs, songbookCsv, songbookHtml } from '../server/http/songbook.js';
import { rawTracks } from './helpers.js';
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

test('songbook: CSV is spreadsheet-safe; HTML escapes names and carries the join QR code', () => {
  const songs = songbookSongs(catalog, {});
  const csv = songbookCsv(catalog, songs);
  assert.ok(csv.startsWith('﻿Artist,Title,Versions,Length,Year,Genre,Tags\r\n'));
  assert.match(csv, /\r\n"'=cmd\|calc","""Tricky, Title""",1,/, 'formula-looking cells are neutralised and quotes escaped');
  assert.match(csv, /ABBA,Dancing Queen,2,3:\d\d,,,/);
  const html = songbookHtml(catalog, songs, { title: 'Party <3', joinUrl: 'http://192.168.1.2:8080/j/ABCD', roomCode: 'ABCD' });
  assert.match(html, /<title>Party &lt;3 · Songbook<\/title>/);
  assert.match(html, /&quot;Tricky, Title&quot;/);
  assert.doesNotMatch(html, /<3/);
  assert.match(html, /<svg[^>]*>/);
  assert.match(html, /192\.168\.1\.2:8080\/j\/ABCD/);
  assert.match(html, /<h2>A<\/h2>/);
  assert.match(html, /<i title="Explicit">E<\/i>/);
  assert.match(html, /<i title="Duet">♥<\/i>/);
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

test('songbook: the toolbar and headings follow the skin; Party prints as it always did', () => {
  const songs = songbookSongs(catalog, {});
  const party = songbookHtml(catalog, songs, { title: 'P', appearance: { theme: 'party', accent: '' } });
  // the exact rules the songbook had before skins existed
  assert.ok(party.includes("header h1 { font: 800 22pt/1 'Bricolage', 'Figtree', system-ui, sans-serif; margin: 0; flex: 1; }"));
  assert.ok(party.includes("section.letter h2 { font: 800 15pt/1 'Bricolage', system-ui, sans-serif; margin: 6px 0 3px;"));
  assert.ok(party.includes('.toolbar { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: #150f26; color: #fff; font: 14px system-ui, sans-serif; }'));
  assert.ok(party.includes('.toolbar button { font: inherit; font-weight: 700; padding: 8px 16px; border: 0; border-radius: 99px; background: #ff3d8b; color: #fff; cursor: pointer; }'));

  const studio = songbookHtml(catalog, songs, { title: 'S' });
  assert.doesNotMatch(studio, /Bricolage/, 'Studio headings are Figtree');
  assert.match(studio, /\.toolbar \{[^}]*background: #0a1120;/);
  assert.match(studio, /\.toolbar button \{[^}]*border-radius: 10px; background: #2fd3c6; color: #03191b;/);

  // an accent the owner picked brings the text colour that reads best on it, in either skin
  assert.match(songbookHtml(catalog, songs, { appearance: { theme: 'party', accent: '#00c2ff' } }), /background: #00c2ff; color: #111;/);
  assert.match(songbookHtml(catalog, songs, { appearance: { theme: 'studio', accent: '#1368ce' } }), /background: #1368ce; color: #fff;/);
});
