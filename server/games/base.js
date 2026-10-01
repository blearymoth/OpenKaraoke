// Base class for party games (PLAN §13). A game is a small server-side state machine owned
// by the Room: the host controls it (`action`), guests play from their phones (`input`),
// the main TV reports media events (`tv`), and every role gets its own `view`.
//
// Lifecycle: new Game(room, config) → start() → phases … → end() → (phase 'done', results
// stay visible) → the host closes it (room.game = null). Every change must be followed by a
// room broadcast: timers created with `later()` and the room's request handler do that.
import crypto from 'node:crypto';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { GAME_SETTLE_MS } from '../../shared/protocol.js';

const log = logger('game');

export const fail = (message, code = 'bad_request') => {
  throw new UserError(message, { code });
};

export const newId = (bytes = 5) => crypto.randomBytes(bytes).toString('base64url');

/** Integer in [min, max] from untrusted input, `def` when missing or not a number. */
export function intIn(v, min, max, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** A decade filter from game setup (1980 for "the 80s"); 0 = any (empty, missing or out of range). */
export function decadeIn(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? Math.floor(n / 10) * 10 : 0;
}

/** Uniformly random integer in [0, n) (crypto quality — results must not be guessable). */
export function randomInt(n) {
  return n > 1 ? crypto.randomInt(n) : 0;
}

/** A shuffled copy (Fisher–Yates with crypto randomness). */
export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  /** Registry key and display name (see shared/protocol.js GAME_LABELS). */
  static type = '';
  static label = '';
  /**
   * true: the game takes over the TV (scenes, audio) — it can only start while no song is on,
   * and songs don't auto-start while it runs (the game may still start songs itself).
   * false: it runs alongside the karaoke (pass the mic, ratings…).
   */
  static exclusive = true;

  /** Returns a clean config from untrusted host input (throw with fail() when unusable). */
  static sanitize(config, room) { // eslint-disable-line no-unused-vars
    return {};
  }

  constructor(room, config = {}) {
    this.room = room;
    this.id = newId();
    this.type = this.constructor.type;
    this.config = this.constructor.sanitize(config || {}, room);
    this.phase = 'setup';
    this.phaseEndsAt = 0; // server time (ms) when the current timed phase ends, 0 = untimed
    this.step = 0; // counts phase changes: host controls name the step they were drawn for
    this.movedAt = 0; // when a host control last moved the game on (see control())
    this.timers = new Set();
    this.ended = false;
    this.startedAt = Date.now();
  }

  get catalog() {
    return this.room.catalog;
  }

  get settings() {
    return this.room.settings;
  }

  now() {
    return Date.now();
  }

  /** Runs `fn` after `ms` unless the game ended meanwhile; then broadcasts. */
  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.ended) return;
      try {
        fn();
      } catch (e) {
        log.warn(`${this.type}: ${e.stack || e.message}`);
      }
      this.room.markDirty();
    }, Math.max(0, ms));
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Enters `phase`; with `seconds`, calls `next()` when it runs out (shown as a countdown). */
  setPhase(phase, seconds = 0, next = null) {
    this.clearTimers();
    this.step++;
    this.phase = phase;
    this.phaseEndsAt = seconds > 0 ? this.now() + seconds * 1000 : 0;
    if (seconds > 0 && next) this.later(seconds * 1000, next);
    this.room.markDirty();
  }

  start() {}

  /** Host controls: { action: 'next' | … }. */
  action(client, m) { // eslint-disable-line no-unused-vars
    fail('This game has no such control.');
  }

  /**
   * A host control, through Room.gameAction. A phase control names the `step` it was drawn for
   * and does nothing (`{ stale: true }`) once the game has moved on (a click that crossed a phase
   * timer, or the second of two clicks sent together), nor for GAME_SETTLE_MS after a host
   * control moved the game on: the second click of a human double click lands on the button the
   * host's screen has meanwhile drawn for the new phase (or the one after, when the TV moved the
   * game on again — a quiz question opens as soon as the clip plays), so it names a current step.
   */
  control(client, m) {
    if (m.step !== undefined) {
      const settling = this.now() - this.movedAt < GAME_SETTLE_MS;
      if (m.step !== this.step || settling) return { stale: true, phase: this.phase };
    }
    const before = this.step;
    const res = this.action(client, m);
    if (this.step !== before) this.movedAt = this.now();
    return res;
  }

  /** A guest's answer or vote. `deviceId` comes from the signed guest token. */
  input(client, m) { // eslint-disable-line no-unused-vars
    fail('This game is not taking answers right now.');
  }

  /** Reports from the main TV (clip started, applause level…). */
  tv(client, m) {} // eslint-disable-line no-unused-vars

  /** Karaoke hooks: return true from onSongEnd to stop the room from auto-advancing. */
  onSongStart(entry) {} // eslint-disable-line no-unused-vars
  onSongEnd(entry, info) { return false; } // eslint-disable-line no-unused-vars

  /** Stops the game; results stay visible (phase 'done') until the host closes it. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.phase = 'done';
    this.phaseEndsAt = 0;
    this.room.onGameEnded?.(this);
    this.room.markDirty();
  }

  /** For the party recap: { title, winners: [name] } or null. */
  summary() {
    return null;
  }

  /** Frees timers when the room drops the game. */
  dispose() {
    this.ended = true;
    this.clearTimers();
  }

  /** Has the host banned this guest? Their answers and votes stop counting (and count again after an unban). */
  banned(deviceId) {
    return !!this.room.profileOf(deviceId)?.banned;
  }

  /** The votes in a deviceId → vote map, without banned guests' votes. */
  liveVotes(map) {
    const out = [];
    for (const [deviceId, vote] of map) if (!this.banned(deviceId)) out.push(vote);
    return out;
  }

  /** A guest as shown in games: { deviceId, name, emoji, color } (null when unknown). */
  player(deviceId) {
    const p = this.room.profileOf(deviceId);
    return p?.name ? { deviceId, name: p.name, emoji: p.emoji, color: p.color } : null;
  }

  /** Public part of a player (never leak device ids to other guests). */
  static publicPlayer(p, id) {
    return p ? { id, name: p.name, emoji: p.emoji, color: p.color } : null;
  }

  /**
   * What `ctx.role` ('host' | 'tv' | 'guest', with ctx.deviceId for guests) sees.
   * Subclasses extend it; keep the TV and guest views free of answers before the reveal.
   */
  view(ctx) {
    const v = {
      id: this.id,
      type: this.type,
      label: this.constructor.label,
      phase: this.phase,
      endsAt: this.phaseEndsAt,
      ended: this.ended,
      exclusive: this.constructor.exclusive,
    };
    if (ctx?.role === 'host') v.step = this.step; // sent back with phase controls (see control())
    return v;
  }
}
