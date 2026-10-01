#!/usr/bin/env node
// End-to-end check of the three small party games, started from the host's Games page:
//  1. Pass the mic — runs alongside a song on the TV: "PASS THE MIC ➜ NAME" in a band along the
//     top edge that never covers a lyric line nor the join QR (16:9, 4:3, 5:4 and portrait),
//     long names shown in full, the holder's phone says "You have the mic!", the host passes it
//     on by hand; a very wide name never makes a phone (or the host on a phone) scroll sideways.
//  2. Applause meter — Chromium's fake microphone (a beep) on the TV: countdown, live gauge, a
//     score > 0, a second singer to compare (a 40-character label on a phone-sized host), the
//     TV letting go of the microphone when it loses the server, and a blocked microphone
//     reaching the host.
//  3. Party recap — after songs with ratings and reactions: slides on the TV (host next/goto,
//     auto-advance, tied singers sharing first place — long names kept on their own steps), the
//     compact recap on the phones, the applause winner among the games.
//
//   node test/e2e/game-party.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-game-party');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
// Fake mic (a beep) and no permission prompt: what bin/open-tv.sh does with the real mic.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = async (page, name, wait = 700) => {
  await sleep(wait);
  // (the host page: show the running game's controls, not wherever the last click scrolled to)
  await page.evaluate(() => document.querySelector('.game-live')?.scrollIntoView({ block: 'start' })).catch(() => {});
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const phone = async (name, width = 390, height = 844) => watch(await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const room = () => app.room;
const game = () => app.room.game;
/**
 * How far a phone's page scrolls sideways (0 = fits). Measured against the viewport the phone
 * was given, not innerWidth: a mobile browser widens its layout viewport (and zooms out) to fit
 * content that sticks out, so innerWidth grows with it and scrollWidth - innerWidth stays 0.
 */
const sideways = (page) => page.evaluate((width) => Math.max(document.documentElement.scrollWidth - width, innerWidth - width), page.viewportSize().width);
/**
 * The same for the host's page area on a phone (.main: the game controls), which scrolls by
 * itself. (Not the whole host page: its bottom navigation is wider than a 390 px phone since
 * M6/M7 added Games, Playlists and Photos — a separate fix.)
 */
const mainSideways = (page) => page.evaluate((width) => Math.max(...[...document.querySelectorAll('.main')].map((m) => Math.max(m.scrollWidth - m.clientWidth, m.getBoundingClientRect().right - width))), page.viewportSize().width);
const WIDE = 'W'.repeat(24); // the widest name a guest can pick
const LONG = 'Maximiliano Fernández'; // a long, real one
const until = async (pred, what, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred()) return true;
    await sleep(50);
  }
  throw new Error(`timeout: ${what}`);
};
const HOST = { role: 'host', data: {} };
const nameOf = (deviceId) => room().profileOf(deviceId)?.name;

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

/** Queues a song for `singerName` (host rules); it starts on the TV when nothing is on. */
function queue(title, singerName) {
  const song = room().catalog.search(title).items[0];
  const r = room().queueAdd(HOST, { songId: song.id, singerName });
  room().maybeAutoStart();
  room().markDirty();
  return r.entry;
}

async function openGame(host, label) {
  await host.click(`.game-card:has(h3:has-text("${label}")) .btn`);
  await host.waitForSelector('.game-card.open .g-setup');
}

/** Pass the mic to `deviceId` now (as the host's button does, but not left to chance). */
function passTo(deviceId) {
  const g = game();
  const pick = g.pick;
  g.pick = () => deviceId;
  try {
    g.pass('host');
  } finally {
    g.pick = pick;
  }
  room().markDirty();
}

/** Renames a guest (their phone, the TV and the host follow). */
function rename(deviceId, name) {
  room().s.profiles[deviceId].name = name;
  room().markDirty();
}

/** Waits for the TV's flash for `name` to be in place: its slide-in and pop animations done. */
async function flashFor(tv, name, timeout = 8000) {
  await tv.waitForFunction((n) => {
    const flash = document.querySelector('.rl-flash');
    if (flash?.querySelector('.name')?.textContent !== n) return false;
    return flash.getAnimations({ subtree: true }).filter((a) => /^rl-(in|pop)/.test(a.animationName)).every((a) => a.playState === 'finished');
  }, name, { timeout });
}

