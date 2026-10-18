#!/usr/bin/env node
// End-to-end checks of the year & genre checker (Browse → Table → Show: … to check): the flagged
// songs and why, changing a year in place (Enter saves, Escape doesn't), going back to the online
// one, a suggested genre, the first release found online, "Right", "Use all", the kinds, the
// browse filters following the host's years, a phone, no console errors.
//
//   node test/e2e/year-genre.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';
import { fakeArtFetch } from '../fake-art.js';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-year-genre');
await fs.mkdir(out, { recursive: true });

// MusicBrainz knows when "Neon Heart" first came out (the lookup the host asks for).
const artFetch = fakeArtFetch({
  unknown: new Set(['dj hush']),
  override: (url) => {
    if (url.hostname !== 'musicbrainz.org' || !/Neon/i.test(decodeURIComponent(url.search))) return undefined;
    return new Response(JSON.stringify({ recordings: [
      { id: 'mb-neon', title: 'Neon Heart', 'artist-credit': [{ name: 'The Midnight Mics' }], 'first-release-date': '1984-05-01', length: 30000, releases: [] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
const { app, base } = await startParty({ artFetch });
const cat = app.library.catalog;
const art = app.artwork;
const song = (title) => cat.songList.find((s) => s.title === title);
// What the artwork lookup found (the crawler is off here).
const ONLINE = {
  'Neon Heart': { year: 1999, genre: 'Pop', album: 'Neon Nights: Greatest Hits' }, // a compilation's year
  'Tempo Tantrum': { year: 1987, genre: 'Dance' },
  'Quiet Storm': { year: 1996 }, // no genre: DJ Hush is R&B
  'Gliding Home': {}, // nothing at all
  'High Notes Only': { year: 2004, genre: 'Rock' },
  'Singing In The Kitchen': { year: 1979, genre: 'Pop', album: 'Kitchen Songs (Remastered)' },
};
for (const [title, e] of Object.entries(ONLINE)) art.songs.set(song(title).key, { ...e, at: Date.now(), v: 9 });
art.artists.set(song('Quiet Storm').artistKeys[0], { genre: 'R&B', at: Date.now(), v: 9 });
cat.metaChanged();

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
const row = (title) => `.meta-row:has(.lib-title:has-text("${title}"))`;
const rows = (page) => page.$$eval('.meta-row .lib-title', (l) => l.map((x) => x.textContent.trim()));
const metaOf = (title) => cat.metaFor(song(title).key) || {};

try {
  const h = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await h.goto(`${base}/host#/browse?view=table&sort=title`);
  await h.waitForSelector('.lib-table .lib-row');
  await h.selectOption('.lib-show select', 'any');
  await h.waitForSelector('.meta-row');
  check(await until(async () => (await h.evaluate(() => location.hash)) === '#/browse?view=table&sort=title&check=any'), 'the checker is in the address');
  const flagged = ['Gliding Home', 'Neon Heart', 'Quiet Storm', 'Singing In The Kitchen'];
  check(await until(async () => JSON.stringify(await rows(h)) === JSON.stringify(flagged)), `flagged: ${(await rows(h)).join(', ')}`);
  const why = async (title) => h.$eval(`${row(title)} .why`, (u) => u.textContent);
  check((await why('Neon Heart')).includes('compilation'), 'Neon Heart: the year of a compilation');
  check((await why('Singing In The Kitchen')).includes('compilation'), 'a remastered album counts too');
  check((await why('Gliding Home')).includes('No year') && (await why('Gliding Home')).includes('No genre'), 'Gliding Home: no year, no genre');
  check(await h.isVisible(`${row('Quiet Storm')} .why-actions button:has-text("Use R&B")`), 'Quiet Storm: R&B suggested (the artist’s genre)');
  await shot(h, 'checker');

  // A year changed in place: Escape keeps it, Enter saves it as the host's.
  await h.click(`${row('Singing In The Kitchen')} .col-year .edit-value`);
  await h.fill(`${row('Singing In The Kitchen')} .col-year input`, '1950');
  await h.keyboard.press('Escape');
  check(await h.isVisible(`${row('Singing In The Kitchen')} .col-year .edit-value:has-text("1979")`) && metaOf('Singing In The Kitchen').year === 1979, 'Escape: nothing changed');
  await h.click(`${row('Singing In The Kitchen')} .col-year .edit-value`);
  await h.fill(`${row('Singing In The Kitchen')} .col-year input`, '1978');
  await h.keyboard.press('Enter');
  check(await until(() => metaOf('Singing In The Kitchen').year === 1978), 'Enter: the host’s year (1978) is used');
  check(await until(() => h.isVisible(`${row('Singing In The Kitchen')}.done .col-year .edit-cell.own`)), 'the row says done, the year is marked as the host’s');
  check(app.songMeta.get(song('Singing In The Kitchen').key)?.year === 1978, 'kept in songmeta.json');
  // A year that can't be right is refused.
  await h.click(`${row('Gliding Home')} .col-year .edit-value`);
  await h.fill(`${row('Gliding Home')} .col-year input`, '1850');
  await h.keyboard.press('Enter');
  check(await until(() => h.isVisible('.toast:has-text("A year from 1900")')), 'a year before 1900 is refused with a message');
  // Back to the online year.
  await h.click(`${row('Singing In The Kitchen')} .col-year .undo`);
  check(await until(() => metaOf('Singing In The Kitchen').year === 1979 && !app.songMeta.get(song('Singing In The Kitchen').key)), 'undo: the online year again');
  check(await until(() => h.isVisible(`${row('Singing In The Kitchen')}:not(.done) .col-year .edit-cell:not(.own)`)), 'and the row needs checking again');

  // The suggested genre.
  await h.click(`${row('Quiet Storm')} .why-actions button:has-text("Use R&B")`);
  check(await until(() => metaOf('Quiet Storm').genre === 'R&B'), 'Use R&B: Quiet Storm is R&B');

  // The first release, found online.
  await h.click(`${row('Neon Heart')} .why-actions button:has-text("Find the first release")`);
  check(await until(() => h.isVisible(`${row('Neon Heart')} .found:has-text("First out in 1984")`)), 'Find the first release: 1984 (MusicBrainz)');
  await h.click(`${row('Neon Heart')} .why-actions button:has-text("Use 1984")`);
  check(await until(() => metaOf('Neon Heart').year === 1984), 'Use 1984');

  // "Right" keeps what it shows.
  await h.click(`${row('Singing In The Kitchen')} .col-actions button:has-text("Right")`);
  check(await until(() => app.songMeta.get(song('Singing In The Kitchen').key)?.year === 1979), 'Right: the year shown (1979) becomes the host’s');

  // The browse filters follow the host's years: Neon Heart is an ’80s song now.
  const eighties = (await (await fetch(`${base}/api/browse/popular?decade=1980`)).json()).items.map((s) => s.title);
  check(eighties.includes('Neon Heart'), `the ’80s now have Neon Heart (${eighties.join(', ')})`);

  // Reloaded: only what is left; the kinds.
  await h.reload();
  await h.waitForSelector('.meta-row');
  check(await until(async () => JSON.stringify(await rows(h)) === JSON.stringify(['Gliding Home'])), `after a reload, left to check: ${(await rows(h)).join(', ')}`);
  await h.selectOption('.lib-show select', 'genre');
  check(await until(async () => JSON.stringify(await rows(h)) === JSON.stringify(['Gliding Home'])), 'Genres to check: Gliding Home');
  // Use all: nothing to suggest for Gliding Home (The Zephyr Lane has no genre anywhere).
  check(!(await h.$('.lib-tools button:has-text("Use all")')), 'no suggestions: no "Use all"');
  await h.click(`${row('Gliding Home')} .col-genre .edit-value`);
  await h.fill(`${row('Gliding Home')} .col-genre input`, 'Synthwave');
  await h.keyboard.press('Enter');
  check(await until(() => metaOf('Gliding Home').genre === 'Synthwave'), 'a genre typed in (Synthwave)');
  await h.selectOption('.lib-show select', '');
  await h.waitForSelector('.lib-table .lib-row:not(.meta-row)');
  check(await h.isVisible('.lib-row:has-text("Neon Heart") .col-year .own-mark'), 'the plain table marks the host’s year');
  check(await until(async () => (await h.evaluate(() => location.hash)) === '#/browse?view=table&sort=title'), 'Every song: the checker leaves the address');

  // Use all: two songs with genre suggestions.
  for (const t of ['Tempo Tantrum', 'High Notes Only']) art.songs.set(song(t).key, { year: ONLINE[t].year, at: Date.now(), v: 9 });
  for (const t of ['Tempo Tantrum', 'High Notes Only']) art.artists.set(song(t).artistKeys[0], { genre: t === 'Tempo Tantrum' ? 'Dance' : 'Rock', at: Date.now(), v: 9 });
  cat.metaChanged();
  await h.selectOption('.lib-show select', 'any');
  await h.waitForSelector('.lib-tools button:has-text("Use all 2 suggestions")');
  await h.click('.lib-tools button:has-text("Use all 2 suggestions")');
  check(await until(() => metaOf('Tempo Tantrum').genre === 'Dance' && metaOf('High Notes Only').genre === 'Rock'), 'Use all 2 suggestions');
  check(await until(async () => JSON.stringify(await rows(h)) === JSON.stringify(['Gliding Home'])), 'left: Gliding Home (it still has no year)');
  check(!(await h.$(`${row('Gliding Home')} .col-actions button:has-text("Right")`)), 'no "Right" for a song without a year (nothing to confirm)');
  await shot(h, 'checker-done');

  // A phone: the table scrolls in its box, not the page.
  const p = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'host-phone');
  art.songs.set(song('Tempo Tantrum').key, { year: 1987, at: Date.now(), v: 9 });
  app.songMeta.set(song('Tempo Tantrum').key, { genre: null });
  cat.metaChanged();
  art.artists.delete(song('Tempo Tantrum').artistKeys[0]);
  await p.goto(`${base}/host#/browse?view=table&check=any`);
  await p.waitForSelector('.meta-row');
  check(await noSideways(p), 'the checker fits a phone (no sideways scrolling of the page)');
  await shot(p, 'checker-phone');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
