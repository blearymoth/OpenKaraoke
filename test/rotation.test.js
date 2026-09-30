import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rounds, insertIndex, etas, shuffleFair } from '../server/room/rotation.js';

const e = (singer, dur = 200) => ({ id: `${singer}${Math.random()}`, singerIds: singer ? [singer] : [], dur, tempo: 1 });
const names = (q) => q.map((x) => x.singerIds[0] || '-').join('');

function add(queue, singer, opts = {}) {
  const entry = e(singer);
  const i = insertIndex(queue, entry, opts);
  queue.splice(i, 0, entry);
  return queue;
}

test('rounds count earlier entries of the same singer', () => {
  const q = [e('A'), e('B'), e('A'), e('C'), e('A')];
  assert.deepEqual(rounds(q), [0, 0, 1, 0, 2]);
  assert.deepEqual(rounds(q, 'A'), [1, 0, 2, 0, 3]);
});

test('rotation interleaves singers fairly', () => {
  const q = [];
  const opts = { newcomersFirst: false };
  add(q, 'A', opts); add(q, 'A', opts); add(q, 'A', opts);
  add(q, 'B', opts);
  assert.equal(names(q), 'ABAA');
  add(q, 'B', opts);
  assert.equal(names(q), 'ABABA');
  add(q, 'C', opts);
  assert.equal(names(q), 'ABCABA');
});

test('the singer on stage waits for others', () => {
  const q = [e('B'), e('C')];
  add(q, 'A', { currentSingerId: 'A', newcomersFirst: false });
  assert.equal(names(q), 'BCA');
});

test('newcomers go before people who already sang', () => {
  const sung = new Set(['A', 'B']);
  const opts = { hasSung: (s) => sung.has(s) };
  const q = [e('A'), e('B'), e('A')];
  add(q, 'N', opts);
  assert.equal(names(q), 'NABA');
  add(q, 'M', opts);
  assert.equal(names(q), 'NMABA', 'second newcomer after the first');
  add(q, 'N', opts);
  assert.equal(names(q), 'NMABAN', 'second song of a newcomer is a normal rotation insert (round 1)');
  const q2 = [e('A')];
  add(q2, 'Z', { ...opts, minIndex: 1 });
  assert.equal(names(q2), 'AZ', 'minIndex protects the singer who is up next');
});

test('fifo and entries without a singer append', () => {
  const q = [e('A'), e('A')];
  add(q, 'B', { mode: 'fifo' });
  assert.equal(names(q), 'AAB');
  add(q, null);
  assert.equal(names(q), 'AAB-');
});

test('etas add durations, countdowns and gaps', () => {
  const q = [e('A', 100), { ...e('B', 200), tempo: 2 }, e('C', 50)];
  assert.deepEqual(etas(q, { currentRemaining: 30, countdown: 10, gap: 5 }), [45, 45 + 10 + 100 + 5, 45 + 10 + 100 + 5 + 10 + 100 + 5]);
  assert.deepEqual(etas(q, { currentRemaining: 0, countdown: 0, gap: 0 }), [0, 100, 200]);
});

test('shuffleFair keeps rounds in order', () => {
  const q = [e('A'), e('B'), e('C'), e('A'), e('B'), e('A')];
  const out = shuffleFair(q, null, () => 0.3);
  assert.deepEqual(rounds(out), [0, 0, 0, 1, 1, 2]);
  assert.equal(out.length, 6);
  assert.deepEqual(new Set(out.slice(0, 3).map((x) => x.singerIds[0])), new Set(['A', 'B', 'C']));
  assert.equal(out[5].singerIds[0], 'A');
});
