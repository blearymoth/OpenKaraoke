// Readable lyrics (shared/lyrics.js): settings, content keying, colour roles, the readable
// palette and scroll smoothing, on synthetic discs written with scripts/lib/cdg-writer.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdgDecoder, CDG_WIDTH, CDG_HEIGHT, CDG_INSTR, CDG_VISIBLE_X, CDG_VISIBLE_Y } from '../shared/cdg.js';
import {
  LYRICS_LOOKS, LYRICS_MOTIONS, LIGHTER_EFFECTS, DEFAULT_LYRICS_LOOK, normalizeLyricsLook, normalizeLyricsMotion, normalizeLighterEffects,
  keyColours, maskColours, roleStats, roleStatsAsync, rolesFromStats, rolesFromHist, readablePalette, panelBackdrop, lyricsLut,
  outlineIndices, OUTLINE_INDEX, contrast, oklab, deltaE, luminance, fromOklch, scrollTimeline, scrollShift, CONTRAST_TARGET,
  ScreenKeying,
} from '../shared/lyrics.js';
import { CdgWriter, textWidth, drawText, centeredX } from '../scripts/lib/cdg-writer.js';
import { GLYPHS, FONT_HEIGHT } from '../scripts/lib/cdg-font.js';
import { makeCdg, synthSong, DEMO_SONGS } from '../scripts/make-demo-library.js';

const W = CDG_WIDTH;
const H = CDG_HEIGHT;
const PLATES = { studio: { rgb: [10, 17, 32], a: 0.9 }, party: { rgb: [21, 15, 38], a: 0.9 } };
const rgbAt = (pal, c) => [pal[c * 3], pal[c * 3 + 1], pal[c * 3 + 2]];

test('settings: the looks, motions and lighter effects, and their defaults', () => {
  assert.deepEqual(LYRICS_LOOKS, ['panel', 'clear', 'disc']);
  assert.deepEqual(LYRICS_MOTIONS, ['smooth', 'disc']);
  assert.deepEqual(LIGHTER_EFFECTS, ['auto', 'on', 'off']);
  assert.equal(DEFAULT_LYRICS_LOOK, 'panel');
  for (const v of LYRICS_LOOKS) assert.equal(normalizeLyricsLook(v), v);
  for (const bad of ['party', '', '__proto__', 'constructor', 'PANEL', 5, null, undefined, {}, ['disc']]) {
    assert.equal(normalizeLyricsLook(bad), 'panel', String(bad));
    assert.equal(normalizeLyricsMotion(bad), 'smooth', String(bad));
    assert.equal(normalizeLighterEffects(bad), 'auto', String(bad));
  }
  assert.equal(normalizeLyricsMotion('disc'), 'disc');
  assert.equal(normalizeLighterEffects('off'), 'off');
});

test('colour maths: luminance, contrast, OKLab round trip', () => {
  assert.equal(luminance([0, 0, 0]), 0);
  assert.ok(Math.abs(luminance([255, 255, 255]) - 1) < 1e-9);
  assert.ok(Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 1e-9);
  assert.ok(Math.abs(oklab([255, 255, 255])[0] - 1) < 1e-6);
  for (const c of [[255, 0, 0], [12, 200, 90], [10, 17, 32], [250, 250, 210]]) {
    const [L, a, b] = oklab(c);
    assert.deepEqual(fromOklch(L, Math.hypot(a, b), Math.atan2(b, a)), c);
  }
  assert.equal(deltaE([1, 2, 3], [1, 2, 3]), 0);
  assert.deepEqual(panelBackdrop(PLATES.studio), [22, 28, 42]);
});

// ---- synthetic decoder states for the keying rules ---------------------------------------------

/** A decoder-shaped screen: `fill(x, y)` gives the colour of each visible pixel (0..287, 0..191). */
function screen(fill, { bg = 0, border = 0, scrollFill = -1, h = 0, v = 0, palette } = {}) {
  const pixels = new Uint8Array(W * H).fill(border);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 288; x++) pixels[(CDG_VISIBLE_Y + v + y) * W + CDG_VISIBLE_X + h + x] = fill(x, y);
  const pal = palette || new Uint8Array(Array.from({ length: 48 }, (_, i) => (i * 37 + 11) % 256));
  return { pixels, palette: pal, bgColor: bg, borderColor: border, scrollFill, hOffset: h, vOffset: v };
}
// `c` on the first `fraction` of the window, then colours 1 and 2 in turn (each under 35 %)
const share = (fraction, c) => (x, y) => (y * 288 + x < fraction * 288 * 192 ? c : 1 + (x & 1));

