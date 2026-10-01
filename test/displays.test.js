// Which /tv screen plays the sound: the main display after (re)connects, stand-ins, queue
// boards and explicit mirrors that must stay muted, and the host's "Make main" choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

const got = (c, display) => c.inbox.some((m) => m.t === 'display' && m.display === display);

async function playing(env) {
  const { connect, req, song, s } = env;
  const host = await connect('host');
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Ana' });
  await req(host, 'player.play');
  return { host, entry: s().current };
}

test('displays: a queue board or a mirror never takes the sound; the reloaded TV is main again', async () => {
  const env = await setupRoom();
  const { connect, leave, req, view, s } = env;
  const tv = await connect('tv');
  const board = await connect('tv', { display: 'board' });
  const mirror = await connect('tv', { display: 'mirror' });
  const oldBoard = await connect('tv', { display: 'mirror' }); // a board page from before 'board' existed
  assert.deepEqual([tv, board, mirror, oldBoard].map((c) => c.welcome.display), ['main', 'mirror', 'mirror', 'mirror']);
  const { host, entry } = await playing(env);
  await req(tv, 'tv.ready', { entryId: entry.id, dur: 200 });
  await req(tv, 'tv.status', { entryId: entry.id, pos: 42, playing: true });
  assert.equal(s().player.state, 'playing');

  leave(tv); // F5 on the TV, Chrome restarting, a Wi-Fi blip…
  for (const c of [board, mirror, oldBoard]) {
    assert.equal(c.data.display, 'mirror');
    assert.equal(got(c, 'main'), false, 'never told to play');
  }
  assert.equal(s().player.state, 'paused');
  assert.equal(s().player.displayLost, true);
  assert.ok(host.inbox.some((m) => m.t === 'toast' && /disconnected/.test(m.text) && /Settings → Displays/.test(m.text)));
  await req(board, 'tv.ready', { entryId: entry.id, dur: 200 });
  assert.equal(s().player.tvReady, false, 'a board is never the main display');

  const tv2 = await connect('tv');
  assert.equal(tv2.welcome.display, 'main', 'the TV is the main display again');
  assert.equal(s().player.displayLost, false);
  const displays = view(host).displays;
  assert.deepEqual(displays.map((d) => [d.display, d.kind]), [['mirror', 'board'], ['mirror', 'mirror'], ['mirror', 'mirror'], ['main', 'main']]);
  await req(tv2, 'tv.ready', { entryId: entry.id, dur: 200 });
  await req(host, 'player.resume');
  assert.equal(s().player.state, 'playing');
});

test('displays: a second plain TV stands in while the main TV is away, then gives the sound back', async () => {
  const env = await setupRoom();
  const { connect, leave, req, view, s } = env;
  const tv = await connect('tv');
  const other = await connect('tv');
  const board = await connect('tv', { display: 'board' });
  assert.equal(other.welcome.display, 'mirror');
  const { host, entry } = await playing(env);
  await req(tv, 'tv.ready', { entryId: entry.id, dur: 200 });

  leave(tv);
  assert.equal(other.data.display, 'main', 'the other TV keeps the party going');
  assert.ok(got(other, 'main'));
  assert.equal(other.data.standIn, true);
  assert.equal(board.data.display, 'mirror');
  assert.equal(s().player.state, 'playing');
  assert.equal(view(host).displays.find((d) => d.id === other.id).standIn, true);

  const back = await connect('tv');
  assert.equal(back.welcome.display, 'main', 'the reloaded TV takes the sound back');
  assert.equal(other.data.display, 'mirror');
  assert.ok(got(other, 'mirror'), 'the stand-in is told to go quiet');
  assert.equal(env.room.mainDisplay(), back);
  await req(other, 'tv.status', { entryId: entry.id, pos: 99, playing: true });
  assert.notEqual(s().player.pos, 99, 'the stand-in no longer reports the position');

  // Once the main TV is back for good, another plain TV is only a mirror.
  const third = await connect('tv');
  assert.equal(third.welcome.display, 'mirror');
  assert.equal(back.data.display, 'main');
  assert.deepEqual(view(host).displays.filter((d) => d.display === 'main').map((d) => d.id), [back.id]);
});

