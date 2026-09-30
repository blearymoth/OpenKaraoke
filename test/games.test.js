// Game framework (server/games/base.js + room integration), the poll, song snippets and ratings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';
import { Game, decadeIn } from '../server/games/base.js';
import { GAMES } from '../server/games/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('games: start rules — one at a time, exclusive games need the TV free, guests can’t start them', async () => {
  const { req, connect, guest, song, s, room } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'game.start', { type: 'poll' }), /not allowed/);
  await assert.rejects(req(host, 'game.start', { type: 'nope' }), /Unknown game/);
  await assert.rejects(req(host, 'game.start', { type: '__proto__' }), /Unknown game/);
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Bo' });
  await req(host, 'player.play');
  assert.ok(s().current);
  await assert.rejects(req(host, 'game.start', { type: 'poll' }), /current song/);
  await req(host, 'player.stop');
  const { id } = await req(host, 'game.start', { type: 'poll', config: { seconds: 60 } });
  assert.ok(id);
  await assert.rejects(req(host, 'game.start', { type: 'poll' }), /already running/);
  await assert.rejects(req(host, 'player.play'), /game is using the TV/, 'songs wait while the poll is on the TV');
  assert.equal(room.maybeAutoStart(), false);
  await req(host, 'game.close');
  assert.equal(room.game, null);
});

test('poll: phones vote (and can change their vote), the winner is queued next for everyone', async () => {
  const { req, connect, guest, s, room, view } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const cy = await guest('Cy');
  await req(host, 'game.start', { type: 'poll', config: { seconds: 30 } });
  const tvView = view(tv).game;
  assert.equal(tvView.type, 'poll');
  assert.equal(tvView.phase, 'vote');
  assert.equal(tvView.candidates.length, 4);
  assert.ok(tvView.endsAt > Date.now());
  assert.equal(tvView.myVote, undefined, 'the TV has no vote');
  assert.equal(view(ana).game.myVote, -1);
  await req(ana, 'game.input', { choice: 2 });
  await req(ben, 'game.input', { choice: 2 });
  await req(cy, 'game.input', { choice: 0 });
  await req(cy, 'game.input', { choice: 2 }); // changed their mind
  await assert.rejects(req(ana, 'game.input', { choice: 9 }), /Pick one/);
  await assert.rejects(req(ana, 'game.input', {}), /Pick one/);
  assert.equal(view(ana).game.myVote, 2);
  assert.deepEqual(view(host).game.candidates.map((c) => c.votes), [0, 0, 3, 0]);
  const winner = view(tv).game.candidates[2];
  await req(host, 'game.action', { action: 'close' });
  const g = view(tv).game;
  assert.equal(g.phase, 'result');
  assert.equal(g.winner, 2);
  assert.equal(s().queue[0].songId, winner.songId);
  assert.equal(s().queue[0].source, 'game:poll');
  assert.equal(room.singer(s().queue[0].singerIds[0]).name, 'Everyone');
  await assert.rejects(req(ana, 'game.input', { choice: 1 }), /closed/);
  // The result screen ends the game; results stay until the host closes it.
  room.game.end();
  assert.equal(view(host).game.phase, 'done');
  await assert.rejects(req(ana, 'game.input', { choice: 1 }), /No game/);
  assert.equal(s().tonight.games.length, 0, 'polls have no winners to remember');
  await req(host, 'game.close');
  assert.equal(view(ana).game, null);
});

test('poll: nobody votes → drawn by lot; guests without a name can’t vote; games can be switched off for phones', async () => {
  const { req, connect, guest, app } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  const nameless = await connect('guest');
  await req(host, 'game.start', { type: 'poll', config: { seconds: 20, singer: 'nobody' } });
  await assert.rejects(req(nameless, 'game.input', { choice: 0 }), /name/);
  app.settings.update({ guests: { games: false } });
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'game.input', { choice: 0 }), /turned off games/);
  const r = await req(host, 'game.action', { action: 'close' });
  assert.ok(r.winner >= 0 && r.winner < 4);
  assert.equal(app.room.s.queue[0].singerIds.length, 0, '"nobody": the host assigns a singer later');
});

