// Pass the mic (server/games/relay.js): participants, scheduling on playing time only, never the
// same holder twice, fair turns, flashes, phone notifications, host controls and views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import { FLASH_MS, MAX_PARTICIPANTS } from '../server/games/relay.js';

/** Takes over the game's clock: `advance(ms)` moves time on in ticks like the real 250 ms timer. */
function fakeClock(game, t0 = 5_000_000) {
  let t = t0;
  game.now = () => t;
  game.lastTick = t;
  return {
    get t() { return t; },
    advance(ms, step = 250) {
      for (let d = 0; d < ms; d += step) {
        t += Math.min(step, ms - d);
        game.tick();
      }
    },
  };
}

async function party(n = 3, settings = {}) {
  const env = await setupRoom(settings);
  const host = await env.connect('host');
  const tv = await env.connect('tv');
  const names = ['Ann', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay'].slice(0, n);
  const guests = [];
  for (const name of names) guests.push(await env.guest(name));
  const ids = guests.map((g) => g.data.deviceId);
  /** Starts a song and lets the TV report it ready: the player is 'playing'. */
  const play = async (q = 'hello', singerName = 'Bo') => {
    await env.req(host, 'queue.add', { songId: env.song(q).id, singerName });
    if (!env.s().current) await env.req(host, 'player.play');
    const cur = env.s().current;
    await env.req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
    assert.equal(env.s().player.state, 'playing');
    return cur;
  };
  return { ...env, host, tv, guests, ids, play };
}

const micNotes = (c) => c.inbox.filter((m) => m.t === 'notify' && m.kind === 'mic');

test('relay: setup — participants are validated guests (or everyone), interval defaults and bounds', async () => {
  const { req, host, ids, room, connect, app } = await party(3);
  const nameless = await connect('guest');
  await assert.rejects(req(host, 'game.start', { type: 'relay', config: { participants: [ids[0]] } }), /at least 2/);
  await assert.rejects(req(host, 'game.start', { type: 'relay', config: { participants: [ids[0], 'nobody-at-all', '__proto__', 42, nameless.data.deviceId] } }), /at least 2/);
  await req(host, 'guest.ban', { deviceId: ids[2] });
  await assert.rejects(req(host, 'game.start', { type: 'relay', config: { participants: [ids[0], ids[2]] } }), /at least 2/, 'banned guests can’t play');
  await req(host, 'game.start', { type: 'relay', config: { participants: [ids[0], ids[1], ids[0], 'constructor'] } });
  let g = room.game;
  assert.deepEqual(g.config, { min: 15, max: 40, everyone: false, participants: [ids[0], ids[1]] });
  assert.equal(g.constructor.exclusive, false);
  await req(host, 'game.close');
  await req(host, 'game.start', { type: 'relay', config: { participants: 'everyone', min: 90, max: 20 } });
  g = room.game;
  assert.equal(g.config.everyone, true);
  assert.deepEqual([g.config.min, g.config.max], [20, 90], 'min/max swapped');
  await req(host, 'game.close');
  await req(host, 'game.start', { type: 'relay', config: { min: -5, max: 1e9 } });
  assert.deepEqual([room.game.config.min, room.game.config.max], [5, 600], 'clamped');
  assert.equal(room.game.config.everyone, true, 'no list = everyone');
  await req(host, 'game.close');
  const many = Array.from({ length: MAX_PARTICIPANTS + 5 }, (_, i) => `dev-${i}-xyz`);
  for (const id of many) app.room.s.profiles[id] = { name: `G${id}` };
  await assert.rejects(req(host, 'game.start', { type: 'relay', config: { participants: many } }), /at most/);
});

test('relay: runs alongside the karaoke — starts during a song and songs keep auto-starting', async () => {
  const { req, host, room, s, play, ids } = await party(2, { playback: { countdown: 0, autoStart: true } });
  await play();
  await req(host, 'game.start', { type: 'relay', config: { participants: ids } });
  assert.equal(room.gameBlocks(), false);
  await req(host, 'queue.add', { songId: room.catalog.search('waterloo').items[0].id, singerName: 'Cy' });
  await req(host, 'player.next');
  assert.equal(s().current.title, 'Waterloo', 'the queue carries on while the game runs');
  await req(host, 'game.close');
});

test('relay: the mic passes at random intervals of playing time, never to the holder, and the phone buzzes', async () => {
  const { req, host, room, play, ids, guests, view, tv } = await party(3);
  await req(host, 'game.start', { type: 'relay', config: { participants: ids, min: 10, max: 20 } });
  const g = room.game;
  const clock = fakeClock(g);
  clock.advance(60_000);
  assert.equal(g.passes, 0, 'nothing happens while no song is playing');
  assert.equal(view(host).game.phase, 'waiting');
  await play();
  g.remaining = g.drawInterval(); // (the song's own fresh interval, drawn at its start)
  assert.ok(g.remaining >= 10_000 && g.remaining <= 20_000);
  let t0 = clock.t;
  while (!g.passes) clock.advance(250);
  const first = clock.t - t0;
  assert.ok(first >= 10_000 && first <= 20_250, `first pass after ${first} ms`);
  t0 = clock.t; // (the next interval starts at the pass)
  assert.equal(view(host).game.phase, 'live');
  const holder = g.holder;
  assert.ok(ids.includes(holder));
  // The TV flashes the name for FLASH_MS, the holder's phone (only) is notified.
  const tvGame = view(tv).game;
  assert.equal(tvGame.flash.name, g.player(holder).name);
  assert.equal(tvGame.flash.deviceId, undefined, 'no device ids on the TV');
  const hi = ids.indexOf(holder);
  assert.equal(micNotes(guests[hi]).length, 1);
  assert.equal(micNotes(guests[(hi + 1) % 3]).length, 0);
  assert.equal(view(guests[hi]).game.mine, true);
  assert.equal(view(guests[hi]).game.flash.mine, true);
  assert.equal(view(guests[(hi + 1) % 3]).game.mine, false);
  clock.advance(FLASH_MS - 500);
  assert.ok(view(tv).game.flash, 'still flashing');
  clock.advance(750);
  assert.equal(view(tv).game.flash, null, 'the flash is over after a few seconds');
  // Many passes: never the same holder twice in a row, intervals within [min, max].
  let prev = g.holder;
  let passes = g.passes;
  for (let i = 0; i < 40; i++) {
    while (g.passes === passes) clock.advance(250);
    const gap = clock.t - t0;
    assert.ok(gap >= 10_000 && gap <= 20_250, `gap ${gap} ms`);
    assert.notEqual(g.holder, prev, 'never the same holder twice');
    prev = g.holder;
    passes = g.passes;
    t0 = clock.t;
  }
  // Fair turns: nobody gets the mic a second time before everyone had it once (and so on).
  const turns = ids.map((id) => g.turns.get(id));
  assert.ok(Math.max(...turns) - Math.min(...turns) <= 1, `turns ${turns}`);
  await req(host, 'game.end');
  const n = g.passes;
  clock.advance(60_000);
  assert.equal(g.passes, n, 'no passes after the game ended');
  assert.equal(view(host).game.phase, 'done');
});

test('relay: the clock pauses while the song is paused, in its intro and between songs', async () => {
  const { req, host, room, play, ids, s } = await party(2);
  await play();
  await req(host, 'game.start', { type: 'relay', config: { participants: ids, min: 15, max: 15 } });
  const g = room.game;
  const clock = fakeClock(g);
  clock.advance(10_000);
  assert.equal(g.passes, 0);
  await req(host, 'player.pause');
  clock.advance(120_000);
  assert.equal(g.passes, 0, 'paused: no passes');
  assert.equal(g.phase, 'waiting');
  assert.ok(Math.abs(g.remaining - 5000) <= 250, `5 s of the interval left (${g.remaining})`);
  await req(host, 'player.resume');
  clock.advance(4000);
  assert.equal(g.passes, 0);
  clock.advance(1250);
  assert.equal(g.passes, 1, 'the pass comes after 15 s of singing in total');
  // Between songs: nothing.
  s().player.pos = 190;
  room.finish('ended');
  clock.advance(120_000);
  assert.equal(g.passes, 1);
  // A stalled clock (PC asleep) doesn't fast-forward: one huge step counts as 1 s at most.
  await play('waterloo');
  const left = g.remaining;
  clock.advance(3_600_000, 3_600_000);
  assert.equal(g.remaining, left - 1000);
});

test('relay: a new song starts a fresh interval; its lead singer holds the mic when playing along', async () => {
  const { req, host, room, play, ids, s } = await party(3);
  await req(host, 'game.start', { type: 'relay', config: { participants: ids, min: 30, max: 30 } });
  const g = room.game;
  const ann = room.s.profiles[ids[0]];
  assert.ok(ann.singerId, 'guests with a phone are singers');
  await req(host, 'queue.add', { songId: room.catalog.search('hello').items[0].id, singerId: ann.singerId });
  await req(host, 'player.play');
  assert.equal(g.holder, ids[0], 'Ann sings: she starts with the mic');
  assert.equal(g.remaining, 30_000);
  const clock = fakeClock(g);
  await play(); // (the TV reports ready)
  clock.advance(30_000);
  assert.equal(g.passes, 1);
  assert.notEqual(g.holder, ids[0], 'passed on to someone else');
  s().player.pos = 190;
  room.finish('ended');
  await play('waterloo', 'Someone Else');
  assert.equal(g.holder, null, 'a singer without a phone in the game: anyone can get the mic');
});

test('relay: everyone mode — named guests who come online join; the host can pass now, remove and add', async () => {
  const { req, host, room, guest, connect, play, view } = await party(1);
  await req(host, 'game.start', { type: 'relay', config: { participants: 'everyone', min: 10, max: 10 } });
  const g = room.game;
  assert.equal(view(host).game.count, 1);
  assert.equal((await req(host, 'game.action', { action: 'pass' })).holder, 'Ann', 'pass now works even between songs');
  await assert.rejects(req(host, 'game.action', { action: 'pass' }), /nobody else/, 'Ann already has it');
  const ben = await guest('Ben');
  await connect('guest'); // no name yet: not playing
  g.tick();
  const hv = view(host).game;
  assert.equal(hv.count, 2);
  assert.ok(hv.participants.every((p) => p.deviceId && p.name));
  assert.equal((await req(host, 'game.action', { action: 'pass' })).holder, 'Ben');
  assert.equal((await req(host, 'game.action', { action: 'pass' })).holder, 'Ann');
  assert.equal(g.passes, 3);
  // Remove Ben: only Ann is left, so a due pass is skipped ("stuck") instead of repeating her.
  await req(host, 'game.action', { action: 'remove', deviceId: ben.data.deviceId });
  assert.equal(view(host).game.count, 1);
  const clock = fakeClock(g);
  await play();
  g.holder = view(host).game.participants[0].deviceId;
  const before = g.passes;
  clock.advance(10_250);
  assert.equal(g.passes, before);
  assert.equal(view(host).game.stuck, true);
  g.tick(); // a removed guest doesn't sneak back in through "everyone"
  assert.equal(view(host).game.count, 1);
  await req(host, 'game.action', { action: 'add', deviceId: ben.data.deviceId });
  assert.equal(view(host).game.count, 2);
  await assert.rejects(req(host, 'game.action', { action: 'add', deviceId: '__proto__' }), /not at the party/);
  await assert.rejects(req(host, 'game.action', { action: 'remove', deviceId: 'nope-nope' }), /not at the party/);
  await assert.rejects(req(host, 'game.action', { action: 'explode' }), /Unknown/);
});

test('relay: views — guests see names but never device ids; guests can’t control or answer', async () => {
  const { req, host, room, ids, guests, view, tv } = await party(3);
  await req(host, 'game.start', { type: 'relay', config: { participants: ids } });
  await req(host, 'game.action', { action: 'pass' });
  const holder = room.game.holder;
  for (const c of [...guests, tv]) {
    const v = view(c).game;
    const json = JSON.stringify(v);
    for (const id of ids) assert.ok(!json.includes(id), 'no device ids leak');
    assert.equal(v.participants.length, 3);
    assert.equal(v.holder.name, room.game.player(holder).name);
    assert.equal(v.nextIn, undefined, 'the next pass is a surprise');
  }
  assert.equal(view(guests[0]).game.joined, true);
  const hv = view(host).game;
  assert.equal(hv.holderId, holder);
  assert.ok(Number.isFinite(hv.passes));
  await assert.rejects(req(guests[0], 'game.action', { action: 'pass' }), /not allowed/);
  await assert.rejects(req(guests[0], 'game.input', { pass: true }), /not taking answers/);
  assert.equal(room.game.summary(), null, 'nothing to remember for the recap');
});