test('keying: 35 % and up is background, with hysteresis down to 20 %', () => {
  const k36 = keyColours(screen(share(0.36, 3), { bg: 9, border: 3 }));
  assert.deepEqual(maskColours(k36.K), [3]);
  assert.equal(k36.main, 3);
  assert.equal(keyColours(screen(share(0.34, 3), { bg: 9, border: 3 })).K, 0, '34 %: nothing dominates (a picture)');
  const s25 = screen((x, y) => (y < 48 ? 3 : y < 96 ? 4 : y < 144 ? 5 : 6), { bg: 9, border: 9 }); // 25 % each
  assert.equal(keyColours(s25).K & (1 << 3), 0, '25 %: not by itself');
  assert.ok(keyColours(s25, 1 << 3).K & (1 << 3), '25 %: kept when it was background');
  const s15 = screen((x, y) => (y < 29 ? 3 : y < 110 ? 1 : 2), { bg: 1, border: 1 });
  assert.equal(keyColours(s15, 1 << 3).K & (1 << 3), 0, '15 %: dropped');
  assert.deepEqual(maskColours(keyColours(s15, 1 << 3).K), [1, 2]);
});

test('keying: the preset colour from 10 %, the scroll fill when on screen', () => {
  const tenth = (c) => (x, y) => (y < 22 ? c : y < 96 ? 1 : y < 144 ? 2 : 3); // 11.5 %, 38.5 %, 25 %, 25 %
  assert.ok(keyColours(screen(tenth(5), { bg: 5, border: 5 })).K & (1 << 5));
  assert.equal(keyColours(screen((x, y) => (y < 15 ? 5 : y < 96 ? 1 : y < 144 ? 2 : 3), { bg: 5, border: 5 })).K & (1 << 5), 0, '8 %: not');
  const filled = screen((x, y) => (y > 188 ? 7 : y < 96 ? 0 : 1), { bg: 0, scrollFill: 7 });
  assert.ok(keyColours(filled).K & (1 << 7), 'scroll fill keyed');
  assert.equal(keyColours(screen((x, y) => (y < 96 ? 0 : 1), { bg: 0, scrollFill: 7 })).K & (1 << 7), 0, 'not on screen: no need');
});

test('keying: the border colour only when it shows nowhere but the revealed strip', () => {
  // vOffset 4: the window's bottom 4 rows are memory rows 204..207 (the bottom border)
  const strip = screen((x, y) => (y < 188 ? (y % 20 < 6 && x % 9 < 4 ? 1 : 0) : 8), { bg: 0, border: 8, v: 4 });
  assert.ok(keyColours(strip).K & (1 << 8), 'only in the strip: keyed');
  const used = screen((x, y) => (y < 188 ? (x === 50 && y === 50 ? 8 : y % 20 < 6 && x % 9 < 4 ? 1 : 0) : 8), { bg: 0, border: 8, v: 4 });
  assert.equal(keyColours(used).K & (1 << 8), 0, 'used inside the window: a lyric colour, not keyed');
});

test('keying: hidden text in the background colour stays hidden; a picture screen keys nothing', () => {
  const pal = new Uint8Array(48);
  pal.set([0, 0, 80], 0); // background
  pal.set([255, 255, 255], 3); // text
  pal.set([0, 0, 80], 6); // "hidden" text: same colour as the background
  const s = screen((x, y) => (y % 24 < 10 && x % 7 < 3 ? (y < 96 ? 1 : 2) : 0), { bg: 0, palette: pal });
  assert.deepEqual(maskColours(keyColours(s).K), [0, 2]);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const picture = screen(() => Math.floor(rand() * 16), { bg: 0, border: 0 });
  assert.equal(keyColours(picture).K, 0, 'no dominant colour: K = ∅');
});

test('keying: DEFINE_TRANSPARENT is never keyed', () => {
  const w = new CdgWriter();
  w.loadColors(Array.from({ length: 16 }, (_, i) => (i === 15 ? [15, 15, 15] : i === 1 ? [0, 0, 0] : [0, 0, 6])));
  w.memoryPreset(0);
  const frame = w.screen.slice();
  drawLine(frame, 'WHITE LYRICS LINE', 30, 90, { 1: 15 }, { shadow: 1 });
  w.drawFrame(frame);
  w.packet(CDG_INSTR.DEFINE_TRANSPARENT, [63, ...new Array(15).fill(0)]); // "colour 0 transparent" (63 & 15 = 15)
  const dec = new CdgDecoder(w.toBuffer());
  dec.seek(dec.duration);
  assert.equal(dec.transparentColor, 15);
  const { K } = keyColours(dec);
  assert.equal(K & (1 << 15), 0, 'the white letters stay');
  assert.ok(K & 1);
});

// ---- keying held still for each screen (ScreenKeying) -------------------------------------------

/** The demo library's timing without rendering its audio (synthSong's numbers). */
const demoTiming = (song) => {
  const bar = 240 / song.bpm;
  return { duration: (4 + song.lyrics.length * 2) * bar, barSec: bar, introBars: 2, lineBars: 2 };
};

/**
 * Plays `bytes` in 1/60 s steps up to `until` s, keying on every change as the TV renderer does
 * (with the load-time pass's screens, or before it has got there: `pass` false). → `flips`: per
 * screen, how many times a colour on screen switched between keyed and drawn; `shown`: the times
 * colour `watch` was drawn; `at(t)`: { K, hist } at time t.
 */
