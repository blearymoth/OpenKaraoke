// Pitch rings (server/games/pitch.js + shared/pitch.js): the detector, octave fold, ring
// hits, TV report validation (main TV only, current round, fly only, 50–2000 Hz), mic
// errors, and the leaderboard (next singer, again, best, recap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import {
  detectPitch, centsBetween, centsOff, hit, pitchHeight, noteHz, pickNotes, scaleNotes,
  HOLE_CENTS, HZ_MIN, HZ_MAX,
} from '../shared/pitch.js';
import { MIC_HINT, SAMPLE_WINDOW_MS } from '../server/games/pitch.js';

function sine(freq, sr, n, amp = 0.6) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return b;
}

test('pitch detector: a synthetic sine is within a few cents; silence is not a pitch', () => {
  const sr = 44100;
  for (const freq of [196, 440, 880]) {
    const det = detectPitch(sine(freq, sr, 4096), sr);
    const cents = Math.abs(centsBetween(det.hz, freq));
    assert.ok(cents < 5, `${freq} Hz heard as ${det.hz} (${cents.toFixed(2)} cents)`);
    assert.ok(det.confidence > 0.5, `confidence ${det.confidence}`);
  }
  assert.equal(detectPitch(new Float32Array(4096), sr).hz, 0, 'silence');
  assert.equal(detectPitch(sine(440, sr, 4096, 0.001), sr).hz, 0, 'too quiet');
  assert.equal(detectPitch(sine(440, 48000, 4096), 48000).hz > 0, true, '48 kHz, the usual TV rate');
});

test('pitch: octave fold is a few cents, not 1200; the hole is ±80 cents; silence misses', () => {
  assert.ok(Math.abs(centsBetween(220, 440)) > 1100, 'raw interval is an octave');
  assert.ok(Math.abs(centsOff(220, 440)) < 1, `folded ${centsOff(220, 440)}`);
  assert.equal(hit(220, 440), true, 'an octave off still goes through the ring');
  assert.equal(hit(440, 440), true);
  const inside = 440 * 2 ** ((HOLE_CENTS - 5) / 1200);
  const outside = 440 * 2 ** ((HOLE_CENTS + 20) / 1200);
  assert.equal(hit(inside, 440), true);
  assert.equal(hit(outside, 440), false);
  for (const quiet of [0, null, undefined, NaN, 40, 3000]) assert.equal(hit(quiet, 440), false, String(quiet));
  const g3 = noteHz('G3');
  assert.ok(Math.abs(pitchHeight(g3, g3)) < 1e-9);
  assert.ok(Math.abs(pitchHeight(noteHz('G4'), g3)) < 1e-6, 'G4 lines up with G3');
  assert.ok(Math.abs(pitchHeight(noteHz('A3'), g3) - 200 / 1200) < 1e-6);
  assert.equal(pitchHeight(0, g3), null);
  assert.ok(noteHz('A4') === 440);
  const low = scaleNotes('low').map((n) => n.name);
  const mid = scaleNotes('mid').map((n) => n.name);
  const high = scaleNotes('high').map((n) => n.name);
  assert.deepEqual([low[0], low.at(-1)], ['G3', 'G4']);
  assert.deepEqual([mid[0], mid.at(-1)], ['C4', 'C5']);
  assert.deepEqual([high[0], high.at(-1)], ['G4', 'G5']);
  const stuck = pickNotes('mid', 8, () => 0);
  for (let i = 1; i < stuck.length; i++) assert.notEqual(stuck[i].name, stuck[i - 1].name);
  assert.equal(HZ_MIN, 50);
  assert.equal(HZ_MAX, 2000);
});

async function setup() {
  const env = await setupRoom();
  const host = await env.connect('host');
  const tv = await env.connect('tv');
  const mirror = await env.connect('tv', { display: 'mirror' });
  const ana = await env.guest('Ana');
  const report = (m, c = tv) => env.req(c, 'tv.game', { round: env.room.game.round, ...m });
  return { ...env, host, tv, mirror, ana, report };
}

/** Scores every ring: true clears, false misses with a bad pitch, missing is silence. */
function fly(g, hits) {
  g.samples = [];
  for (let i = 0; i < g.rings.length; i++) {
    const ring = g.rings[i];
    if (hits[i] === true) g.samples.push({ hz: ring.hz, at: ring.arriveAt - 40 });
    else if (hits[i] === false) g.samples.push({ hz: ring.hz * 2 ** (250 / 1200), at: ring.arriveAt - 40 });
    g.scoreRing(ring);
  }
  g.finishRun();
}

