#!/usr/bin/env node
// End-to-end checks of the M7 polish features in the host app: preview on this computer,
// "In queue" / "Sung tonight" marks, "Most sung here", printable songbook.
//
//   node test/e2e/polish.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';
import { pngImage } from '../fake-art.js';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-polish');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
// Fake microphone and sound outputs; permission prompts are accepted (preview on headphones).
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/search?q=neon`);
  await host.fill('.search-box input', 'neon heart');
  await host.waitForSelector('.song-row');

  // Preview a version on the host computer.
  await host.click('.song-row');
  await host.waitForSelector('.versions .btn:has-text("Preview")');
  await host.click('.versions .btn:has-text("Preview") >> nth=0');
  check(await host.waitForSelector('.versions .btn:has-text("Stop")', { timeout: 8000 }).then(() => true, () => false), 'preview plays on the host computer');
  await shot(host, 'host-preview');
  await host.click('.versions .btn:has-text("Stop")');
  check(await host.waitForSelector('.versions .btn:has-text("Stop")', { state: 'detached', timeout: 5000 }).then(() => true, () => false), 'preview stops');
  // Headphones: the browser names its sound outputs once asked; the choice is kept.
  const pick = await host.$('.preview-output button:has-text("Choose headphones")');
  await pick?.click();
  const outputs = await host.waitForSelector('.preview-output select', { timeout: 5000 }).then(() => host.$$eval('.preview-output option', (l) => l.map((o) => o.value)), () => []);
  check(outputs.length > 1, `preview can play on another sound output (${outputs.length - 1} found)`);
  if (outputs[1]) {
    await host.selectOption('.preview-output select', outputs[1]);
    check(await host.evaluate(() => localStorage.getItem('ok.previewSink')) === outputs[1], 'the chosen output is remembered');
    await host.selectOption('.preview-output select', '');
    check(await host.evaluate(() => localStorage.getItem('ok.previewSink')) === null, 'choosing the default output again forgets the headphones');
  }
  await host.keyboard.press('Escape');
  await host.waitForSelector('table.versions', { state: 'detached' });

  // A preview stopped while it is still loading (the dialog closed) leaves no error behind.
  await host.route('**/media/*/audio', async (route) => {
    await sleep(1500);
    await route.continue().catch(() => {});
  });
  await host.click('.song-row');
  await host.click('.versions .btn:has-text("Preview") >> nth=0');
  await sleep(300);
  await host.keyboard.press('Escape');
  await host.waitForSelector('table.versions', { state: 'detached' });
  await sleep(1800);
  await host.unroute('**/media/*/audio');
  await host.click('.song-row');
  await host.waitForSelector('.preview-output');
  const stale = await host.$eval('.preview-output', (el) => el.querySelector('.warn-text')?.textContent || '');
  check(!stale, `a preview stopped while loading shows no error afterwards${stale ? ` (${stale})` : ''}`);
  check(!(await host.$('.versions .btn:has-text("Stop")')), 'and it did not start playing after the dialog closed');
  await host.keyboard.press('Escape');
  await host.waitForSelector('table.versions', { state: 'detached' });

  // Queue it: search shows "In queue"; after it is sung: "Sung tonight" + "Most sung here".
  const song = app.library.catalog.search('neon heart').items[0];
  await app.room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'queue.add', songId: song.id, singerName: 'Pat' });
  await host.fill('.search-box input', 'neon hear');
  await host.fill('.search-box input', 'neon heart');
  check(await host.waitForSelector('.song-row .tag-mark.queued', { timeout: 5000 }).then(() => true, () => false), 'search marks songs waiting in the queue');
  const room = app.room;
  const e = room.s.queue.shift();
  room.startEntry(e);
  room.s.player.pos = e.dur;
  room.finish('ended', { advance: false });
  await host.fill('.search-box input', 'neon hea');
  await host.fill('.search-box input', 'neon heart');
  check(await host.waitForSelector('.song-row .tag-mark:has-text("Sung tonight")', { timeout: 5000 }).then(() => true, () => false), 'search marks songs sung tonight');
  await host.goto(`${base}/host#/`);
  await host.reload();
  check(await host.waitForSelector('h2:has-text("Most sung here")', { timeout: 8000 }).then(() => true, () => false), 'home shows “Most sung here”');

  // Playlists: create one, add a song from its details, queue it all.
  await host.goto(`${base}/host#/playlists`);
  await host.fill('.page-actions .inline-form input', 'Warm-up');
  await host.click('.page-actions .inline-form .btn.primary');
  await host.waitForSelector('h1:has-text("Warm-up")');
  const pl = app.room.s.playlists.find((p) => p.name === 'Warm-up');
  check(!!pl, 'host created a playlist');
  await host.fill('.search-box input', 'tempo');
  await host.waitForSelector('.song-row');
  await host.click('.song-row');
  await host.waitForSelector('.playlist-select');
  await host.selectOption('.playlist-select', pl.id);
  await sleep(300);
  check(pl.songIds.length === 1, 'song added to the playlist from its details');
  await host.keyboard.press('Escape');
  await host.goto(`${base}/host#/playlists/${pl.id}`);
  await host.waitForSelector('.playlist-queue .btn.primary');
  await host.fill('.playlist-queue .input', 'Everyone');
  const before = app.room.s.queue.length;
  await host.click('.playlist-queue .btn.primary');
  await sleep(400);
  check(app.room.s.queue.length === before + 1, 'playlist queued in one go');
  await shot(host, 'host-playlist');
  // A double-click (or two quick clicks) queues it once, and pressing Enter twice makes one
  // playlist: on this computer the answer comes back before the second click.
  await sleep(1700); // the button rests a moment after queuing
  let n = app.room.s.queue.length;
  await host.dblclick('.playlist-queue .btn.primary');
  await sleep(400);
  check(app.room.s.queue.length === n + 1, `a double-click on “Queue all” queues the playlist once (+${app.room.s.queue.length - n})`);
  await sleep(1700);
  n = app.room.s.queue.length;
  await host.$eval('.playlist-queue .btn.primary', (b) => { b.click(); b.click(); });
  await sleep(400);
  check(app.room.s.queue.length === n + 1, `two quick clicks on “Queue all” queue it once (+${app.room.s.queue.length - n})`);
  // A song that left the library is named, and can be dropped from the playlist.
  pl.songIds.push('gone-song-id');
  app.room.markDirty();
  await host.waitForSelector('.page p.hint:has-text("no longer in the library")');
  await shot(host, 'host-playlist-missing');
  await host.click('.page p.hint button:has-text("Remove it")');
  await host.waitForSelector('.page p.hint:has-text("no longer in the library")', { state: 'detached' });
  check(app.room.s.playlists.find((p) => p.id === pl.id).songIds.length === 1, 'a song no longer in the library can be removed from the playlist');
  // A failed load says so and can be tried again (it used to spin for good).
  const mark = errors.length;
  const songsCall = (url) => url.pathname === '/api/songs';
  await host.route(songsCall, (route) => route.abort('failed'));
  await host.reload();
  check(await host.waitForSelector('.empty h3:has-text("Couldn’t load the songs")', { timeout: 5000 }).then(() => true, () => false), 'a playlist that fails to load says so');
  await shot(host, 'host-playlist-error');
  await host.unroute(songsCall);
  await host.click('.empty button:has-text("Try again")');
  check(await host.waitForSelector('.song-list .song-row', { timeout: 5000 }).then(() => true, () => false), '“Try again” loads it');
  errors.splice(mark, Infinity, ...errors.slice(mark).filter((x) => !/Failed to load resource/.test(x)));
  await host.goto(`${base}/host#/playlists`);
  await host.fill('.page-actions .inline-form input', 'Encore');
  await host.$eval('.page-actions .inline-form', (f) => { f.requestSubmit(); f.requestSubmit(); });
  await host.waitForSelector('h1:has-text("Encore")');
  await sleep(300);
  check(app.room.s.playlists.filter((p) => p.name === 'Encore').length === 1, 'submitting “Create” twice makes one playlist');

  // Duet invitation between two phones, then a co-host.
  const code = app.settings.get('party.roomCode');
  const phone = async (name) => {
    const p = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
    await p.goto(`${base}/j/${code}`);
    await p.waitForSelector('.profile-form');
    await p.fill('.profile-form input', name);
    await p.click('.profile-form .btn.primary');
    await p.waitForSelector('.g-tabs');
    return p;
  };
  const ann = await phone('Ann');
  const bob = await phone('Bob');
  await ann.click('.g-tabs button:has-text("Songs")');
  await ann.fill('.g-search input', 'kitchen');
  await ann.click('.g-songs .song-row:has-text("Kitchen")');
  await ann.waitForSelector('.sheet select');
  const bobSinger = app.room.s.singers.find((x) => x.name === 'Bob');
  await ann.selectOption('.sheet select', bobSinger.id);
  await ann.click('.sheet .btn.primary');
  await ann.waitForSelector('.sheet-done, .sheet-error');
  const sheetError = await ann.$('.sheet-error');
  check(!sheetError, `Ann requested a duet with Bob${sheetError ? ` (${await sheetError.textContent()})` : ''}`);
  await ann.click(sheetError ? '.sheet-close' : '.sheet-done .btn');
  await bob.waitForSelector('.invite-card', { timeout: 5000 });
  await shot(bob, 'bob-invite');
  await bob.click('.invite-card .btn.primary');
  await sleep(400);
  const duet = app.room.s.queue.find((e) => e.title.startsWith('Singing In The Kitchen'));
  check(duet?.singerIds.length === 2 && duet.singerIds[1] === bobSinger.id, 'Bob accepted the duet invitation');
  check(await ann.waitForSelector('.toast:has-text("Bob will sing")', { timeout: 5000 }).then(() => true, () => false), 'Ann is told that Bob joined');

  await host.goto(`${base}/host#/singers`);
  await host.click('tr:has-text("Ann") button:has-text("Make co-host")');
  await ann.click('.g-tabs button:has-text("Home")');
  await ann.waitForSelector('.cohost-card', { timeout: 5000 });
  await ann.click('.cohost-card .btn:has-text("Play")');
  await sleep(500);
  check(!!app.room.s.current, 'the co-host started the queue from their phone');
  await shot(ann, 'ann-cohost');
  const overflow = await ann.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'phone fits without sideways scrolling');

  // Guest photo: phone upload (resized in the browser) → host approves → TV shows it.
  await ann.click('.g-tabs button:has(span:text-is("Me"))');
  await ann.waitForSelector('.photo-card input[type=file]', { state: 'attached' });
  await ann.setInputFiles('.photo-card input[type=file]', { name: 'party.png', mimeType: 'image/png', buffer: pngImage('party-photo', 400) });
  check(await ann.waitForSelector('.toast:has-text("host will put it on the TV")', { timeout: 8000 }).then(() => true, () => false), 'a guest sent a photo');
  const photoId = app.room.s.photos.at(-1)?.id;
  await host.goto(`${base}/host#/photos`);
  await host.waitForSelector('.photo-tile.pending img');
  const loaded = await host.$eval('.photo-tile.pending img', (img) => new Promise((r) => (img.complete ? r(img.naturalWidth) : img.addEventListener('load', () => r(img.naturalWidth)))));
  check(loaded > 0, `host sees the pending photo (${loaded}px wide, resized on the phone)`);
  const tv2 = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv2');
  await tv2.goto(`${base}/tv?display=mirror`);
  await tv2.waitForSelector('.scene, .lobby');
  await host.click('.photo-tile.pending .btn.primary');
  check(await tv2.waitForSelector('.photo-flash img', { timeout: 5000 }).then(() => true, () => false), 'the approved photo pops up on the TV');
  await shot(tv2, 'tv-photo-flash');
  app.settings.update({ display: { background: 'photos' } });
  app.room.markDirty();
  check(await tv2.waitForSelector('#bg .photo-bg', { timeout: 5000 }).then(() => true, () => false), 'photos can be the TV background');
  app.settings.update({ display: { background: 'art' } });
  check(!!photoId, 'photo stored');

  // A screen on another computer: pairing code on the TV, approval in Settings → Displays.
  // (Everything runs on this machine here, so TV connections are marked as remote.)
  const hello = app.hub.onHello;
  app.hub.onHello = (client, msg) => {
    if (msg.role === 'tv' && !msg.display) client.isLocal = false;
    return hello(client, msg);
  };
  const remote = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'remote-tv');
  await remote.goto(`${base}/tv`);
  await remote.waitForSelector('.pair-code b');
  const shown = (await remote.$$eval('.pair-code b', (l) => l.map((x) => x.textContent).join('')));
  await shot(remote, 'remote-tv-pairing');
  await host.goto(`${base}/host#/settings/displays`);
  await host.waitForSelector('.pairing-row');
  check((await host.textContent('.pairing-row .pair-code-small')).trim() === shown, `host sees the screen's code (${shown})`);
  await host.click('.pairing-row .btn.primary');
  check(await remote.waitForSelector('.lobby, .intro, .scene', { timeout: 10000 }).then(() => true, () => false), 'the paired screen joins the party');
  check(!!(await remote.evaluate(() => localStorage.getItem('ok.tvToken'))), 'the screen keeps its token');
  app.hub.onHello = hello;

  // Queue board layout for a second screen.
  const boardPage = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'board');
  await boardPage.goto(`${base}/tv?layout=board`);
  await boardPage.waitForSelector('.board');
  const rows = await boardPage.$$eval('.board-list li', (l) => l.length);
  check(rows === Math.min(8, app.room.s.queue.length), `queue board lists who sings next (${rows})`);
  check(!(await boardPage.$('.start')), 'the board needs no click (it is muted)');
  await shot(boardPage, 'tv-board');
  await boardPage.close();

  // Live preview of the TV in the host.
  await host.click('.player button[title="Live preview of the TV"]');
  const frame = await (await host.waitForSelector('.tv-preview iframe')).contentFrame();
  check(await frame.waitForSelector('.scene, .lobby', { timeout: 10000 }).then(() => true, () => false), 'host shows a live preview of the TV');
  const tvs = app.hub.list((c) => c.role === 'tv').length;
  check(app.room.hostView().displays.length === tvs - 1, 'the preview is not listed as a display');
  await shot(host, 'host-tv-preview');
  await host.click('.tv-preview .icon-btn');

  // On a phone the preview stays clear of the player, and taps go through it.
  const hostPhone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), 'host-phone');
  await hostPhone.goto(`${base}/host#/`);
  await hostPhone.waitForSelector('.player');
  await hostPhone.click('.player button[title="Live preview of the TV"]');
  await hostPhone.waitForSelector('.tv-preview iframe');
  const clear = await hostPhone.evaluate(() => {
    const prev = document.querySelector('.tv-preview').getBoundingClientRect();
    const player = document.querySelector('.player').getBoundingClientRect();
    const reachable = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(sel);
    };
    const under = document.elementFromPoint(prev.left + 10, prev.bottom - 10);
    return {
      overlaps: prev.bottom > player.top,
      controls: ['.play-btn', '.player button[aria-label="Next singer"]', '.player button[aria-label="Restart song"]', '.player .seek'].every(reachable),
      through: !!under && !under.closest('.tv-preview'),
    };
  });
  check(!clear.overlaps && clear.controls, `phone: the TV preview leaves the player's buttons free (${JSON.stringify(clear)})`);
  check(clear.through, 'phone: taps on the page under the TV preview go through it');
  await shot(hostPhone, 'host-phone-tv-preview');
  await hostPhone.tap('.tv-preview .icon-btn');
  check(await hostPhone.waitForSelector('.tv-preview', { state: 'detached', timeout: 3000 }).then(() => true, () => false), 'phone: the TV preview closes from its ✕');
  await hostPhone.close();

  // Printable songbook from Settings → Library.
  await host.goto(`${base}/host#/settings/library`);
  await host.waitForSelector('a:has-text("Open songbook")');
  const [book] = await Promise.all([host.context().waitForEvent('page'), host.click('a:has-text("Open songbook")')]);
  await book.waitForSelector('main .a, main .t');
  const titles = await book.$$eval('main li, main .t', (l) => l.length);
  check(titles === app.library.catalog.songList.length, `songbook lists every song (${titles})`);
  check(!!(await book.$('header .qr svg')), 'songbook has the join QR code');
  await book.emulateMedia({ media: 'print' });
  await shot(book, 'songbook-print');
  const pdf = await book.pdf({ format: 'A4' }).catch(() => null);
  check(!!pdf && pdf.length > 1000, 'songbook prints to PDF');
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
