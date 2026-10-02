// What the TV found out about each track's channels (shared/vocals.js analyseChannelsAsync): a
// multiplex track carries the original singer on one channel only. Kept in data/vocals.json, apart
// from state.json (which is rewritten every second), so a track is analysed once — when it is first
// played or preloaded; the library is never decoded on purpose.
import path from 'node:path';
import { JsonDoc } from '../util/jsonfile.js';

const MAX = 20_000;
const LAYOUTS = new Set(['mono', 'stereo', 'mpx']);
const SIDES = new Set(['', 'L', 'R']);

/** A report from the TV, checked field by field (anything else is dropped): the stored form or null. */
export function cleanAnalysis(m) {
  if (!m || typeof m !== 'object') return null;
  const l = m.layout;
  const s = m.side ?? '';
  const lean = m.lean ?? '';
  if (!LAYOUTS.has(l) || !SIDES.has(s) || !SIDES.has(lean)) return null;
  if (l === 'mpx' && !s) return null;
  const a = Number(m.a);
  return {
    l,
    s: l === 'mpx' ? s : '',
    lean,
    a: Number.isFinite(a) ? Math.round(Math.max(-2, Math.min(2, a)) * 1000) / 1000 : 1,
    c: m.confidence === 'high' ? 'high' : 'low',
  };
}

export class VocalsStore {
  constructor(dataDir) {
    this.doc = new JsonDoc(path.join(dataDir, 'vocals.json'), { tracks: {} }, { debounceMs: 5000 });
  }

  async load() {
    await this.doc.load();
    if (!this.doc.data.tracks || typeof this.doc.data.tracks !== 'object') this.doc.data.tracks = {};
  }

  /** The analysis of a track, or null. */
  get(trackId) {
    const t = this.doc.data.tracks;
    return Object.hasOwn(t, trackId) ? t[trackId] : null;
  }

  /** Stores an analysis; true when it changed what was known. */
  set(trackId, info) {
    const t = this.doc.data.tracks;
    const old = Object.hasOwn(t, trackId) ? t[trackId] : null;
    const changed = !old || old.l !== info.l || old.s !== info.s || old.lean !== info.lean || old.c !== info.c || Math.abs((old.a ?? 1) - info.a) > 0.02;
    t[trackId] = { ...info, at: Date.now() };
    const ids = Object.keys(t);
    if (ids.length > MAX) {
      // The oldest 10 % go.
      ids.sort((x, y) => (t[x].at || 0) - (t[y].at || 0)).slice(0, Math.ceil(MAX / 10)).forEach((id) => delete t[id]);
    }
    this.doc.save();
    return changed;
  }

  flush() {
    return this.doc.flush();
  }

  discard() {
    this.doc.discard();
  }
}