test('pitch rings: needs the main TV, then a run the host starts; phones do not see the next note', async () => {
  const { req, host, room, view, connect, leave, tv, mirror, ana } = await setup();
  leave(tv);
  leave(mirror);
  await assert.rejects(
    req(host, 'game.start', { type: 'pitch', config: { rings: 10, range: 'mid' } }),
    /Open the TV page on the party computer first/,
  );
  const tv2 = await connect('tv');
  await req(host, 'game.start', { type: 'pitch', config: { rings: 99, range: 'nope' } });
  const g = room.game;
  assert.equal(g.constructor.exclusive, true);
  assert.deepEqual(g.config, { rings: 20, range: 'mid' });
  assert.equal(g.phase, 'ready');
  assert.equal(view(ana).game.note, undefined);
  await req(host, 'game.action', { action: 'next', label: '  Ann  ' });
  assert.equal(g.phase, 'fly');
  assert.equal(g.label, 'Ann');
  assert.equal(g.rings.length, 20);
  for (let i = 1; i < g.rings.length; i++) assert.notEqual(g.rings[i].name, g.rings[i - 1].name);
  const names = g.rings.map((r) => r.name);
  const hv = view(host).game;
  const gv = view(ana).game;
  const tvv = view(tv2).game;
  assert.equal(hv.note, names[0]);
  assert.deepEqual(hv.upcoming, names);
  assert.equal(gv.note, undefined);
  assert.equal(gv.upcoming, undefined);
  assert.equal(gv.rings, undefined);
  assert.equal(gv.lowHz, undefined);
  assert.equal(gv.index, 1);
  assert.equal(gv.cleared, 0);
  assert.equal(tvv.rings.length, 20);
  assert.equal(tvv.rings[0].name, undefined);
  assert.equal(typeof tvv.rings[0].height, 'number');
  assert.equal(typeof tvv.rings[0].arriveAt, 'number');
  assert.ok(tvv.endsAt > Date.now());
  // A sample inside the hole clears; one outside misses; silence misses; a stale sample misses.
  const [a, b, c, d] = g.rings;
  g.samples = [{ hz: a.hz * 2 ** (40 / 1200), at: a.arriveAt - 20 }];
  g.scoreRing(a);
  assert.equal(a.cleared, true);
  g.samples.push({ hz: b.hz * 2 ** (200 / 1200), at: b.arriveAt - 20 });
  g.scoreRing(b);
  assert.equal(b.cleared, false);
  g.scoreRing(c);
  assert.equal(c.cleared, false, 'no note heard');
  g.samples.push({ hz: d.hz, at: d.arriveAt - SAMPLE_WINDOW_MS - 50 });
  g.scoreRing(d);
  assert.equal(d.cleared, false, 'too early to count');
  assert.equal(view(host).game.note, names[4], 'the host sees the next note');
  assert.equal(view(ana).game.note, undefined);
  assert.equal(view(ana).game.index, 5);
  assert.equal(view(ana).game.cleared, 1);
  assert.equal(view(ana).game.flash, 'miss');
  const body = JSON.stringify(view(ana).game);
  assert.equal(body.includes(names[4]), false, 'phones are not told the next note');
});

test('pitch rings: only the main TV’s valid reports for the current round count', async () => {
  const { req, host, room, mirror, ana, report } = await setup();
  await req(host, 'game.start', { type: 'pitch', config: { rings: 5, range: 'mid' } });
  await req(host, 'game.action', { action: 'next', label: 'Ann' });
  const g = room.game;
  assert.deepEqual(await report({ event: 'pitch', hz: 440 }, mirror), { ok: false }, 'a mirror display is ignored');
  await assert.rejects(req(ana, 'tv.game', { round: g.round, event: 'pitch', hz: 440 }), /not allowed/);
  await assert.rejects(req(host, 'tv.game', { round: g.round, event: 'pitch', hz: 440 }), /not allowed/);
  for (const hz of [NaN, Infinity, -1, 0, 49, 2001, '440', null, undefined]) {
    const before = g.samples.length;
    assert.equal((await report({ event: 'pitch', hz })).ok, false, `hz ${hz}`);
    assert.equal(g.samples.length, before);
  }
  assert.equal((await report({ event: 'pitch', hz: 440, round: g.round + 1 })).stale, true);
  assert.equal((await report({ event: 'pitch', hz: 440, round: undefined })).ok, false);
  assert.equal(g.samples.length, 0);
  await assert.rejects(report({ event: 'hack', hz: 440 }), /Unknown/);
  g.setPhase('ready');
  assert.equal((await report({ event: 'pitch', hz: 440 })).ok, false, 'not during fly');
  assert.equal(g.samples.length, 0);
  await req(host, 'game.action', { action: 'next', label: 'Ann' });
  for (let i = 0; i < 600; i++) await report({ event: 'pitch', hz: 440 });
  assert.ok(room.game.samples.length <= 480, 'samples are capped');
  assert.ok(room.game.samples.length >= 400);
});

