// Roulette wheel (server/games/wheel.js + shared/wheel.js): segments per kind, secret results,
// fair draws, host actions (queue song / genre / duet, buzz), spin again with removal, input limits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';
import { Wheel, parseDares, LEAD_SECONDS } from '../server/games/wheel.js';
import {
  DEFAULT_DARES, MAX_DARES, MAX_DARE_LENGTH, SPIN_SECONDS, WHEEL_COLORS,
  landingRotation, segmentAt, rotationAt, spinEase, segmentColor,
} from '../shared/wheel.js';
import { GAME_SETTLE_MS } from '../shared/protocol.js';

const ALL = [...SONGS, ...MORE_SONGS];
// Most tests need no more than one song (each harness song is a 1.4 MB file on disk).
const TINY = ['ABBA - Waterloo [SF Karaoke]'];
const DUET_SONGS = ['Sonny & Cher - I Got You Babe [SF Karaoke]', 'Peabo Bryson & Regina Belle - A Whole New World [SC Karaoke]'];

/** Makes the running wheel's spin finish now (no 6-second waits in tests). */
function land(room) {
  const g = room.game;
  assert.equal(g.phase, 'spinning');
  g.clearTimers();
  g.reveal();
  room.markDirty();
}

// Each room writes a library + data folder into the temp dir: remove this file's own ones at the end.
const apps = [];
after(async () => {
  const tmp = os.tmpdir();
  for (const app of apps) {
    await app.close().catch(() => {});
    for (const dir of [...app.library.paths, app.dataDir]) {
      if (path.dirname(dir) === tmp && /^ok-(lib|data)-/.test(path.basename(dir))) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

async function party(opts = {}, settings = { playback: { countdown: 0, autoStart: false } }) {
  const h = await setupRoom(settings, { songs: opts.songs || TINY });
  apps.push(h.app);
  const host = await h.connect('host');
  const tv = await h.connect('tv');
  return { ...h, host, tv };
}

// ---- geometry ---------------------------------------------------------------------------------

test('wheel geometry: the landing rotation puts the pointer inside the drawn segment', () => {
  for (const n of [2, 3, 6, 7, 8, 11, 12]) {
    for (let index = 0; index < n; index++) {
      for (const offset of [0.15, 0.5, 0.85]) {
        for (const from of [0, 17.5, 359.9]) {
          const to = landingRotation(from, index, n, offset, 5);
          assert.equal(segmentAt(to, n), index, `n=${n} i=${index} offset=${offset} from=${from}`);
          assert.ok(to - from >= 5 * 360 && to - from < 6 * 360, 'exactly `turns` full turns plus the rest');
        }
      }
    }
  }
  assert.equal(segmentAt(0, 8), 0, 'segment 0 starts under the pointer');
  assert.equal(segmentAt(-10, 8), 0);
  assert.equal(segmentAt(10, 8), 7, 'turning clockwise brings the last segment under the pointer');
  assert.equal(spinEase(0), 0);
  assert.equal(spinEase(1), 1);
  assert.equal(spinEase(2), 1);
  assert.ok(spinEase(0.5) > 0.9, 'most of the distance is covered early; a long slow-down follows');
  const spin = { from: 30, to: 30 + 1800, startsAt: 1000, duration: 6 };
  assert.equal(rotationAt(spin, 0), 30, 'holds still before the start');
  assert.equal(rotationAt(spin, 7000), 1830);
  assert.equal(rotationAt(spin, 99999), 1830);
  let prev = -Infinity;
  for (let t = 1000; t <= 7000; t += 250) {
    const r = rotationAt(spin, t);
    assert.ok(r >= prev, 'never turns backwards');
    prev = r;
  }
  for (let n = 2; n <= 12; n++) {
    const colors = Array.from({ length: n }, (_, i) => segmentColor(i, n));
    for (let i = 0; i < n; i++) assert.notEqual(colors[i], colors[(i + 1) % n], `neighbours differ (n=${n})`);
  }
  assert.equal(WHEEL_COLORS.length, 12);
});

// ---- setup validation --------------------------------------------------------------------------

test('wheel: host input is sanitised — kinds, segment count, filters, dares limits', () => {
  const room = { catalog: {}, settings: {} };
  const c = Wheel.sanitize({ kind: 'nope', count: 99, tag: '  Duets ', decade: 1987, who: 'x' }, room);
  assert.equal(c.kind, 'songs', 'unknown kinds fall back to songs');
  assert.equal(c.count, 12);
  assert.equal(c.tag, 'Duets');
  assert.equal(c.decade, 1980, 'decades are rounded down');
  assert.equal(c.who, 'all');
  assert.equal(Wheel.sanitize({ count: 2 }, room).count, 6);
  assert.equal(Wheel.sanitize({ count: 'abc' }, room).count, 8);
  assert.equal(Wheel.sanitize({ decade: '' }, room).decade, 0, '"Any" decade is no filter');
  assert.equal(Wheel.sanitize({ kind: '__proto__' }, room).kind, 'songs');
  assert.equal(Wheel.sanitize({ kind: 'singers', who: 'online', tag: 'Duets' }, room).tag, '', 'filters only for song wheels');
  assert.equal(Wheel.sanitize({ kind: 'singers', who: 'online' }, room).who, 'online');
  assert.deepEqual(Wheel.sanitize({ kind: 'dares' }, room).dares, DEFAULT_DARES, 'default dares');
  assert.deepEqual(Wheel.sanitize({ kind: 'songs', dares: 'x\ny' }, room).dares, [], 'dares only for dare wheels');

  // Dares: one per line, cleaned, de-duplicated, limited.
  assert.deepEqual(parseDares('  Sing   high \r\n\n\tDance\u0000 now\nsing HIGH\n'), ['Sing high', 'Dance now']);
  assert.deepEqual(parseDares(['Hop', 'Skip', 42, null, 'hop']), ['Hop', 'Skip']);
  assert.deepEqual(parseDares('🙃\n💃'), ['🙃', '💃'], 'emoji-only dares are distinct');
  assert.deepEqual(parseDares('<b>Bold</b>\nx'), ['<b>Bold</b>', 'x'], 'kept as plain text (the UI escapes it)');
  assert.throws(() => parseDares('only one'), /at least two/);
  assert.throws(() => parseDares('\n \n'), /at least two/);
  assert.throws(() => parseDares({ a: 1 }), /one per line/);
  assert.throws(() => parseDares(Array.from({ length: MAX_DARES + 1 }, (_, i) => `Dare ${i}`).join('\n')), /Up to 40 dares/);
  assert.throws(() => parseDares(Array.from({ length: 200 }, (_, i) => `Dare ${i}`)), /Up to 40 dares/);
  assert.throws(() => parseDares(`ok\n${'x'.repeat(MAX_DARE_LENGTH + 1)}`), /under 100 characters/);
  assert.equal(parseDares(`ok\n${'x'.repeat(MAX_DARE_LENGTH)}`).length, 2, 'exactly the limit is fine');
  assert.throws(() => parseDares('a\n'.repeat(20000)), /too long/);
  assert.equal(parseDares(Array.from({ length: MAX_DARES }, (_, i) => `Dare ${i}`)).length, MAX_DARES);
  for (const d of DEFAULT_DARES) assert.ok(d.length <= MAX_DARE_LENGTH);
});

// ---- segments per kind ---------------------------------------------------------------------------

test('wheel: song segments come from the catalog (filters, not already sung), too few → clear error', async () => {
  const { req, host, view, tv, room, s, song } = await party({ songs: ALL });
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Bo' });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'songs', count: 8 } });
  const g = view(tv).game;
  assert.equal(g.type, 'wheel');
  assert.equal(g.phase, 'ready');
  assert.equal(g.kind, 'songs');
  assert.equal(g.segments.length, 8);
  assert.equal(new Set(g.segments.map((x) => x.songId)).size, 8, 'no duplicates');
  assert.ok(g.segments.every((x) => x.label && x.sub && room.catalog.song(x.songId)));
  assert.ok(!g.segments.some((x) => x.songId === s().queue[0].songId), 'queued songs stay off the wheel');
  assert.equal(g.spin, null);
  assert.equal(g.result, null);
  await req(host, 'game.close');

  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'songs', tag: 'Duets' } }), /Not enough songs/, 'only one duet here');

  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'songs', tag: 'No such collection' } }), /Not enough songs/);
  assert.equal(room.game, null, 'a failed start leaves no game behind');
  // Explicit songs stay off the wheel when the host filters them.
  room.settings.update({ queue: { explicitFilter: true } });
  for (let i = 0; i < 5; i++) {
    await req(host, 'game.start', { type: 'wheel', config: { kind: 'songs', count: 12 } });
    assert.ok(room.game.segments.every((x) => !room.catalog.isExplicit(room.catalog.song(x.songId))));
    await req(host, 'game.close');
  }
});

