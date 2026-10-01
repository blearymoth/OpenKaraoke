// Music quiz (server/games/quiz.js, shared/quiz.js): question generation, distractors,
// scoring and streaks, answer validation, the phase flow with its timers, view privacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, SONGS, MORE_SONGS } from './room-harness.js';
import { Quiz, QUIZ_TIMING, decadeChoices } from '../server/games/quiz.js';
import { QUIZ_ROUNDS, QUIZ_ROUND_INFO, QUIZ_STREAK_BONUS, quizPoints } from '../shared/quiz.js';
import { fold } from '../shared/text.js';
import { writeTree } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [...SONGS, ...MORE_SONGS];
const YEARS = {
  Hello: 2015, 'Bohemian Rhapsody': 1975, 'Killer Queen': 1974, 'Call Me': 1980, Waterloo: 1974, Rapture: 1981,
  'Dancing Queen': 1976, 'Mamma Mia': 1975, Africa: 1982, 'Don\'t Stop Believin\'': 1981, 'I Wanna Dance With Somebody': 1987,
  'Livin\' On A Prayer': 1986, 'Girls Just Want To Have Fun': 1983, 'Don\'t Go Breaking My Heart': 1976, Wonderwall: 1995,
  Wannabe: 1996, 'I Will Survive': 1978, 'Eye Of The Tiger': 1982,
};

/** Room with the big song list; `meta: true` gives every song a year, genre and cover. */
async function quizRoom({ meta = false, settings = {}, songs = ALL } = {}) {
  const r = await setupRoom(settings, { songs });
  const cat = r.app.library.catalog;
  if (meta) {
    const byKey = new Map(cat.songList.map((s) => [s.key, { year: YEARS[s.title] || 1990, genre: YEARS[s.title] < 1980 ? 'Disco' : 'Pop', cover: `${s.id}.jpg` }]));
    cat.metaFor = (key) => byKey.get(key) || null;
  }
  return r;
}

/** Runs the quiz through the question phase without timers (the harness TV reports the clip). */
async function openQuestion(room, req, tv) {
  const g = room.game;
  if (g.phase === 'get-ready') g.ask();
  if (tv) await req(tv, 'tv.game', { event: 'clip', q: g.qi });
  else g.open();
  assert.equal(g.phase, 'question');
  assert.equal(g.opened, true);
}

const songChoice = (g) => g.current().answer;
const wrongChoice = (g) => (g.current().answer + 1) % g.current().choices.length;

test('quiz: config is sanitised (question count, seconds, round types)', async () => {
  const { room } = await quizRoom();
  const c = Quiz.sanitize({ questions: 99, seconds: 3, rounds: ['intro', 'bogus', '__proto__', 'year', 'intro'], popular: 'yes', decade: 'x' }, room);
  assert.equal(c.questions, 30);
  assert.equal(c.seconds, 10);
  assert.deepEqual(c.rounds, ['intro', 'year']);
  assert.equal(c.popular, false, 'only a real true turns it on');
  assert.equal(c.decade, 0);
  const d = Quiz.sanitize({}, room);
  assert.equal(d.questions, 10);
  assert.equal(d.seconds, 20);
  assert.deepEqual(d.rounds, QUIZ_ROUNDS);
  assert.deepEqual(Quiz.sanitize({ rounds: [] }, room).rounds, QUIZ_ROUNDS, 'no round type picked → all of them');
  assert.equal(Quiz.sanitize({ questions: 2, seconds: 45 }, room).questions, 5);
  assert.equal(Quiz.sanitize({ questions: 2, seconds: 45 }, room).seconds, 30);
});

test('quiz: scoring — 500 + 500·(1 − t/T), clamped; streak bonus constant', () => {
  assert.equal(quizPoints(0, 20), 1000);
  assert.equal(quizPoints(10_000, 20), 750);
  assert.equal(quizPoints(20_000, 20), 500);
  assert.equal(quizPoints(99_000, 20), 500, 'late answers never score less than 500');
  assert.equal(quizPoints(-50, 20), 1000);
  assert.equal(quizPoints(5_000, 10), 750);
  assert.equal(quizPoints('x', 20), 1000);
  assert.equal(QUIZ_STREAK_BONUS, 100);
});