/**
 * Where the TV's "PASS THE MIC" flash sits: it must stay clear of the lyric lines — in the
 * margin above the lyrics canvas (any CDG pixel can be text), so above its first lit pixel
 * too — and of the join QR card in the corner, while still spanning the screen with a big name.
 */
async function flashGeometry(tv, name) {
  await flashFor(tv, name);
  return tv.evaluate(() => {
    const flash = document.querySelector('.rl-flash');
    const f = flash.getBoundingClientRect();
    const nameEl = flash.querySelector('.name');
    const parts = [...flash.querySelectorAll('.kick, .arrow, .avatar, .name')].map((e) => e.getBoundingClientRect());
    const qr = document.querySelector('.corner-qr')?.getBoundingClientRect();
    const canvas = document.getElementById('cdg');
    const c = canvas.getBoundingClientRect();
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = -1;
    for (let y = 0; y < canvas.height && lit < 0; y++) for (let x = 0; x < canvas.width; x++) if (px[(y * canvas.width + x) * 4 + 3] > 0) { lit = y; break; }
    return {
      top: flash.classList.contains('top'), flashTop: f.top, flashBottom: f.bottom, flashLeft: f.left, flashRight: f.right, flashWidth: f.width, overflow: flash.scrollWidth - flash.clientWidth,
      partsLeft: Math.min(...parts.map((r) => r.left)), partsRight: Math.max(...parts.map((r) => r.right)), qrLeft: qr ? qr.left : null,
      nameCut: nameEl.scrollWidth > nameEl.clientWidth + 1, nameSize: parseFloat(getComputedStyle(nameEl).fontSize), vw: innerWidth, vh: innerHeight,
      lyricsShown: canvas.classList.contains('show'), cdgTop: c.top, firstLit: lit < 0 ? null : c.top + (lit / canvas.height) * c.height,
    };
  });
}

function checkFlashClear(geo, what) {
  check(geo.top && geo.lyricsShown, `${what}: lyrics on screen, the flash is a band along the top edge`);
  check(geo.flashTop >= -0.5 && geo.flashBottom <= geo.cdgTop + 0.5, `${what}: the flash (${Math.round(geo.flashTop)}–${Math.round(geo.flashBottom)} px) stays above the lyrics (from ${Math.round(geo.cdgTop)} px)`);
  check(geo.firstLit === null || geo.flashBottom <= geo.firstLit, `${what}: no lyric pixel under the flash (first at ${Math.round(geo.firstLit ?? -1)} px)`);
  // Full width — up to the QR card when it's there (never over it).
  const reach = geo.qrLeft === null ? geo.vw : geo.qrLeft;
  check(geo.flashLeft <= 0.5 && geo.flashRight <= reach + 0.5 && geo.flashRight >= reach - geo.vw * 0.05, `${what}: the band spans the screen (${Math.round(geo.flashLeft)}–${Math.round(geo.flashRight)} px)${geo.qrLeft === null ? '' : `, short of the QR card (from ${Math.round(geo.qrLeft)} px)`}`);
  check(geo.nameSize >= Math.min(geo.vh, geo.vw) * 0.05 && geo.overflow <= 0 && geo.partsLeft >= 0 && geo.partsRight <= geo.flashRight, `${what}: still big — the name ${Math.round(geo.nameSize)} px tall, nothing sticking out`);
}

