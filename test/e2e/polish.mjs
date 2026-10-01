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
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
/** Everything a page receives over its WebSocket. */
const recordFrames = (page) => {
  const frames = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  return frames;
};
/** Test only: expose a TV page's controller and connection so its playback can be inspected. */
const exposeController = (page) => page.route('**/js/tv/main.js', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\nwindow.__tvConn = conn;\n` });
});
/** Starts or resumes the party and waits until `page` (the main TV) plays the song. */
const playOn = async (page) => {
  const room = app.room;
  const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
  if (!room.s.current) await room.request(asHost, { t: 'player.play' });
  else if (room.s.player.state !== 'playing') await room.request(asHost, { t: 'player.resume' });
  return until(async () => room.s.player.state === 'playing' && (await page.evaluate(() => window.__tvController.engine.playing)), 20000);
};

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
  await host.keyboard.press('Escape');

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
  const mirrorFrames = recordFrames(tv2);
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
  await exposeController(remote);
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
  const boardFrames = recordFrames(boardPage);
  await boardPage.goto(`${base}/tv?layout=board`);
  await boardPage.waitForSelector('.board');
  const rows = await boardPage.$$eval('.board-list li', (l) => l.length);
  check(rows === Math.min(8, app.room.s.queue.length), `queue board lists who sings next (${rows})`);
  check(!(await boardPage.$('.start')), 'the board needs no click (it is muted)');
  await shot(boardPage, 'tv-board');

  // The TV page reloads mid-song: the board and the mirror stay muted, the TV plays again.
  const mains = () => app.hub.list((c) => c.role === 'tv' && c.data.display === 'main');
  check(await playOn(remote) && mains().length === 1 && mains()[0].data.kind === 'main', 'the TV page plays the song');
  await remote.reload();
  check(await until(() => mains().length === 1 && mains()[0].data.kind === 'main' && mains()[0].open, 10000), 'after a reload the TV page is the main display again');
  const promoted = [...boardFrames, ...mirrorFrames].filter((f) => /"t":"display","display":"main"/.test(f)).length;
  check(promoted === 0, `the board and the mirror never took the sound (${promoted})`);
  await remote.waitForSelector('.scene, .lobby, .intro');
  check(!(await remote.$('.mirror-badge')) && !(await boardPage.$('.start')), 'the TV is not a muted mirror; the board still needs no click');

  // Settings → Displays: what each screen is, and the host picks the main display.
  await host.goto(`${base}/host#/settings/displays`);
  await host.waitForSelector('.display-row');
  const labels = await host.$$eval('.display-row b', (l) => l.map((x) => x.textContent).sort());
  check(labels.join('|') === 'Main TV — plays the sound|Mirror — muted|Queue board — muted', `displays are labelled (${labels.join(', ')})`);
  check((await host.$$('.display-row .btn')).length === 1, 'only the mirror can be made the main display');
  await shot(host, 'host-displays');
  await host.click('.display-row:has-text("Mirror — muted") .btn:has-text("Make main")');
  check(await until(() => mains()[0]?.data.kind === 'mirror', 5000), 'the host made the mirror the main display');
  check(await remote.waitForSelector('.mirror-badge', { timeout: 5000 }).then(() => true, () => false), 'the TV page is muted now');
  const hostPhone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'host-phone');
  await hostPhone.goto(`${base}/host#/settings/displays`);
  await hostPhone.waitForSelector('.display-row .btn');
  await hostPhone.evaluate(() => document.querySelector('.display-row')?.scrollIntoView({ block: 'center' }));
  check(await hostPhone.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'Displays fit a phone without sideways scrolling');
  await shot(hostPhone, 'host-displays-phone');
  await hostPhone.close();
  await host.click('.display-row .btn:has-text("Make main")');
  check(await until(() => mains()[0]?.data.kind === 'main', 5000), 'and gave the sound back to the TV page');
  await boardPage.close();

  // "Forget paired screens": the paired TV goes quiet at once (nothing would stop it later).
  app.hub.onHello = (client, msg) => {
    if (msg.role === 'tv' && !msg.display) client.isLocal = false;
    return hello(client, msg);
  };
  await remote.reload();
  await remote.waitForSelector('.scene, .lobby, .intro');
  check(await until(() => mains()[0] && !mains()[0].isLocal, 10000), 'the TV page is a paired screen again');
  check(await playOn(remote), 'the paired screen plays the song');
  host.once('dialog', (d) => d.accept());
  await host.click('.setting:has-text("Forget paired screens") .btn');
  await remote.waitForSelector('.pair-code b', { timeout: 10000 });
  const quiet = await remote.evaluate(() => ({ playing: window.__tvController.engine.playing, entry: window.__tvController.entryId, outbox: window.__tvConn.outbox.length }));
  check(!quiet.playing && !quiet.entry && quiet.outbox === 0, `the forgotten screen stops playing (${JSON.stringify(quiet)})`);
  await shot(remote, 'remote-tv-forgotten');
  await remote.close();
  app.hub.onHello = hello;

  // The TV's connection dies but the server still holds it (a network change; only the next
  // heartbeat would notice): the page reconnects and keeps the sound, it does not come back as
  // a muted mirror and then "stand in" for itself.
  const lossy = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'lossy-tv');
  await exposeController(lossy);
  const sockets = [];
  await lossy.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    if (!sockets.length) ws.onClose(() => {}); // the first connection: the server never hears it close
    sockets.push({ ws, server });
  });
  await lossy.goto(`${base}/tv`);
  await lossy.waitForSelector('.scene, .lobby, .intro');
  const tvClients = () => app.hub.list((c) => c.role === 'tv' && c.data.kind === 'main');
  const stale = mains()[0];
  check(!!stale && (await playOn(lossy)), 'a TV page plays the song');
  await sockets[0].ws.close();
  check(await until(() => sockets.length === 2 && mains()[0] && mains()[0] !== stale, 10000), 'the page reconnected');
  check(stale.open && stale.data.display === 'mirror', 'while the server still holds its dead connection (now muted)');
  check(!mains()[0].data.standIn && app.room.s.player.state === 'playing' && !app.room.s.player.displayLost, 'the page is still the main TV and the song goes on');
  await sockets[0].server.close();
  check(await until(() => !app.hub.clients.has(stale.id), 5000), 'the dead connection is dropped');
  check(mains().length === 1 && !mains()[0].data.standIn, 'the TV is not "standing in" for itself');
  check(!(await lossy.$('.mirror-badge')) && (await lossy.evaluate(() => window.__tvController.engine.playing)), 'the TV page never went quiet');
  const extra = watch(await browser.newPage({ viewport: { width: 640, height: 360 } }), 'extra-tv');
  await extra.goto(`${base}/tv`);
  await extra.waitForSelector('.mirror-badge');
  check(tvClients().length === 2 && mains().length === 1 && mains()[0] === tvClients()[0], 'so another TV page opened later is only a mirror');
  await extra.close();
  await lossy.close();

  // Live preview of the TV in the host.
  await host.click('.player button[title="Live preview of the TV"]');
  const frame = await (await host.waitForSelector('.tv-preview iframe')).contentFrame();
  check(await frame.waitForSelector('.scene, .lobby', { timeout: 10000 }).then(() => true, () => false), 'host shows a live preview of the TV');
  const tvs = app.hub.list((c) => c.role === 'tv').length;
  check(app.room.hostView().displays.length === tvs - 1, 'the preview is not listed as a display');
  await shot(host, 'host-tv-preview');
  await host.click('.tv-preview .icon-btn');
  // A refused preview never asks to be paired (no stray pairing request from the host's device).
  const waiting = app.room.waitingPairings().length;
  app.hub.onHello = (client, msg) => (msg.display === 'preview' ? { ok: false, reason: 'pairing_required' } : hello(client, msg));
  await host.click('.player button[title="Live preview of the TV"]');
  const refused = await (await host.waitForSelector('.tv-preview iframe')).contentFrame();
  check(await refused.waitForSelector('.denied:has-text("No preview")', { timeout: 10000 }).then(() => true, () => false), 'a refused preview says so');
  await sleep(1000);
  check(!(await refused.$('.pair-code')) && app.room.waitingPairings().length === waiting, 'and shows no pairing code');
  await shot(host, 'host-tv-preview-refused');
  app.hub.onHello = hello;
  await host.click('.tv-preview .icon-btn');

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