test('quiz: decade answers are four consecutive decades around the right one, 1950s…this decade', () => {
  for (let i = 0; i < 50; i++) {
    for (const d of [1950, 1970, 1990, 2010, 2020]) {
      const { choices, answer } = decadeChoices(d, 2026);
      const values = choices.map((c) => c.value);
      assert.equal(values[answer], d);
      assert.equal(choices[answer].text, `${d}s`);
      assert.deepEqual(values, [values[0], values[0] + 10, values[0] + 20, values[0] + 30]);
      assert.ok(values[0] >= 1950 && values[3] <= 2020, `${values} for ${d}`);
    }
  }
  const old = decadeChoices(1930, 2026);
  assert.equal(old.choices[old.answer].value, 1930, 'very old songs still get their decade');
  const seen = new Set();
  for (let i = 0; i < 80; i++) seen.add(decadeChoices(1980, 2026).answer);
  assert.equal(seen.size, 4, 'the right decade can be any of the four tiles');
});

test('quiz: questions — every enabled round type is used, four unique answers, the right one among them', async () => {
  const { req, connect, room, app } = await quizRoom({ meta: true });
  const host = await connect('host');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 18 } });
  const g = room.game;
  const cat = app.library.catalog;
  assert.equal(g.questions.length, 18);
  const types = g.questions.map((q) => q.type);
  assert.deepEqual(new Set(types), new Set(QUIZ_ROUNDS), 'all nine round types take turns');
  for (let i = 1; i < types.length; i++) assert.notEqual(types[i], types[i - 1], 'no round type twice in a row');
  assert.equal(new Set(g.questions.map((q) => q.songId)).size, 18, 'no song twice');
  const answers = new Set();
  for (const q of g.questions) {
    const song = cat.song(q.songId);
    const info = QUIZ_ROUND_INFO[q.type];
    assert.equal(q.choices.length, 4);
    assert.ok(q.answer >= 0 && q.answer < 4);
    answers.add(q.answer);
    const texts = q.choices.map((c) => fold(c.text));
    assert.equal(new Set(texts).size, 4, `unique answers: ${texts}`);
    if (info.ask === 'song') {
      assert.equal(q.choices[q.answer].text, song.title);
      assert.equal(q.choices[q.answer].sub, song.artist);
    } else if (info.ask === 'artist') {
      assert.equal(q.choices[q.answer].text, song.artist);
      const artistKeys = q.choices.map((c) => cat.songList.find((s) => s.artist === c.text).artistKeys).flat();
      assert.equal(new Set(artistKeys).size, artistKeys.length, 'artists never repeat (not even in a duet credit)');
    } else {
      assert.equal(q.choices[q.answer].text, `${Math.floor(YEARS[song.title] / 10) * 10}s`);
      assert.deepEqual(q.hint, { title: song.title, artist: song.artist }, 'year rounds name the song');
    }
    // Clip descriptors
    const c = q.clip;
    const track = cat.track(c.trackId || c.reveal?.trackId);
    if (q.type === 'lyrics') {
      assert.equal(c.kind, 'lyrics');
      assert.equal(track.kind, 'cdg');
      assert.equal(c.cdg, `/media/${track.id}/cdg`);
      assert.deepEqual([c.from, c.to], [0.3, 0.7]);
    } else if (q.type === 'cover') {
      assert.equal(c.kind, 'cover');
      assert.match(c.art, new RegExp(`^/api/art/song/${q.songId}\\?`));
      assert.ok(c.zoom.x >= 25 && c.zoom.x <= 75);
    } else {
      assert.equal(c.kind, 'audio');
      assert.equal(c.url, `/media/${track.id}/audio`);
      assert.equal(track.songId, q.songId);
      assert.ok(c.start >= 0 && c.start + c.dur <= track.duration, `${c.start}+${c.dur} within ${track.duration}`);
      assert.equal(c.semitones, q.type === 'helium' ? 7 : 0);
      assert.equal(c.rate, q.type === 'slowmo' ? 0.7 : 1);
      assert.equal(c.reverse, q.type === 'reverse');
      if (q.type === 'intro') {
        assert.equal(c.start, 0);
        assert.equal(c.skipSilence, true);
      } else {
        assert.ok(c.start >= track.duration * 0.3 - 0.1 && c.start + c.dur <= track.duration * 0.6 + 0.1, `snippet from 30–60 %: ${c.start}`);
      }
      assert.ok(c.dur <= 12);
    }
  }
  assert.ok(answers.size >= 3, 'the right answer moves around');
  await req(host, 'game.close');
});

