// Applause meter maths (PLAN §13.6), shared by the TV (it listens with the PC's microphone)
// and the server (which scores a measurement from the reported levels when the TV's final
// report never arrives). Levels and scores are 0–100.

/** dBFS of a quiet room next to a laptop microphone (level 0)… */
export const FLOOR_DB = -60;
/** …and of a roaring crowd (level 100). Mic auto-gain is switched off while measuring. */
export const CEIL_DB = -6;
/** The TV reports a level about 5× a second. */
export const LEVEL_INTERVAL_MS = 200;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Root mean square of a block of samples (−1…1). */
export function rmsOf(samples) {
  let sum = 0;
  const n = samples?.length || 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return n ? Math.sqrt(sum / n) : 0;
}

/** Loudness level 0–100 from an RMS amplitude (1 = full scale), linear in decibels. */
export function levelFromRms(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return clamp(((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)) * 100, 0, 100);
}

/** A level report is a finite number in [0, 100] (anything else is rejected). */
export function validLevel(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

/**
 * The score of one measurement from its levels (~5 per second): mostly the sustained noise
 * (the mean of the louder half of the window, so one clap doesn't win and a slow start doesn't
 * lose), plus a quarter of the loudest moment. Invalid entries are ignored.
 */
export function scoreLevels(levels) {
  const xs = (Array.isArray(levels) ? levels : []).filter(validLevel).sort((a, b) => b - a);
  if (!xs.length) return 0;
  const top = xs.slice(0, Math.ceil(xs.length / 2));
  const mean = top.reduce((a, b) => a + b, 0) / top.length;
  return Math.round(clamp(0.75 * mean + 0.25 * xs[0], 0, 100));
}
