// Readable lyrics (docs/PLAN.md §9): the TV's lyric looks and the pure maths behind them.
// Isomorphic (no DOM or Node APIs): the TV renderer (public/js/lib/lyrics-renderer.js), the
// server's settings and scripts/lyrics-check.js use it.
//   - settings: the looks, the scroll motions and the lighter-effects choices
//   - scroll smoothing: a disc that scrolls one CD+G pixel at a time is shown gliding, never
//     more than 3 CD+G pixels from where the disc puts the words
//   - content keying: which colours are the disc's background (transparent behind the lyrics),
//     held still for each screen (ScreenKeying)
//   - colour roles (fills, edges, areas), from one pass over the whole song when it loads
//   - readablePalette: every lyric colour at least 7:1 against the panel; dark words on a light
//     disc turn light; halos stop competing with the letters
import {
  CdgDecoder, CDG_INSTR, CDG_PACKET_SIZE, CDG_PACKETS_PER_SECOND, CDG_WIDTH, CDG_HEIGHT,
  CDG_VISIBLE_X, CDG_VISIBLE_Y, CDG_VISIBLE_WIDTH, CDG_VISIBLE_HEIGHT,
} from './cdg.js';

// ---- settings ---------------------------------------------------------------------------------

/** display.lyricsLook: on a dark panel, over the background with an outline, as the disc made them. */
export const LYRICS_LOOKS = ['panel', 'clear', 'disc'];
/**
 * display.lyricsLayout: the disc's own pages; two lines at a time (the line being sung and the
 * next one, karaoke-bar style); a scrolling list with the line being sung in focus (like music
 * apps). The last two re-arrange the disc's sung lines (shared/lyric-lines.js, PLAN §9.6).
 */
export const LYRICS_LAYOUTS = ['page', 'lines', 'scroll'];
/** display.lyricsMotion: glide smoothly, or step exactly like the disc. */
export const LYRICS_MOTIONS = ['smooth', 'disc'];
/** display.lighterEffects on the TV page. */
export const LIGHTER_EFFECTS = ['auto', 'on', 'off'];
export const DEFAULT_LYRICS_LOOK = 'panel';
export const DEFAULT_LYRICS_MOTION = 'smooth';
export const DEFAULT_LYRICS_LAYOUT = 'page';
export const DEFAULT_LIGHTER_EFFECTS = 'auto';

const oneOf = (list, value, fallback) => (typeof value === 'string' && list.includes(value) ? value : fallback);
export const normalizeLyricsLook = (v) => oneOf(LYRICS_LOOKS, v, DEFAULT_LYRICS_LOOK);
export const normalizeLyricsMotion = (v) => oneOf(LYRICS_MOTIONS, v, DEFAULT_LYRICS_MOTION);
export const normalizeLyricsLayout = (v) => oneOf(LYRICS_LAYOUTS, v, DEFAULT_LYRICS_LAYOUT);
export const normalizeLighterEffects = (v) => oneOf(LIGHTER_EFFECTS, v, DEFAULT_LIGHTER_EFFECTS);

// ---- constants ----------------------------------------------------------------------------------

/** Every lyric colour reaches this contrast against the panel. */
export const CONTRAST_TARGET = 7;
/** Brighter than any picture either skin leaves behind the lyrics: the 10 % the plate lets through. */
export const WORST_BACKDROP = 128;
/** Colour-table entry of the baked outline (look 'clear'). */
export const OUTLINE_INDEX = 16;
/** The CD+G pixels the smoothed scroll may be away from the disc's. */
export const MAX_SCROLL_DEVIATION = 3;

