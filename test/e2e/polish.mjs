#!/usr/bin/env node
// End-to-end checks of the M7 polish features in the host app: preview on this computer,
// "In queue" / "Sung tonight" marks, "Most sung here", printable songbook.
//
//   node test/e2e/polish.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep, WsClient } from './lib.mjs';
import { pngImage } from '../fake-art.js';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-polish');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
// Fake microphone and sound outputs; permission prompts are accepted (preview on headphones).
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
let expect429 = false; // a refused search is simulated below; Chrome logs the 429 itself
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !(expect429 && /status of 429/.test(m.text()))) errors.push(`${name}: ${m.text()}`); });
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

/**
 * Sound outputs the way Chrome shows them: without names (nor usable ids) until the page may
 * use a microphone. (Headless Chromium can't ask for real.) The first ask finds no microphone,
 * the test then plugs one in. `window.__media` records what the page did.
 */
function fakeMediaDevices() {
  const md = navigator.mediaDevices;
  const m = { mic: false, allowed: false, asked: 0, stopped: 0, sinks: [] };
  window.__media = m;
  md.enumerateDevices = async () => (m.allowed
    ? [
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Microphone' },
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - HDMI' },
      { kind: 'audiooutput', deviceId: 'hdmi', label: 'HDMI' },
      { kind: 'audiooutput', deviceId: 'hp', label: 'USB Headphones' },
    ]
    : [{ kind: 'audioinput', deviceId: '', label: '' }, { kind: 'audiooutput', deviceId: '', label: '' }]);
  md.getUserMedia = async () => {
    m.asked++;
    if (!m.mic) throw new DOMException('Requested device not found', 'NotFoundError');
    m.allowed = true;
    return { getTracks: () => [{ stop: () => { m.stopped++; } }] };
  };
  HTMLMediaElement.prototype.setSinkId = async function setSinkId(id) {
    m.sinks.push(id);
    if (id && !m.allowed) throw new DOMException('The page may not use this output', 'NotAllowedError');
  };
}

