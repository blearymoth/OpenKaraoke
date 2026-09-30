// Party games attached to the Room: one game at a time, with public (TV), guest and host views.
import { WsError } from '../ws/hub.js';
import { PollGame, POLL_DEFAULTS } from './poll.js';
import { WheelGame, DEFAULT_DARES } from './wheel.js';

export const GAME_TYPES = ['poll', 'wheel'];

export class Games {
  /** @param {import('../room/room.js').Room} room */
  constructor(room, { rng = Math.random, now = Date.now } = {}) {
    this.room = room;
    this.rng = rng;
    this.now = now;
    this.game = null;
  }

  get catalog() { return this.room.catalog; }
  get settings() { return this.room.settings; }

  /** Songs guests would be allowed to pick (explicit filter, max length). */
  songFilter(tag) {
    const q = this.settings.data.queue;
    const f = {};
    if (tag) f.tag = String(tag);
    if (q.explicitFilter) f.noExplicit = true;
    if (q.maxDuration > 0) f.maxDuration = q.maxDuration;
    return f;
  }

  start(type, config = {}) {
    if (!GAME_TYPES.includes(type)) throw new WsError('Unknown game');
    this.end();
    const common = { rng: this.rng, now: this.now, onChange: () => this.room.touch() };
    if (type === 'poll') {
      const count = Math.max(2, Math.min(6, Number(config.count) || POLL_DEFAULTS.count));
      let songs = (Array.isArray(config.songIds) ? config.songIds : []).map((id) => this.catalog.song(id)).filter(Boolean);
      if (songs.length < 2) songs = this.catalog.random(count, this.songFilter(config.tag), { rng: this.rng });
      if (songs.length < 2) throw new WsError('Not enough songs for a poll');
      this.game = new PollGame({ songs: songs.slice(0, count).map((s) => this.catalog.songSummary(s)), seconds: config.seconds || POLL_DEFAULTS.seconds, ...common });
    } else {
      const kind = ['songs', 'singers', 'dares'].includes(config.kind) ? config.kind : 'songs';
      let segments;
      if (kind === 'songs') {
        const n = Math.max(3, Math.min(12, Number(config.count) || 8));
        segments = this.catalog.random(n, this.songFilter(config.tag), { rng: this.rng })
          .map((s) => ({ id: s.id, label: s.title, sub: s.artist }));
      } else if (kind === 'singers') {
        const online = this.room.onlineDevices();
        segments = this.room.s.singers
          .filter((s) => !s.deviceId || online.has(s.deviceId))
          .map((s) => ({ id: s.id, label: s.name, sub: s.emoji, color: s.color }));
      } else {
        const list = (Array.isArray(config.dares) && config.dares.length >= 2 ? config.dares : DEFAULT_DARES)
          .map((d) => String(d).slice(0, 80)).filter(Boolean).slice(0, 12);
        segments = list.map((label, i) => ({ id: `dare${i}`, label }));
      }
      if (segments.length < 2) throw new WsError(kind === 'singers' ? 'The wheel needs at least two singers' : 'Not enough segments for the wheel');
      this.game = new WheelGame({ kind, segments, ...common, spinMs: config.spinMs });
    }
    this.room.hub.broadcast({ t: 'game', event: 'start', type }, (c) => c.role === 'guest');
    this.room.touch();
    return this.game.view();
  }

  end() {
    if (!this.game) return;
    this.game.dispose();
    this.game = null;
    this.room.touch();
  }

  /** Host actions: poll close/queue, wheel spin/remove/queue. */
  action(name, payload = {}) {
    const g = this.game;
    if (!g) throw new WsError('No game is running');
    if (name === 'queue') return this.queueResult(payload);
    try {
      return g.action(name);
    } catch (e) {
      throw new WsError(e.message);
    }
  }

  /** Queues the poll winner / the wheel's song. */
  queueResult({ singerId, position = 'next' } = {}) {
    const g = this.game;
    const song = g instanceof PollGame ? g.winnerSong() : g.kind === 'songs' ? g.resultSegment() : null;
    if (!song) throw new WsError('There is no song to queue yet');
    return this.room.addEntry({ role: 'host' }, { songId: song.id || song.songId, singerId, position, source: `game:${g.constructor.type}` });
  }

  vote(client, option) {
    const g = this.game;
    if (!(g instanceof PollGame)) throw new WsError('There is nothing to vote on');
    if (client.role === 'guest' && !this.settings.get('guests.games')) throw new WsError('Games are switched off');
    try {
      return g.vote(client.deviceId || client.id, option);
    } catch (e) {
      throw new WsError(e.message);
    }
  }

  publicView() {
    return this.game ? this.game.view() : null;
  }

  guestView(deviceId) {
    const g = this.game;
    if (!g) return null;
    if (g instanceof PollGame) return g.view(deviceId);
    const v = g.view();
    // no spoilers on phones while the wheel is still turning
    if (v.phase === 'spinning') return { ...v, result: null, turns: undefined, offset: undefined };
    return v;
  }
}
