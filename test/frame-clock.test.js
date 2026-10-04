// The lyrics' frame clock (public/js/lib/frame-clock.js): even steps, never backwards while
// playing, a jump to the media clock on seeks, the media clock as it is when paused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameClock } from '../public/js/lib/frame-clock.js';

const FRAME = 1000 / 60;

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
}

test('frame clock: never steps back while playing, even when the media clock jitters', () => {
  const clock = new FrameClock();
  const rand = lcg(3);
  let last = -Infinity;
  let backs = 0;
  let prevMedia = 0;
  for (let i = 0; i < 3600; i++) {
    const real = i / 60;
    // ±20 ms of jitter, and a mirror's re-anchor every 15 frames that lands up to 60 ms early
    const media = real + (rand() - 0.5) * 0.04 - (i % 15 === 0 ? rand() * 0.06 : 0);
    if (media < prevMedia) backs++;
    prevMedia = media;
    const t = clock.tick(i * FRAME, media, 1, true);
    assert.ok(t >= last, `frame ${i}: ${t} after ${last}`);
    last = t;
  }
  assert.ok(backs > 500, 'the media clock did go backwards');
  assert.ok(Math.abs(last - 3599 / 60) < 0.03, `still with the song after a minute (${last})`);
});

test('frame clock: jumps to the media clock on a seek (more than 0.25 s), either way', () => {
  const clock = new FrameClock();
  for (let i = 0; i < 60; i++) clock.tick(i * FRAME, 10 + i / 60, 1, true);
  assert.equal(clock.tick(60 * FRAME, 40, 1, true), 40, 'forward');
  assert.equal(clock.tick(61 * FRAME, 5, 1, true), 5, 'backward');
  const near = clock.tick(62 * FRAME, 5 + 1 / 60 + 0.2, 1, true);
  assert.ok(near > 5 && near < 5 + 1 / 60 + 0.2, `0.2 s off: pulled towards it, not jumped (${near})`);
});

test('frame clock: converges to the media clock, at the tempo', () => {
  const clock = new FrameClock();
  clock.tick(0, 0, 1.2, true);
  let t = 0;
  for (let i = 1; i <= 120; i++) t = clock.tick(i * FRAME, (i / 60) * 1.2 + 0.2, 1.2, true); // 0.2 s behind at first
  assert.ok(Math.abs(t - (2 * 1.2 + 0.2)) < 0.002, `caught up (${t})`);
  // even steps: once settled, every frame moves on by one frame at the tempo
  const steps = [];
  for (let i = 121; i < 180; i++) {
    const before = t;
    t = clock.tick(i * FRAME, (i / 60) * 1.2 + 0.2, 1.2, true);
    steps.push(t - before);
  }
  for (const s of steps) assert.ok(Math.abs(s - 1.2 / 60) < 1e-4, `step ${s}`);
});

test('frame clock: paused, stopped or unknown — the media clock as it is', () => {
  const clock = new FrameClock();
  for (let i = 0; i < 30; i++) clock.tick(i * FRAME, i / 60, 1, true);
  assert.equal(clock.tick(30 * FRAME, 0.4, 1, false), 0.4, 'paused: follows it, even backwards');
  assert.equal(clock.tick(31 * FRAME, 0.39, 1, false), 0.39);
  assert.ok(Number.isNaN(clock.tick(32 * FRAME, NaN, 1, true)), 'no media time: nothing to draw');
  assert.equal(clock.tick(33 * FRAME, 0.7, 1, true), 0.7, 'then starts again from the media clock');
  clock.reset();
  assert.equal(clock.tick(0, 12.5, 1, true), 12.5, 'reset: a new song starts where its clock is');
});