test('quiz: rounds a song can’t support are skipped — no covers/years without metadata, no videos for audio', async () => {
  const { req, connect, room } = await quizRoom();
  const host = await connect('host');
  await assert.rejects(req(host, 'game.start', { type: 'quiz', config: { rounds: ['cover', 'year'] } }), /Not enough songs for these round types/);
  assert.equal(room.game, null, 'a failed start leaves no game behind');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 12, rounds: ['cover', 'year', 'lyrics', 'helium'] } });
  const types = new Set(room.game.questions.map((q) => q.type));
  assert.deepEqual(types, new Set(['lyrics', 'helium']), 'cover and year rounds need artwork / years');
  assert.equal(room.game.questions.length, 12);
  await req(host, 'game.close');

  // A library of videos only has nothing the quiz can cut clips or lyrics from.
  const vids = await setupRoom({}, { songs: [] });
  const lib = vids.app.library.paths[0];
  await writeTree(lib, Object.fromEntries(['A - One', 'B - Two', 'C - Three', 'D - Four', 'E - Five'].map((n) => [`${n} [SF Karaoke].mp4`, 100])));
  await vids.app.library.scan();
  assert.equal(vids.app.library.catalog.songs.size, 5);
  const h = await vids.connect('host');
  await assert.rejects(vids.req(h, 'game.start', { type: 'quiz', config: { rounds: ['intro', 'lyrics', 'artist'] } }), /Not enough songs for these round types/);
});

test('quiz: filters and the explicit filter limit the songs; too few songs → a clear error', async () => {
  const { req, connect, room, app } = await quizRoom({ settings: { queue: { explicitFilter: true } } });
  const host = await connect('host');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 30 } });
  const cat = app.library.catalog;
  const used = room.game.questions.map((q) => cat.song(q.songId));
  assert.ok(used.every((s) => !cat.isExplicit(s)), 'Killer Queen (explicit only) is never asked');
  assert.ok(room.game.questions.length >= 3 && room.game.questions.length <= 30);
  for (const q of room.game.questions) {
    if (q.clip.trackId) assert.ok(!cat.track(q.clip.trackId).p.flags.explicit, 'clean versions only');
  }
  await req(host, 'game.close');
  await assert.rejects(req(host, 'game.start', { type: 'quiz', config: { tag: 'No Such Tag' } }), /Not enough songs for a quiz/);
  const small = await quizRoom({ songs: SONGS.slice(0, 3) });
  const h2 = await small.connect('host');
  await assert.rejects(small.req(h2, 'game.start', { type: 'quiz' }), /needs at least four songs/);
});

