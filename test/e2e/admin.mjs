#!/usr/bin/env node
// End-to-end checks of the host's admin panel: the Queue / Playback / Devices tabs, the slim
// player bar, the live preview (only while it can be seen, the big view, hide), the TV settings
// at hand, the Devices list (Identify, Make main, pairing, guests), and the phones' Control
// pages with the mini player — in both skins.
//
//   node test/e2e/admin.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-admin');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
let expectKick = false;
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !(expectKick && /kicked|1006|4002/.test(m.text()))) errors.push(`${name}: ${m.text()}`); });
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
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const seen = (page, sel, timeout = 5000) => page.waitForSelector(sel, { timeout }).then(() => true, () => false);
const previews = () => app.hub.list((c) => c.role === 'tv' && c.data.preview && c.open).length;
const noSideways = (page) => page.evaluate(() => {
  const main = document.querySelector('.main');
  return document.documentElement.scrollWidth - innerWidth <= 0 && (!main || main.scrollWidth - main.clientWidth <= 0);
});
const tab = (page, name) => page.click(`.admin-panel [role=tab]:has-text("${name}")`);
const phone = async (name, width = 390, height = 844) => watch(await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const mirror = watch(await browser.newPage({ viewport: { width: 960, height: 540 } }), 'mirror');
  await mirror.goto(`${base}/tv?display=mirror`);
  await mirror.waitForSelector('.lobby');
  const board = watch(await browser.newPage({ viewport: { width: 960, height: 540 } }), 'board');
  await board.goto(`${base}/tv?layout=board`);
  await board.waitForSelector('.board');
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.admin-panel [role=tab]');

  // ---- the panel's tabs ---------------------------------------------------------------------
  const tabs = await host.$$eval('.admin-panel [role=tab]', (l) => l.map((b) => b.querySelector('span').textContent.trim()));
  check(tabs.join() === 'Queue,Playback,Devices', `the panel's tabs (${tabs})`);
  await tab(host, 'Playback');
  await host.reload();
  check(await seen(host, '#ptab-playback[aria-selected="true"]'), 'the chosen tab is remembered after a reload');
  await host.focus('#ptab-playback');
  await host.keyboard.press('ArrowRight');
  check(await seen(host, '#ptab-devices[aria-selected="true"]:focus'), 'arrow keys move between the tabs');
  await host.keyboard.press('Home');
  check(await seen(host, '#ptab-queue[aria-selected="true"]'), 'Home goes to the first tab');

  // ---- Queue: requests, tonight -------------------------------------------------------------
  const code = app.settings.get('party.roomCode');
  const ben = await phone('Ben');
  await ben.goto(`${base}/j/${code}`);
  await ben.waitForSelector('.profile-form');
  await ben.fill('.profile-form input', 'Ben');
  await ben.click('.profile-form .btn.primary');
  await ben.waitForSelector('.g-tabs');
  await hostReq('settings.update', { patch: { queue: { requireApproval: true }, playback: { countdown: 60 } } });
  await ben.click('.g-tabs button:has-text("Songs")');
  await ben.fill('.g-search input', 'kitchen');
  await ben.click('.g-songs .song-row:has-text("Kitchen")');
  await ben.click('.sheet .btn.primary');
  await ben.waitForSelector('.sheet-done');
  await ben.click('.sheet-done .btn');
  await host.click('.admin-panel .segmented button:has-text("Requests")');
  check(await seen(host, '.admin-panel .q-item .icon-btn.ok'), 'Requests lists Ben’s request');
  await host.click('.admin-panel .q-item .icon-btn.ok');
  check(await until(() => !room.s.pending.length && (room.s.current || room.s.queue[0])?.title === 'Singing In The Kitchen'), 'approved from the Requests segment');
  await hostReq('settings.update', { patch: { queue: { requireApproval: false } } });
  const neon = app.library.catalog.search('neon heart').items[0];
  await hostReq('queue.add', { songId: neon.id, singerName: 'Ann' });
  if (!room.s.current) await hostReq('player.play');
  await hostReq('player.next'); // skip the first song
  await host.click('.admin-panel .segmented button:has-text("Tonight")');
  check(await seen(host, '.admin-panel .q-item:has-text("Skipped")'), 'Tonight lists the skipped song');
  check(await host.getAttribute('#ptab-queue', 'aria-selected') === 'true', 'no tab switched by itself');
  await host.click('.admin-panel .segmented button:has-text("Up next")');

  // ---- Playback: sound ------------------------------------------------------------------------
  check(await until(() => room.s.current), 'a song is on');
  await tab(host, 'Playback');
  await host.click('#pb-sound .stepper >> nth=0 >> button[aria-label="Key up"]');
  await host.click('#pb-sound .stepper >> nth=1 >> button[aria-label="Tempo up"]');
  check(await until(() => room.s.player.key === 1 && room.s.player.tempo === 1.05), 'key and tempo from the Sound section');
  await host.selectOption('#pb-sound select[aria-label="Channel mode"]', 'left');
  check(await until(() => room.s.player.channel === 'left'), 'channel mode from the Sound section');
  check((await host.$$('.player .stepper')).length === 0 && (await host.$$('input[aria-label="Volume"]')).length === 1, 'the bar has no key/tempo; one volume control');
  let tune = null;
  await until(async () => {
    tune = (await host.$eval('.player .tune-pill', (el) => el.textContent).catch(() => null))?.replace(/\s+/g, ' ').trim();
    return tune === 'Key +1 · 105%';
  });
  check(tune === 'Key +1 · 105%', `the bar shows the key and tempo (${tune})`);
  await tab(host, 'Queue');
  await host.click('.player .tune-pill');
  check(await seen(host, '#ptab-playback[aria-selected="true"]') && await until(async () => host.evaluate(() => { const r = document.getElementById('pb-sound')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.top < innerHeight; })), 'the key/tempo pill opens the Sound controls');
  await tab(host, 'Queue');
  await host.click('.player .tv-status.on');
  check(await seen(host, '#ptab-playback[aria-selected="true"]') && await until(async () => host.evaluate(() => { const r = document.getElementById('pb-video')?.getBoundingClientRect(); return !!r && r.top < innerHeight; })), '“TV on” opens the video controls');
  await shot(host, 'host-playback');

  // ---- Playback: the live preview -------------------------------------------------------------
  const frameEl = await host.waitForSelector('.preview-frame iframe');
  const frame = await frameEl.contentFrame();
  check(await frame.waitForSelector('.scene, .lobby, .intro', { timeout: 10000 }).then(() => true, () => false), 'the preview shows the TV');
  const lite = await frame.evaluate(() => ({ cls: document.body.classList.contains('preview'), anim: [...document.querySelectorAll('.aurora i')].every((i) => getComputedStyle(i).animationName === 'none') }));
  check(lite.cls && lite.anim, `the preview is the light version (${JSON.stringify(lite)})`);
  let most = 0;
  for (let i = 0; i < 3; i++) {
    await tab(host, 'Queue');
    most = Math.max(most, previews());
    await tab(host, 'Playback');
    await sleep(300);
    most = Math.max(most, previews());
  }
  check(most <= 1, `never more than one preview (${most})`);
  await tab(host, 'Queue');
  check(await until(() => previews() === 0, 3000), 'none once the Playback tab is left');
  await tab(host, 'Playback');
  const f2 = await (await host.waitForSelector('.preview-frame iframe')).contentFrame();
  await f2.waitForSelector('.scene, .lobby, .intro');
  await f2.evaluate(() => { window.__mark = 1; });
  await host.click('.preview-frame button[aria-label="Show the preview bigger"]');
  check(await seen(host, '.preview-frame.theatre') && await seen(host, '.preview-backdrop'), 'Bigger: the preview fills the window');
  check(await f2.evaluate(() => window.__mark === 1).catch(() => false), 'without reloading it');
  await shot(host, 'host-preview-big');
  await host.keyboard.press('Escape');
  check(await until(async () => !(await host.$('.preview-frame.theatre'))) && await host.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Show the preview bigger', 'Esc closes it; the focus is back on Bigger');
  await host.click('.preview-frame button[aria-label="Hide the preview"]');
  check(await seen(host, '.preview-off'), 'Hide');
  await host.reload();
  await host.waitForSelector('#pb-video');
  check(!!(await host.$('.preview-off')) && !(await host.$('.preview-frame')), 'stays hidden after a reload');
  await host.click('.preview-off');
  check(await seen(host, '.preview-frame iframe'), 'Show brings it back');

  // ---- Playback: on the TV ----------------------------------------------------------------------
  const toastsBefore = await host.$$eval('.toast', (l) => l.length);
  await host.click('#pb-quick summary');
  await host.selectOption('#pb-quick select[aria-label="Background"]', 'plain');
  check(await until(() => app.settings.get('display.background') === 'plain') && await seen(tv, '.plain-bg'), 'Background → Plain on the TV');
  await host.click('#pb-quick .stepper button[aria-label="Lyrics up"]');
  check(await until(() => app.settings.get('playback.lyricOffsetMs') === 50), 'lyrics timing +50 ms');
  const qr = app.settings.get('display.showQr');
  await host.click('#pb-quick .switch');
  check(await until(() => app.settings.get('display.showQr') === !qr), 'the corner QR switch');
  await sleep(300);
  check(!(await host.$('.toast:has-text("Saved")')) && (await host.$$eval('.toast', (l) => l.length)) <= toastsBefore, 'no “Saved” toasts for these');
  await hostReq('settings.update', { patch: { display: { background: 'visualizer', showQr: qr }, playback: { lyricOffsetMs: 0 } } });

  // ---- Devices ----------------------------------------------------------------------------------
  await tab(host, 'Devices');
  await host.waitForSelector('.display-row');
  const names = await host.$$eval('.display-row .grow b', (l) => l.map((b) => b.textContent));
  check(names.join() === 'Main TV,Mirror 1,Queue board 1', `the screens (${names})`);
  check(await seen(host, '.display-row:has-text("Main TV") .pill:has-text("Plays the sound")'), 'the main TV plays the sound');
  await host.click('.display-row:has-text("Mirror 1") .btn:has-text("Identify")');
  check(await seen(mirror, '.identify:has-text("Mirror 1")') && !(await tv.$('.identify')), 'Identify: the name on that screen only');
  await shot(mirror, 'mirror-identify');
  await host.click('.display-row:has-text("Mirror 1") .btn:has-text("Make main")');
  check(await seen(host, '.toast:has-text("Main display changed")'), 'Make main');
  check(await until(() => app.hub.list((c) => c.role === 'tv' && c.data.display === 'main')[0]?.data.kind === 'mirror'), 'the mirror plays the sound now');
  await host.click('.display-row:has-text("Mirror 1") .btn:has-text("Make main")'); // and back
  check(await until(() => app.hub.list((c) => c.role === 'tv' && c.data.display === 'main')[0]?.data.kind === 'main'), 'and back to the TV');
  await tab(host, 'Queue');
  const { code: pairCode } = room.pairRequest('192.168.1.77');
  room.flush();
  await host.click('.topbar .pill:has-text("Screen waiting")');
  check(await seen(host, `#ptab-devices[aria-selected="true"]`) && await seen(host, `.pairing-row:has-text("${pairCode}")`), 'the top bar’s “Screen waiting” opens Devices with the code');
  await host.click('.pairing-row .btn:has-text("Approve")');
  check(await seen(host, '.toast:has-text("Screen paired")'), 'Approve');
  check(await seen(host, '.dev-row.guest:has-text("Ben")') && /Chrome/.test(await host.textContent('.dev-row.guest:has-text("Ben") .hint')), 'Ben is listed with his phone’s browser');
  check(await seen(host, '.dev-row:has-text("This computer") .pill:has-text("This device")'), 'this device is marked');
  await shot(host, 'host-devices');
  await host.click('.dev-row.guest:has-text("Ben") .icon-btn');
  await host.click('.menu button:has-text("Make co-host")');
  const benId = Object.entries(room.s.profiles).find(([, p]) => p.name === 'Ben')[0];
  check(await until(() => room.s.profiles[benId].coHost === true), 'Make co-host from the menu');
  expectKick = true;
  await host.click('.dev-row.guest:has-text("Ben") .icon-btn');
  await host.click('.menu button:has-text("Disconnect")');
  check(await until(() => !app.hub.list((c) => c.role === 'guest' && c.data.deviceId === benId).length), 'Disconnect closes Ben’s connection');
  await sleep(500);
  expectKick = false;
  await ben.close();

  // ---- both skins: screenshots of each tab ------------------------------------------------------
  for (const skin of ['studio', 'party']) {
    await hostReq('settings.update', { patch: { appearance: { theme: skin } } });
    await sleep(400);
    for (const t of ['Queue', 'Playback', 'Devices']) {
      await tab(host, t);
      await sleep(300);
      await shot(host, `${skin}-host-${t.toLowerCase()}`);
    }
  }
  await hostReq('settings.update', { patch: { appearance: { theme: 'studio' } } });

  // ---- phones: the Control pages and the mini player -------------------------------------------
  for (const [w, h] of [[390, 844], [360, 760]]) {
    const p = await phone(`host-phone-${w}`, w, h);
    await p.goto(`${base}/host#/queue`);
    check(await until(async () => (await p.evaluate(() => location.hash)) === '#/panel/queue'), `${w}px: #/queue → #/panel/queue`);
    const nav = await p.$$eval('.nav a', (l) => l.filter((a) => a.offsetParent).map((a) => a.textContent.trim()));
    check(nav.length <= 6 && nav.some((n) => /^Control/.test(n)), `${w}px: the bottom bar has Control (${nav.join(', ')})`);
    check(await seen(p, '.player.mini .play-btn') && !!(await p.$('.player.mini button[aria-label="Next singer"]')) && !(await p.$('.player .seek')) && !(await p.$('.player .stepper')), `${w}px: the mini player`);
    check(await noSideways(p), `${w}px: Queue page fits`);
    await shot(p, `phone-${w}-queue`);
    await p.tap('.now.mini');
    check(await until(async () => (await p.evaluate(() => location.hash)) === '#/panel/playback' && !(await p.$('.player'))), `${w}px: the mini player opens Playback (no bar there)`);
    await p.waitForSelector('#pb-now .play-btn');
    for (const sel of ['button[aria-label="Restart song"]', 'button[aria-label="Next singer"]', 'button[aria-label="Stop and return the song to the queue"]', '.seek input', 'input[aria-label="Volume"]']) {
      check(!!(await p.$(`#pb-now ${sel}`)), `${w}px: Playback page has ${sel}`);
    }
    if (room.s.player.state !== 'playing') await hostReq('player.resume');
    await until(() => room.s.player.state === 'playing', 15000);
    await p.tap('#pb-now .play-btn');
    check(await until(() => room.s.player.state === 'paused'), `${w}px: pause from the Playback page`);
    check(!(await p.$('.preview-frame')) && !!(await p.$('.preview-off')), `${w}px: the preview waits to be asked for`);
    await p.tap('.preview-off');
    await p.waitForSelector('.preview-frame');
    check(await p.evaluate(() => document.querySelector('.preview-frame').getBoundingClientRect().width <= innerWidth), `${w}px: the preview fits`);
    check(await noSideways(p), `${w}px: Playback page fits`);
    await shot(p, `phone-${w}-playback`);
    await p.goto(`${base}/host#/panel/devices`);
    await p.waitForSelector('.display-row');
    const inside = await p.evaluate(() => [...document.querySelectorAll('.dev-actions button')].every((b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0; }));
    check(inside, `${w}px: the Devices buttons are on screen`);
    check(await noSideways(p), `${w}px: Devices page fits`);
    await shot(p, `phone-${w}-devices`);
    await p.close();
  }
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
