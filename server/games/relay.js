// Pass the mic (PLAN §13.5): runs alongside the karaoke (not exclusive). While a song is
// playing, after a random stretch of singing (between `min` and `max` seconds of *playing*
// time) the server hands the mic to another participant: the TV flashes "PASS THE MIC ➜ NAME"
// for a few seconds and that guest's phone buzzes (room.notifyDevice kind 'mic').
//
// Participants are guests with a phone (device ids from their signed tokens): a list the host
// picks, or everyone — then every named guest seen online while the game runs joins in (phones
// that lock their screen drop their connection but stay in the game).
// Picking: never the current holder; among the others, those who had the mic the fewest times
// go first (ties drawn by lot with crypto randomness), so everyone gets a turn.
// The clock only runs while room.s.player.state === 'playing': paused songs, intros and the
// breaks between songs don't count. A new song starts a fresh interval; its lead singer holds
// the mic when they're a participant.
import { Game, fail, intIn, randomInt } from './base.js';

export const FLASH_MS = 4000; // how long the TV shows "PASS THE MIC ➜ NAME"
export const TICK_MS = 250;
const MAX_STEP_MS = 1000; // a stalled event loop (or a suspended PC) doesn't fast-forward the clock
export const MAX_PARTICIPANTS = 60;
export const INTERVAL_LIMITS = { min: 5, max: 600 };

export class Relay extends Game {
  static type = 'relay';
  static label = 'Pass the mic';
  static exclusive = false;

  static sanitize(c, room) {
    let min = intIn(c.min, INTERVAL_LIMITS.min, INTERVAL_LIMITS.max, 15);
    let max = intIn(c.max, INTERVAL_LIMITS.min, INTERVAL_LIMITS.max, 40);
    if (max < min) [min, max] = [max, min];
    const everyone = !Array.isArray(c.participants);
    const participants = [];
    if (!everyone) {
      for (const id of c.participants.slice(0, 500)) {
        if (typeof id !== 'string' || participants.includes(id)) continue;
        const p = room.profileOf(id);
        if (p?.name && !p.banned) participants.push(id);
      }
      if (participants.length < 2) fail('Pick at least 2 guests with a phone (or everyone).', 'bad_request');
      if (participants.length > MAX_PARTICIPANTS) fail(`Pass the mic has room for ${MAX_PARTICIPANTS} participants at most.`, 'bad_request');
    }
    return { min, max, everyone, participants };
  }

  start() {
    this.pool = new Set(this.config.participants); // device ids (everyone: grows while the game runs)
    this.removed = new Set(); // taken out by the host
    this.turns = new Map(); // deviceId → times they got the mic
    this.holder = null;
    this.flash = null; // { seq, deviceId, until }
    this.seq = 0;
    this.passes = 0;
    this.stuck = false; // a pass was due but nobody else could take the mic
    this.phase = 'waiting';
    this.remaining = this.drawInterval();
    this.lastTick = this.now();
    this.refreshPool();
    this.tick();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
  }

  end() {
    clearInterval(this.ticker);
    this.flash = null;
    super.end();
  }

  dispose() {
    clearInterval(this.ticker);
    super.dispose();
  }

  /** Milliseconds of singing until the next pass: a whole number of seconds in [min, max]. */
  drawInterval() {
    const { min, max } = this.config;
    return (min + randomInt(max - min + 1)) * 1000;
  }

  isPlaying() {
    const s = this.room.s;
    return !!s.current && s.player.state === 'playing';
  }

  /** Everyone mode: every named guest who is online now joins in. */
  refreshPool() {
    if (!this.config.everyone || this.pool.size >= MAX_PARTICIPANTS) return false;
    let added = false;
    for (const c of this.room.hub.list((x) => x.role === 'guest')) {
      const id = c.data?.deviceId;
      if (!id || this.pool.has(id) || this.removed.has(id)) continue;
      const p = this.room.profileOf(id);
      if (!p?.name || p.banned) continue;
      this.pool.add(id);
      added = true;
      if (this.pool.size >= MAX_PARTICIPANTS) break;
    }
    return added;
  }

  /** Participants who can get the mic right now (named, not banned, not removed). */
  eligible() {
    return [...this.pool].filter((id) => {
      const p = this.room.profileOf(id);
      return !this.removed.has(id) && p?.name && !p.banned;
    });
  }

  /** The next holder: never the current one; the fewest turns first, ties drawn by lot. */
  pick() {
    const candidates = this.eligible().filter((id) => id !== this.holder);
    if (!candidates.length) return null;
    const fewest = Math.min(...candidates.map((id) => this.turns.get(id) || 0));
    const least = candidates.filter((id) => (this.turns.get(id) || 0) === fewest);
    return least[randomInt(least.length)];
  }