test('wheel: a small library still makes a wheel (fewer segments), even when everything was sung', async () => {
  const { req, host, room, s } = await party({ songs: SONGS });
  s().tonight.sung.push(...room.catalog.songList.map((x) => x.id));
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'songs', count: 12 } });
  const n = room.game.segments.length;
  assert.ok(n >= 3 && n <= room.catalog.songList.length, `${n} segments`);
});

test('wheel: singer segments — tonight’s singers plus guests on their phones, no duplicates, banned guests left out', async () => {
  const { req, host, guest, view, tv, room, leave } = await party();
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'singers' } }), /at least 2 singers/);
  await req(host, 'singer.add', { name: 'Zed' }); // host-added, no phone
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'singers' } }), /at least 2 singers/);
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const cy = await guest('Cy');
  await req(host, 'singer.add', { name: 'ana' }); // same person, other spelling
  await req(host, 'singer.add', { name: 'Everyone' }); // the sing-along "singer" is not a person
  room.findOrCreateSinger('Ben'); // Ben also has a singer entry
  room.s.profiles[cy.data.deviceId].banned = true;
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', count: 12 } });
  const names = view(tv).game.segments.map((x) => x.label).sort();
  assert.deepEqual(names, ['Ana', 'Ben', 'Zed']);
  const seg = view(tv).game.segments[0];
  assert.ok(seg.emoji && seg.people?.[0].name === seg.label);
  assert.equal(JSON.stringify(view(tv).game).includes(ana.data.deviceId), false, 'device ids never leak');
  assert.equal(JSON.stringify(view(ben).game).includes(ana.data.deviceId), false);
  await req(host, 'game.close');

  // "Only guests with their phone here": Zed (no phone) and guests who left are not on it.
  leave(ben);
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', who: 'online' } }), /phone here/);
  await guest('Dee');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', who: 'online' } });
  assert.deepEqual(room.game.segments.map((x) => x.label).sort(), ['Ana', 'Dee']);
  await req(host, 'game.close');

  // At most `count` people on the wheel.
  for (const name of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']) await req(host, 'singer.add', { name });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', count: 6 } });
  assert.equal(room.game.segments.length, 6);
});

