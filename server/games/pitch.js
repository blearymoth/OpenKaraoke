// Pitch rings (PLAN §13.9): the singer's pitch moves a ball on the main TV; rings scroll in
// and they sing through the hole. The party computer's microphone listens (the TV page is a
// secure context). Phones watch the score — they do not sing into their own mics, and this
// does not grade a karaoke song.
//
// A run: the server picks the rings (major scale in the chosen octave, crypto-random, never
// the same note twice in a row) and the moment each one reaches the ball. The TV reports hz
// during `fly`. When a ring arrives, the latest voiced sample near that moment clears it if
// it is inside the hole. The run plays every ring. Best cleared-count wins.
import { Game, fail, newId, intIn, randomInt } from './base.js';
import { pickNotes, pitchHeight, hit, scaleNotes, voicedHz } from '../../shared/pitch.js';

/** How long a ring takes to travel from the right edge to the ball. */
export const TRAVEL_MS = 3600;
/** Time between one ring reaching the ball and the next. */
export const GAP_MS = 1200;
/** Held after the last ring so the pass or miss can be read. */
export const TAIL_MS = 800;
/** A sample counts for a ring when it is this close to the arrival, in either direction. */
export const SAMPLE_WINDOW_MS = 300;
const MAX_SAMPLES = 480; // ~10/s for a 20-ring run, with headroom
const MAX_RESULTS = 30;
export const MIC_HINT = 'Allow the microphone on the TV computer (Chrome asks once).';

const str = (v, max = 40) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const RANGES = new Set(['low', 'mid', 'high']);

export function runMs(rings) {
  return TRAVEL_MS + Math.max(0, rings - 1) * GAP_MS + TAIL_MS;
}

export class Pitch extends Game {
  static type = 'pitch';
  static label = 'Pitch rings';
  static exclusive = true;

  static sanitize(c) {
    const range = typeof c?.range === 'string' && RANGES.has(c.range) ? c.range : 'mid';
    return { rings: intIn(c?.rings, 5, 20, 10), range };
  }

  start() {
    if (!this.room.mainDisplay()) fail('Open the TV page on the party computer first — it listens with its microphone.', 'no_display');
    this.results = []; // { id, label, named, score, total, at }
    this.round = 0;
    this.lastId = null;
    this.rings = [];
    this.samples = [];
    this.label = '';
    this.cleared = 0;
    this.flash = null;
    this.flashAt = 0;
    this.lastHeight = 0;
    this.lastVoicedAt = 0;
    this.micError = null;
    this.lowHz = scaleNotes(this.config.range)[0].hz;
    this.setPhase('ready');
  }

  /** Starts a run; `replaceId` flies that singer again (the new score replaces theirs). */
  beginRun(label, replaceId = null) {
    if (!this.room.mainDisplay()) fail('Open the TV page on the party computer first — it listens with its microphone.', 'no_display');
    if (!replaceId && this.results.length >= MAX_RESULTS) fail(`That's ${MAX_RESULTS} singers — start a new Pitch rings game to go on.`, 'full');
    this.round++;
    this.label = label;
    this.replaceId = replaceId;
    this.samples = [];
    this.cleared = 0;
    this.flash = null;
    this.flashAt = 0;
    this.lastHeight = 0;
    this.lastVoicedAt = 0;
    this.micError = null;
    const notes = pickNotes(this.config.range, this.config.rings, randomInt);
    const t0 = this.now();
    this.rings = notes.map((note, i) => ({
      id: newId(),
      name: note.name,
      hz: note.hz,
      height: pitchHeight(note.hz, this.lowHz),
      arriveAt: t0 + TRAVEL_MS + i * GAP_MS,
      scored: false,
      cleared: false,
    }));
    const ms = runMs(this.rings.length);
    this.setPhase('fly', ms / 1000, () => this.finishRun());
    for (const ring of this.rings) this.later(ring.arriveAt - this.now(), () => this.scoreRing(ring));
  }

  /** Reports from the main TV (room.gameTv only passes those on): pitch, error. */
  tv(client, m) {
    if (m.round !== this.round) return { ok: false, stale: true };
    if (m.event === 'error') {
      if (this.phase !== 'fly') return { ok: false };
      this.micError = str(m.message, 160) || 'The microphone is not available.';
      this.rings = [];
      this.setPhase(this.results.length ? 'turn' : 'ready');
      return { ok: true };
    }
    if (m.event !== 'pitch') return fail('Unknown pitch report.', 'bad_request');
    if (this.phase !== 'fly') return { ok: false };
    if (!voicedHz(m.hz)) return { ok: false };
    if (this.samples.length >= MAX_SAMPLES) return { ok: false };
    const height = pitchHeight(m.hz, this.lowHz);
    this.samples.push({ hz: m.hz, at: this.now() });
    if (height != null) {
      this.lastHeight = height;
      this.lastVoicedAt = this.now();
    }
    return { ok: true };
  }

