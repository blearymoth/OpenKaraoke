// Sends the artwork service's `art` events to the clients (PLAN §12), who then load the
// changed images again (the event's `seq` goes into the image URLs as a version).
//
// - `seq` is time-based, so it keeps growing across page loads and server restarts.
// - Pages send the last `seq` they saw in their hello; the welcome replays what they missed
//   while they were offline (a sleeping phone), or says "everything" when that is too old.
// - Guests don't learn the songs behind queued mystery entries (nor their artists): an event
//   right after the request would give the surprise away. What they were not told is withheld
//   until the song is out in the open (it plays, or is queued without the mystery); a mystery
//   entry that leaves the queue unplayed keeps its secret, so its song stays withheld.
const MAX_IDS = 500; // more ids than this in one message: "everything changed"
const LOG_IDS = 20_000; // ids remembered for replays

export class ArtFeed {
  /**
   * @param {object} opts
   * @param {import('../ws/hub.js').Hub} opts.hub
   * @param {() => Visibility} opts.secrets what guests must not see yet, and what is out in the open
   * @param {() => number} [opts.now]
   *
   * @typedef {object} Visibility
   * @property {Set<string>} songs songs guests must not hear about (queued mystery songs)
   * @property {Set<string>} artists their artists
   * @property {Set<string>} openSongs songs everyone sees in the party (playing, queued openly)
   * @property {Set<string>} openArtists their artists
   */
  constructor({ hub, secrets, now = Date.now }) {
    this.hub = hub;
    this.secrets = secrets;
    this.now = now;
    this.seq = now();
    this.floor = this.seq; // replays reach back to here
    this.log = []; // [{ seq, songs, artists }], oldest first
    this.logIds = 0;
    this.withheld = { songs: new Set(), artists: new Set() }; // not told to guests, not out in the open yet
  }

  /** An `art` event of the artwork service: { songs: [songId], artists: [artistKey] }. */
  publish({ songs = [], artists = [] }) {
    if (!songs.length && !artists.length) return;
    const seq = this.remember(songs, artists);
    this.hub.broadcast(message(seq, songs, artists), (c) => c.role !== 'guest');
    const v = this.secrets();
    const gs = tellable(songs, v.songs, v.openSongs, this.withheld.songs);
    const ga = tellable(artists, v.artists, v.openArtists, this.withheld.artists);
    if (gs.length || ga.length) this.hub.broadcast(message(seq, gs, ga), (c) => c.role === 'guest');
  }

  /** After a party change: tell guests what was withheld from them, now that it's out in the open. */
  release() {
    const w = this.withheld;
    if (!w.songs.size && !w.artists.size) return;
    const v = this.secrets();
    const songs = [...w.songs].filter((id) => v.openSongs.has(id) && !v.songs.has(id));
    const artists = [...w.artists].filter((k) => v.openArtists.has(k) && !v.artists.has(k));
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
      // Withheld ids that are out in the open now come with the next release().
      const v = this.secrets();
      for (const id of [...v.songs, ...this.withheld.songs]) songs.delete(id);
      for (const k of [...v.artists, ...this.withheld.artists]) artists.delete(k);
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

/**
 * The ids of an event that guests may be told about. A secret one is withheld; so is one
 * withheld earlier that isn't out in the open yet (its mystery entry left the queue unplayed:
 * telling now would still give it away). Telling a withheld one ends its withholding.
 */
function tellable(ids, secret, open, withheld) {
  return ids.filter((id) => {
    if (secret.has(id) || (withheld.has(id) && !open.has(id))) {
      withheld.add(id);
      return false;
    }
    withheld.delete(id);
    return true;
  });
}

function message(seq, songs, artists) {
  if (songs.length > MAX_IDS || artists.length > MAX_IDS) return { t: 'art', seq, all: true, songs: [], artists: [] };
  return { t: 'art', seq, songs, artists };
}
