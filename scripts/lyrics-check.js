#!/usr/bin/env node
// Checks how the TV's readable lyrics (shared/lyrics.js, docs/PLAN.md §9) treat a real karaoke
// library: for a random sample of discs, whether they scroll pixel by pixel (and the smoothing
// chosen), which colours are keyed as background, whether the palette is flipped (dark words on
// a light disc), whether halos are tamed, and whether the disc uses DEFINE_TRANSPARENT; and for the
// other layouts (PLAN §9.6) whether its sung lines can be followed (else the TV keeps its pages, and
// why), how many, and how early a line shows in the two-line layout against the disc's own page
// turns. Writes PNG contact sheets (the panel, clear and disc looks at three moments of each disc,
// then the two-line layout at the middle moment) to look through.
// Plain .cdg files only (zipped tracks are skipped). Dev tool: not used at runtime.
//
//   node scripts/lyrics-check.js "<karaoke folder>" [--sample 200] [--out folder] [--seed 1]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdgDecoder, CDG_INSTR, CDG_PACKET_SIZE, CDG_WIDTH, CDG_HEIGHT, CDG_VISIBLE_X, CDG_VISIBLE_Y, findLyricsFrame } from '../shared/cdg.js';
import {
  contrast, ScreenKeying, lyricsLut, maskColours, outlineIndices, oklab, panelBackdrop, readablePalette, roleStats, rolesFromStats, scrollTimeline,
  CONTRAST_TARGET,
} from '../shared/lyrics.js';
import { analyzeLines } from '../shared/lyric-lines.js';
import { twoLinePlan, shown } from '../shared/lyric-layout.js';
import { GLYPHS, FONT_HEIGHT } from './lib/cdg-font.js';
import { encodePng } from './lib/png.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!root) {
  console.error('Usage: node scripts/lyrics-check.js "<karaoke folder>" [--sample 200] [--out folder] [--seed 1]');
  process.exit(1);
}
const sampleSize = Math.max(1, Number(opt('--sample', 200)) || 200);
const outDir = path.resolve(opt('--out', path.join(os.tmpdir(), 'openkaraoke-lyrics-check')));
const firstSeed = Number(opt('--seed', Date.now() % 100000)) >>> 0;
let seed = firstSeed;
const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

// Studio's plate and outline (public/css/base.css: --night-rgb at 0.9, --shade-rgb)
const PLATE = { rgb: [10, 17, 32], a: 0.9 };
const OUTLINE = { rgb: [4, 8, 16], a: 0.9 };
const LOOKS = ['panel', 'clear', 'disc'];
const TW = 288;
const TH = 192;
const LABEL = 26;
const PER_SHEET = 8;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.cdg$/i.test(e.name)) yield p;
  }
}

process.stderr.write(`Looking for .cdg files in ${root} …\n`);
const files = [...walk(root)];
for (let i = files.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [files[i], files[j]] = [files[j], files[i]];
}
const sample = files.slice(0, sampleSize);
console.log(`${files.length} .cdg files, checking ${sample.length} (--seed ${firstSeed} picks the same ones again)`);
fs.mkdirSync(outDir, { recursive: true });

/** One 288×192 tile: the window at the decoder's offsets, in `look`, over its backdrop. */
function tile(dec, look, K, main, roles) {
  const lut = lyricsLut(look, dec.palette, K, main, roles, PLATE, OUTLINE);
  const idx = outlineIndices(dec.pixels, K, look === 'clear', 0, 0, CDG_WIDTH, CDG_HEIGHT, new Uint8Array(CDG_WIDTH * CDG_HEIGHT));
  const panel = panelBackdrop(PLATE);
  const out = new Uint8Array(TW * TH * 4);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const c = idx[(y + CDG_VISIBLE_Y + dec.vOffset) * CDG_WIDTH + x + CDG_VISIBLE_X + dec.hOffset];
      const word = lut[c];
      const a = (word >>> 24) / 255;
      // what shows through: the plate (panel), a stand-in for busy artwork (clear), nothing (disc)
      const back = look === 'panel' ? panel : ((x >> 3) + (y >> 3)) & 1 ? [150, 120, 90] : [70, 110, 140];
      const o = (y * TW + x) * 4;
      out[o] = Math.round((word & 255) * a + back[0] * (1 - a));
      out[o + 1] = Math.round(((word >>> 8) & 255) * a + back[1] * (1 - a));
      out[o + 2] = Math.round(((word >>> 16) & 255) * a + back[2] * (1 - a));
      out[o + 3] = 255;
    }
  }
  return out;
}

