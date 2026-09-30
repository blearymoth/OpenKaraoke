#!/usr/bin/env node
// End-to-end check of the Roulette wheel: the host starts a wheel from the Games page, the TV
// spins it and lands exactly on the server's result, phones learn the result only after the
// wheel stops; songs are queued, a picked singer's phone is called, a custom dare is shown.
//
//   node test/e2e/game-wheel.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { segmentAt } from '../../shared/wheel.js';
import { loadPlaywright, startParty, WsClient, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-wheel');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
app.settings.update({ playback: { autoStart: false } }); // queued wheel songs wait (the next game needs a free TV)
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const room = () => app.room;
const tvRotation = (tv) => tv.$eval('.wheel-tv .wheel-rot', (el) => Number((/rotate\(([-\d.e]+)deg\)/.exec(el.style.transform) || [])[1]));

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

async function startWheel(host, setup) {
  await host.click('.game-card:has-text("Roulette") .btn');
  await host.waitForSelector('.game-card.open .wheel-setup');
  await setup?.();
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .wheel-control');
}

/** Clicks a spin button, checks the secrecy while it turns, returns the result once it stops. */
async function spinAndLand(host, tv, spy, button, label) {
  await host.click(`.game-live .btn:has-text("${button}")`);
  await tv.waitForSelector('.wheel-tv .wheel.is-spinning');
  const secret = room().game.spin;
  const st = await spy.until((s) => s.game?.phase === 'spinning' && s.game.spin?.seq === secret.seq, 5000);
  check(st.game.spin.index === undefined && st.game.spin.to === undefined && st.game.result === null, `${label}: phones don't know the result while the wheel turns`);
  const r1 = await tvRotation(tv);
  await sleep(1200);
  const r2 = await tvRotation(tv);
  check(r2 > r1, `${label}: the TV wheel is turning (${r1.toFixed(0)}° → ${r2.toFixed(0)}°)`);
  check(!(await tv.$('.wheel-reveal')), `${label}: no reveal on the TV before the wheel stops`);
  await tv.waitForSelector('.wheel-reveal', { timeout: 12000 });
  const result = room().game.result;
  const finalDeg = await tvRotation(tv);
  const n = room().game.segments.length;
  check(segmentAt(finalDeg, n) === result.index, `${label}: the TV wheel stopped exactly on the drawn segment (#${result.index + 1} of ${n})`);
  return result;
}

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/games`);
  await host.waitForSelector('.game-card');
  const card = await host.$('.game-card:has-text("Roulette")');
  check(!!card && !(await card.$eval('.btn', (b) => b.disabled)), 'the Roulette wheel can be set up (not “coming soon”)');

  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const ann = await phone('ann');
  const bob = await phone('bob');
  await joinAs(ann, 'Ann');
  await joinAs(bob, 'Bob');
  const spy = new WsClient(`${base.replace('http', 'ws')}/ws`); // a third phone, reading raw guest views
  await spy.open({ role: 'guest', room: code });

  // ---- 1. a wheel of songs --------------------------------------------------------------------
  await startWheel(host);
  check(room().game?.type === 'wheel' && room().game.config.kind === 'songs', 'host started a wheel of songs');
  await tv.waitForSelector('.wheel-tv .wheel-svg');
  const segs = await tv.$$eval('.wheel-tv .wheel-seg', (l) => l.length);
  check(segs === room().game.segments.length && segs >= 3, `TV draws the wheel (${segs} segments)`);
  await ann.waitForSelector('.game-tab .wheel-guest .wheel-svg');
  check(true, 'phones jump to the game tab and show the wheel');
  await shot(tv, 'tv-wheel-ready');

  await host.click('.game-live .btn:has-text("Spin the wheel")');
  await tv.waitForSelector('.wheel-tv .wheel.is-spinning');
  await sleep(900);
  await shot(tv, 'tv-wheel-spinning');
  await shot(ann, 'ann-wheel-spinning');
  check(!(await ann.$('.wheel-guest-card')), 'the phone shows no result while spinning');
  check(await ann.$eval('.wheel-guest', (el) => /Spinning/.test(el.textContent)), 'the phone says “Spinning…”');
  await tv.waitForSelector('.wheel-reveal.song', { timeout: 12000 });
  let result = room().game.result;
  const deg = await tvRotation(tv);
  check(segmentAt(deg, room().game.segments.length) === result.index, 'the TV wheel stopped exactly on the drawn song');
  check((await tv.textContent('.wheel-reveal h2')).trim() === result.seg.label, `TV reveals the song (${result.seg.label})`);
  check(!!(await tv.$('.g-confetti')), 'confetti on the TV');
  await ann.waitForSelector('.wheel-guest-card');
  check((await ann.textContent('.wheel-guest-card h2')).trim() === result.seg.label, 'the phone shows the result after the reveal');
  await shot(tv, 'tv-wheel-result-song');
  await shot(ann, 'ann-wheel-result');

  await host.selectOption('.game-live .wheel-queue select', 'everyone');
  await host.click('.game-live .btn:has-text("Queue it next")');
  await host.waitForSelector('.game-live .wheel-ok');
  check(room().s.queue[0]?.source === 'game:wheel' && room().s.queue[0].songId === result.seg.songId, 'the song is queued next');
  check(room().singer(room().s.queue[0].singerIds[0])?.name === 'Everyone', '…as a sing-along for everyone');
  await tv.waitForFunction(() => /Up next/.test(document.querySelector('.wheel-reveal')?.textContent || ''));
  check(true, 'the TV says it is up next');
  await shot(host, 'host-wheel-control');

  const before = room().game.segments.length;
  const used = result.seg.label;
  result = await spinAndLand(host, tv, spy, 'Spin again without', 'spin again');
  check(room().game.segments.length === before - 1 && !room().game.segments.some((x) => x.label === used), 'the used song was taken off the wheel');
  host.once('dialog', (d) => d.accept());
  await host.click('.game-live .btn:has-text("End game")');
  await host.waitForSelector('.game-live .btn:has-text("Close")');
  await host.click('.game-live .btn:has-text("Close")');
  check(await tv.waitForSelector('.lobby', { timeout: 10000 }).then(() => true, () => false), 'after the game the TV goes back to karaoke');
  check(await ann.waitForSelector('.g-tabs button:has-text("Home").on', { timeout: 5000 }).then(() => true, () => false), 'phones go back home when the game is closed');

  // ---- 2. a wheel of singers ------------------------------------------------------------------
  await startWheel(host, () => host.click('.wheel-kinds .chip:has-text("Singers")'));
  check(room().game?.config.kind === 'singers', 'host started a wheel of singers');
  const names = room().game.segments.map((x) => x.label).sort();
  check(names.join() === 'Ann,Bob', `the guests are on the wheel (${names.join(', ')})`);
  await ann.waitForSelector('.game-tab .wheel-guest');
  await bob.waitForSelector('.game-tab .wheel-guest');
  result = await spinAndLand(host, tv, spy, 'Spin the wheel', 'singers');
  const [picked, other] = result.seg.label === 'Ann' ? [ann, bob] : [bob, ann];
  await picked.waitForSelector('.wheel-guest-card.mine', { timeout: 5000 });
  check(/It’s you/.test(await picked.textContent('.wheel-guest-card.mine')), `${result.seg.label}'s phone says “It’s you!”`);
  check(await picked.waitForFunction(() => /pick a song/i.test(document.body.textContent.replace(/Pick a song in the Songs tab/, '')), null, { timeout: 3000 }).then(() => true, () => false), `${result.seg.label}'s phone got the call to pick a song`);
  await other.waitForSelector('.wheel-guest-card');
  check(!(await other.$('.wheel-guest-card.mine')), 'the other phone just sees the result');
  check(/pick a song/i.test(await tv.textContent('.wheel-tv')), 'the TV tells the singer to pick a song');
  await shot(tv, 'tv-wheel-result-singer');
  await shot(picked, 'phone-wheel-its-you');
  host.once('dialog', (d) => d.accept());
  await host.click('.game-live .btn:has-text("End game")');
  await host.click('.game-live .btn:has-text("Close")');
  await tv.waitForSelector('.lobby', { timeout: 10000 });

  // ---- 3. custom dares ------------------------------------------------------------------------
  const dares = ['Sing the next chorus like a robot', 'Do ten jumping jacks', 'Moonwalk across the room'];
  await startWheel(host, async () => {
    await host.click('.wheel-kinds .chip:has-text("Dares")');
    await host.fill('.wheel-dares', dares.join('\n'));
    await host.selectOption('.game-card.open select >> nth=0', '6');
  });
  check(room().game?.segments.length === 3 && room().game.segments.every((x) => dares.includes(x.label)), 'the host’s own dares are on the wheel');
  result = await spinAndLand(host, tv, spy, 'Spin the wheel', 'dares');
  check((await tv.textContent('.wheel-reveal.dare h2')).trim() === result.seg.label, `the TV shows the dare big (“${result.seg.label}”)`);
  await shot(tv, 'tv-wheel-result-dare');
  await ann.waitForSelector('.wheel-guest-card');
  await shot(ann, 'ann-wheel-dare');
  const overflow = await ann.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'phone fits without sideways scrolling');
  await shot(host, 'host-wheel-dares');
  host.once('dialog', (d) => d.accept());
  await host.click('.game-live .btn:has-text("End game")');
  await host.waitForSelector('.game-live .btn:has-text("Close")');
  check(room().s.tonight.games.filter((g) => g.type === 'wheel').length === 3, 'each wheel is remembered for the party recap');
  await host.click('.game-live .btn:has-text("Close")');
  spy.close();
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: path.join(out, `failure-${Math.random().toString(36).slice(2, 6)}.png`) }).catch(() => {});
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
  // This run's demo library and data folder (temp dirs made by startParty).
  for (const dir of [...app.library.paths, app.dataDir]) {
    if (/^ok-e2e-(lib|data)-/.test(path.basename(dir))) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