async function endAndClose(host) {
  await host.click('.game-live .btn:has-text("End game")');
  await host.waitForSelector('.game-live .btn:has-text("Close")', { timeout: 10000 });
  await host.click('.game-live .btn:has-text("Close")');
  await until(() => !game(), 'game closed');
}

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  host.on('dialog', (d) => d.accept());
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const phones = { Ann: await phone('ann'), Bob: await phone('bob'), Cat: await phone('cat'), [WIDE]: await phone('wide', 320, 640) };
  for (const [name, page] of Object.entries(phones)) await joinAs(page, name);
  const wide = Object.keys(room().s.profiles).find((id) => nameOf(id) === WIDE);
  const cat = Object.keys(room().s.profiles).find((id) => nameOf(id) === 'Cat');
  // The host on a phone (the PIN route; on this machine it's trusted): nothing may scroll sideways.
  const hostPhone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), 'host-phone');
  await hostPhone.goto(`${base}/host#/games`);
  await host.goto(`${base}/host#/games`);
  await host.waitForSelector('.game-card');
  const soon = await host.$$eval('.game-card', (l) => l.filter((c) => /Pass the mic|Applause meter|Party recap/.test(c.textContent) && c.classList.contains('soon')).length);
  check(soon === 0, 'the three games are no longer "coming soon"');

  // ---- 1. Pass the mic ------------------------------------------------------------------------------
  await openGame(host, 'Pass the mic');
  await host.selectOption('.game-card.open select >> nth=1', '5');
  await host.selectOption('.game-card.open select >> nth=2', '20');
  await shot(host, 'host-relay-setup', 200);
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .relay-control');
  check(game()?.type === 'relay' && game().config.everyone && game().config.min === 5 && game().config.max === 20, 'host started pass the mic (everyone, 5–20 s)');
  await phones.Bob.waitForSelector('.g-guest.relay', { timeout: 5000 });
  check(true, 'phones jump to the game tab');
  // Between songs the flash is big, across the middle; a long name gets a line of its own, in full.
  rename(wide, LONG);
  passTo(wide);
  await flashFor(tv, LONG, 5000);
  const lobbyFlash = await tv.evaluate(() => {
    const f = document.querySelector('.rl-flash');
    const n = f.querySelector('.name');
    const r = f.getBoundingClientRect();
    return { top: f.classList.contains('top'), cut: n.scrollWidth > n.clientWidth + 1, inside: r.left >= 0 && r.right <= innerWidth && f.scrollWidth <= f.clientWidth, size: parseFloat(getComputedStyle(n).fontSize), vh: innerHeight };
  });
  check(!lobbyFlash.top && lobbyFlash.size >= lobbyFlash.vh * 0.12 && lobbyFlash.inside, 'between songs: a big flash across the middle of the TV');
  check(!lobbyFlash.cut, `…with "${LONG}" in full`);
  await shot(tv, 'tv-relay-flash-lobby', 0);
  rename(wide, WIDE);
  queue('neon heart', 'Ann');
  await until(() => room().s.current && room().s.player.state === 'playing', 'the song plays on the TV', 30000);
  check(!room().gameBlocks(), 'pass the mic runs alongside the karaoke');
  const ann = Object.keys(room().s.profiles).find((id) => nameOf(id) === 'Ann');
  check(game().holder === ann, 'Ann sings: she starts with the mic');
  const passesAtStart = game().passes; // (the lobby flash above was a pass too)
  game().remaining = 1500; // (don't wait up to 20 s for the first pass)
  await until(() => game().passes > passesAtStart, 'the mic passes by itself', 10000);
  const first = game().holder;
  // (from here on the test passes the mic itself: no surprise pass while it looks at a screen)
  game().drawInterval = () => 600_000;
  game().remaining = 600_000;
  await tv.waitForFunction((n) => document.querySelector('.rl-flash')?.textContent.includes(n), nameOf(first), { timeout: 10000 });
  const flashText = (await tv.textContent('.rl-flash')).replace(/\s+/g, ' ');
  check(first && first !== ann, `the mic passed on by itself to ${nameOf(first)}, not back to Ann`);
  check(/pass the mic/i.test(flashText) && flashText.includes(nameOf(first)), `TV flashes "PASS THE MIC ➜ ${nameOf(first)}"`);
  check(room().s.player.state === 'playing', '…while the song plays');
  checkFlashClear(await flashGeometry(tv, nameOf(first)), 'TV 16:9');
  await shot(tv, 'tv-relay-flash', 0);
  const holderPhone = phones[nameOf(first)];
  await holderPhone.waitForSelector('.rl-mine', { timeout: 5000 });
  check(/You have the mic/.test(await holderPhone.textContent('.rl-mine')), 'the holder’s phone says "You have the mic!"');
  await shot(holderPhone, 'phone-relay-mine', 300);
  const other = Object.entries(phones).find(([n]) => n !== nameOf(first))[1];
  const seen = await other.waitForFunction((n) => document.querySelector('.g-guest.relay')?.textContent.includes(n), nameOf(first), { timeout: 5000 }).then(() => true, () => false);
  check(seen && !(await other.$('.rl-mine')), 'other phones see who has the mic');
  const passesBefore = game().passes; // (the lobby flash above was a pass too)
  await host.click('.game-live .btn:has-text("Pass the mic now")');
  await until(() => game().passes > passesBefore, 'host passes the mic');
  check(game().holder !== first, `the host passed it on to ${nameOf(game().holder)} (never the same twice)`);
  await tv.waitForFunction((n) => document.querySelector('.rl-flash')?.textContent.includes(n), nameOf(game().holder), { timeout: 5000 });
  check(true, 'TV flashes the new holder');
  await tv.waitForSelector('.rl-badge', { timeout: 8000 });
  check((await tv.textContent('.rl-badge')).includes(nameOf(game().holder)), 'after the flash a small badge shows who has the mic');
  await shot(tv, 'tv-relay-badge', 200);
  await shot(host, 'host-relay-control', 100);
  // With a page of lyrics up: the flash stays in the band above them, and a long name fits.
  room().seek({ pos: 5 }); // (the demo song is short: back to its first lines)
  room().markDirty();
  await sleep(1200);
  rename(wide, LONG);
  passTo(wide);
  let geo = await flashGeometry(tv, LONG);
  checkFlashClear(geo, 'TV 16:9, lyrics up');
  check(!geo.nameCut, `…"${LONG}" in full`);
  await shot(tv, 'tv-relay-flash-lyrics', 0);
  // The widest name a guest can pick: cut short on the TV, and no phone scrolls sideways.
  rename(wide, WIDE);
  passTo(cat);
  await flashGeometry(tv, 'Cat');
  passTo(wide);
  geo = await flashGeometry(tv, WIDE);
  checkFlashClear(geo, `TV 16:9, ${WIDE.length} W’s`);
  await phones.Ann.waitForFunction((n) => document.querySelector('.rl-now')?.textContent.includes(n), WIDE, { timeout: 5000 });
  await phones.Bob.setViewportSize({ width: 320, height: 640 });
  await sleep(300);
  for (const [name, p] of Object.entries(phones)) {
    if (name === WIDE) continue;
    check(await sideways(p) <= 0, `${name}'s phone (${p.viewportSize().width} px) doesn’t scroll sideways while ${WIDE.length} W’s have the mic`);
  }
  await shot(phones.Bob, 'phone-relay-wide-name', 0);
  await phones.Bob.setViewportSize({ width: 390, height: 844 });
  await hostPhone.waitForSelector('.relay-control .rl-holder', { timeout: 5000 });
  check(await mainSideways(hostPhone) <= 0, 'the host’s game controls on a phone don’t scroll sideways either');
  await shot(hostPhone, 'host-phone-relay', 0);
  // Other TV shapes: taller margins above the lyrics (from 5:4 two lines, the name on its own)
  // and narrower lines — the band still fits above the lyrics, a long name still in full.
  rename(wide, LONG);
  for (const [width, height, shape] of [[1024, 768, '4:3'], [1280, 1024, '5:4'], [768, 1024, 'portrait']]) {
    await tv.setViewportSize({ width, height });
    room().seek({ pos: 5 });
    room().markDirty();
    passTo(ann);
    checkFlashClear(await flashGeometry(tv, 'Ann'), `TV ${shape}`);
    passTo(wide);
    geo = await flashGeometry(tv, LONG);
    checkFlashClear(geo, `TV ${shape}, "${LONG}"`);
    check(!geo.nameCut, `…"${LONG}" in full`);
    await shot(tv, `tv-relay-flash-${shape.replace(':', 'x')}`, 0);
  }
  rename(wide, WIDE);
  await tv.setViewportSize({ width: 1280, height: 720 });
  const passes = game().passes;
  room().pause();
  room().markDirty();
  game().remaining = 500;
  await sleep(1500);
  check(game().passes === passes && game().phase === 'waiting', 'paused song: the mic stays put');
  room().resume();
  room().markDirty();
  await endAndClose(host);
  check(room().s.current?.title === 'Neon Heart', 'closing the game leaves the song playing');

  // ---- songs with reactions and ratings (for the recap) ----------------------------------------
  await phones.Bob.waitForSelector('.reaction-grid button', { timeout: 8000 });
  for (let i = 0; i < 3; i++) {
    await phones.Bob.click('.reaction-grid button >> nth=0');
    await sleep(120);
  }
  await until(() => (room().s.current?.reactions || 0) >= 3, 'reactions counted');
  const finishSong = async (raters, stars) => {
    const id = room().s.current.id;
    room().seek({ pos: Math.max(0, room().s.player.dur - 1.2) });
    room().markDirty();
    await until(() => !room().s.current || room().s.current.id !== id, 'the song ends on the TV', 20000);
    for (const p of raters) {
      await p.waitForSelector('.rate-card', { timeout: 8000 });
      await p.click(`.rate-stars button >> nth=${stars - 1}`);
    }
    await until(() => room().rating?.votes.size === raters.length, 'ratings counted');
    room().closeRating();
    room().markDirty();
  };
  await finishSong([phones.Bob, phones.Cat], 5);
  queue('tempo tantrum', 'Bob');
  await until(() => room().s.current && room().s.player.state === 'playing', 'the second song plays', 30000);
  await finishSong([phones.Ann, phones.Cat], 3);
  const done = room().s.tonight.history.filter((h) => !h.skipped);
  check(done.length === 2 && done.every((h) => h.rating), 'two songs sung and rated');

  // ---- 2. Applause meter ------------------------------------------------------------------------------
  await until(() => !room().s.current, 'nothing playing');
  await openGame(host, 'Applause meter');
  await host.fill('.game-card.open input', 'Ann');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .applause-control');
  check(game()?.type === 'applause' && game().phase === 'countdown', 'host started the applause meter for Ann');
  await tv.waitForSelector('.g-tv.applause .ap-count', { timeout: 5000 });
  await shot(tv, 'tv-applause-countdown', 300);
  await until(() => game().phase === 'measure', 'measuring', 6000);
  await until(() => game().levels.length >= 3, 'the TV reports levels', 5000);
  check(true, `the TV reports live levels (${game().levels.length} so far)`);
  await shot(tv, 'tv-applause-measure', 1200);
  await shot(phones.Cat, 'phone-applause-measure', 0);
  await until(() => game().phase === 'result', 'result', 12000);
  const r1 = game().results[0];
  check(r1 && r1.score > 0 && !r1.estimated, `the fake mic scored ${r1?.score} (final report from the TV)`);
  await tv.waitForSelector('.g-tv.applause .ap-list li', { timeout: 5000 });
  await shot(tv, 'tv-applause-result', 2000);
  await shot(phones.Ann, 'phone-applause-result', 0);
  const family = 'Grandma Josephine & the Wonderful Family'; // 40 characters, the longest label
  await host.fill('.ap-next input', family);
  await host.click('.ap-next .btn:has-text("Next measurement")');
  await until(() => game().results.length === 2 && game().phase === 'result', 'second measurement', 15000);
  check(game().results[1].label === family && game().results[1].score > 0, `the family scored ${game().results[1].score}`);
  await tv.waitForFunction(() => document.querySelectorAll('.g-tv.applause .ap-list li').length === 2, null, { timeout: 5000 });
  check(true, 'TV compares both results');
  check((await host.$$('.applause-control .ap-list li.best')).length >= 1, 'host sees the loudest marked');
  await shot(tv, 'tv-applause-compare', 2000);
  await shot(host, 'host-applause-control', 0);
  await hostPhone.waitForFunction((l) => document.querySelector('.ap-next .btn.ap-again')?.textContent.includes(l), family, { timeout: 5000 });
  check(await mainSideways(hostPhone) <= 0, 'host on a phone: "Measure … again" with a 40-character name doesn’t scroll sideways');
  await hostPhone.evaluate(() => document.querySelector('.game-live')?.scrollIntoView({ block: 'start' }));
  await shot(hostPhone, 'host-phone-applause', 300);
  for (const [name, p] of Object.entries(phones)) check(await sideways(p) <= 0, `${name}'s phone: the applause results fit`);
  // The TV loses the server in the middle of a measurement: it lets go of the microphone at once
  // (and doesn't keep listening on the last state it got).
  await tv.evaluate(() => {
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__mics = [];
    navigator.mediaDevices.getUserMedia = async (c) => {
      const stream = await open(c);
      window.__mics.push(stream);
      return stream;
    };
  });
  await host.click('.ap-next .btn:has-text("again")');
  await tv.waitForFunction(() => window.__mics.length > 0 && window.__mics.at(-1).getTracks().some((t) => t.readyState === 'live'), null, { timeout: 8000 });
  check(['countdown', 'measure'].includes(game().phase), `the TV listens (${game().phase})`);
  await tv.evaluate(() => {
    window.__RealWebSocket = window.WebSocket;
    window.WebSocket = class extends window.__RealWebSocket { constructor() { super('ws://127.0.0.1:9/'); } }; // the server is gone
  });
  for (const c of app.hub.list((x) => x.role === 'tv' && x.data.display === 'main')) c.close(1001, 'test: server gone');
  await tv.waitForSelector('.conn-lost', { timeout: 5000 });
  const released = await tv.waitForFunction(() => window.__mics.every((s) => s.getTracks().every((t) => t.readyState === 'ended')), null, { timeout: 2500 }).then(() => true, () => false);
  check(released, 'the TV lets go of the microphone as soon as it loses the server');
  game().action(HOST, { action: 'cancel' });
  room().markDirty();
  await tv.evaluate(() => { window.WebSocket = window.__RealWebSocket; });
  await tv.waitForSelector('.conn-lost', { state: 'detached', timeout: 15000 });
  await until(() => app.hub.list((x) => x.role === 'tv' && x.data.display === 'main').length === 1, 'the TV is back', 10000);
  check(true, 'the TV reconnects');
  // (its tries to reach the dead address meanwhile are expected console errors)
  for (let i = errors.length - 1; i >= 0; i--) if (errors[i].startsWith('tv: ') && errors[i].includes('ws://127.0.0.1:9/')) errors.splice(i, 1);
  // A blocked microphone reaches the host with a hint.
  await tv.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await host.click('.ap-next .btn:has-text("again")');
  await host.waitForSelector('.ap-error', { timeout: 8000 });
  const hint = await host.textContent('.ap-error');
  check(/blocked the microphone/.test(hint) && /Allow the microphone on the TV computer \(Chrome asks once\)/.test(hint), 'a blocked mic shows "Allow the microphone on the TV computer"');
  await shot(host, 'host-applause-mic-error', 0);
  check(game().results.length === 2, 'earlier results are kept');
  const winner = game().best().map((r) => r.label);
  await endAndClose(host);
  const rec = room().s.tonight.games.at(-1);
  check(rec?.type === 'applause' && rec.title === 'Loudest applause' && rec.winners.join() === winner.join(), `applause winner remembered for the recap (${winner.join(' & ')})`);

  // ---- 3. Party recap ------------------------------------------------------------------------------------
  await openGame(host, 'Party recap');
  await host.selectOption('.game-card.open select', '5');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .recap-control');
  const g = game();
  check(g?.type === 'recap' && g.recap.totals.songs === 2, 'host started the recap: 2 songs tonight');
  check(g.slides.join() === 'totals,singers,rated,artists,favourite,games,thanks', `all slides (${g.slides.join(', ')})`);
  await tv.waitForSelector('.g-tv.recap .rc-totals', { timeout: 5000 });
  check(/What a night/.test(await tv.textContent('.rc-totals')), 'TV: "What a night!" totals slide');
  await shot(tv, 'tv-recap-totals', 1600);
  await host.click('.recap-control .btn:has-text("Next")');
  await tv.waitForSelector('.rc-singers .g-podium', { timeout: 5000 });
  check(true, 'host → next: top singers podium');
  const places = await tv.$$eval('.rc-singers .g-podium .step', (l) => l.map((s) => `${s.querySelector('b').textContent} ${s.querySelector('.block').textContent} ${s.className}`));
  check(places.length === 2 && places.every((p) => / 1 step p1$/.test(p)), `one song each: Ann and Bob share first place (${places.join('; ')})`);
  await shot(tv, 'tv-recap-singers', 900);
  // Tied singers with long names stand side by side at the same height: each name stays on its step.
  const renamed = [['Ann', 'Grandma Josephine & Co'], ['Bob', LONG]].map(([from, to]) => {
    const singer = room().s.singers.find((x) => x.name === from);
    singer.name = to;
    return [singer, from];
  });
  g.rebuild({ restart: false });
  await tv.waitForFunction((n) => document.querySelector('.rc-singers .g-podium')?.textContent.includes(n), LONG, { timeout: 5000 });
  const steps = await tv.$$eval('.rc-singers .g-podium .step', (l) => l.map((s) => {
    const b = s.querySelector('b').getBoundingClientRect();
    const r = s.getBoundingClientRect();
    return { left: b.left, right: b.right, stepLeft: r.left, stepRight: r.right };
  }).sort((a, b) => a.left - b.left));
  check(steps.length === 2 && steps.every((s) => s.left >= s.stepLeft - 0.5 && s.right <= s.stepRight + 0.5) && steps[0].right <= steps[1].left,
    `tied long names (“${LONG}”) stay on their own steps, never over each other`);
  await shot(tv, 'tv-recap-singers-long-tie', 300);
  for (const [singer, name] of renamed) singer.name = name;
  g.rebuild({ restart: false });
  for (const [i, sel, name] of [[2, '.rc-rated', 'rated'], [3, '.rc-artists', 'artists'], [4, '.rc-fav', 'favourite'], [5, '.rc-games', 'games'], [6, '.rc-thanks', 'thanks']]) {
    await host.click(`.rc-slides .chip >> nth=${i}`);
    await tv.waitForSelector(sel, { timeout: 5000 });
    await shot(tv, `tv-recap-${name}`, 1200);
  }
  check((await tv.$$('.rc-thanks')).length === 1, 'host jumps between slides; the last one says thanks');
  await host.click('.rc-slides .chip >> nth=5');
  await tv.waitForSelector('.rc-games', { timeout: 5000 });
  check((await tv.textContent('.rc-games')).includes('Loudest applause'), 'game winners include the applause meter');
  await host.click('.rc-slides .chip >> nth=4');
  await tv.waitForSelector('.rc-fav', { timeout: 5000 });
  check((await tv.textContent('.rc-fav')).includes('Neon Heart'), 'crowd favourite: the song with the reactions');
  await host.click('.rc-slides .chip >> nth=0');
  await until(() => game().index === 1, 'auto-advance', 9000);
  check(true, 'slides advance by themselves');
  await phones.Cat.waitForSelector('.g-guest.recap .rc-card', { timeout: 5000 });
  const cards = await phones.Cat.$$eval('.g-guest.recap .rc-card h2', (l) => l.map((x) => x.textContent));
  check(cards.includes('Top singers') && cards.includes('Best rated') && cards.includes('Game winners'), `phones show the compact recap (${cards.join(', ')})`);
  await shot(phones.Cat, 'phone-recap', 0);
  await phones.Cat.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(300);
  await phones.Cat.screenshot({ path: path.join(out, 'phone-recap-bottom.png') });
  await shot(host, 'host-recap-control', 0);
  for (const [name, p] of Object.entries(phones)) {
    check(await sideways(p) <= 0, `${name}'s phone (${p.viewportSize().width} px) fits without sideways scrolling`);
  }
  check(await mainSideways(hostPhone) <= 0, 'the host’s recap controls on a phone fit without sideways scrolling');
  await endAndClose(host);
  await tv.waitForSelector('.lobby', { timeout: 10000 });
  check(true, 'after the recap the TV goes back to the lobby');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: path.join(out, `failure-${Math.random().toString(36).slice(2, 6)}.png`) }).catch(() => {});
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
  // This run's own temporary library and data (the disk is shared with other test runs).
  for (const dir of [app.dataDir, ...app.library.paths]) if (dir?.includes('ok-e2e-')) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
