// Singing battle (server/games/battle.js): setup validation, brackets with byes, duel best-of,
// showcase averages, phone voting rules, judges, ties, the karaoke flow with snippets, end/summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';
import { Battle, buildBracket, seedOrder, roundName } from '../server/games/battle.js';

const ALL = [...SONGS, ...MORE_SONGS];

/** A room with a host, the main TV and the given guests (who become singers with phones). */
async function party(names = [], settings = {}) {
  const ctx = await setupRoom(settings, { songs: ALL });
  ctx.host = await ctx.connect('host');
  ctx.tv = await ctx.connect('tv');
  ctx.g = {};
  for (const n of names) ctx.g[n] = await ctx.guest(n);
  ctx.start = (config) => ctx.req(ctx.host, 'game.start', { type: 'battle', config });
  ctx.act = (action, body = {}) => ctx.req(ctx.host, 'game.action', { action, ...body });
  ctx.game = () => ctx.room.game;
  /** Starts the next performance and lets the TV play it to the end. */
  ctx.perform = async () => {
    await ctx.act('start');
    const cur = ctx.s().current;
    assert.ok(cur, 'a battle song is on');
    await ctx.req(ctx.tv, 'tv.ready', { entryId: cur.id, dur: 200 });
    await ctx.req(ctx.tv, 'tv.ended', { entryId: cur.id });
    return cur;
  };
  ctx.name = (i) => ctx.game().cView(i).name;
  return ctx;
}

test('battle: pure helpers — seeding order, brackets with byes, round names', () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  for (let n = 2; n <= 8; n++) {
    const rounds = buildBracket(n);
    const size = rounds[0].length * 2;
    assert.ok(size >= n && size / 2 < n, `bracket size for ${n}`);
    assert.equal(rounds.length, Math.log2(size));
    const first = rounds[0];
    const seeds = first.flatMap((m) => [m.a, m.b]).filter((x) => x !== null).sort((x, y) => x - y);
    assert.deepEqual(seeds, Array.from({ length: n }, (_, i) => i), `every seed once (${n})`);
    const byes = first.filter((m) => m.b === null);
    assert.equal(byes.length, size - n, `byes for ${n}`);
    assert.ok(first.every((m) => m.a !== null), 'never two byes in one match');
    // Byes go to the top seeds.
    assert.deepEqual(byes.map((m) => m.a).sort((x, y) => x - y), Array.from({ length: size - n }, (_, i) => i));
    for (let r = 1; r < rounds.length; r++) assert.equal(rounds[r].length, rounds[r - 1].length / 2);
  }
  // 6 players: the two byes meet round-one winners, not each other.
  const six = buildBracket(6);
  assert.deepEqual(six[0], [{ a: 0, b: null }, { a: 3, b: 4 }, { a: 1, b: null }, { a: 2, b: 5 }]);
  assert.equal(roundName(2, 3), 'Final');
  assert.equal(roundName(1, 3), 'Semi-final');
  assert.equal(roundName(0, 3), 'Quarter-final');
  assert.equal(roundName(0, 4), 'Round 1');
});

