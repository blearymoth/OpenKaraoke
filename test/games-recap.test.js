// Party recap (server/games/recap.js): statistics from a prepared history, the slide list, an
// empty night, and the game in the room (built from real finished songs with ratings, slides
// controlled by the host, auto-advance, the same recap on every screen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import { buildRecap, slidesFor } from '../server/games/recap.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SINGERS = {
  s1: { name: 'Ann', emoji: '🦄', color: '#f0f' },
  s2: { name: 'Ben', emoji: '🐸', color: '#0f0' },
  s3: { name: 'Cy', emoji: '🐙', color: '#00f' },
  sE: { name: 'Everyone', emoji: '🎉', color: '#fff' },
};
const singerOf = (id) => (Object.hasOwn(SINGERS, id) ? SINGERS[id] : null);
let at = 1000;
const rec = (title, artist, singerIds, extra = {}) => ({
  at: (at += 1000), songId: `song-${title}`, title, artist, singerIds, singers: singerIds.map((id) => SINGERS[id]?.name || '?'),
  playedSec: 200, skipped: false, ...extra,
});

// Oldest first here; the room keeps tonight's history newest first.
const HISTORY = [
  rec('Hello', 'Adele', ['s1'], { reactions: 3, rating: { avg: 4.5, n: 4 } }),
  rec('Waterloo', 'ABBA', ['s2'], { reactions: 1, rating: { avg: 3.2, n: 5 } }),
  rec('Dancing Queen', 'Abba', ['s1', 's2'], { reactions: 9, rating: { avg: 4.5, n: 6 }, playedSec: 230 }),
  rec('Call Me', 'Blondie', ['s3'], { skipped: true, playedSec: 12, reactions: 50, rating: { avg: 5, n: 9 } }),
  rec('Mamma Mia', 'ABBA', ['sE'], { reactions: 2 }),
  rec('Africa', 'Toto', ['s1'], { rating: { avg: 2, n: 1 }, playedSec: 290 }),
  rec('Wonderwall', 'Oasis', ['gone'], { singers: ['Dee'] }), // a singer removed since: the name stays
].reverse();

test('recap: tonight’s statistics from the history (skipped songs don’t count)', () => {
  const games = [
    { type: 'battle', title: 'Battle winner', winners: ['Ben'] },
    { type: 'poll', title: 'x', winners: [] }, // nothing to show
    { type: 'applause', title: 'Loudest applause', winners: ['Ann', 'Cy'] },
    { type: 'constructor', title: 'Odd', winners: ['X'] },
  ];
  const r = buildRecap({ history: HISTORY, games, singerOf, since: 42 });
  assert.equal(r.since, 42);
  assert.deepEqual(r.totals, {
    songs: 6,
    minutes: Math.round((200 + 200 + 230 + 200 + 290 + 200) / 60),
    singers: 3, // Ann, Ben, Dee (a removed singer); Cy was skipped and "Everyone" is not a person
    reactions: 3 + 1 + 9 + 2,
    games: 3,
  });
  assert.deepEqual(r.topSingers.map((s) => [s.name, s.songs]), [['Ann', 3], ['Ben', 2], ['Dee', 1]]);
  assert.equal(r.topSingers[0].emoji, '🦄');
  assert.ok(!r.topSingers.some((s) => s.name === 'Everyone'));
  assert.ok(!r.topSingers.some((s) => s.name === 'Cy'), 'Cy was skipped');
  // Best rated: highest average, then more votes, then earlier.
  assert.deepEqual(r.bestRated.map((p) => [p.title, p.rating.avg, p.rating.n]), [['Dancing Queen', 4.5, 6], ['Hello', 4.5, 4], ['Waterloo', 3.2, 5], ['Africa', 2, 1]]);
  assert.deepEqual(r.bestRated[0].singers.map((s) => s.name), ['Ann', 'Ben']);
  assert.equal(r.bestRated[0].order, undefined, 'no internals');
  // Most sung artists: "ABBA" and "Abba" are the same artist.
  assert.deepEqual(r.topArtists[0], { artist: 'ABBA', count: 3 });
  assert.deepEqual(r.topArtists.map((a) => a.artist), ['ABBA', 'Oasis', 'Toto', 'Adele'], 'then the most recent first; Blondie was skipped');
  assert.deepEqual(r.favourite, {
    songId: 'song-Dancing Queen', title: 'Dancing Queen', artist: 'Abba', reactions: 9, rating: { avg: 4.5, n: 6 },
    singers: [{ name: 'Ann', emoji: '🦄', color: '#f0f' }, { name: 'Ben', emoji: '🐸', color: '#0f0' }],
  });
  assert.deepEqual(r.games.map((g) => [g.label, g.title, g.winners]), [
    ['Battle', 'Battle winner', ['Ben']], ['Applause meter', 'Loudest applause', ['Ann', 'Cy']], ['Game', 'Odd', ['X']],
  ]);
  assert.deepEqual(slidesFor(r), ['totals', 'singers', 'rated', 'artists', 'favourite', 'games', 'thanks']);
});

