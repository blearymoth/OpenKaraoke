// Applause meter (server/games/applause.js + shared/applause.js): the maths, TV report
// validation (main TV only, current round, 'measure' only, numbers 0–100), fallback scoring
// from levels, mic errors, results to compare singers, host controls and the recap summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import { levelFromRms, rmsOf, scoreLevels, validLevel, FLOOR_DB, CEIL_DB } from '../shared/applause.js';
import { MIC_HINT, COUNTDOWN_SECONDS, MEASURE_SECONDS } from '../server/games/applause.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('applause maths: RMS → level (linear in dB), validation, score = sustained noise + a bit of the peak', () => {
  assert.equal(rmsOf(new Float32Array(0)), 0);
  assert.equal(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(-1), 0);
  assert.equal(levelFromRms(NaN), 0);
  assert.equal(levelFromRms(10 ** (FLOOR_DB / 20)), 0);
  assert.equal(levelFromRms(10 ** (CEIL_DB / 20)), 100);
  assert.equal(levelFromRms(1), 100, 'clipped at 100');
  assert.ok(Math.abs(levelFromRms(10 ** (((FLOOR_DB + CEIL_DB) / 2) / 20)) - 50) < 1e-9, 'halfway in dB = 50');
  for (const bad of [NaN, Infinity, -1, 100.5, '50', null, undefined, {}]) assert.equal(validLevel(bad), false, String(bad));
  for (const ok of [0, 0.5, 50, 100]) assert.equal(validLevel(ok), true);
  assert.equal(scoreLevels([]), 0);
  assert.equal(scoreLevels(null), 0);
  assert.equal(scoreLevels([40, 40, 40, 40]), 40);
  // Louder half: [80, 60] → mean 70; peak 80 → 0.75·70 + 0.25·80 = 72.5 → 73 (rounded).
  assert.equal(scoreLevels([10, 80, 20, 60]), 73);
  // One clap in silence doesn't win against steady cheering.
  const clap = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100];
  const cheer = [55, 60, 58, 62, 60, 59, 61, 60, 57, 63];
  assert.ok(scoreLevels(cheer) > scoreLevels(clap), `${scoreLevels(cheer)} > ${scoreLevels(clap)}`);
  assert.equal(scoreLevels([50, 'x', NaN, 150, -3]), 50, 'invalid entries are ignored');
  assert.equal(scoreLevels(Array(25).fill(100)), 100);
});

async function setup() {
  const env = await setupRoom();
  const host = await env.connect('host');
  const tv = await env.connect('tv');
  const mirror = await env.connect('tv', { display: 'mirror' });
  const ana = await env.guest('Ana');
  const report = (m, c = tv) => env.req(c, 'tv.game', { round: env.room.game.round, ...m });
  /** Skips the 3 s countdown. */
  const measureNow = () => env.room.game.startMeasure();
  return { ...env, host, tv, mirror, ana, report, measureNow };
}

test('applause: needs the main TV; the countdown then a 5 s measurement; phones and the TV follow along', async () => {
  const { req, host, room, view, connect, leave, tv, mirror, ana, report, measureNow } = await setup();
  assert.equal(tv.data.display, 'main');
  leave(tv);
  leave(mirror); // (it would take over as the main TV)
  await assert.rejects(req(host, 'game.start', { type: 'applause', config: { label: 'for Ann' } }), /TV page/);
  const tv2 = await connect('tv');
  assert.equal(tv2.data.display, 'main');
  await req(host, 'game.start', { type: 'applause', config: { label: '  for   Ann  ' } });
  const g = room.game;
  assert.equal(g.constructor.exclusive, true);
  let v = view(tv2).game;
  assert.equal(v.phase, 'countdown');
  assert.equal(v.label, 'for Ann');
  assert.equal(v.round, 1);
  assert.ok(v.endsAt - Date.now() > (COUNTDOWN_SECONDS - 1) * 1000);
  assert.equal(view(ana).game.phase, 'countdown');
  // Levels before the measurement don't count.
  assert.deepEqual(await report({ event: 'level', level: 50 }, tv2), { ok: false });
  measureNow();
  v = view(tv2).game;
  assert.equal(v.phase, 'measure');
  assert.ok(v.endsAt - Date.now() > (MEASURE_SECONDS - 1) * 1000);
  await report({ event: 'level', level: 42.4 }, tv2);
  assert.equal(view(host).game.level, 42, 'hosts and phones see the live level');
  assert.equal(view(ana).game.level, 42);
  await report({ event: 'result', score: 77.6 }, tv2);
  v = view(ana).game;
  assert.equal(v.phase, 'result');
  assert.equal(v.level, 0);
  assert.deepEqual(v.results.map((r) => [r.label, r.score, r.estimated]), [['for Ann', 78, false]]);
  assert.equal(v.lastId, v.results[0].id);
});

