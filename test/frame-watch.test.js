// The TV's frame-rate watch (public/js/tv/frame-watch.js), the half of the automatic lighter
// effects that looks at the frames: synthetic vsync timestamps at the refresh rates a TV window
// meets (60 Hz, a 30 or 24 Hz TV mode, a 120/144 Hz monitor), moved between screens, and slow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameWatch } from '../public/js/tv/frame-watch.js';

/**
 * Feeds `watch` the frames of `phases` ([seconds, hz, lyrics, every]: a frame every `every`
 * refreshes of an `hz` screen; `every` may be a list, used in turn) → the second it tripped, or null.
 */
function run(phases, watch = new FrameWatch()) {
  let ts = 1000;
  let t = 0;
  for (const [seconds, hz, lyrics, every = 1] of phases) {
    const steps = Array.isArray(every) ? every : [every];
    const end = t + seconds;
    for (let i = 0; t < end; i++) {
      const gap = (1000 / hz) * steps[i % steps.length];
      ts += gap;
      t += gap / 1000;
      if (watch.frame(ts, lyrics)) return Math.round(t * 10) / 10;
    }
  }
  return null;
}

test('frame watch: a steady screen never trips it, whatever its refresh', () => {
  for (const hz of [24, 25, 30, 50, 60, 120, 144]) assert.equal(run([[20, hz, false], [60, hz, true]]), null, `${hz} Hz`);
});

test('frame watch: moving to a slower screen is not slowness', () => {
  // the desktop app on native Wayland: the TV window opens on the host's screen, then the person drags it to the TV
  assert.equal(run([[30, 60, false], [60, 30, true]]), null, '60 Hz lobby, then lyrics on a 30 Hz 4K TV mode');
  assert.equal(run([[30, 60, false], [60, 24, true]]), null, '60 Hz, then 24 Hz');
  assert.equal(run([[30, 120, false], [60, 60, true]]), null, '120 Hz monitor, then a 60 Hz TV');
  assert.equal(run([[30, 144, true], [60, 60, true]]), null, 'moved while a song plays');
  assert.equal(run([[60, 144, true, [1, 1, 2]]]), null, 'a 144 Hz monitor at 96 fps is smooth enough');
});

test('frame watch: dropped frames while lyrics play trip it, in seconds', () => {
  const t40 = run([[10, 60, false], [60, 60, true, [1, 2]]]);
  assert.ok(t40 !== null && t40 <= 15, `60 Hz, lyrics at 40 fps (every other frame late): tripped at ${t40} s`);
  const t30 = run([[10, 60, false], [60, 60, true, [1, 2, 3]]]);
  assert.ok(t30 !== null && t30 <= 15, `60 Hz, lyrics at 30 fps unevenly: ${t30} s`);
  const t5 = run([[10, 60, false], [60, 5, true]]);
  assert.ok(t5 !== null && t5 <= 15, `5 fps: ${t5} s (it took 48 s with 120-frame windows)`);
  const t2 = run([[10, 60, false], [60, 2, true]]);
  assert.ok(t2 !== null && t2 <= 20, `2 fps: ${t2} s`);
  assert.equal(run([[10, 60, false], [60, 0.9, true]]), null, 'under 1 fps every gap is a break (the WebGL check catches software drawing)');
  assert.equal(run([[10, 60, false], [60, 60, true, [1, 1, 1, 1, 1, 1, 1, 1, 1, 2]]]), null, 'one late frame in ten is fine');
  assert.equal(run([[10, 60, false], [60, 60, false, [1, 3]]]), null, 'slow without lyrics: not its business');
});

test('frame watch: a pause, a hidden page or lyrics going away start a new window', () => {
  const w = new FrameWatch();
  let ts = 0;
  let i = 0;
  /** `ms` of frames on a 60 Hz screen, every other one a refresh late (40 fps). */
  const frames = (ms, lyrics, visible = true) => {
    let hit = null;
    for (const end = ts + ms; ts < end;) {
      const r = w.frame((ts += (1000 / 60) * (1 + (i++ % 2))), lyrics, visible);
      hit ||= r;
    }
    return hit;
  };
  assert.equal(frames(2100, true), null, 'one slow window');
  assert.equal(w.slow, 1);
  w.frame((ts += 3000), true); // a long stall: the next window starts afresh
  assert.equal(frames(1000, true), null);
  assert.equal(frames(3000, true, false), null, 'hidden: not measured');
  assert.equal(frames(1000, false), null, 'lyrics gone: a new window');
  assert.equal(w.slow, 1, 'not slow without lyrics, and not reset either');
  const hit = frames(2100, true);
  assert.ok(hit && Math.round(hit.fps) === 30 && Math.round(hit.best) === 60, `the next slow window with lyrics trips it (${JSON.stringify(hit)})`);
});
