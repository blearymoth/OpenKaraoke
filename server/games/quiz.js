// Music quiz (PLAN §13.1, KaraFun-quiz / blind-test style). The TV plays a short clip (intro,
// snippet, helium, slow-mo, backwards…), shows a lyrics screen or a zooming cover; phones answer
// on four Kahoot tiles; fast right answers score more, streaks earn a bonus.
//
// Phases: get-ready (question N of M, the TV preloads) → question (waits for the TV to report
// that the clip started, then the answer timer runs) → reveal → every 3 questions a
// leaderboard → … → final (podium) → end().
//
// Privacy: phones and the TV never get the right answer before the reveal; the clip (track,
// URLs, positions) is only in the TV view; scores change only when a question closes.
import { Game, decadeIn, fail, intIn, newId, randomInt, shuffle } from './base.js';
import { mediaUrls } from '../http/media.js';
import { fold } from '../../shared/text.js';
import {
  QUIZ_ROUNDS, QUIZ_ROUND_INFO, QUIZ_QUESTIONS, QUIZ_SECONDS, QUIZ_STREAK_BONUS, QUIZ_LEADERBOARD_EVERY, quizPoints,
} from '../../shared/quiz.js';

const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Phase lengths (seconds). */
export const QUIZ_TIMING = {
  firstReady: 5, // the first "get ready" also gives the TV time to decode the first clip
  ready: 3,
  clipWait: 4, // how long a question waits for the TV to start the clip before opening anyway
  reveal: 6,
  leaderboard: 6,
  final: 15,
  earlyCloseMs: 900, // everyone answered: a moment to see "locked in" before the reveal
  graceMs: 400, // answers in flight when the timer ran out still count
};

const AUDIO_ROUNDS = new Set(['intro', 'snippet', 'artist', 'helium', 'slowmo', 'reverse', 'year']);
const MIN_SONGS = 4; // four answers per question
const MIN_QUESTIONS = 3; // fewer than asked is fine (small library, rare round types), but not less than this

