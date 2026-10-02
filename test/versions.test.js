// Version play counts and votes (server/room/versions.js): the store, its file, the history
// backfill and the default-version rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VersionStats, HOST_VOTER, MAX_VOTERS, bestVersion, defaultReason, statusName } from '../server/room/versions.js';
import { tmpDir } from './helpers.js';

const G1 = 'guest-aaaa';
const G2 = 'guest-bbbb';
const G3 = 'guest-cccc';

async function store(t, { history = null, file = null } = {}) {
  const dir = await tmpDir('ok-versions-');
  const f = file || path.join(dir, 'versions.json');
  const s = new VersionStats(f);
  await s.load(history ?? path.join(dir, 'history.jsonl'));
  t.after(() => s.discard());
  return { s, dir, file: f };
}

test('versions: votes, take back, counts, status thresholds', async (t) => {
  const { s } = await store(t);
  s.vote('abc123', G1, 1);
  assert.deepEqual(s.info('abc123', G1), { plays: 0, up: 1, down: 0, host: 0, net: 1, status: 0, mine: 1 });
  s.vote('abc123', G1, -1);
  assert.deepEqual([s.info('abc123').up, s.info('abc123').down, s.mine(G1, 'abc123')], [0, 1, -1]);
  s.vote('abc123', G1, 0);
  assert.equal(s.info('abc123').down, 0);
  assert.ok(!Object.hasOwn(s.tracks, 'abc123'), 'an empty record goes');
  // net +1 → neither, +2 → liked; −1 → neither, −2 → avoided
  s.vote('t1', G1, 1);
  assert.equal(s.info('t1').status, 0);
  s.vote('t1', G2, 1);
  assert.equal(s.info('t1').status, 1);
  s.vote('t2', G1, -1);
  assert.equal(s.info('t2').status, 0);
  s.vote('t2', G2, -1);
  assert.equal(s.info('t2').status, -1);
  assert.equal(statusName(s.info('t2').status), 'avoided');
  // The host's vote counts in up/down, never in net — and settles the status.
  s.vote('t2', HOST_VOTER, 1);
  assert.deepEqual([s.info('t2').up, s.info('t2').down, s.info('t2').net, s.info('t2').status], [1, 2, -2, 1]);
  s.vote('t1', G3, 1);
  s.vote('t1', HOST_VOTER, -1);
  assert.equal(s.info('t1').status, -1, 'host down over guest net +3');
  assert.equal(s.info('t1', HOST_VOTER).mine, -1);
  // Plays.
  s.addPlay('t1');
  s.addPlay('t1');
  s.addPlay('../x');
  assert.equal(s.info('t1').plays, 2);
  assert.throws(() => s.vote('t1', G1, 2), TypeError);
  assert.throws(() => s.vote('t1', '__proto__', 1), TypeError);
  assert.throws(() => s.vote('__proto__', G1, 1), TypeError);
  // dropVoter
  assert.equal(s.dropVoter(G1), 2);
  assert.equal(s.mine(G1, 't1'), 0);
  assert.equal(s.dropVoter(G1), 0);
});

test('versions: a cap on voters per version; the host always votes', async (t) => {
  const { s } = await store(t);
  for (let i = 0; i < MAX_VOTERS; i++) s.vote('full1', `voter-${i}`, 1);
  assert.throws(() => s.vote('full1', 'voter-new', 1), (e) => e.code === 'full');
  s.vote('full1', 'voter-3', -1); // an existing voter can change
  s.vote('full1', HOST_VOTER, -1);
  const i = s.info('full1');
  assert.deepEqual([i.up, i.down, i.host], [MAX_VOTERS - 1, 2, -1]);
});

