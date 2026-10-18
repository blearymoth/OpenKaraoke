// The year & genre checker (PLAN §27): which songs' year or genre is missing or looks wrong, and
// what to suggest, from what the library and the artwork lookup already know (no network). The
// host's own year or genre (library/songmeta.js) is never flagged: they checked it.

export { CHECK_REASONS, CHECK_KINDS } from '../../shared/filters.js';
const YEAR_REASONS = new Set(['no-year', 'compilation', 'late', 'range']);

// Album titles of compilations, reissues and remasters: their date is rarely the song's.
const COMPILATION_RE = /\b(greatest hits|best of|very best|hits collection|collection|anthology|the essential|essentials|anniversary|remaster(?:ed)?|deluxe|expanded|edition|ultimate|definitive|retrospective|the singles|complete recordings|gold(?:en)? hits|number ones|platinum)\b/i;
export const LATE_YEARS = 15; // this much after the artist's usual year (the median of their dated songs)
const LATE_MIN_SONGS = 4; // … judged from at least this many dated songs (this one included)

/**
 * Every song that needs a look: `Map(songId → { why: [reason…], suggest: { genre? } })`.
 * @param {object} o
 * @param {object[]} o.songs the catalog's songs
 * @param {(key: string) => object|null} o.online the online entry of a song (not the host's)
 * @param {(key: string) => object|null} o.own the host's entry of a song
 * @param {(entry: object) => string} o.albumType the album's type ('compile', 'album', …) or ''
 * @param {(artistKey: string) => string} o.artistGenre the artist's genre from the artwork lookup
 * @param {number} o.now
 */
export function checkSongs({ songs, online, own, albumType, artistGenre, now = Date.now() }) {
  const maxYear = new Date(now).getUTCFullYear() + 1;
  const n = songs.length;
  const NONE = {};
  // Each song's entries and artist (by position), each artist's years and genres (by the song's
  // first artist), with the host's corrections.
  const onl = new Array(n);
  const mine = new Array(n);
  const years = new Int32Array(n);
  const genres = new Array(n);
  const recs = new Array(n);
  const byArtist = new Map();
  for (let i = 0; i < n; i++) {
    const s = songs[i];
    const e = online(s.key) || NONE;
    const m = own(s.key) || NONE;
    const year = m.year || e.year || 0;
    const genre = m.genre || e.genre || '';
    onl[i] = e;
    mine[i] = m;
    years[i] = year;
    genres[i] = genre;
    const a = s.artistKeys?.[0] || '';
    let rec = byArtist.get(a);
    if (!rec) byArtist.set(a, (rec = { key: a, years: [], genres: null, median: 0 }));
    recs[i] = rec;
    if (year >= 1900 && year <= maxYear) rec.years.push(year);
    if (genre) (rec.genres ||= new Map()).set(genre, (rec.genres.get(genre) || 0) + 1);
  }
  for (const rec of byArtist.values()) {
    if (rec.years.length < LATE_MIN_SONGS) continue;
    rec.years.sort((a, b) => a - b);
    rec.median = rec.years[Math.floor((rec.years.length - 1) / 2)];
  }
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const e = onl[i];
    const m = mine[i];
    const year = years[i];
    const rec = recs[i];
    let why = null;
    let suggest = null;
    if (!m.year) {
      if (!year) why = ['no-year'];
      else if (year < 1900 || year > maxYear) why = ['range'];
      else {
        if ((e.album && COMPILATION_RE.test(e.album)) || (e.albumId && albumType(e) === 'compile')) why = ['compilation'];
        if (rec.median && year - rec.median >= LATE_YEARS) (why ||= []).push('late');
      }
    }
    if (!m.genre && !genres[i]) {
      (why ||= []).push('no-genre');
      // The artist's genre, else the one most of their other songs have (two at least).
      let g = artistGenre(rec.key) || '';
      if (!g && rec.genres) {
        let best = 1;
        for (const [name, c] of rec.genres) if (c > best) { best = c; g = name; }
      }
      if (g) suggest = { genre: g };
    }
    if (why) out.set(songs[i].id, { why, suggest: suggest || {} });
  }
  return out;
}

/** Does a check result match the kind asked for ('any' | 'year' | 'genre')? */
export function checkMatches(result, kind) {
  if (!result) return false;
  if (kind === 'year') return result.why.some((w) => YEAR_REASONS.has(w));
  if (kind === 'genre') return result.why.includes('no-genre');
  return true;
}

/**
 * The year a song first came out, from the providers' matches: the earliest year among the
 * confident matches that are not another version (live, remix…). Null when none has one.
 */
export function firstYearOf(candidates, { min = 0.8, now = Date.now() } = {}) {
  const maxYear = new Date(now).getUTCFullYear() + 1;
  let best = null;
  for (const c of candidates || []) {
    if ((c.confidence ?? 0) < min || c.version) continue;
    const y = Number(c.year);
    if (!Number.isInteger(y) || y < 1900 || y > maxYear) continue;
    if (!best || y < best.year) best = { year: y, album: c.album || '', provider: c.provider || '' };
  }
  return best;
}
