// Roulette wheel (PLAN §13.3): the TV shows a big wheel of random songs, singers, dares,
// genres or duet pairs; the host spins it and acts on the result (queue the song, buzz the
// singer's phone, show the dare…).
//
// Fairness and secrecy: the server draws the result with crypto randomness *before* the spin
// and tells only the TV where the wheel will stop (it needs that to animate). Phones and the
// host screen learn the result when the spin is over (phase 'result').
import { Game, decadeIn, fail, intIn, randomInt, shuffle } from './base.js';
import { fold } from '../../shared/text.js';
import {
  WHEEL_KINDS, WHEEL_KIND_LABELS, WHEEL_MIN_SEGMENTS, WHEEL_MAX_SEGMENTS, MAX_DARES, MAX_DARE_LENGTH,
  DEFAULT_DARES, SPIN_SECONDS, landingRotation,
} from '../../shared/wheel.js';

/** The TV gets the spin this long before it starts, so the animation never jumps. */
export const LEAD_SECONDS = 0.4;
const MIN_SONGS = 3;
const MAX_PEOPLE = 40; // duet pairs are drawn from at most this many people
const HISTORY = 50;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** One line of clean text (control characters and runs of spaces collapsed). */
const clean = (v) => (typeof v === 'string' ? v.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim() : '');
const str = (v, max = 60) => clean(v).slice(0, max);
const cryptoRng = () => randomInt(1e9) / 1e9;
const mod360 = (a) => ((a % 360) + 360) % 360;

/**
 * The host's dares (a string with one dare per line, or an array): cleaned, de-duplicated and
 * checked against the limits. Missing → the default list.
 */
export function parseDares(input) {
  if (input === undefined || input === null) return [...DEFAULT_DARES];
  let lines;
  if (typeof input === 'string') {
    if (input.length > MAX_DARES * (MAX_DARE_LENGTH + 2) * 2) fail('That list of dares is too long.', 'too_long');
    lines = input.split(/\r\n|\r|\n/);
  } else if (Array.isArray(input)) {
    if (input.length > MAX_DARES * 2) fail(`Up to ${MAX_DARES} dares, please.`, 'too_long');
    lines = input.map((x) => (typeof x === 'string' ? x : ''));
  } else {
    fail('Dares must be text, one per line.');
  }
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const text = clean(line);
    if (!text) continue;
    if (text.length > MAX_DARE_LENGTH) fail(`Keep each dare under ${MAX_DARE_LENGTH} characters (“${text.slice(0, 32)}…”).`, 'too_long');
    const key = fold(text) || text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (out.length > MAX_DARES) fail(`Up to ${MAX_DARES} dares, please (you have ${out.length}).`, 'too_long');
  if (out.length < 2) fail('Add at least two dares, one per line.', 'empty');
  return out;
}

const personView = (p) => ({ name: p.name, emoji: p.emoji || '🎤', color: p.color || '' });
/** One key per person: the folded name, or the name as typed when it has no letters ("🦄🦄"). */
const personKey = (name) => fold(name) || String(name || '').trim().toLowerCase();

export class Wheel extends Game {
  static type = 'wheel';
  static label = 'Roulette wheel';
  static exclusive = true;

  static sanitize(c) {
    const kind = typeof c.kind === 'string' && WHEEL_KINDS.includes(c.kind) ? c.kind : 'songs';
    const songs = kind === 'songs';
    return {
      kind,
      count: intIn(c.count, WHEEL_MIN_SEGMENTS, WHEEL_MAX_SEGMENTS, 8),
      // songs: optional filters (like the poll)
      tag: songs ? str(c.tag) : '',
      genre: songs ? str(c.genre) : '',
      decade: songs ? decadeIn(c.decade) : 0,
      // singers / duets: everybody known tonight, or only guests whose phone is here now
      who: c.who === 'online' ? 'online' : 'all',
      dares: kind === 'dares' ? parseDares(c.dares) : [],
    };
  }

  start() {
    this.segments = this.buildSegments();
    this.rotation = 0; // where the wheel rests (degrees, clockwise)
    this.seq = 0; // spins so far
    this.spin = null; // { seq, index, offset, turns, from, to, startsAt, duration }
    this.result = null; // { seq, index, seg, queued, notified }
    this.history = [];
    this.setPhase('ready');
  }

  // ---- segments ------------------------------------------------------------------------------