const W = CDG_WIDTH;
const H = CDG_HEIGHT;
const VW = CDG_VISIBLE_WIDTH;
const VH = CDG_VISIBLE_HEIGHT;
const WINDOW = VW * VH;
const KEY_SHARE = 0.35; // a colour covering this much of the window is background...
const KEEP_SHARE = 0.2; // ...and stays background down to this (no flicker at the threshold)
const PRESET_SHARE = 0.1; // the MEMORY_PRESET colour is background from here
const AREA_SHARE = 0.5; // a colour with this share of its pixels inside an area (8 neighbours alike) is a box, not lines
const LINE_PX = 64; // a sample counts a colour as drawn in lines from this many pixels…
const LINE_SAMPLES = 2; // …and a screen as using it for words from this many such samples
const SAME_COLOUR = 0.02; // OKLab distance under which two entries look the same
const INK_SHARE = 0.02; // colours with less of the ink get no role
const BIG_MOVE = 2; // scroll steps larger than this (page jumps) are never smoothed

// ---- colour maths (sRGB, WCAG luminance, OKLab) -----------------------------------------------

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const toByte = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

/** WCAG relative luminance of [r, g, b] (0–255). */
export function luminance([r, g, b]) {
  return 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
}

/** WCAG contrast ratio of two [r, g, b] colours (1–21). */
export function contrast(a, b) {
  const ya = luminance(a);
  const yb = luminance(b);
  return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05);
}

/** [r, g, b] (0–255) → OKLab [L, a, b]. */
export function oklab([r, g, b]) {
  const lr = LINEAR[r];
  const lg = LINEAR[g];
  const lb = LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (L, C, h) => oklabToLinear(L, C * Math.cos(h), C * Math.sin(h)).every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → [r, g, b], reducing the chroma until the colour fits sRGB (lightness and hue kept). */
export function fromOklch(L, C, h) {
  L = Math.max(0, Math.min(1, L));
  if (!inGamut(L, C, h)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(L, mid, h)) lo = mid;
      else hi = mid;
    }
    C = lo;
  }
  return oklabToLinear(L, C * Math.cos(h), C * Math.sin(h)).map((v) => toByte(Math.max(0, Math.min(1, v))));
}

/** OKLab distance (ΔE) of two [r, g, b] colours. */
export function deltaE(a, b) {
  const p = oklab(a);
  const q = oklab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const rgbAt = (palette, c) => [palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2]];

/** What is right behind the letters on the panel at worst: the plate over WORST_BACKDROP. */
export function panelBackdrop(plate) {
  const a = Number.isFinite(plate?.a) ? Math.max(0, Math.min(1, plate.a)) : 0.9;
  return [0, 1, 2].map((i) => Math.round((plate?.rgb?.[i] ?? 0) * a + WORST_BACKDROP * (1 - a)));
}

/** The colour indices of a 16-bit mask (for messages and tests). */
export function maskColours(mask) {
  const out = [];
  for (let c = 0; c < 16; c++) if ((mask >> c) & 1) out.push(c);
  return out;
}

// ---- content keying ---------------------------------------------------------------------------

/**
 * Which colours are the background of the screen `dec` (a CdgDecoder) shows: drawn transparent
 * so the panel or the picture shows instead. → { K (bit c set: colour c keyed), main (the keyed
 * colour covering the most), hist (pixels per colour in the visible window), big (the colours
 * covering ≥ 35 %) }.
 *   - colours covering ≥ 35 % of the window (kept down to 20 % when `prev` had them)
 *   - the MEMORY_PRESET colour from 10 %; the latest SCROLL_PRESET fill colour when on screen
 *   - colours the screen holds (ScreenKeying): `screen` ones always, `keep` ones while what is
 *     on screen of them is an area (most of its pixels inside a block of it), not lines of words
 *   - colours that look the same as one of those ("hidden" text a disc reveals by changing the
 *     palette stays hidden)
 *   - the border colour, when it shows nowhere but the strip the scroll offsets reveal
 * A screen with no dominant colour (a picture) gives K = 0: shown as the disc made it.
 * DEFINE_TRANSPARENT is never keyed.
 */