function walkKeying(bytes, until, { pass = true, watch = -1, at = [] } = {}) {
  const keying = new ScreenKeying();
  if (pass) roleStats(bytes, { screens: keying.screens });
  const dec = new CdgDecoder(bytes);
  const hist = new Uint32Array(16);
  const flips = new Map();
  const shown = [];
  const snaps = new Map();
  let version = -1;
  let K = 0;
  let prev = { K: 0, present: 0, preset: -1 };
  for (let i = 0; i <= until * 60; i++) {
    const t = i / 60;
    dec.seek(t);
    if (dec.version !== version) {
      version = dec.version;
      K = keying.key(dec, hist).K;
      let present = 0;
      for (let c = 0; c < 16; c++) if (hist[c]) present |= 1 << c;
      const changed = dec.presetCount === prev.preset ? (K ^ prev.K) & present & prev.present : 0;
      if (changed) flips.set(dec.presetCount, (flips.get(dec.presetCount) || 0) + maskColours(changed).length);
      if (watch >= 0 && (present >> watch) & 1 && !((K >> watch) & 1)) shown.push(+t.toFixed(2));
      prev = { K, present, preset: dec.presetCount };
    }
    for (const want of at) if (Math.abs(want - t) < 1 / 120) snaps.set(want, { K, hist: Uint32Array.from(hist), palette: Uint8Array.from(dec.palette) });
  }
  return { flips: Object.fromEntries(flips), shown, at: (t) => snaps.get(t) };
}

test('keying holds still for each screen: a demo title box never flashes on the panel', () => {
  const BAND = 4; // (scripts/make-demo-library.js: the title card's purple box, ≈ 35 % of the window)
  for (const song of DEMO_SONGS) {
    const bytes = makeCdg(song, demoTiming(song));
    const pass = walkKeying(bytes, 12, { watch: BAND });
    assert.deepEqual(pass.flips, {}, `${song.title}: no colour on screen switches between keyed and drawn`);
    assert.deepEqual(pass.shown, [], `${song.title}: the title box is never drawn (it was shown from ≈1.3 s and again from ≈3.7 s)`);
    // before the pass has got there: the box shows while it is drawn, is keyed once at 35 %, and stays keyed while it is erased
    const live = walkKeying(bytes, 12, { pass: false, watch: BAND });
    for (const [screen, n] of Object.entries(live.flips)) assert.ok(n <= 1, `${song.title}, screen ${screen} without the pass: at most one keying change (${n})`);
    assert.ok(live.shown.length && Math.max(...live.shown) < 2, `${song.title} without the pass: only while the box is drawn (${live.shown.at(-1)} s)`);
  }
});

test('keying: words in a colour that was a background earlier on the same screen are drawn', () => {
  // A white title card over 60 % of the window, then (no MEMORY_PRESET) a page of white words on
  // black drawn over it tile by tile.
  const w = new CdgWriter();
  w.loadColors(Array.from({ length: 16 }, (_, i) => [[0, 0, 0], [15, 15, 15], [0, 0, 12], [15, 12, 0]][i] || [0, 0, 0]));
  w.memoryPreset(0, 2);
  w.borderPreset(0);
  let f = w.screen.slice();
  for (let y = 30; y < 180; y++) f.fill(1, y * W + 6, y * W + 294);
  drawText(f, 'The Title Card', centeredX('The Title Card'), 90, 2);
  w.drawFrame(f);
  w.padTo(3);
  f = new Uint8Array(W * H);
  drawText(f, 'White words on black', centeredX('White words on black'), 60, 1);
  drawText(f, 'sung in amber', centeredX('sung in amber'), 110, 1, { highlightX: 150, highlightColor: 3 });
  w.drawFrame(f);
  w.padTo(10);
  const bytes = w.toBuffer();
  for (const pass of [true, false]) {
    const r = walkKeying(bytes, 10, { pass, at: [2.5, 9] });
    const title = r.at(2.5);
    assert.ok(title.K & (1 << 1) && !(title.K & (1 << 2)), `pass ${pass}: the white card is background, its blue words drawn`);
    const page = r.at(9);
    assert.ok(page.hist[1] > 500, 'white words on the page');
    assert.equal(page.K & (1 << 1), 0, `pass ${pass}: the white words are drawn (keyed: ${maskColours(page.K)})`);
    const lut = lyricsLut('panel', page.palette, page.K, 0, null, PLATES.studio, null);
    assert.equal(lut[1] >>> 24, 255);
    assert.equal(lut[3] >>> 24, 255);
  }
  // with the pass: white is background from the start and turns into words once (when what is left of the card is no longer most of it)
  for (const [screen, n] of Object.entries(walkKeying(bytes, 10).flips)) assert.ok(n <= 1, `screen ${screen}: ${n} keying changes`);
});

test('keying: a picture drawn over the preset background is still shown as the disc made it', () => {
  const w = new CdgWriter();
  w.loadColors(Array.from({ length: 16 }, (_, i) => [(i * 5) % 16, (i * 11) % 16, (i * 7 + 3) % 16]));
  w.memoryPreset(0, 2);
  const f = w.screen.slice();
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const c = Math.floor(rand() * 16);
    for (let dy = 0; dy < 3; dy++) f.fill(c, (y + dy) * W + x, (y + dy) * W + x + 3);
  }
  w.drawFrame(f);
  const end = Math.ceil(w.time) + 1; // (a tile of many colours takes several packets)
  w.padTo(end);
  const r = walkKeying(w.toBuffer(), end, { at: [0.2, end - 0.5] });
  assert.ok(r.at(0.2).K & 1, 'the preset colour is background while the picture is drawn');
  assert.equal(r.at(end - 0.5).K, 0, 'the whole picture, nothing keyed');
});

