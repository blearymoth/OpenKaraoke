#!/usr/bin/env node
// End-to-end checks of the app-wide skins (settings.appearance): Studio is the default on every
// app; switching skin or accent in Settings → Appearance changes the already-open host, TV and
// guest pages live; a reload keeps the skin with no flash; screenshots of the key screens in both
// skins; no console errors; phones never scroll sideways. Not part of `npm test`.
//
//   node test/e2e/themes.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-themes');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
app.settings.update({ playback: { startPaused: true } }); // the intro waits for "play": a stable screen
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const pages = [];
const hostClient = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => app.room.request(hostClient, { t, ...m });
const room = () => app.room.s;

/** A page that records the skin its <html> had when the parser created it (a flash shows here). */
async function open(name, opts) {
  const page = await browser.newPage(opts);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.addInitScript(() => {
    const obs = new MutationObserver(() => {
      if (document.documentElement && !window.__firstTheme) {
        window.__firstTheme = document.documentElement.getAttribute('data-theme') || 'none';
        obs.disconnect();
      }
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  pages.push({ name, page });
  return page;
}
const desktop = (name) => open(name, { viewport: { width: 1440, height: 900 } });
const phone = (name) => open(name, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const tvSize = (name) => open(name, { viewport: { width: 1280, height: 720 } });

const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const firstTheme = (page) => page.evaluate(() => window.__firstTheme);
const tokenOf = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const waitTheme = (page, theme) => page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, { timeout: 5000 }).then(() => true, () => false);
const waitToken = (page, name, value) => page.waitForFunction(([n, v]) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() === v, [name, value], { timeout: 5000 }).then(() => true, () => false);
/** Which app icon an <img src="/img/icon.svg"> shows: 'party' (the original) or 'studio' (swapped by --app-icon). */
const iconOf = (page, sel) => page.$eval(sel, (img) => {
  const c = getComputedStyle(img).content;
  return c === 'normal' ? 'party' : c.includes('/img/icon-studio.svg') ? 'studio' : c;
});
const favicon = (page) => page.$eval('link[rel="icon"]', (l) => l.getAttribute('href'));
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function setSkin(theme, open) {
  await hostReq('settings.update', { patch: { appearance: { theme } } });
  const ok = await Promise.all(open.map((p) => waitTheme(p, theme)));
  await sleep(250); // fonts, images in the new colours
  return ok.every(Boolean);
}

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

try {
  // ---- Studio is the default, already in the first HTML ------------------------------------------
  for (const p of ['/', '/host', '/tv', `/j/${code}`]) {
    const res = await fetch(`${base}${p}`);
    const text = await res.text();
    check(/<html lang="en" data-theme="studio">/.test(text) && text.includes('<meta name="theme-color" content="#0f1216">'), `${p} is served in the Studio skin`);
  }
  const host = await desktop('host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');
  const tv = await tvSize('tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const guest = await phone('guest');
  await joinAs(guest, 'Gia');
  const hostPhone = await phone('host-phone');
  await hostPhone.goto(`${base}/host#/`);
  await hostPhone.waitForSelector('.player');
  const live = [host, tv, guest, hostPhone];
  const scrollChecks = [];
  for (const { name, page } of pages) {
    check(await themeOf(page) === 'studio' && await firstTheme(page) === 'studio', `${name}: Studio from the first paint`);
  }
  check(await tokenOf(tv, '--neon') === '#6ea8fe' && await tokenOf(guest, '--night') === '#0f1216', 'Studio tokens apply');
  check(!(await tv.evaluate(() => [...document.fonts].some((f) => f.family.includes('Bricolage') && f.status === 'loaded'))), 'Studio does not load the Party display font');
  check(await iconOf(host, '.brand img') === 'studio' && await iconOf(tv, '.lobby-top img') === 'studio' && await favicon(host) === '/img/icon-studio.svg', 'Studio shows its own app icon (header, TV lobby, favicon)');

  // ---- switch to Party in Settings → Appearance: every open page follows, live --------------------
  await host.goto(`${base}/host#/settings/appearance`);
  await host.waitForSelector('.skin-card');
  check(await host.$eval('.settings-nav a.on', (a) => a.textContent.trim()) === 'Appearance', 'Settings has an Appearance section');
  check((await host.$$('.skin-card')).length === 2 && await host.$eval('.skin-card.on', (b) => b.dataset.skin) === 'studio', 'two skins to pick from, Studio in use');
  await shot(host, 'studio-host-settings-appearance');
  const tvQrBefore = await tv.$eval('.marquee img', (i) => i.getAttribute('src'));
  await host.click('.skin-card[data-skin="party"]');
  const followed = await Promise.all(live.map((p) => waitTheme(p, 'party')));
  check(followed.every(Boolean), 'host, TV, guest and host phone switch to Party live (no reload)');
  check(await host.$eval('.skin-card.on', (b) => b.dataset.skin) === 'party', 'the Party card is now in use');
  check(await tokenOf(tv, '--night') === '#150f26' && await tokenOf(guest, '--neon') === '#ff3d8b', 'Party tokens apply on the TV and the phone');
  await tv.waitForFunction((before) => document.querySelector('.marquee img')?.getAttribute('src') !== before, tvQrBefore, { timeout: 5000 }).catch(() => {});
  check(/dark=%231b1230&light=%23fff8e6/.test(await tv.$eval('.marquee img', (i) => i.getAttribute('src'))), 'the TV redraws its QR code in the Party colours');
  check(await guest.$eval('meta[name="theme-color"]', (m) => m.content) === '#150f26', 'the phone’s theme-color follows the skin');
  check(await iconOf(host, '.brand img') === 'party' && await iconOf(tv, '.lobby-top img') === 'party' && await favicon(tv) === '/img/icon.svg', 'Party shows the original app icon again (header, TV lobby, favicon)');
  check(app.settings.get('appearance.theme') === 'party', 'the choice is saved');
  await sleep(300);
  await shot(host, 'party-host-settings-appearance');

  // ---- accent override: applies everywhere, readable text on it, and resets ----------------------
  await host.fill('.accent-form input[type="color"]', '#00c2ff');
  const accented = await Promise.all(live.map((p) => waitToken(p, '--neon', '#00c2ff')));
  check(accented.every(Boolean), 'accent override applies on every open page');
  check(await host.$eval('.accent-form .btn', (b) => !b.disabled), '“Use the skin’s colour” is offered');
  const playInk = () => host.evaluate(() => getComputedStyle(document.querySelector('.play-btn')).color);
  check(await tokenOf(guest, '--neon-ink') === '#111' && await playInk() === 'rgb(17, 17, 17)', 'dark text on a mid-light accent (higher contrast than white)');
  await hostReq('settings.update', { patch: { appearance: { accent: '#1368ce' } } });
  await waitToken(host, '--neon', '#1368ce');
  check(await playInk() === 'rgb(255, 255, 255)' && await tokenOf(guest, '--neon-ink') === '#fff', 'white text on a dark accent');
  await hostReq('settings.update', { patch: { appearance: { accent: '#ffe066' } } });
  await waitToken(host, '--neon', '#ffe066');
  check(await playInk() === 'rgb(17, 17, 17)', 'dark text on a light accent');
  const res = await fetch(`${base}/tv`);
  check((await res.text()).includes('style="--neon: #ffe066; --neon-ink: #111;"'), 'the served page already has the accent (no flash)');
  await sleep(300); // the skin cards' border transition
  await shot(host, 'party-host-accent');
  await host.click('.accent-form .btn');
  const reset = await Promise.all(live.map((p) => waitToken(p, '--neon', '#ff3d8b')));
  check(reset.every(Boolean) && app.settings.get('appearance.accent') === '', 'accent resets to the skin’s own colour');
  check(await host.evaluate(() => !document.documentElement.style.getPropertyValue('--neon')), 'no inline accent left');

  // ---- a reload keeps the skin, with no flash of the default one ---------------------------------
  for (const { name, page } of pages) {
    const r = await page.reload();
    const html = await r.text();
    await page.waitForLoadState('load');
    check(html.includes('data-theme="party"') && await firstTheme(page) === 'party' && await themeOf(page) === 'party', `${name}: reload keeps Party from the first paint`);
  }
  await host.waitForSelector('.player');
  await tv.waitForSelector('.lobby');
  await guest.waitForSelector('.g-tabs');

  // ---- screens without a live connection follow a switch too (they check every few seconds) -----
  const idle = await desktop('landing-idle');
  await idle.goto(`${base}/`);
  await idle.waitForSelector('#qr[src]');
  const pinHost = await desktop('host-pin'); // another device, before its PIN: the server refuses it
  await pinHost.routeWebSocket(/\/ws$/, (ws) => ws.onMessage((m) => {
    if (JSON.parse(String(m)).t === 'hello') ws.send(JSON.stringify({ t: 'denied', reason: 'pin_required' }));
  }));
  await pinHost.goto(`${base}/host`);
  await pinHost.waitForSelector('.pin-input');
  const lost = await phone('guest-wrong-code');
  await lost.goto(`${base}/j/ZZZZ`);
  await lost.waitForSelector('.code-box');
  const gates = [idle, pinHost, lost];
  check((await Promise.all(gates.map(themeOf))).every((t) => t === 'party'), 'landing page, PIN screen and wrong-code screen are served in Party');
  check(await setSkin('studio', gates), 'landing page, PIN screen and wrong-code screen follow a switch without a reload');
  await shot(pinHost, 'studio-host-pin');
  await shot(lost, 'studio-guest-wrong-code');
  check(await setSkin('party', gates), '… and back to Party');
  await shot(pinHost, 'party-host-pin');
  await shot(lost, 'party-guest-wrong-code');
  scrollChecks.push(['guest wrong-code screen', await noSideways(lost)]);
  await Promise.all(gates.map((p) => p.close()));

  // ---- screenshots of the key screens in both skins ----------------------------------------------
  const songs = app.library.catalog.songList;
  await hostReq('queue.add', { songId: songs[1].id, singerName: 'Dora' });
  await hostReq('player.stop').catch(() => {});
  const landing = await desktop('landing');
  const landingPhone = await phone('landing-phone');
  const all = () => live;

  async function screens(skin) {
    check(await setSkin(skin, all()), `${skin}: every page shows the skin`);
    await landing.goto(`${base}/`);
    await landing.waitForSelector('#qr[src]');
    await sleep(600);
    await shot(landing, `${skin}-landing`);
    await landingPhone.goto(`${base}/`);
    await sleep(300);
    await shot(landingPhone, `${skin}-landing-phone`);
    await host.goto(`${base}/host#/`);
    await host.waitForSelector('.page-head, .hero-card');
    await sleep(400);
    await shot(host, `${skin}-host-home`);
    await host.fill('.search-box input', 'neon');
    await host.waitForSelector('.song-row');
    await sleep(400);
    await shot(host, `${skin}-host-search`);
    await hostPhone.goto(`${base}/host#/queue`);
    await hostPhone.waitForSelector('.q-item');
    await shot(hostPhone, `${skin}-host-phone-queue`);
    await hostPhone.goto(`${base}/host#/settings/appearance`);
    await hostPhone.waitForSelector('.skin-card');
    await shot(hostPhone, `${skin}-host-phone-appearance`);
    scrollChecks.push([`${skin}: host phone`, await noSideways(hostPhone)]);
    await guest.click('.g-tabs button:has-text("Home")');
    await sleep(300);
    await shot(guest, `${skin}-guest-home`);
    scrollChecks.push([`${skin}: guest home`, await noSideways(guest)]);
    await guest.click('.g-tabs button:has-text("Songs")');
    await guest.fill('.g-search input', 'neon');
    await guest.waitForSelector('.g-songs .song-row');
    await sleep(300);
    await shot(guest, `${skin}-guest-songs`);
    await guest.click('.g-songs .song-row');
    await guest.waitForSelector('.sheet .btn.primary');
    await sleep(400);
    await shot(guest, `${skin}-guest-song-sheet`);
    scrollChecks.push([`${skin}: guest song sheet`, await noSideways(guest)]);
    await guest.click('.sheet-close');
    scrollChecks.push([`${skin}: landing`, await noSideways(landingPhone)]);
    await tv.waitForSelector('.lobby .upnext-item');
    await sleep(500);
    await shot(tv, `${skin}-tv-lobby`);
  }
  await screens('party');
  await screens('studio');

  // Intro (waits for "play"), then singing.
  await hostReq('player.play');
  await tv.waitForSelector('.intro');
  await host.goto(`${base}/host#/`);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    await tv.waitForFunction(() => /Ready when you are/.test(document.querySelector('.intro .status')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    await shot(tv, `${skin}-tv-intro`);
  }
  await hostReq('player.play').catch(() => hostReq('player.resume'));
  await tv.waitForSelector('#cdg.show', { timeout: 15000 });
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    await sleep(700);
    await shot(tv, `${skin}-tv-singing`);
    await shot(host, `${skin}-host-playing`);
    await shot(guest, `${skin}-guest-playing`);
  }
  await hostReq('player.stop');
  await tv.waitForSelector('.lobby');

  // A game: the roulette wheel (answer colours and confetti come from the skin too).
  await hostReq('game.start', { type: 'wheel', config: { kind: 'songs', count: 8 } });
  await tv.waitForSelector('.wheel-tv .wheel-svg');
  await guest.waitForSelector('.wheel-guest .wheel-svg');
  const segFill = () => tv.$eval('.wheel-seg path', (p) => getComputedStyle(p).fill);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    check(await segFill() === (skin === 'party' ? 'rgb(255, 61, 139)' : 'rgb(91, 141, 239)'), `${skin}: wheel segments use the skin’s palette`);
    await shot(tv, `${skin}-tv-wheel`);
    await shot(guest, `${skin}-guest-wheel`);
    scrollChecks.push([`${skin}: guest wheel`, await noSideways(guest)]);
  }
  await hostReq('game.action', { action: 'spin' });
  await tv.waitForSelector('.wheel-reveal', { timeout: 15000 });
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    await shot(tv, `${skin}-tv-wheel-result`);
  }
  await hostReq('game.end');
  await hostReq('game.close');

  // The "What's next?" poll: answer colours per skin, on the TV and the phone.
  await hostReq('game.start', { type: 'poll', config: {} });
  await tv.waitForSelector('.g-tv .g-answer');
  await guest.waitForSelector('button.g-answer');
  const answerBg = () => guest.$eval('button.g-answer', (b) => getComputedStyle(b).backgroundColor);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    check(await answerBg() === (skin === 'party' ? 'rgb(226, 27, 60)' : 'rgb(181, 71, 90)'), `${skin}: answer colours come from the skin`);
    await shot(tv, `${skin}-tv-poll`);
    await shot(guest, `${skin}-guest-poll`);
    scrollChecks.push([`${skin}: guest poll`, await noSideways(guest)]);
  }
  await hostReq('game.end');
  await hostReq('game.close');

  // The queue board for a second screen follows the skin too.
  await setSkin('studio', all());
  const board = await tvSize('board');
  await board.goto(`${base}/tv?layout=board`);
  await board.waitForSelector('.board');
  check(await themeOf(board) === 'studio' && await firstTheme(board) === 'studio', 'board: Studio from the first paint');
  await shot(board, 'studio-tv-board');
  check(await setSkin('party', [...all(), board]), 'board: switches to Party live');
  await shot(board, 'party-tv-board');

  for (const [what, ok] of scrollChecks) check(ok, `${what}: no sideways scrolling`);
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await app.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed.length ? 1 : 0);
