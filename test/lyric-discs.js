// Synthetic discs in the styles real karaoke discs use (test helper; written with
// scripts/lib/cdg-writer.js), for the lyric layouts (shared/lyric-lines.js, PLAN §9.6):
//   - pages:   a title card, an info card that is never sung, countdown squares drawn and erased,
//              pages of four outlined lines (three colours a tile: NORMAL + XOR packets) drawn line
//              by line, the screen cleared right after a page's last line (the next page shows up
//              at the last moment), and a 12 s instrumental between two verses
//   - rolling: five lines; each sung line is erased and a new one drawn in its place; the wipe
//              paints a highlight bar behind the letters
//   - duet:    two singers' colours; one line sung by both at once (two lines wiped together)
//   - popon:   lines that appear and go, never re-coloured (nothing to follow)
// Each returns { bytes, lines: [{ text, start, end }] } (what is sung when, in seconds). Every
// line fits the disc's screen (as on real discs).
import { CdgWriter, textWidth, centeredX } from '../scripts/lib/cdg-writer.js';
import { GLYPHS, FONT_HEIGHT } from '../scripts/lib/cdg-font.js';
import { CDG_WIDTH, CDG_VISIBLE_X, CDG_VISIBLE_Y } from '../shared/cdg.js';

const W = CDG_WIDTH;
const pal = (entries) => Array.from({ length: 16 }, (_, i) => entries[i] || [0, 0, 0]);

export const VERSES = [
  ['Under harbour lights tonight', 'We sang the songs we knew', 'The tide came in so close', 'And nothing kept us apart'],
  ['Hold the lantern up so high', 'Every sailor knows the tune', 'Sing it out across the bay', 'Underneath the silver moon'],
  ['When the morning finds us here', 'Tired voices, happy eyes', 'One more chorus, one more cheer', 'Till the sun begins to rise'],
];

/**
 * Text into a frame (300 wide): `fill` for the letters, `edge` a 1-pixel outline around them;
 * pixels left of `hx` in `sung` (and, with `bar`, the background there in `bar`).
 */
export function drawLine(frame, text, x, y, { fill, sung, edge = -1, hx = -1, bar = -1, bg = 0 }) {
  const w = textWidth(text);
  const m = new Uint8Array((w + 4) * (FONT_HEIGHT + 4));
  const mw = w + 4;
  let cx = 2;
  for (const ch of text) {
    const g = GLYPHS.get(ch.charCodeAt(0)) || GLYPHS.get(63);
    for (let gy = 0; gy < FONT_HEIGHT; gy++) for (let gx = 0; gx < g.width; gx++) if ((g.rows[gy] >> (g.width - 1 - gx)) & 1) m[(gy + 2) * mw + cx + gx] = 1;
    cx += g.advance;
  }
  const rows = frame.length / W;
  for (let my = 0; my < FONT_HEIGHT + 4; my++) {
    for (let mx = 0; mx < mw; mx++) {
      const px = x + mx - 2;
      const py = y + my - 2;
      if (px < 0 || py < 0 || px >= W || py >= rows) continue;
      const i = py * W + px;
      const done = px < hx;
      if (m[my * mw + mx]) frame[i] = done ? sung : fill;
      else if (edge >= 0 && [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => m[(my + dy) * mw + mx + dx]))) frame[i] = edge;
      else if (bar >= 0 && done && my >= 3 && my < FONT_HEIGHT + 1) frame[i] = bar;
      else if (bar >= 0) frame[i] = bg;
    }
  }
  return w;
}

/**
 * Wipes a line (drawn at x by `draw(hx)`) from `t0` to `t1`, a step every 50 ms. → { start, end }:
 * when the disc really re-colours it (the packets of a step can run late).
 */