test('keying: a scroll-preset fill colour is forgotten at the next memory preset', () => {
  // A title on yellow scrolled away with SCROLL_PRESET (fill yellow), then a MEMORY_PRESET to blue
  // and yellow words sung in white: the yellow words must be drawn.
  const [WHITE, YELLOW, BLUE] = [1, 2, 3];
  const w = new CdgWriter();
  w.loadColors(Array.from({ length: 16 }, (_, i) => [[0, 0, 0], [15, 15, 15], [15, 14, 0], [0, 0, 8]][i] || [0, 0, 0]));
  w.memoryPreset(YELLOW, 2);
  w.borderPreset(YELLOW);
  let f = w.screen.slice();
  drawText(f, 'The Title', centeredX('The Title'), 90, 0);
  w.drawFrame(f);
  w.padTo(2);
  for (let i = 0; i < 6; i++) {
    w.scroll(false, YELLOW, 0, 0, 2, 0);
    w.padPackets(10);
  }
  w.padTo(3);
  w.memoryPreset(BLUE, 2);
  w.borderPreset(BLUE);
  f = w.screen.slice();
  drawText(f, 'Yellow words on blue', centeredX('Yellow words on blue'), 60, YELLOW);
  drawText(f, 'sung in white', centeredX('sung in white'), 110, YELLOW, { highlightX: 150, highlightColor: WHITE });
  w.drawFrame(f);
  w.padTo(6);
  const dec = new CdgDecoder(w.toBuffer());
  dec.seek(2.9);
  assert.equal(dec.scrollFill, YELLOW);
  dec.seek(5);
  assert.equal(dec.scrollFill, -1, 'the memory preset painted over every strip');
  const { K, main } = keyColours(dec);
  assert.deepEqual(maskColours(K), [BLUE]);
  const lut = lyricsLut('panel', dec.palette, K, main, null, PLATES.studio, null);
  assert.equal(lut[YELLOW] >>> 24, 255, 'the yellow words are drawn');
  assert.equal(lut[WHITE] >>> 24, 255);
});

// ---- archetype discs (readability: outline, bare, light, dim, halo, scroller, …) --------------

/** Draws `text` at (x, y) into a frame 300 wide; colours: { 1: unsung, 2: sung, 3: outline/shadow, 4–7: anti-aliasing }. */
function drawLine(frame, text, x, y, col, { outline = 0, shadow = 0, aa = 0, hx = -1 } = {}) {
  const w = textWidth(text);
  const m = new Uint8Array(w * FONT_HEIGHT);
  let cx = 0;
  for (const ch of text) {
    const g = GLYPHS.get(ch.charCodeAt(0)) || GLYPHS.get(63);
    for (let gy = 0; gy < FONT_HEIGHT; gy++) for (let gx = 0; gx < g.width; gx++) if ((g.rows[gy] >> (g.width - 1 - gx)) & 1 && cx + gx < w) m[gy * w + cx + gx] = 1;
    cx += g.advance;
  }
  const ink = (gx, gy) => gx >= 0 && gy >= 0 && gx < w && gy < FONT_HEIGHT && m[gy * w + gx];
  const rows = frame.length / W;
  const put = (px, py, c) => { if (px >= 0 && py >= 0 && px < W && py < rows && c !== undefined) frame[py * W + px] = c; };
  const sung = (px) => px < hx;
  for (let gy = -3; gy < FONT_HEIGHT + 3; gy++) {
    for (let gx = -3; gx < w + 3; gx++) {
      if (ink(gx, gy)) continue;
      const px = x + gx;
      const py = y + gy;
      if (outline) {
        let near = false;
        for (let dy = -outline; dy <= outline && !near; dy++) for (let dx = -outline; dx <= outline; dx++) if (ink(gx + dx, gy + dy)) { near = true; break; }
        if (near) put(px, py, col[3]);
      }
      if (shadow && ink(gx - shadow, gy - shadow)) put(px, py, col[3]);
      if (aa) {
        const four = ink(gx - 1, gy) || ink(gx + 1, gy) || ink(gx, gy - 1) || ink(gx, gy + 1);
        const diag = ink(gx - 1, gy - 1) || ink(gx + 1, gy - 1) || ink(gx - 1, gy + 1) || ink(gx + 1, gy + 1);
        if (four) put(px, py, sung(px) ? col[6] : col[4]);
        else if (diag && aa > 1) put(px, py, sung(px) ? col[7] : col[5]);
      }
    }
  }
  for (let gy = 0; gy < FONT_HEIGHT; gy++) for (let gx = 0; gx < w; gx++) if (ink(gx, gy)) put(x + gx, y + gy, sung(x + gx) ? col[2] : col[1]);
}

