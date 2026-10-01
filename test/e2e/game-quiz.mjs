#!/usr/bin/env node
// End-to-end check of the music quiz: the host sets it up on the Games page, the TV plays the
// clips (reporting when each starts), shows lyrics screens / zooming covers, two phones answer,
// reveals and the leaderboard follow, and the final podium crowns the champion.
//
//   node test/e2e/game-quiz.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep, doubleClick } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-quiz');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const room = () => app.room;
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

/** The TV's audio engine (exposed by the test-only route in the TV page). */
let tvPage = null;
const engineState = () => tvPage.evaluate(() => {
  const c = window.__tvController;
  const e = c.engine;
  return { playing: e.playing, id: e.track?.id || null, key: e.key, rate: e.rate, dur: e.track?.duration, level: e.level(), gameAudio: c.gameAudio };
});

/** Everything a phone receives over its WebSocket (to prove no clip or answer ever reaches it). */
function recordFrames(page) {
  const frames = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  return frames;
}

try {
  // Cover art and years come from the fake provider network, so cover rounds are possible.
  app.settings.update({ artwork: { crawl: true } });
  app.artwork.crawlTick();
  check(await until(() => app.artwork.status().songs.pending === 0, 20000), 'metadata for the demo library is in');

  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/games`);
  await host.waitForSelector('.game-card');
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  // Test only: expose the TV's karaoke controller so the audio engine can be inspected.
  await tv.route('**/js/tv/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
  });
  tvPage = tv;
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  check(!(await tv.$('.start')), 'the TV can play sound (autoplay allowed)');
  const ann = await phone('ann');
  const bob = await phone('bob');
  const annFrames = recordFrames(ann);
  await joinAs(ann, 'Ann');
  await joinAs(bob, 'Bob');

  // ---- host setup ----
  await host.click('.game-card:has-text("Music quiz") .btn');
  await host.waitForSelector('.game-card.open .quiz-setup');
  await host.selectOption('.game-card.open select >> nth=0', '5');
  await host.selectOption('.game-card.open select >> nth=1', '10');
  for (const label of ['Snippet', 'Name the artist', 'Slow-mo', 'Decade']) await host.click(`.qz-rounds .chip:has-text("${label}")`);
  await host.click('.qz-switch');
  const on = await host.$$eval('.qz-rounds .chip.on', (l) => l.map((x) => x.textContent.trim()));
  check(on.length === 5, `five round types left on (${on.join(', ')})`);
  await sleep(300); // let the switch finish its transition
  await shot(host, 'host-quiz-setup');
  await host.click('.game-card.open .btn.primary');
  await host.waitForSelector('.game-live .quiz-control');
  const g = room().game;
  check(g?.type === 'quiz' && g.questions.length === 5 && g.config.seconds === 10 && g.config.popular === true, 'host started a 5-question quiz (10 s, popular songs)');
  const types = g.questions.map((q) => q.type);
  console.log(`  rounds: ${types.join(', ')}`);
  check(types.every((t) => ['intro', 'lyrics', 'cover', 'helium', 'reverse'].includes(t)), 'only the chosen round types');
  const tvEvents = [];
  const askedAt = [];
  const origAsk = g.ask.bind(g);
  g.ask = () => {
    askedAt[g.qi] = Date.now();
    return origAsk();
  };
  const origTv = g.tv.bind(g);
  g.tv = (c, m) => {
    tvEvents.push({ ...m, phase: g.phase, opened: g.opened, at: Date.now() });
    return origTv(c, m);
  };

  await tv.waitForSelector('.qz-ready');
  check(/Question 1/.test(await tv.textContent('.qz-ready')), 'TV: "Question 1 of 5" get-ready screen');
  await sleep(800);
  await shot(tv, 'tv-1-ready');
  check(await ann.waitForSelector('.qz-g-ready', { timeout: 5000 }).then(() => true, () => false), 'phones jump to the quiz');
  await shot(ann, 'ann-1-ready');

  // ---- five questions ----
  for (let i = 0; i < 5; i++) {
    const q = g.questions[i];
    let dbl = '';
    if (i === 1) {
      // The host double-clicks "Start the question now" (once the TV had a moment to load the
      // clip). By the second click the button reads "Close the question": the question still
      // opens with the TV's clip, and stays open.
      await until(() => g.qi === 1 && g.phase === 'get-ready', 12000);
      await sleep(800);
      dbl = await doubleClick(host, '.game-live .btn:has-text("Start the question now")');
    }
    await tv.waitForSelector('.qz-question', { timeout: 10000 });
    const opened = await until(() => g.qi === i && g.opened, 6000);
    const clipEvent = tvEvents.find((e) => e.q === i && e.event === 'clip');
    const delay = clipEvent && askedAt[i] ? clipEvent.at - askedAt[i] : -1;
    check(opened && !!clipEvent && !clipEvent.opened && delay >= 0 && delay < 3000, `Q${i + 1} (${q.type}): the TV started the ${q.clip.kind} and reported it ${delay} ms after the question appeared`);
    if (dbl) {
      await sleep(700);
      check(g.qi === 1 && g.phase === 'question' && g.opened && /disabled/.test(dbl), `Q2: a double click on "Start the question now" starts it once (the second click hit ${dbl})`);
    }
    if (q.type === 'lyrics') {
      const colours = await tv.$eval('.qz-lyrics canvas', (c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        for (let p = 0; p < d.length; p += 64) seen.add((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
        return seen.size;
      });
      check(colours >= 2, `lyrics screen drawn on the TV (${colours} colours)`);
      await sleep(300);
      await shot(tv, 'tv-lyrics');
    } else if (q.type === 'cover') {
      await tv.waitForSelector('.qz-cover img.go');
      check(true, 'cover zoom running on the TV');
      await sleep(1500);
      await shot(tv, 'tv-cover');
    } else {
      check(!!(await tv.$('.qz-listen .qz-eq')), 'TV shows the "listen" equaliser');
      if (i === 0 || q.type === 'helium') await shot(tv, `tv-${q.type}`);
    }
    // Phones: four tiles; Ann answers right, Bob wrong.
    await ann.waitForSelector('.qz-pad button.g-answer:not([disabled])');
    check((await ann.$$('.qz-pad .g-answer')).length === 4, `Q${i + 1}: four answer tiles on the phone`);
    if (i === 0) await shot(ann, 'ann-question');
    await ann.click(`.qz-pad .g-answer >> nth=${q.answer}`);
    await ann.waitForSelector('.qz-pad .g-answer.s-picked');
    check(/Locked in/.test(await ann.textContent('.g-guest.quiz')), 'Ann: "Locked in!"');
    if (i === 0) await shot(ann, 'ann-locked');
    if (q.clip.kind === 'audio') {
      // State broadcasts (Ann's answer) must not reset the clip's key/tempo to the karaoke's.
      await sleep(200);
      const e = await engineState();
      check(e.playing && e.id === `quiz:${g.id}:${i}:main` && e.key === q.clip.semitones && e.rate === q.clip.rate,
        `Q${i + 1}: the TV engine plays the clip (key ${e.key}, tempo ${e.rate}, ${e.dur?.toFixed(1)} s${q.clip.reverse ? ', reversed' : ''})`);
      let level = 0;
      await until(async () => (level = Math.max(level, (await engineState()).level)) > 0.01, 2000);
      check(level > 0.01, `Q${i + 1}: the clip is audible (level ${level.toFixed(3)})`);
    }
    if (i === 3) {
      // Bob doesn't answer; the host double-clicks "Close the question": the reveal stays up.
      const under = await doubleClick(host, '.game-live .btn:has-text("Close the question")');
      await tv.waitForSelector('.qz-reveal', { timeout: 5000 });
      await sleep(700);
      check(g.phase === 'reveal' && g.qi === 3 && !!(await tv.$('.qz-reveal')), `Q4: a double click on "Close the question" shows the answer (doesn’t skip it; the second click hit ${under})`);
      await ann.waitForSelector('.qz-verdict.right');
      await bob.waitForSelector('.qz-verdict.wrong:has-text("Too slow")');
    } else {
      await bob.click(`.qz-pad .g-answer >> nth=${(q.answer + 1) % 4}`);
      // Everyone answered → the question closes early.
      await tv.waitForSelector('.qz-reveal', { timeout: 5000 });
      const after = Date.now() - g.openedAt;
      check(after < 7000, `Q${i + 1}: closed early once both phones answered (${(after / 1000).toFixed(1)} s of 10)`);
      await ann.waitForSelector('.qz-verdict.right');
      await bob.waitForSelector('.qz-verdict.wrong');
    }
    if (q.clip.reveal) {
      const ok = await until(async () => {
        const e = await engineState();
        return e.playing && e.id === `quiz:${g.id}:${i}:reveal` && e.key === 0 && e.rate === 1;
      }, 3000);
      check(ok, `Q${i + 1}: the answer plays as it is (normal key and speed)`);
    }
    const tvText = await tv.textContent('.qz-reveal');
    check(tvText.includes(q.title) && /1 player got it right/.test(tvText), `Q${i + 1}: TV reveals "${q.title}" and who got it`);
    if (i === 0) {
      await sleep(700);
      await shot(tv, 'tv-reveal');
      await shot(ann, 'ann-reveal');
      await shot(bob, 'bob-reveal');
    }
    if (i === 2) {
      await host.click('.game-live .btn:has-text("Next")');
      await tv.waitForSelector('.qz-board');
      check(/Ann/.test(await tv.textContent('.qz-board .g-leaderboard li:first-child')), 'leaderboard after question 3: Ann leads');
      await bob.waitForSelector('.g-guest.quiz .g-leaderboard');
      await shot(tv, 'tv-leaderboard');
      await shot(bob, 'bob-leaderboard');
    }
    if (i < 4) {
      await host.click('.game-live .btn:has-text("Next")'); // skip the rest of the reveal / leaderboard
      await tv.waitForSelector('.qz-ready');
    }
  }

  // ---- final ----
  await host.click('.game-live .btn:has-text("Next")');
  await tv.waitForSelector('.qz-final .g-podium');
  check(/Ann is the quiz champion/.test(await tv.textContent('.qz-final')), 'TV: podium crowns Ann');
  await ann.waitForSelector('text=You won the quiz');
  check(/finished 2nd/.test(await bob.textContent('.g-guest.quiz')), 'Bob: "You finished 2nd!"');
  const ev = tvEvents.filter((e) => e.event === 'error');
  check(ev.length === 0, `the TV played every clip${ev.length ? `: ${ev.map((e) => e.error).join('; ')}` : ''}`);
  await sleep(800);
  await shot(tv, 'tv-final');
  await shot(ann, 'ann-final');
  await shot(host, 'host-quiz-final');
  // A tie at the top: both share the crown on the TV, the phones and in the recap.
  const players = room().game.players;
  const idOf = (name) => Object.keys(room().s.profiles).find((id) => room().s.profiles[id].name === name);
  players.get(idOf('Bob')).score = players.get(idOf('Ann')).score;
  room().markDirty();
  check(await tv.waitForSelector('.qz-final h1:has-text("Ann & Bob share the crown")', { timeout: 5000 }).then(() => true, () => false), 'TV: a tie shares the crown');
  check(await bob.waitForSelector('text=You share the win', { timeout: 5000 }).then(() => true, () => false), 'Bob: "You share the win!"');
  check(/You share the win/.test(await ann.textContent('.g-guest.quiz')), 'Ann: "You share the win!"');
  check((await bob.$$eval('.g-leaderboard .rank', (l) => l.map((x) => x.textContent))).join() === '1,1', 'phones: both are listed 1st');
  await sleep(500);
  await shot(tv, 'tv-final-tie');
  await shot(bob, 'bob-final-tie');
  await host.click('.game-live .btn:has-text("Finish")');
  await host.waitForSelector('.game-live .btn:has-text("Close")', { timeout: 5000 });
  const recap = room().s.tonight.games.at(-1);
  check(recap?.type === 'quiz' && recap.winners?.join() === 'Ann,Bob', 'the (tied) champions go into the party recap');
  await host.click('.game-live .btn:has-text("Close")');
  check(await tv.waitForSelector('.lobby', { timeout: 10000 }).then(() => true, () => false), 'after the quiz the TV goes back to the lobby');
  await sleep(1200);
  const e = await engineState();
  check(!e.playing && e.gameAudio === null, 'the quiz leaves the audio engine to the karaoke');

  const leaked = annFrames.filter((f) => /\/media\/|"clip"|"preload"/.test(f));
  check(annFrames.length > 10 && leaked.length === 0, `phones never received clips or media URLs (${annFrames.length} frames)`);
  const answersEarly = annFrames.filter((f) => /"phase":"question"/.test(f) && /"reveal":/.test(f));
  check(answersEarly.length === 0, 'phones never got the answer during a question');
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