export function keyColours(dec, prev = 0, hist = new Uint32Array(16), { screen = 0, keep = 0 } = {}) {
  const px = dec.pixels;
  const ox = CDG_VISIBLE_X + dec.hOffset;
  const oy = CDG_VISIBLE_Y + dec.vOffset;
  hist.fill(0);
  for (let y = 0; y < VH; y++) {
    const row = (oy + y) * W + ox;
    for (let x = 0; x < VW; x++) hist[px[row + x]]++;
  }
  let K = 0;
  let big = 0;
  for (let c = 0; c < 16; c++) {
    const share = hist[c] / WINDOW;
    if (share >= KEY_SHARE) big |= 1 << c;
    if (share >= KEY_SHARE || ((prev >> c) & 1 && share >= KEEP_SHARE)) K |= 1 << c;
  }
  if (hist[dec.bgColor] / WINDOW >= PRESET_SHARE) K |= 1 << dec.bgColor;
  if (dec.scrollFill >= 0 && hist[dec.scrollFill] > 0) K |= 1 << dec.scrollFill;
  if (!K) return { K: 0, main: dec.bgColor, hist, big };
  let held = 0; // held colours not on screen: keyed (the colour table stays the same), after the look-alikes
  for (let c = 0; c < 16; c++) {
    if ((K >> c) & 1 || !(((screen | keep) >> c) & 1)) continue;
    if (!hist[c]) held |= 1 << c;
    else if ((screen >> c) & 1 || areaShare(dec, c, hist[c]) >= AREA_SHARE) K |= 1 << c;
  }
  const labs = [];
  for (let c = 0; c < 16; c++) labs.push(oklab(rgbAt(dec.palette, c)));
  const base = K;
  for (let c = 0; c < 16; c++) {
    if ((base >> c) & 1) continue;
    for (let k = 0; k < 16; k++) {
      if (!((base >> k) & 1)) continue;
      if (Math.hypot(labs[c][0] - labs[k][0], labs[c][1] - labs[k][1], labs[c][2] - labs[k][2]) < SAME_COLOUR) {
        K |= 1 << c;
        break;
      }
    }
  }
  K |= held;
  const b = dec.borderColor;
  if (!((K >> b) & 1) && !borderInside(dec, b)) K |= 1 << b;
  let main = -1;
  for (let c = 0; c < 16; c++) if ((K >> c) & 1 && (main < 0 || hist[c] > hist[main])) main = c;
  return { K, main, hist, big };
}

/** The share of colour `c`'s `n` pixels in the window that are inside an area (all 8 neighbours `c` too). */
function areaShare(dec, c, n) {
  const px = dec.pixels;
  const ox = CDG_VISIBLE_X + dec.hOffset;
  const oy = CDG_VISIBLE_Y + dec.vOffset;
  let inner = 0;
  for (let y = 0; y < VH; y++) {
    const row = (oy + y) * W + ox; // (the window never touches the memory's edge: every pixel has 8 neighbours)
    for (let x = 0; x < VW; x++) {
      const i = row + x;
      if (px[i] === c && px[i - W - 1] === c && px[i - W] === c && px[i - W + 1] === c && px[i - 1] === c && px[i + 1] === c
        && px[i + W - 1] === c && px[i + W] === c && px[i + W + 1] === c) inner++;
    }
  }
  return inner / n;
}

/**
 * Keying that holds still while a screen is up (from one MEMORY_PRESET to the next, the
 * decoder's presetCount). A box drawn or erased tile by tile (a title card) crossed 35 % and then
 * 20 % on the way: it flashed on the panel, vanished, and its last fifth came back behind the
 * words. Now a colour that has been background on this screen stays keyed while what is on screen
 * of it is still an area; and one the load-time pass saw covering 35 % at some point on this screen
 * is keyed from the start (`screens`, filled by roleStats/roleStatsAsync) — unless the screen also
 * uses it for words (drawn in lines at two samples or more): then only while it looks like an
 * area. Words in a colour that was a background earlier on the screen are never hidden.
 */
export class ScreenKeying {
  constructor() {
    /** presetCount → { big (colours ≥ 35 % at a sample), lines (per colour: samples where it was drawn in lines) } */
    this.screens = new Map();
    this.reset();
  }

  reset() {
    this.prev = 0;
    this.seen = 0; // the colours that were ≥ 35 % on this screen so far
    this.preset = -1;
  }