const LINES = ['Turn the lights down low tonight', 'Every mic is shining bright', 'Grab the words and hold them tight', 'Neon heart, we sing till light'];
const COLS = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
// palettes in 4-bit components; roles: 0 background, 1 unsung, 2 sung, 3 outline/shadow, 4–7 anti-aliasing
const ARCHETYPES = {
  A: { pal: { 0: [0, 0, 5], 1: [15, 15, 15], 2: [15, 12, 0], 3: [0, 0, 0] }, outline: 1 }, // outlined: reads well
  B: { pal: { 0: [0, 0, 0], 1: [12, 12, 15], 2: [15, 4, 4] } }, // bare
  C: { pal: { 0: [14, 14, 13], 1: [1, 1, 7], 2: [13, 1, 1] } }, // light background, navy text
  D: { pal: { 0: [0, 0, 0], 1: [0, 0, 9], 2: [0, 10, 12], 4: [0, 0, 4], 6: [0, 4, 5] }, aa: 1 }, // dim
  E: { pal: { 0: [2, 4, 11], 1: [15, 15, 4], 2: [15, 5, 0], 3: [15, 15, 15] }, outline: 1 }, // white halo
  F: { pal: { 0: [0, 0, 0], 1: [15, 15, 15], 2: [6, 12, 15], 3: [0, 0, 0] }, shadow: 1, scroll: true }, // scroller: reads well
  G: { pal: { 0: [0, 0, 0], 1: [15, 15, 15], 2: [15, 9, 0], 4: [9, 9, 9], 5: [5, 5, 5], 6: [9, 5, 0], 7: [5, 3, 0] }, aa: 2 },
  H: { pal: { 0: [3, 6, 12], 1: [0, 0, 0], 2: [8, 0, 0], 3: [15, 15, 15] }, outline: 1 }, // black text, white outline
  I: { pal: { 0: [15, 15, 15], 1: [0, 0, 0], 2: [0, 0, 12], 4: [8, 8, 8], 6: [8, 8, 14] }, aa: 1 }, // paper
  J: { pal: { 0: [15, 15, 15], 1: [15, 15, 0], 2: [15, 0, 0] } }, // yellow on white: light, but no flip
};
const palette16 = (pal) => Array.from({ length: 16 }, (_, i) => pal[i] || [0, 0, 0]);
const centred = (t) => CDG_VISIBLE_X + Math.max(0, Math.round((288 - textWidth(t)) / 2));

/** A one-page disc: four lines, a wipe through lines 1 and 2. → { bytes, mark (a time with both colours on screen) } */
function pagedDisc(arch) {
  const w = new CdgWriter();
  w.loadColors(palette16(arch.pal));
  w.memoryPreset(0, 2);
  w.borderPreset(0);
  const frame = new Uint8Array(W * H);
  const draw = (active, prog) => {
    frame.fill(0);
    LINES.forEach((t, k) => {
      const x = centred(t);
      const hx = k < active ? 999 : k === active ? x + Math.round(prog * textWidth(t)) : -1;
      drawLine(frame, t, x, CDG_VISIBLE_Y + 18 + k * 44, COLS, { ...arch, hx });
    });
  };
  draw(-1, 0);
  w.drawFrame(frame);
  for (const k of [0, 1]) {
    for (let s = 0; s <= 1.0001; s += 0.1) {
      w.padTo(2 + k * 2 + s * 1.8);
      draw(k, s);
      w.drawFrame(frame);
    }
  }
  w.padTo(8);
  return { bytes: w.toBuffer(), mark: 5 };
}

/** A smooth scroller: lines 36 px apart glide up one pixel every 10 packets, the wipe on the middle line. */
function scrollDisc(arch) {
  const w = new CdgWriter();
  w.loadColors(palette16(arch.pal));
  w.memoryPreset(0, 2);
  w.borderPreset(0);
  const sheetRows = 192 + LINES.length * 2 * 36 + 48;
  const sheet = new Uint8Array(W * sheetRows);
  const drawSheet = (s) => {
    sheet.fill(0);
    [...LINES, ...LINES].forEach((t, i) => {
      const y0 = 60 + i * 36;
      const x = centred(t);
      const prog = Math.max(0, Math.min(1, (s + 96 + 12 - y0) / 36));
      drawLine(sheet, t, x, y0, COLS, { ...arch, hx: prog <= 0 ? -1 : x + Math.round(prog * textWidth(t)) });
    });
  };
  // the memory (rows 12..215) shows sheet rows base.. ; row 17 holds the next band
  const target = (base) => {
    const t = new Uint8Array(W * H);
    for (let y = CDG_VISIBLE_Y; y < H; y++) t.set(sheet.subarray((base + y - CDG_VISIBLE_Y) * W, (base + y - CDG_VISIBLE_Y + 1) * W), y * W);
    for (let y = 0; y < H; y++) { t.fill(0, y * W, y * W + CDG_VISIBLE_X); t.fill(0, y * W + 294, y * W + W); }
    return t;
  };
  let s = 0;
  drawSheet(0);
  w.drawFrame(target(0));
  w.padTo(1);
  for (let block = 0; block < 12; block++) {
    // twelve 1-px steps, then the wipe moves on
    w.glide(12, 10, { copy: false, fill: 0 });
    s += 12;
    drawSheet(s);
    w.drawFrame(target(s));
  }
  w.padTo(w.time + 1);
  return { bytes: w.toBuffer(), mark: 4 };
}

