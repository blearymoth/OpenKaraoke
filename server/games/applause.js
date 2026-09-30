// Applause meter (PLAN §13.6): the main TV listens with the party PC's microphone (the TV page
// runs on localhost — a secure context — while phones on LAN http can't use theirs).
//
// Each measurement: countdown (3 s, the TV opens the mic) → measure (5 s: the TV reports a
// level ~5×/s and a final score, see shared/applause.js) → result (0–100 on a big gauge). The
// game keeps every result so several singers can be compared ("for Ann", "for Ben"…); the host
// can measure the last one again (it replaces that result) or start the next measurement.
// Only the main TV's reports count, only during 'measure' of the current round, and only
// numbers in [0, 100]. When the TV's final report doesn't arrive in time, the score is worked
// out from the levels it sent; with no levels at all the measurement fails (mic not allowed?).
import { Game, fail, newId } from './base.js';
import { scoreLevels, validLevel } from '../../shared/applause.js';

export const COUNTDOWN_SECONDS = 3;
export const MEASURE_SECONDS = 5;
export const GRACE_MS = 1500; // the TV's final report may land a little after the window closes
const MAX_LEVELS = 120; // ~5 per second for 5 s, with plenty of headroom
const MAX_RESULTS = 30;
export const MIC_HINT = 'Allow the microphone on the TV computer (Chrome asks once).';

const str = (v, max = 40) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class Applause extends Game {
  static type = 'applause';
  static label = 'Applause meter';
  static exclusive = true;

  static sanitize(c) {
    return { label: str(c.label) };
  }

  start() {
    this.results = []; // { id, label, named, score, estimated, at }
    this.round = 0;
    this.lastId = null; // the result shown on the 'result' screen
    this.micError = null;
    this.measure(this.config.label);
  }

  /** Starts a measurement; `replaceId` = measure that result again. */
  measure(label, replaceId = null) {
    if (!this.room.mainDisplay()) fail('Open the TV page on the party computer first — it listens with its microphone.', 'no_display');
    if (!replaceId && this.results.length >= MAX_RESULTS) fail(`That's ${MAX_RESULTS} measurements — start a new applause meter to go on.`, 'full');
    this.round++;
    this.label = label;
    this.replaceId = replaceId;
    this.levels = [];
    this.level = 0;
    this.peak = 0;
    this.micError = null;
    this.setPhase('countdown', COUNTDOWN_SECONDS, () => this.startMeasure());
  }

  startMeasure() {
    this.setPhase('measure', MEASURE_SECONDS);
    this.later(MEASURE_SECONDS * 1000 + GRACE_MS, () => this.complete(null));
  }

  /** Reports from the main TV (room.gameTv only passes those on): level, result, error. */
  tv(client, m) {
    if (m.round !== this.round) return { ok: false, stale: true };
    switch (m.event) {
      case 'level': {
        if (this.phase !== 'measure') return { ok: false };
        if (!validLevel(m.level)) fail('A level is a number from 0 to 100.', 'bad_request');
        if (this.levels.length >= MAX_LEVELS) return { ok: false };
        this.levels.push(m.level);
        this.level = Math.round(m.level);
        this.peak = Math.max(this.peak, this.level);
        return { ok: true };
      }
      case 'result': {
        if (this.phase !== 'measure') return { ok: false };
        if (!validLevel(m.score)) fail('A score is a number from 0 to 100.', 'bad_request');
        this.complete(m.score);
        return { ok: true };
      }
      case 'error': {
        if (this.phase !== 'countdown' && this.phase !== 'measure') return { ok: false };
        this.micError = str(m.message, 160) || 'The microphone is not available.';
        this.setPhase(this.results.length ? 'result' : 'ready');
        return { ok: true };
      }
      default:
        return fail('Unknown applause report.', 'bad_request');
    }
  }

  /** The measurement is over: `score` from the TV, or null → worked out from the levels. */
  complete(score) {
    if (this.phase !== 'measure') return;
    let estimated = false;
    if (score === null) {
      if (!this.levels.length) {
        this.micError = 'No sound level arrived from the TV — is its microphone on?';
        this.setPhase(this.results.length ? 'result' : 'ready');
        return;
      }
      score = scoreLevels(this.levels);
      estimated = true;
    }
    const i = this.replaceId ? this.results.findIndex((r) => r.id === this.replaceId) : -1;
    const n = i >= 0 ? i + 1 : this.results.length + 1;
    const result = {
      id: newId(),
      label: this.label || `Measurement ${n}`,
      named: !!this.label,
      score: Math.round(score),
      peak: this.peak,
      estimated,
      at: this.now(),
    };
    if (i >= 0) this.results[i] = result;
    else this.results.push(result);
    this.lastId = result.id;
    this.level = 0;
    this.setPhase('result');
  }

  action(client, m) {
    const busy = this.phase === 'countdown' || this.phase === 'measure';
    switch (m.action) {
      case 'measure':
        if (busy) fail('Wait for this measurement to finish.', 'busy');
        this.measure(str(m.label));
        return { round: this.round };
      case 'again': {
        if (busy) fail('Wait for this measurement to finish.', 'busy');
        const last = this.results.find((r) => r.id === this.lastId);
        if (!last) fail('There is nothing to measure again yet.', 'empty');
        this.measure(last.named ? last.label : '', last.id);
        return { round: this.round };
      }
      case 'cancel':
        if (!busy) return { ok: true };
        this.setPhase(this.results.length ? 'result' : 'ready');
        return { ok: true };
      case 'remove': {
        if (busy) fail('Wait for this measurement to finish.', 'busy');
        const i = this.results.findIndex((r) => r.id === m.id);
        if (i < 0) fail('That result is gone.', 'not_found');
        this.results.splice(i, 1);
        if (this.lastId === m.id) this.lastId = this.results.at(-1)?.id || null;
        if (!this.results.length) this.setPhase('ready');
        return { ok: true };
      }
      case 'end': return this.end();
      default: return fail('Unknown applause meter control.');
    }
  }

  /** The loudest results (ties share the top). */
  best() {
    if (!this.results.length) return [];
    const top = Math.max(...this.results.map((r) => r.score));
    return this.results.filter((r) => r.score === top);
  }

  summary() {
    const winners = this.best().filter((r) => r.named).map((r) => r.label);
    return winners.length && this.results.length > 1 ? { title: 'Loudest applause', winners } : null;
  }

  view(ctx) {
    const v = super.view(ctx);
    const best = new Set(this.best().map((r) => r.id));
    v.round = this.round;
    v.label = this.label || '';
    v.countdown = COUNTDOWN_SECONDS;
    v.seconds = MEASURE_SECONDS;
    v.level = this.phase === 'measure' ? this.level : 0;
    v.results = this.results.map(({ id, label, score, estimated }) => ({ id, label, score, estimated, best: best.size > 0 && best.has(id) && this.results.length > 1 }));
    v.lastId = this.phase === 'result' || this.phase === 'done' ? this.lastId : null;
    v.micError = this.micError ? (ctx.role === 'guest' ? 'The microphone isn’t working right now.' : this.micError) : null;
    if (ctx.role === 'host' && this.micError) v.micHint = MIC_HINT;
    return v;
  }
}
