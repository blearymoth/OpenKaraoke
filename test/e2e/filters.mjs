#!/usr/bin/env node
// End-to-end checks of the browse filters (several decades, genres, collections and version
// types): the guest's Songs tab (chip row, Filters sheet, typing ignores them, kept between tabs,
// the explicit filter) and the host's Browse page (filters in the address, Clear, phone layout).
//
//   node test/e2e/filters.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-filters');
await fs.mkdir(out, { recursive: true });

// More songs for the filters: backing-vocal versions, a Christmas song, a music video, an
// explicit one (the files are never played).
const EXTRA = [
  'B/Backline/Backline - Harmony Road (With Backing Vocals) [OK Karaoke]',
  'B/Backline/Backline - Harmony Road (No Backing Vocals) [ZZ Karaoke]',
  'M/Mistletoe Crew/Mistletoe Crew - Christmas Lights [OK Karaoke]',
  'R/Rough Edges/Rough Edges - Loud Words (Explicit) [OK Karaoke]',
];
const { app, base } = await startParty({
  addTracks: async (dir) => {
    for (const name of EXTRA) {
      await fs.mkdir(path.join(dir, path.dirname(name)), { recursive: true });
      await fs.writeFile(path.join(dir, `${name}.cdg`), Buffer.alloc(7200 * 60));
      await fs.writeFile(path.join(dir, `${name}.mp3`), Buffer.alloc(1000));
    }
    await fs.mkdir(path.join(dir, 'V'), { recursive: true });
    await fs.writeFile(path.join(dir, 'V/Velvet Frames - Picture Show.mp4'), Buffer.alloc(1000));
  },
});
// Online song information (years and genres) by title, as the artwork lookup would bring it.
const META = {
  'Neon Heart': { year: 1984, genre: 'Pop' },
  'Tempo Tantrum': { year: 1987, genre: 'Dance' },
  'Quiet Storm': { year: 1996, genre: 'R&B' },
  'Gliding Home': { year: 1978, genre: 'Pop' },
  'High Notes Only': { year: 2004, genre: 'Rock' },
  'Singing In The Kitchen': { year: 1979, genre: 'Pop' },
  'Harmony Road': { year: 1991, genre: 'Rock' },
  'Christmas Lights': { year: 1994, genre: 'Pop' },
  'Picture Show': { year: 2008, genre: 'Dance' },
  'Loud Words': { year: 1999, genre: 'Rock' },
};
const cat = app.library.catalog;
const titleOf = new Map(cat.songList.map((s) => [s.key, s.title]));
cat.metaFor = (key) => META[titleOf.get(key)] || null;
cat.metaChanged();
const expect = (pred) => cat.songList.filter((s) => pred(META[s.title] || {}, s)).map((s) => s.title).sort();

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
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => app.room.request(asHost, { t, ...m });
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const phone = { viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
/** The titles a list shows once it has settled on `want` (or after the timeout). */
const listed = async (page, selector, want) => {
  const read = () => page.$$eval(`${selector} .song-row`, (rows) => rows.map((r) => r.querySelector('.song-title')?.firstChild?.textContent.trim()));
  await until(async () => same(await read(), want));
  return (await read()).sort();
};
const chip = (scope, param, label) => `${scope} button[data-filter="${param}"]:has-text("${label}")`;

try {
  // ---- guest: the Songs tab ----------------------------------------------------------------
  const code = app.settings.get('party.roomCode');
  const g = watch(await browser.newPage(phone), 'guest');
  await g.goto(`${base}/j/${code}`);
  await g.waitForSelector('.profile-form');
  await g.fill('.profile-form input', 'Fay');
  await g.click('.profile-form .btn.primary');
  await g.waitForSelector('.g-tabs');
  await g.click('.g-tabs button:has-text("Songs")');
  await g.waitForSelector('.g-chips .filters-btn');
  const songs = '.g-songs';
  check(same(await listed(g, songs, cat.songList.map((s) => s.title)), cat.songList.map((s) => s.title)), 'no filters: every song, most popular first');
  check(!!(await g.$(chip('.g-chips', 'tag', 'Duets'))), 'the chip row has the collections (Duets)');
  check(!(await g.$(chip('.g-chips', 'tag', 'Multiplex'))), 'no Multiplex collection: the Guide singer version type says it');
  check(!!(await g.$(chip('.g-chips', 'decade', '80s'))) && !!(await g.$(chip('.g-chips', 'genre', 'Pop'))), 'the chip row has the decades and genres');

  // Two decades: either one.
  await g.click(chip('.g-chips', 'decade', '’70s'));
  await g.click(chip('.g-chips', 'decade', '’80s'));
  const seventiesEighties = expect((m) => m.year >= 1970 && m.year < 1990);
  check(same(await listed(g, songs, seventiesEighties), seventiesEighties), `’70s or ’80s: ${seventiesEighties.join(', ')}`);
  check(await g.isVisible(`.g-results:has-text("${seventiesEighties.length} songs")`), 'the count of matching songs');
  // …and a genre: both groups must match.
  await g.click(chip('.g-chips', 'genre', 'Pop'));
  const popOld = expect((m) => m.year >= 1970 && m.year < 1990 && m.genre === 'Pop');
  check(same(await listed(g, songs, popOld), popOld), `’70s or ’80s, and Pop: ${popOld.join(', ')}`);
  check(await g.isVisible('.filters-btn .badge:has-text("3")'), 'the Filters button counts 3 filters');
  check(await noSideways(g), 'the Songs tab fits the phone (no sideways scrolling)');
  await shot(g, 'guest-chips');

  // Typing a search ignores the filters; they are back when the search is cleared.
  await g.fill('.g-search input', 'high notes');
  check(same(await listed(g, songs, ['High Notes Only']), ['High Notes Only']), 'a typed search ignores the filters (High Notes Only is from 2004, Rock)');
  check(!(await g.$('.g-chips')), 'the filter chips are hidden while typing');
  await g.fill('.g-search input', '');
  check(same(await listed(g, songs, popOld), popOld), 'cleared: the filtered list is back');

  // Kept while switching tabs.
  await g.click('.g-tabs button:has-text("Queue")');
  await g.click('.g-tabs button:has-text("Songs")');
  check(same(await listed(g, songs, popOld), popOld), 'the filters are kept when coming back to the Songs tab');

  // The Filters sheet: every group; a draft with a live count, applied by its button.
  await g.click('.g-chips .filters-btn');
  await g.waitForSelector('.filter-sheet');
  const groups = await g.$$eval('.filter-sheet .filter-group legend', (l) => l.map((x) => x.textContent));
  check(same(groups, ['Decade', 'Genre', 'Collections', 'Versions']), `the sheet has every group (${groups})`);
  const versions = await g.$$eval('.filter-sheet button[data-filter="version"]', (l) => l.map((b) => b.textContent.replace(/\s*\d+$/, '').trim()));
  check(same(versions, ['Guide singer', 'With backing vocals', 'No backing vocals', 'Music video']), `version types (${versions})`);
  check(await noSideways(g), 'the Filters sheet fits the phone');
  await sleep(400); // (the sheet slides up)
  const covered = await g.$eval('.filter-sheet .btn.primary', (b) => {
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return !b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  check(!covered, 'the sheet’s button is above the tab bar');
  await shot(g, 'guest-sheet');
  await g.click('.filter-sheet .btn:has-text("Clear all")');
  check(await g.isVisible('.filter-sheet .btn.primary:has-text("Show popular songs")'), 'cleared draft: "Show popular songs"');
  await g.click(chip('.filter-sheet', 'version', 'Guide singer'));
  await g.click(chip('.filter-sheet', 'version', 'Music video'));
  check(await until(() => g.isVisible('.filter-sheet .btn.primary:has-text("Show 2 songs")')), 'Guide singer or Music video: "Show 2 songs" (counted as you pick)');
  await g.click(chip('.filter-sheet', 'tag', 'Duets'));
  check(await until(() => g.isVisible('.filter-sheet .btn.primary:has-text("Show 0 songs")')), '…and Duets: no song has all of that');
  check(await g.isDisabled('.filter-sheet .btn.primary'), 'nothing to show: the button is off');
  await g.click(chip('.filter-sheet', 'tag', 'Duets'));
  check(same(await listed(g, songs, popOld), popOld), 'the list behind the sheet is unchanged until the filters are applied');
  await g.click('.filter-sheet .btn.primary');
  await g.waitForSelector('.filter-sheet', { state: 'detached' });
  const mpxOrVideo = ['Quiet Storm', 'Picture Show'];
  check(same(await listed(g, songs, mpxOrVideo), mpxOrVideo), 'applied: the multiplex song and the music video');
  await g.click('.g-results .link:has-text("Clear filters")');
  check((await listed(g, songs, cat.songList.map((s) => s.title))).length === cat.songList.length, 'Clear filters: every song again');

  // The explicit filter: the Explicit collection and explicit songs are gone for guests.
  await hostReq('settings.update', { patch: { queue: { explicitFilter: true } } });
  await g.reload();
  await g.click('.g-tabs button:has-text("Songs")');
  await g.click('.g-chips .filters-btn');
  await g.waitForSelector('.filter-sheet .filter-group');
  check(!(await g.$(chip('.filter-sheet', 'tag', 'Explicit'))), 'explicit filter on: no Explicit collection');
  // (The song lists themselves: this phone is on the host's own computer, which the server
  // trusts as the host over HTTP, so explicit songs aren't taken out here — test/server.test.js.)
  await g.click(chip('.filter-sheet', 'decade', '’90s'));
  await g.click('.filter-sheet .btn.primary');
  const nineties = expect((m) => m.year >= 1990 && m.year < 2000);
  check(same(await listed(g, songs, nineties), nineties), `’90s: ${nineties.join(', ')}`);
  await hostReq('settings.update', { patch: { queue: { explicitFilter: false } } });

  // ---- host: the Browse page ------------------------------------------------------------------
  const h = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await h.goto(`${base}/host`);
  await h.waitForSelector('.nav a[href="#/browse"]');
  await h.click('.nav a[href="#/browse"]');
  await h.waitForSelector('.browse-filters .filter-group');
  const all = cat.songList.map((s) => s.title);
  check(same(await listed(h, '.browse-results', all), all), 'host Browse: every song without filters');
  await h.click(chip('.browse-filters', 'genre', 'Rock'));
  await h.click(chip('.browse-filters', 'genre', 'Dance'));
  await h.click(chip('.browse-filters', 'version', 'With backing vocals'));
  const rockDanceBgv = ['Harmony Road'];
  check(same(await listed(h, '.browse-results', rockDanceBgv), rockDanceBgv), 'Rock or Dance, with backing vocals: Harmony Road');
  const hash = await h.evaluate(() => location.hash);
  check(hash === '#/browse?genre=Dance&genre=Rock&version=bgv', `the filters are in the address (${hash})`);
  await h.reload();
  check(same(await listed(h, '.browse-results', rockDanceBgv), rockDanceBgv), 'a reload keeps them');
  check(await h.isVisible('.browse-filters summary .badge:has-text("3")'), 'the panel counts 3 filters');
  await shot(h, 'host-browse');
  await h.click('.browse-count .link:has-text("Clear filters")');
  check(same(await listed(h, '.browse-results', all), all), 'Clear filters: every song');
  check(await h.evaluate(() => location.hash) === '#/browse', 'and a plain address');
  await h.goto(`${base}/host#/browse?decade=1970&tag=Duets&version=hack&decade=1955`);
  check(same(await listed(h, '.browse-results', ['Singing In The Kitchen']), ['Singing In The Kitchen']), 'an address with odd values: only the valid ones count');
  await h.goto(`${base}/host#/tags`);
  check(!!(await h.waitForSelector('.page-head a[href="#/browse"]', { timeout: 5000 }).catch(() => null)), 'Collections links to Browse with filters');

  // The host on a phone: the panel folds away, nothing sideways.
  const hp = watch(await browser.newPage({ ...phone, viewport: { width: 390, height: 844 } }), 'host-phone');
  await hp.goto(`${base}/host#/browse?decade=1980`);
  await hp.waitForSelector('.browse-filters');
  check(!(await hp.$eval('.browse-filters', (d) => d.open)), 'host on a phone: the filters start folded');
  await hp.click('.browse-filters summary');
  await hp.click(chip('.browse-filters', 'decade', '’90s'));
  check(await hp.$eval('.browse-filters', (d) => d.open), 'picking a filter keeps them open');
  const eightiesNineties = expect((m) => m.year >= 1980 && m.year < 2000);
  check(same(await listed(hp, '.browse-results', eightiesNineties), eightiesNineties), '’80s or ’90s on the phone');
  check(await noSideways(hp), 'host Browse fits the phone (no sideways scrolling)');
  await shot(hp, 'host-browse-phone');
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
