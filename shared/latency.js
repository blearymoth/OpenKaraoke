// Round-trip latency measurement for the mic test page (/mictest), kept pure so it can be
// unit-tested in Node. The page plays a short click through the speakers, records the
// microphone in the same AudioContext and looks for the click in the recording: the distance
// between the frame the click was scheduled at and the frame it was heard at is the full
// output + input path (buffers, drivers, HDMI/TV processing, Bluetooth, the air in between).
// That is the delay a singer hears between singing and hearing themselves on the speakers.

/** Length of the test click (seconds): a burst of noise, sharp enough to time to a sample. */
export const CLICK_SECONDS = 0.004;

/** How much recording before the click is used to measure the room's noise (seconds). */
export const PRE_ROLL_SECONDS = 0.1;

/** How long after the click the recording runs (seconds); Bluetooth can take ~300 ms. */
export const LISTEN_SECONDS = 1.0;

/**
 * The test click: CLICK_SECONDS of deterministic white noise with 0.25 ms fades, so the same
 * click is played every time and the onset is broadband (speakers and mics keep some of it).
 */
export function makeClick(sampleRate) {
  const n = Math.max(8, Math.round(CLICK_SECONDS * sampleRate));
  const fade = Math.max(1, Math.round(0.00025 * sampleRate));
  const out = new Float32Array(n);
  let seed = 0x2f6b9a1d;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const white = seed / 0x80000000 - 1;
    const env = Math.min(1, (i + 1) / fade, (n - i) / fade);
    out[i] = white * 0.9 * env;
  }
  return out;
}

const rms = (a, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

/**
 * Finds the click in a mono recording.
 * @param {Float32Array} samples the recording
 * @param {number} clickIndex index in `samples` of the frame the click was scheduled to play at
 * @param {number} sampleRate
 * @returns {{ ms: number|null, snr: number, peak: number, reason?: string }}
 *   ms is null when the click could not be told apart from the room noise.
 */
export function findArrival(samples, clickIndex, sampleRate) {
  const start = Math.max(0, Math.min(samples.length, clickIndex));
  if (start < 16 || samples.length - start < 16) return { ms: null, snr: 0, peak: 0, reason: 'too short' };
  const noise = Math.max(rms(samples, 0, start), 1e-5);
  // the loudest point after the click was scheduled
  let peak = 0;
  let peakAt = start;
  for (let i = start; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) { peak = v; peakAt = i; }
  }
  const snr = peak / noise;
  if (snr < 10) return { ms: null, snr, peak, reason: 'quiet' };
  // the onset: the first sample, going back from the peak, of the run of loud samples that leads
  // to it (gaps of up to 2 ms of quieter samples are part of the same sound). A short loud noise
  // before the click (a cough, a bump) is not part of that run, so it is ignored.
  const threshold = Math.max(peak * 0.2, noise * 6);
  const gap = Math.round(0.002 * sampleRate);
  let onset = peakAt;
  let quiet = 0;
  for (let i = peakAt; i >= start; i--) {
    if (Math.abs(samples[i]) >= threshold) { onset = i; quiet = 0; } else if (++quiet > gap) break;
  }
  return { ms: ((onset - start) / sampleRate) * 1000, snr, peak };
}

/** Median and spread of several measurements (nulls are the clicks that were not heard). */
export function summarize(values) {
  const ok = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!ok.length) return { median: null, min: null, max: null, spread: null, heard: 0, total: values.length };
  const mid = ok.length >> 1;
  const median = ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
  return { median, min: ok[0], max: ok[ok.length - 1], spread: ok[ok.length - 1] - ok[0], heard: ok.length, total: values.length };
}

/**
 * What a round trip means for live mic effects (rules of thumb for singers hearing themselves
 * on speakers; reverb and echo hide a little more delay than a dry voice).
 */
export function verdict(ms) {
  if (ms == null) return { level: 'unknown', title: 'No result', text: 'The click was not heard.' };
  if (ms < 12) return { level: 'great', title: 'Great', text: 'Feels instant. Software mic effects will work well.' };
  if (ms < 22) return { level: 'good', title: 'Good', text: 'Most singers will not notice. Fine for software effects.' };
  if (ms < 35) return { level: 'fair', title: 'Borderline', text: 'Noticeable on a dry voice; reverb or echo hides most of it. Worth trying lower settings.' };
  return { level: 'bad', title: 'Too slow for live sound', text: 'Singers will hear themselves late. Use a hardware mixer for the mics, or system-level effects with a low-latency setup.' };
}