test('wheel: a guest who calls themself Everyone is on the wheel — the sing-along singer is not', async () => {
  const { req, host, guest, room, leave } = await party();
  await req(host, 'singer.add', { name: 'Everyone' }); // the sing-along singer (flagged)
  room.createSinger({ name: 'everyone' }); // a phone-less one made before the flag existed
  const ana = await guest('Ana');
  await req(host, 'singer.add', { name: 'Zed' });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', who: 'all' } });
  assert.deepEqual(room.game.segments.map((x) => x.label).sort(), ['Ana', 'Zed'], 'no sing-along on the wheel');
  await req(host, 'game.close');

  const eve = await guest('Everyone');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', who: 'online' } });
  assert.deepEqual(room.game.segments.map((x) => x.label).sort(), ['Ana', 'Everyone']);
  assert.equal(room.game.segments.find((x) => x.label === 'Everyone').people[0].deviceId, eve.data.deviceId, 'the guest, not the sing-along');
  await req(host, 'game.close');

  // "Everyone singing tonight": her singer (made when she requests a song) counts once.
  await req(eve, 'queue.add', { songId: room.catalog.songList[0].id });
  const mine = room.s.singers.find((x) => x.deviceId === eve.data.deviceId);
  assert.ok(mine && !mine.singAlong);
  leave(eve); // gone for now, but she was here tonight
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', who: 'all' } });
  const segs = room.game.segments;
  assert.deepEqual(segs.map((x) => x.label).sort(), ['Ana', 'Everyone', 'Zed']);
  assert.equal(segs.find((x) => x.label === 'Everyone').people[0].singerId, mine.id);
  await req(host, 'game.close');

  // Three people with a phone make duet pairs (she counts as one of them).
  await guest('Everyone');
  await guest('Ben');
  leave(ana);
  await guest('Cy');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'duets', who: 'online', count: 12 } });
  const names = new Set(room.game.segments.flatMap((x) => x.people.map((p) => p.name)));
  assert.deepEqual([...names].sort(), ['Ben', 'Cy', 'Everyone']);
});

