// Break music between singers and "autoplay" when the queue stays empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';
import { tmpDir, writeTree } from './helpers.js';
import { scanAudioFolder } from '../server/room/breakmusic.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('break music: plays while nobody sings, stops during a song, skips and follows the next song', async () => {
  const { connect, req, view, song, s, room } = await setupRoom({ playback: { countdown: 5 } }, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const tv = await connect('tv');
  const bm = view(tv).breakMusic;
  assert.ok(bm, 'the lobby has music');
  assert.match(bm.url, /^\/media\/\w+\/audio$/);
  assert.equal(bm.volume, 0.35);
  assert.equal(view(host).breakMusic.title, bm.title);
  await req(host, 'break.skip');
  assert.notEqual(view(tv).breakMusic.id, bm.id, 'skipped to another track');
  const id = view(tv).breakMusic.id;
  await req(tv, 'tv.break', { id });
  assert.notEqual(view(tv).breakMusic.id, id, 'the TV reported the end: next track');
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Ann' });
  await req(host, 'player.play');
  assert.equal(s().player.state, 'intro');
  assert.ok(view(tv).breakMusic, 'music continues during the countdown');
  await req(tv, 'tv.ready', { entryId: s().current.id, dur: 200 });
  room.resume();
  assert.equal(s().player.state, 'playing');
  assert.equal(view(tv).breakMusic, null, 'silent while someone sings');
  room.app.settings.update({ playback: { breakMusic: { enabled: false } } });
  s().player.pos = 190;
  room.finish('ended');
  assert.equal(view(tv).breakMusic, null, 'switched off');
});

test('break music: explicit songs never play; a mystery-free pool excludes queued songs', async () => {
  const { connect, view, room } = await setupRoom({}, { songs: ['Queen - Killer Queen (Explicit) [SF Karaoke]', 'Blondie - Rapture (Explicit) [SF Karaoke]'] });
  const tv = await connect('tv');
  assert.equal(view(tv).breakMusic, null, 'only explicit songs: nothing to play');
  assert.equal(room.breakMusic.track, null);
});

test('break music: from a music folder (only scanned files are served)', async () => {
  const music = await tmpDir('ok-music-');
  await writeTree(music, { 'Band - Tune One.mp3': 2000, 'sub/Other - Tune Two.ogg': 2000, 'notes.txt': 10, '.hidden/x.mp3': 10 });
  const files = await scanAudioFolder(music);
  assert.deepEqual(files.map((f) => f.title).sort(), ['Tune One', 'Tune Two']);
  const { app, connect, view, room } = await setupRoom({ playback: { breakMusic: { source: 'folder', folder: music } } });
  await app.listen(0, '127.0.0.1');
  try {
    const tv = await connect('tv');
    assert.equal(view(tv).breakMusic, null, 'nothing until the folder has been scanned');
    await room.breakMusic.folder.scanning;
    assert.equal(room.breakMusic.folder.dir, path.resolve(music));
    const bm = view(tv).breakMusic;
    assert.match(bm.url, /^\/media\/break\/\w+$/);
    const res = await fetch(`http://127.0.0.1:${app.port}${bm.url}`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 2000);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/media/break/nope`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/media/break/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  } finally {
    await app.close();
  }
});

test('autoplay: an empty queue gets a popular sing-along for everyone after the wait', async () => {
  const { connect, s, room, app } = await setupRoom({ playback: { whenQueueEmpty: 'autoplay', autoplayAfter: 5, countdown: 0 } }, { songs: [...SONGS, ...MORE_SONGS] });
  await connect('host');
  await connect('tv');
  room.flush();
  assert.ok(room.breakMusic.autoplayTimer, 'waiting');
  clearTimeout(room.breakMusic.autoplayTimer);
  room.breakMusic.autoplayTimer = null;
  app.settings.update({ playback: { autoplayAfter: 0.05 } });
  room.breakMusic.checkAutoplay();
  await sleep(5200); // minimum wait is 5 s
  assert.ok(s().current, 'a song started');
  assert.equal(room.singer(s().current.singerIds[0]).name, 'Everyone');
  assert.equal(s().current.source, 'game:autoplay');
  app.settings.update({ playback: { whenQueueEmpty: 'lobby' } });
  room.breakMusic.checkAutoplay();
  assert.equal(room.breakMusic.autoplayTimer, null);
});

test('autoplay: pass the mic runs alongside the karaoke — the sing-along still comes; a game on the TV holds it back', async () => {
  const { connect, req, s, room, app } = await setupRoom({ playback: { whenQueueEmpty: 'autoplay', autoplayAfter: 5, countdown: 0 } }, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  await connect('tv');
  const armed = () => {
    room.flush();
    return !!room.breakMusic.autoplayTimer;
  };
  assert.ok(armed(), 'waiting');
  // An exclusive game (the recap) owns the TV — also while its results are still up.
  await req(host, 'game.start', { type: 'recap' });
  assert.equal(armed(), false, 'not during a game on the TV');
  await req(host, 'game.end');
  assert.equal(armed(), false, 'nor while its results are on the TV');
  await req(host, 'game.close');
  assert.ok(armed());
  // Pass the mic plays along with the songs: autoplay carries on, before and after it ends.
  await req(host, 'game.start', { type: 'relay', config: { participants: 'everyone' } });
  assert.ok(armed(), 'waiting while pass the mic runs');
  clearTimeout(room.breakMusic.autoplayTimer);
  room.breakMusic.autoplayTimer = null;
  app.settings.update({ playback: { autoplayAfter: 0.05 } });
  room.breakMusic.checkAutoplay();
  await sleep(5200); // minimum wait is 5 s
  assert.ok(s().current, 'the sing-along started');
  assert.equal(s().current.source, 'game:autoplay');
  assert.equal(room.game?.type, 'relay', 'with pass the mic still on');
  room.finish('skipped', { advance: false });
  await req(host, 'game.end');
  assert.ok(armed(), 'an ended pass the mic doesn’t hold it back either');
  app.settings.update({ playback: { whenQueueEmpty: 'lobby' } });
  assert.equal(armed(), false);
});
