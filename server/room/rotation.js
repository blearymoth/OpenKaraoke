// Queue ordering (PLAN §6.3). Pure functions, no state — unit tested in test/rotation.test.js.
//
// Rotation: round-robin by lead singer. An entry's round is how many earlier queue entries
// the same lead singer has (the singer on stage counts as one entry in round 0). A new entry
// for a singer with k entries gets round k and goes after the last entry whose round ≤ k.
// Newcomers first: a singer who hasn't sung tonight and has nothing queued goes before the
// round-0 entries of people who already sang.

/** Lead singer key of an entry; entries without a singer rotate on their own. */
export function leadOf(entry) {
  return entry.singerIds?.[0] || `entry:${entry.id}`;
}

/** Round number of every entry in `queue`. */
export function rounds(queue, currentLead = null) {
  const seen = new Map();
  if (currentLead) seen.set(currentLead, 1);
  return queue.map((e) => {
    const k = leadOf(e);
    const r = seen.get(k) || 0;
    seen.set(k, r + 1);
    return r;
  });
}

/**
 * Where to insert `entry` into `queue`.
 * @param {object[]} queue
 * @param {object} entry
 * @param {object} opts
 * @param {'rotation'|'fifo'} [opts.mode]
 * @param {boolean} [opts.newcomersFirst]
 * @param {string|null} [opts.currentLead] lead singer of the song being performed
 * @param {(lead: string) => boolean} [opts.hasSung] whether that singer already sang tonight
 */
export function insertIndex(queue, entry, { mode = 'rotation', newcomersFirst = true, currentLead = null, hasSung = () => false } = {}) {
  if (mode !== 'rotation') return queue.length;
  const lead = leadOf(entry);
  const isSingerless = (l) => l.startsWith('entry:');
  const r = rounds(queue, currentLead);
  const k = queue.reduce((n, e) => n + (leadOf(e) === lead ? 1 : 0), 0) + (lead === currentLead ? 1 : 0);

  // Newcomer: goes right before the first round-0 entry of someone who already sang.
  if (newcomersFirst && k === 0 && !isSingerless(lead) && !hasSung(lead)) {
    for (let i = 0; i < queue.length; i++) {
      const l = leadOf(queue[i]);
      if (r[i] === 0 && !isSingerless(l) && hasSung(l)) return i;
    }
  }
  let idx = 0;
  for (let i = 0; i < queue.length; i++) if (r[i] <= k) idx = i + 1;
  return idx;
}

/**
 * Seconds until each queue entry starts.
 * @param {object[]} queue entries with `dur` (s) and `tempo`
 * @param {object} opts
 * @param {number} [opts.remaining] seconds left of the current song
 * @param {boolean} [opts.hasCurrent]
 * @param {number} [opts.countdown] intro countdown between songs
 * @param {number} [opts.gap] extra seconds per changeover (walking up, applause…)
 */
export function etas(queue, { remaining = 0, hasCurrent = false, countdown = 10, gap = 5 } = {}) {
  const change = countdown + gap;
  let t = hasCurrent ? Math.max(0, remaining) + change : 0;
  return queue.map((e) => {
    const eta = t;
    t += (e.dur || 180) / (e.tempo || 1) + change;
    return Math.round(eta);
  });
}

/** Fisher–Yates shuffle (copy). `rng` is injectable for tests. */
export function shuffled(list, rng = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
