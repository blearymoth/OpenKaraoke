// The host's own years and genres (the year & genre checker, PLAN §27), kept in
// data/songmeta.json by song key (artist + title, so a rescan or a folder that is split or
// folded keeps them). They are laid over the online song information wherever it is read
// (catalog.metaFor): the browse filters, the Library table, facets, break music, games.
import { JsonDoc } from '../util/jsonfile.js';
import { UserError } from '../util/errors.js';

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const validKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 300 && !BAD_KEYS.has(k);
export const MAX_GENRE = 40;
export const MIN_YEAR = 1900;
export const maxYear = (now = Date.now()) => new Date(now).getUTCFullYear() + 1;

/** A year the host may set (a whole number from 1900 to next year), else null. */
export function cleanYear(v, now) {
  const n = Number(v);
  return Number.isInteger(n) && n >= MIN_YEAR && n <= maxYear(now) ? n : null;
}

/** A genre the host may set (letters, digits and a few signs, at most 40 characters), else ''. */
export function cleanGenre(v) {
  if (typeof v !== 'string') return '';
  const g = v.replace(/\s+/g, ' ').trim().slice(0, MAX_GENRE);
  return /^[\p{L}\p{N}][\p{L}\p{N} &'’/.,+-]*$/u.test(g) ? g : '';
}

export class SongMeta {
  constructor(file, { now = () => Date.now() } = {}) {
    this.doc = new JsonDoc(file, { version: 1, songs: {} }, { debounceMs: 1500 });
    this.songs = Object.create(null); // song key → { year?, genre?, at }
    this.version = 0; // bumped on every change (the checker's cache)
    this.merged = new Map(); // song key → { src, out }: the merged entry, while its source is the same
    this.now = now;
  }

  async load() {
    const raw = await this.doc.load();
    const src = raw.songs && typeof raw.songs === 'object' ? raw.songs : {};
    for (const [key, rec] of Object.entries(src)) {
      if (!validKey(key) || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      const e = {};
      const year = cleanYear(rec.year, this.now());
      const genre = cleanGenre(rec.genre);
      if (year) e.year = year;
      if (genre) e.genre = genre;
      if (!e.year && !e.genre) continue;
      e.at = Number.isSafeInteger(rec.at) ? rec.at : 0;
      this.songs[key] = e;
    }
    this.doc.data = { version: 1, songs: this.songs };
    return this;
  }

  get(key) {
    return validKey(key) && Object.hasOwn(this.songs, key) ? this.songs[key] : null;
  }

  get size() {
    return Object.keys(this.songs).length;
  }

  /**
   * The song information as everyone reads it: the online entry with the host's year and genre
   * over it (`host: { year, genre }` says which). The same object while nothing changed, so a
   * loop over the library allocates nothing.
   */
  apply(key, entry) {
    const own = Object.hasOwn(this.songs, key) ? this.songs[key] : null;
    if (!own) return entry;
    const hit = this.merged.get(key);
    if (hit && hit.src === entry && hit.own === own) return hit.out;
    const out = { ...(entry || {}), host: {} };
    if (own.year) { out.year = own.year; out.host.year = true; }
    if (own.genre) { out.genre = own.genre; out.host.genre = true; }
    this.merged.set(key, { src: entry, own, out });
    return out;
  }

  /**
   * Sets the host's year and/or genre for a song: a value sets it, `null` takes the host's back
   * (the online one shows again). Returns the song's record (or null when none is left).
   */
  set(key, { year, genre } = {}) {
    if (!validKey(key)) throw new UserError('Unknown song', { code: 'not_found' });
    const cur = { ...(this.get(key) || {}) };
    if (year !== undefined) {
      if (year === null) delete cur.year;
      else {
        const y = cleanYear(year, this.now());
        if (!y) throw new UserError(`A year from ${MIN_YEAR} to ${maxYear(this.now())}, please.`, { code: 'bad_year' });
        cur.year = y;
      }
    }
    if (genre !== undefined) {
      if (genre === null) delete cur.genre;
      else {
        const g = cleanGenre(genre);
        if (!g) throw new UserError('That genre has odd characters in it (or it is empty).', { code: 'bad_genre' });
        cur.genre = g;
      }
    }
    if (cur.year || cur.genre) {
      cur.at = this.now();
      this.songs[key] = cur;
    } else {
      delete this.songs[key];
    }
    this.merged.delete(key);
    this.version++;
    this.doc.save();
    return this.get(key);
  }

  flush() {
    return this.doc.flush();
  }

  /** Drops a pending save (a server that could not start must not overwrite the file). */
  discard() {
    this.doc.discard();
  }
}