test('battle: setup validation — contestants, formats, options', async () => {
  const { room, req, connect, guest, song } = await setupRoom({}, { songs: ALL });
  const host = await connect('host');
  const ana = await guest('Ana');
  const S = (c) => Battle.sanitize(c, room);
  await assert.rejects(req(ana, 'game.start', { type: 'battle', config: { contestants: ['A', 'B'] } }), /not allowed/);
  assert.throws(() => S({}), /at least 2/);
  assert.throws(() => S({ contestants: ['Solo'] }), /at least 2/);
  assert.throws(() => S({ contestants: ['Bo', 'bo', ' BO '] }), /at least 2/, 'duplicate names count once');
  assert.throws(() => S({ format: 'knockout', contestants: Array.from({ length: 9 }, (_, i) => `P${i}`) }), /8 contestants/);
  assert.throws(() => S({ contestants: ['A', 'B', 'C'] }), /exactly 2/, 'a duel is for two');
  assert.throws(() => S({ contestants: [{ singerId: 'nope' }, { name: '' }, 42, null, 'A'] }), /at least 2/);
  // A typed name that matches an existing singer is that singer (Ana has a phone).
  const anaSinger = room.s.singers.find((s) => s.name === 'Ana');
  const c = S({ contestants: [{ name: 'ana' }, { singerId: anaSinger.id }, 'Bo'], format: 'bogus', voting: 'x', songMode: 'y', snippet: 45, rounds: 9, voteSeconds: 999, judgeWeight: -5, decade: 1987, songIds: [song('hello').id, 'nope', 7] });
  assert.deepEqual(c.contestants, [{ singerId: anaSinger.id }, { name: 'Bo' }]);
  assert.equal(c.format, 'duel');
  assert.equal(c.voting, 'ab');
  assert.equal(c.songMode, 'random');
  assert.equal(c.snippet, 90, 'unknown snippet length → 90 s');
  assert.equal(c.rounds, 3);
  assert.equal(c.voteSeconds, 60);
  assert.equal(c.judges, false);
  assert.equal(c.judgeWeight, 1);
  assert.equal(c.decade, 1980);
  assert.deepEqual(c.songIds, [song('hello').id]);
  assert.equal(S({ contestants: ['A', 'B'], snippet: '0' }).snippet, 0);
  assert.equal(S({ contestants: ['A', 'B'], snippet: 60 }).snippet, 60);
  assert.equal(S({ contestants: ['A', 'B'], judges: 'yes' }).judges, false, 'only a real true turns judges on');
  const sc = S({ format: 'showcase', voting: 'ab', rounds: 3, contestants: ['A', 'B', 'C'] });
  assert.equal(sc.voting, 'score', 'a showcase always scores');
  assert.equal(sc.rounds, 1);
  // Names without letters stay apart (they would all fold to the same empty key).
  const emoji = S({ contestants: ['🎤', '🎸'] });
  assert.equal(emoji.contestants.length, 2);
  // Typed names become singers when the battle starts.
  await req(host, 'game.start', { type: 'battle', config: { contestants: ['Ana', 'Newbie'] } });
  assert.ok(room.s.singers.some((s) => s.name === 'Newbie'));
  assert.equal(room.s.singers.filter((s) => s.name === 'Ana').length, 1);
  const tvv = room.game.view({ role: 'tv' });
  assert.equal(tvv.phase, 'vs');
  assert.equal(tvv.showSongs, true);
  assert.deepEqual(tvv.contestants.map((x) => x.name), ['Ana', 'Newbie']);
  await req(host, 'game.close');
  await req(host, 'game.start', { type: 'battle', config: { contestants: ['🎤', '🎸'] } });
  assert.deepEqual(room.game.view({ role: 'tv' }).contestants.map((x) => x.name), ['🎤', '🎸']);
  assert.notEqual(room.game.contestants[0].singerId, room.game.contestants[1].singerId);
});