/** One 288×192 tile of the two-line layout at time t (panel look), or a grey tile saying why not. */
function linesTile(a, t, roles) {
  const out = new Uint8Array(TW * TH * 4);
  const panel = panelBackdrop(PLATE);
  for (let i = 0; i < TW * TH; i++) out.set([...panel, 255], i * 4);
  if (!a.ok) {
    for (let i = 0; i < TW * TH; i++) out.set([60, 60, 60, 255], i * 4);
    text(out, TW, 6, 80, `pages: ${a.reason}`.slice(0, 40), [255, 200, 120]);
    return out;
  }
  const plan = twoLinePlan(a.lines);
  const hMax = Math.max(...a.lines.map((l) => l.h));
  const top = Math.round(TH * 0.6 - hMax - 6);
  const p = Math.floor(t * 300);
  a.lines.forEach((l, j) => {
    const alpha = shown(plan[j], t);
    if (alpha <= 0) return;
    const lut = lyricsLut('panel', l.palette, l.K, l.main, roles, PLATE, OUTLINE);
    const ox = Math.round((TW - l.w) / 2);
    const oy = top + plan[j].slot * (hMax + 12) + Math.round((hMax - l.h) / 2);
    for (let y = 0; y < l.h; y++) {
      for (let x = 0; x < l.w; x++) {
        const i = y * l.w + x;
        const word = lut[l.at[i] > 0 && l.at[i] <= p ? l.sung[i] : l.unsung[i]];
        const a8 = ((word >>> 24) / 255) * alpha;
        if (!a8 || ox + x >= TW || oy + y >= TH || oy + y < 0) continue;
        const o = ((oy + y) * TW + ox + x) * 4;
        out[o] = Math.round((word & 255) * a8 + out[o] * (1 - a8));
        out[o + 1] = Math.round(((word >>> 8) & 255) * a8 + out[o + 1] * (1 - a8));
        out[o + 2] = Math.round(((word >>> 16) & 255) * a8 + out[o + 2] * (1 - a8));
      }
    }
  });
  return out;
}

function text(img, w, x, y, str, rgb) {
  for (const ch of str) {
    const g = GLYPHS.get(ch.charCodeAt(0)) || GLYPHS.get(63);
    for (let gy = 0; gy < FONT_HEIGHT; gy++) {
      for (let gx = 0; gx < g.width; gx++) {
        if (!((g.rows[gy] >> (g.width - 1 - gx)) & 1)) continue;
        const px = x + gx;
        const py = y + gy;
        if (px < 0 || px >= w || py < 0 || py * w * 4 >= img.length) continue;
        img.set(rgb, (py * w + px) * 4);
      }
    }
    x += g.advance;
    if (x > w) break;
  }
}

const rows = [];
const totals = { discs: 0, failed: 0, scrolling: 0, smoothed: 0, flipped: 0, halosTamed: 0, defineTransparent: 0, pictureScreens: 0, weakBefore: 0, linesOk: 0, earlier: 0 };
const pageReasons = new Map();
let sheet = [];
let sheetNo = 0;

function writeSheet() {
  if (!sheet.length) return;
  const cols = LOOKS.length * 3 + 1;
  const w = cols * (TW + 4) - 4;
  const h = sheet.length * (TH + LABEL + 6);
  const img = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) img.set([28, 28, 28, 255], i * 4);
  sheet.forEach((row, r) => {
    const oy = r * (TH + LABEL + 6);
    text(img, w, 4, oy, row.label, [255, 230, 120]);
    row.tiles.forEach((t, c) => {
      const ox = c * (TW + 4);
      for (let y = 0; y < TH; y++) img.set(t.subarray(y * TW * 4, (y + 1) * TW * 4), ((oy + LABEL + y) * w + ox) * 4);
    });
  });
  const file = path.join(outDir, `sheet-${String(++sheetNo).padStart(3, '0')}.png`);
  fs.writeFileSync(file, encodePng(img, w, h));
  sheet = [];
}

