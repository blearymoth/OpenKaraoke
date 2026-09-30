// Singing battle (PLAN §13.2): 2–8 contestants sing against each other and the room votes.
//
// Formats
//   duel      2 contestants, 1–3 rounds (a new song each round; who opens alternates). The first
//             to win a majority of the rounds wins ("best of"); 1–1 after two rounds goes to the
//             total votes/points, then to a draw by lot.
//   knockout  a random draw into a bracket (standard seeding: byes when the field isn't a power of
//             two go to the top seeds and straight into the next round), one match per pairing.
//   showcase  everyone sings once in a random order; the highest average score (1–10) wins.
// Songs: 'same' (both singers of a match sing one song — random or `songIds` from the setup; the
// host can change it until the first of them has sung), 'random' (a random song per performance
// from the filter) or 'pick' (the host chooses each song in the live controls; random if not).
// Snippets: full song, 90 s or 60 s (room.gameSing clipEnd: the TV fades out).
// Voting: 'ab' (after both performances phones pick the better one) or 'score' (phones give 1–10
// right after each performance; a showcase always scores). Contestants can't vote in their own
// match — in a showcase everybody is in the same contest, so contestants don't vote at all.
// One vote per device (it can be changed while the vote is open); guests need a name.
// Judges (optional): the host enters one 1–10 score per performance, worth `judgeWeight` votes:
// with score voting it is added to the phone scores `judgeWeight` times before averaging; with
// A/B voting the performance the judges scored higher gets `judgeWeight` extra votes (no extra
// votes when the two scores are equal or one is missing).
// Ties (and "nobody voted") are decided by lot (crypto random) and shown as such.
//
// Phases: vs (intro, 6 s) → waiting (who's next; the host starts the performance — or it starts
// after 10 s with `auto`) → singing (room.gameSing; the TV shows the normal karaoke, see
// `showSongs`; onSongEnd returns true so the room doesn't move on) → [score, after each
// performance] → … → vote (A/B, after both) → result (7 s) → vs (next match) … → final (podium,
// 12 s) → done. A skipped performance loses its match (walkover) or scores 0 in a showcase.
import { Game, decadeIn, fail, intIn, randomInt, shuffle, newId } from './base.js';
import { fold } from '../../shared/text.js';

export const FORMATS = ['duel', 'knockout', 'showcase'];
export const SONG_MODES = ['same', 'random', 'pick'];
export const VOTING = ['ab', 'score'];
export const SNIPPETS = [0, 90, 60];
export const MAX_CONTESTANTS = 8;
const VS_SECONDS = 6;
const RESULT_SECONDS = 7;
const FINAL_SECONDS = 12;
const AUTO_SECONDS = 10;
const SONG_MIN = 60; // random songs: no jingles…
const SONG_MAX = 420; // …and no 10-minute epics

const str = (v, max = 40) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const round1 = (x) => Math.round(x * 10) / 10;

/** Standard seeding order for a bracket of `size` slots (a power of two): 1 v size, … */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/**
 * A knockout bracket for `n` seeds (0 … n−1): rounds of matches { a, b } with seed indexes.
 * Round 0: `b` null = a bye (always the top seeds). Later rounds: null = winner of the feeder
 * matches 2·slot and 2·slot+1 of the previous round.
 */
export function buildBracket(n) {
  let size = 2;
  while (size < n) size *= 2;
  const seeds = seedOrder(size).map((s) => (s <= n ? s - 1 : null));
  const rounds = [[]];
  for (let i = 0; i < size; i += 2) rounds[0].push({ a: seeds[i], b: seeds[i + 1] });
  while (rounds.at(-1).length > 1) rounds.push(Array.from({ length: rounds.at(-1).length / 2 }, () => ({ a: null, b: null })));
  return rounds;
}

/** "Final", "Semi-final", "Quarter-final", "Round 1" … for knockout round `round` of `count`. */
export function roundName(round, count) {
  const fromEnd = count - 1 - round;
  return ['Final', 'Semi-final', 'Quarter-final'][fromEnd] || `Round ${round + 1}`;
}

