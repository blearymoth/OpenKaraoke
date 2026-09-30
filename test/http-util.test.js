import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../server/http/router.js';
import { parseRange, safeJoin } from '../server/http/static.js';
import { Lru, memoPromise } from '../server/util/lru.js';
import { RateLimiter } from '../server/util/ratelimit.js';
import { Auth } from '../server/room/auth.js';
import { Settings } from '../server/config.js';
import { initialsOf, placeholderSvg } from '../server/artwork/placeholder.js';
import { tmpDir } from './helpers.js';

test('router matches params, wildcards and reports allowed methods', () => {
  const r = new Router();
  const a = () => 'a';
  const b = () => 'b';
  r.get('/api/songs/:id', a);
  r.post('/api/songs/:id/play', b);
  r.get('/js/*', b);
  assert.deepEqual(r.match('GET', '/api/songs/abc%20d').params, { id: 'abc d' });
  assert.equal(r.match('HEAD', '/api/songs/x').handler, a, 'GET routes answer HEAD');
  assert.deepEqual(r.match('GET', '/api/songs/x/play'), { allowed: ['POST'] });
  assert.deepEqual(r.match('GET', '/js/vendor/preact.js').params, { rest: 'vendor/preact.js' });
  assert.equal(r.match('GET', '/nope'), null);
  assert.equal(r.match('GET', '/api/songs/%E0%A4%A'), null, 'bad escapes do not throw');
});

test('parseRange', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-1', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'multi-range falls back to the whole file');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
});

test('safeJoin blocks traversal and hidden files', () => {
  assert.equal(safeJoin('/srv/public', 'js/app.js'), '/srv/public/js/app.js');
  assert.equal(safeJoin('/srv/public', '../secret'), null);
  assert.equal(safeJoin('/srv/public', 'js/../../etc/passwd'), null);
  assert.equal(safeJoin('/srv/public', '.env'), null);
  assert.equal(safeJoin('/srv/public', 'a\0b'), null);
  assert.equal(safeJoin('/srv/public', '/etc/passwd'), '/srv/public/etc/passwd', 'absolute paths stay inside');
});

test('Lru evicts by count and bytes; memoPromise shares work', async () => {
  const lru = new Lru({ max: 2, maxBytes: 10 });
  lru.set('a', Buffer.alloc(4));
  lru.set('b', Buffer.alloc(4));
  lru.get('a');
  lru.set('c', Buffer.alloc(4));
  assert.deepEqual([...lru.map.keys()], ['a', 'c'], 'least recently used evicted');
  lru.set('d', Buffer.alloc(8));
  assert.deepEqual([...lru.map.keys()], ['d']);
  assert.equal(lru.bytes, 8);
  lru.set('huge', Buffer.alloc(11));
  assert.equal(lru.get('huge'), undefined, 'too big to cache');

  let calls = 0;
  const cache = new Lru({ max: 4 });
  const work = () => { calls++; return new Promise((r) => setTimeout(() => r(Buffer.from('x')), 5)); };
  const [x, y] = await Promise.all([memoPromise(cache, 'k', work), memoPromise(cache, 'k', work)]);
  assert.equal(calls, 1);
  assert.equal(x, y);
  assert.ok(Buffer.isBuffer(cache.get('k')), 'resolved value replaces the promise');
});

test('RateLimiter refills over time', () => {
  const rl = new RateLimiter({ capacity: 2, perMs: 1000 });
  assert.equal(rl.take('ip', 1, 0), true);
  assert.equal(rl.take('ip', 1, 0), true);
  assert.equal(rl.take('ip', 1, 0), false);
  assert.equal(rl.take('ip', 1, 600), true, 'one token back after half the period');
  assert.equal(rl.take('other', 1, 0), true);
});

test('auth tokens: signing, PIN login and PIN change', async () => {
  const dir = await tmpDir();
  const settings = new Settings(dir);
  await settings.load();
  const auth = new Auth({ dataDir: dir, settings });
  await auth.load();
  assert.throws(() => auth.loginWithPin('1234', 'ip'), /PIN/, 'no PIN set: remote host disabled');
  settings.update({ party: { adminPin: '1234' } });
  assert.throws(() => auth.loginWithPin('0000', 'ip1'), /Wrong PIN/);
  const token = auth.loginWithPin('1234', 'ip1');
  assert.ok(auth.verify(token, 'host'));
  assert.equal(auth.verify(token, 'guest'), null);
  assert.equal(auth.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), 'host'), null);
  assert.equal(auth.isHost('203.0.113.5', token), true);
  assert.equal(auth.isHost('203.0.113.5', ''), false);
  assert.equal(auth.isHost('127.0.0.1', ''), true, 'this computer is trusted');
  settings.update({ party: { adminPin: '9999' } });
  assert.equal(auth.verify(token, 'host'), null, 'changing the PIN logs remote hosts out');

  const guest = auth.sign('guest', 'dev123');
  assert.deepEqual(auth.verify(guest, 'guest'), { role: 'guest', id: 'dev123' });

  const again = new Auth({ dataDir: dir, settings });
  await again.load();
  assert.equal(again.secret, auth.secret, 'secret persists');

  for (let i = 0; i < 5; i++) assert.throws(() => auth.loginWithPin('0000', 'flood'));
  assert.throws(() => auth.loginWithPin('9999', 'flood'), /Too many/);
});

test('placeholder artwork', () => {
  assert.equal(initialsOf('The Beatles'), 'B');
  assert.equal(initialsOf('Queen & David Bowie'), 'QD');
  assert.equal(initialsOf("Guns N' Roses"), 'GR');
  assert.equal(initialsOf(''), '♪');
  const svg = placeholderSvg({ artist: 'Adele <3' });
  assert.match(svg, /^<svg/);
  assert.ok(!svg.includes('<3'), 'escaped');
  assert.equal(placeholderSvg({ artist: 'Adele' }), placeholderSvg({ artist: 'ADELE' }), 'deterministic');
});