test('applause: only the main TV’s valid reports for the current round count', async () => {
  const { req, host, room, mirror, ana, report, measureNow } = await setup();
  await req(host, 'game.start', { type: 'applause' });
  measureNow();
  const g = room.game;
  assert.deepEqual(await report({ event: 'level', level: 90 }, mirror), { ok: false }, 'a mirror display is ignored');
  await assert.rejects(req(ana, 'tv.game', { round: g.round, event: 'result', score: 100 }), /not allowed/, 'phones can’t report');
  await assert.rejects(req(host, 'tv.game', { round: g.round, event: 'result', score: 100 }), /not allowed/);
  for (const level of [NaN, -1, 101, '50', null, Infinity]) {
    await assert.rejects(report({ event: 'level', level }), /0 to 100/, `level ${level}`);
  }
  await assert.rejects(report({ event: 'result', score: 1e6 }), /0 to 100/);
  await assert.rejects(report({ event: 'result' }), /0 to 100/);
  await assert.rejects(report({ event: 'hack' }), /Unknown/);
  assert.equal((await report({ event: 'result', score: 99, round: g.round + 1 })).ok, false, 'another round');
  assert.equal((await report({ event: 'result', score: 99, round: undefined })).ok, false, 'no round');
  assert.equal(g.phase, 'measure');
  assert.equal(g.levels.length, 0);
  for (let i = 0; i < 200; i++) await report({ event: 'level', level: 30 });
  assert.ok(g.levels.length <= 120, 'levels are capped');
  await report({ event: 'result', score: 64 });
  assert.equal(g.results[0].score, 64);
  assert.deepEqual(await report({ event: 'result', score: 10 }), { ok: false }, 'one result per measurement');
  assert.equal(g.results.length, 1);
});

test('applause: without a final report the score comes from the levels; without levels the measurement fails', async () => {
  const { req, host, room, report, measureNow, view } = await setup();
  await req(host, 'game.start', { type: 'applause', config: { label: 'Ann' } });
  const g = room.game;
  measureNow();
  for (const level of [10, 80, 20, 60]) await report({ event: 'level', level });
  g.complete(null); // (what the grace timer does when the TV's result never arrives)
  assert.equal(g.phase, 'result');
  assert.deepEqual(g.results.map((r) => [r.score, r.estimated, r.peak]), [[73, true, 80]]);
  // Nothing at all from the TV: an error, the earlier results stay.
  await req(host, 'game.action', { action: 'measure', label: 'Ben' });
  measureNow();
  g.complete(null);
  assert.equal(g.phase, 'result');
  assert.equal(g.results.length, 1);
  assert.match(view(host).game.micError, /No sound level/);
  assert.equal(view(host).game.micHint, MIC_HINT);
  // The real timer: the window plus a grace period.
  await req(host, 'game.action', { action: 'measure', label: 'Cy' });
  g.setPhase('measure', 0.05);
  g.later(80, () => g.complete(null));
  await report({ event: 'level', level: 50 });
  await sleep(150);
  assert.equal(g.phase, 'result');
  assert.equal(g.results.at(-1).label, 'Cy');
  assert.equal(g.results.at(-1).score, 50);
  assert.equal(view(host).game.micError, null, 'a new measurement clears the error');
});