test('quiz: views — phones and the TV never see the answer before the reveal; only the TV gets the clip', async () => {
  const { req, connect, guest, room, view } = await quizRoom({ meta: true });
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5, rounds: ['snippet', 'helium'] } });
  const g = room.game;
  const q = g.current();

  // get-ready: the TV preloads the clip (and the next one); phones only know the round type.
  const tvReady = view(tv).game;
  assert.equal(tvReady.phase, 'get-ready');
  assert.equal(tvReady.clip.q, 0);
  assert.equal(tvReady.clip.url, q.clip.url);
  assert.equal(tvReady.preload.q, 1);
  assert.equal(tvReady.choices, undefined, 'answers only appear with the question');
  const anaReady = view(ana).game;
  assert.equal(anaReady.round.type, q.type);
  assert.equal(anaReady.clip, undefined);
  assert.equal(anaReady.preload, undefined);

  await openQuestion(room, req, tv);
  for (const [who, v] of [['guest', view(ana).game], ['tv', view(tv).game], ['host', view(host).game]]) {
    assert.equal(v.phase, 'question');
    assert.equal(v.choices.length, 4, who);
    assert.equal(v.reveal, undefined, `${who}: no reveal yet`);
    assert.equal(v.answer, undefined);
    const json = JSON.stringify(v);
    assert.ok(!json.includes(q.songId), `${who}: the song id would give the answer away`);
    if (who !== 'tv') {
      assert.ok(!json.includes(q.clip.trackId), `${who}: no clip`);
      assert.ok(!json.includes('/media/'), `${who}: no media URLs`);
    }
    for (const c of v.choices) assert.deepEqual(Object.keys(c).sort(), ['sub', 'text']);
  }
  assert.equal(view(tv).game.clip.semitones, q.clip.semitones);
  assert.ok(view(tv).game.clip.url.startsWith('/media/'));

  // Answering doesn't say whether it was right, and scores don't move before the reveal.
  const r = await req(ana, 'game.input', { q: 0, choice: wrongChoice(g) });
  assert.deepEqual(r, { choice: wrongChoice(g) });
  assert.equal(view(ana).game.me.choice, wrongChoice(g));
  assert.equal(view(ana).game.me.result, null);
  assert.equal(view(host).game.leaderboard[0].score, 0, 'scores only change at the reveal');
  assert.equal(view(tv).game.answered, 1);

  g.close();
  const rv = view(ana).game;
  assert.equal(rv.phase, 'reveal');
  assert.equal(rv.reveal.answer, q.answer);
  assert.equal(rv.reveal.song.songId, q.songId);
  assert.deepEqual(rv.me.result, { correct: false, answered: true, points: 0, bonus: 0 });
  assert.equal(rv.clip, undefined);
  assert.equal(view(tv).game.clip.q, 0, 'the TV keeps the clip for the answer music');
  const leaderboard = view(tv).game.leaderboard;
  assert.equal(leaderboard, undefined, 'the TV shows the leaderboard only in its own phase');
  assert.ok(!JSON.stringify(view(tv).game).includes(ana.data.deviceId), 'no device ids on the TV');
  for (const row of view(host).game.leaderboard) assert.equal(row.deviceId, undefined, 'no device ids in rows');
  await req(host, 'game.close');
});

test('quiz: answer validation — first answer counts, late / early / invalid / unknown players are refused', async () => {
  const { req, connect, guest, room, app } = await quizRoom();
  const host = await connect('host');
  await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const nameless = await connect('guest');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5, seconds: 10 } });
  const g = room.game;
  await assert.rejects(req(ana, 'game.input', { q: 0, choice: 0 }), /closed/, 'not during get-ready');
  g.ask();
  await assert.rejects(req(ana, 'game.input', { q: 0, choice: 0 }), /Wait for the question/, 'not before the clip starts');
  g.open();
  await assert.rejects(req(nameless, 'game.input', { q: 0, choice: 0 }), /name/);
  for (const bad of [4, -1, 1.5, '1', null, undefined]) {
    await assert.rejects(req(ana, 'game.input', { q: 0, choice: bad }), /Pick one/, `choice ${bad}`);
  }
  await assert.rejects(req(ana, 'game.input', { q: 1, choice: 0 }), /closed/, 'an answer for another question');
  await assert.rejects(req(ana, 'game.input', { q: '0', choice: 0 }), /closed/);
  await req(ana, 'game.input', { q: 0, choice: 2 });
  await assert.rejects(req(ana, 'game.input', { q: 0, choice: 3 }), /already answered/, 'no changing');
  assert.equal(g.answers.get(ana.data.deviceId).choice, 2);
  // The clock ran out (the timer hasn't fired yet): too late.
  g.openedAt = Date.now() - 10_000 - QUIZ_TIMING.graceMs - 50;
  await assert.rejects(req(ben, 'game.input', { q: 0, choice: 1 }), /time is up/);
  g.close();
  await assert.rejects(req(ben, 'game.input', { q: 0, choice: 1 }), /closed/, 'after the reveal');
  // Banned guests and games switched off.
  app.room.s.profiles[ben.data.deviceId].banned = true;
  g.afterReveal();
  g.ask();
  g.open();
  await assert.rejects(req(ben, 'game.input', { q: 1, choice: 1 }), /removed/);
  app.settings.update({ guests: { games: false } });
  await assert.rejects(req(ana, 'game.input', { q: 1, choice: 1 }), /turned off games/);
  // Only hosts control it; guests can't report TV events.
  await assert.rejects(req(ana, 'game.action', { action: 'next' }), /not allowed/);
  await assert.rejects(req(ana, 'tv.game', { event: 'clip', q: 1 }), /not allowed/);
  await assert.rejects(req(host, 'game.action', { action: 'explode' }), /Unknown quiz control/);
  await req(host, 'game.close');
});