test('versions: the file — saved, loaded, cleaned of anything hostile; discard leaves it', async (t) => {
  const { s, file, dir } = await store(t);
  s.vote('keep1', G1, 1);
  s.addPlay('keep1');
  await s.flush();
  const again = new VersionStats(file);
  await again.load(path.join(dir, 'history.jsonl'));
  assert.deepEqual(again.info('keep1', G1), s.info('keep1', G1));

  const voters = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`many-${i}`, 1]));
  const hostile = `{"version":1,"backfilled":true,"tracks":{"__proto__":{"p":5,"v":{}},"constructor":{"p":1},
    "ok1":{"p":3,"v":{"__proto__":1,"constructor":1,"@host":-1,"${G1}":2,"${G2}":"1","${G3}":-1}},
    "big":{"p":0,"v":${JSON.stringify(voters)}},"BAD!":{"p":1},"neg":{"p":-4,"v":{}},"arr":[1]}}`;
  const hf = path.join(dir, 'hostile.json');
  await fs.writeFile(hf, hostile);
  const h = new VersionStats(hf);
  await h.load(null);
  assert.deepEqual(Object.keys(h.tracks).sort(), ['big', 'ok1']);
  assert.deepEqual(h.info('ok1'), { plays: 3, up: 0, down: 2, host: -1, net: -1, status: -1, mine: 0 });
  assert.equal(h.info('big').up, MAX_VOTERS);
  assert.equal(Object.getPrototypeOf(h.tracks), null);
  assert.equal({}.p, undefined, 'Object.prototype stays clean');
  h.vote('ok1', G1, 1);
  h.discard();
  assert.equal(await fs.readFile(hf, 'utf8'), hostile, 'discard writes nothing');
});

test('versions: the history is counted once (completed songs only)', async (t) => {
  const dir = await tmpDir('ok-versions-hist-');
  const hist = path.join(dir, 'history.jsonl');
  const lines = [
    { trackId: 'aaa1', skipped: false },
    { trackId: 'aaa1', skipped: false },
    { trackId: 'aaa1', skipped: true },
    { trackId: 'bbb2', skipped: false },
    { type: 'rating', trackId: 'bbb2', skipped: false },
    { trackId: '__proto__', skipped: false },
    { trackId: 'ccc3' },
  ].map((x) => JSON.stringify(x));
  await fs.writeFile(hist, `${lines.join('\n')}\n{"trackId":"aaa1","ski`);
  const file = path.join(dir, 'versions.json');
  const s = new VersionStats(file);
  await s.load(hist);
  assert.deepEqual([s.info('aaa1').plays, s.info('bbb2').plays, s.info('ccc3').plays], [2, 1, 0]);
  assert.equal(s.doc.data.backfilled, true);
  await s.flush();
  const again = new VersionStats(file);
  await again.load(hist);
  assert.equal(again.info('aaa1').plays, 2, 'not counted twice');
  // No history yet: nothing to count, done. A history that can't be read: tried again next time.
  const none = new VersionStats(path.join(dir, 'v2.json'));
  await none.load(path.join(dir, 'missing.jsonl'));
  assert.equal(none.doc.data.backfilled, true);
  const broken = new VersionStats(path.join(dir, 'v3.json'));
  await broken.load(dir); // a directory
  assert.equal(broken.doc.data.backfilled, false);
  none.discard();
  broken.discard();
  again.discard();
});

test('versions: the default — liked, neither, avoided; the host decides; a lone vote changes nothing', () => {
  const tracks = [{ id: 'a', s: 10 }, { id: 'b', s: 30 }, { id: 'c', s: 20 }];
  const infos = {};
  const infoOf = (id) => infos[id] || { status: 0, host: 0, net: 0 };
  const pick = (pref = null) => bestVersion(tracks, { infoOf, pref, scoreOf: (t) => t.s }).id;
  assert.equal(pick(), 'b', 'no votes: the label score');
  assert.equal(pick('c'), 'c', 'no votes: the version used last time');
  infos.a = { status: 0, host: 0, net: 1 };
  assert.equal(pick(), 'b', 'a lone +1 changes nothing');
  infos.a = { status: 1, host: 0, net: 2 };
  assert.equal(pick('c'), 'a', 'liked beats the last one and the label');
  infos.c = { status: 1, host: 1, net: -1 };
  assert.equal(pick(), 'c', 'the host’s pick beats a guest favourite with a higher net');
  infos.a = { status: -1, host: 0, net: -2 };
  infos.b = { status: -1, host: -1, net: 0 };
  infos.c = { status: -1, host: 0, net: -3 };
  assert.equal(pick(), 'a', 'all avoided: still one is returned');
  assert.equal(bestVersion([], { infoOf, scoreOf: () => 0 }), null);
  assert.equal(defaultReason({ id: 'x' }, { status: 1, host: 1 }, null), 'host');
  assert.equal(defaultReason({ id: 'x' }, { status: 1, host: 0 }, null), 'guests');
  assert.equal(defaultReason({ id: 'x' }, { status: 0, host: 0 }, 'x'), 'last');
  assert.equal(defaultReason({ id: 'x' }, { status: -1, host: 0 }, null), 'label');
});
