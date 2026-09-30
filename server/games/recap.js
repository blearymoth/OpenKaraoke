// Party recap (PLAN §13.7): tonight's highlights as slides on the TV (auto-advancing, the host
// can go back and forth) and as a compact list on the phones.
//
// Everything comes from room.s.tonight: `history` (newest first; skipped songs don't count),
// `games` (winners remembered by Game.summary()) and the singers' current names/avatars.
// Slides: totals · top singers (most songs) · best rated (tonight's 1–5 ★ ratings) · most sung
// artists · crowd favourite (most reactions) · game winners · "Thanks for singing!". Slides
// without data are left out; a night without songs shows "No songs yet tonight".
import { Game, fail, intIn } from './base.js';
import { fold } from '../../shared/text.js';
import { GAME_LABELS } from '../../shared/protocol.js';

export const SLIDE_SECONDS = 7;
const TOP = 5;
const EVERYONE = 'everyone'; // the sing-along "singer" (polls, autoplay) isn't a person

const round1 = (x) => Math.round(x * 10) / 10;

/** Names of a history record's singers: [{ key, name, emoji, color }] (current profile when known). */
function singersOf(h, singerOf) {
  const ids = Array.isArray(h.singerIds) ? h.singerIds : [];
  const names = Array.isArray(h.singers) ? h.singers : [];
  const out = [];
  const aligned = ids.length === names.length;
  ids.forEach((id, i) => {
    const s = singerOf(id);
    const name = s?.name || (aligned ? names[i] : '');
    if (name) out.push({ key: `id:${id}`, name, emoji: s?.emoji || '🎤', color: s?.color || '' });
  });
  if (!ids.length) for (const name of names) if (typeof name === 'string' && name) out.push({ key: `name:${fold(name) || name}`, name, emoji: '🎤', color: '' });
  return out;
}

const perfOf = (h, singers) => ({
  songId: h.songId || '',
  title: h.title || '',
  artist: h.artist || '',
  singers: singers.map(({ name, emoji, color }) => ({ name, emoji, color })),
});

/**
 * Tonight's statistics (pure: easy to test).
 * @param {object} p
 * @param {object[]} p.history tonight's history records (newest first, like room.s.tonight.history)
 * @param {object[]} [p.games] remembered game results { type, title, winners }
 * @param {(id: string) => object|null} [p.singerOf] current singer by id (name, emoji, color)
 * @param {number} [p.since] when the party started (ms)
 */
export function buildRecap({ history = [], games = [], singerOf = () => null, since = 0 } = {}) {
  const done = history.filter((h) => h && !h.skipped).slice().reverse(); // oldest first
  const singerCount = new Map(); // key → { name, emoji, color, songs, stars: [] }
  const artistCount = new Map(); // folded artist → { artist, count, last }
  let seconds = 0;
  let reactions = 0;
  const people = new Set();
  const perfs = [];
  done.forEach((h, order) => {
    const singers = singersOf(h, singerOf);
    seconds += Math.max(0, Number(h.playedSec) || 0);
    const r = Math.max(0, Math.round(Number(h.reactions) || 0));
    reactions += r;
    for (const s of singers) {
      if (fold(s.name) === EVERYONE) continue;
      people.add(s.key);
      const row = singerCount.get(s.key) || { ...s, songs: 0, last: 0 };
      row.songs++;
      row.last = order;
      singerCount.set(s.key, row);
    }
    const a = fold(h.artist);
    if (a) {
      const row = artistCount.get(a) || { artist: h.artist, count: 0, last: 0 };
      row.count++;
      row.last = order;
      artistCount.set(a, row);
    }
    const rating = h.rating && Number(h.rating.n) > 0 && Number.isFinite(Number(h.rating.avg)) ? { avg: round1(Number(h.rating.avg)), n: Math.round(Number(h.rating.n)) } : null;
    perfs.push({ ...perfOf(h, singers), order, reactions: r, rating });
  });
  const topSingers = [...singerCount.values()]
    .sort((a, b) => b.songs - a.songs || a.last - b.last || a.name.localeCompare(b.name))
    .slice(0, TOP)
    .map(({ name, emoji, color, songs }) => ({ name, emoji, color, songs }));
  const bestRated = perfs.filter((p) => p.rating)
    .sort((a, b) => b.rating.avg - a.rating.avg || b.rating.n - a.rating.n || a.order - b.order)
    .slice(0, TOP)
    .map(({ order, reactions: _r, ...p }) => p);
  const topArtists = [...artistCount.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last || a.artist.localeCompare(b.artist))
    .slice(0, TOP)
    .map(({ artist, count }) => ({ artist, count }));
  const fav = perfs.filter((p) => p.reactions > 0)
    .sort((a, b) => b.reactions - a.reactions || (b.rating?.avg || 0) - (a.rating?.avg || 0) || a.order - b.order)[0];
  const favourite = fav ? (({ order, ...p }) => p)(fav) : null;
  const gameList = (Array.isArray(games) ? games : [])
    .filter((g) => g && Array.isArray(g.winners) && g.winners.length)
    .slice(-12)
    .map((g) => ({ type: String(g.type || ''), label: Object.hasOwn(GAME_LABELS, g.type) ? GAME_LABELS[g.type] : 'Game', title: String(g.title || 'Winner'), winners: g.winners.slice(0, 6).map(String) }));
  return {
    since,
    totals: { songs: done.length, minutes: Math.round(seconds / 60), singers: people.size, reactions, games: gameList.length },
    topSingers,
    bestRated,
    topArtists,
    favourite,
    games: gameList,
  };
}