test('game setup: "Any" decade means no decade filter (not the 1900s)', async () => {
  assert.equal(decadeIn(''), 0);
  assert.equal(decadeIn(null), 0);
  assert.equal(decadeIn(undefined), 0);
  assert.equal(decadeIn('abc'), 0);
  assert.equal(decadeIn(1500), 0);
  assert.equal(decadeIn(1987), 1980);
  assert.equal(decadeIn('1990'), 1990);
  const { req, connect } = await setupRoom({}, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  await req(host, 'game.start', { type: 'poll', config: { seconds: 20, decade: '' } });
  const r = await req(host, 'game.action', { action: 'close' });
  assert.ok(r.winner >= 0, 'songs were found without a decade');
});

test('poll: the timer closes the vote, then the game ends and the queue carries on', async () => {
  const { req, connect, s, room } = await setupRoom({ playback: { autoStart: true, countdown: 0 } }, { songs: [...SONGS, ...MORE_SONGS] });
  const host = await connect('host');
  await connect('tv');
  await req(host, 'game.start', { type: 'poll', config: { seconds: 10 } });
  room.game.setPhase('vote', 0.05, () => room.game.close());
  await sleep(120);
  assert.equal(room.game.phase, 'result');
  assert.equal(s().current, null, 'nothing starts while the result is on the TV');
  room.game.setPhase('result', 0.05, () => room.game.end());
  await sleep(120);
  assert.equal(room.game.phase, 'done');
  assert.ok(s().current, 'the winning song starts once the game is over');
});

test('game hooks: a game can sing songs itself (snippets with clipEnd) and decides what comes next', async () => {
  class Sing extends Game {
    static type = 'sing';
    static exclusive = true;
    start() {
      this.ended_ = [];
      this.phase = 'singing';
      this.entry = this.room.gameSing(this.catalog.search('hello').items[0], { clipEnd: 30, gameId: this.id, source: 'game:sing' });
    }
    onSongEnd(entry, info) {
      this.ended_.push({ id: entry.id, ...info });
      return true;
    }
  }
  GAMES.sing = Sing;
  try {
    const { req, connect, s, room, song, view } = await setupRoom();
    const host = await connect('host');
    const tv = await connect('tv');
    await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Queued' });
    await req(host, 'player.stop').catch(() => {});
    assert.equal(s().current, null);
    await req(host, 'game.start', { type: 'sing' });
    const cur = s().current;
    assert.equal(cur.clipEnd, 30);
    assert.equal(cur.source, 'game:sing');
    assert.equal(view(tv).current.clipEnd, 30);
    assert.equal(s().player.dur, 30, 'progress bars use the snippet length');
    await req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
    assert.equal(s().player.dur, 30);
    // The TV fades out at clipEnd; the server's safety net ends it 3 s later anyway.
    await req(tv, 'tv.status', { entryId: cur.id, pos: 33.5, dur: 200, playing: true });
    assert.equal(s().current, null);
    assert.equal(room.game.ended_[0].completed, true);
    assert.equal(s().queue.length, 1, 'the queued song did not start: the game decides');
    assert.equal(s().tonight.history[0].game, 'sing');
    assert.equal(room.rating, null, 'no rating window for game songs');
    await req(host, 'game.close');
  } finally {
    delete GAMES.sing;
  }
});

test('ratings: guests rate a finished performance (not their own); average lands in history and singer stats', async () => {
  const { req, connect, guest, s, room, view, song } = await setupRoom({ playback: { countdown: 0, ratingAfterSong: true } });
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const cy = await guest('Cy');
  await req(ana, 'queue.add', { songId: song('hello').id });
  await req(host, 'player.play');
  const cur = s().current;
  await req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
  await req(ben, 'reaction', { emoji: '🔥' });
  await req(tv, 'tv.ended', { entryId: cur.id });
  const r = view(ben).rating;
  assert.equal(r.entryId, cur.id);
  assert.equal(r.own, false);
  assert.equal(view(ana).rating.own, true);
  await assert.rejects(req(ana, 'rate', { entryId: cur.id, stars: 5 }), /own performance/);
  await req(ben, 'rate', { entryId: cur.id, stars: 5 });
  await req(cy, 'rate', { entryId: cur.id, stars: 2 });
  await req(cy, 'rate', { entryId: cur.id, stars: 4 }); // changed
  await assert.rejects(req(cy, 'rate', { entryId: 'other', stars: 4 }), /closed/);
  await assert.rejects(req(cy, 'rate', { entryId: cur.id, stars: 'x' }), /1 to 5/);
  assert.equal(view(tv).rating.avg, 4.5);
  assert.equal(view(ben).rating.mine, 5);
  room.closeRating();
  assert.deepEqual(s().tonight.history[0].rating, { avg: 4.5, n: 2 });
  assert.equal(s().tonight.history[0].reactions, 1);
  const singer = view(host).singers.find((x) => x.name === 'Ana');
  assert.equal(singer.stars, 4.5);
  assert.equal(view(ben).rating, null);
  await assert.rejects(req(ben, 'rate', { entryId: cur.id, stars: 3 }), /closed/);
});

test('ratings: skipped songs and ratings turned off open no rating window', async () => {
  const { req, connect, s, room, app, song } = await setupRoom({ playback: { countdown: 0 } });
  const host = await connect('host');
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Bo' });
  await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Cy' });
  await req(host, 'player.play');
  await req(host, 'player.next'); // skipped after 0 s
  assert.equal(room.rating, null);
  app.settings.update({ playback: { ratingAfterSong: false } });
  s().player.pos = 190;
  room.finish('ended');
  assert.equal(room.rating, null);
});