  /** keyColours() for `dec` at its current time, with what this screen holds. */
  key(dec, hist) {
    if (dec.presetCount !== this.preset) {
      this.reset();
      this.preset = dec.presetCount;
    }
    let screen = 0;
    let keep = this.seen;
    const s = this.screens.get(dec.presetCount);
    if (s) {
      for (let c = 0; c < 16; c++) {
        if (!((s.big >> c) & 1)) continue;
        if (s.lines[c] >= LINE_SAMPLES) keep |= 1 << c;
        else screen |= 1 << c;
      }
    }
    const r = keyColours(dec, this.prev, hist, { screen, keep });
    this.prev = r.K;
    this.seen |= r.big;
    return r;
  }
}

/** Adds a pass sample to `screens` (see ScreenKeying): `big` colours, and those drawn in lines (`stats`: addRoleStats' result). */
function noteScreen(screens, preset, big, stats) {
  let s = screens.get(preset);
  if (!s) screens.set(preset, (s = { big: 0, lines: new Uint16Array(16) }));
  s.big |= big;
  if (!stats) return;
  for (let c = 0; c < 16; c++) if (stats.count[c] >= LINE_PX && stats.interior[c] < AREA_SHARE * stats.count[c]) s.lines[c]++;
}

/** Does colour `b` show in the window outside the bottom/right strip the offsets reveal? */
function borderInside(dec, b) {
  const px = dec.pixels;
  const ox = CDG_VISIBLE_X + dec.hOffset;
  const oy = CDG_VISIBLE_Y + dec.vOffset;
  const rows = VH - dec.vOffset;
  const cols = VW - dec.hOffset;
  for (let y = 0; y < rows; y++) {
    const row = (oy + y) * W + ox;
    for (let x = 0; x < cols; x++) if (px[row + x] === b) return true;
  }
  return false;
}

// ---- colour roles -----------------------------------------------------------------------------

export function newRoleStats() {
  return { count: new Float64Array(16), interior: new Float64Array(16), sandwich: new Float64Array(16) };
}

/**
 * Adds one screen to the statistics (window `idx`, 288×192 indices; `K` keyed). Per colour:
 * pixels, "interior" pixels (all 8 neighbours the same colour) and "sandwich" pixels (touching
 * the background and another ink colour: outlines, shadows, anti-aliasing). Colours that are
 * mostly interior on this screen (boxes, pictures) count as background for the sandwich test.
 */
export function addRoleStats(stats, idx, K) {
  const w = VW;
  const cnt = new Float64Array(16);
  const inter = new Float64Array(16);
  const sand = new Float64Array(16);
  for (let y = 1; y < VH - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const p = idx[i];
      if ((K >> p) & 1) continue;
      cnt[p]++;
      if (idx[i - w - 1] === p && idx[i - w] === p && idx[i - w + 1] === p && idx[i - 1] === p && idx[i + 1] === p
        && idx[i + w - 1] === p && idx[i + w] === p && idx[i + w + 1] === p) inter[p]++;
    }
  }
  let back = K;
  for (let c = 0; c < 16; c++) if (cnt[c] > 50 && inter[c] / cnt[c] >= 0.5) back |= 1 << c;
  for (let y = 1; y < VH - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const p = idx[i];
      if ((back >> p) & 1) continue;
      const a = idx[i - 1];
      const b = idx[i + 1];
      const c = idx[i - w];
      const d = idx[i + w];
      const ba = (back >> a) & 1;
      const bb = (back >> b) & 1;
      const bc = (back >> c) & 1;
      const bd = (back >> d) & 1;
      if ((ba | bb | bc | bd) && ((!ba && a !== p) || (!bb && b !== p) || (!bc && c !== p) || (!bd && d !== p))) sand[p]++;
    }
  }
  for (let c = 0; c < 16; c++) {
    stats.count[c] += cnt[c];
    stats.interior[c] += inter[c];
    stats.sandwich[c] += sand[c];
  }
  return { count: cnt, interior: inter, sandwich: sand };
}

/**
 * One sample every `step` packets (0.5 s) of the whole song; picture screens (K = 0) are skipped.
 * With `screens` (a ScreenKeying's), notes what each screen holds. Yields the packet position.
 */