test('recap: a guest who calls themself Everyone is one of tonight’s singers; the sing-along isn’t', () => {
  const people = {
    guest: { name: 'Everyone', emoji: '🦄', color: '#f0f', deviceId: 'phone-1' },
    along: { name: 'Everyone', emoji: '🎉', color: '#fff', singAlong: true },
    old: { name: 'everyone', emoji: '🎉', color: '#fff' }, // a sing-along singer from before the flag
  };
  const of = (id) => (Object.hasOwn(people, id) ? people[id] : null);
  const history = [
    rec('Hello', 'Adele', ['guest']),
    rec('Waterloo', 'ABBA', ['along']),
    rec('Africa', 'Toto', ['old']),
    rec('Wonderwall', 'Oasis', ['gone'], { singers: ['Everyone'] }), // removed since: just the name
    rec('Call Me', 'Blondie', [], { singers: ['EVERYONE'] }), // an old record without ids
  ].reverse();
  const r = buildRecap({ history, singerOf: of });
  assert.equal(r.totals.songs, 5);
  assert.equal(r.totals.singers, 1);
  assert.deepEqual(r.topSingers.map((x) => [x.name, x.songs, x.emoji]), [['Everyone', 1, '🦄']]);
});

test('recap: slides without data are left out; an empty night says so', () => {
  const empty = buildRecap({});
  assert.deepEqual(empty.totals, { songs: 0, minutes: 0, singers: 0, reactions: 0, games: 0 });
  assert.deepEqual(slidesFor(empty), ['empty']);
  const onlySkipped = buildRecap({ history: [rec('Hello', 'Adele', ['s1'], { skipped: true })], singerOf });
  assert.deepEqual(slidesFor(onlySkipped), ['empty']);
  const gamesOnly = buildRecap({ games: [{ type: 'quiz', title: 'Quiz champion', winners: ['Ann'] }] });
  assert.deepEqual(slidesFor(gamesOnly), ['empty', 'games']);
  const one = buildRecap({ history: [rec('Hello', 'Adele', ['sE'])], singerOf });
  assert.deepEqual(slidesFor(one), ['totals', 'thanks'], 'one sing-along: no top singers, no ratings, no reactions');
  const junk = buildRecap({ history: [null, { skipped: false, playedSec: 'x', reactions: -4, rating: { avg: 'NaN', n: 3 } }], games: 'nope', singerOf });
  assert.equal(junk.totals.songs, 1);
  assert.equal(junk.totals.minutes, 0);
  assert.equal(junk.totals.reactions, 0);
  assert.deepEqual(junk.bestRated, []);
});

/** Sings `q` for `singerName` through the room: queue → play → TV ready → ended. */
async function sing(env, host, tv, q, singerName, { reactions = 0, raters = [], stars = 5 } = {}) {
  await env.req(host, 'queue.add', { songId: env.song(q).id, singerName });
  if (!env.s().current) await env.req(host, 'player.play');
  const cur = env.s().current;
  await env.req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
  for (let i = 0; i < reactions; i++) env.s().current.reactions = (env.s().current.reactions || 0) + 1;
  await env.req(tv, 'tv.ended', { entryId: cur.id });
  for (const g of raters) await env.req(g, 'rate', { entryId: cur.id, stars });
  env.room.closeRating();
  return cur;
}