/** Which slides a recap has, in order. */
export function slidesFor(recap) {
  const t = recap.totals;
  if (!t.songs) return recap.games.length ? ['empty', 'games'] : ['empty'];
  const slides = ['totals'];
  if (recap.topSingers.length) slides.push('singers');
  if (recap.bestRated.length) slides.push('rated');
  if (recap.topArtists.length && t.songs >= 2) slides.push('artists');
  if (recap.favourite) slides.push('favourite');
  if (recap.games.length) slides.push('games');
  slides.push('thanks');
  return slides;
}

export class Recap extends Game {
  static type = 'recap';
  static label = 'Party recap';
  static exclusive = true;

  static sanitize(c) {
    return { seconds: intIn(c.seconds, 4, 30, SLIDE_SECONDS), loop: c.loop === true };
  }

  start() {
    this.build();
    this.auto = true;
    this.show(0);
  }

  build() {
    const s = this.room.s;
    this.recap = buildRecap({
      history: s.tonight.history,
      games: s.tonight.games,
      singerOf: (id) => this.room.singer(id),
      since: s.session?.startedAt || 0,
    });
    this.slides = slidesFor(this.recap);
  }

  /** Shows slide `i`; while auto-advancing, the next one follows after `seconds`. */
  show(i) {
    const n = this.slides.length;
    this.index = Math.min(n - 1, Math.max(0, i));
    const last = this.index === n - 1;
    if (this.auto && n > 1 && (!last || this.config.loop)) this.setPhase('slides', this.config.seconds, () => this.show((this.index + 1) % n));
    else this.setPhase('slides');
  }

  action(client, m) {
    switch (m.action) {
      case 'next':
        this.show(this.index + 1 < this.slides.length ? this.index + 1 : 0);
        return { index: this.index };
      case 'prev':
        this.show(this.index > 0 ? this.index - 1 : this.slides.length - 1);
        return { index: this.index };
      case 'goto': {
        const i = Number(m.index);
        if (!Number.isInteger(i) || i < 0 || i >= this.slides.length) fail('No such slide.', 'bad_request');
        this.show(i);
        return { index: this.index };
      }
      case 'pause':
        this.auto = false;
        this.show(this.index);
        return { auto: false };
      case 'play':
        this.auto = true;
        this.show(this.index);
        return { auto: true };
      case 'refresh': {
        const cur = this.slides[this.index];
        this.build();
        this.show(Math.max(0, this.slides.indexOf(cur)));
        return { slides: this.slides.length };
      }
      case 'end': return this.end();
      default: return fail('Unknown recap control.');
    }
  }

  view(ctx) {
    const v = super.view(ctx);
    v.recap = this.recap;
    v.slides = this.slides;
    v.index = this.index;
    v.slide = this.slides[this.index];
    v.auto = this.auto;
    v.advancing = this.phaseEndsAt > 0;
    v.seconds = this.config.seconds;
    return v;
  }
}
