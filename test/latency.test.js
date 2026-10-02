import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClick, findArrival, summarize, verdict, PRE_ROLL_SECONDS, LISTEN_SECONDS } from '../shared/latency.js';

const SR = 48000;

/** A fake recording: room noise, then the click arriving `delayMs` after it was scheduled. */
function recording({ delayMs, gain = 0.3, noise = 0.003, smear = 0, extra = [] }) {
  const pre = Math.round(PRE_ROLL_SECONDS * SR);
  const out = new Float32Array(pre + Math.round(LISTEN_SECONDS * SR));
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 0x80000000 - 1; };
  for (let i = 0; i < out.length; i++) out[i] = rnd() * noise;
  const click = makeClick(SR);
  if (delayMs != null) {
    const at = pre + Math.round((delayMs / 1000) * SR);
    for (let i = 0; i < click.length; i++) out[at + i] += click[i] * gain;
    // a speaker that rings on: a decaying tail after the click
    for (let i = 0; i < smear; i++) out[at + click.length + i] += Math.sin(i / 3) * gain * 0.5 * Math.exp(-i / (smear / 4));
  }
  for (const { ms, amp, len } of extra) {
    const at = pre + Math.round((ms / 1000) * SR);
    for (let i = 0; i < len; i++) out[at + i] += (i % 2 ? 1 : -1) * amp;
  }
  return { samples: out, clickIndex: pre };
}

test('latency: the click is a short, repeatable burst', () => {
  const a = makeClick(SR);
  assert.equal(a.length, 192);
  assert.deepEqual(makeClick(SR), a);
  assert.ok(Math.max(...a.map(Math.abs)) <= 0.9);
  assert.ok(Math.abs(a[0]) < 0.1 && Math.abs(a.at(-1)) < 0.1, 'fades in and out');
});

test('latency: finds the click within a fraction of a millisecond', () => {
  for (const delayMs of [3, 18.5, 42, 120, 280]) {
    const { samples, clickIndex } = recording({ delayMs, smear: 900 });
    const r = findArrival(samples, clickIndex, SR);
    assert.ok(r.ms != null, `heard at ${delayMs} ms`);
    assert.ok(Math.abs(r.ms - delayMs) < 0.5, `${delayMs} ms → ${r.ms}`);
    assert.ok(r.snr > 10);
  }
});

test('latency: a quiet click in a noisy room is reported as not heard', () => {
  const { samples, clickIndex } = recording({ delayMs: 30, gain: 0.01, noise: 0.01 });
  const r = findArrival(samples, clickIndex, SR);
  assert.equal(r.ms, null);
  assert.equal(r.reason, 'quiet');
  const silent = recording({ delayMs: null });
  assert.equal(findArrival(silent.samples, silent.clickIndex, SR).ms, null);
});

test('latency: a short bump before the louder click does not count', () => {
  const { samples, clickIndex } = recording({ delayMs: 60, extra: [{ ms: 20, amp: 0.05, len: 40 }] });
  const r = findArrival(samples, clickIndex, SR);
  assert.ok(Math.abs(r.ms - 60) < 0.5, String(r.ms));
});

test('latency: noise before the scheduled click is not mistaken for it', () => {
  const { samples, clickIndex } = recording({ delayMs: 25, extra: [{ ms: -50, amp: 0.8, len: 100 }] });
  // the loud noise is in the pre-roll: it raises the noise floor but the click still stands out
  const r = findArrival(samples, clickIndex, SR);
  assert.ok(r.ms == null || Math.abs(r.ms - 25) < 0.5);
});

test('latency: bad input is handled', () => {
  assert.equal(findArrival(new Float32Array(10), 5, SR).ms, null);
  assert.equal(findArrival(new Float32Array(1000), 0, SR).ms, null);
});

test('latency: summary uses the median and ignores clicks that were not heard', () => {
  assert.deepEqual(summarize([20, 22, null, 21, 40]), { median: 21.5, min: 20, max: 40, spread: 20, heard: 4, total: 5 });
  assert.equal(summarize([10, 30, 20]).median, 20);
  assert.deepEqual(summarize([null, null]), { median: null, min: null, max: null, spread: null, heard: 0, total: 2 });
});

test('latency: verdicts', () => {
  assert.equal(verdict(8).level, 'great');
  assert.equal(verdict(15).level, 'good');
  assert.equal(verdict(30).level, 'fair');
  assert.equal(verdict(80).level, 'bad');
  assert.equal(verdict(null).level, 'unknown');
});
