// When and where the sung lines of a disc (shared/lyric-lines.js) show in the TV's other lyric
// layouts (docs/PLAN.md §9.6). Pure functions of the song time: every frame, every screen (the TV,
// a mirror, the host's preview) and every replay of a moment draws the same thing, and nothing can
// move but what the plan moves.
//   - two lines ('lines'): two places, one above the other. Lines take them in turn: line j is in
//     place j % 2 of its verse. A line comes in when the line two before it is done, so the line
//     being sung and the next one are always both up; a line never moves once it is shown.
//   - scrolling ('scroll'): every line in one column; the line being sung is in focus, and the
//     column glides to the next line just before it starts (half a second, eased in and out).
// A pause of more than BREAK seconds between two lines starts a new verse: the lines come in
// LEAD seconds before it, and the screen is clear while nothing is coming up.

export const BREAK = 8; // s between two lines: a new verse
export const LEAD = 4; // s before a verse's first line: its first two lines come in (two lines)
export const TAIL = 1.5; // s after a verse's last line: its lines go
export const HOLD = 0.25; // s a sung line stays, at most, before it makes way
export const SWAP = 0.1; // s between a line going and the line after next taking its place
export const MIN_LEAD = 1; // s: a line comes in at least this long before it is sung, when the line two before is sung by then
export const FADE_IN = 0.25; // s
export const FADE_OUT = 0.15; // s
export const COUNTDOWN = 3; // s of dots before a line that comes after a pause…
export const COUNT_GAP = 3.5; // …of at least this many seconds (or starts a verse)
export const MOVE = 0.45; // s: the scrolling list's glide to the next line
export const FOCUS_EARLY = 2.5; // s: after a pause, the next line is in focus this long before it starts
export const TOGETHER = 0.5; // s: lines that start this close are sung together (a duet): one stop between them

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Smoothstep: starts and ends at rest, never overshoots. */
export const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Verses: [first, last] line indices, split where the pause between lines is longer than BREAK. */
export function verses(lines) {
  const out = [];
  for (let j = 0; j < lines.length; j++) {
    if (!j || lines[j].start - lines[j - 1].end > BREAK) out.push([j, j]);
    else out[out.length - 1][1] = j;
  }
  return out;
}

/** Does line j get a countdown (the first of a verse, or after a pause of COUNT_GAP)? */
export function counted(lines, j) {
  return j === 0 || lines[j].start - lines[j - 1].end >= COUNT_GAP;
}

/**
 * The two-line plan: per line { slot (0 top, 1 bottom), in, out (s) }. A line is shown (fading
 * in) from `in` and fades out from `out`; out ≥ its end (never taken away before it is sung). A
 * sung line stays up to HOLD s and the next line in its place comes SWAP s after it has gone; when
 * that would leave the new line less than MIN_LEAD s before it is sung (the line between is very
 * short), the sung line goes at once and the new one comes as it goes: up before its singing starts
 * whenever the line two before is sung by then.
 */
export function twoLinePlan(lines) {
  const plan = lines.map(() => ({ slot: 0, in: 0, out: 0 }));
  let free = -Infinity; // when the previous verse has gone
  for (const [g0, g1] of verses(lines)) {
    const show = Math.max(lines[g0].start - LEAD, free);
    for (let j = g0; j <= g1; j++) {
      const p = plan[j];
      p.slot = (j - g0) % 2;
      if (j < g0 + 2) p.in = show;
      else {
        const before = plan[j - 2];
        const late = lines[j].start - MIN_LEAD - FADE_OUT - SWAP; // the latest it may go for a MIN_LEAD
        if (before.out > late) before.out = Math.max(lines[j - 2].end, late, before.in + FADE_IN);
        p.in = before.out + FADE_OUT + (before.out + FADE_OUT + SWAP <= lines[j].start - MIN_LEAD ? SWAP : 0);
      }
      if (j + 2 <= g1) p.out = lines[j].end + clamp((lines[j + 2].start - lines[j].end) * 0.15, 0.1, HOLD);
      else p.out = lines[g1].end + TAIL;
      p.out = Math.max(p.out, lines[j].end, p.in + FADE_IN);
    }
    free = plan[g1].out + FADE_OUT + SWAP;
  }
  return plan;
}