test('quiz: scoring and streaks through a whole game (fast right answers, streak bonus, misses reset it)', async () => {
  const { req, connect, guest, room, view, s } = await quizRoom();
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const cy = await guest('Cy');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5, seconds: 20 } });
  const g = room.game;
  const answer = async (c, pick, ms) => {
    await req(c, 'game.input', { q: g.qi, choice: pick === 'right' ? songChoice(g) : wrongChoice(g) });
    g.answers.get(c.data.deviceId).ms = ms; // pretend the answer came `ms` after the question opened
  };

  // Q1: Ana right at 0 s (1000), Ben right at 10 s (750), Cy wrong.
  await openQuestion(room, req, tv);
  await answer(ana, 'right', 0);
  await answer(ben, 'right', 10_000);
  await answer(cy, 'wrong', 1000);
  g.close();
  let rv = view(tv).game.reveal;
  assert.equal(rv.rightCount, 2);
  assert.deepEqual(rv.right.map((p) => [p.name, p.points]), [['Ana', 1000], ['Ben', 750]], 'fastest first');
  assert.equal(rv.counts.reduce((a, b) => a + b, 0), 3);
  assert.equal(rv.counts[g.current().answer], 2);
  assert.deepEqual(view(cy).game.me.result, { correct: false, answered: true, points: 0, bonus: 0 });
  assert.equal(view(ana).game.me.rank, 1);
  assert.equal(view(cy).game.me.rank, 3);

  // Q2: Ana right again at 20 s → 500 + 100 streak bonus; Ben misses it (no answer) → streak lost.
  g.afterReveal();
  await openQuestion(room, req, tv);
  await answer(ana, 'right', 20_000);
  await answer(cy, 'right', 5_000);
  g.close();
  assert.deepEqual(view(ana).game.me.result, { correct: true, answered: true, points: 600, bonus: 100 });
  assert.equal(view(ana).game.me.streak, 2);
  assert.deepEqual(view(ben).game.me.result, { correct: false, answered: false, points: 0, bonus: 0 });
  assert.equal(view(ben).game.me.streak, 0);
  assert.equal(view(cy).game.me.result.points, 875, 'Cy: right after a wrong answer, no bonus');

  // Q3 → leaderboard (every 3 questions).
  g.afterReveal();
  await openQuestion(room, req, tv);
  await answer(ben, 'right', 0);
  g.close();
  assert.equal(view(ben).game.me.result.bonus, 0, 'Ben missed Q2: his streak starts again');
  assert.equal(view(ana).game.me.streak, 0, 'no answer resets the streak');
  g.afterReveal();
  assert.equal(g.phase, 'leaderboard');
  const board = view(tv).game.leaderboard;
  assert.deepEqual(board.map((r) => [r.name, r.score]), [['Ana', 1600], ['Ben', 1750], ['Cy', 875]].sort((a, b) => b[1] - a[1]));
  assert.equal(board[0].delta, 1000, 'Ben scored 1000 on the last question');
  assert.equal(view(ben).game.me.rank, 1);
  assert.deepEqual(view(ben).game.leaderboard.map((r) => r.name), ['Ben', 'Ana', 'Cy']);

  // Q4, Q5 → final → end: the champion is remembered for the recap.
  g.nextQuestion();
  await openQuestion(room, req, tv);
  g.close();
  g.afterReveal();
  assert.equal(g.phase, 'get-ready', 'no leaderboard after question 4');
  await openQuestion(room, req, tv);
  await answer(ana, 'right', 0);
  g.close();
  g.afterReveal();
  assert.equal(g.phase, 'final');
  const fin = view(tv).game;
  assert.equal(fin.leaderboard[0].name, 'Ana');
  assert.equal(fin.leaderboard[0].score, 2600);
  assert.equal(fin.clip, undefined);
  g.end();
  assert.equal(view(host).game.phase, 'done');
  assert.deepEqual(s().tonight.games.at(-1), { ...s().tonight.games.at(-1), type: 'quiz', title: 'Quiz champion', winners: ['Ana'] });
  assert.equal(view(ana).game.me.rank, 1);
  await req(host, 'game.close');
});

