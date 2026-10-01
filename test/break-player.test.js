// The TV's break-music player (public/js/tv/break-player.js) with a fake <audio> element.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Enough of HTMLAudioElement: setting src reloads (back to 0:00), play() can fail or take a while. */
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.ended = false;
    this.volume = 1;
    this.currentTime = 0;
    this.loads = 0;
    this.attr = '';
    this.broken = new Set(); // urls that can't play
    this.playDelay = 0; // ms before play() resolves
  }

  get src() {
    return this.attr;
  }

  set src(url) {
    this.attr = url;
    this.loads++;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
  }

  play() {
    if (this.broken.has(this.attr)) {
      setTimeout(() => this.dispatchEvent(new Event('error')), 5);
      return Promise.reject(new Error('NotSupportedError'));
    }
    this.paused = false;
    const playing = () => this.dispatchEvent(new Event('playing'));
    if (!this.playDelay) {
      playing();
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(() => { playing(); resolve(); }, this.playDelay));
  }

  pause() {
    this.paused = true;
  }

  end() {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('ended'));
  }
}

globalThis.Audio = FakeAudio;
globalThis.document ??= { body: { appendChild() {} } };
const { BreakPlayer } = await import('../public/js/tv/break-player.js');

const ON = { main: true, unlocked: true, master: 1 };
const track = (id) => ({ id, url: `/media/${id}`, volume: 0.4 });
const flush = () => new Promise((r) => setImmediate(r));

function player(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const reports = [];
  const p = new BreakPlayer({ onEnded: (id, opts) => reports.push({ id, error: !!opts?.error }) });
  /** Lets fake time pass (fades step every 50 ms) and settles play() promises. */
  const pass = async (ms) => {
    for (let i = 0; i < ms; i += 50) {
      t.mock.timers.tick(Math.min(50, ms - i));
      await flush();
    }
  };
  return { p, el: p.el, reports, pass };
}

test('break player: a switch to another track survives further updates during the fade-out', async (t) => {
  const { p, el, reports, pass } = player(t);
  p.apply(track('a'), ON);
  await pass(3000);
  assert.equal(el.src, '/media/a');
  assert.ok(Math.abs(el.volume - 0.4) < 0.01, 'faded in');
  p.apply(track('b'), ON); // host pressed Skip
  await pass(200);
  p.apply(track('b'), ON); // any other broadcast (a rating vote, a guest joining…)
  await pass(200);
  p.apply(track('b'), ON);
  await pass(3000);
  assert.equal(el.src, '/media/b', 'the new track is playing');
  assert.equal(el.paused, false);
  assert.ok(Math.abs(el.volume - 0.4) < 0.01);
  el.end();
  assert.deepEqual(reports, [{ id: 'b', error: false }], 'its end is reported under its own id');
});

test('break player: a new track right after a fade to silence is not paused by that fade', async (t) => {
  const { p, el, pass } = player(t);
  p.apply(track('a'), ON);
  await pass(3000);
  el.playDelay = 2000; // a slow start (big file, busy disk)
  p.apply(null, ON); // a song starts…
  await pass(300);
  p.apply(track('c'), ON); // …and is stopped again straight away
  await pass(6000);
  assert.equal(el.src, '/media/c');
  assert.equal(el.paused, false, 'playing');
  assert.ok(el.volume > 0.39, 'and audible');
});

test('break player: an unplayable track is reported as an error, later after each failure, and never reloaded meanwhile', async (t) => {
  const { p, el, reports, pass } = player(t);
  el.broken.add('/media/x').add('/media/y');
  p.apply(track('x'), ON);
  await pass(100);
  assert.deepEqual(reports, [], 'not straight away');
  for (let i = 0; i < 10; i++) p.apply(track('x'), ON); // state broadcasts while it waits
  assert.equal(el.loads, 1, 'the broken track is not loaded again and again');
  await pass(1500);
  assert.deepEqual(reports, [{ id: 'x', error: true }]);
  p.apply(track('y'), ON); // the server's next pick fails too
  await pass(2900);
  assert.equal(reports.length, 1, 'the second failure waits longer');
  await pass(200);
  assert.deepEqual(reports.at(-1), { id: 'y', error: true });
  p.apply(track('z'), ON); // a good one: playing resets the wait
  await pass(3000);
  assert.equal(el.paused, false);
  el.broken.add('/media/w');
  p.apply(track('w'), ON);
  await pass(1600 + 800);
  assert.deepEqual(reports.at(-1), { id: 'w', error: true });
  // The server moved on before the wait was over: nothing is reported for the old track.
  el.broken.add('/media/v');
  p.apply(track('v'), ON);
  await pass(100);
  p.apply(null, ON);
  await pass(5000);
  assert.notEqual(reports.at(-1).id, 'v');
});

test('break player: the same track after a pause resumes where it stopped (no restart from 0:00)', async (t) => {
  const { p, el, pass } = player(t);
  p.apply(track('a'), ON);
  await pass(3000);
  el.currentTime = 42;
  p.apply(null, ON); // silence for a moment
  await pass(2000);
  assert.equal(el.paused, true);
  p.apply(track('a'), ON);
  await pass(2000);
  assert.equal(el.loads, 1);
  assert.equal(el.currentTime, 42);
  assert.equal(el.paused, false);
});
