// The host's own details for a version (track) of a song: artist, title, label, version note and
// the explicit and duet marks, kept in data/trackedits.json by track id. The file on the drive is
// never touched: an edit is laid over what the file name says (its parse result) whenever the
// catalog is built, so the version moves to another song when its artist or title changes, and a
// field taken back shows the file name's again. Edits follow a file whose id moves (rekey).
import { JsonDoc } from '../util/jsonfile.js';
import { UserError } from '../util/errors.js';
import { rekeyRecords } from './ids.js';
import { splitCredits, fold } from '../../shared/text.js';

export const TRACK_EDIT_FIELDS = ['artist', 'title', 'brand', 'variant', 'explicit', 'duet'];
export const MAX_NAME = 120; // artist and title
export const MAX_LABEL = 40; // label and version note
const TEXT_MAX = { artist: MAX_NAME, title: MAX_NAME, brand: MAX_LABEL, variant: MAX_LABEL * 2 };
const TRACK_RE = /^[0-9a-z]{1,16}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const validTrack = (id) => typeof id === 'string' && TRACK_RE.test(id) && !BAD_KEYS.has(id);

/** One text field as the host may set it (spaces tidied, no control characters), else ''. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/**
 * A patch from the host: each field a value, or null to take the host's back (the file name's
 * shows again). Fields not sent stay as they are. Throws a UserError on a value that can't be used.
 */
export function cleanTrackPatch(body) {
  const patch = {};
  for (const k of TRACK_EDIT_FIELDS) {
    if (!body || !Object.hasOwn(body, k)) continue;
    const v = body[k];
    if (v === null) { patch[k] = null; continue; }
    if (k === 'explicit' || k === 'duet') {
      if (typeof v !== 'boolean') throw new UserError(`“${k}” is yes or no.`, { code: 'bad_field' });
      patch[k] = v;
      continue;
    }
    const s = cleanText(v, TEXT_MAX[k]);
    // An empty label or version note is a value ("no label"); an empty artist or title is not.
    if (!s && (k === 'artist' || k === 'title')) throw new UserError(`The ${k} can't be empty.`, { code: 'bad_field' });
    patch[k] = s;
  }
  return patch;
}

/** A stored edit, cleaned (unknown fields and odd values dropped); null when nothing is left. */
function cleanRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const out = {};
  for (const k of TRACK_EDIT_FIELDS) {
    if (!Object.hasOwn(rec, k)) continue;
    const v = rec[k];
    if (k === 'explicit' || k === 'duet') { if (typeof v === 'boolean') out[k] = v; continue; }
    const s = cleanText(v, TEXT_MAX[k]);
    if (s || ((k === 'brand' || k === 'variant') && v === '')) out[k] = s;
  }
  if (!Object.keys(out).length) return null;
  out.at = Number.isSafeInteger(rec.at) ? rec.at : 0;
  return out;
}

const TAG_FOR = { explicit: 'Explicit', duet: 'Duets' };

/**
 * The parse result `p` (parse.js parseName) with the host's edit `e` laid over it — a new object;
 * `p` is never changed. Grouping reads baseArtist/credits and baseTitle, so those follow too.
 */
export function applyTrackEdit(p, e) {
  if (!e) return p;
  const out = { ...p, flags: { ...p.flags }, tags: [...p.tags], variant: [...p.variant] };
  if (typeof e.artist === 'string' && e.artist) {
    out.artist = e.artist;
    out.baseArtist = e.artist;
    out.credits = splitCredits(e.artist);
    const c = fold(e.artist).charAt(0); // (as parse.js letterOf)
    out.letter = c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
  }
  if (typeof e.title === 'string' && e.title) {
    out.title = e.title;
    out.baseTitle = e.title;
  }
  if (typeof e.brand === 'string') out.brand = e.brand;
  if (typeof e.variant === 'string') {
    out.variant = e.variant ? [...new Set(e.variant.split(/\s*,\s*/).filter(Boolean))] : [];
    delete out.flags.live;
    delete out.flags.acoustic;
    for (const v of out.variant) {
      if (/\blive\b/i.test(v)) out.flags.live = true;
      if (/acoustic|unplugged|acoustative/i.test(v)) out.flags.acoustic = true;
    }
  }
  for (const k of ['explicit', 'duet']) {
    if (typeof e[k] !== 'boolean') continue;
    if (e[k]) out.flags[k] = true;
    else delete out.flags[k];
    const has = out.tags.includes(TAG_FOR[k]);
    if (e[k] && !has) out.tags.push(TAG_FOR[k]);
    if (!e[k] && has) out.tags = out.tags.filter((t) => t !== TAG_FOR[k]);
  }
  if (e.explicit === true) delete out.flags.clean;
  return out;
}

export class TrackEdits {
  constructor(file, { now = () => Date.now() } = {}) {
    this.doc = new JsonDoc(file, { version: 1, tracks: {} }, { debounceMs: 1000 });
    this.tracks = Object.create(null); // track id → { artist?, title?, brand?, variant?, explicit?, duet?, at }
    this.now = now;
  }

  async load() {
    const raw = await this.doc.load();
    const src = raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {};
    for (const [id, rec] of Object.entries(src)) {
      if (!validTrack(id)) continue;
      const e = cleanRecord(rec);
      if (e) this.tracks[id] = e;
    }
    this.doc.data = { version: 1, tracks: this.tracks };
    return this;
  }

  /** The host's edit of a track, or null. */
  get(id) {
    return validTrack(id) && Object.hasOwn(this.tracks, id) ? this.tracks[id] : null;
  }

  get size() {
    return Object.keys(this.tracks).length;
  }

  /** Applies a patch (cleanTrackPatch): a value sets a field, null takes it back. Returns the edit or null. */
  set(id, patch) {
    if (!validTrack(id)) throw new UserError('Unknown version', { code: 'not_found' });
    const cur = { ...(this.get(id) || {}) };
    delete cur.at;
    for (const [k, v] of Object.entries(patch)) {
      if (!TRACK_EDIT_FIELDS.includes(k)) continue;
      if (v === null) delete cur[k];
      else cur[k] = v;
    }
    if (Object.keys(cur).length) {
      cur.at = this.now();
      this.tracks[id] = cur;
    } else {
      delete this.tracks[id];
    }
    this.doc.save();
    return this.get(id);
  }

  /** Takes every edit of a track back. */
  clear(id) {
    if (!this.get(id)) return false;
    delete this.tracks[id];
    this.doc.save();
    return true;
  }

  /** The edits as a plain object (for the catalog worker). */
  toObject() {
    return { ...this.tracks };
  }

  /** Moves edits along with files whose ids changed (library 'ids' event). Returns how many moved. */
  rekey(moves) {
    const n = rekeyRecords(this.tracks, moves);
    if (n) this.doc.save();
    return n;
  }

  flush() { return this.doc.flush(); }
  discard() { this.doc.discard(); }
}
