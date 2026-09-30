import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertIndex, rounds, etas, leadOf, shuffled } from '../server/room/rotation.js';

let n = 0;
const e = (singer, extra = {}) => ({ id: `e${++n}`, singerIds: singer ? [singer] : [], dur: 180, tempo: 1, ...extra });
const names = (q) => q.map((x) => x.singerIds[0] || '-');

/** Adds entries one by one using the rotation rules and returns the singer order. */
function build(singers, opts = {}) {
  const q = [];
  for (const s of singers) {
    const entry = e(s);
    q.splice(insertIndex(q, entry, opts), 0, entry);
  }
  return q;
}

test('fifo appends', () => {
  assert.deepEqual(names(build(['a', 'a', 'b'], { mode: 'fifo' })), ['a', 'a', 'b']);
});

test('rotation interleaves singers round by round', () => {
  const q = build(['a', 'a', 'a', 'b', 'c', 'b'], { newcomersFirst: false });
  assert.deepEqual(names(q), ['a', 'b', 'c', 'a', 'b', 'a']);
  assert.deepEqual(rounds(q), [0, 0, 0, 1, 1, 2]);
});

test('a latecomer sings after the current round, not at the end', () => {
  const q = build(['a', 'b', 'a', 'b', 'a'], { newcomersFirst: false });
  assert.deepEqual(names(q), ['a', 'b', 'a', 'b', 'a']);
  const late = e('c');
  q.splice(insertIndex(q, late, { newcomersFirst: false }), 0, late);
  assert.deepEqual(names(q), ['a', 'b', 'c', 'a', 'b', 'a']);
});

test('the singer on stage counts as one entry in round 0', () => {
  const q = build(['b', 'c'], { newcomersFirst: false, currentLead: 'a' });
  const next = e('a');
  q.splice(insertIndex(q, next, { newcomersFirst: false, currentLead: 'a' }), 0, next);
  assert.deepEqual(names(q), ['b', 'c', 'a']);
  const d = e('d');
  q.splice(insertIndex(q, d, { newcomersFirst: false, currentLead: 'a' }), 0, d);
  assert.deepEqual(names(q), ['b', 'c', 'd', 'a'], 'd (round 0) goes before a (round 1)');
});

test('newcomers go before round-0 entries of people who already sang', () => {
  const sung = new Set(['a', 'b']);
  const opts = { hasSung: (s) => sung.has(s) };
  const q = build(['a', 'b'], opts);
  const c = e('c');
  q.splice(insertIndex(q, c, opts), 0, c);
  assert.deepEqual(names(q), ['c', 'a', 'b']);
  const d = e('d');
  q.splice(insertIndex(q, d, opts), 0, d);
  assert.deepEqual(names(q), ['c', 'd', 'a', 'b'], 'newcomers keep their own order');
  const c2 = e('c');
  q.splice(insertIndex(q, c2, opts), 0, c2);
  assert.deepEqual(names(q), ['c', 'd', 'a', 'b', 'c'], 'second song is round 1');
});

test('entries without a singer are appended to their round', () => {
  const q = build(['a', null, 'b']);
  assert.equal(leadOf(q[1]).startsWith('entry:'), true);
  assert.deepEqual(names(q), ['a', '-', 'b']);
});

test('ETA adds song length, countdown and changeover time', () => {
  const q = [e('a', { dur: 100 }), e('b', { dur: 200, tempo: 0.8 }), e('c')];
  assert.deepEqual(etas(q, { remaining: 30, hasCurrent: true, countdown: 10, gap: 5 }), [45, 160, 425]);
  assert.deepEqual(etas(q, { countdown: 0, gap: 0 }), [0, 100, 350]);
});

test('shuffle keeps every entry', () => {
  const list = [1, 2, 3, 4, 5];
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = shuffled(list, rng);
  assert.deepEqual([...out].sort(), list);
  assert.notDeepEqual(out, list);
});
