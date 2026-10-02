// Lead and backing vocals (isomorphic: the server resolves what a track allows, the TV mixes and
// analyses). Only what CD+G karaoke recordings really allow:
// - Lead vocal: on a multiplex (MPX) track the original singer is on one channel only (the other
//   channel is the music alone). Re-weighting the 2×2 channel matrix gives every level from "no
//   guide" to "full guide" exactly, with the music level unchanged.
// - Backing vocals are mixed into the music on both channels: only another version of the song
//   (flagged "with" / "without backing vocals") changes them.

/** The channel modes for tracks without a separate lead: [L→L, R→L, L→R, R→R]. */
export const CHANNEL_MATRIX = {
  stereo: [1, 0, 0, 1],
  left: [1, 0, 1, 0],
  right: [0, 1, 0, 1],
  mono: [0.5, 0.5, 0.5, 0.5],
  vocalcut: [0.7, -0.7, 0.7, -0.7], // (L − R) on both speakers
};

export const LEAD_MIN = 0;
export const LEAD_MAX = 100;
export const LEAD_STEP = 10;
export const LEAD_PRESETS = { off: 0, quiet: 50, full: 100 };
/** The host's corrections of a track's layout. */
export const LAYOUTS = ['auto', 'stereo', 'mpxL', 'mpxR'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A lead level 0..100 (integer), or null when `v` isn't a number. */
export function clampLead(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(clamp(n, LEAD_MIN, LEAD_MAX)) : null;
}

export function formatLead(v) {
  return v <= 0 ? 'Off' : v >= 100 ? 'Full' : `${v}%`;
}

/** Gain of the singer's channel for a lead level: the volume slider's square law (50 → −12 dB). */
export function leadGain(lead) {
  return (clamp(Number(lead) || 0, LEAD_MIN, LEAD_MAX) / 100) ** 2;
}

/**
 * The 2×2 matrix for a track. On an adjustable track (vocals.adjustable, side 'L'/'R') with the
 * singer's channel X = a·M + V and the music channel Y = M, both speakers get c·Y + g·X with
 * c = 1 − g·a, i.e. M + g·V: the music stays as it is and only the singer moves — for any a,
 * also a negative one (a channel recorded with inverted polarity) or a > 1. Otherwise the
 * channel mode's matrix.
 */
export function mixMatrix({ channel = 'stereo', vocals = null, lead = 0 } = {}) {
  if (!vocals?.adjustable || (vocals.side !== 'L' && vocals.side !== 'R')) return [...(CHANNEL_MATRIX[channel] || CHANNEL_MATRIX.stereo)];
  const g = leadGain(lead);
  const a = clamp(Number.isFinite(vocals.a) ? vocals.a : 1, -2, 2);
  const c = 1 - g * a;
  return vocals.side === 'R' ? [c, g, c, g] : [g, c, g, c];
}

/**
 * What a track allows. `flags` from its file name (mpx, vocals, bgv, nobgv), `info` the TV's
 * analysis ({ l: 'mono'|'stereo'|'mpx', s, lean, a, c: 'high'|'low' }), `override` the host's
 * correction (LAYOUTS), `findGuide` false = sound analysis alone never counts (a kill switch).
 * → { adjustable, side, a, source: 'host'|'file'|'sound'|null, mixed, ask, suggest, bgv }
 * - adjustable: the lead level works (side known).
 * - ask: the name says multiplex but nothing tells the side yet — the host is asked; until then
 *   the track plays as before (a wrong guess would play the guide singer alone).
 * - suggest: the sound alone looks like a multiplex, not surely: offered to the host, not used.
 * - mixed: the original singer is in the stereo mix ("Con Voz", "with vocals") — no lead control.
 */
export function resolveVocals({ flags = {}, info = null, override = 'auto', findGuide = true } = {}) {
  const out = { adjustable: false, side: null, a: 1, source: null, mixed: false, ask: false, suggest: null, bgv: flags.nobgv ? 'without' : flags.bgv ? 'with' : null };
  const fileSays = !!(flags.mpx || flags.vocals);
  const measuredA = (side) => (info?.l === 'mpx' && info.s === side && Number.isFinite(info.a) ? info.a : 1);
  if (override === 'stereo') return { ...out, mixed: !!flags.vocals && !flags.mpx, source: 'host' };
  if (override === 'mpxL' || override === 'mpxR') {
    const side = override === 'mpxL' ? 'L' : 'R';
    return { ...out, adjustable: true, side, a: measuredA(side), source: 'host' };
  }
  if (info?.l === 'mpx' && (info.s === 'L' || info.s === 'R') && (fileSays || (findGuide && info.c === 'high'))) {
    return { ...out, adjustable: true, side: info.s, a: measuredA(info.s), source: fileSays ? 'file' : 'sound' };
  }
  if (flags.mpx && info?.l !== 'mono') {
    const side = info?.lean === 'L' || info?.lean === 'R' ? info.lean : null;
    return side ? { ...out, adjustable: true, side, source: 'file' } : { ...out, ask: !!info, source: 'file' };
  }
  if (info?.l === 'mpx' && findGuide && (info.s === 'L' || info.s === 'R')) out.suggest = info.s;
  if (flags.vocals) out.mixed = true;
  return out;
}

/**
 * How a version's lead vocal can be used, for version lists and requests: 'adjustable' (side
 * known), 'multiplex' (named so; the side is found when the TV first decodes it), 'mixed' (in the
 * stereo mix) or null.
 */
export function leadKind(v) {
  if (!v) return null;
  if (v.adjustable) return 'adjustable';
  if (v.source === 'file' && !v.mixed) return 'multiplex';
  return v.mixed ? 'mixed' : null;
}

// ---- analysis (on the TV, from the decoded channels) ------------------------------------------

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

/**
 * Is one channel "the other one plus a singer"? Fits X ≈ a·Y (least squares) for both sides and
 * looks at the residual R = X − a·Y in 0.1 s frames, relative to the music channel: on a
 * multiplex track it is silent between the lines (intro, breaks, outro) and loud while the guide
 * sings; the other side's residual never goes quiet. `yieldEvery` (async version) lets the page
 * breathe between chunks. → { l: 'mono'|'stereo'|'mpx', s, lean, a, c, stats }
 */
export async function analyseChannelsAsync(L, R, sampleRate, { yieldEvery = 0 } = {}) {
  const pause = yieldEvery ? () => new Promise((r) => setTimeout(r, 0)) : () => null;
  if (!L || !R) return { l: 'mono', s: '', lean: '', a: 1, c: 'high' };
  const n = Math.min(L.length, R.length);
  const chunk = yieldEvery || n;
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let diff = 0;
  for (let start = 0; start < n; start += chunk) {
    const end = Math.min(n, start + chunk);
    for (let i = start; i < end; i += 2) {
      const l = L[i];
      const r = R[i];
      ll += l * l;
      rr += r * r;
      lr += l * r;
      diff += (l - r) * (l - r);
    }
    await pause();
  }
  const quietAll = 1e-6 * (n / 2);
  if (ll < quietAll || rr < quietAll) return { l: 'stereo', s: '', lean: '', a: 1, c: 'high' };
  if (diff < 1e-8 * (ll + rr)) return { l: 'mono', s: '', lean: '', a: 1, c: 'high' };
  const fit = (num, den) => clamp(num / den, -2, 2);
  const aR = fit(lr, ll); // R ≈ aR·L + V (singer on R)
  const aL = fit(lr, rr); // L ≈ aL·R + V (singer on L)
  const F = Math.max(2, Math.round(sampleRate * 0.1));
  const frames = [];
  for (let start = 0; start + F <= n; start += F) {
    let eL = 0;
    let eR = 0;
    let xR = 0;
    let xL = 0;
    for (let i = start; i < start + F; i += 2) {
      const l = L[i];
      const r = R[i];
      eL += l * l;
      eR += r * r;
      const dr = r - aR * l;
      const dl = l - aL * r;
      xR += dr * dr;
      xL += dl * dl;
    }
    frames.push([eL, eR, xL, xR]);
    if (yieldEvery && frames.length % Math.max(1, Math.round(yieldEvery / F)) === 0) await pause();
  }
  const db = (x) => 10 * Math.log10(x + 1e-12);
  /** The residual of `x` (frame index) relative to the music channel `y`, per usable frame. */
  const side = (yIdx, xIdx) => {
    const mean = frames.reduce((s, f) => s + f[yIdx], 0) / Math.max(1, frames.length);
    const rho = [];
    frames.forEach((f, i) => { if (f[yIdx] > mean * 1e-3) rho.push([db(f[xIdx] / f[yIdx]), i]); });
    const sorted = rho.map((x) => x[0]).sort((a, b) => a - b);
    return { rho, p10: percentile(sorted, 0.1), p70: percentile(sorted, 0.7) };
  };
  const onR = side(0, 3); // music channel L, singer on R
  const onL = side(1, 2); // music channel R, singer on L
  if (onR.rho.length < 60 || onL.rho.length < 60) return { l: 'stereo', s: '', lean: '', a: 1, c: 'low' };
  const qualifies = (x, y) => x.p70 - x.p10 >= 12 && y.p10 - x.p10 >= 8 && x.p70 >= -20;
  const r = qualifies(onR, onL);
  const l = qualifies(onL, onR);
  const stats = { L: { p10: +onL.p10.toFixed(1), p70: +onL.p70.toFixed(1) }, R: { p10: +onR.p10.toFixed(1), p70: +onR.p70.toFixed(1) } };
  let s = '';
  if (r && l) s = onL.p10 - onR.p10 >= onR.p10 - onL.p10 ? 'R' : 'L';
  else if (r) s = 'R';
  else if (l) s = 'L';
  let lean = '';
  if (onR.p10 <= onL.p10 - 3 && onR.p70 - onR.p10 >= 6) lean = 'R';
  else if (onL.p10 <= onR.p10 - 3 && onL.p70 - onL.p10 >= 6) lean = 'L';
  if (!s) return { l: 'stereo', s: '', lean, a: 1, c: 'low', stats };
  // Sure enough to be used without a word in the file name: a clear gap, and the quiet moments
  // (the guide not singing) spread over the song — not one instrument resting for a while.
  const x = s === 'R' ? onR : onL;
  const y = s === 'R' ? onL : onR;
  const quietAt = x.p10 + 6;
  const lo = Math.floor(frames.length * 0.1);
  const span = Math.max(1, Math.floor(frames.length * 0.8) / 5);
  const parts = new Set(x.rho.filter(([v, i]) => v <= quietAt && i >= lo && i < lo + span * 5).map(([, i]) => Math.floor((i - lo) / span)));
  const high = x.p70 - x.p10 >= 18 && y.p10 - x.p10 >= 14 && parts.size >= 3;
  return { l: 'mpx', s, lean: s, a: +(s === 'R' ? aR : aL).toFixed(3), c: high ? 'high' : 'low', stats };
}