test('battle: A/B duel — VS → performances (60 s snippets) → vote → result; the room never auto-advances', async () => {
  const ctx = await party(['Ana', 'Ben', 'Cy', 'Di'], { playback: { countdown: 0, autoStart: true, ratingAfterSong: true } });
  const { req, act, s, room, view, g, tv, host } = ctx;
  await req(host, 'queue.add', { songId: ctx.song('waterloo').id, singerName: 'Queued' });
  await req(host, 'player.stop');
  assert.equal(s().current, null);
  await ctx.start({ contestants: ['Ana', 'Ben'], snippet: 60, voteSeconds: 30 });
  let v = view(tv).game;
  assert.equal(v.phase, 'vs');
  assert.equal(v.match.label, 'Head to head');
  assert.deepEqual(v.match.order, ['a', 'b']);
  assert.ok(v.match.perfs.a.songId && v.match.perfs.b.songId, 'random songs are drawn for both');
  assert.notEqual(v.match.perfs.a.songId, v.match.perfs.b.songId);
  await assert.rejects(req(g.Cy, 'game.input', { pick: 'a' }), /closed/);
  await assert.rejects(req(host, 'player.play'), /game is using the TV/);

  // Performance A: a 60 s snippet; the TV fades out at clipEnd, the server's safety net ends it.
  await act('start');
  const a = s().current;
  assert.equal(a.clipEnd, 60);
  assert.equal(a.source, 'game:battle');
  assert.equal(room.singer(a.singerIds[0]).name, 'Ana');
  assert.equal(view(tv).current.game, room.game.id, 'the TV knows the song belongs to the battle');
  assert.equal(view(tv).game.phase, 'singing');
  await req(tv, 'tv.ready', { entryId: a.id, dur: 200 });
  assert.equal(s().player.dur, 60);
  await req(tv, 'tv.status', { entryId: a.id, pos: 30, dur: 200, playing: true });
  assert.equal(s().current.id, a.id);
  await req(tv, 'tv.status', { entryId: a.id, pos: 63.5, dur: 200, playing: true });
  assert.equal(s().current, null, 'snippet over');
  v = view(tv).game;
  assert.equal(v.phase, 'waiting');
  assert.equal(v.perf.c, 1, 'Ben is next');
  assert.equal(s().queue.length, 1, 'the queued song waits');
  assert.equal(room.rating, null, 'no star rating for battle songs');
  assert.equal(s().tonight.history[0].game, 'battle');
  assert.equal(s().tonight.history[0].skipped, false);

  // Performance B ends with tv.ended (the TV's fade-out report).
  const b = await ctx.perform();
  assert.equal(room.singer(b.singerIds[0]).name, 'Ben');
  v = view(tv).game;
  assert.equal(v.phase, 'vote');
  assert.ok(v.endsAt > Date.now());

  // Votes: contestants can't vote; one vote per device, changeable; the TV sees live bars, phones don't.
  await assert.rejects(req(g.Ana, 'game.input', { pick: 'a' }), /in this battle/);
  await assert.rejects(req(g.Ben, 'game.input', { pick: 'b' }), /in this battle/);
  assert.equal(view(g.Ana).game.canVote, false);
  assert.equal(view(g.Ana).game.me, 0);
  assert.equal(view(g.Cy).game.canVote, true);
  assert.equal(view(g.Cy).game.me, -1);
  await assert.rejects(req(g.Cy, 'game.input', { pick: 'c' }), /Pick one/);
  await assert.rejects(req(g.Cy, 'game.input', { score: 5 }), /Pick one/);
  await req(g.Cy, 'game.input', { pick: 'a' });
  await req(g.Di, 'game.input', { pick: 'a' });
  await req(g.Di, 'game.input', { pick: 'b' }); // changed their mind
  const diAgain = await ctx.connect('guest', { token: g.Di.welcome.token }); // a second tab on the same phone
  await req(diAgain, 'game.input', { pick: 'b' });
  const nameless = await ctx.connect('guest');
  await assert.rejects(req(nameless, 'game.input', { pick: 'a' }), /name/);
  assert.deepEqual(view(tv).game.match.votes, { a: 1, b: 1 });
  assert.equal(view(g.Cy).game.match.votes, undefined, 'phones don’t see the split before the result');
  assert.equal(view(g.Cy).game.match.voters, 2);
  assert.equal(view(g.Di).game.myPick, 'b');
  await req(g.Cy, 'game.input', { pick: 'b' });
  await act('close');
  v = view(tv).game;
  assert.equal(v.phase, 'result');
  assert.equal(v.match.winner, 1);
  assert.deepEqual(v.match.points, { a: 0, b: 2 });
  assert.equal(v.match.lot, false);
  assert.deepEqual(view(g.Cy).game.match.votes, { a: 0, b: 2 }, 'revealed with the result');
  await assert.rejects(req(g.Di, 'game.input', { pick: 'a' }), /closed/);

  // One round: the result leads to the final podium, then the game ends and the party carries on.
  await act('next');
  v = view(tv).game;
  assert.equal(v.phase, 'final');
  assert.equal(v.champion, 1);
  assert.deepEqual(v.ranking.map((r) => r.c), [1, 0]);
  assert.equal(s().current, null, 'nothing starts while the podium is on');
  await act('next');
  assert.equal(room.game.phase, 'done');
  assert.deepEqual(s().tonight.games.at(-1).winners, ['Ben']);
  assert.equal(s().tonight.games.at(-1).title, 'Battle winner');
  assert.equal(s().tonight.games.at(-1).type, 'battle');
  assert.equal(s().current?.title, 'Waterloo', 'the battle is over: the queue carries on');
  assert.equal(view(tv).game.phase, 'done', 'results stay until the host closes them');
  await req(host, 'game.close');
  assert.equal(view(tv).game, null);
});

test('battle: duel best of three — alternating order, stops at 2–0; two rounds at 1–1 go to total votes', async () => {
  const ctx = await party(['Ana', 'Ben', 'Cy', 'Di', 'Ed']);
  const { act, view, tv, req, g } = ctx;
  await ctx.start({ contestants: ['Ana', 'Ben'], rounds: 3, songMode: 'same', snippet: 0 });
  let v = view(tv).game;
  assert.equal(v.match.label, 'Round 1 of 3');
  assert.equal(v.match.perfs.a.songId, v.match.perfs.b.songId, 'same song for both');
  const round = async (picks) => {
    await ctx.perform();
    await ctx.perform();
    for (const [n, pick] of Object.entries(picks)) await req(g[n], 'game.input', { pick });
    await act('close');
    return view(tv).game;
  };
  const firstSong = v.match.perfs.a.songId;
  v = await round({ Cy: 'a', Di: 'a' });
  assert.equal(v.match.winner, 0);
  assert.deepEqual(v.wins, [1, 0]);
  await act('next');
  v = view(tv).game;
  assert.equal(v.phase, 'vs');
  assert.equal(v.match.label, 'Round 2 of 3');
  assert.deepEqual(v.match.order, ['b', 'a'], 'Ben opens round 2');
  assert.equal(v.match.perfs.a.songId, v.match.perfs.b.songId);
  assert.notEqual(v.match.perfs.a.songId, firstSong, 'a new song each round');
  await act('start');
  assert.equal(ctx.room.singer(ctx.s().current.singerIds[0]).name, 'Ben');
  await req(tv, 'tv.ended', { entryId: ctx.s().current.id });
  await ctx.perform();
  await req(g.Cy, 'game.input', { pick: 'a' });
  await act('close');
  await act('next');
  v = view(tv).game;
  assert.equal(v.phase, 'final', 'best of three is over at 2–0');
  assert.equal(v.matches.length, 2);
  assert.equal(v.champion, 0);
  assert.deepEqual(v.ranking[0], { c: 0, place: 1, wins: 2, points: 3 });

  // Two rounds, 1–1: total votes decide.
  const two = await party(['Ana', 'Ben', 'Cy', 'Di', 'Ed']);
  await two.start({ contestants: ['Ana', 'Ben'], rounds: 2 });
  const vote = async (picks) => {
    await two.perform();
    await two.perform();
    for (const [n, pick] of Object.entries(picks)) await two.req(two.g[n], 'game.input', { pick });
    await two.act('close');
    await two.act('next');
  };
  await vote({ Cy: 'a', Di: 'a', Ed: 'a' }); // Ana 3–0
  await vote({ Cy: 'b', Di: 'b' }); // Ben 2–0
  const w = two.view(two.tv).game;
  assert.equal(w.phase, 'final');
  assert.deepEqual(w.wins, [1, 1]);
  assert.equal(w.champion, 0, 'Ana has more votes in total');
  assert.equal(w.finalLot, false);
});