test('recap: the game — built from tonight in the room, host slide controls, same recap on every screen', async () => {
  const env = await setupRoom({ playback: { countdown: 0, ratingAfterSong: true } });
  const { req, room, view, connect, guest, s } = env;
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  await sing(env, host, tv, 'hello', 'Zoe', { reactions: 2, raters: [ana, ben], stars: 4 });
  await sing(env, host, tv, 'waterloo', 'Max', { reactions: 5, raters: [ana], stars: 5 });
  await sing(env, host, tv, 'bohemian', 'Zoe');
  await req(host, 'queue.add', { songId: env.song('call me').id, singerName: 'Max' });
  await req(host, 'player.play');
  await req(host, 'player.next'); // skipped straight away
  assert.equal(s().tonight.history.length, 4);
  // An exclusive game: not while a song is on.
  await req(host, 'queue.add', { songId: env.song('rapture').id, singerName: 'Max' });
  await req(host, 'player.play');
  await assert.rejects(req(host, 'game.start', { type: 'recap' }), /current song/);
  await req(host, 'player.stop');
  s().tonight.games.push({ type: 'battle', at: Date.now(), title: 'Battle winner', winners: ['Zoe'] });
  await req(host, 'game.start', { type: 'recap', config: { seconds: 999 } });
  const g = room.game;
  assert.equal(g.config.seconds, 30, 'clamped');
  const v = view(tv).game;
  assert.equal(v.type, 'recap');
  assert.equal(v.phase, 'slides');
  assert.equal(v.slide, 'totals');
  assert.equal(v.index, 0);
  assert.ok(v.advancing && v.endsAt > Date.now());
  assert.equal(v.recap.totals.songs, 3);
  assert.equal(v.recap.totals.reactions, 7);
  assert.deepEqual(v.recap.topSingers.map((x) => [x.name, x.songs]), [['Zoe', 2], ['Max', 1]]);
  assert.deepEqual(v.recap.bestRated.map((p) => [p.title, p.rating.avg]), [['Waterloo', 5], ['Hello', 4]]);
  assert.equal(v.recap.favourite.title, 'Waterloo');
  assert.deepEqual(v.recap.games[0].winners, ['Zoe']);
  assert.deepEqual(v.slides, ['totals', 'singers', 'rated', 'artists', 'favourite', 'games', 'thanks']);
  assert.deepEqual(view(ana).game.recap, v.recap, 'phones get the same recap');
  // Host controls: next / prev (wrapping) / goto / pause / play; guests can't.
  await assert.rejects(req(ana, 'game.action', { action: 'next' }), /not allowed/);
  assert.equal((await req(host, 'game.action', { action: 'next' })).index, 1);
  assert.equal(view(tv).game.slide, 'singers');
  assert.equal((await req(host, 'game.action', { action: 'prev' })).index, 0);
  assert.equal((await req(host, 'game.action', { action: 'prev' })).index, 6, 'wraps to the last slide');
  assert.equal(view(tv).game.slide, 'thanks');
  assert.equal(view(tv).game.advancing, false, 'the last slide stays up');
  await req(host, 'game.action', { action: 'goto', index: 2 });
  assert.equal(view(tv).game.slide, 'rated');
  await assert.rejects(req(host, 'game.action', { action: 'goto', index: 7 }), /No such slide/);
  await assert.rejects(req(host, 'game.action', { action: 'goto', index: '__proto__' }), /No such slide/);
  await req(host, 'game.action', { action: 'pause' });
  assert.equal(view(host).game.auto, false);
  assert.equal(view(host).game.endsAt, 0);
  await req(host, 'game.action', { action: 'play' });
  assert.equal(view(host).game.auto, true);
  assert.ok(view(host).game.endsAt > 0);
  await assert.rejects(req(host, 'game.action', { action: 'boom' }), /Unknown/);
  await assert.rejects(req(ana, 'game.input', { x: 1 }), /not taking answers/);
  // Auto-advance (short slides for the test) stops at the last slide unless looping.
  g.config.seconds = 0.03;
  g.show(5);
  await sleep(120);
  assert.equal(g.index, 6);
  g.config.loop = true;
  g.config.seconds = 0.2;
  g.show(6);
  for (let i = 0; i < 100 && g.index === 6; i++) await sleep(10);
  assert.equal(g.index, 0, 'looping starts over');
  g.config.loop = false;
  // Refresh: a song sung meanwhile shows up, the current slide stays.
  g.auto = false;
  g.show(1);
  s().tonight.history.unshift({ at: Date.now(), songId: 'x', title: 'Extra', artist: 'Adele', singers: ['Zoe'], singerIds: [], playedSec: 100, skipped: false });
  await req(host, 'game.action', { action: 'refresh' });
  assert.equal(view(tv).game.recap.totals.songs, 4);
  assert.equal(view(tv).game.slide, 'singers');
  assert.equal(g.summary(), null);
  await req(host, 'game.end');
  assert.equal(view(ana).game.phase, 'done');
  await req(host, 'game.close');
  assert.equal(s().current, null, 'the stopped song waits for Play');
});

test('recap: in the room, a guest called Everyone is on the top singers slide; sing-alongs aren’t', async () => {
  const env = await setupRoom({ playback: { countdown: 0 } });
  const { req, view, connect, guest, s } = env;
  const host = await connect('host');
  const tv = await connect('tv');
  const eve = await guest('Everyone');
  await req(eve, 'queue.add', { songId: env.song('hello').id }); // from her phone
  await req(host, 'player.play');
  const cur = s().current;
  await req(tv, 'tv.ready', { entryId: cur.id, dur: 200 });
  await req(tv, 'tv.ended', { entryId: cur.id });
  await sing(env, host, tv, 'waterloo', 'Everyone'); // the host's sing-along
  await req(host, 'game.start', { type: 'recap' });
  const r = view(tv).game.recap;
  assert.equal(r.totals.songs, 2);
  assert.equal(r.totals.singers, 1);
  assert.deepEqual(r.topSingers.map((x) => [x.name, x.songs]), [['Everyone', 1]]);
  assert.equal(r.topSingers[0].emoji, s().singers.find((x) => x.deviceId === eve.data.deviceId).emoji, 'the guest, not the sing-along');
  await req(host, 'game.close');
});

test('recap: an empty night — one slide, no auto-advance', async () => {
  const { req, room, view, connect, guest } = await setupRoom();
  const host = await connect('host');
  const ana = await guest('Ana');
  await req(host, 'game.start', { type: 'recap' });
  const v = view(ana).game;
  assert.deepEqual(v.slides, ['empty']);
  assert.equal(v.slide, 'empty');
  assert.equal(v.advancing, false);
  assert.equal(v.recap.totals.songs, 0);
  assert.equal((await req(host, 'game.action', { action: 'next' })).index, 0);
  assert.equal(room.game.phase, 'slides');
});