function* roleSamples(bytes, step, screens = null) {
  const dec = new CdgDecoder(bytes);
  const stats = newRoleStats();
  const idx = new Uint8Array(WINDOW);
  const hist = new Uint32Array(16);
  let prev = 0;
  let big = 0;
  let last = null;
  let lastVersion = -1;
  for (let p = step; p <= dec.packetCount; p += step) {
    dec.seek((p + 0.5) / CDG_PACKETS_PER_SECOND);
    if (dec.version === lastVersion && last) {
      // the same screen as half a second ago: count it again (statistics are time-weighted)
      for (let c = 0; c < 16; c++) {
        stats.count[c] += last.count[c];
        stats.interior[c] += last.interior[c];
        stats.sandwich[c] += last.sandwich[c];
      }
    } else {
      const r = keyColours(dec, prev, hist);
      prev = r.K;
      big = r.big;
      last = r.K ? addRoleStats(stats, dec.visibleIndices(idx), r.K) : null;
      lastVersion = dec.version;
    }
    if (screens) noteScreen(screens, dec.presetCount, big, last);
    yield p;
  }
  return stats;
}

/** The colour statistics of a whole song (synchronous: scripts and tests); `screens`: as roleSamples. */
export function roleStats(bytes, { step = 150, screens = null } = {}) {
  const it = roleSamples(bytes, step, screens);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function breathe() {
  if (typeof MessageChannel !== 'function') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      r();
    };
    ch.port2.postMessage(0);
  });
}

/**
 * The same, in slices of about `sliceMs` with a pause between them, so the TV keeps drawing
 * while a song loads; the first `syncSeconds` of the song are done before this returns (the
 * screens of a title card are known before it is drawn). Resolves to null when `cancelled()`
 * turns true (another song loaded).
 */
export async function roleStatsAsync(bytes, { step = 150, sliceMs = 8, cancelled = () => false, screens = null, syncSeconds = 0 } = {}) {
  const it = roleSamples(bytes, step, screens);
  let syncUntil = syncSeconds * CDG_PACKETS_PER_SECOND;
  for (;;) {
    const t0 = now();
    let r;
    do {
      r = it.next();
    } while (!r.done && (now() - t0 < sliceMs || r.value < syncUntil));
    if (r.done) return r.value;
    syncUntil = 0;
    await breathe();
    if (cancelled()) return null;
  }
}

/**
 * Roles from the statistics: for colours with ≥ 2 % of the ink, 'a' area (mostly interior:
 * boxes, pictures), 'e' edge (mostly sandwiched: outlines, shadows, anti-aliasing), 'f' fill
 * (the letters); '-' for the rest. → { sig (16 characters, part of the colour table's key), weight }
 */
export function rolesFromStats(stats) {
  let ink = 0;
  for (let c = 0; c < 16; c++) ink += stats.count[c];
  let sig = '';
  for (let c = 0; c < 16; c++) {
    const n = stats.count[c];
    if (!n || n < INK_SHARE * ink) sig += '-';
    else if (stats.interior[c] / n >= 0.5) sig += 'a';
    else if (stats.sandwich[c] / n >= 0.4) sig += 'e';
    else sig += 'f';
  }
  return { sig, weight: Float64Array.from(stats.count) };
}

/** Until the song's statistics are in: every colour on screen (≥ 2 % of the ink) is a fill. */
export function rolesFromHist(hist, K) {
  let ink = 0;
  for (let c = 0; c < 16; c++) if (!((K >> c) & 1)) ink += hist[c];
  let sig = '';
  for (let c = 0; c < 16; c++) sig += !((K >> c) & 1) && hist[c] && hist[c] >= INK_SHARE * ink ? 'f' : '-';
  return { sig, weight: Float64Array.from(hist) };
}

// ---- readable palette -------------------------------------------------------------------------