function wipe(w, frame, draw, x, width, t0, t1) {
  let start = -1;
  for (let t = t0 + 0.05; t <= t1 + 1e-9; t += 0.05) {
    w.padTo(t);
    if (start < 0) start = w.time;
    draw(x + Math.round(((t - t0) / (t1 - t0)) * width));
    w.drawFrame(frame);
  }
  draw(x + width + 1);
  w.drawFrame(frame);
  return { start, end: w.time };
}

/** Pages, the way many brands make them (see above). */
export function pagesDisc() {
  const [BG, WHITE, YELLOW, BLACK, RED, BLUE] = [0, 1, 2, 3, 4, 5];
  const w = new CdgWriter();
  w.loadColors(pal([[0, 0, 4], [15, 15, 15], [15, 15, 0], [0, 0, 0], [15, 2, 2], [4, 8, 15]]));
  w.memoryPreset(BG, 2);
  w.borderPreset(BG);
  let f = w.screen.slice();
  for (const [t, y, c] of [['Harbour Lights', 60, RED], ['in the style of The Lanterns', 100, WHITE], ['OK Karaoke', 150, BLUE]]) drawLine(f, t, centeredX(t), y, { fill: c, edge: BLACK });
  w.drawFrame(f);
  w.padTo(4);
  w.memoryPreset(BG, 2);
  f = w.screen.slice();
  ['KEY OF G', 'TIME 3:05', '8 MEASURE INTRO'].forEach((t, i) => drawLine(f, t, centeredX(t), 50 + i * 30, { fill: YELLOW, edge: BLACK }));
  w.drawFrame(f);
  const lines = [];
  let t = 9;
  VERSES.slice(0, 2).forEach((verse, v) => {
    if (v === 1) t += 12; // the instrumental
    w.padTo(t - 3.2);
    w.memoryPreset(BG, 2);
    f = w.screen.slice();
    if (v === 1) {
      drawLine(f, 'INSTRUMENTAL', centeredX('INSTRUMENTAL'), 90, { fill: WHITE, edge: BLACK });
      w.drawFrame(f);
      w.padTo(t - 1.5);
      f.fill(BG);
      w.drawFrame(f);
    }
    // countdown squares, then the page drawn line by line
    for (let k = 0; k < 4; k++) {
      for (let y = 20; y < 30; y++) f.fill(RED, y * W + 100 + k * 24, y * W + 112 + k * 24);
      w.drawFrame(f);
      w.padTo(w.time + 0.2);
    }
    const ys = [60, 96, 132, 168];
    for (let i = 0; i < 4; i++) {
      drawLine(f, verse[i], centeredX(verse[i]), ys[i], { fill: WHITE, edge: BLACK });
      w.drawFrame(f);
      w.padTo(w.time + 0.1);
    }
    for (let k = 3; k >= 0; k--) {
      w.padTo(Math.max(w.time, t - 0.2 * k));
      for (let y = 20; y < 30; y++) f.fill(BG, y * W + 100 + k * 24, y * W + 112 + k * 24);
      w.drawFrame(f);
    }
    for (let i = 0; i < 4; i++) {
      const text = verse[i];
      const x = centeredX(text);
      const dur = 1.2 + text.length * 0.06;
      const r = wipe(w, f, (hx) => drawLine(f, text, x, ys[i], { fill: WHITE, sung: YELLOW, edge: BLACK, hx }), x, textWidth(text), t, t + dur);
      lines.push({ text, ...r });
      t = Math.max(t + dur, r.end) + 0.35;
    }
  });
  w.padTo(t + 3);
  return { bytes: w.toBuffer(), lines };
}

