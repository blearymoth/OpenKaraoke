#!/usr/bin/env node
// End-to-end check of the three apps together, driven through their real interfaces:
// the host (desktop), two guests (phones) and the TV. Not part of `npm test`.
//
//   node test/e2e/apps.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-apps');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const room = () => app.room.s;
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

async function guestRequest(page, query, title, { key } = {}) {
  await page.click('.g-tabs button:nth-child(2)');
  await page.fill('.g-search input', query);
  const row = `.g-songs .song-row:has-text("${title}")`;
  await page.waitForSelector(row);
  await page.click(row);
  await page.waitForSelector('.sheet .btn.primary');
  if (key) await page.click(`.key-row button:has-text("${key}")`);
  await page.click('.sheet .btn.primary');
  await page.waitForSelector('.sheet-done, .sheet-error');
  const ok = await page.$('.sheet-done');
  const text = await page.textContent(ok ? '.sheet-done h2' : '.sheet-error');
  if (ok) await page.click('.sheet-done .btn');
  else await page.click('.sheet-close');
  return { ok: !!ok, text };
}

try {
  // ---- host queues a song for someone without a phone -------------------------------------
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');
  await host.fill('.search-box input', 'neon heart');
  await host.waitForSelector('.song-row');
  await host.click('.song-row .btn.primary');
  await host.waitForSelector('.dialog');
  await host.fill('.dialog .field input', 'Dora');
  await host.click('.dialog-foot .btn.primary');
  await host.waitForSelector('.q-item');
  check(room().queue.length === 1 && room().singers[0]?.name === 'Dora', 'host queued a song for a singer without a phone');

  // ---- two guests join and request songs ---------------------------------------------------------
  const ben = await phone('ben');
  const cara = await phone('cara');
  await joinAs(ben, 'Ben');
  await joinAs(cara, 'Cara');
  check(Object.values(room().profiles).length === 2, 'two guests joined with names');
  const r1 = await guestRequest(ben, 'tempo', 'Tempo Tantrum', { key: '-2' });
  check(r1.ok, `Ben requested Tempo Tantrum (${r1.text})`);
  const r2 = await guestRequest(cara, 'high notes', 'High Notes Only');
  check(r2.ok, 'Cara requested High Notes Only');
  const r3 = await guestRequest(ben, 'quiet storm', 'Quiet Storm');
  check(r3.ok, 'Ben requested a second song');
  const r4 = await guestRequest(cara, 'tempo', 'Tempo Tantrum');
  check(!r4.ok && /already/.test(r4.text), `repeat requests are refused (“${r4.text?.trim()}”)`);
  const order = room().queue.map((e) => room().singers.find((s) => s.id === e.singerIds[0])?.name);
  check(order.join(',') === 'Dora,Ben,Cara,Ben', `fair rotation order: ${order.join(', ')}`);
  check(room().queue.find((e) => e.title === 'Tempo Tantrum')?.key === -2, 'guest key choice is kept');
  await host.waitForFunction(() => document.querySelectorAll('.q-item').length === 4);
  await shot(host, 'host-queue');
  await shot(ben, 'ben-home');

  // ---- approval mode through the settings UI ---------------------------------------------------------
  await host.goto(`${base}/host#/settings/queue`);
  await host.waitForSelector('.settings-body');
  const approve = host.locator('.setting', { hasText: 'Approve guest requests' }).locator('input[type=checkbox]');
  await approve.check({ force: true });
  await host.waitForFunction(() => true);
  await sleep(300);
  check(app.settings.get('queue.requireApproval') === true, 'settings toggle saves (approval mode on)');
  const r5 = await guestRequest(cara, 'kitchen', 'Singing In The Kitchen');
  check(r5.ok && /Request sent/.test(r5.text), 'guest request now waits for approval');
  await host.click('.tabs button:has-text("Requests")');
  await host.waitForSelector('.q-item .icon-btn.ok');
  await shot(host, 'host-requests');
  await host.click('.q-item .icon-btn.ok');
  await sleep(400);
  check(room().pending.length === 0 && room().queue.some((e) => e.title === 'Singing In The Kitchen'), 'host approved the request');
  await host.click('.tabs button:has-text("Queue")');

  // ---- the TV starts the party ------------------------------------------------------------------------
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.intro');
  check(room().current?.title === 'Neon Heart', 'first song auto-starts when the TV opens');
  await host.waitForSelector('.now-card');
  const t0 = Date.now();
  while (room().player.state !== 'playing' && Date.now() - t0 < 15000) await sleep(100);
  check(room().player.state === 'playing', 'song is playing');
  await ben.waitForSelector('.g-banner', { timeout: 10000 });
  check(true, 'Ben is told he is up next');
  await shot(ben, 'ben-upnext');

  // host controls from the player bar
  await host.click('.stepper >> nth=0 >> button[aria-label="Key up"]');
  await sleep(300);
  check(room().player.key === 1, 'key up from the player bar');
  await host.click('.play-btn');
  await sleep(300);
  check(room().player.state === 'paused', 'pause from the player bar');
  await host.click('.play-btn');
  await sleep(300);
  check(room().player.state === 'playing', 'resume from the player bar');
  await host.goto(`${base}/host#/`);
  await host.click('button:has-text("Announce")');
  await host.fill('.dialog textarea', 'Pizza is here!');
  await host.click('.dialog-foot .btn.primary');
  await tv.waitForSelector('.announce');
  check(true, 'announcement shows on the TV');
  await shot(tv, 'tv-announce');
  await sleep(300);

  // skip to Ben: his phone says it's his turn
  await host.click('button[aria-label="Next singer"]');
  await ben.waitForSelector('.g-alert.now', { timeout: 10000 });
  check(room().current?.title === 'Tempo Tantrum', 'next singer: Ben');
  await shot(ben, 'ben-your-turn');
  await ben.click('.g-alert');
  while (room().player.state !== 'playing' && Date.now() - t0 < 40000) await sleep(100);
  check(room().player.key === -2, 'Ben’s song plays in his chosen key');

  // Cara cheers
  await cara.click('.g-tabs button:nth-child(1)');
  await cara.waitForSelector('.reaction-grid button');
  await cara.click('.reaction-grid button:nth-child(3)');
  await tv.waitForSelector('.reaction');
  check(true, 'reaction from a phone floats up on the TV');
  await shot(tv, 'tv-reaction');

  // Ben removes his second song, Cara checks the queue
  await ben.click('.g-tabs button:nth-child(3)');
  await ben.waitForSelector('.g-queue li.mine');
  ben.once('dialog', (d) => d.accept());
  await ben.click('.g-queue li.mine button[aria-label^="Remove"]');
  await sleep(500);
  check(!room().queue.some((e) => e.title === 'Quiet Storm'), 'guest removed their own song');
  await shot(ben, 'ben-queue');

  // host removes Cara from the party
  await host.goto(`${base}/host#/singers`);
  await host.waitForSelector('.table');
  host.once('dialog', (d) => d.accept());
  await host.click('tr:has-text("Cara") button:has-text("Remove") >> nth=-1');
  await cara.waitForSelector('text=Can\'t join', { timeout: 5000 });
  check(true, 'removed guest sees that they can’t join');
  await shot(host, 'host-singers');

  // phone-sized host
  const hostPhone = await phone('host-phone');
  await hostPhone.goto(`${base}/host#/queue`);
  await hostPhone.waitForSelector('.player');
  const overflow = await hostPhone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'host fits a phone screen without sideways scrolling');
  const gOverflow = await ben.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(gOverflow <= 0, 'guest app fits a phone screen without sideways scrolling');
  await shot(hostPhone, 'host-phone-queue');

  // a denial that arrives right after the first render is still shown (useStore used to
  // subscribe after paint and miss it, leaving the page on "Connecting…")
  const denials = [
    ['host', '/host', 'pin_required', '.pin-input'],
    ['guest', `/j/${code}`, 'banned', '.g-gate h1'],
    ['tv', '/tv?fullscreen=0', 'rate_limited', '.denied h2'],
  ];
  const shown = await Promise.all([...denials, ...denials].map(async ([name, url, reason, sel]) => {
    const page = watch(await browser.newPage({ viewport: { width: 390, height: 844 } }), `denied-${name}`);
    await page.routeWebSocket(/\/ws$/, (ws) => ws.onMessage((m) => {
      if (JSON.parse(String(m)).t === 'hello') ws.send(JSON.stringify({ t: 'denied', reason }));
    }));
    await page.goto(`${base}${url}`);
    const ok = await page.waitForSelector(sel, { timeout: 5000 }).then(() => true, () => false);
    await page.close();
    return ok ? null : name;
  }));
  const missed = shown.filter(Boolean);
  check(missed.length === 0, `an immediate denial is shown by host, guest and TV${missed.length ? ` (missed: ${missed.join(', ')})` : ''}`);
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
