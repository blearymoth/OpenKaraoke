#!/usr/bin/env node
// Checks how the TV's readable lyrics (shared/lyrics.js, docs/PLAN.md §9) treat a real karaoke
// library: for a random sample of discs, whether they scroll pixel by pixel (and the smoothing
// chosen), which colours are keyed as background, whether the palette is flipped (dark words on
// a light disc), whether halos are tamed, and whether the disc uses DEFINE_TRANSPARENT. Writes PNG
// contact sheets (the panel, clear and disc looks at three moments of each disc) to look through.
// Plain .cdg files only (zipped tracks are skipped). Dev tool: not used at runtime.
//
//   node scripts/lyrics-check.js "<karaoke folder>" [--sample 200] [--out folder] [--seed 1]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdgDecoder, CDG_INSTR, CDG_PACKET_SIZE, CDG_WIDTH, CDG_HEIGHT, CDG_VISIBLE_X, CDG_VISIBLE_Y, findLyricsFrame } from '../shared/cdg.js';
import {
  contrast, keyColours, lyricsLut, maskColours, outlineIndices, oklab, panelBackdrop, readablePalette, roleStats, rolesFromStats, scrollTimeline,
  CONTRAST_TARGET,
} from '../shared/lyrics.js';
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
const totals = { discs: 0, failed: 0, scrolling: 0, smoothed: 0, flipped: 0, halosTamed: 0, defineTransparent: 0, pictureScreens: 0, weakBefore: 0 };
let sheet = [];
let sheetNo = 0;

function writeSheet() {
  if (!sheet.length) return;
  const cols = LOOKS.length * 3;
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
  const roles = rolesFromStats(roleStats(bytes));
  const dec = new CdgDecoder(bytes);
  const best = findLyricsFrame(bytes).time;
  const times = [...new Set([dec.duration * 0.25, best, dec.duration * 0.7].map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
  const tiles = [];
  const keyed = new Set();
  let flip = false;
  let tamed = 0;
  let pictures = 0;
  let weak = 0;
  let prev = 0;
  for (const t of times) {
    dec.seek(t);
    const { K, main } = keyColours(dec, prev);
    prev = K;
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
  };
  rows.push(row);
  if (tl) totals.scrolling++;
  if (tl?.w) totals.smoothed++;
  if (flip) totals.flipped++;
  if (tamed) totals.halosTamed++;
  if (transparent) totals.defineTransparent++;
  if (pictures) totals.pictureScreens++;
  if (weak) totals.weakBefore++;
  const flags = [
    tl ? `scrolls (box ${row.smoothing.boxMs} ms, insets ${tl.insTop}/${tl.insBot})` : '',
    flip ? 'flipped' : '',
    tamed ? 'halos tamed' : '',
    weak ? 'weak colours fixed' : '',
    transparent ? `DEFINE_TRANSPARENT ×${transparent}` : '',
    pictures ? `${pictures} picture screen(s)` : '',
  ].filter(Boolean).join(', ');
  console.log(`${rel}\n    keyed ${row.keyed.join(',') || '-'}; roles ${roles.sig}${flags ? `; ${flags}` : ''}`);
  sheet.push({ label: `${totals.discs}. ${path.basename(file, path.extname(file))}  [panel | clear | disc at ${times.join(' s, ')} s]`, tiles });
  if (sheet.length === PER_SHEET) writeSheet();
}
writeSheet();

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ root, totals, discs: rows }, null, 1));
console.log(`\n${totals.discs} discs: ${totals.scrolling} scroll pixel by pixel (${totals.smoothed} smoothed), ${totals.flipped} flipped to light text,`);
console.log(`${totals.weakBefore} had lyric colours under 7:1, ${totals.halosTamed} had halos tamed, ${totals.defineTransparent} use DEFINE_TRANSPARENT,`);
console.log(`${totals.pictureScreens} show a picture screen (nothing keyed)${totals.failed ? `; ${totals.failed} unreadable` : ''}.`);
console.log(`Contact sheets (${sheetNo}) and report.json in ${outDir}`);