for (const file of sample) {
  const rel = path.relative(root, file);
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(file));
  } catch (err) {
    totals.failed++;
    console.log(`! ${rel}: ${err.message}`);
    continue;
  }
  totals.discs++;
  const tl = scrollTimeline(bytes);
  let transparent = 0;
  for (let i = 0; i + CDG_PACKET_SIZE <= bytes.length; i += CDG_PACKET_SIZE) {
    if ((bytes[i] & 0x3f) === 9 && (bytes[i + 1] & 0x3f) === CDG_INSTR.DEFINE_TRANSPARENT) transparent++;
  }
  const keying = new ScreenKeying(); // as the TV keys: held still for each screen
  const roles = rolesFromStats(roleStats(bytes, { screens: keying.screens }));
  const dec = new CdgDecoder(bytes);
  const best = findLyricsFrame(bytes).time;
  const times = [...new Set([dec.duration * 0.25, best, dec.duration * 0.7].map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
  const tiles = [];
  const keyed = new Set();
  let flip = false;
  let tamed = 0;
  let pictures = 0;
  let weak = 0;
  for (const t of times) {
    dec.seek(t);
    const { K, main } = keying.key(dec, new Uint32Array(16));
    if (!K) pictures++;
    for (const c of maskColours(K)) keyed.add(c);
    if (K) {
      const r = readablePalette(dec.palette, K, main, roles, PLATE);
      const rgb = (p, c) => [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]];
      const before = (c) => (r.flip ? 1 - oklab(rgb(dec.palette, c))[0] : oklab(rgb(dec.palette, c))[0]);
      flip ||= r.flip;
      for (const c of r.edges) if (oklab(rgb(r.rgb, c))[0] < before(c) - 0.01) tamed++;
      for (const c of r.fills) if (contrast(rgb(dec.palette, c), panelBackdrop(PLATE)) < CONTRAST_TARGET) weak++;
    }
    for (const look of LOOKS) tiles.push(tile(dec, look, K, main, roles));
  }
  const lines = analyzeLines(bytes);
  tiles.push(linesTile(lines, times[Math.floor(times.length / 2)], roles));
  // how early each line shows: the disc (from when it is drawn) and the two-line layout
  const plan = lines.ok ? twoLinePlan(lines.lines) : [];
  const leadDisc = lines.lines.length ? Math.min(...lines.lines.map((l) => l.start - l.appear)) : null;
  const leadOurs = plan.length ? Math.min(...lines.lines.map((l, j) => l.start - plan[j].in)) : null;
  const row = {
    file: rel,
    seconds: Math.round(dec.duration),
    scrolls: !!tl,
    smoothing: tl ? { boxMs: Math.round((tl.w / 300) * 1000), insets: [tl.insTop, tl.insBot], maxDev: +tl.dev.toFixed(2) } : null,
    keyed: [...keyed].sort((a, b) => a - b),
    roles: roles.sig,
    flipped: flip,
    halosTamed: tamed > 0,
    weakColoursBefore: weak > 0,
    pictureScreens: pictures,
    defineTransparent: transparent,
    times,
    lines: { ok: lines.ok, reason: lines.reason, count: lines.lines.length, coverage: +lines.coverage.toFixed(3), leadDisc: leadDisc === null ? null : +leadDisc.toFixed(2), leadTwoLines: leadOurs === null ? null : +leadOurs.toFixed(2) },
  };
  rows.push(row);
  if (tl) totals.scrolling++;
  if (tl?.w) totals.smoothed++;
  if (flip) totals.flipped++;
  if (tamed) totals.halosTamed++;
  if (transparent) totals.defineTransparent++;
  if (pictures) totals.pictureScreens++;
  if (weak) totals.weakBefore++;
  if (lines.ok) totals.linesOk++;
  else pageReasons.set(lines.reason.replace(/\d+/g, 'N'), (pageReasons.get(lines.reason.replace(/\d+/g, 'N')) || 0) + 1);
  if (lines.ok && leadOurs > leadDisc) totals.earlier++;
  const flags = [
    tl ? `scrolls (box ${row.smoothing.boxMs} ms, insets ${tl.insTop}/${tl.insBot})` : '',
    flip ? 'flipped' : '',
    tamed ? 'halos tamed' : '',
    weak ? 'weak colours fixed' : '',
    transparent ? `DEFINE_TRANSPARENT ×${transparent}` : '',
    pictures ? `${pictures} picture screen(s)` : '',
    lines.ok ? `${lines.lines.length} lines (${Math.round(lines.coverage * 100)} % of the singing), two lines show each ${leadOurs.toFixed(1)} s+ ahead (the disc ${leadDisc.toFixed(1)} s)` : `kept as pages (${lines.reason})`,
  ].filter(Boolean).join(', ');
  console.log(`${rel}\n    keyed ${row.keyed.join(',') || '-'}; roles ${roles.sig}${flags ? `; ${flags}` : ''}`);
  sheet.push({ label: `${totals.discs}. ${path.basename(file, path.extname(file))}  [panel | clear | disc at ${times.join(' s, ')} s | two lines]`, tiles });
  if (sheet.length === PER_SHEET) writeSheet();
}
writeSheet();

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ root, totals, discs: rows }, null, 1));
console.log(`\n${totals.discs} discs: ${totals.scrolling} scroll pixel by pixel (${totals.smoothed} smoothed), ${totals.flipped} flipped to light text,`);
console.log(`${totals.weakBefore} had lyric colours under 7:1, ${totals.halosTamed} had halos tamed, ${totals.defineTransparent} use DEFINE_TRANSPARENT,`);
console.log(`${totals.pictureScreens} show a picture screen (nothing keyed)${totals.failed ? `; ${totals.failed} unreadable` : ''}.`);
console.log(`Layouts: ${totals.linesOk} of ${totals.discs} discs can be shown as two lines / scrolling (${totals.earlier} show their lines earlier than the disc does);`);
console.log(`kept as pages: ${[...pageReasons].map(([r, n]) => `${n} × ${r}`).join(', ') || 'none'}.`);
console.log(`Contact sheets (${sheetNo}) and report.json in ${outDir}`);