const discs = new Map();
function disc(key) {
  if (!discs.has(key)) {
    const arch = ARCHETYPES[key];
    const { bytes, mark } = arch.scroll ? scrollDisc(arch) : pagedDisc(arch);
    const roles = rolesFromStats(roleStats(bytes));
    const dec = new CdgDecoder(bytes);
    dec.seek(mark);
    const { K, main } = keyColours(dec);
    discs.set(key, { bytes, dec, roles, K, main });
  }
  return discs.get(key);
}

test('roles: unsung and sung letters are fills, a 1 px outline is an edge', () => {
  const a = disc('A');
  assert.equal(a.roles.sig[1], 'f');
  assert.equal(a.roles.sig[2], 'f');
  assert.equal(a.roles.sig[3], 'e');
  assert.deepEqual(maskColours(a.K), [0]);
  const g = disc('G');
  assert.equal(g.roles.sig[4], 'e', 'anti-aliasing is an edge');
});

test('roles: 2–3 px strokes are fills, a solid box is an area, a 1 px outline an edge', () => {
  const w = new CdgWriter();
  w.loadColors(palette16({ 0: [0, 0, 0], 1: [15, 15, 15], 2: [8, 8, 8], 9: [4, 2, 8] }));
  w.memoryPreset(0);
  const frame = w.screen.slice();
  for (let y = 24; y < 84; y++) frame.fill(9, y * W + 18, y * W + 108); // a 90×60 box (10 % of the window)
  drawLine(frame, 'Outlined words here', 120, 40, { 1: 1, 3: 2 }, { outline: 1 });
  drawLine(frame, 'and more of them below', 40, 120, { 1: 1, 3: 2 }, { outline: 1 });
  w.drawFrame(frame);
  w.padTo(6);
  const roles = rolesFromStats(roleStats(w.toBuffer()));
  assert.equal(roles.sig[1], 'f', '2–3 px strokes');
  assert.equal(roles.sig[2], 'e', '1 px outline');
  assert.equal(roles.sig[9], 'a', 'solid box');
  assert.equal(roles.sig[0], '-', 'the background (keyed) has no role');
});

test('roles: the async pass gives the same statistics, and stops when cancelled', async () => {
  const { bytes } = disc('E');
  const sync = roleStats(bytes);
  const slow = await roleStatsAsync(bytes, { sliceMs: 0.5 });
  assert.deepEqual(slow, sync);
  let calls = 0;
  assert.equal(await roleStatsAsync(bytes, { sliceMs: 0, cancelled: () => ++calls > 2 }), null);
  // the screens for ScreenKeying: the first `syncSeconds` before it returns, then the same as the synchronous pass
  const song = DEMO_SONGS[0];
  const demo = makeCdg(song, demoTiming(song));
  const whole = new ScreenKeying();
  roleStats(demo, { screens: whole.screens });
  const early = new ScreenKeying();
  const pending = roleStatsAsync(demo, { sliceMs: 0, screens: early.screens, syncSeconds: 10 });
  assert.equal(early.screens.get(2)?.big, 0b10001, 'the title card’s screen is known at once (its background and box)');
  await pending;
  assert.deepEqual(early.screens, whole.screens);
  const hist = new Uint32Array(16);
  hist[0] = 50000;
  hist[1] = 5000;
  hist[2] = 50;
  assert.equal(rolesFromHist(hist, 1).sig, '-f' + '-'.repeat(14), 'before the pass: what is on screen is a fill');
});