test('battle: ties are decided by lot and shown as such', async () => {
  const winners = new Set();
  for (let i = 0; i < 12 && winners.size < 2; i++) {
    const ctx = await party([]);
    await ctx.start({ contestants: ['Ana', 'Ben'] });
    await ctx.perform();
    await ctx.perform();
    await ctx.act('close'); // nobody voted: 0–0
    const v = ctx.view(ctx.tv).game;
    assert.equal(v.match.lot, true);
    assert.ok([0, 1].includes(v.match.winner));
    winners.add(v.match.winner);
    await ctx.act('next');
    assert.equal(ctx.view(ctx.tv).game.finalLot, true);
    ctx.room.game.dispose();
  }
  assert.equal(winners.size, 2, 'both sides can win a draw');
});

test('battle: knockout with byes — 5 singers, a random draw, the bracket fills up to a champion', async () => {
  const ctx = await party(['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Fay']);
  const { act, view, tv, req, g, room } = ctx;
  await ctx.start({ format: 'knockout', contestants: ['Ana', 'Ben', 'Cy', 'Di', 'Ed'], songMode: 'pick' });
  let v = view(tv).game;
  assert.equal(v.roundCount, 3);
  assert.equal(v.matches.length, 7);
  const byes = v.matches.filter((m) => m.bye);
  assert.equal(byes.length, 3);
  assert.ok(byes.every((m) => m.decided && m.winner === m.a && m.b === -1));
  const semis = v.matches.filter((m) => m.round === 1);
  assert.equal(semis.filter((m) => m.a >= 0 && m.b >= 0).length, 1, 'two bye winners meet in a semi-final');
  assert.equal(v.match.round, 0, 'the only real quarter-final is up first');
  assert.equal(v.match.label, 'Quarter-final');
  assert.equal(v.match.perfs.a.songId, null, '"pick": no song yet');
  // The host picks a song (search) and a random one.
  await act('song', { perfId: v.match.perfs.a.id, songId: ctx.song('hello').id });
  await act('song', { perfId: v.match.perfs.b.id, random: true });
  v = view(tv).game;
  assert.equal(v.match.perfs.a.title, 'Hello');
  assert.ok(v.match.perfs.b.songId);
  await assert.rejects(act('song', { perfId: v.match.perfs.a.id, songId: 'nope' }), /not found/);
  await assert.rejects(act('song', { perfId: 'nope', songId: ctx.song('hello').id }), /not waiting/);
  const played = [];
  // Plays every remaining match: side A always wins with one vote from a non-contestant.
  for (let guard = 0; guard < 8 && view(tv).game.phase !== 'final'; guard++) {
    v = view(tv).game;
    const m = v.match;
    played.push(m.label);
    assert.ok(m.a >= 0 && m.b >= 0, 'both singers of the match are known');
    const first = await ctx.perform();
    if (m.round === 0) assert.equal(first.title, 'Hello', 'the host’s pick is sung');
    await ctx.perform();
    const voter = Object.values(g).find((c) => room.game.view({ role: 'guest', deviceId: c.data.deviceId }).canVote);
    await req(voter, 'game.input', { pick: 'a' });
    await act('close');
    assert.equal(view(tv).game.match.winner, m.a);
    await act('next');
  }
  v = view(tv).game;
  assert.deepEqual(played, ['Quarter-final', 'Semi-final 1', 'Semi-final 2', 'Final']);
  assert.equal(v.phase, 'final');
  const final = v.matches.at(-1);
  assert.equal(v.champion, final.winner);
  assert.equal(v.ranking[0].note, 'Champion');
  assert.equal(v.ranking[1].note, 'Runner-up');
  assert.deepEqual(v.ranking.map((r) => r.place), [1, 2, 3, 3, 5]);
  assert.deepEqual(v.ranking.slice(2, 4).map((r) => r.note), ['Semi-final', 'Semi-final']);
});