  buildSegments() {
    const { kind, count } = this.config;
    if (kind === 'songs') return this.songSegments(count);
    if (kind === 'dares') return shuffle(this.config.dares).slice(0, count).map((text) => ({ label: text }));
    if (kind === 'genres') return this.genreSegments(count);
    const people = this.people();
    if (kind === 'singers') {
      if (people.length < 2) {
        fail(this.config.who === 'online'
          ? 'The wheel needs at least 2 guests with their phone here — or spin all singers instead.'
          : 'The wheel needs at least 2 singers — add some on the Singers page or let guests join with their phones.', 'empty');
      }
      return shuffle(people).slice(0, count).map((p) => ({ label: p.name, emoji: p.emoji, people: [p] }));
    }
    if (people.length < 3) fail('Duet pairs need at least 3 singers.', 'empty');
    return this.pairs(people, count).map((pair) => ({ label: pair.map((p) => p.name).join(' & '), emoji: pair.map((p) => p.emoji).join(''), people: pair }));
  }

  /** Songs filter shared by the song segments and "random song from…" picks. */
  songFilter(extra = {}) {
    const f = { minDuration: 20, maxDuration: 480, ...extra };
    if (this.settings.get('queue.explicitFilter')) f.noExplicit = true;
    return f;
  }

  notSungYet() {
    const s = this.room.s;
    return new Set([...s.tonight.sung, ...s.queue.map((e) => e.songId), ...s.pending.map((e) => e.songId), ...(s.current ? [s.current.songId] : [])]);
  }

  songSegments(count) {
    const c = this.config;
    const extra = {};
    if (c.tag) extra.tag = c.tag;
    if (c.genre) extra.genre = c.genre;
    if (c.decade) extra.decade = c.decade;
    const filter = this.songFilter(extra);
    let songs = this.catalog.random(count, { ...filter, exclude: this.notSungYet() }, { rng: cryptoRng });
    if (songs.length < MIN_SONGS) songs = this.catalog.random(count, filter, { rng: cryptoRng }); // a small library: repeats are fine
    if (songs.length < MIN_SONGS) fail('Not enough songs for a wheel — try it without filters.', 'empty');
    return songs.map((s) => ({ label: s.title, sub: s.artist, songId: s.id }));
  }

  genreSegments(count) {
    const genres = (this.catalog.facets().genres || []).filter((g) => g.genre && g.count > 0);
    if (genres.length < 2) fail('Genres come from song metadata — turn on artwork & metadata and let it look up some songs first.', 'empty');
    // The most common genres, in random order (a sprinkling of rarer ones when there are many).
    return shuffle(genres.slice(0, count * 2)).slice(0, count).map((g) => ({ label: g.genre, sub: `${g.count} ${g.count === 1 ? 'song' : 'songs'}`, genre: g.genre }));
  }

