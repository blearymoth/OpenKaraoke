#!/usr/bin/env node
// End-to-end checks of the singer's own controls on their phone: while their song is on, the
// singer (only them) gets play/pause, restart and a seek bar; a seek works with a real drag and
// recovers when the pointer is cancelled or goes quiet; the controls go when the song changes;
// the phones fit with no sideways scrolling.
//
//   node test/e2e/singer-controls.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-singer-controls');
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
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const seen = (page, selector, timeout = 5000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const gone = (page, selector, timeout = 5000) => page.waitForSelector(selector, { state: 'detached', timeout }).then(() => true, () => false);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
const phone = { viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const code = app.settings.get('party.roomCode');

async function join(name) {
  const page = watch(await browser.newPage(phone), name);
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
  return page;
}
async function request(page, query, title) {
  await page.click('.g-tabs button:has-text("Songs")');
  await page.fill('.g-search input', query);
  await page.click(`.g-songs .song-row:has-text("${title}")`);
  await page.waitForSelector('.sheet .btn.primary');
  await page.click('.sheet .btn.primary');
  await page.waitForSelector('.sheet-done');
  await page.click('.sheet-done .btn');
  await page.click('.g-tabs button:first-child');
}

const seekSel = '.singer-controls input[aria-label="Seek"]';
const seekValue = (page) => page.$eval(seekSel, (el) => Number(el.value));
/** Starts a drag on the seek bar by hand (pointerdown, then the value moves) without ending it. */
const startDrag = (page, pos) => page.$eval(seekSel, (el, v) => {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, pos);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');

  const ann = await join('Ann');
  const bob = await join('Bob');
  // (With the TV on and nothing playing, the first request starts at once.)
  await request(ann, 'tempo tantrum', 'Tempo Tantrum');
  await request(bob, 'neon heart', 'Neon Heart');
  check(await until(() => room.s.current?.title === 'Tempo Tantrum' && room.s.player.state === 'playing', 30000), 'Ann’s song plays');
  const annEntry = room.s.current.id;

  // ---- the singer sees the controls, another guest doesn't --------------------------------
  check(await seen(ann, '.g-turn.now .singer-controls'), 'Ann: her turn card has the singer controls');
  check(!(await bob.$('.singer-controls')), 'Bob (not singing) has no singer controls');
  check(!(await ann.$('.singer-controls button:has-text("Next")')), 'no Next button among them');
  check(await noSideways(ann), 'Ann’s phone fits (no sideways scrolling)');
  await shot(ann, 'singer-controls');

  // ---- pause, play, restart ------------------------------------------------------------------
  await ann.click('.singer-controls .singer-play');
  check(await until(() => room.s.player.state === 'paused'), 'Ann paused her song');
  check(await seen(ann, '.singer-controls .singer-play:has-text("Play")'), 'the button now says Play');
  await ann.click('.singer-controls .singer-play');
  check(await until(() => room.s.player.state === 'playing'), 'Ann played it again');

  // ---- seek with a real drag ----------------------------------------------------------------
  const dur = room.s.player.dur;
  const box = await (await ann.$(seekSel)).boundingBox();
  const y = box.y + box.height / 2;
  const seq0 = room.s.player.seek.seq;
  await ann.mouse.move(box.x + box.width * 0.2, y);
  await ann.mouse.down();
  await ann.mouse.move(box.x + box.width * 0.4, y, { steps: 4 });
  await ann.mouse.move(box.x + box.width * 0.6, y, { steps: 4 });
  await ann.mouse.up();
  check(await until(() => room.s.player.seek.seq > seq0), 'the drag sent a seek');
  const target = room.s.player.seek.pos;
  check(Math.abs(target - dur * 0.6) < dur * 0.08, `it seeked to where the finger let go (${target.toFixed(1)} of ${dur.toFixed(1)} s)`);
  check(room.s.player.seek.seq === seq0 + 1, 'one seek for one drag');
  check(await until(async () => Math.abs((await seekValue(ann)) - target) < 3, 4000), 'the bar shows the new position');

  await ann.click('.singer-controls .singer-restart');
  check(await until(() => room.s.player.seek.pos === 0 && room.s.player.seek.seq === seq0 + 2), 'Restart goes back to the start');

  // ---- a cancelled pointer: the drag is dropped, the bar follows the song again --------------
  await sleep(1500); // past the post-seek hold
  const seq1 = room.s.player.seek.seq;
  const far = Math.floor(dur - 2);
  await startDrag(ann, far);
  check(await seekValue(ann) === far, 'mid-drag the bar shows the finger');
  await ann.$eval(seekSel, (el) => {
    el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
    el.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
  });
  check(await until(async () => Math.abs((await seekValue(ann)) - room.s.player.pos) < 3, 2000), 'after pointercancel the bar follows the song again');
  check(room.s.player.seek.seq === seq1, 'a cancelled drag seeks nowhere');
  const a = await seekValue(ann);
  await sleep(1500);
  check((await seekValue(ann)) > a, 'the bar keeps moving with the song (not stuck)');

  // A drag whose end never arrives: given up after a few quiet seconds.
  await startDrag(ann, far);
  await sleep(500);
  check(await seekValue(ann) === far, 'a drag with no end yet holds the finger’s place');
  check(await until(async () => Math.abs((await seekValue(ann)) - room.s.player.pos) < 3, 9000), 'a drag that goes quiet ends by itself');
  check(room.s.player.seek.seq === seq1, 'and seeks nowhere');

  // Not stuck: a drag after that works as usual.
  await ann.mouse.move(box.x + box.width * 0.3, y);
  await ann.mouse.down();
  await ann.mouse.move(box.x + box.width * 0.5, y, { steps: 4 });
  await ann.mouse.up();
  check(await until(() => room.s.player.seek.seq === seq1 + 1), 'the next drag seeks again');
  check(Math.abs(room.s.player.seek.pos - dur * 0.5) < dur * 0.08, `to the new place (${room.s.player.seek.pos.toFixed(1)} s)`);

  // ---- the song changes: Ann's controls go, Bob's come ---------------------------------------
  await hostReq('player.next');
  check(await until(() => room.s.current && room.s.current.id !== annEntry && room.s.current.title === 'Neon Heart'), 'the host moved on to Bob’s song');
  check(await gone(ann, '.singer-controls'), 'Ann’s controls go when her song is no longer on');
  check(await seen(bob, '.g-turn.now .singer-controls'), 'Bob now has the controls for his song');
  check(await noSideways(bob), 'Bob’s phone fits (no sideways scrolling)');
  await shot(bob, 'singer-controls-bob');
  await shot(ann, 'after-song');

  // The host stops: nobody has controls.
  await hostReq('player.stop');
  check(await gone(bob, '.singer-controls'), 'Stop: Bob’s controls go');
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
