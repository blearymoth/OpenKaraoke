#!/usr/bin/env node
// Pitch rings: host starts a run, TV shows the playfield, phones see progress without note names.
//   node test/e2e/game-pitch.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-game-pitch');
const artifacts = '/opt/cursor/artifacts';
await fs.mkdir(out, { recursive: true });
await fs.mkdir(artifacts, { recursive: true }).catch(() => {});

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = async (page, name, wait = 500) => {
  await sleep(wait);
  const p = path.join(out, `${name}.png`);
  await page.screenshot({ path: p });
  await fs.copyFile(p, path.join(artifacts, `${name}.png`)).catch(() => {});
};
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const game = () => app.room.game;

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await host.goto(`${base}/host#/games`);
  await tv.goto(`${base}/tv`);
  await tv.click('.start', { timeout: 5000 }).catch(() => {});
  const ann = await phone('ann');
  await joinAs(ann, 'Ann');
  await host.click('.game-card:has-text("Pitch rings") .btn');
  await host.waitForSelector('.game-card.open .pitch-setup');
  await host.selectOption('.pitch-setup select >> nth=0', '5');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .pitch-control');
  check(game()?.type === 'pitch' && game().phase === 'ready', 'host started Pitch rings');
  await host.fill('.pn-next-row input', 'Ann');
  await host.click('.pn-next-row .btn.primary');
  check(game()?.phase === 'fly', 'run is flying');
  await tv.waitForSelector('.g-tv.pitch canvas.pn-field', { timeout: 8000 });
  const hostNote = await host.textContent('.pn-live .pn-next');
  check(/Next ring:/.test(hostNote || ''), 'host sees the next ring note');
  const guestHtml = await ann.evaluate(() => document.querySelector('.game-tab')?.innerText || '');
  check(!/Next ring:/.test(guestHtml), 'guest does not see host note coaching');
  check(/Ring \d+ of 5/.test(guestHtml), 'guest sees ring progress');
  await shot(host, 'pitch-host-fly', 800);
  await shot(tv, 'pitch-tv-fly', 1200);
  await shot(ann, 'pitch-guest-fly', 0);
  await sleep(12000);
  check(game()?.phase === 'turn', 'run finished');
  await shot(tv, 'pitch-tv-turn', 500);
  await host.evaluate(() => { window.confirm = () => true; });
  await host.click('.game-live .btn.danger');
  await sleep(300);
  await host.click('.game-live .btn:has-text("Close")');
  await sleep(300);
  await browser.close();

  // Mic blocked: only one main TV; the first browser is gone so this one owns the mic path.
  const browser2 = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx2 = await browser2.newContext();
  await ctx2.addInitScript(() => {
    const deny = async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = deny;
  });
  const host2 = watch(await ctx2.newPage({ viewport: { width: 1440, height: 900 } }), 'host2');
  const tv2 = watch(await ctx2.newPage({ viewport: { width: 1280, height: 720 } }), 'tv2');
  await host2.goto(`${base}/host#/games`);
  await tv2.goto(`${base}/tv`);
  await tv2.click('.start', { timeout: 5000 }).catch(() => {});
  await host2.click('.game-card:has-text("Pitch rings") .btn');
  await host2.click('.game-card.open .btn.primary');
  await host2.fill('.pn-next-row input', 'Cy');
  await host2.click('.pn-next-row .btn.primary');
  await host2.waitForSelector('.pitch-control .pn-error', { timeout: 10000 });
  const hv = await host2.textContent('.pitch-control .pn-error');
  check(!!hv && /microphone|blocked|not available/i.test(hv), `host sees a mic error (${hv})`);
  await shot(host2, 'pitch-host-mic-error', 300);
  check(game()?.phase === 'ready', 'host can still control the game after a mic error');
  await host2.evaluate(() => { window.confirm = () => true; });
  await host2.click('.game-live .btn.danger').catch(() => {});
  await browser2.close();

  check(errors.length === 0, `no console errors (${errors.length})`);
  console.log(results.filter((r) => !r.ok).map((r) => r.what).join('\n') || 'all checks passed');
  if (results.some((r) => !r.ok)) process.exit(1);
} finally {
  app.close();
}