/**
 * The disc's 16 colours made readable on the panel (OKLab; hue and chroma kept, chroma reduced
 * only to stay inside sRGB). `palette`: 48 bytes; `K`: keyed mask; `main`: the background;
 * `roles`: { sig, weight } (null: every colour is a fill); `plate`: { rgb, a }.
 *   - polarity: letters darker than the background and dark themselves (dark words on a light
 *     disc) → every lightness is mirrored, so they end up light on the dark panel
 *   - fills (and areas) go through one monotone lightness map, set by the fill that needs the
 *     most stretch to reach 7:1 against the panel: order and differences are kept (sung and
 *     unsung stay apart); every fill then reaches 7:1
 *   - edges (halos) stay at least 0.35 L darker than the dimmest fill (not under 0.15)
 *   - a colour whose lightness doesn't change keeps its exact bytes (discs that read well are
 *     left as they are)
 * → { rgb (48 bytes), flip, fills, edges, areas }
 */
export function readablePalette(palette, K, main, roles, plate) {
  const panel = panelBackdrop(plate);
  const keyed = (c) => (K >> c) & 1;
  const labs = [];
  for (let c = 0; c < 16; c++) labs.push(oklab(rgbAt(palette, c)));
  const fills = [];
  const edges = [];
  const areas = [];
  for (let c = 0; c < 16; c++) {
    if (keyed(c)) continue;
    const role = roles ? roles.sig[c] : 'f';
    if (role === 'f') fills.push(c);
    else if (role === 'e') edges.push(c);
    else if (role === 'a') areas.push(c);
  }
  const bgL = labs[main >= 0 ? main : 0][0];
  let fillL = null;
  {
    let sum = 0;
    let n = 0;
    for (const c of fills) {
      const w = roles ? roles.weight[c] : 1;
      sum += labs[c][0] * w;
      n += w;
    }
    if (n > 0) fillL = sum / n;
  }
  const flip = fillL === null ? bgL > 0.55 : fillL < bgL && fillL < 0.5;
  const Lf = (L) => (flip ? 1 - L : L);
  // lightness is measured from the disc's background, or from the panel when the background is the lighter one
  const ref = fillL !== null && Lf(fillL) < Lf(bgL) ? oklab(panel)[0] : Lf(bgL);
  const lch = labs.map(([L, a, b]) => [Lf(L), Math.hypot(a, b), Math.atan2(b, a)]);
  const dL = lch.map(([L], c) => (keyed(c) ? 0 : L - ref));
  const meets = (L, c) => contrast(fromOklch(L, lch[c][1], lch[c][2]), panel) >= CONTRAST_TARGET;
  const need = (c) => {
    if (!meets(1, c)) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (meets(mid, c)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const needs = new Map(fills.map((c) => [c, need(c)]));
  // the stretch: set by the fill that needs it most (never below 1: contrast is never reduced)
  let dW = 0;
  let Lw = 0;
  for (const c of fills) {
    if (dL[c] <= 0.02) continue;
    const n = needs.get(c);
    if (n - ref > 0 && (n - ref) / dL[c] > (dW ? (Lw - ref) / dW : 1)) {
      dW = dL[c];
      Lw = n;
    }
  }
  const dTop = Math.max(0, ...dL);
  const Ltop = Math.min(1, Math.max(ref + dTop, Lw + 0.12));
  const map = (d) => {
    if (!dW || d <= 0) return ref + d;
    if (d <= dW) return ref + (d * (Lw - ref)) / dW;
    return dTop > dW ? Lw + ((d - dW) * (Ltop - Lw)) / (dTop - dW) : Lw;
  };
  const L = lch.map(([L0], c) => (dL[c] >= 0 && !keyed(c) ? map(dL[c]) : L0));
  for (const c of fills) L[c] = Math.max(L[c], needs.get(c));
  // sung and unsung (any two fills) stay at least 0.12 apart: the lighter one moves up
  const colour = (c) => fromOklch(L[c], lch[c][1], lch[c][2]);
  const byL = [...fills].sort((a, b) => L[a] - L[b]);
  for (let i = 1; i < byL.length; i++) {
    const hi = byL[i];
    for (let j = 0; j < i; j++) {
      const lo = byL[j];
      while (L[hi] < 1 && deltaE(colour(lo), colour(hi)) < 0.12) L[hi] = Math.min(1, L[hi] + 0.01);
    }
  }
  const minFillL = fills.length ? Math.min(...fills.map((c) => L[c])) : null;
  for (const c of edges) L[c] = minFillL === null ? lch[c][0] : Math.min(lch[c][0], Math.max(0.15, minFillL - 0.35));
  const rgb = new Uint8Array(48);
  for (let c = 0; c < 16; c++) {
    const same = keyed(c) || (!flip && Math.abs(L[c] - lch[c][0]) < 1e-9);
    rgb.set(same ? rgbAt(palette, c) : colour(c), c * 3);
  }
  return { rgb, flip, fills, edges, areas };
}

const word = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/**
 * The colour table of one screen: 17 RGBA words for ImageData (little-endian), entry 16 the
 * outline. Look 'disc', or a screen with nothing keyed: the disc's own colours, opaque. 'panel'
 * and 'clear': keyed colours transparent, the others made readable. `outline`: { rgb, a }.
 */
export function lyricsLut(look, palette, K, main, roles, plate, outline, out = new Uint32Array(17)) {
  const keying = look !== 'disc' && K !== 0;
  const rgb = keying ? readablePalette(palette, K, main, roles, plate).rgb : palette;
  for (let c = 0; c < 16; c++) out[c] = word(rgb[c * 3], rgb[c * 3 + 1], rgb[c * 3 + 2], keying && (K >> c) & 1 ? 0 : 255);
  const o = outline?.rgb || [0, 0, 0];
  const a = Number.isFinite(outline?.a) ? Math.round(Math.max(0, Math.min(1, outline.a)) * 255) : 230;
  out[OUTLINE_INDEX] = word(o[0], o[1], o[2], a);
  return out;
}

/**
 * Copies the memory rectangle [x0, x1) × [y0, y1) of `mem` (300×216 indices) into `out`; with
 * `outline`, a keyed pixel next to (8 neighbours) an unkeyed one becomes OUTLINE_INDEX: a 1 px
 * dark edge baked into the picture (no CSS filter).
 */
export function outlineIndices(mem, K, outline, x0, y0, x1, y1, out) {
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    for (let x = x0; x < x1; x++) {
      const c = mem[row + x];
      if (!outline || !((K >> c) & 1)) {
        out[row + x] = c;
        continue;
      }
      let edge = false;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1) && !edge; yy++) {
        const r = yy * W;
        for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
          if (!((K >> mem[r + xx]) & 1)) {
            edge = true;
            break;
          }
        }
      }
      out[row + x] = edge ? OUTLINE_INDEX : c;
    }
  }
  return out;
}