test('wheel: dare segments are a random pick of the host’s list', async () => {
  const { req, host, room, view, tv } = await party();
  const dares = Array.from({ length: 20 }, (_, i) => `Dare number ${i + 1}`);
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 10, dares: dares.join('\n') } });
  const labels = view(tv).game.segments.map((x) => x.label);
  assert.equal(labels.length, 10);
  assert.equal(new Set(labels).size, 10);
  assert.ok(labels.every((l) => dares.includes(l)));
  await req(host, 'game.close');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 12, dares: 'Jump\nSing\nDance' } });
  assert.equal(room.game.segments.length, 3, 'a short list makes a small wheel');
  await req(host, 'game.close');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 12 } });
  assert.equal(room.game.segments.length, 12, 'default dares');
  assert.ok(room.game.segments.every((x) => DEFAULT_DARES.includes(x.label)));
  await req(host, 'game.close');
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', dares: 'Just one' } }), /at least two/);
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', dares: 'y'.repeat(300) } }), /under 100/);
  assert.equal(room.game, null);
});

test('wheel: genre segments need song metadata', async () => {
  const { req, host, room, view, tv } = await party({ songs: SONGS });
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'genres' } }), /metadata/);
  const catalog = room.catalog;
  const genres = ['Pop', 'Rock', 'Disco', 'Dance'];
  const byKey = new Map(catalog.songList.map((x, i) => [x.key, { genre: genres[i % genres.length], year: 1980 + i }]));
  catalog.metaFor = (key) => byKey.get(key) || null;
  catalog.metaChanged();
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'genres', count: 6 } });
  const g = view(tv).game;
  assert.deepEqual(g.segments.map((x) => x.label).sort(), ['Dance', 'Disco', 'Pop', 'Rock']);
  assert.ok(g.segments.every((x) => /\d+ songs?/.test(x.sub)));
});

test('wheel: duet pairs — random pairs covering everyone, need 3 singers', async () => {
  const { req, host, guest, room, view, tv } = await party();
  await guest('Ana');
  await guest('Ben');
  await assert.rejects(req(host, 'game.start', { type: 'wheel', config: { kind: 'duets' } }), /at least 3 singers/);
  for (const name of ['Cy', 'Dee', 'Eve', 'Fay']) await req(host, 'singer.add', { name });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'duets', count: 8 } });
  const segs = view(tv).game.segments;
  assert.equal(segs.length, 8);
  const keys = segs.map((x) => x.people.map((p) => p.name).sort().join('|'));
  assert.equal(new Set(keys).size, 8, 'no pair twice');
  assert.ok(segs.every((x) => x.people.length === 2 && x.people[0].name !== x.people[1].name));
  assert.ok(segs.every((x) => x.label === `${x.people[0].name} & ${x.people[1].name}`));
  const everyone = new Set(segs.flatMap((x) => x.people.map((p) => p.name)));
  assert.equal(everyone.size, 6, 'everybody gets at least one partner');
  await req(host, 'game.close');
  // Three singers → three possible pairs.
  const { req: req2, host: host2, room: room2 } = await party();
  for (const name of ['A', 'B', 'C']) await req2(host2, 'singer.add', { name });
  await req2(host2, 'game.start', { type: 'wheel', config: { kind: 'duets', count: 12 } });
  assert.equal(room2.game.segments.length, 3);
  assert.ok(room.game === null);
});

// ---- spinning: secrecy and fairness ------------------------------------------------------------

