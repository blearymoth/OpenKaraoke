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
  assert.ok(host.inbox.some((m) => m.t === 'toast' && /disconnected/.test(m.text) && /the Devices tab/.test(m.text)));
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
  assert.ok(host.inbox.some((m) => m.t === 'toast' && /Approve it in the Devices tab/.test(m.text)));
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

test('displays: the same paired screen reconnecting before its old connection timed out stays the main TV', async () => {
  const env = await setupRoom();
  const { room, connect, leave, req, view, s } = env;
  const pair = async (host, ip) => {
    const { id } = room.pairRequest(ip);
    await req(host, 'display.approve', { id });
    return room.pairStatus(id).token;
  };
  const { host, entry } = await playing(env);
  const token = await pair(host, '192.168.1.50');
  const tv = await connect('tv', { token }, { local: false });
  const board = await connect('tv', { display: 'board' });
  assert.equal(tv.welcome.display, 'main');
  await req(tv, 'tv.ready', { entryId: entry.id, dur: 200 });
  assert.equal(s().player.state, 'playing');

  // Wi-Fi drop on the TV: it reconnects while the server still holds its dead socket.
  const tvNew = await connect('tv', { token }, { local: false });
  assert.equal(tvNew.welcome.display, 'main', 'the TV is back with the sound at once');
  assert.equal(tvNew.data.standIn, false);
  assert.equal(tv.data.display, 'mirror');
  assert.ok(got(tv, 'mirror'), 'the dead socket is demoted');
  assert.equal(board.data.display, 'mirror');
  leave(tv); // the heartbeat drops the dead socket
  assert.equal(tvNew.data.display, 'main');
  assert.equal(tvNew.data.standIn, false, 'not "standing in" for itself');
  assert.equal(got(tvNew, 'main'), false, 'no second "main" message');
  assert.equal(s().player.displayLost, false);
  assert.deepEqual(view(host).displays.map((d) => [d.id, d.display, d.standIn]), [[board.id, 'mirror', false], [tvNew.id, 'main', false]]);
  // So the next plain /tv (Open TV on the PC, bin/open-tv.sh) is only a mirror.
  const another = await connect('tv');
  assert.equal(another.welcome.display, 'mirror');
  assert.equal(room.mainDisplay(), tvNew);

  // Another paired screen is not the same screen: it stays a mirror.
  const otherToken = await pair(host, '192.168.1.51');
  const otherScreen = await connect('tv', { token: otherToken }, { local: false });
  assert.equal(otherScreen.welcome.display, 'mirror');
  // Nor is the same screen's mirror tab (it asked to stay muted).
  const mirrorTab = await connect('tv', { token, display: 'mirror' }, { local: false });
  assert.equal(mirrorTab.welcome.display, 'mirror');
  assert.equal(room.mainDisplay(), tvNew);

  // Two tabs of the main screen: closing the one with the sound hands it to the other tab,
  // which is that screen (not a stand-in), even before the other plain TVs.
  const tab2 = await connect('tv', { token }, { local: false });
  assert.equal(tab2.welcome.display, 'main');
  assert.equal(tvNew.data.display, 'mirror');
  leave(tab2);
  assert.equal(tvNew.data.display, 'main');
  assert.equal(tvNew.data.standIn, false);
  assert.equal(another.data.display, 'mirror');
});

test('displays: a paired stand-in reconnecting is still only standing in', async () => {
  const env = await setupRoom();
  const { room, connect, leave, req, s } = env;
  const { host, entry } = await playing(env);
  const { id } = room.pairRequest('192.168.1.50');
  await req(host, 'display.approve', { id });
  const { token } = room.pairStatus(id);
  const tv = await connect('tv');
  const other = await connect('tv', { token }, { local: false });
  await req(tv, 'tv.ready', { entryId: entry.id, dur: 200 });
  leave(tv);
  assert.equal(other.data.display, 'main');
  assert.equal(other.data.standIn, true);
  const otherNew = await connect('tv', { token }, { local: false });
  assert.equal(otherNew.welcome.display, 'main');
  assert.equal(otherNew.data.standIn, true, 'it keeps standing in');
  leave(other);
  assert.equal(otherNew.data.display, 'main');
  assert.equal(s().player.displayLost, false);
  const back = await connect('tv');
  assert.equal(back.welcome.display, 'main', 'the real TV still takes the sound back');
  assert.equal(otherNew.data.display, 'mirror');
});