test('pitch rings: a scripted run clears rings from samples and misses the rest', async () => {
  const { req, host, room, report, view, ana } = await setup();
  await req(host, 'game.start', { type: 'pitch', config: { rings: 5, range: 'high' } });
  const g = room.game;
  await req(host, 'game.action', { action: 'next', label: 'Ann' });
  assert.equal(g.config.range, 'high');
  const ring = g.rings[0];
  await report({ event: 'pitch', hz: ring.hz / 2 });
  g.samples.at(-1).at = ring.arriveAt - 30;
  g.scoreRing(ring);
  assert.equal(ring.cleared, true, 'octave fold clears the ring');
  assert.equal(view(ana).game.cleared, 1);
  assert.equal(view(ana).game.flash, 'pass');
  for (let i = 1; i < g.rings.length; i++) {
    const r = g.rings[i];
    const good = i === 1 || i === 2;
    if (good) g.samples = [{ hz: r.hz, at: r.arriveAt - 25 }];
    else if (i === 3) g.samples = [{ hz: r.hz * 2 ** (250 / 1200), at: r.arriveAt - 25 }];
    else g.samples = [];
    g.scoreRing(r);
  }
  g.finishRun();
  assert.equal(g.phase, 'turn');
  assert.deepEqual(g.results.map((r) => [r.label, r.score, r.total]), [['Ann', 3, 5]]);
});

test('pitch rings: mic errors from the TV reach the host with a hint; phones get a plain message', async () => {
  const { req, host, room, report, view, ana } = await setup();
  await req(host, 'game.start', { type: 'pitch', config: { rings: 5 } });
  await req(host, 'game.action', { action: 'next', label: 'Ann' });
  await report({ event: 'error', message: 'NotAllowedError: Permission denied' });
  assert.equal(room.game.phase, 'ready', 'no results yet');
  const hv = view(host).game;
  assert.match(hv.micError, /Permission denied/);
  assert.equal(hv.micHint, MIC_HINT);
  assert.equal(view(ana).game.micError, 'The microphone isn’t working right now.');
  assert.equal(view(ana).game.micHint, undefined);
  await assert.rejects(req(host, 'game.action', { action: 'again' }), /nothing to try again/);
  await req(host, 'game.action', { action: 'next', label: 'Ann' });
  assert.equal(room.game.phase, 'fly');
  assert.equal(view(host).game.micError, null);
  room.game.setPhase('turn');
  assert.deepEqual(await report({ event: 'error', message: 'late' }), { ok: false }, 'errors only count during fly');
});

test('pitch rings: next singer, again replaces, best score, recap summary', async () => {
  const { req, host, room, view, ana, s } = await setup();
  await req(host, 'game.start', { type: 'pitch', config: { rings: 5 } });
  const g = room.game;
  await req(host, 'game.action', { action: 'next', label: 'Ann' });
  fly(g, [true, true, true, false, false]);
  assert.equal(g.results[0].score, 3);
  await assert.rejects(req(ana, 'game.action', { action: 'next' }), /not allowed/);
  await req(host, 'game.action', { action: 'next', label: 'Ben' });
  await assert.rejects(req(host, 'game.action', { action: 'next', label: 'Cy' }), /Wait/);
  fly(g, [true, true, true, true, true]);
  let v = view(host).game;
  assert.deepEqual(v.results.map((r) => [r.label, r.score, r.best]), [['Ann', 3, false], ['Ben', 5, true]]);
  const { round } = await req(host, 'game.action', { action: 'again' });
  assert.equal(round, 3);
  fly(g, [true, false, false, false, false]);
  v = view(host).game;
  assert.deepEqual(v.results.map((r) => [r.label, r.score, r.best]), [['Ann', 3, true], ['Ben', 1, false]]);
  await req(host, 'game.action', { action: 'next', label: '' });
  fly(g, [false, false, false, false, false]);
  assert.equal(g.results.at(-1).label, 'Singer 3');
  assert.deepEqual(g.summary(), { title: 'Most rings', winners: ['Ann'] });
  await assert.rejects(req(host, 'game.action', { action: 'hack' }), /Unknown/);
  await req(host, 'game.end');
  assert.equal(view(ana).game.phase, 'done');
  assert.deepEqual(s().tonight.games.at(-1), { type: 'pitch', at: s().tonight.games.at(-1).at, title: 'Most rings', winners: ['Ann'] });
  await req(host, 'game.close');
});

test('pitch rings: a single named singer or unnamed results leave nothing for the recap', async () => {
  const { req, host, room, s } = await setup();
  await req(host, 'game.start', { type: 'pitch', config: { rings: 5 } });
  await req(host, 'game.action', { action: 'next', label: 'Solo' });
  fly(room.game, [true, true, true, true, true]);
  assert.equal(room.game.summary(), null);
  await req(host, 'game.action', { action: 'next' });
  fly(room.game, [true, true, true, true, true]);
  assert.equal(room.game.summary(), null, 'the best has no name');
  await req(host, 'game.close');
  assert.equal(s().tonight.games.length, 0);
});