test('wheel: the result is drawn before the spin; only the TV knows it until the wheel stops', async () => {
  const { req, host, tv, guest, view, room } = await party();
  const ana = await guest('Ana');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 8 } });
  await assert.rejects(req(ana, 'game.action', { action: 'spin' }), /not allowed/, 'guests can’t spin');
  await assert.rejects(req(ana, 'game.input', { choice: 1 }), /not taking answers/);
  const t0 = Date.now();
  const res = await req(host, 'game.action', { action: 'spin' });
  assert.equal(res.seq, 1);
  assert.equal(res.index, undefined, 'the host’s reply does not tell');
  const secret = room.game.spin;
  assert.ok(Number.isInteger(secret.index) && secret.index >= 0 && secret.index < 8);

  const tvGame = view(tv).game;
  assert.equal(tvGame.phase, 'spinning');
  assert.equal(tvGame.spin.index, secret.index, 'the TV needs the target to animate');
  assert.equal(segmentAt(tvGame.spin.to, 8), secret.index, 'and the spin lands on it');
  assert.ok(tvGame.spin.turns >= 4 && tvGame.spin.turns <= 6);
  assert.ok(tvGame.spin.offset >= 0.15 && tvGame.spin.offset <= 0.85, 'never on a border');
  assert.equal(tvGame.spin.duration, SPIN_SECONDS);
  assert.ok(tvGame.spin.startsAt >= t0 + LEAD_SECONDS * 1000 - 5, 'the TV gets the spin before it starts');
  assert.equal(tvGame.endsAt, tvGame.spin.startsAt + SPIN_SECONDS * 1000, 'the result comes when the wheel stops');
  assert.equal(tvGame.result, null, 'the TV shows the result only after the animation');

  for (const who of [ana, host]) {
    const g = view(who).game;
    assert.equal(g.phase, 'spinning');
    assert.equal(g.result, null);
    for (const k of ['index', 'to', 'offset', 'turns']) assert.equal(g.spin[k], undefined, `${who.role} can’t see spin.${k}`);
    assert.equal(g.rotation, tvGame.spin.from, 'the resting angle is where it started');
    assert.equal(g.history.length, 0);
    const json = JSON.stringify(g);
    assert.ok(!json.includes(`"to":`) && !json.includes(`"index":${secret.index}`) && !json.includes('"index"'), `nothing in the ${who.role} view points at the result`);
  }
  await assert.rejects(req(host, 'game.action', { action: 'spin' }), /already spinning/);
  await assert.rejects(req(host, 'game.action', { action: 'queue' }), /Spin the wheel first/);

  land(room);
  const g = view(ana).game;
  assert.equal(g.phase, 'result');
  assert.equal(g.result.index, secret.index);
  assert.equal(g.result.label, room.game.segments[secret.index].label);
  assert.equal(g.result.mine, false);
  assert.equal(g.spin.index, secret.index, 'after the reveal everyone may know');
  assert.ok(Math.abs(g.rotation - (((tvGame.spin.to % 360) + 360) % 360)) < 1e-9);
  assert.equal(segmentAt(g.rotation, 8), secret.index, 'the wheel rests on the result');
  assert.equal(view(tv).game.result.index, secret.index);
  assert.equal(g.history.length, 1);
});

test('wheel: the spin timer reveals the result by itself', async () => {
  const { req, host, room, view, tv } = await party();
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares' } });
  await req(host, 'game.action', { action: 'spin' });
  const g = room.game;
  g.setPhase('spinning', 0.05, () => g.reveal()); // a short spin
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(view(tv).game.phase, 'result');
  assert.equal(view(tv).game.result.label, g.segments[g.spin.index].label);
});

test('wheel: results are drawn fairly (crypto randomness, every segment, roughly uniform)', async () => {
  const { req, host, room } = await party();
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 6 } });
  const counts = [0, 0, 0, 0, 0, 0];
  const N = 1200;
  const offsets = new Set();
  for (let i = 0; i < N; i++) {
    await req(host, 'game.action', { action: 'spin' });
    const sp = room.game.spin;
    counts[sp.index]++;
    offsets.add(sp.offset);
    assert.equal(segmentAt(sp.to, 6), sp.index);
    land(room);
  }
  // Each segment expects 200; a 6-sigma band keeps this test from ever flaking.
  for (const c of counts) assert.ok(c > 120 && c < 280, `counts ${counts}`);
  const chi2 = counts.reduce((a, c) => a + (c - N / 6) ** 2 / (N / 6), 0);
  assert.ok(chi2 < 30, `chi² ${chi2.toFixed(1)} (5 degrees of freedom)`);
  assert.ok(offsets.size > 20, 'the landing spot inside the segment varies too');
  assert.equal(room.game.history.length, 50, 'history is capped');
  assert.equal(room.game.seq, N);
});

// ---- host actions ------------------------------------------------------------------------------

