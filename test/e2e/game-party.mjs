#!/usr/bin/env node
// End-to-end check of the three small party games, started from the host's Games page:
//  1. Pass the mic — runs alongside a song on the TV: "PASS THE MIC ➜ NAME" over the lyrics, the
//     holder's phone says "You have the mic!", the host passes it on by hand.
//  2. Applause meter — Chromium's fake microphone (a beep) on the TV: countdown, live gauge, a
//     score > 0, a second singer to compare, and a blocked microphone reaching the host.
//  3. Party recap — after songs with ratings and reactions: slides on the TV (host next/goto,
//     auto-advance), the compact recap on the phones, the applause winner among the games.
//
//   node test/e2e/game-party.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-game-party');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
// Fake mic (a beep) and no permission prompt: what bin/open-tv.sh does with the real mic.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = async (page, name, wait = 700) => {
  await sleep(wait);
  // (the host page: show the running game's controls, not wherever the last click scrolled to)
  await page.evaluate(() => document.querySelector('.game-live')?.scrollIntoView({ block: 'start' })).catch(() => {});
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
const HOST = { role: 'host', data: {} };
const nameOf = (deviceId) => room().profileOf(deviceId)?.name;

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

/** Queues a song for `singerName` (host rules); it starts on the TV when nothing is on. */
function queue(title, singerName) {
  const song = room().catalog.search(title).items[0];
  const r = room().queueAdd(HOST, { songId: song.id, singerName });
  room().maybeAutoStart();
  room().markDirty();
  return r.entry;
}

async function openGame(host, label) {
  await host.click(`.game-card:has(h3:has-text("${label}")) .btn`);
  await host.waitForSelector('.game-card.open .g-setup');
}

