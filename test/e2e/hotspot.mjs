#!/usr/bin/env node
// End-to-end checks of the party hotspot (PLAN §20) in the browser: Settings → Party, the two
// steps on the invite dialog, the TV lobby, the corner QR and the queue board, the banner when
// it drops, Try again, turning it off. NetworkManager is scripts/fake-nmcli.mjs — never the
// real nmcli.
//
//   node test/e2e/hotspot.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fetchHealth } from '../../server/net/hotspot.js';
import { fakeNmcli } from '../../scripts/fake-nmcli.mjs';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'error');
const out = path.resolve(process.argv[2] || 'test-results/e2e-hotspot');
await fs.mkdir(out, { recursive: true });

const HOTSPOT_IP = '10.42.0.1';
const nm = fakeNmcli('ok');
// Phones would reach this server at 10.42.0.1; here it listens on 127.0.0.1 (a real one on
// every address — the listen check is unit-tested).
const health = (url) => (url.startsWith(`http://${HOTSPOT_IP}:`) ? fetchHealth(url.replace(HOTSPOT_IP, '127.0.0.1')) : Promise.resolve(null));
const { app, base } = await startParty({ hotspot: { run: nm.run, health, platform: 'linux', readText: async () => '', pollMs: 60_000, listenAddress: () => '0.0.0.0' } });
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept()); // confirm() before a new password
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
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
/** Does every element matching `sel` lie inside the window? */
const inView = (page, sel) => page.$$eval(sel, (els) => els.length > 0 && els.every((e) => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
}));
const qrTexts = (page, sel) => page.$$eval(`${sel} img`, (imgs) => imgs.map((i) => new URL(i.getAttribute('src') || '', location.href).searchParams.get('text') || ''));