function snippetOf(v) {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return SNIPPETS.includes(n) ? n : 90;
}

export class Battle extends Game {
  static type = 'battle';
  static label = 'Battle';
  static exclusive = true;

  static sanitize(c, room) {
    const format = oneOf(c.format, FORMATS, 'duel');
    const contestants = [];
    const seen = new Set();
    for (const x of Array.isArray(c.contestants) ? c.contestants.slice(0, 32) : []) {
      let singer = null;
      let name = '';
      if (typeof x === 'string') name = str(x);
      else if (x && typeof x === 'object') {
        if (typeof x.singerId === 'string') singer = room.singer(x.singerId);
        if (!singer) name = str(x.name);
      }
      if (!singer && !name) continue;
      // A typed name that matches an existing singer is that singer (like room.findOrCreateSinger).
      const f = fold(name) || name.toLowerCase();
      if (!singer) singer = room.s.singers.find((s) => fold(s.name) === f) || null;
      const key = singer ? singer.id : `name:${f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contestants.push(singer ? { singerId: singer.id } : { name });
    }
    if (contestants.length < 2) fail('Pick at least 2 contestants.', 'bad_request');
    if (contestants.length > MAX_CONTESTANTS) fail(`A battle has room for ${MAX_CONTESTANTS} contestants at most.`, 'bad_request');
    if (format === 'duel' && contestants.length !== 2) fail('A duel is for exactly 2 contestants — choose knockout or showcase for more.', 'bad_request');
    const decade = decadeIn(c.decade);
    return {
      contestants,
      format,
      rounds: format === 'duel' ? intIn(c.rounds, 1, 3, 1) : 1,
      songMode: oneOf(c.songMode, SONG_MODES, 'random'),
      songIds: (Array.isArray(c.songIds) ? c.songIds : []).filter((id) => typeof id === 'string' && room.catalog.song(id)).slice(0, 8),
      snippet: snippetOf(c.snippet),
      voting: format === 'showcase' ? 'score' : oneOf(c.voting, VOTING, 'ab'),
      voteSeconds: intIn(c.voteSeconds, 10, 60, 20),
      judges: c.judges === true,
      judgeWeight: intIn(c.judgeWeight, 1, 10, 3),
      auto: c.auto === true,
      tag: str(c.tag, 60),
      genre: str(c.genre, 60),
      decade: decade ? Math.floor(decade / 10) * 10 : 0,
    };
  }

  start() {
    const room = this.room;
    const cfg = this.config;
    if (!this.catalog.songs.size) fail('The song library is empty.', 'empty');
    this.contestants = [];
    for (const x of cfg.contestants) {
      // (Names without letters, like "🎤", would all fold to '' in findOrCreateSinger: match them exactly.)
      const singer = x.singerId ? room.singer(x.singerId)
        : fold(x.name) ? room.findOrCreateSinger(x.name) : room.s.singers.find((s) => s.name === x.name) || room.createSinger({ name: x.name });
      if (!singer || this.contestants.some((c) => c.singerId === singer.id)) continue;
      this.contestants.push({ singerId: singer.id, name: singer.name, emoji: singer.emoji, color: singer.color });
    }
    if (this.contestants.length < 2) fail('Pick at least 2 contestants.', 'bad_request');
    this.matches = [];
    this.perfs = [];
    this.used = new Set(); // songs of this battle (random picks avoid them)
    this.presets = [...cfg.songIds];
    this.matchIdx = -1;
    this.perfIdx = -1;
    this.roundCount = 1;
    this.champion = -1;
    this.ranking = null;
    this.finalLot = false;
    this.error = null;
    if (cfg.format === 'duel') this.addDuelRound();
    else if (cfg.format === 'knockout') this.buildKnockout();
    else this.buildShowcase();
    this.setPhase('vs', VS_SECONDS, () => this.toWaiting());
  }

  // ---- structure: matches and performances -------------------------------------------------

  newMatch({ round, slot, a, b }) {
    const m = {
      id: newId(), round, slot, a, b, bye: false, perfs: [], votes: new Map(), // deviceId → 'a' | 'b'
      decided: false, winner: -1, lot: false, walkover: false, points: null, songId: null,
    };
    this.matches.push(m);
    return m;
  }

  newPerf(c, m = null, side = null) {
    const p = {
      id: newId(), index: this.perfs.length, c, match: m?.id || null, side, songId: null,
      status: 'pending', // → singing → done | skipped
      entryId: null, votes: new Map(), // deviceId → 1…10 (score voting)
      judge: 0, closed: false, playedSec: 0, reactions: 0,
    };
    this.perfs.push(p);
    if (m) m.perfs.push(p.index);
    return p;
  }

  /** A match is about to be sung: its performances (in singing order) and their songs. */
  activate(m, order = ['a', 'b']) {
    this.matchIdx = this.matches.indexOf(m);
    const perfs = order.map((side) => this.newPerf(side === 'a' ? m.a : m.b, m, side));
    if (this.config.songMode === 'same') {
      const song = this.presetSong() || this.randomSong();
      if (song) {
        m.songId = song.id;
        for (const p of perfs) this.assign(p, song);
      }
    } else if (this.config.songMode === 'random') {
      for (const p of perfs) {
        const song = this.randomSong();
        if (song) this.assign(p, song);
      }
    }
  }

  addDuelRound() {
    const k = this.matches.length;
    const m = this.newMatch({ round: k, slot: 0, a: 0, b: 1 });
    this.activate(m, k % 2 ? ['b', 'a'] : ['a', 'b']);
  }

  buildKnockout() {
    const draw = shuffle(this.contestants.map((_, i) => i)); // draw[seed] = contestant
    const rounds = buildBracket(draw.length);
    this.roundCount = rounds.length;
    rounds.forEach((list, round) => list.forEach((x, slot) => {
      this.newMatch({ round, slot, a: x.a === null ? -1 : draw[x.a], b: x.b === null ? -1 : draw[x.b] });
    }));
    for (const m of this.matches) {
      if (m.round !== 0 || m.b >= 0) continue;
      Object.assign(m, { bye: true, decided: true, winner: m.a });
      this.propagate(m);
    }
    this.nextKnockoutMatch();
  }

  /** The winner of `m` moves up into the next round's match. */
  propagate(m) {
    if (this.config.format !== 'knockout' || m.round >= this.roundCount - 1) return;
    const parent = this.matches.find((x) => x.round === m.round + 1 && x.slot === m.slot >> 1);
    parent[m.slot & 1 ? 'b' : 'a'] = m.winner;
  }

  nextKnockoutMatch() {
    const m = this.matches.find((x) => !x.decided && x.a >= 0 && x.b >= 0);
    if (m) this.activate(m);
    return m || null;
  }

  buildShowcase() {
    const order = shuffle(this.contestants.map((_, i) => i));
    const perfs = order.map((c) => this.newPerf(c));
    if (this.config.songMode === 'same') {
      const song = this.presetSong() || this.randomSong();
      if (song) for (const p of perfs) this.assign(p, song);
    } else if (this.config.songMode === 'random') {
      for (const p of perfs) {
        const song = this.randomSong();
        if (song) this.assign(p, song);
      }
    }
  }

  match() {
    return this.matches[this.matchIdx] || null;
  }

  perf() {
    return this.perfs[this.perfIdx] || null;
  }

  /** { a, b }: the performances of a match by side. */
  sides(m) {
    const out = { a: null, b: null };
    for (const i of m?.perfs || []) out[this.perfs[i].side] = this.perfs[i];
    return out;
  }

  nextPendingPerf() {
    const list = this.config.format === 'showcase' ? this.perfs : (this.match()?.perfs || []).map((i) => this.perfs[i]);
    return list.find((p) => p.status === 'pending') || null;
  }

  /** Contestants who can't vote right now (the ones in the current match; everyone in a showcase). */
  blockedVoters() {
    if (this.config.format === 'showcase') return this.contestants.map((_, i) => i);
    const m = this.match();
    return m ? [m.a, m.b] : [];
  }

  /** Is this device one of the contestants `idxs` (through the guest's singer profile)? */
  isContestantDevice(deviceId, idxs) {
    if (!deviceId) return false;
    const singerId = this.room.profileOf(deviceId)?.singerId;
    return idxs.some((i) => {
      const c = this.contestants[i];
      return !!c && (c.singerId === singerId || this.room.singer(c.singerId)?.deviceId === deviceId);
    });
  }

  // ---- songs ------------------------------------------------------------------------------------

  presetSong() {
    while (this.presets.length) {
      const song = this.catalog.song(this.presets.shift());
      if (song) return song;
    }
    return null;
  }

  /** A random song from the setup filter (relaxed step by step when nothing matches). */
  randomSong() {
    const c = this.config;
    const room = this.room;
    const noExplicit = !!this.settings.get('queue.explicitFilter');
    const exclude = new Set([...this.used, ...room.s.tonight.sung, ...room.s.queue.map((e) => e.songId)]);
    const base = { exclude, minDuration: SONG_MIN, maxDuration: SONG_MAX, noExplicit };
    const filtered = { ...base };
    if (c.tag) filtered.tag = c.tag;
    if (c.genre) filtered.genre = c.genre;
    if (c.decade) filtered.decade = c.decade;
    for (const f of [filtered, base, { exclude: this.used, noExplicit }, { noExplicit }]) {
      const [song] = this.catalog.random(1, f);
      if (song) return song;
    }
    return null;
  }

  assign(p, song) {
    p.songId = song.id;
    this.used.add(song.id);
  }

  /** The performances that share `p`'s song ('same': the whole match, or the whole showcase). */
  songGroup(p) {
    if (this.config.songMode !== 'same') return [p];
    if (!p.match) return this.perfs;
    return this.perfs.filter((x) => x.match === p.match);
  }

  // ---- flow -------------------------------------------------------------------------------------

  toWaiting() {
    const p = this.nextPendingPerf();
    if (!p) return this.advance();
    this.perfIdx = p.index;
    if (this.config.auto) this.setPhase('waiting', AUTO_SECONDS, () => this.autoStart());
    else this.setPhase('waiting');
    return { perf: p.id };
  }

  autoStart() {
    try {
      this.startPerf();
    } catch (e) {
      this.error = e.message;
      this.setPhase('waiting'); // wait for the host (they can pick another song)
    }
  }

  startPerf() {
    const p = this.perf();
    if (!p || p.status !== 'pending') fail('Nobody is waiting to sing.', 'bad_state');
    let song = p.songId ? this.catalog.song(p.songId) : null;
    if (!song) {
      song = this.randomSong();
      if (!song) fail('No song found for this performance — pick one.', 'empty');
      for (const x of this.songGroup(p)) if (x.status === 'pending') this.assign(x, song);
    }
    this.dropStaleEntries();
    const c = this.contestants[p.c];
    const entry = this.room.gameSing(song, { singerIds: [c.singerId], clipEnd: this.config.snippet, gameId: this.id, source: 'game:battle' });
    p.entryId = entry.id;
    p.status = 'singing';
    this.error = null;
    this.setPhase('singing');
    return { entryId: entry.id };
  }

  /** The performance's song was stopped from the player (it went back to the queue). */
  stalled() {
    const p = this.perf();
    return this.phase === 'singing' && p?.status === 'singing' && this.room.s.current?.id !== p.entryId;
  }

  /** Battle songs stopped from the player sit in the queue: they must not start after the battle. */
  dropStaleEntries() {
    const q = this.room.s.queue;
    if (q.some((e) => e.game === this.id)) this.room.s.queue = q.filter((e) => e.game !== this.id);
  }

  onSongEnd(entry, info = {}) {
    const p = this.perfs?.find((x) => x.entryId === entry.id);
    if (!p) return false; // not ours (nothing auto-starts while the battle owns the TV anyway)
    p.playedSec = info.playedSec || 0;
    p.reactions = entry.reactions || 0;
    if (p.status === 'singing') p.status = 'done';
    if (this.phase === 'singing' && this.perf() === p) this.afterPerf(p);
    return true;
  }

  afterPerf(p) {
    if (p.status === 'done' && this.config.voting === 'score') {
      this.setPhase('score', this.config.voteSeconds, () => this.closeScore());
      return;
    }
    if (p.status === 'skipped') p.closed = true;
    this.advance();
  }

  closeScore() {
    const p = this.perf();
    if (p) p.closed = true;
    this.advance();
    return { score: p ? this.perfScore(p) : 0 };
  }

  advance() {
    if (this.nextPendingPerf()) return this.toWaiting();
    if (this.config.format === 'showcase') return this.finalize();
    const { a, b } = this.sides(this.match());
    if (this.config.voting === 'ab' && a.status === 'done' && b.status === 'done') {
      this.setPhase('vote', this.config.voteSeconds, () => this.decide());
      return { vote: true };
    }
    return this.decide();
  }

  /** A/B votes (+ judges) or average scores for both sides of a match. */
  points(m) {
    const { a, b } = this.sides(m);
    if (this.config.voting === 'score') return { a: this.perfScore(a), b: this.perfScore(b) };
    const out = { a: 0, b: 0 };
    for (const side of m.votes.values()) out[side]++;
    const judged = this.judgeSide(a, b);
    if (judged) out[judged] += this.config.judgeWeight;
    return out;
  }

  judgeSide(a, b) {
    if (!this.config.judges || a?.status !== 'done' || b?.status !== 'done' || !a.judge || !b.judge || a.judge === b.judge) return null;
    return a.judge > b.judge ? 'a' : 'b';
  }

  /** Average 1–10 score of a performance (judges count `judgeWeight` times), rounded to 0.1. */
  perfScore(p) {
    if (!p || p.status === 'skipped') return 0;
    let sum = 0;
    let n = 0;
    for (const v of p.votes.values()) {
      sum += v;
      n++;
    }
    if (this.config.judges && p.judge) {
      sum += p.judge * this.config.judgeWeight;
      n += this.config.judgeWeight;
    }
    return n ? round1(sum / n) : 0;
  }

  decide() {
    const m = this.match();
    if (!m || m.decided) fail('This match is already decided.', 'bad_state');
    const { a, b } = this.sides(m);
    const pts = this.points(m);
    let side;
    if (a.status === 'skipped' && b.status !== 'skipped') side = 'b';
    else if (b.status === 'skipped' && a.status !== 'skipped') side = 'a';
    if (side) m.walkover = true;
    else if (pts.a !== pts.b) side = pts.a > pts.b ? 'a' : 'b';
    else {
      side = randomInt(2) ? 'b' : 'a';
      m.lot = true;
    }
    Object.assign(m, { points: pts, decided: true, winner: side === 'a' ? m.a : m.b });
    a.closed = true;
    b.closed = true;
    this.setPhase('result', RESULT_SECONDS, () => this.nextMatch());
    return { winner: m.winner, lot: m.lot };
  }

  wins() {
    const w = this.contestants.map(() => 0);
    for (const m of this.matches) if (m.decided && !m.bye && m.winner >= 0) w[m.winner]++;
    return w;
  }

  nextMatch() {
    const cfg = this.config;
    if (cfg.format === 'duel') {
      const wins = this.wins();
      const need = Math.floor(cfg.rounds / 2) + 1;
      if (this.matches.length >= cfg.rounds || wins.some((w) => w >= need)) return this.finalize();
      this.addDuelRound();
    } else {
      this.propagate(this.match());
      if (!this.nextKnockoutMatch()) return this.finalize();
    }
    this.perfIdx = -1;
    this.setPhase('vs', VS_SECONDS, () => this.toWaiting());
    return { match: this.match().id };
  }

  /** Final standings: rows { c, place, wins, points, score, note } — ties at the top by lot. */
  rank() {
    const cfg = this.config;
    const idx = this.contestants.map((_, i) => i);
    if (cfg.format === 'knockout') {
      const final = this.matches.at(-1);
      // How far each contestant got: the round they lost in (the champion: past the final).
      const reached = idx.map((c) => {
        const lost = this.matches.find((m) => m.decided && !m.bye && (m.a === c || m.b === c) && m.winner !== c);
        return lost ? lost.round : this.roundCount;
      });
      const wins = this.wins();
      const rows = idx.map((c) => ({ c, reached: reached[c], wins: wins[c] }))
        .sort((x, y) => y.reached - x.reached || y.wins - x.wins);
      for (const r of rows) {
        r.place = 1 + rows.filter((o) => o.reached > r.reached).length;
        r.note = r.reached >= this.roundCount ? 'Champion' : r.reached === this.roundCount - 1 ? 'Runner-up' : roundName(r.reached, this.roundCount);
      }
      return { rows, lot: !!final?.lot };
    }
    // Shuffled first, then a stable sort: whoever is left tied at the top is decided by lot.
    let rows;
    let same;
    if (cfg.format === 'duel') {
      const wins = this.wins();
      const pointsOf = (c) => round1(this.matches.reduce((sum, m) => sum + (m.decided ? (m.a === c ? m.points.a : m.b === c ? m.points.b : 0) : 0), 0));
      rows = shuffle(idx.map((c) => ({ c, wins: wins[c], points: pointsOf(c) }))).sort((x, y) => y.wins - x.wins || y.points - x.points);
      same = (x, y) => x.wins === y.wins && x.points === y.points;
    } else {
      const eff = (r) => (r.skipped ? -1 : r.score);
      rows = shuffle(this.perfs.map((p) => ({ c: p.c, score: this.perfScore(p), skipped: p.status === 'skipped' }))).sort((x, y) => eff(y) - eff(x));
      same = (x, y) => eff(x) === eff(y);
    }
    rows.forEach((r, i) => { r.place = i + 1; });
    let lot = rows.length > 1 && same(rows[0], rows[1]);
    // A duel whose deciding round was drawn by lot was decided by lot too.
    const last = this.matches.at(-1);
    if (cfg.format === 'duel' && last?.lot && last.winner === rows[0].c) lot = true;
    return { rows, lot };
  }

  finalize() {
    const { rows, lot } = this.rank();
    this.ranking = rows;
    this.finalLot = lot;
    this.champion = rows[0].c;
    this.perfIdx = -1;
    this.setPhase('final', FINAL_SECONDS, () => this.end());
    return { champion: this.champion };
  }

  end() {
    if (this.ended) return;
    if (this.perfs) this.dropStaleEntries();
    super.end();
  }

  summary() {
    const c = this.champion >= 0 ? this.cView(this.champion) : null;
    return c ? { title: 'Battle winner', winners: [c.name] } : null;
  }

  // ---- host controls ------------------------------------------------------------------------------

  action(client, m) {
    switch (m.action) {
      case 'start': return this.hostStart();
      case 'skip': return this.skip();
      case 'close':
      case 'next': return this.hostNext();
      case 'song': return this.chooseSong(m);
      case 'judge': return this.judge(m);
      case 'end':
        this.end();
        return { ok: true };
      default: return fail('Unknown battle control.');
    }
  }

  /** Start the next performance now (from the intro too), or sing a stopped one again. */
  hostStart() {
    if (this.phase === 'vs') this.toWaiting();
    if (this.phase === 'waiting') return this.startPerf();
    if (this.stalled()) {
      const p = this.perf();
      this.dropStaleEntries();
      p.status = 'pending';
      p.entryId = null;
      return this.startPerf();
    }
    return fail('The next performance can’t start right now.', 'bad_state');
  }

  /** The contestant doesn't sing (or stops now): no votes for this performance. */
  skip() {
    if (!['vs', 'waiting', 'singing'].includes(this.phase)) fail('There is no performance to skip right now.', 'bad_state');
    const p = this.phase === 'vs' ? this.nextPendingPerf() : this.perf();
    if (!p || (p.status !== 'pending' && p.status !== 'singing')) fail('There is no performance to skip right now.', 'bad_state');
    this.perfIdx = p.index;
    const singing = p.status === 'singing' && this.room.s.current?.id === p.entryId;
    p.status = 'skipped';
    if (singing) {
      this.room.finish('skipped', { advance: false }); // → onSongEnd → afterPerf
    } else {
      this.dropStaleEntries();
      this.afterPerf(p);
    }
    return { skipped: p.id };
  }

  /** Continue now: close the vote, show the result, go to the next match or end. */
  hostNext() {
    if (this.phase === 'vote') return this.decide();
    if (this.phase === 'score') return this.closeScore();
    if (this.phase === 'result') return this.nextMatch();
    if (this.phase === 'vs') return this.toWaiting();
    if (this.phase === 'final') {
      this.end();
      return { ok: true };
    }
    return fail('Nothing to move on from right now.', 'bad_state');
  }

  chooseSong(m) {
    const p = this.perfs.find((x) => x.id === m.perfId);
    if (!p || p.status !== 'pending') fail('That performance is not waiting for a song.', 'bad_state');
    if (p.match && p.match !== this.match()?.id) fail('Songs are chosen when the match is up.', 'bad_state');
    const group = this.songGroup(p);
    if (group.some((x) => x.status !== 'pending')) fail('Everyone sings the same song here — it can’t change after the first performance.', 'bad_state');
    let song;
    if (m.random === true) {
      song = this.randomSong();
      if (!song) fail('No other song found — try it without filters.', 'empty');
    } else {
      song = typeof m.songId === 'string' ? this.catalog.song(m.songId) : null;
      if (!song) fail('Song not found.', 'not_found');
    }
    for (const x of group) this.assign(x, song);
    const match = p.match && this.match();
    if (match && this.config.songMode === 'same') match.songId = song.id;
    return { songId: song.id };
  }

  judge(m) {
    if (!this.config.judges) fail('Judges are off for this battle.', 'bad_state');
    const p = this.perfs.find((x) => x.id === m.perfId);
    if (!p) fail('Performance not found.', 'not_found');
    if (p.status !== 'singing' && p.status !== 'done') fail('Judges score a performance once it has been sung.', 'bad_state');
    const match = p.match ? this.matches.find((x) => x.id === p.match) : null;
    if (match?.decided || this.ranking) fail('This result is final.', 'closed');
    if (!Number.isInteger(m.score) || m.score < 0 || m.score > 10) fail('Give the judges’ score from 1 to 10.', 'bad_request');
    p.judge = m.score; // 0 clears it
    return { judge: p.judge };
  }

  // ---- phones -------------------------------------------------------------------------------------

  input(client, m) {
    const deviceId = client.data.deviceId;
    if (this.phase !== 'vote' && this.phase !== 'score') fail('Voting is closed right now.', 'closed');
    if (!this.player(deviceId)) fail('Choose a name first.', 'no_profile');
    if (this.isContestantDevice(deviceId, this.blockedVoters())) fail('You’re in this battle — let the others vote 😉', 'own');
    if (this.phase === 'vote') {
      if (m.pick !== 'a' && m.pick !== 'b') fail('Pick one of the two performances.', 'bad_request');
      this.match().votes.set(deviceId, m.pick);
      return { pick: m.pick };
    }
    if (!Number.isInteger(m.score) || m.score < 1 || m.score > 10) fail('Give a score from 1 to 10.', 'bad_request');
    this.perf().votes.set(deviceId, m.score);
    return { score: m.score };
  }

  // ---- views ----------------------------------------------------------------------------------------

  cView(i) {
    const c = this.contestants?.[i];
    if (!c) return null;
    const s = this.room.singer(c.singerId);
    return { i, id: c.singerId, name: s?.name || c.name, emoji: s?.emoji || c.emoji, color: s?.color || c.color };
  }

  matchLabel(m) {
    if (this.config.format === 'duel') return this.config.rounds === 1 ? 'Head to head' : `Round ${m.round + 1} of ${this.config.rounds}`;
    const name = roundName(m.round, this.roundCount);
    const same = this.matches.filter((x) => x.round === m.round && !x.bye);
    return same.length > 1 ? `${name} ${same.indexOf(m) + 1}` : name;
  }

  /** Scores and judges' marks stay hidden from the TV and phones until they are revealed. */
  perfView(p, role) {
    if (!p) return null;
    const song = p.songId ? this.catalog.song(p.songId) : null;
    const open = p.closed || role === 'host';
    const out = {
      id: p.id, c: p.c, side: p.side, status: p.status, songId: song?.id || null,
      title: song?.title || '', artist: song?.artist || '', votes: p.votes.size, reactions: p.reactions,
    };
    if (this.config.voting === 'score' && open) out.score = this.perfScore(p);
    if (this.config.judges && open) out.judge = p.judge || 0;
    return out;
  }

  matchView(m, role, full) {
    const out = {
      id: m.id, round: m.round, slot: m.slot, label: this.matchLabel(m), a: m.a, b: m.b, bye: m.bye,
      decided: m.decided, winner: m.decided ? m.winner : -1, lot: m.lot, walkover: m.walkover, points: m.decided ? m.points : null,
    };
    if (!full) return out;
    const { a, b } = this.sides(m);
    out.order = m.perfs.map((i) => this.perfs[i].side);
    out.perfs = { a: this.perfView(a, role), b: this.perfView(b, role) };
    if (this.config.voting === 'ab') {
      out.voters = m.votes.size;
      // Live A/B bars on the TV (and the host); phones only see their own vote until the result.
      if (role !== 'guest' || m.decided) {
        out.votes = { a: 0, b: 0 };
        for (const side of m.votes.values()) out.votes[side]++;
      }
      if (role === 'host' || m.decided) out.judged = this.judgeSide(a, b);
    }
    return out;
  }

  view(ctx) {
    const v = super.view(ctx);
    const cfg = this.config;
    Object.assign(v, {
      format: cfg.format, rounds: cfg.rounds, songMode: cfg.songMode, snippet: cfg.snippet, voting: cfg.voting,
      voteSeconds: cfg.voteSeconds, judges: cfg.judges, judgeWeight: cfg.judgeWeight, auto: cfg.auto,
      showSongs: true, // while a battle song is on, the TV shows the normal karaoke scene
    });
    if (!this.contestants) return v;
    const m = this.match();
    const p = this.perf();
    v.contestants = this.contestants.map((_, i) => this.cView(i));
    v.roundCount = cfg.format === 'knockout' ? this.roundCount : cfg.rounds;
    v.matches = this.matches.map((x) => this.matchView(x, ctx.role, false));
    v.match = m && cfg.format !== 'showcase' ? this.matchView(m, ctx.role, true) : null;
    v.perf = this.perfView(p, ctx.role);
    v.next = this.perfView(this.phase === 'vs' ? this.nextPendingPerf() : null, ctx.role);
    if (cfg.format === 'showcase') v.perfs = this.perfs.map((x) => this.perfView(x, ctx.role));
    if (cfg.format === 'duel') v.wins = this.wins();
    v.ranking = this.ranking ? this.ranking.map(({ c, place, wins, points, score, note, skipped }) => ({ c, place, wins, points, score, note, skipped })) : null;
    v.champion = this.champion;
    v.finalLot = this.finalLot;
    v.entryId = p?.status === 'singing' ? p.entryId : null;
    if (ctx.role === 'host') {
      v.error = this.error;
      v.stalled = this.stalled();
    }
    if (ctx.role === 'guest') {
      const id = ctx.deviceId;
      v.me = this.contestants.findIndex((_, i) => this.isContestantDevice(id, [i]));
      v.canVote = !!this.player(id) && !this.isContestantDevice(id, this.blockedVoters());
      v.myPick = (m && m.votes.get(id)) || null;
      v.myScore = (p && p.votes.get(id)) || 0;
    }
    return v;
  }
}