test('quiz: timers — get-ready → wait for the TV clip (fallback) → timed question → reveal → leaderboard → final → done', async () => {
  const saved = { ...QUIZ_TIMING };
  // get-ready 50 ms, clip wait 250 ms, reveal/leaderboard 150 ms (wide margins for busy machines)
  Object.assign(QUIZ_TIMING, { firstReady: 0.05, ready: 0.05, clipWait: 0.25, reveal: 0.15, leaderboard: 0.15, final: 0.05, earlyCloseMs: 10 });
  try {
    const { req, connect, guest, room, s, view } = await quizRoom({ settings: { playback: { autoStart: true, countdown: 0 } } });
    const host = await connect('host');
    const tv = await connect('tv');
    await guest('Ana');
    await req(host, 'game.start', { type: 'quiz', config: { questions: 5, seconds: 10 } });
    const g = room.game;
    assert.equal(g.phase, 'get-ready');
    assert.equal(view(tv).game.phaseSeconds, 0.05);
    await sleep(130); // get-ready ends at 50 ms, the fallback would open at 300 ms
    assert.equal(g.phase, 'question');
    assert.equal(g.opened, false, 'waiting for the TV to start the clip');
    assert.equal(view(tv).game.open, false);
    assert.equal(view(tv).game.endsAt, 0);
    // A report for another question changes nothing; the right one opens it.
    await req(tv, 'tv.game', { event: 'clip', q: 3 });
    await req(tv, 'tv.game', { event: 'clip' });
    assert.equal(g.opened, false);
    await req(tv, 'tv.game', { event: 'clip', q: 0 });
    assert.equal(g.opened, true);
    const v = view(tv).game;
    assert.ok(v.open && v.endsAt > Date.now() + 9000 && v.endsAt <= Date.now() + 10_050, 'the answer timer starts with the clip');

    // Next question: the TV never reports → the question opens after the fallback wait.
    g.close(); // reveal until 150 ms, get-ready until 200 ms, fallback at 450 ms
    await sleep(280);
    assert.equal(g.qi, 1);
    assert.equal(g.phase, 'question');
    assert.equal(g.opened, false);
    await sleep(280);
    assert.equal(g.opened, true, 'a silent TV doesn’t block the quiz');

    // A TV error also opens it (and tells the host).
    g.close();
    await sleep(280);
    assert.equal(g.qi, 2);
    assert.equal(g.phase, 'question');
    assert.equal(g.opened, false);
    await req(tv, 'tv.game', { event: 'error', q: 2, error: 'Could not load the song (HTTP 404)' });
    assert.equal(g.opened, true);
    assert.match(view(host).game.clipError, /HTTP 404/);

    // The question timer closes it; after question 3 comes the leaderboard.
    g.setPhase('question', 0.05, () => g.close());
    await sleep(120);
    assert.equal(g.phase, 'reveal');
    await sleep(150);
    assert.equal(g.phase, 'leaderboard');
    assert.equal(s().current, null, 'nothing starts while the quiz owns the TV');
    // Skip to the end with the host control; the final timer ends the game.
    await req(host, 'game.action', { action: 'final' });
    assert.equal(g.phase, 'final');
    await sleep(150);
    assert.equal(g.phase, 'done');
    assert.equal(g.ended, true);
    await req(host, 'game.close');
  } finally {
    Object.assign(QUIZ_TIMING, saved);
  }
});