test('displays: a TV on this computer reconnecting before its old connection closed stays the main TV', async () => {
  const env = await setupRoom();
  const { room, connect, leave, req, view, s } = env;
  const tv = await connect('tv');
  const board = await connect('tv', { display: 'board' });
  const { host, entry } = await playing(env);
  await req(tv, 'tv.ready', { entryId: entry.id, dur: 200 });
  assert.equal(typeof tv.welcome.resume, 'string');
  assert.ok(tv.welcome.resume.length >= 12);
  assert.equal(board.welcome.resume === tv.welcome.resume, false, 'every connection gets its own key');
  assert.equal(view(host).displays.some((d) => 'resume' in d), false, 'the key is never shown to anyone else');

  // The page reconnects (network change) with the key of its old connection, still "open" here.
  const tvNew = await connect('tv', { resume: tv.welcome.resume });
  assert.equal(tvNew.welcome.display, 'main', 'the TV keeps the sound');
  assert.equal(tvNew.data.standIn, false);
  assert.notEqual(tvNew.welcome.resume, tv.welcome.resume, 'a fresh key for the new connection');
  assert.equal(tv.data.display, 'mirror');
  assert.equal(board.data.display, 'mirror');
  leave(tv); // the heartbeat drops the dead connection
  assert.equal(tvNew.data.display, 'main');
  assert.equal(tvNew.data.standIn, false, 'not "standing in" for itself');
  assert.equal(got(tvNew, 'main'), false, 'no second "main" message');
  assert.equal(s().player.displayLost, false);
  assert.deepEqual(view(host).displays.map((d) => [d.id, d.display, d.standIn]), [[board.id, 'mirror', false], [tvNew.id, 'main', false]]);
  // So "Open TV" on the PC or bin/open-tv.sh run again is only a mirror.
  const another = await connect('tv');
  assert.equal(another.welcome.display, 'mirror');
  assert.equal(room.mainDisplay(), tvNew);

  // A key that is used up, made up, of another kind of page, or not the main display's: a mirror.
  for (const hello of [
    { resume: tv.welcome.resume },
    { resume: 'x'.repeat(16) },
    { resume: '' },
    { resume: { toString: () => tvNew.welcome.resume } },
    { resume: another.welcome.resume },
    { resume: tvNew.welcome.resume, display: 'board' },
    { resume: tvNew.welcome.resume, display: 'mirror' },
  ]) {
    const c = await connect('tv', hello);
    assert.equal(c.welcome.display, 'mirror', JSON.stringify(hello));
    assert.equal(room.mainDisplay(), tvNew);
  }

  // A TV that only stood in is still only standing in after such a reconnect.
  leave(tvNew);
  assert.equal(another.data.display, 'main');
  assert.equal(another.data.standIn, true);
  const anotherNew = await connect('tv', { resume: another.welcome.resume });
  assert.equal(anotherNew.welcome.display, 'main');
  assert.equal(anotherNew.data.standIn, true, 'it keeps standing in');
  leave(another);
  assert.equal(anotherNew.data.standIn, true);
  const back = await connect('tv');
  assert.equal(back.welcome.display, 'main', 'the real TV still takes the sound back');
  assert.equal(anotherNew.data.display, 'mirror');

  // The host's pick (a mirror page) survives its own reconnect too.
  const mirror = await connect('tv', { display: 'mirror' });
  await req(host, 'display.main', { id: mirror.id });
  const mirrorNew = await connect('tv', { display: 'mirror', resume: mirror.welcome.resume });
  assert.equal(mirrorNew.welcome.display, 'main');
  leave(mirror);
  assert.equal(room.mainDisplay(), mirrorNew);
  assert.equal(mirrorNew.data.standIn, false);
});
