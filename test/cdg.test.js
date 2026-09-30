import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdgDecoder, scale2x, indicesToRgba, findLyricsFrame, CDG_WIDTH, CDG_HEIGHT } from '../shared/cdg.js';
import { CdgWriter, drawText, textWidth, centeredX } from '../scripts/lib/cdg-writer.js';

const W = CDG_WIDTH;
const PALETTE = Array.from({ length: 16 }, (_, i) => [i, 15 - i, (i * 5) % 16]);
const px = (dec, x, y) => dec.pixels[y * W + x];

test('colour tables, presets and tiles', () => {
  const w = new CdgWriter();
  w.loadColors(PALETTE);
  w.memoryPreset(2);
  w.borderPreset(5);
  w.tile(3, 4, 1, 7, [0b100001, 0b010010, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0b111111]);
  const dec = new CdgDecoder(w.toBuffer());
  assert.equal(dec.duration, w.count / 300);
  dec.seek(dec.duration);
  assert.deepEqual([...dec.palette.slice(3 * 3, 3 * 3 + 3)], [3 * 17, 12 * 17, 15 * 17]);
  assert.equal(dec.bgColor, 2);
  assert.equal(dec.borderColor, 5);
  assert.equal(px(dec, 0, 0), 5, 'border');
  assert.equal(px(dec, 299, 100), 5, 'border right');
  assert.equal(px(dec, 150, 100), 2, 'background');
  const x0 = 4 * 6;
  const y0 = 3 * 12;
  assert.equal(px(dec, x0, y0), 7, 'bit 5 is the leftmost pixel');
  assert.equal(px(dec, x0 + 1, y0), 1);
  assert.equal(px(dec, x0 + 5, y0), 7);
  assert.equal(px(dec, x0 + 1, y0 + 1), 7);
  assert.equal(px(dec, x0 + 3, y0 + 11), 7);
  assert.deepEqual(dec.pixels, w.screen, 'writer mirror matches the decoder');
});

test('XOR tiles flip colours', () => {
  const w = new CdgWriter();
  w.memoryPreset(0);
  w.tile(0, 0, 1, 1, new Array(12).fill(0));
  w.tile(0, 0, 0, 3, [0b111000, ...new Array(11).fill(0)], true);
  const dec = new CdgDecoder(w.toBuffer());
  dec.seek(10);
  assert.equal(px(dec, 0, 0), 1 ^ 3);
  assert.equal(px(dec, 3, 0), 1);
});

test('drawFrame turns any frame into tile packets, including 3-colour tiles', () => {
  const w = new CdgWriter();
  w.loadColors(PALETTE);
  w.memoryPreset(0);
  const frame = w.screen.slice();
  const x = centeredX('Hello World');
  const width = drawText(frame, 'Hello World', x, 60, 15, { highlightX: x + 40, highlightColor: 9, shadowColor: 1 });
  assert.equal(width, textWidth('Hello World'));
  w.drawFrame(frame);
  assert.deepEqual(w.screen, frame);
  const dec = new CdgDecoder(w.toBuffer());
  dec.seek(dec.duration);
  assert.deepEqual(dec.pixels, frame);
  const colors = new Set(frame);
  assert.ok(colors.has(9) && colors.has(15) && colors.has(1), 'highlight, text and shadow present');
});

