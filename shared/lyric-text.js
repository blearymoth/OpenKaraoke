// The TV's lyrics as real text (PLAN §9.7): a song autokaraoke made has its words and their times
// (`NAME.timing.json`, shared/timing.js), so the two-line and scrolling layouts (§9.6) can draw the
// words in the skin's font instead of re-arranging the disc's pixels. Pure: the lines and their
// wipe come from the song time; the colours from the disc's own colour table, made readable as
// the disc's are (shared/lyrics.js).
import { readTiming } from './timing.js';
import { readablePalette, contrast, deltaE } from './lyrics.js';
import { CDG_INSTR, CDG_PACKET_SIZE } from './cdg.js';

/** autokaraoke's colour-table entries (its render.py): the background, unsung and sung words. */
export const BG = 0;
export const UNSUNG = 1;
export const SUNG = 2;
/** autokaraoke's "classic" theme (4-bit RGB × 17): the colours when the disc's can't be read. */
export const CLASSIC = { bg: [0, 0, 51], unsung: [255, 255, 255], sung: [255, 187, 0] };
const SAME = 0.08; // OKLab distance under which sung and unsung look alike: not a wipe to follow

/**
 * The song's lines for the layouts: { start, end, text, words: [{ text, start, end }] } in sung
 * order (from a timing.json's contents; anything else → []). start/end: its first word's start and
 * its last word's end, as the disc's lines (shared/lyric-lines.js) have them.
 */
export function textLines(timing) {
  let song;
  try {
    song = readTiming(timing);
  } catch {
    return [];
  }
  return song.lines
    .filter((l) => l.words.length)
    .map((l) => ({
      start: l.words[0].start,
      end: Math.max(l.words[0].start, ...l.words.map((w) => w.end)),
      text: l.words.map((w) => w.text).join(' '),
      words: l.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    }));
}

/**
 * Lines wider than `maxW` split at spaces (each piece keeps its words and their times), so no
 * line is drawn smaller than the rest. `widthOf(text)`: the width of a text at the chosen size.
 */
export function wrapLines(lines, widthOf, maxW) {
  const out = [];
  for (const l of lines) {
    if (widthOf(l.text) <= maxW || l.words.length < 2) {
      out.push(l);
      continue;
    }
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      out.push({ start: cur[0].start, end: Math.max(...cur.map((w) => w.end)), text: cur.map((w) => w.text).join(' '), words: cur });
      cur = [];
    };
    for (const w of l.words) {
      const next = [...cur, w];
      if (cur.length && widthOf(next.map((x) => x.text).join(' ')) > maxW) flush();
      cur.push(w);
    }
    flush();
  }
  return out;
}

/**
 * How far the wipe has got along a line at song time t: an x from the line's left edge, in the
 * units of `xs` (each word's left edge) and `ws` (its width). A word fills from its start to its
 * end; between words the wipe waits at the end of the last one sung.
 */
export function wipeAt(words, xs, ws, t) {
  let x = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (t < w.start) break;
    if (t >= w.end) {
      x = xs[i] + ws[i];
      continue;
    }
    x = xs[i] + (ws[i] * (t - w.start)) / Math.max(1e-3, w.end - w.start);
    break;
  }
  return x;
}

/** The background, unsung and sung colours of the disc's first colour table ([r, g, b] 0–255), or null. */
export function discTextColours(bytes) {
  if (!bytes) return null;
  const end = Math.min(bytes.length, CDG_PACKET_SIZE * 3000); // its first 10 s
  for (let off = 0; off + CDG_PACKET_SIZE <= end; off += CDG_PACKET_SIZE) {
    if ((bytes[off] & 0x3f) !== 9 || (bytes[off + 1] & 0x3f) !== CDG_INSTR.LOAD_COLORS_LOW) continue;
    const at = (c) => {
      const hi = bytes[off + 4 + c * 2] & 0x3f;
      const lo = bytes[off + 5 + c * 2] & 0x3f;
      return [(hi >> 2) & 15, ((hi & 3) << 2) | ((lo >> 4) & 3), lo & 15].map((v) => v * 17);
    };
    const c = { bg: at(BG), unsung: at(UNSUNG), sung: at(SUNG) };
    // (another maker's table, or words the same colour sung and unsung: not a wipe to follow)
    if (deltaE(c.unsung, c.sung) < SAME || contrast(c.unsung, c.bg) < 1.5) return null;
    return c;
  }
  return null;
}

/**
 * Any disc's colours, from its sung lines (shared/lyric-lines.js analysis): the unsung and sung
 * colours most of its letters turn between, and the background. For a disc's own words (PLAN
 * §31.16), whose colour table isn't autokaraoke's. → { bg, unsung, sung } or null (no lines).
 */
export function analysisTextColours(analysis) {
  const lines = analysis?.ok ? analysis.lines : null;
  if (!lines?.length) return null;
  const pairs = new Map(); // "unsung,sung" (colour-table entries) → pixels
  for (const l of lines) {
    for (let i = 0; i < l.at.length; i++) {
      // (a background pixel that turns is a highlight bar behind the letters, not a letter)
      if (!(l.at[i] > 0) || l.unsung[i] === l.main || (l.K >> l.unsung[i]) & 1) continue;
      const k = `${l.unsung[i]},${l.sung[i]}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  let best = null;
  for (const [k, n] of pairs) if (!best || n > best[1]) best = [k, n];
  if (!best) return null;
  const [u, g] = best[0].split(',').map(Number);
  const pal = lines[0].palette;
  const at = (c) => [pal[c * 3], pal[c * 3 + 1], pal[c * 3 + 2]];
  const c = { bg: at(lines[0].main), unsung: at(u), sung: at(g) };
  return deltaE(c.unsung, c.sung) < SAME ? null : c;
}

/**
 * The colours the words are drawn in: the disc's (or CLASSIC), as they are for look 'disc', else
 * made readable on the panel exactly as a disc's lyrics are (every colour 7:1 on the plate, sung
 * and unsung kept apart). → { bg, unsung, sung }
 */
export function textColours(look, disc, plate) {
  const c = disc || CLASSIC;
  if (look === 'disc') return { bg: c.bg, unsung: c.unsung, sung: c.sung };
  const palette = new Uint8Array(48);
  palette.set(c.bg, BG * 3);
  palette.set(c.unsung, UNSUNG * 3);
  palette.set(c.sung, SUNG * 3);
  const K = 0xffff & ~((1 << UNSUNG) | (1 << SUNG)); // (only the two word colours are fills)
  const { rgb } = readablePalette(palette, K, BG, null, plate || { rgb: [0, 0, 0], a: 0.9 });
  const at = (i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
  return { bg: c.bg, unsung: at(UNSUNG), sung: at(SUNG) };
}