test('quiz: the question closes early once everyone connected has answered', async () => {
  const saved = { ...QUIZ_TIMING };
  Object.assign(QUIZ_TIMING, { earlyCloseMs: 20 });
  try {
    const { req, connect, guest, room, leave, view } = await quizRoom();
    const host = await connect('host');
    const tv = await connect('tv');
    const ana = await guest('Ana');
    const ben = await guest('Ben');
    const cy = await guest('Cy');
    await connect('guest'); // no name yet: not expected to answer
    await req(host, 'game.start', { type: 'quiz', config: { questions: 5, seconds: 30 } });
    const g = room.game;
    await openQuestion(room, req, tv);
    assert.equal(view(ana).game.expected, 3);
    leave(cy); // Cy's phone went to sleep
    await req(ana, 'game.input', { q: 0, choice: 0 });
    await sleep(40);
    assert.equal(g.phase, 'question', 'Ben hasn’t answered yet');
    await req(ben, 'game.input', { q: 0, choice: 1 });
    assert.equal(g.phase, 'question', 'a short pause to show "locked in"');
    await sleep(60);
    assert.equal(g.phase, 'reveal');
    await req(host, 'game.close');
  } finally {
    Object.assign(QUIZ_TIMING, saved);
  }
});

test('quiz: host controls skip through every phase; no main TV → questions open at once; ending early keeps the results', async () => {
  const { req, connect, guest, room, view, s } = await quizRoom();
  const host = await connect('host');
  const ana = await guest('Ana');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5 } });
  const g = room.game;
  const next = async (phase) => {
    const r = await req(host, 'game.action', { action: 'next' });
    assert.equal(r.phase, phase);
  };
  await next('question');
  assert.equal(g.opened, true, 'without a TV nobody reports the clip');
  await req(ana, 'game.input', { q: 0, choice: songChoice(g) });
  await next('reveal');
  assert.equal(view(ana).game.me.result.correct, true);
  await next('get-ready');
  await next('question');
  await next('reveal');
  await next('get-ready');
  await next('question');
  await next('reveal');
  await next('leaderboard');
  await next('get-ready');
  assert.equal(g.qi, 3);
  // A mirror display can't open questions.
  const tv1 = await connect('tv');
  const mirror = await connect('tv');
  assert.equal(mirror.data.display, 'mirror');
  g.ask();
  const r = await req(mirror, 'tv.game', { event: 'clip', q: 3 });
  assert.equal(r.ok, false);
  assert.equal(g.opened, false);
  await req(tv1, 'tv.game', { event: 'clip', q: 3 });
  assert.equal(g.opened, true);
  await req(host, 'game.end');
  assert.equal(g.phase, 'done');
  assert.equal(view(ana).game.leaderboard[0].name, 'Ana', 'the final standings stay up');
  assert.equal(s().tonight.games.at(-1).winners[0], 'Ana');
  await assert.rejects(req(ana, 'game.input', { q: 3, choice: 0 }), /No game/);
  await req(host, 'game.close');
  assert.equal(view(ana).game, null);
});

test('quiz: nobody played → no champion in the recap', async () => {
  const { req, connect, room, s } = await quizRoom();
  const host = await connect('host');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5 } });
  assert.equal(room.game.summary(), null);
  await req(host, 'game.end');
  assert.equal(s().tonight.games.length, 0);
});

test('quiz: distractors prefer the same decade and genre when metadata is known', async () => {
  const { req, connect, room, app } = await quizRoom({ meta: true });
  const host = await connect('host');
  const cat = app.library.catalog;
  let same = 0;
  let total = 0;
  for (let round = 0; round < 6; round++) {
    await req(host, 'game.start', { type: 'quiz', config: { questions: 10, rounds: ['snippet'] } });
    for (const q of room.game.questions) {
      const decade = Math.floor(cat.metaFor(q.key).year / 10);
      for (const [i, c] of q.choices.entries()) {
        if (i === q.answer) continue;
        const s = cat.songList.find((x) => x.title === c.text && x.artist === c.sub);
        total++;
        if (Math.floor(cat.metaFor(s.key).year / 10) === decade) same++;
      }
    }
    await req(host, 'game.close');
  }
  // 18 songs: 6–7 per decade, so random picks would share the decade ~1/3 of the time.
  assert.ok(same / total > 0.55, `same decade ${same}/${total}`);
});

