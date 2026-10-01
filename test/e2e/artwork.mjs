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
  // A logo that can't be loaded (dead link, offline): the name as text, no broken image.
  const tadb = app.artwork.artists.get(artistKey);
  const goodLogo = tadb.logo;
  tadb.logo = 'url:https://logos.example.invalid/gone.png';
  app.artwork.artChanged({ artists: [artistKey] });
  check(await until(async () => !(await host.$('.artist-logo img')) && /Pixel Parade/.test(await host.textContent('.artist-head h1'))), 'artist page falls back to the name when the logo is missing');
  tadb.logo = goodLogo;
  app.artwork.artChanged({ artists: [artistKey] });

  // Changed covers reach pages that are opened later: a reload shows "No cover", not the
  // image the browser loaded before.
  await host.goto(`${base}/host#/`);
  await host.reload(); // a fresh page: the browser caches the covers under their plain URLs
  await host.waitForSelector('.song-card img');
  const firstCard = await host.$eval('.song-card', (el) => el.textContent);
  const fixSong = [...app.library.catalog.songs.values()].find((s) => firstCard.includes(s.title) && app.artwork.songs.get(s.key)?.cover);
  const coverOf = (page, id) => page.$$eval('img', (imgs, sid) => imgs.filter((i) => i.src.includes(`/api/art/song/${sid}?`)).map((i) => i.complete && i.naturalWidth), id);
  check(await until(async () => (await coverOf(host, fixSong.id)).includes(48)), `the host shows the cover of ${fixSong.title}`);
  const artSeq = app.artFeed.seq;
  app.artwork.setNone(fixSong);
  await until(() => app.artFeed.seq > artSeq); // the open page was told; a reloaded one is not
  await host.reload();
  await host.waitForSelector('.song-card img');
  check(await until(async () => { const w = await coverOf(host, fixSong.id); return w.length && !w.includes(48) && w.every(Boolean); }), 'after “No cover” a reloaded page shows the placeholder');
  await app.artwork.refresh(fixSong);

  // TV: lobby mosaic, then cover + logo on the intro card and artist photos while singing.
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  check(await until(async () => (await tv.$$('.mosaic img')).length >= 20), 'TV lobby shows a mosaic of covers');
  await shot(tv, 'tv-lobby-mosaic');
  const song = [...app.library.catalog.songs.values()].find((s) => s.artist === 'Pixel Parade');
  app.settings.update({ playback: { countdown: 6 } });
  // A duet with long names: the name must keep its full width and height next to the artwork.
  await app.room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'queue.add', songId: song.id, singerName: 'Maximilian', partnerName: 'Josephine' });
  await tv.waitForSelector('.intro-cover', { timeout: 10000 });
  check(await until(async () => !!(await tv.$('.intro .artist-logo'))), 'intro card shows the cover and the artist logo');
  await app.room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'player.key', semitones: 2 });
  await tv.waitForSelector('.intro .chip');
  await sleep(900);
  const introFit = () => tv.evaluate(() => {
    const name = document.querySelector('.intro .name');
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      text: name.textContent, height: name.clientHeight / name.scrollHeight, width: name.clientWidth / name.scrollWidth,
      size: parseFloat(getComputedStyle(name).fontSize) / (innerHeight * 0.15), top: box('.intro .kicker').top, bottom: box('.intro .status').bottom,
    };
  });
  let fit = await introFit();
  check(fit.text === 'Maximilian & Josephine' && fit.height >= 0.9 && fit.width >= 1 && fit.size === 1 && fit.top >= 0 && fit.bottom <= 720,
    `the singers’ names keep their full size next to cover, logo and key chip (${Math.round(fit.height * 100)} % high, ${Math.round(fit.width * 100)} % wide)`);
  await shot(tv, 'tv-intro');
  // On a 4:3 screen the duet is wider than the card: it gets a little smaller instead of "…".
  await tv.setViewportSize({ width: 1024, height: 768 });
  await sleep(300);
  fit = await introFit();
  check(fit.width >= 1 && fit.size < 1 && fit.size >= 0.5 && fit.height >= 0.9 && fit.top >= 0 && fit.bottom <= 768,
    `on a 4:3 screen a long name gets smaller to fit (${Math.round(fit.size * 100)} % size)`);
  await shot(tv, 'tv-intro-4x3');
  await tv.setViewportSize({ width: 1280, height: 720 });
  await app.room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'player.key', semitones: 0 });
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

  // A phone that was asleep missed an `art` event: the welcome after it reconnects brings it.
  const shownId = await guest.$eval('.g-songs img', (i) => decodeURIComponent(new URL(i.src).pathname.split('/').pop()));
  const shown = app.library.catalog.song(shownId);
  const broadcast = app.hub.broadcast.bind(app.hub);
  app.hub.broadcast = (msg, filter) => broadcast(msg, (c) => !(msg.t === 'art' && c.role === 'guest') && (!filter || filter(c)));
  const seqBefore = app.artFeed.seq;
  app.artwork.setNone(shown);
  await until(() => app.artFeed.seq > seqBefore);
  await sleep(300);
  check((await coverOf(guest, shown.id)).includes(48), 'the sleeping phone missed the change');
  app.hub.broadcast = broadcast;
  for (const c of app.hub.clients.values()) if (c.role === 'guest') c.ws.terminate();
  check(await until(async () => { const w = await coverOf(guest, shown.id); return w.length && !w.includes(48) && w.every(Boolean); }), 'after reconnecting the phone shows the change without a reload');
  await app.artwork.refresh(shown);
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
