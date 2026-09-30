#!/usr/bin/env node
// End-to-end check of the game framework: the host starts a poll from the Games page, the TV
// shows it, phones vote, the winner is queued; after a song, phones rate the performance.
//
//   node test/e2e/games.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-games');
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
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const room = () => app.room;

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/games`);
  await host.waitForSelector('.game-card');
  const cards = await host.$$eval('.game-card h3', (l) => l.map((x) => x.textContent.trim()));
  check(cards.length === 7, `games page lists the games (${cards.length})`);

  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const ann = await phone('ann');
  const bob = await phone('bob');
  await joinAs(ann, 'Ann');
  await joinAs(bob, 'Bob');

  await host.click('.game-card:has-text("poll") .btn');
  await host.waitForSelector('.game-card.open .g-setup');
  await host.selectOption('.game-card.open select >> nth=0', '45');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live');
  check(room().game?.type === 'poll', 'host started a poll');
  await tv.waitForSelector('.poll-grid .poll-card');
  check((await tv.$$('.poll-card')).length === 4, 'TV shows four songs to vote on');
  await ann.waitForSelector('.game-tab .g-answer');
  check(true, 'phones jump to the game tab');
  await ann.click('.g-answer >> nth=1');
  await bob.click('.g-answer >> nth=1');
  await sleep(300);
  check(room().game.votes.size === 2, 'two votes counted');
  await shot(tv, 'tv-poll');
  await shot(ann, 'ann-poll');
  await host.click('.game-live .btn:has-text("Close voting")');
  await tv.waitForSelector('.poll-winner');
  check(room().s.queue[0]?.source === 'game:poll', 'winner queued next');
  await shot(tv, 'tv-poll-winner');
  await host.click('.game-live .btn:has-text("End game")').catch(() => {});
  host.once('dialog', (d) => d.accept());
  await host.waitForSelector('.game-live .btn:has-text("Close")', { timeout: 15000 });
  await host.click('.game-live .btn:has-text("Close")');
  check(await tv.waitForSelector('.intro, .lobby', { timeout: 10000 }).then(() => true, () => false), 'after the game the TV goes back to karaoke');
  check(await ann.waitForSelector('.g-tabs button:has-text("Home").on', { timeout: 5000 }).then(() => true, () => false), 'phones go back home when the game is closed');

  // Ratings: the winning song plays to its end, phones get a rating card.
  const cur = await (async () => { for (let i = 0; i < 60 && !room().s.current; i++) await sleep(100); return room().s.current; })();
  check(!!cur, 'the poll winner starts');
  if (cur) {
    room().s.current.singerIds = [room().findOrCreateSinger('Bob').id];
    room().s.player.pos = cur.dur;
    room().finish('ended');
    room().flush();
    await ann.waitForSelector('.rate-card', { timeout: 5000 });
    await ann.click('.rate-stars button >> nth=4');
    await sleep(300);
    check(room().rating?.votes.size === 1, 'a guest rated the performance');
    await tv.waitForSelector('.tv-rating', { timeout: 5000 });
    check(/5\.0/.test(await tv.textContent('.tv-rating')), 'TV shows the live rating');
    await shot(ann, 'ann-rating');
    await shot(tv, 'tv-rating');
  }
  const overflow = await ann.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'phone fits without sideways scrolling');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: path.join(out, `failure-${Math.random().toString(36).slice(2, 6)}.png`) }).catch(() => {});
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