for (const [skin, plate] of Object.entries(PLATES)) {
  test(`readable palette (${skin} plate): every disc's lyric colours reach 7:1`, () => {
    const panel = panelBackdrop(plate);
    for (const key of Object.keys(ARCHETYPES)) {
      const { dec, roles, K, main } = disc(key);
      assert.ok(K & 1, `${key}: the background is keyed`);
      const r = readablePalette(dec.palette, K, main, roles, plate);
      assert.ok(r.fills.includes(1) && r.fills.includes(2), `${key}: unsung and sung are fills (${roles.sig})`);
      for (const c of r.fills) {
        const ratio = contrast(rgbAt(r.rgb, c), panel);
        assert.ok(ratio >= CONTRAST_TARGET, `${key}: colour ${c} ${rgbAt(r.rgb, c)} is ${ratio.toFixed(2)}:1`);
      }
      // sung and unsung stay apart, and keep their lightness order (after a flip: the mirrored order)
      assert.ok(deltaE(rgbAt(r.rgb, 1), rgbAt(r.rgb, 2)) >= 0.12, `${key}: sung and unsung apart`);
      const before = (c) => (r.flip ? 1 - oklab(rgbAt(dec.palette, c))[0] : oklab(rgbAt(dec.palette, c))[0]);
      const after = (c) => oklab(rgbAt(r.rgb, c))[0];
      for (const p of r.fills) for (const q of r.fills) if (before(p) < before(q) - 0.01) assert.ok(after(p) <= after(q), `${key}: fills ${p} and ${q} keep their order`);
    }
  });

  test(`readable palette (${skin} plate): good discs untouched, light discs flipped, halos tamed`, () => {
    for (const key of ['A', 'F']) {
      const { dec, roles, K, main } = disc(key);
      const r = readablePalette(dec.palette, K, main, roles, plate);
      assert.deepEqual([...r.rgb], [...dec.palette], `${key}: byte-identical`);
      assert.equal(r.flip, false);
    }
    const c = disc('C');
    const rc = readablePalette(c.dec.palette, c.K, c.main, c.roles, plate);
    assert.equal(rc.flip, true, 'C: navy on cream turns light on dark');
    assert.ok(oklab(rgbAt(rc.rgb, 1))[0] > 0.7, 'C: the text is light now');
    const hue = (rgb) => { const [, a, b] = oklab(rgb); return Math.atan2(b, a); };
    assert.ok(Math.abs(hue(rgbAt(rc.rgb, 1)) - hue(rgbAt(c.dec.palette, 1))) < 0.35, 'C: still blue');
    for (const key of ['I', 'H']) {
      const d = disc(key);
      assert.equal(readablePalette(d.dec.palette, d.K, d.main, d.roles, plate).flip, true, `${key} flips`);
    }
    const j = disc('J');
    assert.equal(readablePalette(j.dec.palette, j.K, j.main, j.roles, plate).flip, false, 'J: yellow on white keeps its polarity');
    const e = disc('E');
    assert.equal(e.roles.sig[3], 'e');
    const re = readablePalette(e.dec.palette, e.K, e.main, e.roles, plate);
    const minFill = Math.min(...re.fills.map((f) => oklab(rgbAt(re.rgb, f))[0]));
    assert.ok(oklab(rgbAt(re.rgb, 3))[0] <= minFill - 0.3, 'E: the white halo is well below the letters');
    assert.ok(oklab(rgbAt(re.rgb, 3))[0] >= 0.15, 'E: …but still there');
  });
}

test('colour table: keyed colours transparent in panel/clear, opaque on the disc look; outline entry', () => {
  const { dec, roles, K, main } = disc('B');
  const outline = { rgb: [4, 8, 16], a: 0.9 };
  const panel = lyricsLut('panel', dec.palette, K, main, roles, PLATES.studio, outline);
  assert.equal(panel[0] >>> 24, 0, 'background transparent');
  assert.equal(panel[1] >>> 24, 255);
  assert.equal(panel[OUTLINE_INDEX], ((230 << 24) | (16 << 16) | (8 << 8) | 4) >>> 0);
  const disc_ = lyricsLut('disc', dec.palette, K, main, roles, PLATES.studio, outline);
  for (let c = 0; c < 16; c++) {
    assert.equal(disc_[c] >>> 24, 255);
    assert.equal(disc_[c] & 0xffffff, (dec.palette[c * 3 + 2] << 16) | (dec.palette[c * 3 + 1] << 8) | dec.palette[c * 3]);
  }
  const picture = lyricsLut('panel', dec.palette, 0, 0, roles, PLATES.studio, outline);
  assert.deepEqual([...picture.slice(0, 16)], [...disc_.slice(0, 16)], 'nothing keyed: shown as the disc made it');
});

test('outline: keyed pixels next to ink become the outline entry', () => {
  const mem = new Uint8Array(W * H);
  mem[100 * W + 100] = 5;
  const out = outlineIndices(mem, 1, true, 0, 0, W, H, new Uint8Array(W * H));
  let ring = 0;
  for (let i = 0; i < out.length; i++) if (out[i] === OUTLINE_INDEX) ring++;
  assert.equal(ring, 8);
  assert.equal(out[100 * W + 100], 5);
  assert.equal(out[99 * W + 99], OUTLINE_INDEX);
  assert.equal(out[98 * W + 100], 0);
  const plain = outlineIndices(mem, 1, false, 0, 0, W, H, new Uint8Array(W * H));
  assert.deepEqual(plain, mem);
});

// ---- scroll smoothing --------------------------------------------------------------------------

test('scroll timeline: a gliding disc is smoothed, within 3 CD+G px, with insets ≤ 3', () => {
  const { bytes } = disc('F');
  const tl = scrollTimeline(bytes);
  assert.ok(tl, 'a timeline');
  assert.ok(tl.w > 0, `a box width (${tl.w})`);
  assert.ok(tl.insTop <= 3 && tl.insBot <= 3, `insets ${tl.insTop}/${tl.insBot}`);
  const dec = new CdgDecoder(bytes);
  let moving = 0;
  let maxShift = 0;
  const values = new Set();
  for (let t = 0; t < dec.duration; t += 1 / 240) {
    dec.seek(t);
    const shift = scrollShift(tl, t * 300, dec.position);
    maxShift = Math.max(maxShift, Math.abs(shift));
    assert.ok(shift >= -tl.insTop - 1e-9 && shift <= tl.insBot + 1e-9, `t=${t.toFixed(3)}: shift ${shift} inside the insets`);
    values.add(Math.round((dec.vOffset + shift) * 4)); // the position shown, to a quarter of a row
    if (Math.abs(shift) > 0.05) moving++;
  }
  assert.ok(maxShift <= 3, `|shift| ≤ 3 (${maxShift})`);
  assert.ok(moving > 50, 'it does smooth');
  assert.ok(values.size > 40, 'sub-pixel positions in between the disc’s steps');
});

