#!/usr/bin/env node
// End-to-end check of the singing Battle: the host sets up a knockout from the Games page (two
// guests with phones + a typed name, judges on), the TV shows the VS intro, the performances as
// normal karaoke with a battle badge, the A/B vote with live bars, results with the bracket and
// the final podium; phones vote (contestants can't). Then a quick showcase with 1–10 scores.
//
//   node test/e2e/game-battle.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-battle');
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
/** Screenshot once the scene's entrance animation is over (and without the "your turn" alert). */
const shot = async (page, name) => {
  await sleep(900);
  await page.click('.g-alert .btn', { timeout: 300 }).catch(() => {});
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const room = () => app.room;
const game = () => app.room.game;
const until = async (pred, what, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred()) return true;
    await sleep(50);
  }
  throw new Error(`timeout: ${what}`);
};

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

/** The host starts the next performance; the TV plays it (we skip to the last seconds). */
async function perform(host, tv, label, shots = false) {
  await host.click('.game-live .btn:has-text("Start performance")');
  await until(() => room().s.current && room().s.player.state === 'playing', `${label} starts playing`);
  const entryId = room().s.current.id;
  await tv.waitForSelector('.bt-badge', { timeout: 10000 });
  const badge = await tv.textContent('.bt-badge');
  if (shots) {
    await tv.waitForSelector('.scene:not(.intro)', { timeout: 10000 }).catch(() => {});
    await shot(tv, 'tv-singing');
    await shot(host, 'host-singing');
  }
  room().seek({ pos: Math.max(0, room().s.player.dur - 1.5) });
  room().markDirty();
  await until(() => !room().s.current || room().s.current.id !== entryId, `${label} ends on the TV`);
  return badge;
}

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const phones = { Ann: await phone('ann'), Bob: await phone('bob'), Cat: await phone('cat') };
  for (const [name, page] of Object.entries(phones)) await joinAs(page, name);

  // ---- setup on the Games page ------------------------------------------------------------------
  await host.goto(`${base}/host#/games`);
  await host.waitForSelector('.game-card');
  const card = host.locator('.game-card:has-text("Battle")');
  check(!(await card.locator('.btn:has-text("Coming soon")').count()), 'Battle is available on the Games page');
  await card.locator('.btn:has-text("Set up")').click();
  await host.waitForSelector('.game-card.open .battle-setup');
  await host.click('.bt-chips .chip:has-text("Ann")');
  await host.click('.bt-chips .chip:has-text("Bob")');
  await host.fill('.bt-add input', 'Dee');
  await host.press('.bt-add input', 'Enter');
  check((await host.$$('.bt-picked li')).length === 3, 'three contestants picked (two guests + a typed name)');
  check(await host.isDisabled('.game-card.open .btn.primary'), 'a duel with three can’t start');
  await host.locator('.game-card.open label.field', { hasText: 'Format' }).locator('select').selectOption('knockout');
  await host.locator('.bt-toggle', { hasText: 'Judges' }).locator('input').check();
  await shot(host, 'host-setup');
  await host.click('.game-card.open .btn.primary:has-text("Start the battle")');
  await host.waitForSelector('.game-live .battle-control');
  check(game()?.type === 'battle' && game().config.format === 'knockout' && game().config.judges, 'host started a knockout battle with judges');
  check(room().s.singers.some((s) => s.name === 'Dee'), 'the typed contestant became a singer');

  // ---- VS intro ------------------------------------------------------------------------------------
  await tv.waitForSelector('.bt-versus .bt-fighter');
  check((await tv.$$('.bt-fighter')).length === 2, 'TV shows the VS screen with both singers');
  await shot(tv, 'tv-1-vs');
  await phones.Cat.waitForSelector('.game-tab .bt-guest-vs');
  check(true, 'phones jump to the battle');
  await shot(phones.Cat, 'cat-1-vs');
  check((await host.$$('.bt-bracket .bt-bmatch')).length === 3, 'host sees the bracket (3 matches, one bye)');

  const names = (m) => [m.a, m.b].map((i) => game().contestants[i].name);
  let rounds = 0;
  while (game()?.phase !== 'final' && rounds < 3) {
    rounds++;
    const m = game().match();
    const [a, b] = names(m);
    await host.waitForSelector('.game-live .btn:has-text("Start performance")');
    const badge = await perform(host, tv, `${a}'s performance`, rounds === 1);
    if (rounds === 1) {
      check(/vs/i.test(badge) && badge.includes(a) && badge.includes(b), `battle badge over the karaoke (${badge.trim()})`);
      await tv.waitForSelector('.bt-nextup', { timeout: 10000 });
      await shot(tv, 'tv-2-next-up');
      // The judges score the first performance.
      await host.locator('.bt-perf').first().locator('.bt-jbtn:has-text("8")').click();
      await until(() => game().perfs.some((p) => p.judge === 8), 'judge score saved');
      check(true, 'the host entered a judges’ score');
    }
    await perform(host, tv, `${b}'s performance`);
    await tv.waitForSelector('.bt-vote .bt-vote-card', { timeout: 10000 });
    check(game().phase === 'vote', `${m.id === game().matches.at(-1).id ? 'final' : 'semi-final'}: phones vote after both performances`);
    // Everyone who can vote picks side B (after a change of mind); contestants can't vote.
    let voted = 0;
    for (const [name, page] of Object.entries(phones)) {
      if ([a, b].includes(name)) {
        await page.waitForSelector('.game-tab .bt-own', { timeout: 10000 });
        if (rounds === 1) await shot(page, `${name.toLowerCase()}-own-match`);
        continue;
      }
      await page.waitForSelector('.game-tab .g-answer', { timeout: 10000 });
      await page.click('.g-answer >> nth=0');
      await page.click('.g-answer >> nth=1');
      voted++;
      if (rounds === 1 && name === 'Cat') {
        await sleep(200);
        await shot(page, 'cat-2-vote');
      }
    }
    // The first tap already makes the count right, so wait for the changed votes themselves.
    const allB = () => [...game().match().votes.values()].every((v) => v === 'b');
    await until(() => game().match().votes.size === voted && allB(), 'votes counted').catch(() => {});
    check(game().match().votes.size === voted && allB(), `${voted} phone vote(s) counted, changed votes replaced`);
    await tv.waitForFunction((n) => document.querySelectorAll('.bt-vote-num')[1]?.textContent.trim() === String(n), voted, { timeout: 5000 });
    check(true, 'TV shows live vote bars');
    if (rounds === 1) {
      await shot(tv, 'tv-3-vote');
      await shot(host, 'host-vote');
    }
    await host.click('.game-live .btn:has-text("Close voting now")');
    await tv.waitForSelector('.bt-result', { timeout: 10000 });
    const winner = game().contestants[game().match().winner].name;
    const judged = game().match().points;
    check((await tv.textContent('.g-tv-head h1')).includes(winner), `result on the TV: ${winner} wins (${judged.a}–${judged.b})`);
    if (rounds === 1) {
      await shot(tv, 'tv-4-result');
      await phones.Cat.waitForSelector('.bt-guest-points');
      await shot(phones.Cat, 'cat-3-result');
    }
    await host.click('.game-live .btn:has-text("Continue")');
    await until(() => ['vs', 'final'].includes(game().phase), 'next match or final');
  }
  check(rounds === 2, `two matches were sung (${rounds})`);

  // ---- final -----------------------------------------------------------------------------------------
  await tv.waitForSelector('.bt-final .bt-champion', { timeout: 10000 });
  const champ = game().contestants[game().champion].name;
  check((await tv.textContent('.bt-champion')).includes(champ), `TV crowns the champion (${champ})`);
  await sleep(600);
  await shot(tv, 'tv-5-final');
  await phones.Ann.waitForSelector('.game-tab .bt-standings');
  await shot(phones.Ann, 'ann-final');
  check((await phones.Ann.$$('.bt-standings li')).length === 3, 'phones show the final standings');
  await host.click('.game-live .btn:has-text("Continue")');
  await host.waitForSelector('.game-live .btn:has-text("Close")');
  const rec = room().s.tonight.games.at(-1);
  check(rec?.type === 'battle' && rec.title === 'Battle winner' && rec.winners[0] === champ, 'battle winner remembered for the party recap');
  check(room().s.tonight.history.filter((h) => h.game === 'battle').length === 4, 'all four performances are in tonight’s history');
  await host.click('.game-live .btn:has-text("Close")');
  check(await tv.waitForSelector('.lobby', { timeout: 10000 }).then(() => true, () => false), 'the TV goes back to the lobby');

  // ---- showcase: phones score 1–10 ---------------------------------------------------------------------
  await card.locator('.btn:has-text("Set up")').click();
  await host.waitForSelector('.game-card.open .battle-setup');
  await host.click('.bt-chips .chip:has-text("Ann")');
  await host.click('.bt-chips .chip:has-text("Dee")');
  await host.locator('.game-card.open label.field', { hasText: 'Format' }).locator('select').selectOption('showcase');
  await host.locator('.game-card.open label.field', { hasText: 'Songs' }).locator('select').selectOption('same');
  await host.click('.game-card.open .btn.primary:has-text("Start the battle")');
  await tv.waitForSelector('.bt-lineup .bt-lineup-item');
  check((await tv.$$('.bt-lineup-item')).length === 2, 'showcase: the TV introduces the line-up');
  await shot(tv, 'tv-6-lineup');
  for (let k = 0; k < 2; k++) {
    await perform(host, tv, `showcase performance ${k + 1}`);
    await tv.waitForSelector('.bt-score', { timeout: 10000 });
    await phones.Bob.waitForSelector('.bt-scores button');
    await phones.Bob.click(`.bt-scores button >> nth=${k === 0 ? 8 : 4}`);
    await phones.Cat.click(`.bt-scores button >> nth=${k === 0 ? 6 : 5}`);
    if (k === 0) {
      await sleep(200);
      await shot(phones.Bob, 'bob-score');
      await shot(tv, 'tv-7-score');
      await phones.Ann.waitForSelector('.game-tab .bt-own');
    }
    await until(() => game().perf().votes.size === 2, 'scores counted');
    await host.click('.game-live .btn:has-text("Close voting now")');
    await until(() => game().phase !== 'score', 'scoring closed');
  }
  await tv.waitForSelector('.bt-final', { timeout: 10000 });
  const first = game().perfs[0];
  check(game().champion === first.c && game().ranking[0].score === 8, `showcase: the best average wins (${game().ranking.map((r) => r.score).join(' vs ')})`);
  await sleep(600);
  await shot(tv, 'tv-8-showcase-final');
  host.once('dialog', (d) => d.accept());
  await host.click('.game-live .btn:has-text("End game")');
  await host.waitForSelector('.game-live .btn:has-text("Close")', { timeout: 15000 });
  await host.click('.game-live .btn:has-text("Close")');
  check(await phones.Cat.waitForSelector('.g-tabs button:has-text("Home").on', { timeout: 5000 }).then(() => true, () => false), 'phones go back home when the battle is closed');
  for (const [name, page] of Object.entries(phones)) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(overflow <= 0, `${name}'s phone fits without sideways scrolling`);
  }
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
