// Track ids are shortId(`${dir}/${name}`), and `dir` is relative to that track's library
// folder. When a folder becomes its own root, or is folded back into a parent, `dir` changes
// and so does the id — but it is the same file. Plays, votes and the other records keyed by
// id follow that file. A different file never does, even when its name matches.
import path from 'node:path';
import { nestedRoots, inNestedRoot } from './scanner.js';

/** Absolute path of a track's base name under its root. Empty when the root is gone. */
export function trackPlace(roots, t) {
  const root = roots?.[t?.root];
  if (typeof root !== 'string' || !root || typeof t?.name !== 'string' || !t.name) return '';
  const rel = t.dir ? String(t.dir).split('/').join(path.sep) : '';
  return path.resolve(root, rel, t.name);
}

/**
 * True when `t` drops out of the catalog only because another library folder now owns that
 * file: its folder became a root of its own, or its root was folded back into a parent that
 * is still a library folder. A folder that was simply removed does not qualify.
 */
export function trackReturns(oldRoots, t, newRoots) {
  const oldRoot = oldRoots?.[t?.root];
  if (typeof oldRoot !== 'string' || !oldRoot || !Array.isArray(newRoots)) return false;
  const norm = (p) => path.resolve(String(p));
  const oldAbs = norm(oldRoot);
  const nested = nestedRoots(newRoots);
  const idx = newRoots.findIndex((r) => norm(r) === oldAbs);
  if (idx >= 0) return inNestedRoot(t.dir || '', nested[idx]);
  return newRoots.some((r) => {
    const rel = path.relative(norm(r), oldAbs);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

/**
 * `{ from, to }` for each file (same `trackPlace`) whose id changed. A file that only left,
 * or one that was never here, is not a move. The first old id at a place wins.
 */
export function idMoves(oldRoots, oldTracks, newRoots, newTracks) {
  const byPlace = new Map();
  const placeOf = (roots, t) => (typeof t?.place === 'string' && t.place ? t.place : trackPlace(roots, t));
  for (const t of oldTracks || []) {
    if (!t?.id) continue;
    const p = placeOf(oldRoots, t);
    if (!p || byPlace.has(p)) continue;
    byPlace.set(p, t.id);
  }
  const used = new Set();
  const moves = [];
  for (const t of newTracks || []) {
    if (!t?.id) continue;
    const p = placeOf(newRoots, t);
    if (!p) continue;
    const from = byPlace.get(p);
    if (!from || from === t.id || used.has(from)) continue;
    used.add(from);
    moves.push({ from, to: t.id });
  }
  return moves;
}

/**
 * Moves records in a plain object (or a null-prototype map) from `from` to `to`.
 * A destination that already holds a record, and is not itself moving away, is left alone
 * and the source stays — a swap or a chain still moves. Returns how many records moved.
 */
export function rekeyRecords(records, moves) {
  if (!records || typeof records !== 'object') return 0;
  const list = [];
  for (const m of moves || []) {
    if (!m || typeof m.from !== 'string' || typeof m.to !== 'string' || m.from === m.to) continue;
    if (!Object.hasOwn(records, m.from)) continue;
    list.push(m);
  }
  const sources = new Set(list.map((m) => m.from));
  const blocked = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of list) {
      if (blocked.has(m.from)) continue;
      const leaving = sources.has(m.to) && !blocked.has(m.to);
      if (Object.hasOwn(records, m.to) && !leaving) {
        blocked.add(m.from);
        changed = true;
      }
    }
  }
  const snap = new Map();
  for (const m of list) {
    if (blocked.has(m.from)) continue;
    snap.set(m.from, records[m.from]);
  }
  for (const from of snap.keys()) delete records[from];
  for (const m of list) {
    if (!snap.has(m.from)) continue;
    records[m.to] = snap.get(m.from);
  }
  return snap.size;
}