test('scroll timeline: a paging disc has none; page jumps are not smoothed', () => {
  const song = { artist: 'A', title: 'T', bpm: 120, root: 57, prog: [0, 7, 9, 5], lyrics: LINES };
  assert.equal(scrollTimeline(makeCdg(song, synthSong(song, 1))), null, 'the demo’s page-at-a-time disc');
  assert.equal(scrollTimeline(disc('B').bytes), null);
  // a glide, then (5 s later) a 12-row jump: S jumps 24 → 36 at once
  const w = new CdgWriter();
  w.memoryPreset(0);
  w.padTo(1);
  w.glide(24, 8);
  w.padTo(6);
  w.scroll(true, 0, 0, 0, 2, 0);
  const jumpAt = w.count;
  w.padTo(9);
  const tl = scrollTimeline(w.toBuffer());
  assert.ok(tl && tl.w > 0);
  const dec = new CdgDecoder(w.toBuffer());
  for (const p of [jumpAt - 20, jumpAt - 1, jumpAt - 0.2, jumpAt, jumpAt + 0.5, jumpAt + 10]) {
    dec.seek(p / 300);
    assert.equal(scrollShift(tl, p, dec.position), 0, `no smoothing around the jump (packet ${p})`);
    assert.equal(dec.vOffset, 0);
  }
  assert.equal(tl.S[tl.count - 1] - tl.S[tl.count - 2], 12);
  assert.equal(scrollShift(null, 100, 100), 0);
  assert.equal(scrollShift(tl, NaN, 100), 0);
});

test('CdgWriter.glide: offsets 1..11, then a 12-row move with the offset back at 0; bands staged in row 17', () => {
  const w = new CdgWriter();
  w.memoryPreset(0);
  const band = (c) => new Uint8Array(W * 12).fill(c);
  w.glide(14, 5, { stage: (n) => band(n + 3) });
  const dec = new CdgDecoder(w.toBuffer());
  dec.seek(dec.duration);
  assert.equal(dec.vOffset, 2);
  assert.deepEqual(dec.pixels, w.screen, 'the writer mirrors the decoder');
  assert.equal(dec.pixels[192 * W + 100], 3, 'the first band came up into tile row 16');
  assert.equal(dec.pixels[204 * W + 100], 4, 'the second band is in row 17');
  assert.equal(w.count, 1 + 12 * 5 + 2 * (50 + 1), 'a step is 5 packets, or its band’s 50 tiles + the scroll');
});

test('the demo library’s scroller glides a pixel at a time, the next lines drawn out of sight beforehand', () => {
  const song = DEMO_SONGS.find((s) => s.scroll);
  assert.ok(song, 'a smooth-scrolling demo track');
  for (const line of song.lyrics) assert.ok(textWidth(line) <= 276, `${line}: fits one row`);
  const bytes = makeCdg(song, synthSong(song, 1));
  const tl = scrollTimeline(bytes);
  assert.ok(tl && tl.w > 0 && tl.insTop <= 3 && tl.insBot <= 3, 'smoothed');
  const scrolls = [];
  for (let i = 0; i < bytes.length / 24; i++) if ((bytes[i * 24] & 0x3f) === 9 && (bytes[i * 24 + 1] & 0x3f) === CDG_INSTR.SCROLL_COPY) scrolls.push(i);
  assert.equal(scrolls.length, 24 * (song.lyrics.length - 1), 'a 24 px glide between lines');
  const dec = new CdgDecoder(bytes);
  const after = (packet) => { dec.seek((packet + 1.5) / 300); return dec.visibleIndices(); };
  const unwiped = (win) => win.map((c) => (c === 2 ? 1 : c)); // the demo's sung colour (2) as unsung (1)
  for (let g = 0; g < scrolls.length; g += 24) {
    // every step shows rows of the screen before the glide or of the screen after it…
    const start = after(scrolls[g] - 1);
    const steps = scrolls.slice(g, g + 23).map((p) => after(p));
    const end = after(scrolls[g + 23]);
    steps.forEach((win, j) => {
      const d = j + 1;
      for (let y = 0; y < 192; y++) {
        const from = d + y < 192 ? start.subarray((d + y) * 288, (d + y + 1) * 288) : end.subarray((y - 24 + d) * 288, (y - 24 + d + 1) * 288);
        assert.deepEqual(win.subarray(y * 288, (y + 1) * 288), from, `glide ${g / 24}, step ${d}, row ${y}`);
      }
    });
    // …and the screen after it is the next screen as drawn later (only the wipe moves on): nothing stale came in
    const later = after(g + 24 < scrolls.length ? scrolls[g + 24] - 1 : scrolls[g + 23] + 300);
    assert.deepEqual(unwiped(end), unwiped(later), `glide ${g / 24}: the lines that came in are the right ones`);
  }
});