test('battle: knockout with 3 — one bye; singers not in the match may vote, the two in it may not', async () => {
  const ctx = await party(['Ana', 'Ben', 'Cy', 'Di']);
  const { view, tv, req, g, room } = ctx;
  await ctx.start({ format: 'knockout', contestants: ['Ana', 'Ben', 'Cy'] });
  const v = view(tv).game;
  assert.equal(v.matches.length, 3);
  assert.equal(v.matches.filter((m) => m.bye).length, 1);
  assert.equal(v.match.label, 'Semi-final');
  const inMatch = [v.match.a, v.match.b].map((i) => v.contestants[i].name);
  const out = v.contestants.find((c) => !inMatch.includes(c.name)).name;
  await ctx.perform();
  await ctx.perform();
  await assert.rejects(req(g[inMatch[0]], 'game.input', { pick: 'a' }), /in this battle/);
  await req(g[out], 'game.input', { pick: 'b' });
  await req(g.Di, 'game.input', { pick: 'b' });
  await ctx.act('close');
  assert.equal(room.game.match().winner, v.match.b);
});

test('battle: showcase — everyone sings once, phones score 1–10, highest average wins; contestants don’t vote', async () => {
  const ctx = await party(['Ana', 'Ben', 'Cy', 'Di', 'Ed']);
  const { act, view, tv, req, g, room } = ctx;
  await ctx.start({ format: 'showcase', contestants: ['Ana', 'Ben', 'Cy'], songMode: 'same', voteSeconds: 20 });
  let v = view(tv).game;
  assert.equal(v.voting, 'score');
  assert.equal(v.match, null);
  assert.equal(v.perfs.length, 3);
  assert.equal(new Set(v.perfs.map((p) => p.songId)).size, 1, 'everyone sings the same song');
  assert.equal(v.next.id, v.perfs[0].id);
  const scores = { 0: [9, 8], 1: [4, 5], 2: [7, 7] }; // by singing order
  const order = v.perfs.map((p) => p.c);
  for (let k = 0; k < 3; k++) {
    await ctx.perform();
    v = view(tv).game;
    assert.equal(v.phase, 'score');
    assert.equal(v.perf.c, order[k]);
    await assert.rejects(req(g.Ana, 'game.input', { score: 10 }), /in this battle/, 'contestants don’t score in a showcase');
    await assert.rejects(req(g.Di, 'game.input', { score: 11 }), /1 to 10/);
    await assert.rejects(req(g.Di, 'game.input', { score: 5.5 }), /1 to 10/);
    await assert.rejects(req(g.Di, 'game.input', { pick: 'a' }), /1 to 10/);
    await req(g.Di, 'game.input', { score: 1 });
    await req(g.Di, 'game.input', { score: scores[k][0] }); // changed
    await req(g.Ed, 'game.input', { score: scores[k][1] });
    assert.equal(view(g.Di).game.myScore, scores[k][0]);
    assert.equal(view(tv).game.perf.score, undefined, 'no average on the TV before the vote closes');
    assert.equal(view(tv).game.perf.votes, 2);
    assert.equal(view(ctx.host).game.perf.score, (scores[k][0] + scores[k][1]) / 2, 'the host sees it live');
    if (k === 0) {
      await assert.rejects(act('song', { perfId: v.perfs[1].id, random: true }), /same song/, 'the song is fixed once someone sang it');
    }
    await act('close');
    assert.equal(view(tv).game.perfs[k].score, (scores[k][0] + scores[k][1]) / 2, 'revealed after the vote');
  }
  v = view(tv).game;
  assert.equal(v.phase, 'final');
  assert.equal(v.champion, order[0]);
  assert.deepEqual(v.ranking.map((r) => r.score), [8.5, 7, 4.5]);
  assert.deepEqual(v.ranking.map((r) => r.c), [order[0], order[2], order[1]]);
  room.game.end();
  assert.deepEqual(ctx.s().tonight.games.at(-1).winners, [ctx.name(order[0])]);
});