  /** Runs 4× a second: counts playing time, passes the mic when it's due, clears the flash. */
  tick() {
    if (this.ended) return;
    const now = this.now();
    const step = Math.max(0, Math.min(now - this.lastTick, MAX_STEP_MS));
    this.lastTick = now;
    let dirty = this.refreshPool();
    const playing = this.isPlaying();
    const phase = playing ? 'live' : 'waiting';
    if (phase !== this.phase) {
      this.phase = phase;
      dirty = true;
    }
    if (playing) {
      this.remaining -= step;
      if (this.remaining <= 0) {
        this.pass('auto');
        dirty = true;
      }
    }
    if (this.flash && now >= this.flash.until) {
      this.flash = null;
      dirty = true;
    }
    if (dirty) this.room.markDirty();
  }

  /** Hands the mic to the next participant (the TV flashes, their phone buzzes). */
  pass(reason = 'auto') {
    this.refreshPool();
    this.remaining = this.drawInterval();
    const next = this.pick();
    if (!next) {
      this.stuck = true;
      if (reason === 'host') fail('There is nobody else to pass the mic to — at least 2 participants are needed.', 'empty');
      return null;
    }
    this.stuck = false;
    this.holder = next;
    this.turns.set(next, (this.turns.get(next) || 0) + 1);
    this.passes++;
    this.flash = { seq: ++this.seq, deviceId: next, until: this.now() + FLASH_MS };
    const p = this.player(next);
    this.room.notifyDevice(next, { t: 'notify', kind: 'mic', name: p?.name || '', gameId: this.id });
    this.room.markDirty();
    return p;
  }

  onSongStart(entry) {
    // A fresh interval for every song; its lead singer starts with the mic when they play along.
    this.remaining = this.drawInterval();
    this.flash = null;
    const lead = entry?.singerIds?.[0] ? this.room.singer(entry.singerIds[0]) : null;
    this.refreshPool();
    const id = lead?.deviceId;
    this.holder = id && this.eligible().includes(id) ? id : null;
  }

  action(client, m) {
    switch (m.action) {
      case 'pass': {
        const p = this.pass('host');
        return { holder: p?.name || '' };
      }
      case 'remove':
      case 'add': {
        const id = typeof m.deviceId === 'string' ? m.deviceId : '';
        const p = this.room.profileOf(id);
        if (!p?.name) fail('That guest is not at the party.', 'not_found');
        if (m.action === 'remove') {
          this.removed.add(id);
          if (this.holder === id) this.holder = null;
          if (this.flash?.deviceId === id) this.flash = null;
        } else {
          if (p.banned) fail('That guest is banned.', 'forbidden');
          if (!this.pool.has(id) && this.pool.size >= MAX_PARTICIPANTS) fail('The game is full.', 'full');
          this.removed.delete(id);
          this.pool.add(id);
        }
        return { participants: this.eligible().length };
      }
      case 'end': return this.end();
      default: return fail('Unknown control for pass the mic.');
    }
  }

  view(ctx) {
    const v = super.view(ctx);
    const ids = this.eligible();
    const pub = (id, i) => Game.publicPlayer(this.player(id), `p${i}`);
    const now = this.now();
    const flash = this.flash && this.flash.until > now ? this.flash : null;
    const holderIndex = ids.indexOf(this.holder);
    v.min = this.config.min;
    v.max = this.config.max;
    v.everyone = this.config.everyone;
    v.passes = this.passes;
    v.count = ids.length;
    v.holder = this.holder ? Game.publicPlayer(this.player(this.holder), holderIndex >= 0 ? `p${holderIndex}` : 'h') : null;
    v.flash = flash ? { seq: flash.seq, until: flash.until, ...Game.publicPlayer(this.player(flash.deviceId), 'f') } : null;
    if (ctx.role === 'host') {
      const online = new Set(this.room.hub.list((c) => c.role === 'guest').map((c) => c.data?.deviceId));
      v.participants = ids.map((id) => ({ deviceId: id, ...this.player(id), turns: this.turns.get(id) || 0, online: online.has(id), holder: id === this.holder }));
      v.holderId = this.holder;
      v.nextIn = this.phase === 'live' ? Math.max(0, Math.ceil(this.remaining / 1000)) : null;
      v.stuck = this.stuck;
    } else {
      v.participants = ids.map((id, i) => ({ ...pub(id, i), turns: this.turns.get(id) || 0, holder: id === this.holder }));
    }
    if (ctx.role === 'guest') {
      v.mine = !!ctx.deviceId && this.holder === ctx.deviceId;
      v.joined = ids.includes(ctx.deviceId);
      if (v.flash) v.flash.mine = flash.deviceId === ctx.deviceId;
    }
    return v;
  }
}
