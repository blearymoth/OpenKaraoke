// Queue ordering and ETA helpers (pure functions, PLAN §6.3).

const lead = (e) => e?.singerIds?.[0] || null;

/**
 * Round number of every queue entry: how many earlier entries the same lead
 * singer has (the singer on stage counts as one entry in round 0).
 */
export function rounds(queue, currentSingerId = null) {
  const seen = new Map();
  if (currentSingerId) seen.set(currentSingerId, 1);
  return queue.map((e) => {
    const s = lead(e);
    if (!s) return 0;
    const r = seen.get(s) || 0;
    seen.set(s, r + 1);
    return r;
  });
}

/**
 * Where to insert `entry` in `queue`.
 * @param {object} o
 * @param {'rotation'|'fifo'} o.mode
 * @param {boolean} o.newcomersFirst
 * @param {string|null} o.currentSingerId lead singer of the song on stage
 * @param {(singerId: string) => boolean} o.hasSung has sung tonight
 * @param {number} [o.minIndex] never insert before this index (protects "up next")
 */
export function insertIndex(queue, entry, { mode = 'rotation', newcomersFirst = true, currentSingerId = null, hasSung = () => false, minIndex = 0 } = {}) {
  const s = lead(entry);
  if (mode === 'fifo' || !s) return queue.length;
  const r = rounds(queue, currentSingerId);
  let k = queue.filter((e) => lead(e) === s).length;
  if (s === currentSingerId) k += 1;

  if (newcomersFirst && k === 0 && !hasSung(s)) {
    // after the last round-0 entry of someone who hasn't sung yet either
    let idx = -1;
    for (let i = 0; i < queue.length; i++) {
      if (r[i] === 0 && !hasSung(lead(queue[i]))) idx = i;
    }
    return Math.max(minIndex, Math.min(queue.length, idx + 1));
  }
  let idx = -1;
  for (let i = 0; i < queue.length; i++) if (r[i] <= k) idx = i;
  return Math.max(minIndex, Math.min(queue.length, idx + 1));
}

/**
 * Seconds until each queue entry starts.
 * @param {object[]} queue entries with `dur` (s) and `tempo`
 * @param {object} o
 * @param {number} o.currentRemaining seconds left of the song on stage (incl. intro)
 * @param {number} o.countdown intro seconds per song
 * @param {number} [o.gap] extra seconds between songs
 */
export function etas(queue, { currentRemaining = 0, countdown = 10, gap = 5 } = {}) {
  const out = [];
  let t = Math.max(0, currentRemaining) + (currentRemaining > 0 ? gap : 0);
  for (const e of queue) {
    out.push(Math.round(t + countdown));
    t += countdown + (e.dur || 210) / (e.tempo || 1) + gap;
  }
  return out;
}

/** Fisher–Yates shuffle that keeps the rotation fair (shuffles within rounds). */
export function shuffleFair(queue, currentSingerId = null, rng = Math.random) {
  const r = rounds(queue, currentSingerId);
  const byRound = new Map();
  queue.forEach((e, i) => {
    let list = byRound.get(r[i]);
    if (!list) byRound.set(r[i], (list = []));
    list.push(e);
  });
  const out = [];
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const list = byRound.get(round);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    out.push(...list);
  }
  return out;
}