test('battle: judges — worth N votes in A/B, N scores in averages; only for sung performances, until the result', async () => {
  const ctx = await party(['Ana', 'Ben', 'Cy']);
  const { act, view, tv, req, g } = ctx;
  await ctx.start({ contestants: ['Ana', 'Ben'], judges: true, judgeWeight: 3 });
  let v = view(ctx.host).game;
  await assert.rejects(act('judge', { perfId: v.match.perfs.a.id, score: 8 }), /once it has been sung/);
  await ctx.perform();
  v = view(ctx.host).game;
  await assert.rejects(act('judge', { perfId: v.match.perfs.a.id, score: 11 }), /1 to 10/);
  await assert.rejects(act('judge', { perfId: v.match.perfs.a.id, score: '9' }), /1 to 10/);
  await act('judge', { perfId: v.match.perfs.a.id, score: 9 });
  await ctx.perform();
  await act('judge', { perfId: v.match.perfs.b.id, score: 6 });
  assert.equal(view(ctx.host).game.match.perfs.a.judge, 9);
  assert.equal(view(tv).game.match.perfs.a.judge, undefined, 'judges’ marks stay secret until the result');
  assert.equal(view(ctx.host).game.match.judged, 'a');
  await req(g.Cy, 'game.input', { pick: 'b' }); // 1 phone vote for Ben vs the judges' 3 for Ana
  await act('close');
  v = view(tv).game;
  assert.deepEqual(v.match.points, { a: 3, b: 1 });
  assert.equal(v.match.winner, 0);
  assert.equal(v.match.judged, 'a');
  assert.equal(v.match.perfs.b.judge, 6);
  await assert.rejects(act('judge', { perfId: v.match.perfs.a.id, score: 1 }), /final/);

  // Score voting: the judges' score counts judgeWeight times in the average.
  const sc = await party(['Ana', 'Ben', 'Cy']);
  await sc.start({ contestants: ['Ana', 'Ben'], voting: 'score', judges: true, judgeWeight: 2 });
  await sc.perform();
  let w = sc.view(sc.host).game;
  assert.equal(w.phase, 'score');
  await sc.req(sc.g.Cy, 'game.input', { score: 4 });
  await sc.act('judge', { perfId: w.perf.id, score: 10 });
  assert.equal(sc.view(sc.host).game.perf.score, 8, '(4 + 10 + 10) / 3');
  await sc.act('close');
  assert.equal(sc.view(sc.tv).game.phase, 'waiting');
  await sc.perform();
  await sc.req(sc.g.Cy, 'game.input', { score: 9 });
  await sc.act('close');
  w = sc.view(sc.tv).game;
  assert.equal(w.phase, 'result');
  assert.deepEqual(w.match.points, { a: 8, b: 9 }, 'unjudged performance: phone scores only');
  assert.equal(w.match.winner, 1);

  // Judges off: no judging.
  const off = await party([]);
  await off.start({ contestants: ['Ana', 'Ben'] });
  await off.perform();
  await assert.rejects(off.act('judge', { perfId: off.room.game.perfs[0].id, score: 5 }), /Judges are off/);
});

test('battle: skipping — a skipped performance loses by walkover; skipping mid-song stops it', async () => {
  const ctx = await party(['Cy']);
  const { act, view, tv, s, room } = ctx;
  await ctx.start({ contestants: ['Ana', 'Ben'] });
  await act('skip'); // from the intro: Ana doesn't sing
  let v = view(tv).game;
  assert.equal(v.phase, 'waiting');
  assert.equal(v.match.perfs.a.status, 'skipped');
  assert.equal(v.perf.c, 1);
  await ctx.perform();
  v = view(tv).game;
  assert.equal(v.phase, 'result', 'no vote needed');
  assert.equal(v.match.winner, 1);
  assert.equal(v.match.walkover, true);

  // Mid-song: the song stops (history: skipped), no votes for it, the other one wins.
  const two = await party(['Cy']);
  await two.start({ contestants: ['Ana', 'Ben'], voting: 'score' });
  await two.perform();
  await two.req(two.g.Cy, 'game.input', { score: 2 });
  await two.act('close');
  await two.act('start');
  const cur = two.s().current;
  await two.req(two.tv, 'tv.ready', { entryId: cur.id, dur: 200 });
  await two.act('skip');
  assert.equal(two.s().current, null);
  assert.equal(two.s().tonight.history[0].skipped, true);
  const w = two.view(two.tv).game;
  assert.equal(w.phase, 'result', 'skipped performances get no score vote');
  assert.equal(w.match.winner, 0);
  assert.equal(w.match.walkover, true);
  await assert.rejects(two.act('skip'), /no performance to skip/);
  // Next on the player bar ends a performance early — voting still happens.
  const three = await party([]);
  await three.start({ contestants: ['Ana', 'Ben'] });
  await three.act('start');
  await three.req(three.host, 'player.next');
  assert.equal(three.s().current, null);
  assert.equal(three.view(three.tv).game.phase, 'waiting');
  assert.equal(three.room.game.perfs[0].status, 'done');
  assert.equal(room.game.phase, 'result');
});

test('battle: a song stopped from the player can be sung again; stale battle songs never reach the queue', async () => {
  const ctx = await party([], { playback: { countdown: 0, autoStart: true } });
  const { act, view, tv, s, req, host } = ctx;
  await ctx.start({ contestants: ['Ana', 'Ben'] });
  await act('start');
  const first = s().current;
  await req(host, 'player.stop');
  assert.equal(s().current, null);
  assert.equal(s().queue[0].id, first.id, 'Stop put it back in the queue');
  assert.equal(view(host).game.stalled, true);
  assert.equal(view(tv).game.phase, 'singing');
  await act('start'); // sing it again
  assert.ok(s().current);
  assert.notEqual(s().current.id, first.id);
  assert.equal(s().queue.length, 0, 'the stopped copy is gone');
  assert.equal(view(host).game.stalled, false);
  await req(host, 'player.stop');
  await req(host, 'game.end');
  assert.equal(s().queue.length, 0, 'ending the battle drops its stopped songs');
  assert.equal(s().tonight.games.length, 0, 'no winner when the battle ends early');
});