try {
  const code = app.info().roomCode;
  const ssid = `OpenKaraoke-${code}`;

  // ---- Settings → Party: switch it on and follow the checks --------------------------------------
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/settings/party`);
  await host.waitForSelector('.hotspot-block');
  check(/Off — guests use the home Wi-Fi/.test(await text(host, '.hs-status')), 'Settings → Party: the hotspot block says it is off');
  check(await host.$eval('.hotspot-block', (b) => b.compareDocumentPosition(document.querySelector('.setting:has(input[placeholder="Your network name"])')) & Node.DOCUMENT_POSITION_FOLLOWING).catch(() => false),
    'the hotspot block comes before the home Wi-Fi fields');
  await host.click('.hotspot-block .switch');
  check(await until(() => app.hotspot.state === 'on'), 'the switch starts the hotspot (fake NetworkManager)');
  await host.waitForSelector('.hs-status.on');
  check((await text(host, '.hs-status')).includes(`On: “${ssid}” at ${HOTSPOT_IP}`), 'status line: on, with the name and the address');
  const marks = await host.$$eval('.hs-checks li', (l) => l.map((li) => li.className));
  check(marks.length >= 10 && marks.every((c) => c === 'ok'), `every check is ✓ (${marks.length})`);
  check(!!(await host.$('.top-right .pill:has-text("Party Wi-Fi")')), 'the top bar shows “Party Wi-Fi”');
  const pw = app.hotspot.config().password;
  check(await host.$eval('input[aria-label="Hotspot password"]', (i, p) => i.value === p && i.type === 'password', pw), 'the host sees the password (hidden until shown)');
  await (await host.$('.hotspot-block')).screenshot({ path: path.join(out, 'host-settings-on.png') });

  // ---- the invite dialog: two steps -------------------------------------------------------------
  await host.click('.code-chip');
  await host.waitForSelector('.invite-steps');
  const inviteQrs = await qrTexts(host, '.invite-steps .marquee');
  check(inviteQrs.length === 2 && inviteQrs[0] === `WIFI:T:WPA;S:${ssid};P:${pw};;` && inviteQrs[1] === `http://${HOTSPOT_IP}:${app.port}/j/${code}`,
    'invite: step 1 joins the hotspot Wi-Fi, step 2 opens the party at its address');
  check((await text(host, '.wifi-facts')).includes(ssid) && (await text(host, '.wifi-facts')).includes(pw), 'invite: the network name and password in text');
  check(await host.$eval('.invite-url input', (i) => i.value.startsWith('http://10.42.0.1:')), 'invite: the link to copy is the hotspot one');
  await shot(host, 'invite-two-steps');
  await host.click('.dialog .close');
  await host.waitForSelector('.scrim', { state: 'detached' });

  // ---- the TV lobby, the queue board -------------------------------------------------------------
  const tv = watch(await browser.newPage({ viewport: { width: 1920, height: 1080 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby-main.steps');
  const tvQrs = await qrTexts(tv, '.lobby-main.steps .marquee');
  check(tvQrs.length === 2 && tvQrs[0].startsWith(`WIFI:T:WPA;S:${ssid};`) && tvQrs[1].includes(`${HOTSPOT_IP}:${app.port}/j/${code}`), 'TV lobby: two QR codes, Wi-Fi then party');
  check((await text(tv, '.tv-step .wifi-name')) === ssid && (await text(tv, '.tv-step .pw')) === pw, 'TV lobby: the name and password in big letters');
  check(await inView(tv, '.tv-step'), 'TV lobby: both steps fit on the screen (1920×1080)');
  check(!(await tv.$('.join .wifi')), 'TV lobby: no home Wi-Fi QR while the hotspot is step 1');
  await shot(tv, 'tv-lobby-steps');
  await tv.setViewportSize({ width: 1280, height: 720 });
  check(await inView(tv, '.tv-step'), 'TV lobby: both steps fit at 1280×720 too');
  await tv.evaluate(() => document.documentElement.setAttribute('data-theme', 'party'));
  await sleep(150);
  check(await inView(tv, '.tv-step'), 'TV lobby: and in the Party skin');
  await shot(tv, 'tv-lobby-steps-party');
  await tv.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  const board = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'board');
  await board.goto(`${base}/tv?layout=board`);
  await board.waitForSelector('.board-join.two');
  const boardQrs = await qrTexts(board, '.board-join.two');
  check(boardQrs.length === 2 && boardQrs[0].startsWith('WIFI:') && (await text(board, '.board-join.two')).includes(pw), 'queue board: both steps in its footer');
  check(await inView(board, '.board-join.two > div'), 'queue board: the footer fits');
  await shot(board, 'board-steps');
  await board.close();

  // ---- during a song: the corner QR has both steps ----------------------------------------------
  const song = app.library.catalog.songList[0];
  await app.room.request(asHost, { t: 'queue.add', songId: song.id, singerName: 'Ana' });
  if (!app.room.s.current) await app.room.request(asHost, { t: 'player.play' });
  await tv.waitForSelector('.corner-qr.two', { timeout: 20000 });
  const corner = await qrTexts(tv, '.corner-qr.two');
  check(corner.length === 2 && corner[0].startsWith('WIFI:') && corner[1].includes(`/j/${code}`), 'during a song: the corner QR shows Wi-Fi and party');
  check(await inView(tv, '.corner-qr.two'), 'the corner QR fits');
  await shot(tv, 'tv-corner-steps');
  await app.room.request(asHost, { t: 'player.stop' }).catch(() => {});

  // ---- a new password: the TV follows ------------------------------------------------------------
  await host.click('.hotspot-block button:has-text("New")');
  check(await until(() => app.hotspot.state === 'on' && app.hotspot.config().password !== pw, 15000), 'a new password restarts the hotspot with it');
  const pw2 = app.hotspot.config().password;
  const tvPw = await until(async () => (await text(tv, '.tv-step .pw, .board-join .pw')) === pw2 || (await qrTexts(tv, '.corner-qr.two'))[0]?.includes(`P:${pw2};`), 15000);
  check(tvPw, 'the TV shows the new password');

  // ---- it drops: banner, home QR, Try again ------------------------------------------------------
  await app.room.request(asHost, { t: 'player.stop' }).catch(() => {});
  nm.drop();
  await app.hotspot.poll();
  await app.hotspot.poll();
  check(app.hotspot.state === 'failed', 'the hotspot dropped (fake NetworkManager took it down)');
  await host.goto(`${base}/host#/`);
  await host.waitForSelector('.hs-banner');
  check(/The party hotspot is off\..*stopped/.test(await text(host, '.hs-banner')), 'host: a banner with the reason');
  check(/home Wi-Fi/.test(await text(host, '.hs-banner')), 'host: the banner says guests use the home Wi-Fi meanwhile');
  await shot(host, 'host-banner');
  await tv.waitForSelector('.lobby-main:not(.steps), .scene:not(.lobby)', { timeout: 10000 });
  check(!(await tv.$('.tv-step, .corner-qr.two')), 'TV: back to the one QR code of the home network');
  const homeQr = await qrTexts(tv, '.lobby .marquee, .corner-qr');
  check(homeQr.length >= 1 && !homeQr.some((t) => t.includes(HOTSPOT_IP) || t.startsWith('WIFI:T:WPA;S:OpenKaraoke')), 'TV: its QR no longer points at the hotspot');
  await host.click('.code-chip');
  await host.waitForSelector('.invite-body');
  check(!(await host.$('.invite-steps')), 'invite: one QR code again');
  await host.click('.dialog .close');
  await host.waitForSelector('.scrim', { state: 'detached' });

  // Try again while Wi-Fi is off: the reason and fix change; then on again.
  nm.state.radio = 'disabled';
  await host.click('.hs-banner button:has-text("Try again")');
  await until(() => app.hotspot.state === 'failed' && app.hotspot.view().check === 'radio');
  await host.waitForFunction(() => /Wi-Fi is switched off/.test(document.querySelector('.hs-banner')?.textContent || ''));
  check(/flight mode/.test(await text(host, '.hs-banner')), 'Try again with Wi-Fi off: the banner gives the new reason and its fix');
  await host.goto(`${base}/host#/settings/party`);
  await host.waitForSelector('.hs-checks li.fail');
  check((await text(host, '.hs-checks li.fail')).includes('Wi-Fi is switched off'), 'Settings: the failed check is ✗ with its fix');
  await (await host.$('.hotspot-block')).screenshot({ path: path.join(out, 'host-settings-failed.png') });
  nm.state.radio = 'enabled';
  await host.click('.hotspot-block button:has-text("Try again")');
  check(await until(() => app.hotspot.state === 'on'), 'Try again: on again');
  await host.waitForSelector('.hs-banner', { state: 'detached' });
  check(true, 'the banner is gone');
  await tv.waitForSelector('.tv-step, .corner-qr.two', { timeout: 10000 });
  check(true, 'the TV shows the two steps again');

  // ---- phones: the host's Settings and the invite fit ------------------------------------------------
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'host-phone');
  await phone.goto(`${base}/host#/settings/party`);
  await phone.waitForSelector('.hotspot-block .hs-status.on');
  check(await overflow(phone) <= 0, 'phone: Settings → Party fits without sideways scrolling');
  await phone.tap('.code-chip');
  await phone.waitForSelector('.invite-steps');
  const stacked = await phone.$$eval('.invite-step', (s) => s.length === 2 && s[1].getBoundingClientRect().top >= s[0].getBoundingClientRect().bottom - 1);
  check(stacked, 'phone: the two steps are stacked');
  check(await overflow(phone) <= 0, 'phone: the invite fits without sideways scrolling');
  await shot(phone, 'invite-phone');
  await phone.close();

  // ---- the landing page names the Wi-Fi, never the password ----------------------------------------
  const landing = watch(await browser.newPage({ viewport: { width: 1280, height: 800 } }), 'landing');
  await landing.goto(`${base}/`);
  await landing.waitForSelector('#first:not([hidden])');
  const first = await text(landing, '#first');
  check(first.includes(ssid) && !first.includes(app.hotspot.config().password), `landing page: “${first}”`);
  await landing.close();

  // ---- off from the banner's sibling: Settings switch ----------------------------------------------
  await host.click('.hotspot-block .switch');
  check(await until(() => app.hotspot.state === 'off' && !app.settings.get('party.hotspot.enabled')), 'switched off from Settings');
  await host.waitForSelector('.hs-status:not(.on)');
  await tv.waitForSelector('.lobby-main:not(.steps), .corner-qr:not(.two)', { timeout: 10000 });
  check(!(await tv.$('.tv-step')), 'TV: one QR code after switching off');
  check(!(await host.$('.top-right .pill:has-text("Party Wi-Fi")')), 'the top bar pill is gone');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  check(nm.calls.every((c) => c[0] === 'nmcli' || c[0] === 'firewall-cmd'), 'only the fake nmcli and firewall-cmd were asked');
  await browser.close();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