async function endAndClose(host) {
  await host.click('.game-live .btn:has-text("End game")');
  await host.waitForSelector('.game-live .btn:has-text("Close")', { timeout: 10000 });
  await host.click('.game-live .btn:has-text("Close")');
  await until(() => !game(), 'game closed');
}

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  host.on('dialog', (d) => d.accept());
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const phones = { Ann: await phone('ann'), Bob: await phone('bob'), Cat: await phone('cat') };
  for (const [name, page] of Object.entries(phones)) await joinAs(page, name);
  await host.goto(`${base}/host#/games`);
  await host.waitForSelector('.game-card');
  const soon = await host.$$eval('.game-card', (l) => l.filter((c) => /Pass the mic|Applause meter|Party recap/.test(c.textContent) && c.classList.contains('soon')).length);
  check(soon === 0, 'the three games are no longer "coming soon"');

  // ---- 1. Pass the mic ------------------------------------------------------------------------------
  await openGame(host, 'Pass the mic');
  await host.selectOption('.game-card.open select >> nth=1', '5');
  await host.selectOption('.game-card.open select >> nth=2', '20');
  await shot(host, 'host-relay-setup', 200);
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .relay-control');
  check(game()?.type === 'relay' && game().config.everyone && game().config.min === 5 && game().config.max === 20, 'host started pass the mic (everyone, 5–20 s)');
  await phones.Bob.waitForSelector('.g-guest.relay', { timeout: 5000 });
  check(true, 'phones jump to the game tab');
  queue('neon heart', 'Ann');
  await until(() => room().s.current && room().s.player.state === 'playing', 'the song plays on the TV', 30000);
  check(!room().gameBlocks(), 'pass the mic runs alongside the karaoke');
  const ann = Object.keys(room().s.profiles).find((id) => nameOf(id) === 'Ann');
  check(game().holder === ann, 'Ann sings: she starts with the mic');
  game().remaining = 1500; // (don't wait up to 20 s for the first pass)
  await tv.waitForSelector('.rl-flash', { timeout: 10000 });
  const first = game().holder;
  const flashText = (await tv.textContent('.rl-flash')).replace(/\s+/g, ' ');
  check(first && first !== ann, `the mic passed on by itself to ${nameOf(first)}, not back to Ann`);
  check(/pass the mic/i.test(flashText) && flashText.includes(nameOf(first)), `TV flashes "PASS THE MIC ➜ ${nameOf(first)}"`);
  check(room().s.player.state === 'playing', '…while the song plays');
  await shot(tv, 'tv-relay-flash', 400);
  const holderPhone = phones[nameOf(first)];
  await holderPhone.waitForSelector('.rl-mine', { timeout: 5000 });
  check(/You have the mic/.test(await holderPhone.textContent('.rl-mine')), 'the holder’s phone says "You have the mic!"');
  await shot(holderPhone, 'phone-relay-mine', 300);
  const other = Object.entries(phones).find(([n]) => n !== nameOf(first))[1];
  check(!(await other.$('.rl-mine')) && (await other.textContent('.g-guest.relay')).includes(nameOf(first)), 'other phones see who has the mic');
  await host.click('.game-live .btn:has-text("Pass the mic now")');
  await until(() => game().passes >= 2, 'host passes the mic');
  check(game().holder !== first, `the host passed it on to ${nameOf(game().holder)} (never the same twice)`);
  await tv.waitForFunction((n) => document.querySelector('.rl-flash')?.textContent.includes(n), nameOf(game().holder), { timeout: 5000 });
  check(true, 'TV flashes the new holder');
  await tv.waitForSelector('.rl-badge', { timeout: 8000 });
  check((await tv.textContent('.rl-badge')).includes(nameOf(game().holder)), 'after the flash a small badge shows who has the mic');
  await shot(tv, 'tv-relay-badge', 200);
  await shot(host, 'host-relay-control', 100);
  const passes = game().passes;
  room().pause();
  room().markDirty();
  game().remaining = 500;
  await sleep(1500);
  check(game().passes === passes && game().phase === 'waiting', 'paused song: the mic stays put');
  room().resume();
  room().markDirty();
  await endAndClose(host);
  check(room().s.current?.title === 'Neon Heart', 'closing the game leaves the song playing');

  // ---- songs with reactions and ratings (for the recap) ----------------------------------------
  await phones.Bob.waitForSelector('.reaction-grid button', { timeout: 8000 });
  for (let i = 0; i < 3; i++) {
    await phones.Bob.click('.reaction-grid button >> nth=0');
    await sleep(120);
  }
  await until(() => (room().s.current?.reactions || 0) >= 3, 'reactions counted');
  const finishSong = async (raters, stars) => {
    const id = room().s.current.id;
    room().seek({ pos: Math.max(0, room().s.player.dur - 1.2) });
    room().markDirty();
    await until(() => !room().s.current || room().s.current.id !== id, 'the song ends on the TV', 20000);
    for (const p of raters) {
      await p.waitForSelector('.rate-card', { timeout: 8000 });
      await p.click(`.rate-stars button >> nth=${stars - 1}`);
    }
    await until(() => room().rating?.votes.size === raters.length, 'ratings counted');
    room().closeRating();
    room().markDirty();
  };
  await finishSong([phones.Bob, phones.Cat], 5);
  queue('tempo tantrum', 'Bob');
  await until(() => room().s.current && room().s.player.state === 'playing', 'the second song plays', 30000);
  await finishSong([phones.Ann, phones.Cat], 3);
  const done = room().s.tonight.history.filter((h) => !h.skipped);
  check(done.length === 2 && done.every((h) => h.rating), 'two songs sung and rated');

  // ---- 2. Applause meter ------------------------------------------------------------------------------
  await until(() => !room().s.current, 'nothing playing');
  await openGame(host, 'Applause meter');
  await host.fill('.game-card.open input', 'Ann');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .applause-control');
  check(game()?.type === 'applause' && game().phase === 'countdown', 'host started the applause meter for Ann');
  await tv.waitForSelector('.g-tv.applause .ap-count', { timeout: 5000 });
  await shot(tv, 'tv-applause-countdown', 300);
  await until(() => game().phase === 'measure', 'measuring', 6000);
  await until(() => game().levels.length >= 3, 'the TV reports levels', 5000);
  check(true, `the TV reports live levels (${game().levels.length} so far)`);
  await shot(tv, 'tv-applause-measure', 1200);
  await shot(phones.Cat, 'phone-applause-measure', 0);
  await until(() => game().phase === 'result', 'result', 12000);
  const r1 = game().results[0];
  check(r1 && r1.score > 0 && !r1.estimated, `the fake mic scored ${r1?.score} (final report from the TV)`);
  await tv.waitForSelector('.g-tv.applause .ap-list li', { timeout: 5000 });
  await shot(tv, 'tv-applause-result', 2000);
  await shot(phones.Ann, 'phone-applause-result', 0);
  await host.fill('.ap-next input', 'Bob');
  await host.click('.ap-next .btn:has-text("Next measurement")');
  await until(() => game().results.length === 2 && game().phase === 'result', 'second measurement', 15000);
  check(game().results[1].label === 'Bob' && game().results[1].score > 0, `Bob scored ${game().results[1].score}`);
  await tv.waitForFunction(() => document.querySelectorAll('.g-tv.applause .ap-list li').length === 2, null, { timeout: 5000 });
  check(true, 'TV compares both results');
  check((await host.$$('.applause-control .ap-list li.best')).length >= 1, 'host sees the loudest marked');
  await shot(tv, 'tv-applause-compare', 2000);
  await shot(host, 'host-applause-control', 0);
  // A blocked microphone reaches the host with a hint.
  await tv.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await host.click('.ap-next .btn:has-text("again")');
  await host.waitForSelector('.ap-error', { timeout: 8000 });
  const hint = await host.textContent('.ap-error');
  check(/blocked the microphone/.test(hint) && /Allow the microphone on the TV computer \(Chrome asks once\)/.test(hint), 'a blocked mic shows "Allow the microphone on the TV computer"');
  await shot(host, 'host-applause-mic-error', 0);
  check(game().results.length === 2, 'earlier results are kept');
  const winner = game().best().map((r) => r.label);
  await endAndClose(host);
  const rec = room().s.tonight.games.at(-1);
  check(rec?.type === 'applause' && rec.title === 'Loudest applause' && rec.winners.join() === winner.join(), `applause winner remembered for the recap (${winner.join(' & ')})`);

  // ---- 3. Party recap ------------------------------------------------------------------------------------
  await openGame(host, 'Party recap');
  await host.selectOption('.game-card.open select', '5');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .recap-control');
  const g = game();
  check(g?.type === 'recap' && g.recap.totals.songs === 2, 'host started the recap: 2 songs tonight');
  check(g.slides.join() === 'totals,singers,rated,artists,favourite,games,thanks', `all slides (${g.slides.join(', ')})`);
  await tv.waitForSelector('.g-tv.recap .rc-totals', { timeout: 5000 });
  check(/What a night/.test(await tv.textContent('.rc-totals')), 'TV: "What a night!" totals slide');
  await shot(tv, 'tv-recap-totals', 1600);
  await host.click('.recap-control .btn:has-text("Next")');
  await tv.waitForSelector('.rc-singers .g-podium', { timeout: 5000 });
  check(true, 'host → next: top singers podium');
  await shot(tv, 'tv-recap-singers', 900);
  for (const [i, sel, name] of [[2, '.rc-rated', 'rated'], [3, '.rc-artists', 'artists'], [4, '.rc-fav', 'favourite'], [5, '.rc-games', 'games'], [6, '.rc-thanks', 'thanks']]) {
    await host.click(`.rc-slides .chip >> nth=${i}`);
    await tv.waitForSelector(sel, { timeout: 5000 });
    await shot(tv, `tv-recap-${name}`, 1200);
  }
  check((await tv.$$('.rc-thanks')).length === 1, 'host jumps between slides; the last one says thanks');
  await host.click('.rc-slides .chip >> nth=5');
  await tv.waitForSelector('.rc-games', { timeout: 5000 });
  check((await tv.textContent('.rc-games')).includes('Loudest applause'), 'game winners include the applause meter');
  await host.click('.rc-slides .chip >> nth=4');
  await tv.waitForSelector('.rc-fav', { timeout: 5000 });
  check((await tv.textContent('.rc-fav')).includes('Neon Heart'), 'crowd favourite: the song with the reactions');
  await host.click('.rc-slides .chip >> nth=0');
  await until(() => game().index === 1, 'auto-advance', 9000);
  check(true, 'slides advance by themselves');
  await phones.Cat.waitForSelector('.g-guest.recap .rc-card', { timeout: 5000 });
  const cards = await phones.Cat.$$eval('.g-guest.recap .rc-card h2', (l) => l.map((x) => x.textContent));
  check(cards.includes('Top singers') && cards.includes('Best rated') && cards.includes('Game winners'), `phones show the compact recap (${cards.join(', ')})`);
  await shot(phones.Cat, 'phone-recap', 0);
  await phones.Cat.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(300);
  await phones.Cat.screenshot({ path: path.join(out, 'phone-recap-bottom.png') });
  await shot(host, 'host-recap-control', 0);
  for (const [name, p] of Object.entries(phones)) {
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(overflow <= 0, `${name}'s phone fits without sideways scrolling`);
  }
  await endAndClose(host);
  await tv.waitForSelector('.lobby', { timeout: 10000 });
  check(true, 'after the recap the TV goes back to the lobby');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: path.join(out, `failure-${Math.random().toString(36).slice(2, 6)}.png`) }).catch(() => {});
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
  // This run's own temporary library and data (the disk is shared with other test runs).
  for (const dir of [app.dataDir, ...app.library.paths]) if (dir?.includes('ok-e2e-')) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