test('battle: auto mode starts performances by itself; failures wait for the host', async () => {
  const ctx = await party([]);
  const { room, s } = ctx;
  await ctx.start({ contestants: ['Ana', 'Ben'], auto: true });
  const game = room.game;
  game.setPhase('vs', 0.03, () => game.toWaiting());
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(game.phase, 'waiting');
  assert.ok(game.phaseEndsAt > Date.now(), 'the next performance counts down');
  game.autoStart();
  assert.equal(game.phase, 'singing');
  assert.ok(s().current);
  await ctx.req(ctx.tv, 'tv.ended', { entryId: s().current.id });
  // The song disappears from the library: the auto start fails, the host sees why.
  game.perf().songId = 'gone';
  const random = game.randomSong;
  game.randomSong = () => null;
  game.autoStart();
  game.randomSong = random;
  assert.equal(game.phase, 'waiting');
  assert.equal(game.phaseEndsAt, 0);
  assert.match(ctx.view(ctx.host).game.error, /No song/);
});

test('battle: controls are phase-checked; unknown actions and guests’ attempts are refused', async () => {
  const ctx = await party(['Cy']);
  const { act, req, g } = ctx;
  await ctx.start({ contestants: ['Ana', 'Ben'] });
  await assert.rejects(act('nope'), /Unknown battle control/);
  await assert.rejects(act('judge', { perfId: 'x', score: 3 }), /Judges are off/);
  await assert.rejects(req(g.Cy, 'game.action', { action: 'start' }), /not allowed/);
  await act('start');
  await assert.rejects(act('start'), /can’t start right now/);
  await assert.rejects(act('next'), /Nothing to move on/);
  await assert.rejects(act('close'), /Nothing to move on/);
  await assert.rejects(req(g.Cy, 'game.input', { pick: 'a' }), /closed/);
  await act('end');
  assert.equal(ctx.room.game.phase, 'done');
  await assert.rejects(act('start'), /No game/);
  // The song that was on keeps playing; the party carries on from there.
  assert.ok(ctx.s().current);
});

test('battle: another song can’t start during a performance — “Play now” and Play are refused, nothing is lost', async () => {
  const ctx = await party(['Cy'], { playback: { countdown: 0, autoStart: true } });
  const { act, req, s, room, host, tv } = ctx;
  await req(host, 'queue.add', { songId: ctx.song('waterloo').id, singerName: 'Queued' });
  await req(host, 'player.stop');
  await ctx.start({ contestants: ['Ana', 'Ben'], auto: true });
  await act('start');
  const a = s().current;
  await req(tv, 'tv.ready', { entryId: a.id, dur: 200 });
  const queued = s().queue[0];
  await assert.rejects(req(host, 'queue.add', { songId: ctx.song('hello').id, singerName: 'Bo', position: 'now' }), /game is using the TV/);
  await assert.rejects(req(host, 'player.play', { entryId: queued.id }), /game is using the TV/);
  room.profileOf(ctx.g.Cy.data.deviceId).coHost = true;
  await assert.rejects(req(ctx.g.Cy, 'player.play', { entryId: queued.id }), /game is using the TV/, 'a co-host neither');
  assert.equal(s().current.id, a.id, 'the performance goes on');
  assert.equal(room.game.perfs[0].status, 'singing');
  assert.deepEqual(s().queue.map((e) => e.title), ['Waterloo'], 'the queue is untouched');
  assert.deepEqual(await req(host, 'player.play', { entryId: a.id }), { state: 'playing' }, 'the battle song itself can be resumed');
  // Safety net: if a non-game song were on when the next performance starts, it goes back to the queue.
  await req(tv, 'tv.ended', { entryId: a.id });
  room.game.clearTimers();
  room.startEntry(s().queue.shift());
  const host1 = s().current;
  room.game.autoStart();
  assert.equal(s().current.source, 'game:battle');
  assert.equal(s().queue[0].id, host1.id, 'back at the top of the queue, not thrown away');
  assert.equal(s().tonight.history.filter((h) => h.title === host1.title).length, 0, 'and not in the history as skipped');
});

