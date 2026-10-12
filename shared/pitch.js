// Pitch rings (PLAN §13.9): pitch maths shared by the TV (it listens) and the tests.
// The singer's pitch moves a ball; a ring is cleared when that pitch is inside its hole.
// This does not grade a karaoke song — CDG has no melody (§13.8).
//
// The detector is YIN (de Cheveigné & Kawahara, 2002) on a float time-domain buffer.
// Octaves fold onto the pitch class (±600 cents) so a singer an octave off still lines up.

/** Frequencies the server will keep from a TV report. */
export const HZ_MIN = 50;
export const HZ_MAX = 2000;
/** The TV reports a pitch about this often while a run is in the air. */
export const HZ_INTERVAL_MS = 100;
/** A ring is cleared when the singer is at most this many cents from its centre. */
export const HOLE_CENTS = 80;

const RMS_FLOOR = 0.01;
const YIN_THRESHOLD = 0.15;
/** YIN searches this rate (a pure tone stays within a few cents; the browser stays cheap). */
const DETECT_RATE = 16000;

const MIDI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** Equal temperament, A4 = 440. `name` is like "G4" or "F#5". */
export function noteHz(name) {
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!m || !Object.hasOwn(MIDI, m[1])) return 0;
  const midi = (Number(m[2]) + 1) * 12 + MIDI[m[1]];
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Major scale across one octave, inclusive of the top note (Low G3–G4, Mid C4–C5, High G4–G5). */
export const SCALES = {
  low: ['G3', 'A3', 'B3', 'C4', 'D4', 'E4', 'F#4', 'G4'],
  mid: ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'],
  high: ['G4', 'A4', 'B4', 'C5', 'D5', 'E5', 'F#5', 'G5'],
};

/** Notes of a range as `{ name, hz }`. Unknown ranges use Mid. */
export function scaleNotes(range) {
  const names = Object.hasOwn(SCALES, range) ? SCALES[range] : SCALES.mid;
  return names.map((name) => ({ name, hz: noteHz(name) }));
}

/**
 * `count` notes from the range. `rng(n)` is a uniform integer in [0, n).
 * Never the same note twice in a row (a one-note scale can't help that).
 */
export function pickNotes(range, count, rng) {
  const scale = scaleNotes(range);
  const out = [];
  let prev = -1;
  const n = Math.max(0, count | 0);
  for (let i = 0; i < n; i++) {
    let j = scale.length > 1 ? rng(scale.length) : 0;
    if (scale.length > 1 && j === prev) j = (j + 1 + rng(scale.length - 1)) % scale.length;
    prev = j;
    out.push(scale[j]);
  }
  return out;
}

/** Cents from `targetHz` up to `hz` (positive = sharp). No octave folding. */
export function centsBetween(hz, targetHz) {
  return 1200 * Math.log2(hz / targetHz);
}

/** Fold cents into (−600, 600]: an octave away is 0, not ±1200. */
export function foldCents(cents) {
  if (!Number.isFinite(cents)) return 0;
  let c = cents % 1200;
  if (c > 600) c -= 1200;
  else if (c <= -600) c += 1200;
  return c;
}

/** Folded cents from `targetHz` to `hz` (negative = flat). */
export function centsOff(hz, targetHz) {
  if (!(hz > 0) || !(targetHz > 0)) return null;
  return foldCents(centsBetween(hz, targetHz));
}

/** A usable voiced frequency (finite, inside HZ_MIN…HZ_MAX). */
export function voicedHz(hz) {
  return typeof hz === 'number' && Number.isFinite(hz) && hz >= HZ_MIN && hz <= HZ_MAX;
}

/**
 * Where `hz` sits in the octave that starts at `lowHz`, from 0 (the low note) up to 1.
 * Octaves wrap, so the same pitch class — a singer an octave off — lands on the same height.
 * Null when there is no usable pitch: the ball falls to the bottom.
 */
export function pitchHeight(hz, lowHz) {
  if (!voicedHz(hz) || !(lowHz > 0)) return null;
  const wrapped = ((centsBetween(hz, lowHz) % 1200) + 1200) % 1200;
  return wrapped / 1200;
}

/** True when a voiced pitch is inside the ring's hole (octave-folded cents). Silence is a miss. */
export function hit(hz, targetHz) {
  if (!voicedHz(hz) || !(targetHz > 0)) return false;
  const off = centsOff(hz, targetHz);
  return off != null && Math.abs(off) <= HOLE_CENTS;
}

function rmsOf(samples) {
  let sum = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return n ? Math.sqrt(sum / n) : 0;
}

/** Remove the mean so a DC offset isn't mistaken for a quiet signal. */
function demean(samples) {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean = n ? mean / n : 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i] - mean;
  return out;
}

function boxDecimate(samples, factor) {
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * factor;
    for (let k = 0; k < factor; k++) s += samples[o + k];
    out[i] = s / factor;
  }
  return out;
}

/**
 * YIN pitch of one time-domain buffer.
 * @param {ArrayLike<number>} samples −1…1
 * @param {number} sampleRate
 * @returns {{ hz: number, confidence: number, rms: number }} `hz` is 0 when the frame is quiet or low-confidence.
 */
export function detectPitch(samples, sampleRate) {
  const n0 = samples?.length || 0;
  if (n0 < 64 || !(sampleRate > 0)) return { hz: 0, confidence: 0, rms: 0 };
  let data = demean(samples);
  let rate = sampleRate;
  // Keep the search short. A box filter doesn't move a pure tone's frequency.
  const factor = rate > DETECT_RATE * 1.5 ? Math.round(rate / DETECT_RATE) : 1;
  if (factor > 1) {
    data = boxDecimate(data, factor);
    rate /= factor;
  }
  const rms = rmsOf(data);
  if (!(rms >= RMS_FLOOR)) return { hz: 0, confidence: 0, rms };
  const n = data.length;
  const half = Math.floor(n / 2);
  const tauMin = Math.max(2, Math.floor(rate / HZ_MAX));
  const tauMax = Math.min(half - 1, Math.floor(rate / HZ_MIN));
  if (tauMax <= tauMin) return { hz: 0, confidence: 0, rms };

  // Difference function over a fixed window so every lag is comparable.
  const width = n - tauMax;
  const diff = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < width; i++) {
      const d = data[i] - data[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }
  // Cumulative mean normalised difference. 0 = a perfect period.
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }
  // Absolute threshold, then the local minimum (the shortest period — the fundamental).
  let tau = tauMin;
  while (tau <= tauMax && cmnd[tau] > YIN_THRESHOLD) tau++;
  if (tau > tauMax) return { hz: 0, confidence: 0, rms };
  while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
  const x0 = cmnd[tau - 1];
  const x1 = cmnd[tau];
  const x2 = tau < tauMax ? cmnd[tau + 1] : x1;
  const denom = 2 * (2 * x1 - x2 - x0);
  let delta = denom !== 0 ? (x2 - x0) / denom : 0;
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.max(-1, Math.min(1, delta));
  const period = tau + delta;
  const confidence = 1 - x1;
  if (!(period > 0) || confidence < 1 - YIN_THRESHOLD) return { hz: 0, confidence, rms };
  const hz = rate / period;
  if (!voicedHz(hz)) return { hz: 0, confidence, rms };
  return { hz, confidence, rms };
}
