#!/usr/bin/env node
// End-to-end check of cover art & metadata in the three apps (M5), with a fake provider
// network (test/fake-art.js) — nothing goes to the internet. Not part of `npm test`.
//
//   node test/e2e/artwork.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-artwork');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
/** Real covers from the fake CDN are 48×48 PNGs; placeholders are SVGs. */
const realImages = (page, selector) => page.$$eval(selector, (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 48).length);

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.song-card img');
  const cards = await host.$$eval('.song-card img', (l) => l.length);
  // First view: placeholders; the lookups finish and `art` events swap in the real covers.
  // (DJ Hush is unknown to the fake Deezer: that card keeps its placeholder.)
  check(await until(async () => (await realImages(host, '.song-card img')) === cards - 1), `home: real covers replace the placeholders live (${cards} cards)`);

  // Background crawl of the whole (demo) library.
  app.settings.update({ artwork: { crawl: true } });
  app.artwork.crawlTick();
  check(await until(() => app.artwork.status().songs.pending === 0, 20000), 'crawler looked up the whole library');
  const st = app.artwork.status();
  check(st.songs.found === st.songs.total - 1 && st.songs.missed === 1, `found ${st.songs.found}/${st.songs.total}, 1 unknown artist missed`);

  await host.goto(`${base}/host#/settings/artwork`);
  await host.waitForSelector('.art-progress');
  const progress = await host.textContent('.settings-body');
  check(/have a cover/.test(progress) && /Deezer/.test(progress) && /OK/.test(progress), 'settings → artwork shows progress and provider status');
  await shot(host, 'host-settings-artwork');

  app.library.catalog.metaChanged();
  await host.goto(`${base}/host#/tags`);
  await host.reload();
  await host.waitForSelector('.tag-tile.genre');
  const genres = await host.$$eval('.tag-tile.genre b', (l) => l.map((x) => x.textContent));
  const decades = await host.$$eval('.tag-tile.decade b', (l) => l.map((x) => x.textContent));
  check(genres.length > 0 && decades.length > 0, `collections list genres (${genres.join(', ')}) and decades (${decades.join(', ')})`);
  await shot(host, 'host-collections');
  await host.click('.tag-tile.genre');
  await host.waitForSelector('.song-row');
  check((await host.$$('.song-row')).length > 0, `genre page lists songs (${genres[0]})`);

  // Song details: metadata, source and "fix artwork".
  await host.click('.song-row');
  await host.waitForSelector('.art-source');
  const source = await host.textContent('.art-source');
  check(/Deezer/.test(source), `song details say where the cover came from (“${source.trim()}”)`);
  await host.click('.art-source .link');
  await host.waitForSelector('.art-candidate');
  await shot(host, 'host-fix-artwork');
  check(await until(async () => (await realImages(host, '.art-candidate img')) > 0), 'candidate thumbnails come through the server');
  await host.click('.art-candidate');
  check(await until(async () => /chosen by you/i.test((await host.textContent('.art-source').catch(() => '')) || '')), 'choosing a cover in “Change cover” is remembered');

  await host.keyboard.press('Escape');
  // Artist page with fanart and logo (TheAudioDB).
  const artistKey = app.library.catalog.artistList.find((a) => a.name === 'Pixel Parade').key;
  await host.goto(`${base}/host#/artist/${encodeURIComponent(artistKey)}`);
  check(await until(async () => !!(await host.$('.artist-head.with-fanart .artist-logo img'))), 'artist page shows fanart and the logo once TheAudioDB answers');
  await shot(host, 'host-artist');

  // TV: lobby mosaic, then cover + logo on the intro card and artist photos while singing.
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  check(await until(async () => (await tv.$$('.mosaic img')).length >= 20), 'TV lobby shows a mosaic of covers');
  await shot(tv, 'tv-lobby-mosaic');
  const song = [...app.library.catalog.songs.values()].find((s) => s.artist === 'Pixel Parade');
  app.settings.update({ playback: { countdown: 6 } });
  await app.room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'queue.add', songId: song.id, singerName: 'Eve' });
  await tv.waitForSelector('.intro-cover', { timeout: 10000 });
  check(await until(async () => !!(await tv.$('.intro .artist-logo'))), 'intro card shows the cover and the artist logo');
  await shot(tv, 'tv-intro');
  check(await until(async () => !!(await tv.$('#bg .fanart-bg')), 15000), 'artist photos move behind the lyrics while singing');
  await sleep(600);
  await shot(tv, 'tv-singing-fanart');

  // Guest: decade and genre chips filter the list.
  const guest = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'guest');
  await guest.goto(`${base}/j/${code}`);
  await guest.waitForSelector('.profile-form');
  await guest.fill('.profile-form input', 'Gus');
  await guest.click('.profile-form .btn.primary');
  await guest.waitForSelector('.g-tabs');
  await guest.click('.g-tabs button:nth-child(2)');
  await guest.waitForSelector('.g-chips');
  const chip = await guest.waitForSelector(`.g-chips button:has-text("${genres[0]}")`, { timeout: 5000 }).catch(() => null);
  check(!!chip, 'guest sees genre chips');
  await chip?.click();
  await guest.waitForSelector('.g-songs .song-row');
  check(await until(async () => (await realImages(guest, '.g-songs img')) > 0), 'guest list shows real covers');
  const overflow = await guest.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'guest app still fits the phone screen');
  await shot(guest, 'guest-genre');
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