/** Five lines on screen; each sung line is erased and replaced, a highlight bar behind the wipe. */
export function rollingDisc() {
  const [BG, WHITE, BAR, SUNG] = [0, 1, 2, 3];
  const w = new CdgWriter();
  w.loadColors(pal([[0, 0, 0], [15, 15, 15], [3, 3, 12], [15, 15, 6]]));
  w.memoryPreset(BG, 2);
  w.borderPreset(BG);
  const all = VERSES.flat();
  const f = w.screen.slice();
  const ys = [30, 64, 98, 132, 166];
  for (let i = 0; i < 5; i++) drawLine(f, all[i], centeredX(all[i]), ys[i], { fill: WHITE });
  w.drawFrame(f);
  const lines = [];
  let t = 3;
  all.forEach((text, i) => {
    const y = ys[i % 5];
    const x = centeredX(text);
    const dur = 1 + text.length * 0.05;
    const r = wipe(w, f, (hx) => drawLine(f, text, x, y, { fill: WHITE, sung: SUNG, bar: BAR, bg: BG, hx }), x, textWidth(text), t, t + dur);
    lines.push({ text, ...r });
    t = Math.max(t + dur, r.end) + 0.3;
    w.padTo(t - 0.15);
    for (let yy = y - 3; yy < y + FONT_HEIGHT + 3; yy++) f.fill(BG, yy * W + CDG_VISIBLE_X, yy * W + CDG_VISIBLE_X + 288);
    const next = all[i + 5];
    if (next) drawLine(f, next, centeredX(next), y, { fill: WHITE });
    w.drawFrame(f);
  });
  w.padTo(t + 2);
  return { bytes: w.toBuffer(), lines };
}

/** A duet: him in blue, her in pink, both in white; the fourth line is two lines sung at once. */
export function duetDisc() {
  const [BG, BLUE, PINK, BOTH, SUNG] = [0, 1, 2, 3, 4];
  const w = new CdgWriter();
  w.loadColors(pal([[0, 0, 0], [5, 9, 15], [15, 6, 11], [15, 15, 15], [15, 13, 0]]));
  w.memoryPreset(BG, 2);
  w.borderPreset(BG);
  const page = [['You take the high part', BLUE], ['I will take the low', PINK], ['Together we will sing it', BOTH], ['Him: on and on', BLUE], ['Her: and on we go', PINK]];
  const f = w.screen.slice();
  const ys = [24, 58, 92, 126, 160];
  page.forEach(([text, c], i) => drawLine(f, text, centeredX(text), ys[i], { fill: c }));
  w.drawFrame(f);
  const lines = [];
  let t = 2;
  for (let i = 0; i < 3; i++) {
    const [text, c] = page[i];
    const x = centeredX(text);
    const r = wipe(w, f, (hx) => drawLine(f, text, x, ys[i], { fill: c, sung: SUNG, hx }), x, textWidth(text), t, t + 2);
    lines.push({ text, ...r });
    t = Math.max(t + 2, r.end) + 0.4;
  }
  // both at once
  const [a, b] = [page[3], page[4]];
  const xa = centeredX(a[0]);
  const xb = centeredX(b[0]);
  let start = -1;
  for (let s = 1; s <= 40; s++) {
    w.padTo(t + s * 0.05);
    if (start < 0) start = w.time;
    drawLine(f, a[0], xa, ys[3], { fill: a[1], sung: SUNG, hx: xa + Math.round((s / 40) * textWidth(a[0])) });
    drawLine(f, b[0], xb, ys[4], { fill: b[1], sung: SUNG, hx: xb + Math.round((s / 40) * textWidth(b[0])) });
    w.drawFrame(f);
  }
  lines.push({ text: a[0], start, end: w.time }, { text: b[0], start, end: w.time });
  w.padTo(t + 4);
  return { bytes: w.toBuffer(), lines };
}

/** Lines that pop on and off, never re-coloured. */
export function popOnDisc() {
  const w = new CdgWriter();
  w.loadColors(pal([[0, 0, 0], [15, 15, 15]]));
  w.memoryPreset(0, 2);
  const f = w.screen.slice();
  VERSES.flat().forEach((text, i) => {
    w.padTo(1 + i * 2);
    f.fill(0);
    drawLine(f, text, centeredX(text), CDG_VISIBLE_Y + 80, { fill: 1 });
    w.drawFrame(f);
  });
  w.padTo(VERSES.flat().length * 2 + 3);
  return { bytes: w.toBuffer(), lines: [] };
}