test('wheel: a song result is queued next for everyone, a singer or nobody (once)', async () => {
  const { req, host, room, s, view, tv } = await party({ songs: SONGS });
  const bo = (await req(host, 'singer.add', { name: 'Bo' })).singer;
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'songs', count: 6 } });
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  const r = view(host).game.result;
  await assert.rejects(req(host, 'game.action', { action: 'queue', for: 'no-such-singer' }), /who sings/);
  await assert.rejects(req(host, 'game.action', { action: 'queue', for: { x: 1 } }), /who sings/);
  const res = await req(host, 'game.action', { action: 'queue', for: bo.id });
  assert.equal(res.queued.songId, r.songId);
  assert.deepEqual(res.queued.singers, ['Bo']);
  assert.equal(s().queue[0].songId, r.songId);
  assert.equal(s().queue[0].source, 'game:wheel');
  assert.deepEqual(s().queue[0].singerIds, [bo.id]);
  assert.equal(s().current, null, 'nothing starts while the wheel is on the TV');
  assert.deepEqual(view(tv).game.result.queued.singers, ['Bo']);
  await assert.rejects(req(host, 'game.action', { action: 'queue' }), /already in the queue/);

  await req(host, 'game.action', { action: 'spin' });
  land(room);
  await req(host, 'game.action', { action: 'queue' });
  assert.equal(room.singer(s().queue[0].singerIds[0]).name, 'Everyone', 'default: a sing-along');
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  await req(host, 'game.action', { action: 'queue', for: 'nobody' });
  assert.deepEqual(s().queue[0].singerIds, []);
  assert.equal(s().queue.length, 3);
  await assert.rejects(req(host, 'game.action', { action: 'buzz' }), /singer or duet/);
  await assert.rejects(req(host, 'game.action', { action: 'explode' }), /Unknown wheel control/);
});

test('wheel: a genre result queues a random song of that genre', async () => {
  const { req, host, room, s, view } = await party({ songs: SONGS });
  const catalog = room.catalog;
  const byKey = new Map(catalog.songList.map((x, i) => [x.key, { genre: i % 2 ? 'Rock' : 'Pop' }]));
  catalog.metaFor = (key) => byKey.get(key) || null;
  catalog.metaChanged();
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'genres' } });
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  const genre = view(host).game.result.label;
  const res = await req(host, 'game.action', { action: 'queue', for: 'everyone' });
  const song = catalog.song(s().queue[0].songId);
  assert.equal(byKey.get(song.key).genre, genre);
  assert.equal(res.queued.title, song.title);
  assert.equal(view(host).game.result.queued.songId, song.id);
});

test('wheel: a duet result queues a random duet for both (guests get their singer), buzzes their phones', async () => {
  const { req, host, guest, room, s, view } = await party({ songs: [...TINY, ...DUET_SONGS] });
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  await req(host, 'singer.add', { name: 'Cy' });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'duets' } });
  // Rig the draw: the pair with both guests.
  const g = room.game;
  const target = g.segments.findIndex((x) => x.people.every((p) => p.deviceId));
  assert.ok(target >= 0);
  await req(host, 'game.action', { action: 'spin' });
  g.spin.index = target;
  ana.inbox.length = 0;
  ben.inbox.length = 0;
  land(room);
  const notes = [ana, ben].map((c) => c.inbox.find((m) => m.t === 'notify' && m.kind === 'game'));
  assert.ok(notes[0] && /paired you with Ben/.test(notes[0].text));
  assert.ok(notes[1] && /paired you with Ana/.test(notes[1].text));
  assert.equal(view(ana).game.result.mine, true);
  assert.equal(view(ben).game.result.mine, true);
  assert.equal(view(host).game.result.notified, 2);
  const res = await req(host, 'game.action', { action: 'queue' });
  const entry = s().queue[0];
  assert.ok(room.catalog.song(entry.songId).tags.includes('Duets'));
  assert.deepEqual(entry.singerIds.map((id) => room.singer(id).name).sort(), ['Ana', 'Ben']);
  assert.deepEqual(res.queued.singers.sort(), ['Ana', 'Ben']);
  const anaSinger = room.singer(entry.singerIds.find((id) => room.singer(id).name === 'Ana'));
  assert.equal(anaSinger.deviceId, ana.data.deviceId, 'the singer is linked to the guest’s phone');
  assert.equal(room.profileOf(ana.data.deviceId).singerId, anaSinger.id);
  // Buzz again.
  ana.inbox.length = 0;
  assert.equal((await req(host, 'game.action', { action: 'buzz' })).notified, 2);
  assert.ok(ana.inbox.some((m) => m.t === 'notify' && m.kind === 'game'));
});

test('wheel: no duet songs in the library → a clear error, the result stays', async () => {
  const { req, host, room } = await party();
  for (const name of ['A', 'B', 'C']) await req(host, 'singer.add', { name });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'duets' } });
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  await assert.rejects(req(host, 'game.action', { action: 'queue' }), /No duet songs/);
  assert.equal(room.game.phase, 'result');
  assert.equal(room.s.queue.length, 0);
});