// ---- scroll smoothing -------------------------------------------------------------------------

/**
 * The disc's vertical scroll position over the song, read once from the packets (about 1 ms).
 * A disc scrolls smoothly by stepping the vertical offset (0..11) a pixel at a time and moving
 * the memory up 12 rows (vCmd 2): S = 12 × (moves up) + offset. The TV shows a box-filtered S
 * instead, as wide as possible while never more than `maxDev` CD+G px from S; moves of more than
 * 2 px (page jumps) are never smoothed.
 * → null for a disc that doesn't scroll pixel by pixel; else { P (packet positions where S
 * changes), S, w (box width in packets; 0 = no smoothing), insTop, insBot (rows the smoothing can
 * show above / below the disc's window, ≤ maxDev), … }
 */
export function scrollTimeline(bytes, { maxDev = MAX_SCROLL_DEVIATION, widths = [60, 45, 30, 20, 10], minSteps = 8 } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const P = [0];
  const S = [0];
  let up = 0;
  let last = 0;
  let small = 0;
  const n = Math.floor(b.length / CDG_PACKET_SIZE);
  for (let i = 0; i < n; i++) {
    const o = i * CDG_PACKET_SIZE;
    if ((b[o] & 0x3f) !== 9) continue;
    const instr = b[o + 1] & 0x3f;
    if (instr !== CDG_INSTR.SCROLL_PRESET && instr !== CDG_INSTR.SCROLL_COPY) continue;
    const v = b[o + 6] & 0x3f;
    const cmd = (v >> 4) & 3;
    up += cmd === 2 ? 1 : cmd === 1 ? -1 : 0;
    const s = 12 * up + Math.min(v & 15, 11);
    if (s === last) continue;
    if (Math.abs(s - last) <= BIG_MOVE) small++;
    P.push(i + 1); // the decoder has run packet i once its position is i + 1
    S.push(s);
    last = s;
  }
  if (small < minSteps) return null;
  const count = P.length;
  const tl = {
    P: Float64Array.from(P),
    S: Float64Array.from(S),
    seg: new Int32Array(count), // first event of each event's segment (a page jump starts one)
    I: new Float64Array(count), // integral of S from the segment's start to P[i]
    segEnd: new Float64Array(count), // where each event's segment ends (Infinity: the song's end)
    count,
    w: 0,
    dev: 0,
    insTop: 0,
    insBot: 0,
  };
  for (let i = 1; i < count; i++) {
    const jump = Math.abs(S[i] - S[i - 1]) > BIG_MOVE;
    tl.seg[i] = jump ? i : tl.seg[i - 1];
    tl.I[i] = jump ? 0 : tl.I[i - 1] + S[i - 1] * (P[i] - P[i - 1]);
  }
  tl.segEnd[count - 1] = Infinity;
  for (let i = count - 2; i >= 0; i--) tl.segEnd[i] = tl.seg[i + 1] === i + 1 ? P[i + 1] : tl.segEnd[i + 1];
  for (const w of widths) {
    const { lag, lead } = deviation(tl, w);
    if (Math.max(lag, lead) <= maxDev) {
      tl.w = w;
      tl.dev = Math.max(lag, lead);
      tl.insTop = Math.min(maxDev, Math.ceil(lag - 1e-9));
      tl.insBot = Math.min(maxDev, Math.ceil(lead - 1e-9));
      break;
    }
  }
  return tl;
}