test('battle: ended on the deciding result screen → the winner is kept; nobody sang → no winner', async () => {
  const ctx = await party(['Cy', 'Di']);
  const { act, req, view, tv, s, g } = ctx;
  await ctx.start({ contestants: ['Ana', 'Bo'] });
  await ctx.perform();
  await ctx.perform();
  await req(g.Cy, 'game.input', { pick: 'b' });
  await req(g.Di, 'game.input', { pick: 'b' });
  await act('close');
  assert.equal(view(tv).game.phase, 'result');
  await req(ctx.host, 'game.end'); // "End game" while the TV says "Bo wins!"
  let v = view(tv).game;
  assert.equal(v.phase, 'done');
  assert.equal(v.champion, 1);
  assert.deepEqual(v.ranking.map((r) => r.c), [1, 0]);
  assert.deepEqual(s().tonight.games.at(-1).winners, ['Bo']);

  // Best of three, ended at 1–0 on the result screen: not decided yet → no winner.
  const three = await party(['Cy']);
  await three.start({ contestants: ['Ana', 'Bo'], rounds: 3 });
  await three.perform();
  await three.perform();
  await three.req(three.g.Cy, 'game.input', { pick: 'a' });
  await three.act('close');
  await three.req(three.host, 'game.end');
  assert.equal(three.view(three.tv).game.champion, -1);
  assert.equal(three.s().tonight.games.length, 0);

  // A showcase where every performance is skipped: nobody wins.
  const sc = await party([]);
  await sc.start({ format: 'showcase', contestants: ['Ana', 'Bo', 'Cy'] });
  for (let i = 0; i < 3; i++) await sc.act('skip');
  v = sc.view(sc.tv).game;
  assert.equal(v.phase, 'final');
  assert.equal(v.champion, -1);
  assert.equal(v.finalLot, false);
  sc.room.game.end();
  assert.equal(sc.s().tonight.games.length, 0, 'no "Battle winner" in the recap');

  // A duel where both skip: the match is drawn by lot, but nobody is the battle's champion.
  const duel = await party([]);
  await duel.start({ contestants: ['Ana', 'Bo'] });
  await duel.act('skip');
  await duel.act('skip');
  assert.equal(duel.view(duel.tv).game.phase, 'result');
  await duel.act('next');
  assert.equal(duel.view(duel.tv).game.champion, -1);
  duel.room.game.end();
  assert.equal(duel.s().tonight.games.length, 0);
});

test('battle: a banned guest’s votes stop counting', async () => {
  const ctx = await party(['Cy', 'Troll', 'Ed']);
  const { act, req, view, tv, g } = ctx;
  await ctx.start({ contestants: ['Ana', 'Bo'] });
  await ctx.perform();
  await ctx.perform();
  await req(g.Cy, 'game.input', { pick: 'a' });
  await req(g.Troll, 'game.input', { pick: 'b' });
  await req(g.Ed, 'game.input', { pick: 'b' });
  assert.deepEqual(view(tv).game.match.votes, { a: 1, b: 2 });
  await req(ctx.host, 'guest.ban', { deviceId: g.Troll.data.deviceId });
  assert.deepEqual(view(tv).game.match.votes, { a: 1, b: 1 });
  assert.equal(view(tv).game.match.voters, 2);
  await act('close');
  assert.deepEqual(view(tv).game.match.points, { a: 1, b: 1 }, 'a tie without the troll');

  // Score voting: the average leaves the banned guest's score out.
  const sc = await party(['Cy', 'Troll']);
  await sc.start({ format: 'showcase', contestants: ['Ana', 'Bo'] });
  await sc.perform();
  await sc.req(sc.g.Cy, 'game.input', { score: 8 });
  await sc.req(sc.g.Troll, 'game.input', { score: 1 });
  assert.equal(sc.view(sc.host).game.perf.score, 4.5);
  await sc.req(sc.host, 'guest.ban', { deviceId: sc.g.Troll.data.deviceId });
  assert.equal(sc.view(sc.host).game.perf.score, 8);
  assert.equal(sc.view(sc.tv).game.perf.votes, 1);
});

test('battle: a double click on “Close voting now” or “Continue” never skips the result screen', async () => {
  const ctx = await party(['Cy']);
  const { req, view, tv, host } = ctx;
  await ctx.start({ format: 'knockout', contestants: ['Ana', 'Bo', 'Cy', 'Di'] });
  await ctx.perform();
  await ctx.perform();
  const twice = async (action) => {
    const step = view(host).game.step;
    return Promise.all([0, 1].map(() => req(host, 'game.action', { action, step })));
  };
  let [a, b] = await twice('close');
  assert.equal(b.stale, true);
  assert.ok(a.winner >= 0);
  assert.equal(view(tv).game.phase, 'result', 'the result is on the TV');
  [a, b] = await twice('next');
  assert.equal(b.stale, true);
  assert.equal(view(tv).game.phase, 'vs', 'the next match’s intro, not further');
  // Without a step, "close" outside a vote is refused instead of moving on.
  await ctx.perform();
  await ctx.perform();
  await ctx.act('close');
  await assert.rejects(ctx.act('close'), /Nothing to move on/);
  assert.equal(view(tv).game.phase, 'result');
});