test('wheel: a singer result buzzes only that guest’s phone and tells them it’s them', async () => {
  const { req, host, guest, room, view, tv } = await party();
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  await req(host, 'singer.add', { name: 'Zed' });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers' } });
  const g = room.game;
  await req(host, 'game.action', { action: 'spin' });
  g.spin.index = g.segments.findIndex((x) => x.label === 'Ana');
  land(room);
  const got = (c) => c.inbox.filter((m) => m.t === 'notify' && m.kind === 'game');
  assert.equal(got(ana).length, 1);
  assert.match(got(ana)[0].text, /pick a song/);
  assert.equal(got(ben).length, 0, 'nobody else is buzzed');
  assert.equal(got(tv).length, 0);
  assert.equal(view(ana).game.result.mine, true);
  assert.equal(view(ben).game.result.mine, false);
  assert.equal(view(tv).game.result.mine, undefined);
  await assert.rejects(req(host, 'game.action', { action: 'queue' }), /nothing to queue/);
  // Zed has no phone: no buzz, and "buzz again" says so.
  await req(host, 'game.action', { action: 'spin' });
  g.spin.index = g.segments.findIndex((x) => x.label === 'Zed');
  land(room);
  assert.equal(view(host).game.result.notified, 0);
  await assert.rejects(req(host, 'game.action', { action: 'buzz' }), /No.*phone/);
});

test('wheel: spin again, optionally taking the result off the wheel (down to two)', async () => {
  const { req, host, room, view, tv } = await party();
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 6 } });
  await assert.rejects(req(host, 'game.action', { action: 'spin', remove: true }), /Spin first/);
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  let used = view(host).game.result.label;
  await req(host, 'game.action', { action: 'spin' }); // keep it
  assert.equal(room.game.segments.length, 6);
  land(room);
  for (let n = 5; n >= 2; n--) {
    used = view(host).game.result.label;
    await req(host, 'game.action', { action: 'spin', remove: true });
    const segs = view(tv).game.segments.map((x) => x.label);
    assert.equal(segs.length, n);
    assert.ok(!segs.includes(used), `“${used}” is off the wheel`);
    assert.ok(room.game.spin.index < n);
    assert.equal(segmentAt(room.game.spin.to, n), room.game.spin.index);
    land(room);
  }
  assert.equal(view(host).game.canRemove, false);
  await assert.rejects(req(host, 'game.action', { action: 'spin', remove: true }), /Only two left/);
  await req(host, 'game.action', { action: 'spin', remove: 'yes' }); // only `true` removes
  assert.equal(room.game.segments.length, 2);
  land(room);
  assert.equal(view(host).game.spins, 7);
});

test('wheel: ending mid-spin never reveals the drawn result; summary for the recap', async () => {
  const { req, host, guest, room, view, s } = await party();
  const ana = await guest('Ana');
  await guest('Ben');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers' } });
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  const first = view(host).game.result.label;
  await req(host, 'game.action', { action: 'spin' });
  await req(host, 'game.end');
  const g = view(ana).game;
  assert.equal(g.phase, 'done');
  assert.equal(g.spin, null, 'the unfinished spin is gone');
  assert.equal(g.result, null);
  assert.ok(!JSON.stringify(view(host).game).includes('"index"'));
  const rec = s().tonight.games.at(-1);
  assert.equal(rec.type, 'wheel');
  assert.match(rec.title, /Roulette wheel/);
  assert.deepEqual(rec.winners, [first]);
  assert.deepEqual(rec.results, [first]);
  await req(host, 'game.close');
  // A wheel that never spun leaves nothing in the recap.
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares' } });
  await req(host, 'game.end');
  assert.equal(s().tonight.games.length, 1);
  assert.equal(room.game.summary(), null);
});

test('wheel: after the game the queue carries on (auto-start resumes)', async () => {
  const { req, host, room, s } = await party({ songs: SONGS }, { playback: { autoStart: true, countdown: 0 } });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'songs' } });
  await req(host, 'game.action', { action: 'spin' });
  land(room);
  await req(host, 'game.action', { action: 'queue' });
  assert.equal(s().current, null);
  await req(host, 'game.action', { action: 'end' });
  assert.equal(room.game.phase, 'done');
  assert.ok(s().current, 'the wheel’s song starts once the game is over');
  assert.equal(s().current.source, 'game:wheel');
});