test('applause: mic errors from the TV reach the host with a hint; phones get a plain message', async () => {
  const { req, host, room, report, view, ana, tv } = await setup();
  await req(host, 'game.start', { type: 'applause' });
  await report({ event: 'error', message: 'NotAllowedError: Permission denied' });
  assert.equal(room.game.phase, 'ready', 'no results yet');
  const hv = view(host).game;
  assert.match(hv.micError, /Permission denied/);
  assert.equal(hv.micHint, MIC_HINT);
  assert.match(hv.micHint, /Allow the microphone on the TV computer \(Chrome asks once\)/);
  assert.match(view(tv).game.micError, /Permission denied/);
  assert.equal(view(ana).game.micError, 'The microphone isn’t working right now.');
  assert.equal(view(ana).game.micHint, undefined);
  assert.deepEqual(await report({ event: 'error', message: 'late' }), { ok: false }, 'errors only count while measuring');
  await assert.rejects(req(host, 'game.action', { action: 'again' }), /nothing to measure again/);
  await req(host, 'game.action', { action: 'measure', label: 'Ann' });
  assert.equal(room.game.phase, 'countdown');
  assert.equal(view(host).game.micError, null);
});

test('applause: compare singers — next measurement, measure again (replaces), best, remove, cancel, summary', async () => {
  const { req, host, room, report, measureNow, view, ana, s } = await setup();
  await req(host, 'game.start', { type: 'applause', config: { label: 'Ann' } });
  const g = room.game;
  measureNow();
  await report({ event: 'result', score: 60 });
  await assert.rejects(req(ana, 'game.action', { action: 'measure' }), /not allowed/);
  await req(host, 'game.action', { action: 'measure', label: 'Ben' });
  await assert.rejects(req(host, 'game.action', { action: 'measure', label: 'Cy' }), /Wait/, 'one at a time');
  await assert.rejects(req(host, 'game.action', { action: 'again' }), /Wait/);
  measureNow();
  await report({ event: 'result', score: 85 });
  let v = view(host).game;
  assert.deepEqual(v.results.map((r) => [r.label, r.score, r.best]), [['Ann', 60, false], ['Ben', 85, true]]);
  // Measure Ben again: the new score replaces his old one.
  const { round } = await req(host, 'game.action', { action: 'again' });
  assert.equal(round, 3);
  assert.equal(view(host).game.label, 'Ben');
  measureNow();
  await report({ event: 'result', score: 40 });
  v = view(host).game;
  assert.deepEqual(v.results.map((r) => [r.label, r.score, r.best]), [['Ann', 60, true], ['Ben', 40, false]]);
  // Unlabelled measurements are numbered; cancel goes back to the results.
  await req(host, 'game.action', { action: 'measure', label: '' });
  measureNow();
  await req(host, 'game.action', { action: 'cancel' });
  assert.equal(g.phase, 'result');
  assert.equal(g.results.length, 2);
  await req(host, 'game.action', { action: 'measure' });
  measureNow();
  await report({ event: 'result', score: 60 });
  assert.equal(g.results.at(-1).label, 'Measurement 3');
  assert.deepEqual(g.best().map((r) => r.label), ['Ann', 'Measurement 3'], 'a tie');
  assert.deepEqual(g.summary(), { title: 'Loudest applause', winners: ['Ann'] }, 'only named results are remembered');
  await req(host, 'game.action', { action: 'remove', id: g.results[1].id });
  assert.deepEqual(g.results.map((r) => r.label), ['Ann', 'Measurement 3']);
  await assert.rejects(req(host, 'game.action', { action: 'remove', id: 'nope' }), /gone/);
  await assert.rejects(req(host, 'game.action', { action: 'fly' }), /Unknown/);
  await req(host, 'game.end');
  assert.equal(view(ana).game.phase, 'done');
  assert.deepEqual(s().tonight.games.at(-1), { type: 'applause', at: s().tonight.games.at(-1).at, title: 'Loudest applause', winners: ['Ann'] });
  await req(host, 'game.close');
});

test('applause: a single result or unnamed results leave nothing for the recap', async () => {
  const { req, host, room, report, measureNow, s } = await setup();
  await req(host, 'game.start', { type: 'applause', config: { label: 'Solo' } });
  measureNow();
  await report({ event: 'result', score: 50 });
  assert.equal(room.game.summary(), null);
  await req(host, 'game.action', { action: 'measure' });
  measureNow();
  await report({ event: 'result', score: 90 });
  assert.equal(room.game.summary(), null, 'the loudest has no name');
  await req(host, 'game.close');
  assert.equal(s().tonight.games.length, 0);
});