/** Index of the last event at or before packet position p. */
function eventAt(tl, p) {
  const P = tl.P;
  let lo = 0;
  let hi = tl.count - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (P[m] <= p) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** Mean of S over [p - w/2, p + w/2], clipped to p's segment. */
function boxMean(tl, p, w) {
  const i = eventAt(tl, p);
  const lo = Math.max(p - w / 2, tl.P[tl.seg[i]]);
  const hi = Math.min(p + w / 2, tl.segEnd[i]);
  if (hi - lo < 1e-9) return tl.S[i];
  const a = eventAt(tl, lo);
  const b = eventAt(tl, hi - 1e-9);
  const F = (x, e) => tl.I[e] + tl.S[e] * (x - tl.P[e]);
  return (F(hi, b) - F(lo, a)) / (hi - lo);
}

/**
 * The largest lag (S − shown) and lead (shown − S) of the box of width w over the song. The
 * shown curve is piecewise linear and S a step function, so the extremes are at the events and
 * half a box away from them (both sides of each).
 */
function deviation(tl, w) {
  let lag = 0;
  let lead = 0;
  for (let i = 1; i < tl.count; i++) {
    for (const p of [tl.P[i], tl.P[i] - w / 2, tl.P[i] + w / 2]) {
      for (const q of [p, p - 1e-6]) {
        const d = boxMean(tl, q, w) - tl.S[eventAt(tl, q)];
        if (-d > lag) lag = -d;
        if (d > lead) lead = d;
      }
    }
  }
  return { lag, lead };
}

/**
 * How far (CD+G rows, fractional) the smoothed scroll is from the disc's at song packet position
 * `packetPos` (time × 300), for a decoder at `decoderPosition`: add it to the vertical offset.
 */
export function scrollShift(tl, packetPos, decoderPosition) {
  if (!tl || !tl.w || !Number.isFinite(packetPos)) return 0;
  const shift = boxMean(tl, packetPos, tl.w) - tl.S[eventAt(tl, decoderPosition)];
  if (Math.abs(shift) < 1e-6) return 0; // rounding of the integrals
  return Math.max(-tl.insTop, Math.min(tl.insBot, shift));
}
