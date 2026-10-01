// Roulette wheel constants and geometry, shared by the server (server/games/wheel.js) and the
// TV / phones (public/js/games/wheel.js). Isomorphic: no Node or DOM APIs here.
//
// Geometry: segment i covers the angles [i·s, (i+1)·s) clockwise from 12 o'clock, s = 360/n.
// The wheel turns clockwise by `rotation` degrees; the pointer is fixed at the top, so it points
// at the wheel angle (−rotation mod 360).

export const WHEEL_KINDS = ['songs', 'singers', 'dares', 'genres', 'duets'];
export const WHEEL_KIND_LABELS = {
  songs: 'Songs',
  singers: 'Singers',
  dares: 'Dares',
  genres: 'Genres',
  duets: 'Duet pairs',
};
export const WHEEL_MIN_SEGMENTS = 6;
export const WHEEL_MAX_SEGMENTS = 12;
export const MAX_DARES = 40;
export const MAX_DARE_LENGTH = 100;
export const SPIN_SECONDS = 6;

/** Fun, clean party dares (the host can edit the list before starting). */
export const DEFAULT_DARES = [
  'Sing your next song in a fake accent',
  'Play a 10-second air guitar solo',
  'Sing the next chorus like an opera star',
  'Dance like a robot until the next spin',
  'Hum a song — the room has to guess it',
  'Give a 20-second award acceptance speech',
  'Sing “Happy Birthday” like a rock star',
  'Strike your best album-cover pose',
  'Invent a dance move and teach it to everyone',
  'Beatbox for 15 seconds',
  'Talk like a pirate until your next song',
  'Pick a duet partner for your next song',
  'Compliment everyone in the room in 30 seconds',
  'Sing a nursery rhyme as a power ballad',
  'Do your best game-show host intro for the next singer',
  'Lead the room in a slow-motion wave',
];

/**
 * Palette for the segments: 12 distinct colours (neighbours never match), as CSS tokens that each
 * skin defines in /css/base.css (--wheel-1…12), with a readable label colour for each
 * (--wheel-ink-1…12).
 */
export const WHEEL_COLORS = Array.from({ length: 12 }, (_, i) => `var(--wheel-${i + 1})`);
export const WHEEL_INKS = Array.from({ length: 12 }, (_, i) => `var(--wheel-ink-${i + 1})`);

const mod = (a, n) => ((a % n) + n) % n;

/** Palette index of segment i of n (the last one never repeats the first one's colour). */
export function segmentIndex(i, n) {
  const k = WHEEL_COLORS.length;
  return n % k === 1 && i === n - 1 ? (i + 1) % k : i % k;
}

/** Colour of segment i of n (a CSS value). */
export function segmentColor(i, n) {
  return WHEEL_COLORS[segmentIndex(i, n)];
}

/** Label colour on segment i of n (a CSS value). */
export function segmentInk(i, n) {
  return WHEEL_INKS[segmentIndex(i, n)];
}

/** The segment under the pointer when the wheel is turned by `rotation` degrees. */
export function segmentAt(rotation, n) {
  if (n <= 1) return 0;
  const a = mod(-rotation, 360);
  return Math.min(n - 1, Math.floor(a / (360 / n)));
}

/**
 * Final rotation of a spin that starts at `from` degrees, makes `turns` full turns and stops
 * with the pointer at `offset` (0–1) of the way through segment `index` (of `n`).
 */
export function landingRotation(from, index, n, offset = 0.5, turns = 5) {
  const seg = 360 / Math.max(1, n);
  const target = mod(-(index + offset) * seg, 360);
  return from + turns * 360 + mod(target - from, 360);
}

/** Wheel deceleration: fast start, long slow-down (ease-out quart). */
export function spinEase(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 4;
}

/**
 * Rotation at server time `at` for a spin { from, to, startsAt, duration (s) }: holds at
 * `from` until startsAt, eases to `to`, then stays there.
 */
export function rotationAt(spin, at) {
  if (!spin) return 0;
  const t = (at - spin.startsAt) / (spin.duration * 1000);
  return spin.from + (spin.to - spin.from) * spinEase(t);
}
