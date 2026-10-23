#!/usr/bin/env node
// Pitch rings: host starts a run, the TV flies it in 3D (WebGL) and hears a sung G4 (Chromium's
// fake microphone plays a tone file), phones see progress without note names; the flat playfield
// when the browser has no WebGL; a blocked microphone.
//   node test/e2e/game-pitch.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { writePcmWav } from '../../server/stems/wav.js';
import { pitchHeight, noteHz } from '../../shared/pitch.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-game-pitch');
const artifacts = '/opt/cursor/artifacts';
await fs.mkdir(out, { recursive: true });
await fs.mkdir(artifacts, { recursive: true }).catch(() => {});

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
// The singer: a steady G4 into the TV computer's microphone (Chromium loops the file).
const g4 = path.join(out, 'g4.wav');
await writePcmWav(g4, { hz: noteHz('G4'), seconds: 4, channels: 1, rate: 48000 });
const micArgs = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${g4}`];
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', ...micArgs] });
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
  const field = () => tv.$eval('canvas.pn-field', (c) => ({ renderer: c.dataset.renderer, frames: Number(c.dataset.frames || 0), w: c.width, h: c.height }));
  await sleep(1200);
  const f1 = await field();
  check(f1.renderer === 'webgl', `the TV flies it in 3D (renderer: ${f1.renderer})`);
  await sleep(1000);
  const f2 = await field();
  check(f2.frames > f1.frames && f2.w > 0 && f2.h > 0, `and keeps drawing (${f1.frames} → ${f2.frames} frames, ${f2.w}×${f2.h})`);
  const want = pitchHeight(noteHz('G4'), app.room.game.lowHz);
  check(Math.abs((game()?.lastHeight ?? -1) - want) < 0.03, `the TV hears the sung G4: ball height ${game()?.lastHeight?.toFixed(3)} (G4 is ${want.toFixed(3)} of the octave)`);
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

  // No WebGL (a browser that refuses it): the flat playfield, the same run.
  const browser3 = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', ...micArgs] });
  const ctx3 = await browser3.newContext();
  await ctx3.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/.test(type) ? null : get.call(this, type, ...rest);
    };
  });
  const tv3 = watch(await ctx3.newPage({ viewport: { width: 1280, height: 720 } }), 'tv3');
  await tv3.goto(`${base}/tv`);
  await tv3.click('.start', { timeout: 5000 }).catch(() => {});
  const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
  await app.room.request(asHost, { t: 'game.start', type: 'pitch', config: { rings: 5, range: 'mid' } });
  await app.room.request(asHost, { t: 'game.action', action: 'next', label: 'Di' });
  await tv3.waitForSelector('.g-tv.pitch canvas.pn-field', { timeout: 8000 });
  await sleep(1500);
  const flat = await tv3.$eval('canvas.pn-field', (c) => ({ renderer: c.dataset.renderer, frames: Number(c.dataset.frames || 0) }));
  check(flat.renderer === '2d' && flat.frames > 0, `no WebGL: the flat playfield (${flat.renderer}, ${flat.frames} frames)`);
  await shot(tv3, 'pitch-tv-flat', 0);
  await app.room.request(asHost, { t: 'game.action', action: 'end' }).catch(() => {});
  await browser3.close();

  check(errors.length === 0, `no console errors (${errors.length})`);
  console.log(results.filter((r) => !r.ok).map((r) => r.what).join('\n') || 'all checks passed');
  if (results.some((r) => !r.ok)) process.exit(1);
} finally {
  app.close();
}