try {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await hostContext.addInitScript(fakeMediaDevices);
  const host = watch(await hostContext.newPage(), 'host');
  const openDetails = async () => {
    await host.goto(`${base}/host#/search?q=neon`);
    await host.fill('.search-box input', 'neon heart');
    await host.waitForSelector('.song-row');
    await host.click('.song-row');
    await host.waitForSelector('.preview-output');
  };
  const media = () => host.evaluate(() => window.__media);
  const pickButton = '.preview-output button:has-text("Choose headphones")';
  await openDetails();

  // Preview a version on the host computer.
  await host.waitForSelector('.versions .btn:has-text("Preview")');
  await host.click('.versions .btn:has-text("Preview") >> nth=0');
  check(await host.waitForSelector('.versions .btn:has-text("Stop")', { timeout: 8000 }).then(() => true, () => false), 'preview plays on the host computer');
  await shot(host, 'host-preview');
  await host.click('.versions .btn:has-text("Stop")');
  check(await host.waitForSelector('.versions .btn:has-text("Stop")', { state: 'detached', timeout: 5000 }).then(() => true, () => false), 'preview stops');
  // Headphones: the browser names its sound outputs once asked; the choice is kept.
  const plainHint = await host.$eval('.preview-output', (el) => el.textContent);
  check(!/like the TV/.test(plainHint), 'with no TV on this computer the hint doesn’t say the TV shares the output');
  check(!!(await host.$(pickButton)) && !(await host.$('.preview-output select')), 'outputs without names: “Choose headphones…” instead of a list');
  await host.click(pickButton);
  const noMicText = await host.waitForSelector('.preview-output .hint:has-text("no microphone")', { timeout: 5000 }).then((el) => el.textContent(), () => '');
  check(/Microphone: Allow/.test(noMicText) && (await media()).asked === 1 && !(await host.$('.preview-output select')),
    'without a microphone the host learns how to allow it in the site settings');
  check(!/Make the headphones the default|default output in the system/i.test(noMicText), 'and is never told to move the system’s default output');
  await host.evaluate(() => { window.__media.mic = true; });
  await host.click(pickButton);
  const listed = await host.waitForSelector('.preview-output select', { timeout: 5000 }).then(() => true, () => false);
  const options = await host.$$eval('.preview-output option', (l) => l.map((o) => `${o.value}=${o.textContent}`));
  check(listed && !(await host.$(pickButton)) && (await media()).stopped === 1, 'once allowed, the outputs are listed (and the microphone is let go at once)');
  check(JSON.stringify(options) === JSON.stringify(['=This computer’s default output', 'hdmi=HDMI', 'hp=USB Headphones']), `the list names every output but the default one (${options.join(', ')})`);
  await host.selectOption('.preview-output select', 'hp');
  await sleep(200);
  check(await host.evaluate(() => localStorage.getItem('ok.previewSink')) === 'hp' && (await media()).sinks.at(-1) === 'hp', 'the chosen output is used and remembered');
  await host.click('.versions .btn:has-text("Preview") >> nth=0');
  await host.waitForSelector('.versions .btn:has-text("Stop")', { timeout: 8000 });
  check((await media()).sinks.at(-1) === 'hp', 'the preview plays on the headphones');
  await host.click('.versions .btn:has-text("Stop")');
  // Another browser session without the permission: the default output for now, the choice kept.
  await host.reload();
  await openDetails();
  check(!!(await host.$(pickButton)), 'after a restart without the permission “Choose headphones…” is back');
  await host.click('.versions .btn:has-text("Preview") >> nth=0');
  await host.waitForSelector('.versions .btn:has-text("Stop")', { timeout: 8000 });
  const sinks = (await media()).sinks;
  check(JSON.stringify(sinks) === JSON.stringify(['hp', '']) && await host.evaluate(() => localStorage.getItem('ok.previewSink')) === 'hp',
    `the preview falls back to the default output and keeps the choice (${JSON.stringify(sinks)})`);
  await host.click('.versions .btn:has-text("Stop")');
  // Choosing the default output again forgets the headphones.
  await host.click(pickButton).catch(() => {});
  await host.evaluate(() => { window.__media.mic = true; });
  await host.click(pickButton).catch(() => {});
  if (await host.waitForSelector('.preview-output select', { timeout: 5000 }).then(() => true, () => false)) {
    await host.selectOption('.preview-output select', '');
    check(await host.evaluate(() => localStorage.getItem('ok.previewSink')) === null, 'choosing the default output again forgets the headphones');
  } else {
    check(false, 'the output list comes back once allowed again');
  }
  await host.keyboard.press('Escape');
  await host.waitForSelector('table.versions', { state: 'detached' });

  // A computer without a microphone (Chrome then won't name its outputs), alone and then with
  // the TV on it: the host learns how to allow it in the site settings, and is never told to
  // move the system's default output (the TV plays there). Once allowed, the outputs appear.
  const noMic = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host-no-mic');
  await noMic.addInitScript(() => {
    let allowed = false;
    const perm = new EventTarget();
    Object.defineProperty(perm, 'state', { get: () => (allowed ? 'granted' : 'prompt') });
    const md = navigator.mediaDevices;
    md.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
    md.enumerateDevices = async () => [{ kind: 'audiooutput', deviceId: allowed ? 'usb-headphones' : '', label: allowed ? 'USB headphones' : '', groupId: '' }];
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d?.name === 'microphone' ? Promise.resolve(perm) : query(d));
    window.allowMicrophone = () => {
      allowed = true;
      perm.dispatchEvent(new Event('change'));
    };
  });
  await noMic.goto(`${base}/host#/search?q=neon`);
  await noMic.fill('.search-box input', 'neon heart');
  await noMic.click('.song-row');
  await noMic.click('.preview-output button:has-text("Choose headphones")');
  const aloneNote = await noMic.waitForSelector('.preview-output .hint:has-text("no microphone")', { timeout: 5000 }).then((el) => el.textContent(), () => '');
  check(/Microphone: Allow/.test(aloneNote) && !/default output/i.test(aloneNote), `no microphone, no TV here: the note never mentions the system's default output (${aloneNote})`);
  const tvHere = new WsClient(`${base.replace('http', 'ws')}/ws`);
  await tvHere.open({ role: 'tv' });
  await noMic.waitForSelector('.preview-output .hint:has-text("like the TV")', { timeout: 5000 }).catch(() => {});
  const tvHint = await noMic.textContent('.preview-output .hint');
  check(/like the TV/.test(tvHint), `with the TV on this computer the hint says the party hears previews (${tvHint.trim()})`);
  await noMic.click('.preview-output button:has-text("Choose headphones")');
  const noMicNote = await noMic.waitForSelector('.preview-output .hint:has-text("the TV plays on it")', { timeout: 5000 }).then((el) => el.textContent(), () => '');
  check(/Site settings/.test(noMicNote) && /Microphone: Allow/.test(noMicNote), `no microphone: the note says how to allow it (${noMicNote})`);
  check(!/Make the headphones the default|default output in the system/i.test(noMicNote) && /Don’t change the system’s default output/.test(noMicNote), 'no microphone: the note never says to move the default output, which the TV uses');
  await shot(noMic, 'host-preview-no-mic');
  await noMic.evaluate(() => window.allowMicrophone());
  const allowedOutputs = await noMic.waitForSelector('.preview-output select', { timeout: 5000 })
    .then(() => noMic.$$eval('.preview-output option', (l) => l.map((o) => o.textContent)), () => []);
  check(allowedOutputs.includes('USB headphones'), `once the microphone is allowed in the site settings the outputs appear (${allowedOutputs.join(', ')})`);
  check(!(await noMic.$('.preview-output .hint:has-text("no microphone")')), 'and the note goes away');
  check(allowedOutputs[0] === 'This computer’s default output (the TV’s)', `the default output is marked as the TV’s (${allowedOutputs[0]})`);
  await noMic.close();
  tvHere.close();
  await sleep(200);

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
  const staleError = await host.$eval('.preview-output', (el) => el.querySelector('.warn-text')?.textContent || '');
  check(!staleError, `a preview stopped while loading shows no error afterwards${staleError ? ` (${staleError})` : ''}`);
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

  // Too many searches from one Wi-Fi: the phone says to wait (not "No songs found") and can retry.
  await bob.click('.g-tabs button:has-text("Songs")');
  await bob.waitForSelector('.g-songs .song-row');
  expect429 = true;
  await bob.route('**/api/search?*', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many searches — wait a few seconds.' }) }));
  await bob.fill('.g-search input', 'kitchen');
  check(await bob.waitForSelector('.empty:has-text("wait a few seconds") .btn:has-text("Try again")', { timeout: 5000 }).then(() => true, () => false), 'a refused search asks to wait, with a retry');
  check(!(await bob.$('.empty:has-text("No songs found")')), 'a refused search does not claim the song is missing');
  await shot(bob, 'bob-search-429');
  await bob.unroute('**/api/search?*');
  await bob.click('.empty .btn:has-text("Try again")');
  check(await bob.waitForSelector('.g-songs .song-row:has-text("Kitchen")', { timeout: 5000 }).then(() => true, () => false), 'Try again loads the results');
  expect429 = false;

  // Bob stays on the Songs tab: the invitation must reach him there (and survive a reload).
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
  check(await bob.waitForSelector('.g-dock .invite-card:has-text("Ann wants to sing")', { timeout: 5000 }).then(() => true, () => false), 'Bob sees the invitation on the Songs tab');
  check(await bob.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'the invitation fits the phone (no sideways scrolling)');
  await shot(bob, 'bob-invite');
  await bob.reload();
  check(await bob.waitForSelector('.g-dock .invite-card', { timeout: 8000 }).then(() => true, () => false), 'the invitation is still there after a reload');
  await bob.click('.invite-card .btn.primary');
  await sleep(400);
  const duet = app.room.s.queue.find((e) => e.title.startsWith('Singing In The Kitchen'));
  check(duet?.singerIds.length === 2 && duet.singerIds[1] === bobSinger.id, 'Bob accepted the duet invitation');
  check(await ann.waitForSelector('.toast:has-text("Bob will sing")', { timeout: 5000 }).then(() => true, () => false), 'Ann is told that Bob joined');
  check(await bob.waitForSelector('.invite-card', { state: 'detached', timeout: 5000 }).then(() => true, () => false), 'the answered invitation goes away');

  // Bob can turn invitations off on his Me tab (and back on).
  await bob.click('.g-tabs button:has(span:text-is("Me"))');
  const invitesSwitch = '.toggle-row:has-text("Duet invitations") input';
  await bob.setChecked(invitesSwitch, false);
  await sleep(300);
  await shot(bob, 'bob-me-invites-off');
  check(app.room.profileOf(bobSinger.deviceId)?.noInvites === true && !app.room.duetPartners().some((x) => x.id === bobSinger.id), 'Bob turned duet invitations off');
  await bob.setChecked(invitesSwitch, true);
  await sleep(300);
  check(!app.room.profileOf(bobSinger.deviceId)?.noInvites, 'and back on');

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
  // While someone sings it must not cover the lyrics: beside them on 16:9, only the name (at
  // the top) where there's no room beside them.
  const flashBox = () => tv2.evaluate(() => {
    const fig = document.querySelector('.photo-flash');
    if (!fig) return null;
    const a = fig.getBoundingClientRect();
    const b = document.getElementById('cdg').getBoundingClientRect();
    const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return { corner: fig.classList.contains('corner'), overlap, img: Math.round(fig.querySelector('img').getBoundingClientRect().width), right: Math.round(window.innerWidth - a.right) };
  });
  await sleep(800); // entrance animation
  const wide = await flashBox();
  check(wide?.corner && wide.overlap === 0 && wide.img > 80 && wide.right >= 0, `16:9: the photo sits beside the lyrics, not over them (${JSON.stringify(wide)})`);
  await shot(tv2, 'tv-photo-flash');
  for (const [w, h] of [[1280, 800], [1024, 768]]) {
    await tv2.setViewportSize({ width: w, height: h });
    await sleep(100);
    const narrow = await flashBox();
    check(narrow?.overlap === 0 && narrow.img === 0, `${w}×${h}: only the name, clear of the lyrics (${JSON.stringify(narrow)})`);
    await shot(tv2, `tv-photo-flash-${w}x${h}`);
  }
  await tv2.setViewportSize({ width: 1280, height: 720 });
  check(await host.waitForSelector('.section-title:has-text("On the TV (1)")', { timeout: 5000 }).then(() => true, () => false), 'the host Photos page counts the approved photo');
  await shot(host, 'host-photos');
  app.settings.update({ display: { background: 'photos' } });
  app.room.markDirty();
  check(await tv2.waitForSelector('#bg .photo-bg', { timeout: 5000 }).then(() => true, () => false), 'photos can be the TV background');
  app.settings.update({ display: { background: 'art' } });
  check(!!photoId, 'photo stored');
  // A pile of waiting photos: the host turns them all down at once, keeping the photo wall.
  const annId = app.room.photos.find(photoId)?.deviceId;
  for (const tag of ['a', 'b']) await app.room.photos.add(annId, pngImage(`waiting-${tag}`, 200), '10.0.0.1');
  app.room.markDirty();
  await host.waitForSelector('.photo-tile.pending >> nth=1');
  await shot(host, 'host-photos-waiting');
  await host.click('.section-title:has-text("Waiting for you") .btn:has-text("Don’t show any")');
  check(await host.waitForSelector('.section-title:has-text("Not shown (2)")', { timeout: 5000 }).then(() => true, () => false)
    && (await host.$$('.photo-tile.pending')).length === 0 && app.room.photos.counts().approved === 1, 'the host turns down every waiting photo at once (the approved one stays)');

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

  // On a phone the preview stays clear of the player, and taps go through it.
  const previewPhone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), 'host-phone');
  await previewPhone.goto(`${base}/host#/`);
  await previewPhone.waitForSelector('.player');
  await previewPhone.click('.player button[title="Live preview of the TV"]');
  await previewPhone.waitForSelector('.tv-preview iframe');
  const clear = await previewPhone.evaluate(() => {
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
  await shot(previewPhone, 'host-phone-tv-preview');
  await previewPhone.tap('.tv-preview .icon-btn');
  check(await previewPhone.waitForSelector('.tv-preview', { state: 'detached', timeout: 3000 }).then(() => true, () => false), 'phone: the TV preview closes from its ✕');
  await previewPhone.close();

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
