// Break music between singers and "autoplay" when the queue stays empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';
import { tmpDir, writeTree, makeZip } from './helpers.js';
import { scanAudioFolder } from '../server/room/breakmusic.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Counts the catalog searches break music makes (each one filters and sorts the whole library). */
function countRandom(catalog) {
  const counter = { n: 0 };
  const random = catalog.random.bind(catalog);
  catalog.random = (...args) => {
    counter.n++;
    return random(...args);
  };
  return counter;
}

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

/** A small library (like the demo): fewer songs than the tracks kept from repeating. */
const FIVE_SONGS = ['Adele - Hello [SF Karaoke]', 'Queen - Bohemian Rhapsody [SF Karaoke]', 'Blondie - Call Me [SC Karaoke]', 'ABBA - Waterloo [SF Karaoke]', 'Toto - Africa [SF Karaoke]'];

test('break music: a small library plays on at every break, all night (no repeat back to back)', async () => {
  const { connect, req, view, s, room, app } = await setupRoom({ playback: { countdown: 10, autoStart: true } }, { songs: FIVE_SONGS });
  const host = await connect('host');
  const tv = await connect('tv');
  const songs = [...app.library.catalog.songs.values()];
  assert.equal(songs.length, 5);
  const lobbies = [];
  for (let i = 0; i < 12; i++) {
    await req(host, 'queue.add', { songId: songs[i % songs.length].id, singerName: 'Ann' });
    const cur = s().current;
    const intro = view(tv).breakMusic;
    assert.ok(intro, `music in the countdown to song ${i + 1}`);
    assert.notEqual(intro.id, `lib:${cur.songId}`, 'not the song counting down');
    await req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
    room.resume();
    assert.equal(view(tv).breakMusic, null, 'silent while someone sings');
    await req(tv, 'tv.ended', { entryId: cur.id });
    const lobby = view(tv).breakMusic;
    assert.ok(lobby, `music in the lobby after song ${i + 1}`);
    if (lobbies.length) assert.notEqual(lobby.id, lobbies.at(-1), `a fresh track after song ${i + 1}`);
    lobbies.push(lobby.id);
  }
  assert.equal(new Set(lobbies).size, songs.length, `every song had its turn: ${lobbies.join(' ')}`);
  // Tracks that play to their end in the lobby: the one played longest ago comes next.
  const played = [];
  for (let i = 0; i < 10; i++) {
    const { id } = view(tv).breakMusic;
    room.breakMusic.track.at -= 60_000;
    await req(tv, 'tv.break', { id });
    played.push(view(tv).breakMusic.id);
  }
  assert.deepEqual(played.slice(5), played.slice(0, 5), 'the five songs in turn');
  assert.equal(new Set(played).size, songs.length);
});

test('break music: a pick that found nothing is tried again when the queue changes (not a minute later)', async () => {
  const { connect, req, view, s, app, room } = await setupRoom({ playback: { countdown: 10, autoStart: true, breakMusic: { enabled: false } } }, { songs: FIVE_SONGS });
  const host = await connect('host');
  const tv = await connect('tv');
  for (const song of app.library.catalog.songs.values()) await req(host, 'queue.add', { songId: song.id, singerName: 'Ann' });
  assert.equal(s().player.state, 'intro');
  const searches = countRandom(app.library.catalog);
  await req(host, 'settings.update', { patch: { playback: { breakMusic: { enabled: true } } } });
  assert.equal(view(tv).breakMusic, null, 'every song is coming up: none of them as break music');
  assert.ok(searches.n > 0);
  const n = searches.n;
  for (let i = 0; i < 10; i++) room.flush();
  assert.equal(searches.n, n, 'no new search on every broadcast');
  const last = s().queue.at(-1);
  await req(host, 'queue.remove', { entryId: last.id });
  assert.equal(view(tv).breakMusic?.id, `lib:${last.songId}`, 'a song left the queue: it plays straight away');
});

test('break music: a small music folder never plays the same song twice in a row', async () => {
  const music = await tmpDir('ok-music-three-');
  await writeTree(music, { 'A - One.mp3': 2000, 'B - Two.mp3': 2000, 'C - Three.mp3': 2000 });
  const { connect, view, room, req } = await setupRoom({ playback: { breakMusic: { source: 'folder', folder: music } } });
  const tv = await connect('tv');
  view(tv);
  await room.breakMusic.folder.scanning;
  const played = [view(tv).breakMusic.title];
  for (let i = 0; i < 20; i++) {
    const bm = view(tv).breakMusic;
    room.breakMusic.track.at -= 60_000;
    await req(tv, 'tv.break', { id: bm.id, pick: bm.pick });
    played.push(view(tv).breakMusic.title);
  }
  for (let i = 1; i < played.length; i++) assert.notEqual(played[i], played[i - 1], played.join(', '));
  assert.deepEqual(new Set(played), new Set(['One', 'Two', 'Three']));
});

