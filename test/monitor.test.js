// The headphone monitor's rules without a browser: where the TV is, when the monitor plays,
// pauses or jumps, its delay and its own guide level (shared/monitor.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvPosition, monitorStep, monitorMix, monitorSource, clampDelay, MONITOR_TOLERANCE, MONITOR_SEEK_GAP, STALE_MS } from '../shared/monitor.js';

test('the TV’s position now, from its last report and the server clock', () => {
  assert.equal(tvPosition(null, 1000), null);
  assert.equal(tvPosition({ pos: 10, playing: false, at: 0 }, 5000), 10, 'paused: where it stopped');
  assert.equal(tvPosition({ pos: 10, playing: true, at: 1000 }, 1500), 10.5);
  assert.equal(tvPosition({ pos: 10, playing: true, at: 1000 }, 1500, 1.2), 10.6, 'faster at a faster tempo');
  assert.equal(tvPosition({ pos: 10, playing: true, at: 1000 }, 900), 10, 'a clock a little behind: not backwards');
  assert.equal(tvPosition({ pos: 10, playing: true, at: 0 }, 60_000), 10 + STALE_MS / 1000, 'an old report is not extrapolated for ever');
});

test('play, pause, jump: within the tolerance it is left alone, and jumps are spaced', () => {
  assert.deepEqual(monitorStep({ tv: 20, tvPlaying: true, position: 0, playing: false, now: 0 }), { action: 'play', to: 20 });
  assert.deepEqual(monitorStep({ tv: 20, tvPlaying: true, position: 0, playing: false, delayMs: 150, now: 0 }), { action: 'play', to: 20.15 }, 'late headphones: ahead');
  assert.deepEqual(monitorStep({ tv: 20, tvPlaying: false, position: 19, playing: true, now: 0 }), { action: 'pause' });
  assert.deepEqual(monitorStep({ tv: null, tvPlaying: true, position: 19, playing: true, now: 0 }), { action: 'pause' }, 'no report: wait');
  assert.deepEqual(monitorStep({ tv: 20, tvPlaying: false, position: 19, playing: false, now: 0 }), { action: null });
  const near = monitorStep({ tv: 20, tvPlaying: true, position: 20 + MONITOR_TOLERANCE - 0.01, playing: true, now: 10_000 });
  assert.equal(near.action, null);
  const off = monitorStep({ tv: 20, tvPlaying: true, position: 20.3, playing: true, now: 10_000, lastSeekAt: 0 });
  assert.deepEqual([off.action, off.to, Math.round(off.err * 100) / 100], ['seek', 20, 0.3]);
  assert.equal(monitorStep({ tv: 20, tvPlaying: true, position: 20.3, playing: true, now: 10_000, lastSeekAt: 10_000 - MONITOR_SEEK_GAP + 1 }).action, null, 'too soon after a jump');
  assert.equal(clampDelay(900), 500);
  assert.equal(clampDelay(-900), -500);
  assert.equal(clampDelay('abc'), 0);
  assert.equal(clampDelay(123.4), 123);
});

test('the mix: the room’s channels, its own guide level on a multiplex track; what it loads', () => {
  const mpx = { adjustable: true, side: 'L', a: 1 };
  assert.deepEqual(monitorMix({ channel: 'stereo', vocals: mpx, lead: 0 }, 100), { channel: 'stereo', vocals: mpx, lead: 100 });
  assert.deepEqual(monitorMix({ channel: 'stereo', vocals: mpx, lead: 50 }, null), { channel: 'stereo', vocals: mpx, lead: 50 }, 'none of its own: the room’s');
  assert.deepEqual(monitorMix({ channel: 'left', vocals: { adjustable: false }, lead: 0 }, 100), { channel: 'left', vocals: null, lead: 0 }, 'not multiplex: the room’s channels');
  assert.deepEqual(monitorMix(null), { channel: 'stereo', vocals: null, lead: 0 });
  assert.deepEqual(monitorSource({ kind: 'cdg', audio: '/media/a/audio', cdg: '/media/a/cdg' }), { mode: 'buffer', url: '/media/a/audio' });
  assert.deepEqual(monitorSource({ kind: 'cdg', audio: '/media/a/audio', stems: { music: '/m', vocal: '/v' } }), { mode: 'stems', url: '/m', vocal: '/v' }, 'separated: the stems');
  assert.deepEqual(monitorSource({ kind: 'video', video: '/media/v/video' }), { mode: 'element', url: '/media/v/video' });
  assert.equal(monitorSource({ kind: 'video', video: null, converting: {} }), null);
});