test('wheel: a buzz only counts phones that are connected right now', async () => {
  const { req, host, guest, room, view, leave, connect } = await party();
  const ana = await guest('Ana');
  await guest('Ben');
  leave(ana); // Ana went home (her singer and profile stay)
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers' } });
  const g = room.game;
  assert.ok(g.segments.some((x) => x.label === 'Ana'), 'she was here tonight: still on the wheel');
  await req(host, 'game.action', { action: 'spin' });
  g.spin.index = g.segments.findIndex((x) => x.label === 'Ana');
  const before = ana.inbox.length;
  land(room);
  assert.equal(ana.inbox.length, before);
  assert.equal(view(host).game.result.notified, 0, 'the host sees “No phone connected”');
  await assert.rejects(req(host, 'game.action', { action: 'buzz' }), /No.*phone/);
  // Back on her phone: "Buzz again" reaches her.
  const back = await connect('guest', { token: ana.welcome.token });
  assert.deepEqual(await req(host, 'game.action', { action: 'buzz' }), { notified: 1 });
  assert.equal(back.inbox.filter((m) => m.t === 'notify' && m.kind === 'game').length, 1);
  assert.equal(view(host).game.result.notified, 1);
});

test('wheel: “everyone singing tonight” leaves out singers from earlier parties', async () => {
  const { req, host, guest, room, leave, connect } = await party();
  await req(host, 'singer.add', { name: 'LastMonthLucy' });
  const otto = await guest('OldGuestOtto');
  await req(otto, 'queue.add', { songId: room.catalog.songList[0].id });
  await req(host, 'queue.clear');
  leave(otto);
  await req(host, 'singer.add', { name: 'Zed' });
  await new Promise((r) => setTimeout(r, 5));
  await req(host, 'party.new');
  await guest('Ana');
  await guest('Ben');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', count: 12 } });
  assert.deepEqual(room.game.segments.map((x) => x.label).sort(), ['Ana', 'Ben']);
  await req(host, 'game.close');
  // Tonight's people without a phone: re-added by the host, or with a song in the queue.
  await req(host, 'singer.add', { name: 'zed' });
  await req(host, 'queue.add', { songId: room.catalog.songList[0].id, singerName: 'LastMonthLucy' });
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', count: 12 } });
  assert.deepEqual(room.game.segments.map((x) => x.label).sort(), ['Ana', 'Ben', 'LastMonthLucy', 'Zed']);
  await req(host, 'game.close');
  // Otto drops by tonight with his phone (and leaves again): he's part of tonight.
  leave(await connect('guest', { token: otto.welcome.token }));
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'duets', count: 12 } });
  const people = new Set(room.game.segments.flatMap((x) => x.people.map((p) => p.name)));
  assert.deepEqual([...people].sort(), ['Ana', 'Ben', 'LastMonthLucy', 'OldGuestOtto', 'Zed']);
});

test('wheel: a double click on a spin button spins once (and never takes a newer result off the wheel)', async () => {
  const { req, host, room, view } = await party();
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'dares', count: 6 } });
  const g = room.game;
  let later = 0; // the game's clock: the wheel turns for a few seconds before it lands
  g.now = () => Date.now() + later;
  const landed = () => {
    land(room);
    later += GAME_SETTLE_MS;
  };
  let step = view(host).game.step;
  const [a, b] = await Promise.all([0, 1].map(() => req(host, 'game.action', { action: 'spin', step })));
  assert.equal(a.seq, 1);
  assert.equal(b.stale, true);
  assert.equal(g.seq, 1);
  landed();
  step = view(host).game.step;
  const shown = g.result.seg.label;
  await req(host, 'game.action', { action: 'spin', remove: true, step });
  landed();
  // The second click of "Spin again without …" arrives late (drawn for the old result).
  assert.equal((await req(host, 'game.action', { action: 'spin', remove: true, step })).stale, true);
  assert.equal(g.segments.length, 5, 'only the shown result was taken off');
  assert.ok(!g.segments.some((x) => x.label === shown));
});

test('wheel: guests whose name is only emoji are on the wheel (and paired) like everyone else', async () => {
  const { req, host, guest, room } = await party();
  await guest('Ana');
  await guest('🦄🦄');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'singers', who: 'online' } });
  assert.deepEqual(room.game.segments.map((x) => x.label).sort(), ['Ana', '🦄🦄'].sort());
  await req(host, 'game.close');
  await guest('🎸');
  await req(host, 'game.start', { type: 'wheel', config: { kind: 'duets', who: 'online', count: 12 } });
  const pairs = room.game.segments.map((x) => x.people.map((p) => p.name).sort().join(' & ')).sort();
  assert.deepEqual(pairs, ['Ana & 🎸', 'Ana & 🦄🦄', '🎸 & 🦄🦄'].map((p) => p.split(' & ').sort().join(' & ')).sort());
});