const decadeOf = (year) => Math.floor(year / 10) * 10;
/** Folded title without "(Live)", "[Remix]"…: "Hello" and "Hello (Radio Edit)" count as the same title. */
const baseTitle = (title) => fold(String(title).replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')) || fold(title);
const unit = () => randomInt(1_000_000) / 1_000_000;

export class Quiz extends Game {
  static type = 'quiz';
  static label = 'Music quiz';
  static exclusive = true;

  static sanitize(c) {
    const rounds = Array.isArray(c.rounds) ? QUIZ_ROUNDS.filter((r) => c.rounds.includes(r)) : [];
    return {
      questions: intIn(c.questions, QUIZ_QUESTIONS.min, QUIZ_QUESTIONS.max, QUIZ_QUESTIONS.def),
      seconds: intIn(c.seconds, QUIZ_SECONDS.min, QUIZ_SECONDS.max, QUIZ_SECONDS.def),
      rounds: rounds.length ? rounds : [...QUIZ_ROUNDS],
      tag: str(c.tag),
      genre: str(c.genre),
      decade: decadeIn(c.decade),
      popular: c.popular === true,
    };
  }

  start() {
    this.buildPool();
    this.questions = this.generate();
    const poolSize = this.pool.length;
    this.pool = this.rankOf = this.supportCache = this.trackCache = null; // only needed to make the questions
    if (this.questions.length < MIN_QUESTIONS) {
      const c = this.config;
      const filtered = !!(c.tag || c.genre || c.decade || c.popular);
      if (poolSize < MIN_SONGS) fail(filtered ? 'Not enough songs for a quiz — try it without filters.' : 'The quiz needs at least four songs in the library.', 'empty');
      fail(`Not enough songs for these round types — enable more rounds${filtered ? ' or remove the filters' : ''}.`, 'empty');
    }
    this.players = new Map(); // deviceId → { pid, score, streak, best, correct, answered, order, last }
    this.answers = new Map(); // deviceId → { choice, ms } for the current question
    this.qi = -1;
    this.opened = false;
    this.openedAt = 0;
    this.clipError = null;
    this.closing = false;
    this.nextQuestion();
  }

  // ---- question generation -------------------------------------------------------------------

  /** Songs the quiz may use, most popular first (so neighbours have a similar popularity). */
  buildPool() {
    const c = this.config;
    const cat = this.catalog;
    const filter = { minDuration: 20, maxDuration: 900 }; // no jingles
    if (c.tag) filter.tag = c.tag;
    if (c.genre) filter.genre = c.genre;
    if (c.decade) filter.decade = c.decade;
    if (this.settings.get('queue.explicitFilter')) filter.noExplicit = true;
    const pop = new Map();
    let pool = [];
    for (const s of cat.songList) {
      if (s.flags?.medley || !cat._passes(s, filter)) continue;
      pool.push(s);
      pop.set(s.id, cat.popularity(s));
    }
    pool.sort((a, b) => pop.get(b.id) - pop.get(a.id));
    if (c.popular) pool = pool.slice(0, Math.max(150, c.questions * 8));
    this.pool = pool;
    this.rankOf = new Map(pool.map((s, i) => [s.id, i]));
    this.supportCache = new Map();
  }

  /**
   * N questions with the enabled round types taking turns: always one of the least used types
   * (random among equals), never the same type twice in a row when there is a choice. Types
   * that no song supports (no artwork, no years…) drop out and the others fill in.
   */
  generate() {
    const want = Math.min(this.config.questions, this.pool.length);
    const alive = new Set(this.config.rounds);
    const count = new Map();
    const used = new Set();
    const out = [];
    if (this.pool.length < MIN_SONGS) return out;
    let prev = null;
    while (out.length < want && alive.size) {
      const weight = (t) => (count.get(t) || 0) + (t === prev ? 0.5 : 0);
      const type = shuffle([...alive]).sort((a, b) => weight(a) - weight(b))[0];
      const q = this.pickQuestion(type, used);
      if (!q) {
        alive.delete(type);
        continue;
      }
      used.add(q.songId);
      count.set(type, (count.get(type) || 0) + 1);
      prev = type;
      q.index = out.length;
      out.push(q);
    }
    return out;
  }

  /** A question of `type` about a song not used yet (popular songs are more likely), or null. */
  pickQuestion(type, used) {
    const pool = this.pool;
    const skew = !this.config.popular && pool.length > 200;
    for (let tries = 0; tries < 40; tries++) {
      const u = unit();
      const s = pool[Math.min(pool.length - 1, Math.floor((skew ? u ** 3 : u) * pool.length))];
      if (used.has(s.id) || !this.supports(type, s)) continue;
      const q = this.makeQuestion(type, s);
      if (q) return q;
    }
    // Rare round types (years, covers) or a nearly used-up pool: look through every song.
    const list = this.supporting(type).filter((s) => !used.has(s.id));
    for (const s of shuffle(list).slice(0, 25)) {
      const q = this.makeQuestion(type, s);
      if (q) return q;
    }
    return null;
  }

  supporting(type) {
    if (!this.supportCache.has(type)) this.supportCache.set(type, this.pool.filter((s) => this.supports(type, s)));
    return this.supportCache.get(type);
  }

  /** Whether a song can be used for a round type (the TV needs audio, a CDG, a cover or a year). */
  supports(type, song) {
    const meta = this.catalog.metaFor(song.key);
    if (type === 'cover') return !!meta?.cover;
    if (type === 'year' && !(meta?.year >= 1900)) return false;
    if (type === 'artist' && (!song.artist || /^various( artists)?$/i.test(song.artist))) return false;
    if (type === 'lyrics') return !!this.cdgTrack(song);
    return AUDIO_ROUNDS.has(type) && !!this.audioTrack(song);
  }

  /** The version to play: the room's usual pick when it has separate audio, else any audio version. */
  audioTrack(song) {
    if (!this.trackCache) this.trackCache = new Map();
    if (!this.trackCache.has(song.id)) this.trackCache.set(song.id, this.findAudioTrack(song));
    return this.trackCache.get(song.id);
  }

  findAudioTrack(song) {
    const noExplicit = !!this.settings.get('queue.explicitFilter');
    const ok = (t) => !!t && t.songId === song.id && hasAudio(t) && !(noExplicit && t.p?.flags?.explicit);
    const best = this.room.pickTrack(song, { noExplicit });
    if (ok(best)) return best;
    for (const id of song.trackIds) {
      const t = this.catalog.track(id);
      if (ok(t) && !t.p?.flags?.vocals) return t;
    }
    return song.trackIds.map((id) => this.catalog.track(id)).find(ok) || null;
  }

  /** A CD+G version (lyrics rounds draw one of its screens). */
  cdgTrack(song) {
    const best = this.audioTrack(song);
    if (best && hasCdg(best)) return best;
    const noExplicit = !!this.settings.get('queue.explicitFilter');
    return song.trackIds.map((id) => this.catalog.track(id)).find((t) => t && hasCdg(t) && !(noExplicit && t.p?.flags?.explicit)) || null;
  }

  makeQuestion(type, song) {
    const info = QUIZ_ROUND_INFO[type];
    const meta = this.catalog.metaFor(song.key);
    let choices;
    let answer;
    if (info.ask === 'decade') {
      ({ choices, answer } = decadeChoices(decadeOf(meta.year)));
    } else {
      const others = this.distractors(song, info.ask === 'artist');
      if (others.length < 3) return null;
      const all = shuffle([song, ...others]);
      answer = all.indexOf(song);
      choices = all.map((s) => (info.ask === 'artist' ? { text: s.artist } : { text: s.title, sub: s.artist }));
    }
    const track = type === 'lyrics' ? this.cdgTrack(song) : this.audioTrack(song);
    const q = {
      type, songId: song.id, key: song.key, title: song.title, artist: song.artist,
      year: meta?.year || 0, choices, answer,
      clip: this.clipFor(type, song, track),
    };
    if (type === 'year') q.hint = { title: song.title, artist: song.artist };
    return q;
  }

  /**
   * Three wrong answers that sound plausible: songs with a similar popularity (neighbours in the
   * sorted pool) plus a random sample, preferring the same decade/genre when metadata is known.
   * Titles are never duplicated; artist questions never repeat an artist.
   */
  distractors(song, byArtist) {
    const pool = this.pool;
    const cat = this.catalog;
    const at = this.rankOf.get(song.id) ?? 0;
    const meta = cat.metaFor(song.key);
    const decade = meta?.year ? decadeOf(meta.year) : 0;
    const genre = meta?.genre || '';
    const WINDOW = 60;
    const cand = new Map();
    for (let i = Math.max(0, at - WINDOW); i < Math.min(pool.length, at + WINDOW + 1); i++) cand.set(pool[i].id, pool[i]);
    for (let k = 0; k < 120 && cand.size < pool.length; k++) {
      const s = pool[randomInt(pool.length)];
      cand.set(s.id, s);
    }
    cand.delete(song.id);
    const scored = [...cand.values()].map((s) => {
      let score = unit() * 1.5; // variety
      const m = (decade || genre) ? cat.metaFor(s.key) : null;
      if (decade && m?.year && decadeOf(m.year) === decade) score += 2;
      if (genre && m?.genre === genre) score += 2;
      const rank = this.rankOf.get(s.id) ?? pool.length;
      score += 1 - Math.min(1, Math.abs(rank - at) / (WINDOW * 2));
      return [score, s];
    }).sort((a, b) => b[0] - a[0]).map((x) => x[1]);

    const pick = (strictArtist) => {
      const titles = new Set([baseTitle(song.title), fold(song.title)]);
      const artists = new Set(song.artistKeys || []);
      const artistNames = new Set([fold(song.artist)]);
      const out = [];
      for (const s of scored) {
        if (out.length === 3) break;
        const tf = fold(s.title);
        const tb = baseTitle(s.title);
        if (titles.has(tf) || titles.has(tb)) continue;
        const sameArtist = (s.artistKeys || []).some((k) => artists.has(k)) || artistNames.has(fold(s.artist));
        if (sameArtist && (byArtist || strictArtist)) continue;
        out.push(s);
        titles.add(tf).add(tb);
        for (const k of s.artistKeys || []) artists.add(k);
        artistNames.add(fold(s.artist));
      }
      return out;
    };
    const strict = pick(true);
    return strict.length === 3 || byArtist ? strict : pick(false);
  }

  /** What the TV needs to play/show the question (TV view only). */
  clipFor(type, song, track) {
    const T = this.config.seconds;
    const dur = track?.duration || song.duration || 180;
    const media = track ? mediaUrls(track) : null;
    const audio = media?.kind === 'cdg' && hasAudio(track) ? { trackId: track.id, url: media.audio } : null;
    const channel = (track && this.room.s.trackPrefs?.[track.id]?.channel) || this.settings.get('playback.defaultChannelMode') || 'stereo';
    const reveal = audio ? { ...audio, start: round1(dur * 0.35), dur: QUIZ_TIMING.reveal + 1 } : null;
    if (type === 'lyrics') {
      if (reveal) reveal.atLyrics = true; // the TV starts the answer where the lyrics screen is
      return { kind: 'lyrics', trackId: track.id, cdg: media.cdg, from: 0.3, to: 0.7, channel, reveal };
    }
    if (type === 'cover') {
      return {
        kind: 'cover', art: `/api/art/song/${encodeURIComponent(song.id)}?s=1000`, zoom: { x: 25 + randomInt(51), y: 25 + randomInt(51) },
        channel, reveal,
      };
    }
    const len = Math.min(type === 'reverse' || type === 'intro' ? 10 : 12, T);
    const clip = { kind: 'audio', ...audio, channel, start: 0, dur: len, semitones: 0, rate: 1, reverse: false };
    if (type === 'intro') {
      clip.skipSilence = true; // karaoke tracks often start with a few silent seconds
    } else {
      if (type === 'slowmo') {
        clip.rate = 0.7;
        clip.dur = round1(len * 0.7); // seconds of the song; they last `len` at 70 % speed
      }
      if (type === 'helium') clip.semitones = 7;
      if (type === 'reverse') clip.reverse = true;
      // ≈ 30–60 % into the song (away from the title screen and the ending).
      const lo = dur * 0.3;
      const hi = Math.max(lo, dur * 0.6 - clip.dur);
      clip.start = round1(Math.max(0, Math.min(lo + (hi - lo) * unit(), dur - clip.dur - 1)));
    }
    clip.reveal = { ...audio, start: clip.start, dur: QUIZ_TIMING.reveal + 1, fromClip: type === 'intro' };
    return clip;
  }

  // ---- phases ----------------------------------------------------------------------------------

  current() {
    return this.qi >= 0 ? this.questions[this.qi] || null : null;
  }

  setPhase(phase, seconds = 0, next = null) {
    this.phaseSeconds = seconds; // the countdown rings' full circle
    super.setPhase(phase, seconds, next);
  }

  nextQuestion() {
    this.qi++;
    this.answers = new Map();
    this.opened = false;
    this.openedAt = 0;
    this.clipError = null;
    this.closing = false;
    this.setPhase('get-ready', this.qi === 0 ? QUIZ_TIMING.firstReady : QUIZ_TIMING.ready, () => this.ask());
  }

  /** Shows the question; the answer timer starts when the TV reports the clip (or after a few seconds). */
  ask() {
    this.setPhase('question', 0);
    this.opened = false;
    if (!this.room.mainDisplay()) return this.open();
    this.later(QUIZ_TIMING.clipWait * 1000, () => this.open());
    return undefined;
  }

  open() {
    if (this.phase !== 'question' || this.opened) return;
    this.opened = true;
    this.openedAt = this.now();
    // The countdown shows `seconds`; the question closes a moment later, so answers that were
    // still on their way when the countdown hit 0 count (input() checks the same limit).
    this.setPhase('question', this.config.seconds);
    this.later(this.config.seconds * 1000 + QUIZ_TIMING.graceMs, () => this.close());
  }

  /** Scores the question and shows the answer. */
  close() {
    if (this.phase !== 'question') return;
    const q = this.current();
    const T = this.config.seconds;
    const counts = q.choices.map(() => 0);
    for (const [deviceId, p] of this.players) {
      const a = this.answers.get(deviceId);
      if (!a) {
        p.streak = 0;
        p.last = { q: this.qi, answered: false, correct: false, points: 0, bonus: 0 };
        continue;
      }
      counts[a.choice]++;
      p.answered++;
      const correct = a.choice === q.answer;
      let points = 0;
      let bonus = 0;
      if (correct) {
        p.streak++;
        p.correct++;
        points = quizPoints(a.ms, T);
        if (p.streak >= 2) bonus = QUIZ_STREAK_BONUS;
      } else {
        p.streak = 0;
      }
      p.best = Math.max(p.best, p.streak);
      p.score += points + bonus;
      p.last = { q: this.qi, answered: true, correct, points: points + bonus, bonus, choice: a.choice, ms: a.ms };
    }
    q.closed = true;
    q.counts = counts;
    this.setPhase('reveal', QUIZ_TIMING.reveal, () => this.afterReveal());
  }

  afterReveal() {
    if (this.qi >= this.questions.length - 1) return this.final();
    if ((this.qi + 1) % QUIZ_LEADERBOARD_EVERY === 0) return this.setPhase('leaderboard', QUIZ_TIMING.leaderboard, () => this.nextQuestion());
    return this.nextQuestion();
  }

  final() {
    if (this.phase === 'final') return;
    this.setPhase('final', QUIZ_TIMING.final, () => this.end());
  }

  /** Host: skip ahead (next), jump to the final results, or stop. */
  action(client, m) {
    if (m.action === 'end') return this.end();
    if (m.action === 'final') {
      this.final();
      return { phase: this.phase };
    }
    if (m.action !== 'next') return fail('Unknown quiz control.');
    switch (this.phase) {
      case 'get-ready': this.ask(); break;
      case 'question': if (this.opened) this.close(); else this.open(); break;
      case 'reveal': this.afterReveal(); break;
      case 'leaderboard': this.nextQuestion(); break;
      case 'final': this.end(); break;
      default: break;
    }
    return { phase: this.phase };
  }

  /** A guest's answer: { q: question index, choice: 0–3 }. The first answer counts. */
  input(client, m) {
    const deviceId = client.data.deviceId;
    const profile = this.room.profileOf(deviceId);
    if (!profile?.name) fail('Choose a name first.', 'no_profile');
    if (profile.banned) fail('The host has removed you from this party.', 'banned');
    const q = this.current();
    if (!q || m.q !== this.qi || this.phase !== 'question') fail('Too late — this question has closed.', 'closed');
    if (!this.opened) fail('Wait for the question to start.', 'not_open');
    const ms = this.now() - this.openedAt;
    if (ms > this.config.seconds * 1000 + QUIZ_TIMING.graceMs) fail('Too late — time is up.', 'closed');
    if (this.answers.has(deviceId)) fail('You already answered this one.', 'double');
    const choice = m.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) fail('Pick one of the answers.', 'bad_request');
    this.answers.set(deviceId, { choice, ms: Math.max(0, ms) });
    if (!this.players.has(deviceId)) {
      this.players.set(deviceId, { pid: newId(4), score: 0, streak: 0, best: 0, correct: 0, answered: 0, order: this.players.size, last: null });
    }
    this.maybeCloseEarly();
    return { choice }; // never whether it was right: that's for the reveal
  }

  /** Guests connected right now who could answer (named, not banned). */
  expected() {
    const ids = new Set();
    for (const c of this.room.hub.list((x) => x.role === 'guest' && x.open !== false)) {
      const p = this.room.profileOf(c.data?.deviceId);
      if (p?.name && !p.banned) ids.add(c.data.deviceId);
    }
    return ids;
  }

  /** Everyone connected has answered: close the question a moment later. */
  maybeCloseEarly() {
    if (this.closing || this.phase !== 'question') return;
    const expected = this.expected();
    if (!expected.size) return;
    for (const id of expected) if (!this.answers.has(id)) return;
    this.closing = true;
    this.later(QUIZ_TIMING.earlyCloseMs, () => this.close());
  }

  /** The main TV: { event: 'clip', q } when the clip/visual started, { event: 'error', q, error }. */
  tv(client, m) {
    if (!Number.isInteger(m.q) || m.q !== this.qi) return { ok: false };
    if (m.event === 'error') this.clipError = str(m.error, 160) || 'The TV could not play this clip.';
    if ((m.event === 'clip' || m.event === 'error') && this.phase === 'question' && !this.opened) this.open();
    return { ok: true };
  }

  // ---- results ---------------------------------------------------------------------------------

  /** Players by score (ties: whoever joined first). */
  ranking() {
    const rows = [];
    for (const [deviceId, p] of this.players) {
      const prof = this.room.profileOf(deviceId);
      rows.push({
        deviceId, id: p.pid, name: prof?.name || 'Player', emoji: prof?.emoji || '🎤', color: prof?.color || '',
        score: p.score, delta: p.last?.q === this.qi ? p.last.points : 0, correct: p.correct, streak: p.streak, best: p.best, order: p.order,
      });
    }
    return rows.sort((a, b) => b.score - a.score || a.order - b.order);
  }

  summary() {
    const top = this.ranking()[0];
    return top && top.score > 0 ? { title: 'Quiz champion', winners: [top.name] } : null;
  }

  // ---- views -------------------------------------------------------------------------------------

  view(ctx) {
    const v = super.view(ctx);
    const q = this.current();
    const phase = this.phase;
    const revealed = !!q?.closed;
    const rows = this.ranking();
    const pub = ({ deviceId, order, ...r }) => r; // eslint-disable-line no-unused-vars
    v.seconds = this.config.seconds;
    v.phaseSeconds = this.phaseSeconds || 0;
    v.total = this.questions.length;
    v.index = this.qi;
    v.open = phase === 'question' && this.opened;
    v.answered = this.answers.size;
    v.expected = this.expected().size;
    v.players = this.players.size;
    if (q && phase !== 'final' && phase !== 'done') {
      const info = QUIZ_ROUND_INFO[q.type];
      v.round = { type: q.type, label: info.label, icon: info.icon, prompt: info.prompt, ask: info.ask };
      if (phase === 'question' || phase === 'reveal') {
        v.choices = q.choices.map((c) => ({ text: c.text, sub: c.sub || '' }));
        if (q.hint) v.hint = q.hint;
      }
    }
    if (revealed && (phase === 'reveal' || phase === 'leaderboard')) {
      const right = rows.filter((r) => this.players.get(r.deviceId).last?.q === this.qi && this.players.get(r.deviceId).last.correct)
        .map((r) => ({ ...pub(r), points: this.players.get(r.deviceId).last.points, ms: this.players.get(r.deviceId).last.ms }))
        .sort((a, b) => a.ms - b.ms);
      v.reveal = {
        answer: q.answer,
        counts: q.counts,
        song: { songId: q.songId, title: q.title, artist: q.artist, year: q.year || null },
        right: right.slice(0, 8),
        rightCount: right.length,
      };
    }
    if (phase === 'leaderboard' || phase === 'final' || phase === 'done' || ctx.role === 'host') {
      v.leaderboard = rows.slice(0, 10).map(pub);
    }
    if (ctx.role === 'tv' && q && !this.ended) {
      if (['get-ready', 'question', 'reveal'].includes(phase)) v.clip = { q: this.qi, ...q.clip };
      const next = this.questions[this.qi + 1];
      if (next && phase !== 'final') v.preload = { q: this.qi + 1, ...next.clip };
    }
    if (ctx.role === 'host') {
      v.clipError = this.clipError;
      v.asked = this.config.questions; // more than `total` when the library couldn't fill the quiz
    }
    if (ctx.role === 'guest') {
      const p = this.players.get(ctx.deviceId);
      const mine = this.answers.get(ctx.deviceId);
      const rank = p ? 1 + rows.filter((r) => r.score > p.score).length : 0;
      v.me = {
        id: p?.pid || null,
        choice: mine ? mine.choice : -1,
        score: p?.score || 0,
        rank,
        streak: p?.streak || 0,
        correct: p?.correct || 0,
        // This question's result, only once it is revealed.
        result: revealed && p?.last?.q === this.qi ? { correct: p.last.correct, answered: p.last.answered, points: p.last.points, bonus: p.last.bonus } : null,
      };
    }
    return v;
  }
}

function hasAudio(t) {
  if (t.kind === 'cdg') return !!t.audio;
  if (t.kind === 'zip') return !!(t.entries?.audio && t.entries?.cdg);
  return false;
}

function hasCdg(t) {
  if (t.kind === 'cdg') return !!(t.cdg && t.audio);
  if (t.kind === 'zip') return !!(t.entries?.cdg && t.entries?.audio);
  return false;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Four consecutive decades around the right one, in chronological order (the window's position
 * is random, so the right answer can be any tile), kept between the 1950s and this decade.
 */
export function decadeChoices(decade, thisYear = new Date().getFullYear()) {
  const newest = Math.max(decade, decadeOf(thisYear));
  const oldest = Math.min(decade, 1950);
  const starts = [0, 1, 2, 3].map((k) => decade - 10 * k).filter((s) => s >= oldest && s + 30 <= newest);
  const first = starts.length ? starts[randomInt(starts.length)] : decade;
  const decades = [0, 1, 2, 3].map((k) => first + 10 * k);
  return { choices: decades.map((d) => ({ text: `${d}s`, value: d })), answer: decades.indexOf(decade) };
}