test('scroll copy wraps, scroll preset fills, offsets shift the visible area', () => {
  const w = new CdgWriter();
  w.memoryPreset(0);
  w.tile(1, 2, 0, 4, new Array(12).fill(0b111111)); // solid tile at row 1, col 2
  w.scroll(true, 0, 0, 0, 2, 0); // copy, up 12 px
  let dec = new CdgDecoder(w.toBuffer());
  dec.seek(10);
  assert.equal(px(dec, 12, 0), 4, 'moved up one tile row');
  assert.equal(px(dec, 12, 12), 0);
  w.scroll(true, 0, 0, 0, 2, 0); // wraps to the bottom row
  dec = new CdgDecoder(w.toBuffer());
  dec.seek(10);
  assert.equal(px(dec, 12, CDG_HEIGHT - 12), 4, 'wrapped around');
  w.scroll(false, 6, 1, 0, 0, 0); // preset, right 6 px, fills with colour 6
  dec = new CdgDecoder(w.toBuffer());
  dec.seek(10);
  assert.equal(px(dec, 18, CDG_HEIGHT - 12), 4, 'moved right');
  assert.equal(px(dec, 0, 50), 6, 'uncovered column filled');
  assert.deepEqual(dec.pixels, w.screen);

  w.scroll(false, 0, 0, 3, 0, 5); // offsets only
  dec = new CdgDecoder(w.toBuffer());
  dec.seek(10);
  assert.equal(dec.hOffset, 3);
  assert.equal(dec.vOffset, 5);
  assert.equal(dec.visibleIndex(0, 0), px(dec, 6 + 3, 12 + 5));
});

test('seeking backwards replays from the start', () => {
  const w = new CdgWriter();
  w.memoryPreset(1);
  w.padTo(2);
  w.memoryPreset(3);
  const dec = new CdgDecoder(w.toBuffer());
  assert.equal(dec.seek(1), true);
  assert.equal(dec.bgColor, 1);
  assert.equal(dec.seek(1.5), false, 'nothing new between 1 s and 1.5 s');
  dec.seek(3);
  assert.equal(dec.bgColor, 3);
  const v = dec.version;
  dec.seek(0.5);
  assert.equal(dec.bgColor, 1);
  assert.ok(dec.version > v);
});

test('non-CDG packets and out-of-range tiles are ignored', () => {
  const w = new CdgWriter();
  w.memoryPreset(2);
  w.packet(6, [1, 1, 30, 60, ...new Array(12).fill(63)]); // row/col out of range
  const bytes = w.toBuffer();
  const junk = new Uint8Array(24);
  junk[0] = 8; // not a CD+G command
  junk[1] = 1;
  junk[4] = 9;
  const all = new Uint8Array(bytes.length + 24);
  all.set(bytes);
  all.set(junk, bytes.length);
  const dec = new CdgDecoder(all);
  dec.seek(10);
  assert.ok(dec.pixels.every((p) => p === 2));
});

test('scale2x keeps edges crisp and rgba mapping applies alpha', () => {
  // 3×3 diagonal: EPX rounds the staircase
  const src = new Uint8Array([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  const out = scale2x(src, 3, 3);
  assert.equal(out.length, 36);
  assert.equal(out[0], 1);
  assert.equal(out[6 * 2 + 2], 1, 'centre pixel stays');
  assert.equal(out[6 * 1 + 2], 1, 'EPX fills the staircase next to the diagonal');
  assert.equal(out[6 * 0 + 5], 0, 'far corner stays background');

  const palette = new Uint8Array(48);
  palette.set([255, 0, 0], 3);
  const rgba = new Uint8ClampedArray(4 * 2);
  const alpha = new Uint8Array(16).fill(255);
  alpha[0] = 0;
  indicesToRgba(new Uint8Array([0, 1]), palette, rgba, alpha);
  assert.deepEqual([...rgba], [0, 0, 0, 0, 255, 0, 0, 255]);
});

test('findLyricsFrame prefers screens with text', () => {
  const w = new CdgWriter();
  w.memoryPreset(0);
  w.padTo(40);
  const frame = w.screen.slice();
  drawText(frame, 'The busiest lyric line', 20, 80, 15);
  drawText(frame, 'and another one below', 20, 110, 15);
  w.drawFrame(frame);
  w.padTo(55);
  w.memoryPreset(0);
  w.padTo(100);
  const r = findLyricsFrame(w.toBuffer());
  assert.ok(r.time >= 41 && r.time <= 55, `picked ${r.time}`);
  assert.ok(r.ink > 500);
});
