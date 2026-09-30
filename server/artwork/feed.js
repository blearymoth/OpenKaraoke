// Sends the artwork service's `art` events to the clients (PLAN §12), who then load the
// changed images again (the event's `seq` goes into the image URLs as a version).
//
// - `seq` is time-based, so it keeps growing across page loads and server restarts.
// - Pages send the last `seq` they saw in their hello; the welcome replays what they missed
//   while they were offline (a sleeping phone), or says "everything" when that is too old.
// - Guests don't learn the songs behind queued mystery entries (nor their artists): an event
//   right after the request would give the surprise away. They get them once it's no secret.
const MAX_IDS = 500; // more ids than this in one message: "everything changed"
const LOG_IDS = 20_000; // ids remembered for replays

export class ArtFeed {
  /**
   * @param {object} opts
   * @param {import('../ws/hub.js').Hub} opts.hub
   * @param {() => { songs: Set<string>, artists: Set<string> }} opts.secrets what guests must not see yet
   * @param {() => number} [opts.now]
   */
  constructor({ hub, secrets, now = Date.now }) {
    this.hub = hub;
    this.secrets = secrets;
    this.now = now;
    this.seq = now();
    this.floor = this.seq; // replays reach back to here
    this.log = []; // [{ seq, songs, artists }], oldest first
    this.logIds = 0;
    this.withheld = { songs: new Set(), artists: new Set() };
  }

  /** An `art` event of the artwork service: { songs: [songId], artists: [artistKey] }. */
  publish({ songs = [], artists = [] }) {
    if (!songs.length && !artists.length) return;
    const seq = this.remember(songs, artists);
    this.hub.broadcast(message(seq, songs, artists), (c) => c.role !== 'guest');
    const hide = this.secrets();
    const gs = songs.filter((id) => !hide.songs.has(id));
    const ga = artists.filter((k) => !hide.artists.has(k));
    for (const id of songs) if (hide.songs.has(id)) this.withheld.songs.add(id);
    for (const k of artists) if (hide.artists.has(k)) this.withheld.artists.add(k);
    if (gs.length || ga.length) this.hub.broadcast(message(seq, gs, ga), (c) => c.role === 'guest');
  }

  /** After a party change: what guests were not told because it was a secret, now that it isn't. */
  release() {
    const w = this.withheld;
    if (!w.songs.size && !w.artists.size) return;
    const hide = this.secrets();
    const songs = [...w.songs].filter((id) => !hide.songs.has(id));
    const artists = [...w.artists].filter((k) => !hide.artists.has(k));
    if (!songs.length && !artists.length) return;
    for (const id of songs) w.songs.delete(id);
    for (const k of artists) w.artists.delete(k);
    const seq = this.remember(songs, artists);
    this.hub.broadcast(message(seq, songs, artists), (c) => c.role === 'guest');
  }

  /**
   * For the welcome: `{ seq }` plus what changed after `since` (the hello's `artSeq`), or
   * `all: true` when that can't be told any more (long offline, server restarted).
   */
  replay(role, since) {
    const out = { seq: this.seq };
    since = Number(since);
    if (!Number.isSafeInteger(since) || since <= 0 || since === this.seq) return out;
    if (since < this.floor || since > this.seq) return { ...out, all: true };
    const songs = new Set();
    const artists = new Set();
    for (let i = this.log.length - 1; i >= 0 && this.log[i].seq > since; i--) {
      for (const id of this.log[i].songs) songs.add(id);
      for (const k of this.log[i].artists) artists.add(k);
    }
    if (role === 'guest') {
      const hide = this.secrets();
      for (const id of hide.songs) songs.delete(id);
      for (const k of hide.artists) artists.delete(k);
    }
    if (songs.size > MAX_IDS || artists.size > MAX_IDS) return { ...out, all: true };
    return { ...out, songs: [...songs], artists: [...artists] };
  }

  remember(songs, artists) {
    this.seq = Math.max(this.seq + 1, this.now());
    this.log.push({ seq: this.seq, songs, artists });
    this.logIds += songs.length + artists.length;
    while (this.logIds > LOG_IDS && this.log.length > 1) {
      const old = this.log.shift();
      this.logIds -= old.songs.length + old.artists.length;
      this.floor = old.seq;
    }
    return this.seq;
  }
}

function message(seq, songs, artists) {
  if (songs.length > MAX_IDS || artists.length > MAX_IDS) return { t: 'art', seq, all: true, songs: [], artists: [] };
  return { t: 'art', seq, songs, artists };
}