  /** The ring has reached the ball: the latest voiced sample near this moment clears or misses. */
  scoreRing(ring) {
    if (this.phase !== 'fly' || !ring || ring.scored) return;
    let best = null;
    for (const s of this.samples) {
      if (Math.abs(s.at - ring.arriveAt) > SAMPLE_WINDOW_MS) continue;
      if (!best || s.at > best.at) best = s;
    }
    ring.scored = true;
    ring.cleared = !!(best && hit(best.hz, ring.hz));
    if (ring.cleared) this.cleared++;
    this.flash = ring.cleared ? 'pass' : 'miss';
    this.flashAt = this.now();
  }

  /** Every ring has been flown. The cleared count is this singer's score. */
  finishRun() {
    if (this.phase !== 'fly') return;
    for (const ring of this.rings) if (!ring.scored) this.scoreRing(ring);
    const i = this.replaceId ? this.results.findIndex((r) => r.id === this.replaceId) : -1;
    const n = i >= 0 ? i + 1 : this.results.length + 1;
    const result = {
      id: newId(),
      label: this.label || `Singer ${n}`,
      named: !!this.label,
      score: this.cleared,
      total: this.rings.length,
      at: this.now(),
    };
    if (i >= 0) this.results[i] = result;
    else this.results.push(result);
    this.lastId = result.id;
    this.rings = [];
    this.flash = null;
    this.setPhase('turn');
  }

  /** Ball height 0–1, falling toward the bottom when the singer goes quiet. */
  ballNow() {
    if (this.phase !== 'fly' || !this.lastVoicedAt) return 0;
    const age = this.now() - this.lastVoicedAt;
    const hold = 150;
    const fall = 480;
    if (age <= hold) return this.lastHeight;
    const t = Math.min(1, (age - hold) / fall);
    return this.lastHeight * (1 - t * t);
  }

  action(client, m) {
    const busy = this.phase === 'fly';
    switch (m.action) {
      case 'next':
        if (busy) fail('Wait for this run to finish.', 'busy');
        this.beginRun(str(m.label));
        return { round: this.round };
      case 'again': {
        if (busy) fail('Wait for this run to finish.', 'busy');
        const last = this.results.find((r) => r.id === this.lastId);
        if (!last) fail('There is nothing to try again yet.', 'empty');
        this.beginRun(last.named ? last.label : '', last.id);
        return { round: this.round };
      }
      case 'end': return this.end();
      default: return fail('Unknown pitch rings control.');
    }
  }

  /** The most rings (ties share the top). */
  best() {
    if (!this.results.length) return [];
    const top = Math.max(...this.results.map((r) => r.score));
    return this.results.filter((r) => r.score === top);
  }

  summary() {
    const named = this.results.filter((r) => r.named);
    if (named.length < 2) return null;
    const winners = this.best().filter((r) => r.named).map((r) => r.label);
    return winners.length ? { title: 'Most rings', winners } : null;
  }

  view(ctx) {
    const v = super.view(ctx);
    const best = new Set(this.best().map((r) => r.id));
    const role = ctx?.role;
    const unscored = this.rings.findIndex((r) => !r.scored);
    v.round = this.round;
    v.label = this.label || '';
    v.range = this.config.range;
    v.total = this.phase === 'fly' ? this.rings.length : this.config.rings;
    v.cleared = this.cleared;
    v.index = this.rings.length ? (unscored < 0 ? this.rings.length : unscored + 1) : 0;
    v.flash = this.phase === 'fly' ? this.flash : null;
    v.flashAt = this.flashAt;
    v.travel = TRAVEL_MS;
    v.seconds = this.phase === 'fly' ? Math.round(runMs(this.rings.length || this.config.rings) / 1000) : 0;
    v.results = this.results.map(({ id, label, score, total }) => ({
      id, label, score, total, best: best.size > 0 && best.has(id) && this.results.length > 1,
    }));
    v.lastId = this.phase === 'turn' || this.phase === 'done' ? this.lastId : null;
    if (role === 'tv') {
      v.lowHz = this.lowHz;
      v.ball = this.ballNow();
      if (this.phase === 'fly') {
        v.rings = this.rings.map(({ id, height, arriveAt, scored, cleared }) => ({ id, height, arriveAt, scored, cleared }));
      }
    }
    if (role === 'host' && this.phase === 'fly') {
      const coming = this.rings.filter((r) => !r.scored);
      v.note = coming[0]?.name || '';
      v.upcoming = coming.map((r) => r.name);
    }
    v.micError = this.micError ? (role === 'guest' ? 'The microphone isn’t working right now.' : this.micError) : null;
    if (role === 'host' && this.micError) v.micHint = MIC_HINT;
    return v;
  }
}