test('break music: a new volume fades the song that is on (0% is silence); a new source picks anew', async () => {
  const music = await tmpDir('ok-music-');
  await writeTree(music, { 'Band - Tune One.mp3': 2000 });
  const { connect, req, view, room } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const tv = await connect('tv');
  const id = view(tv).breakMusic.id;
  for (const volume of [0.3, 0.2, 0.15]) {
    await req(host, 'settings.update', { patch: { playback: { breakMusic: { volume } } } });
    assert.equal(view(tv).breakMusic.id, id, 'the same song');
    assert.equal(view(tv).breakMusic.volume, volume);
  }
  await req(host, 'settings.update', { patch: { playback: { breakMusic: { volume: 0 } } } });
  assert.equal(view(tv).breakMusic, null, '0% is silence (not the 35% default)');
  assert.equal(view(host).breakMusic, null);
  await req(host, 'settings.update', { patch: { playback: { breakMusic: { volume: 0.25 } } } });
  assert.equal(view(tv).breakMusic.volume, 0.25);
  await req(host, 'settings.update', { patch: { playback: { breakMusic: { source: 'folder', folder: music } } } });
  assert.equal(view(tv).breakMusic, null, 'the folder is being scanned');
  await room.breakMusic.folder.scanning;
  assert.equal(view(tv).breakMusic.title, 'Tune One', 'the music comes from the folder now');
});

test('break music: explicit songs never play; a mystery-free pool excludes queued songs', async () => {
  const { connect, view, room } = await setupRoom({}, { songs: ['Queen - Killer Queen (Explicit) [SF Karaoke]', 'Blondie - Rapture (Explicit) [SF Karaoke]'] });
  const tv = await connect('tv');
  assert.equal(view(tv).breakMusic, null, 'only explicit songs: nothing to play');
  assert.equal(room.breakMusic.track, null);
});

test('break music: only tracks the TV can play (no videos, no zipped videos), and no search on every broadcast when there are none', async () => {
  const { app, connect, view, room } = await setupRoom({}, { songs: [] });
  const lib = app.library.paths[0];
  const files = Object.fromEntries(['A - One', 'B - Two', 'C - Three'].map((n) => [`${n} [SF Karaoke].mp4`, 100]));
  files['D - Four [SF Karaoke].zip'] = makeZip([{ name: 'D - Four.mp4', data: Buffer.alloc(100) }]);
  await writeTree(lib, files);
  await app.library.scan();
  assert.equal(app.library.catalog.songs.size, 4);
  const searches = countRandom(app.library.catalog);
  const tv = await connect('tv');
  await connect('host');
  assert.equal(view(tv).breakMusic, null, 'videos only: no break music');
  const n = searches.n;
  assert.ok(n > 0);
  for (let i = 0; i < 10; i++) room.flush();
  assert.equal(searches.n, n, 'no new search on every broadcast');
  // A rescan that finds a playable track: picked straight away.
  await writeTree(lib, { 'E - Five [SF Karaoke].cdg': 7200 * 200, 'E - Five [SF Karaoke].mp3': 100 });
  await app.library.scan();
  assert.equal(view(tv).breakMusic?.title, 'Five');
});

test('break music: nothing from an unplugged drive — no request/broadcast loop — and back when it is connected', async () => {
  const { app, connect, req, view, room } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const lib = app.library.paths[0];
  const tv = await connect('tv');
  const bm = view(tv).breakMusic;
  assert.ok(bm);
  await fs.rename(lib, `${lib}-unplugged`);
  try {
    await app.library.checkOnline(); // (what the media route does when a file is missing)
    assert.equal(app.library.status().offline, true);
    const searches = countRandom(app.library.catalog);
    await req(tv, 'tv.break', { id: bm.id, error: true });
    assert.equal(view(tv).breakMusic, null, 'the TV could not play it: silence, not the next song from the same drive');
    for (let i = 0; i < 10; i++) room.flush();
    assert.equal(searches.n, 0, 'the library is not searched while its drive is away');
  } finally {
    await fs.rename(`${lib}-unplugged`, lib);
  }
  await app.library.checkOnline();
  assert.ok(view(tv).breakMusic, 'the drive is back: music again');
});

test('break music: several unplayable tracks in a row → a rest instead of a request/broadcast loop', async (t) => {
  const { connect, req, view, room } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const tv = await connect('tv');
  const bm = room.breakMusic;
  // Tracks that play to their end are fine, however many.
  for (let i = 0; i < 5; i++) {
    const id = view(tv).breakMusic.id;
    bm.track.at -= 60_000;
    await req(tv, 'tv.break', { id });
    assert.notEqual(view(tv).breakMusic.id, id);
  }
  // The TV says it couldn't play them: two more tries, then a minute of silence.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (let i = 0; i < 3; i++) {
    const id = view(tv).breakMusic?.id;
    assert.ok(id, `try ${i + 1}`);
    await req(tv, 'tv.break', { id, error: true });
  }
  assert.equal(view(tv).breakMusic, null, 'resting');
  t.mock.timers.tick(30_000);
  assert.equal(view(tv).breakMusic, null, 'still resting');
  t.mock.timers.tick(30_000);
  assert.ok(view(tv).breakMusic, 'a minute later it tries again');
  // An older TV page reports failures as an end right after the pick: the same.
  for (let i = 0; i < 3; i++) await req(tv, 'tv.break', { id: view(tv).breakMusic.id });
  assert.equal(view(tv).breakMusic, null, 'resting again');
  // The host changes the break music settings (maybe fixing the problem): it tries straight away.
  await req(host, 'settings.update', { patch: { playback: { breakMusic: { matchNext: false } } } });
  assert.ok(view(tv).breakMusic);
});

