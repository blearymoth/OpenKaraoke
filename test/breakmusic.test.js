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

test('break music: every break gets a fresh track that matches the song coming up (not the same intro all night)', async () => {
  const { connect, req, view, song, s, room, app } = await setupRoom({ playback: { countdown: 5, autoStart: true } }, { songs: [...SONGS, ...MORE_SONGS] });
  const genres = { abba: 'Disco', 'gloria gaynor': 'Disco', toto: 'Rock', journey: 'Rock', 'bon jovi': 'Rock', survivor: 'Rock', oasis: 'Rock' };
  const catalog = app.library.catalog;
  const genreOf = (s) => genres[s.artist.toLowerCase()] || 'Pop';
  catalog.metaFor = (key) => {
    const s = [...catalog.songs.values()].find((x) => x.key === key);
    return s ? { genre: genreOf(s) } : null;
  };
  const host = await connect('host');
  const tv = await connect('tv');
  const lobby = view(tv).breakMusic.id;
  await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Ann' });
  await req(host, 'queue.add', { songId: song('africa').id, singerName: 'Bo' });
  await req(host, 'queue.add', { songId: song('dancing queen').id, singerName: 'Cy' });
  if (catalog.song(lobby.replace(/^lib:/, '')).title !== 'Waterloo') assert.equal(view(tv).breakMusic.id, lobby, 'the lobby music carries on into the first countdown');
  else assert.notEqual(view(tv).breakMusic.id, lobby, 'unless it is the song now counting down');
  const breakSong = () => catalog.song(view(tv).breakMusic.id.replace(/^lib:/, ''));
  const sing = async () => {
    const cur = s().current;
    await req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
    room.resume();
    assert.equal(s().player.state, 'playing');
    assert.equal(view(tv).breakMusic, null, 'silent while someone sings');
    await req(tv, 'tv.ended', { entryId: cur.id });
  };
  const ids = [];
  for (const [title, genre] of [['Waterloo', null], ['Africa', 'Rock'], ['Dancing Queen', 'Disco']]) {
    assert.equal(s().current.title, title);
    assert.equal(s().player.state, 'intro');
    const bs = breakSong();
    if (genre) assert.equal(genreOf(bs), genre, `the countdown to ${title} plays ${genre}`);
    assert.notEqual(bs.title, title, 'never the backing track of the song coming up');
    ids.push(view(tv).breakMusic.id);
    await sing();
  }
  ids.push(view(tv).breakMusic.id);
  assert.equal(new Set(ids).size, ids.length, `a new track at every break: ${ids.join(' ')}`);
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

test('autoplay: a finished poll stays on the TV until its winner starts, then the lobby and autoplay come back', async () => {
  const { connect, req, view, s, room } = await setupRoom(
    { playback: { autoStart: true, countdown: 0, whenQueueEmpty: 'autoplay', autoplayAfter: 60 } },
    { songs: [...SONGS, ...MORE_SONGS] },
  );
  const host = await connect('host');
  const tv = await connect('tv');
  await req(host, 'game.start', { type: 'poll', config: { seconds: 10 } });
  room.game.setPhase('vote', 0.05, () => room.game.close());
  await sleep(120);
  assert.equal(view(tv).game.phase, 'result', 'the result is on the TV');
  assert.equal(room.breakMusic.autoplayTimer, null, 'no autoplay while the poll is on the TV');
  room.game.setPhase('result', 0.05, () => room.game.end());
  await sleep(120);
  const cur = s().current;
  assert.ok(cur, 'the winning song starts once the poll is over');
  assert.equal(view(host).game.phase, 'done', 'the host still sees the result while the winner is sung');
  await req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
  await req(tv, 'tv.ended', { entryId: cur.id });
  assert.equal(s().current, null);
  assert.equal(room.game, null, 'the party moved on: the finished poll is closed');
  assert.equal(view(tv).game, null, 'the lobby is back after the winner, not the old poll');
  assert.ok(room.breakMusic.autoplayTimer, 'autoplay is armed again');
});

test('games: a game that ends during a song keeps its results up after that song', async () => {
  const { connect, req, view, s, room, song } = await setupRoom({ playback: { countdown: 0 } }, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const tv = await connect('tv');
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Ann' });
  await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Bo' });
  await req(host, 'game.start', { type: 'relay', config: {} });
  await req(host, 'player.play');
  const first = s().current;
  await req(host, 'game.end');
  await req(tv, 'tv.ended', { entryId: first.id });
  assert.ok(room.game?.ended, 'ended during the first song: still there after it');
  const second = s().current;
  assert.ok(second && second.id !== first.id);
  await req(tv, 'tv.ended', { entryId: second.id });
  assert.equal(room.game, null, 'closed once the next song is over');
  assert.equal(view(tv).game, null);
});

test('autoplay: the results of a game that ended with nothing queued hold it back until they are closed', async () => {
  const { connect, req, view, room } = await setupRoom(
    { playback: { autoStart: true, countdown: 0, whenQueueEmpty: 'autoplay', autoplayAfter: 60 } },
    { songs: [...SONGS, ...MORE_SONGS] },
  );
  const host = await connect('host');
  const tv = await connect('tv');
  await req(host, 'game.start', { type: 'poll', config: { seconds: 10 } });
  await req(host, 'game.end');
  assert.equal(view(tv).game.ended, true, 'the results stay on the TV');
  assert.equal(room.breakMusic.autoplayTimer, null);
  await req(host, 'game.close');
  view(tv);
  assert.ok(room.breakMusic.autoplayTimer, 'closed: autoplay is armed');
});