test('quiz: an answer still on its way when the countdown hits 0 counts (grace window), later ones don’t', async () => {
  const { req, connect, guest, room, view } = await quizRoom();
  const host = await connect('host');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  await guest('Cy'); // never answers, so the question doesn't close early
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5, seconds: 10 } });
  const saved = QUIZ_TIMING.graceMs;
  QUIZ_TIMING.graceMs = 800; // (wider than the real 400 ms: room for a busy test machine)
  try {
    const g = room.game;
    g.config.seconds = 0.2; // a 200 ms question (the real minimum is 10 s)
    g.ask(); // no TV: opens at once
    assert.equal(g.opened, true);
    assert.ok(view(ana).game.endsAt <= Date.now() + 200, 'the countdown still shows the real deadline');
    await sleep(260); // past the countdown, inside the grace window
    assert.equal(g.phase, 'question', 'still open for answers in flight');
    await req(ana, 'game.input', { q: 0, choice: songChoice(g) });
    await sleep(1000);
    assert.equal(g.phase, 'reveal', 'the timer closes it after the grace window');
    await assert.rejects(req(ben, 'game.input', { q: 0, choice: songChoice(g) }), /closed/);
    assert.deepEqual(view(ana).game.me.result, { correct: true, answered: true, points: 500, bonus: 0 }, 'late but right: the minimum points');
  } finally {
    QUIZ_TIMING.graceMs = saved;
  }
  await req(host, 'game.close');
});

test('quiz: ties share the win, nobody wins with 0 points — TV, phones and recap agree', async () => {
  const { req, connect, guest, room, view, s } = await quizRoom();
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const cy = await guest('Cy');
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5 } });
  const g = room.game;
  // Everyone answers wrong: no champion.
  await openQuestion(room, req, tv);
  for (const c of [ana, ben]) await req(c, 'game.input', { q: 0, choice: wrongChoice(g) });
  g.close();
  g.final();
  assert.deepEqual(view(tv).game.winners, []);
  assert.equal(view(ana).game.me.rank, 1);
  assert.equal(view(ana).game.me.tied, true);
  assert.equal(g.summary(), null);
  await req(host, 'game.close');

  // Ana and Ben tie at the top, Cy is third.
  await req(host, 'game.start', { type: 'quiz', config: { questions: 5 } });
  const q = room.game;
  await openQuestion(room, req, tv);
  for (const c of [ana, ben]) {
    await req(c, 'game.input', { q: 0, choice: songChoice(q) });
    q.answers.get(c.data.deviceId).ms = 0;
  }
  await req(cy, 'game.input', { q: 0, choice: wrongChoice(q) });
  q.close();
  q.final();
  assert.deepEqual(view(tv).game.winners, ['Ana', 'Ben']);
  assert.deepEqual(view(ben).game.winners, ['Ana', 'Ben']);
  assert.equal(view(ana).game.me.rank, 1);
  assert.equal(view(ben).game.me.rank, 1);
  assert.equal(view(ben).game.me.tied, true);
  assert.equal(view(cy).game.me.rank, 3);
  assert.equal(view(cy).game.me.tied, false);
  assert.deepEqual(view(tv).game.leaderboard.map((r) => r.place), [1, 1, 3], 'the leaderboard shows the shared place');
  q.end();
  assert.deepEqual(s().tonight.games.at(-1).winners, ['Ana', 'Ben'], 'both are in the recap');
  assert.equal(s().tonight.games.at(-1).title, 'Quiz champions');
  assert.deepEqual(view(tv).game.winners, ['Ana', 'Ben'], 'still shown after the end');
});
