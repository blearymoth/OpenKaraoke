// How often each version (track) of a song was sung here, and the up/down votes on it — kept in
// data/versions.json across parties ("New party" never resets it). The host's own vote settles a
// version's status; guests need a lead of two votes. Votes only steer which version plays by
// default (bestVersion): an explicit pick is always honoured.
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { JsonDoc } from '../util/jsonfile.js';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';

const log = logger('versions');

export const HOST_VOTER = '@host'; // every host device shares this vote; '@' never occurs in a deviceId
export const LIKE_AT = 2;
export const AVOID_AT = -2;
export const MAX_VOTERS = 100;
export const TRACK_RE = /^[0-9a-z]{1,16}$/; // shortId ids are base36 (and can be shorter than 12)
const VOTER_RE = /^[\w-]{4,64}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const validVoter = (v) => v === HOST_VOTER || (typeof v === 'string' && VOTER_RE.test(v) && !BAD_KEYS.has(v));
const validTrack = (id) => typeof id === 'string' && TRACK_RE.test(id) && !BAD_KEYS.has(id);

export class VersionStats {
  constructor(file) {
    this.doc = new JsonDoc(file, { version: 1, backfilled: false, tracks: {} }, { debounceMs: 2000 });
    this.tracks = Object.create(null);
  }

  /** Loads (and cleans) the file; the first time, counts the plays already in the history. */
  async load(historyFile) {
    const raw = await this.doc.load();
    const tracks = Object.create(null);
    const src = raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {};
    for (const [id, rec] of Object.entries(src)) {
      if (!validTrack(id) || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      const p = Number.isSafeInteger(rec.p) && rec.p > 0 ? rec.p : 0;
      const v = Object.create(null);
      let guests = 0;
      if (rec.v && typeof rec.v === 'object') {
        for (const [voter, value] of Object.entries(rec.v)) {
          if (!validVoter(voter) || (value !== 1 && value !== -1)) continue;
          if (voter !== HOST_VOTER) {
            if (guests >= MAX_VOTERS) continue;
            guests++;
          }
          v[voter] = value;
        }
      }
      if (p === 0 && !Object.keys(v).length) continue;
      tracks[id] = { p, v };
    }
    this.tracks = tracks;
    this.doc.data = { version: 1, backfilled: raw.backfilled === true, tracks };
    if (!this.doc.data.backfilled && historyFile) await this.backfill(historyFile);
  }

  /** Counts the completed songs of history.jsonl once (streamed; tried again next start on failure). */
  async backfill(historyFile) {
    let fh;
    try {
      fh = await fs.open(historyFile, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.doc.data.backfilled = true;
        this.doc.save();
      } else {
        log.warn('could not read the history for version play counts', e.message);
      }
      return;
    }
    try {
      const counts = new Map();
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r !== 'object' || Object.hasOwn(r, 'type') || r.skipped !== false || !validTrack(r.trackId)) continue;
        counts.set(r.trackId, (counts.get(r.trackId) || 0) + 1);
      }
      for (const [id, n] of counts) this.record(id).p += n;
      this.doc.data.backfilled = true;
      this.doc.save();
    } catch (e) {
      log.warn('could not read the history for version play counts', e.message);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  record(id) {
    if (!Object.hasOwn(this.tracks, id)) this.tracks[id] = { p: 0, v: Object.create(null) };
    return this.tracks[id];
  }

  /** A completed song: one more play for its version. */
  addPlay(trackId) {
    if (!validTrack(trackId)) return;
    this.record(trackId).p++;
    this.doc.save();
  }

  /** value 1 (up), -1 (down) or 0 (take the vote back). */
  vote(trackId, voter, value) {
    if (!validTrack(trackId) || !validVoter(voter) || ![1, -1, 0].includes(value)) throw new TypeError('bad vote');
    const has = Object.hasOwn(this.tracks, trackId);
    if (value === 0) {
      if (!has) return;
      const r = this.tracks[trackId];
      delete r.v[voter];
      if (r.p === 0 && !Object.keys(r.v).length) delete this.tracks[trackId];
      this.doc.save();
      return;
    }
    if (voter !== HOST_VOTER && !(has && Object.hasOwn(this.tracks[trackId].v, voter))) {
      const guests = has ? Object.keys(this.tracks[trackId].v).filter((k) => k !== HOST_VOTER).length : 0;
      if (guests >= MAX_VOTERS) throw new UserError('This version has plenty of votes already.', { code: 'full' });
    }
    this.record(trackId).v[voter] = value;
    this.doc.save();
  }

  /** { plays, up, down, host, net, status, mine }: status 1 liked, -1 avoided, 0 neither. */
  info(trackId, voter = null) {
    const r = Object.hasOwn(this.tracks, trackId) ? this.tracks[trackId] : null;
    let up = 0;
    let down = 0;
    let net = 0;
    const host = r && Object.hasOwn(r.v, HOST_VOTER) ? r.v[HOST_VOTER] : 0;
    if (r) {
      for (const [k, x] of Object.entries(r.v)) {
        if (x === 1) up++;
        else down++;
        if (k !== HOST_VOTER) net += x;
      }
    }
    const status = host !== 0 ? host : net >= LIKE_AT ? 1 : net <= AVOID_AT ? -1 : 0;
    const mine = r && voter && Object.hasOwn(r.v, voter) ? r.v[voter] : 0;
    return { plays: r?.p || 0, up, down, host, net, status, mine };
  }

  /** One voter's vote on a version: 1, -1 or 0. */
  mine(voter, trackId) {
    if (!voter || !Object.hasOwn(this.tracks, trackId)) return 0;
    const v = this.tracks[trackId].v;
    return Object.hasOwn(v, voter) ? v[voter] : 0;
  }

  /** Removes a voter's votes everywhere (a guest removed from the party); how many. */
  dropVoter(voter) {
    if (!validVoter(voter)) return 0;
    let n = 0;
    for (const [id, r] of Object.entries(this.tracks)) {
      if (!Object.hasOwn(r.v, voter)) continue;
      delete r.v[voter];
      n++;
      if (r.p === 0 && !Object.keys(r.v).length) delete this.tracks[id];
    }
    if (n) this.doc.save();
    return n;
  }

  flush() {
    return this.doc.flush();
  }

  discard() {
    this.doc.discard();
  }
}

/**
 * The version that plays by default: liked first, then neither, avoided last; within a tier the
 * host's vote, the guests' net (both only when the tier is decided by them — a lone ±1 never
 * changes the default), the version used last time, then the label score. Ties keep the order.
 */
export function bestVersion(tracks, { infoOf, pref = null, scoreOf }) {
  let best = null;
  let bestKey = null;
  for (const t of tracks) {
    const i = infoOf(t.id);
    const key = [i.status, i.status ? i.host : 0, i.status ? i.net : 0, t.id === pref ? 1 : 0, scoreOf(t)];
    if (!best || greater(key, bestKey)) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

function greater(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Why a version is the default: 'host' | 'guests' | 'last' | 'label'. */
export function defaultReason(track, info, pref) {
  if (info.status === 1) return info.host === 1 ? 'host' : 'guests';
  return track.id === pref ? 'last' : 'label';
}

export const statusName = (s) => (s === 1 ? 'liked' : s === -1 ? 'avoided' : null);