test('break music: every pick has a number — a repeated or late report counts once, and a one-song folder plays on', async () => {
  const music = await tmpDir('ok-music-one-');
  await writeTree(music, { 'Band - Only Song.mp3': 2000 });
  const { connect, view, room, req } = await setupRoom({ playback: { breakMusic: { source: 'folder', folder: music } } });
  const tv = await connect('tv');
  view(tv);
  await room.breakMusic.folder.scanning;
  const first = view(tv).breakMusic;
  assert.equal(first.title, 'Only Song');
  assert.ok(Number.isSafeInteger(first.pick));
  await req(tv, 'tv.break', { id: first.id, pick: first.pick }); // it ended
  const again = view(tv).breakMusic;
  assert.equal(again.id, first.id, 'the only song again…');
  assert.notEqual(again.pick, first.pick, '…as a new pick (the TV plays it from the top)');
  // The same report again (the TV sends it while it still sees that pick: a broadcast crossed
  // it, or the first one was lost on a reconnect): ignored, without a broadcast.
  for (let i = 0; i < 5; i++) await req(tv, 'tv.break', { id: first.id, pick: first.pick, error: true });
  assert.equal(room.flushTimer, null, 'nothing changed: no broadcast');
  assert.deepEqual(view(tv).breakMusic, again);
  assert.equal(room.breakMusic.restUntil, 0, 'late reports are not failures');
  // Older TV pages send no pick: their report is taken.
  await req(tv, 'tv.break', { id: again.id });
  assert.notEqual(view(tv).breakMusic.pick, again.pick);
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
    // A rescan whose sample leaves the playing file out: the TV can still stream it.
    room.breakMusic.folder.files = room.breakMusic.folder.files.filter((f) => f.id !== bm.id);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}${bm.url}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/media/break/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  } finally {
    await app.close();
  }
});

test('break music: a new music folder plays only its own songs (none from the folder before while it is scanned)', async () => {
  const before = await tmpDir('ok-music-a-');
  const after = await tmpDir('ok-music-b-');
  await writeTree(before, { 'Old - Song A.mp3': 2000 });
  await writeTree(after, { 'New - Song B.mp3': 2000 });
  const { connect, view, room, req } = await setupRoom({ playback: { breakMusic: { source: 'folder', folder: before } } });
  const host = await connect('host');
  const tv = await connect('tv');
  view(tv);
  await room.breakMusic.folder.scanning;
  assert.equal(view(tv).breakMusic.title, 'Song A');
  await req(host, 'settings.update', { patch: { playback: { breakMusic: { folder: after } } } });
  assert.equal(view(tv).breakMusic, null, 'silence while the new folder is scanned');
  await room.breakMusic.folder.scanning;
  assert.equal(view(tv).breakMusic.title, 'Song B');
});

test('break music folder scan: follows symbolic links (once, no loops) and samples a big folder from end to end', async () => {
  const root = await tmpDir('ok-music-links-');
  await writeTree(root, {
    'music/Real/B - Two.mp3': 100,
    'other/Artist/A - Song.mp3': 100,
    'other/Artist/A - Another.ogg': 100,
    'single/Link Target - Tune.mp3': 100,
  });
  const music = path.join(root, 'music');
  await fs.symlink('../other', path.join(music, 'Library')); // all the music on a second disk
  await fs.symlink('../other', path.join(music, 'Same Library')); // the same folder twice
  await fs.symlink('../single/Link Target - Tune.mp3', path.join(music, 'Link - Tune.mp3'));
  await fs.symlink('..', path.join(music, 'Real', 'up')); // a loop back up the tree
  await fs.symlink('nowhere', path.join(music, 'Broken - Link.mp3'));
  const files = await scanAudioFolder(music);
  assert.deepEqual(files.map((f) => f.title).sort(), ['Another', 'Song', 'Tune', 'Two']);
  assert.equal(new Set(files.map((f) => f.id)).size, files.length);

  const big = await tmpDir('ok-music-big-');
  const tree = {};
  for (let a = 0; a < 30; a++) for (let t = 0; t < 10; t++) tree[`Artist ${a}/Artist ${a} - Song ${t}.mp3`] = 10;
  await writeTree(big, tree);
  const sample = await scanAudioFolder(big, { max: 50 });
  assert.equal(sample.length, 50);
  assert.equal(new Set(sample.map((f) => f.id)).size, 50, 'no file twice');
  const artists = new Set(sample.map((f) => f.artist));
  assert.ok(artists.size > 15, `drawn from the whole folder, not the first few artists (${artists.size} of 30)`);
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