  /**
   * Everyone who could sing: tonight's singers plus guests on their phones (no duplicates).
   * Singers are kept from party to party: only the ones who are part of tonight count.
   */
  people() {
    const room = this.room;
    const online = new Set(room.hub.list((c) => c.role === 'guest').map((c) => c.data.deviceId).filter(Boolean));
    const onlineOnly = this.config.who === 'online';
    const out = [];
    const seen = new Set();
    const add = (p) => {
      const key = personKey(p.name);
      if (!key || key === 'everyone' || seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };
    const singer = (x) => add({ name: x.name, emoji: x.emoji, color: x.color, singerId: x.id, deviceId: x.deviceId || null });
    const tonight = this.tonight();
    // People with a phone first (so a name the host also typed in maps to the guest's phone).
    for (const x of room.s.singers) {
      if (!x.deviceId || room.profileOf(x.deviceId)?.banned) continue;
      if (onlineOnly ? online.has(x.deviceId) : online.has(x.deviceId) || tonight(x)) singer(x);
    }
    for (const deviceId of online) {
      const p = room.profileOf(deviceId);
      if (!p?.name || p.banned) continue;
      if (p.singerId && room.singer(p.singerId)) continue; // listed above
      add({ name: p.name, emoji: p.emoji, color: p.color, singerId: null, deviceId });
    }
    if (!onlineOnly) for (const x of room.s.singers) if (!x.deviceId && !x.singAlong && tonight(x)) singer(x);
    return out;
  }

  /**
   * Is a singer part of tonight's party? Sang, queued or waiting tonight, added (or re-added by the
   * host) since the party started, or their phone was here tonight.
   */
  tonight() {
    const s = this.room.s;
    const since = s.session?.startedAt || 0;
    const busy = new Set([...s.queue, ...s.pending, ...(s.current ? [s.current] : [])].flatMap((e) => e.singerIds || []));
    return (x) => x.sung > 0 || busy.has(x.id)
      || Math.max(x.createdAt || 0, x.seenAt || 0, x.lastSangAt || 0) >= since
      || (!!x.deviceId && (this.room.profileOf(x.deviceId)?.lastSeen || 0) >= since);
  }

  /** Random duet pairs: first everyone gets a partner, then other random combinations. */
  pairs(people, count) {
    const ppl = shuffle(people).slice(0, MAX_PEOPLE);
    const out = [];
    const keys = new Set();
    const add = (a, b) => {
      const key = [personKey(a.name), personKey(b.name)].sort().join('|');
      if (keys.has(key)) return;
      keys.add(key);
      out.push([a, b]);
    };
    for (let i = 0; i + 1 < ppl.length && out.length < count; i += 2) add(ppl[i], ppl[i + 1]);
    const all = [];
    for (let i = 0; i < ppl.length; i++) for (let j = i + 1; j < ppl.length; j++) all.push([ppl[i], ppl[j]]);
    for (const [a, b] of shuffle(all)) {
      if (out.length >= count) break;
      add(a, b);
    }
    return shuffle(out);
  }

  // ---- host controls -------------------------------------------------------------------------

  action(client, m) {
    switch (m.action) {
      case 'spin': return this.doSpin({ remove: m.remove === true });
      case 'queue': return this.queueResult(m);
      case 'buzz': return { notified: this.buzz(true) };
      case 'end':
        this.end();
        return { ok: true };
      default: return fail('Unknown wheel control.');
    }
  }

  /** Draws the result, then lets the TV animate the spin that lands on it. */
  doSpin({ remove = false } = {}) {
    if (this.phase === 'spinning') fail('The wheel is already spinning.', 'busy');
    if (this.phase !== 'ready' && this.phase !== 'result') fail('The wheel can’t spin right now.', 'closed');
    if (remove) {
      if (!this.result) fail('Spin first — then you can take the result off the wheel.');
      if (this.segments.length <= 2) fail('Only two left — spin again without removing it, or end the game.', 'empty');
      this.segments.splice(this.result.index, 1);
    }
    const n = this.segments.length;
    const index = randomInt(n);
    const offset = (15 + randomInt(71)) / 100; // 15–85 % into the segment: never on a border
    const turns = 4 + randomInt(3);
    const from = mod360(this.rotation);
    this.result = null;
    this.setPhase('spinning', LEAD_SECONDS + SPIN_SECONDS, () => this.reveal());
    this.spin = {
      seq: ++this.seq, index, offset, turns, from,
      to: landingRotation(from, index, n, offset, turns),
      startsAt: this.phaseEndsAt - SPIN_SECONDS * 1000,
      duration: SPIN_SECONDS,
    };
    this.rotation = from;
    return { seq: this.spin.seq, segments: n };
  }

  reveal() {
    const sp = this.spin;
    const seg = this.segments[sp.index];
    this.rotation = sp.to;
    this.result = { seq: sp.seq, index: sp.index, seg, queued: null, notified: 0 };
    this.history.push({ seq: sp.seq, seg });
    if (this.history.length > HISTORY) this.history.shift();
    this.setPhase('result');
    if (seg.people) this.buzz();
  }

  /** Buzzes the picked singers' phones (singers and duet wheels). Returns how many were reached. */
  buzz(again = false) {
    const r = this.result;
    if (this.phase !== 'result' || !r?.seg.people) {
      if (again) fail('Only a singer or duet result can buzz a phone.');
      return 0;
    }
    let n = 0;
    for (const p of r.seg.people) {
      const deviceId = this.deviceOf(p);
      if (!deviceId) continue;
      const other = r.seg.people.find((x) => x !== p);
      const text = other ? `The wheel paired you with ${other.name} — time for a duet! 🎶` : 'The wheel picked you — pick a song! 🎤';
      if (this.room.notifyDevice(deviceId, { t: 'notify', kind: 'game', game: 'wheel', text }) > 0) n++; // only phones that are here
    }
    r.notified = n;
    if (again && !n) fail('Nobody on this result has a phone connected.', 'not_found');
    return n;
  }

  deviceOf(p) {
    const deviceId = p.deviceId || (p.singerId && this.room.singer(p.singerId)?.deviceId) || null;
    const profile = deviceId ? this.room.profileOf(deviceId) : null;
    return profile?.name && !profile.banned ? deviceId : null;
  }

  /** A singer id for someone on the wheel (guests without one get their singer now). */
  singerIdFor(p) {
    const room = this.room;
    if (p.singerId && room.singer(p.singerId)) return p.singerId;
    const profile = p.deviceId ? room.profileOf(p.deviceId) : null;
    if (profile?.name && !profile.banned) return room.singerForProfile(p.deviceId).id;
    return room.findOrCreateSinger(p.name).id;
  }

  randomSong(extra) {
    const filter = this.songFilter(extra);
    return this.catalog.random(1, { ...filter, exclude: this.notSungYet() }, { rng: cryptoRng })[0]
      || this.catalog.random(1, filter, { rng: cryptoRng })[0]
      || null;
  }

  /**
   * Queues the result next: the song (songs), a random song of the genre (genres) or a random
   * duet for the pair (duets). `m.for`: 'everyone' (default), 'nobody' or a singer id.
   */
  queueResult(m) {
    const r = this.result;
    if (this.phase !== 'result' || !r) fail('Spin the wheel first.', 'closed');
    if (r.queued) fail('That’s already in the queue.', 'repeat');
    const kind = this.config.kind;
    let song = null;
    if (kind === 'songs') song = this.catalog.song(r.seg.songId);
    else if (kind === 'genres') song = this.randomSong({ genre: r.seg.genre });
    else if (kind === 'duets') song = this.randomSong({ tag: 'Duets' });
    else fail('There is nothing to queue for this wheel.');
    if (!song) fail(kind === 'duets' ? 'No duet songs were found in the library.' : kind === 'genres' ? `No ${r.seg.genre} songs are left to pick.` : 'That song is not in the library any more.', 'not_found');

    let singerIds = [];
    let singerName = '';
    if (kind === 'duets') singerIds = [...new Set(r.seg.people.map((p) => this.singerIdFor(p)))];
    else if (m.for === undefined || m.for === 'everyone') singerName = 'Everyone';
    else if (m.for === 'nobody') singerName = '';
    else if (typeof m.for === 'string' && this.room.singer(m.for)) singerIds = [m.for];
    else fail('Pick who sings it.');

    const res = this.room.gameQueue(song, { singerName, singerIds, position: 'next', source: 'game:wheel' });
    const entry = res?.entry;
    r.queued = {
      entryId: entry?.id || null,
      songId: song.id,
      title: song.title,
      artist: song.artist,
      singers: (entry?.singers || []).map((x) => x.name),
    };
    return { queued: r.queued };
  }

  end() {
    if (!this.ended && this.phase === 'spinning') {
      // Stopped mid-spin: the drawn result is never shown (and never leaks).
      this.rotation = this.spin.from;
      this.spin = null;
    }
    super.end();
  }

  summary() {
    if (!this.history.length) return null;
    const winners = [];
    for (const h of this.history) for (const p of h.seg.people || []) if (!winners.includes(p.name)) winners.push(p.name);
    return {
      title: `Roulette wheel · ${WHEEL_KIND_LABELS[this.config.kind]}`,
      winners: winners.slice(0, 12),
      results: this.history.slice(-10).map((h) => h.seg.label),
    };
  }

  // ---- views ---------------------------------------------------------------------------------

  segView(seg) {
    const out = { label: seg.label };
    if (seg.sub) out.sub = seg.sub;
    if (seg.emoji) out.emoji = seg.emoji;
    if (seg.songId) out.songId = seg.songId;
    if (seg.genre) out.genre = seg.genre;
    if (seg.people) out.people = seg.people.map(personView);
    return out;
  }

  view(ctx) {
    const v = super.view(ctx);
    const spinning = this.phase === 'spinning';
    v.kind = this.config.kind;
    v.kindLabel = WHEEL_KIND_LABELS[this.config.kind];
    v.segments = this.segments.map((s) => this.segView(s));
    v.spins = this.seq;
    v.rotation = mod360(this.rotation);
    v.spin = null;
    if (this.spin) {
      const { seq, startsAt, duration, from } = this.spin;
      v.spin = { seq, startsAt, duration, from };
      // Only the TV knows where the wheel stops before it does (it has to draw the spin).
      if (ctx.role === 'tv' || !spinning) Object.assign(v.spin, { index: this.spin.index, offset: this.spin.offset, turns: this.spin.turns, to: this.spin.to });
    }
    v.result = null;
    if (this.result && !spinning) {
      const r = this.result;
      v.result = { seq: r.seq, index: r.index, ...this.segView(r.seg), queued: r.queued, notified: r.notified };
      if (ctx.role === 'guest') {
        const mySinger = this.room.profileOf(ctx.deviceId)?.singerId;
        v.result.mine = !!r.seg.people?.some((p) => (p.deviceId && p.deviceId === ctx.deviceId) || (p.singerId && p.singerId === mySinger));
      }
    }
    v.history = this.history.slice(-8).map((h) => ({ seq: h.seq, ...this.segView(h.seg) }));
    if (ctx.role === 'host') v.canRemove = this.segments.length > 2;
    return v;
  }
}
