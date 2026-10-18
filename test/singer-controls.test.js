// The singer's own controls: while their song is on, the singer's phone (and a duet partner's)
// may play, pause, seek and restart it — nothing else, nobody else, and not a moment after the
// song stops being the one on now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

const singerOf = (s, c) => s().profiles[c.welcome.deviceId].singerId;

/** A party with a TV, the host, singers Ana and Ben, and Cy (another guest). */
async function party(settings = {}) {
  const r = await setupRoom({ playback: { countdown: 0, autoStart: false }, ...settings });
  const host = await r.connect('host');
  const tv = await r.connect('tv');
  const ana = await r.guest('Ana');
  const ben = await r.guest('Ben');
  const cy = await r.guest('Cy');
  /** Starts the next song and lets the TV report it ready (so it plays). */
  const start = async () => {
    await r.req(host, 'player.next');
    await r.req(tv, 'tv.ready', { entryId: r.s().current.id, dur: 200 });
    assert.equal(r.s().player.state, 'playing');
    return r.s().current.id;
  };
  return { ...r, host, tv, ana, ben, cy, start };
}

test('the singer runs their own song: play, pause, seek, restart — nothing else', async () => {
  const { req, song, s, view, ana, cy, start } = await party();
  await req(ana, 'queue.add', { songId: song('waterloo').id });
  assert.equal(view(ana).me.controls, false, 'queued is not on now');
  const entryId = await start();
  assert.equal(view(ana).me.controls, true);
  assert.equal(view(cy).me.controls, false, 'another guest has none');

  assert.deepEqual(await req(ana, 'player.pause', { entryId }), { state: 'paused' });
  assert.deepEqual(await req(ana, 'player.resume', { entryId }), { state: 'playing' });
  assert.deepEqual(await req(ana, 'player.seek', { entryId, pos: 42 }), { pos: 42 });
  assert.equal(s().player.seek.pos, 42);
  assert.deepEqual(await req(ana, 'player.restart', { entryId }), { pos: 0 });
  assert.equal(s().player.pos, 0);

  // Not the party's controls: the next song, stop, volume, key, the queue.
  for (const t of ['player.next', 'player.stop', 'player.volume', 'player.key', 'player.tempo', 'player.toggle', 'player.play', 'queue.move', 'queue.clear']) {
    await assert.rejects(req(ana, t, { entryId, v: 0.1, semitones: 2, rate: 1.1, index: 0 }), /not allowed/, t);
  }
  assert.equal(s().current.id, entryId);
  assert.equal(s().player.volume, 0.9);

  // Everyone else still needs co-host or the host PIN.
  for (const t of ['player.pause', 'player.resume', 'player.seek', 'player.restart']) {
    await assert.rejects(req(cy, t, { entryId, pos: 10 }), /Only the singer/, t);
  }
  assert.equal(s().player.state, 'playing');
});

test('a duet partner has the same controls; a co-host keeps the party controls', async () => {
  const { req, song, s, view, host, ana, ben, cy, start } = await party();
  await req(ana, 'queue.add', { songId: song('waterloo').id, partners: [singerOf(s, ben)] });
  await req(ana, 'queue.add', { songId: song('call me').id, partners: [singerOf(s, cy)] });
  const invite = view(ben).me.invites.find((i) => i.title === 'Waterloo');
  await req(ben, 'duet.answer', { entryId: invite.entryId, accept: true });
  const entryId = await start();
  assert.equal(s().current.title, 'Waterloo');
  assert.equal(view(ben).me.controls, true, 'the duet partner');
  assert.equal(view(ana).me.controls, true, 'the lead singer');
  assert.deepEqual(await req(ben, 'player.seek', { entryId, pos: 5 }), { pos: 5 });
  assert.deepEqual(await req(ben, 'player.pause', { entryId }), { state: 'paused' });

  // Invited but never answered: not a singer of that song.
  await req(host, 'player.next');
  assert.equal(s().current.title, 'Call Me');
  assert.equal(view(cy).me.controls, false);
  assert.equal(view(ben).me.controls, false);
  await assert.rejects(req(cy, 'player.pause', { entryId: s().current.id }), /Only the singer/);
  const callMe = s().current.id;

  // A co-host: the party's controls (no song id needed), unchanged by this.
  await req(host, 'guest.cohost', { deviceId: cy.data.deviceId, on: true });
  assert.equal(view(cy).me.controls, false, 'not their song');
  assert.ok(view(cy).cohost);
  await req(cy, 'player.seek', { pos: 3 });
  await req(cy, 'player.volume', { v: 0.5 });
  assert.equal(s().player.volume, 0.5);
  await req(cy, 'player.next');
  assert.notEqual(s().current?.id, callMe);
});