/** How visible a planned line is at t (0–1). */
export function shown(p, t) {
  if (t < p.in || t >= p.out + FADE_OUT) return 0;
  if (t < p.in + FADE_IN) return (t - p.in) / FADE_IN;
  if (t >= p.out) return 1 - (t - p.out) / FADE_OUT;
  return 1;
}

/**
 * The scrolling plan: the stops of the focus, one per line (or per group of lines sung together,
 * TOGETHER s apart at most: the focus stops between them). Stop s is reached by a glide from
 * `at[s]` to `at[s] + MOVE`, normally ending as its lines start, but never beginning before the
 * lines before are nearly done; after a pause the next line comes into focus FOCUS_EARLY before it
 * starts. Glides never overlap. → { at, to (the focus: a fractional line index), stop (per line) }
 */
export function scrollPlan(lines) {
  const at = [];
  const to = [];
  const stop = new Int32Array(lines.length);
  let first = 0;
  let prevEnd = -Infinity; // the latest end among the lines of the previous stop
  let glideEnd = -Infinity;
  for (let j = 0; j < lines.length; j++) {
    if (j && lines[j].start - lines[first].start < TOGETHER) {
      stop[j] = at.length - 1;
      to[to.length - 1] = (first + j) / 2;
      continue;
    }
    if (j) {
      for (let i = first; i < j; i++) prevEnd = Math.max(prevEnd, lines[i].end);
      const gap = lines[j].start - prevEnd;
      let t = gap > COUNTDOWN ? Math.max(prevEnd + 0.5, lines[j].start - FOCUS_EARLY) : Math.max(prevEnd - 0.1, lines[j].start - MOVE);
      t = Math.min(t, lines[j].start); // (lines that overlap the ones before: the glide starts with them)
      t = Math.max(t, glideEnd);
      at.push(t);
      glideEnd = t + MOVE;
    } else {
      at.push(-Infinity);
    }
    to.push(j);
    stop[j] = at.length - 1;
    first = j;
  }
  return { at: Float64Array.from(at), to: Float64Array.from(to), stop };
}

/** Where the focus is at t: a fractional stop index (s + u: gliding from stop s to s + 1, u eased). */
export function stopAt(plan, t) {
  const { at } = plan;
  let lo = 0;
  let hi = at.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? 0 : lo - 1 + ease((t - at[lo]) / MOVE);
}

/** The focus at t: a fractional line index (between lines sung together, their middle). */
export function focusAt(plan, t) {
  const { to } = plan;
  if (!to.length) return 0;
  const s = stopAt(plan, t);
  const s0 = Math.floor(s);
  return s0 + 1 < to.length ? to[s0] + (to[s0 + 1] - to[s0]) * (s - s0) : to[s0];
}

export const UPCOMING = 0.6; // the scrolling list's lines to come, against 1 for the line in focus…
export const SUNG = 0.38; // …and the ones sung

/** Opacity of a line `d` lines below the focus (negative: above, already sung). */
export function scrollAlpha(d) {
  if (d >= 0.5) return UPCOMING;
  if (d <= -0.5) return SUNG;
  return d >= 0 ? 1 - (d / 0.5) * (1 - UPCOMING) : 1 + (d / 0.5) * (1 - SUNG);
}

/** Countdown dots over line j at t: 3, 2, 1 in its last COUNTDOWN seconds, else 0. */
export function countdownAt(lines, j, t) {
  if (!counted(lines, j)) return 0;
  const left = lines[j].start - t;
  return left > 0 && left <= COUNTDOWN ? Math.ceil(left) : 0;
}

/**
 * The scale of a song's lines: device pixels per CD+G pixel, the same for every line (the words
 * never change size). The widest line fits `width` (with a margin); in the scrolling list about
 * `rows` lines fit `height`. `whole`: a whole number (the disc's square pixels).
 */
export function lineScale(lines, width, height, { rows = 2, gap = 10, whole = false } = {}) {
  let w = 1;
  let h = 1;
  for (const l of lines) {
    w = Math.max(w, l.w);
    h = Math.max(h, l.h);
  }
  const k = Math.min((width * 0.96) / w, height / (rows * (h + gap)));
  return whole && k >= 1 ? Math.floor(k) : k; // (below one, as in the host's small preview: shrunk, filtered)
}