test('displays: the host picks the main display; boards and previews can not be picked', async () => {
  const env = await setupRoom();
  const { connect, leave, req, view, guest, s } = env;
  const tv = await connect('tv');
  const mirror = await connect('tv', { display: 'mirror' });
  const board = await connect('tv', { display: 'board' });
  const preview = await connect('tv', { display: 'preview' });
  const { host, entry } = await playing(env);
  const ann = await guest('Ann');

  await assert.rejects(req(ann, 'display.main', { id: mirror.id }), /not allowed/);
  await assert.rejects(req(host, 'display.main', { id: board.id }), /queue board/);
  await assert.rejects(req(host, 'display.main', { id: preview.id }), /not connected/);
  await assert.rejects(req(host, 'display.main', { id: 'nope' }), /not connected/);
  await assert.rejects(req(host, 'display.main', { id: { $ne: 1 } }), /not connected/);

  await req(host, 'display.main', { id: mirror.id });
  assert.equal(mirror.data.display, 'main');
  assert.ok(got(mirror, 'main'));
  assert.equal(tv.data.display, 'mirror');
  assert.ok(got(tv, 'mirror'));
  assert.equal(view(host).displays.find((d) => d.id === mirror.id).display, 'main');

  // The host's choice sticks: the TV page reloading doesn't take the sound back.
  leave(tv);
  const tv2 = await connect('tv');
  assert.equal(tv2.welcome.display, 'mirror');
  assert.equal(mirror.data.display, 'main');

  // Without any plain TV, losing the main display pauses; the host can pick a mirror to go on.
  await req(host, 'display.main', { id: tv2.id });
  await req(tv2, 'tv.ready', { entryId: entry.id, dur: 200 });
  leave(tv2);
  assert.equal(mirror.data.display, 'mirror', 'a mirror never takes over by itself');
  assert.equal(s().player.displayLost, true);
  await assert.rejects(req(host, 'player.resume'), /No TV display/);
  await req(host, 'display.main', { id: mirror.id });
  assert.equal(s().player.displayLost, false);
  assert.ok(got(mirror, 'main'));
  await req(host, 'player.resume');
  assert.equal(s().player.state, 'intro', 'waits for the new main display to load the song');
  await req(mirror, 'tv.ready', { entryId: entry.id, dur: 200 });
  assert.equal(s().player.state, 'playing');
});

test('displays: a stand-in the host confirmed keeps the sound', async () => {
  const env = await setupRoom();
  const { connect, leave, req } = env;
  const host = await connect('host');
  const tv = await connect('tv');
  const other = await connect('tv');
  leave(tv);
  assert.equal(other.data.standIn, true);
  await req(host, 'display.main', { id: other.id });
  assert.equal(other.data.standIn, false);
  const back = await connect('tv');
  assert.equal(back.welcome.display, 'mirror');
  assert.equal(other.data.display, 'main');
});

test('displays: a paired screen asking to be the host preview is listed (and logged out) like any mirror', async () => {
  const { app, room, connect, req, view } = await setupRoom();
  const host = await connect('host');
  const { id } = room.pairRequest('192.168.1.50');
  await req(host, 'display.approve', { id });
  const { token } = room.pairStatus(id);
  const sneaky = await connect('tv', { token, display: 'preview' }, { local: false });
  assert.equal(sneaky.data.preview, false);
  assert.equal(sneaky.welcome.display, 'mirror', 'it asked to be muted, so it is a mirror');
  assert.deepEqual(view(host).displays.map((d) => [d.id, d.kind]), [[sneaky.id, 'mirror']]);
  // The host's own preview on a phone (PIN) is not a paired screen: "Forget" leaves it alone.
  app.settings.update({ party: { adminPin: '4321' } });
  const hostToken = app.auth.loginWithPin('4321', 'x');
  const phonePreview = await connect('tv', { display: 'preview', hostToken }, { local: false });
  assert.equal(phonePreview.data.preview, true);
  assert.equal(view(host).displays.length, 1, 'the host preview is not listed');
  await req(host, 'display.forget');
  assert.ok(sneaky.inbox.some((m) => m.t === 'denied' && m.reason === 'pairing_required'));
  assert.equal(sneaky.open, false);
  assert.equal(phonePreview.inbox.some((m) => m.t === 'denied'), false, 'the host preview stays');
  assert.equal(phonePreview.open, true);
  assert.equal((await connect('tv', { display: 'preview', hostToken }, { local: false })).denied, undefined, 'and can reconnect');
});