test('the controls go as soon as the song stops being the one on now', async () => {
  const { req, song, s, view, host, tv, ana, ben, start, room } = await party();
  await req(ana, 'queue.add', { songId: song('waterloo').id });
  await req(ana, 'queue.add', { songId: song('hello').id });
  await req(ben, 'queue.add', { songId: song('call me').id });
  s().queue.sort((a, b) => (a.title === 'Call Me') - (b.title === 'Call Me')); // Ana twice, then Ben
  const first = await start();
  assert.equal(s().current.title, 'Waterloo');

  // Skipped (the host's Next): Ana is on again, but a tap meant for the first song is refused.
  await req(host, 'player.next');
  assert.equal(s().current.title, 'Hello');
  assert.equal(view(ana).me.controls, true);
  await assert.rejects(req(ana, 'player.seek', { entryId: first, pos: 30 }), /That song is over/);
  await assert.rejects(req(ana, 'player.pause', {}), /That song is over/, 'no song named: refused');
  assert.equal(s().player.seek.pos, 0);

  // Ended (the TV's report): Ben's song is on, Ana's controls are gone.
  const second = s().current.id;
  await req(tv, 'tv.ended', { entryId: second });
  assert.equal(s().current.title, 'Call Me');
  assert.equal(view(ana).me.controls, false);
  await assert.rejects(req(ana, 'player.pause', { entryId: second }), /Only the singer/);
  await assert.rejects(req(ana, 'player.pause', { entryId: s().current.id }), /Only the singer/, 'not with the new song’s id either');

  // Stopped: nothing on now, nobody has controls.
  const ben3 = s().current.id;
  await req(tv, 'tv.ready', { entryId: ben3, dur: 200 });
  assert.equal(view(ben).me.controls, true);
  await req(host, 'player.stop');
  assert.equal(view(ben).me.controls, false);
  await assert.rejects(req(ben, 'player.resume', { entryId: ben3 }), /Only the singer/);
  assert.equal(room.singerOnNow(ben.data.deviceId), false);
});

test('the singer’s controls are rate-limited, and the host can turn them off', async () => {
  const { app, req, song, s, view, host, ana, start } = await party();
  await req(ana, 'queue.add', { songId: song('waterloo').id });
  const entryId = await start();
  for (let i = 0; i < 8; i++) await req(ana, 'player.seek', { entryId, pos: i });
  await assert.rejects(req(ana, 'player.seek', { entryId, pos: 50 }), /Slow down/);
  assert.equal(s().player.seek.pos, 7);

  app.settings.update({ queue: { singerControls: false } });
  assert.equal(view(ana).me.controls, false);
  await assert.rejects(req(ana, 'player.pause', { entryId }), /Only the singer/);
  app.settings.update({ queue: { singerControls: true } });
  assert.equal(view(ana).me.controls, true);

  // Not in a judged battle round, not for a banned guest.
  s().current.source = 'game:battle';
  assert.equal(view(ana).me.controls, false);
  delete s().current.source;
  await req(host, 'guest.ban', { deviceId: ana.data.deviceId });
  assert.equal(app.room.singerOnNow(ana.data.deviceId), false);
});

test('the singer’s phone follows the song at the TV’s rate, other guests once a second', async () => {
  const { req, song, ana, cy, tv, start } = await party();
  await req(ana, 'queue.add', { songId: song('waterloo').id });
  const entryId = await start();
  const times = (c) => c.inbox.filter((m) => m.t === 'time').length;
  const a0 = times(ana);
  const c0 = times(cy);
  for (let i = 0; i < 4; i++) await req(tv, 'tv.status', { entryId, pos: i, dur: 200, playing: true });
  assert.equal(times(ana) - a0, 4);
  assert.ok(times(cy) - c0 <= 1);
});
