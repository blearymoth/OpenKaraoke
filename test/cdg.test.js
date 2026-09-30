import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdgDecoder, scale2x, pickLyricsFrame, CDG_WIDTH } from '../shared/cdg.js';
import { CdgWriter } from '../scripts/lib/cdg-writer.js';

const PALETTE = [[0, 0, 0], [15, 15, 15], [15, 0, 0], [0, 15, 0], [0, 0, 15], [15, 8, 1]];
const px = (dec, x, y) => dec.pixels[y * CDG_WIDTH + x];

test('colour table, memory/border preset and tiles', () => {
  const w = new CdgWriter()
    .loadColors(PALETTE)
    .memoryPreset(4)
    .memoryPreset(9, 1) // redundant repeat -> ignored
    .borderPreset(2)
    .tile(5, 10, 0, 1, [0b100000, 0b010000, 0b001000, 0b000100, 0b000010, 0b000001, 0, 0, 0, 0, 0, 0b111111]);
  const dec = new CdgDecoder(w.toBuffer());
  dec.seekPacket(dec.packetCount);
  assert.deepEqual([...dec.palette.subarray(0, 9)], [0, 0, 0, 255, 255, 255, 255, 0, 0]);
  assert.deepEqual([...dec.palette.subarray(15, 18)], [255, 136, 17]);
  assert.equal(dec.bgColor, 4);
  assert.equal(px(dec, 0, 0), 2, 'border');
  assert.equal(px(dec, 299, 215), 2, 'border');
  assert.equal(px(dec, 150, 100), 4, 'paper');
  // tile at x=60, y=60: diagonal of colour 1 over colour 0
  assert.equal(px(dec, 60, 60), 1);
  assert.equal(px(dec, 61, 60), 0);
  assert.equal(px(dec, 61, 61), 1);
  assert.equal(px(dec, 65, 65), 1);
  for (let x = 60; x < 66; x++) assert.equal(px(dec, x, 71), 1);
});

test('XOR tiles toggle colours; transparency and rgba lookup', () => {
  const w = new CdgWriter().loadColors(PALETTE).memoryPreset(0)
    .tile(1, 1, 0, 1, new Array(12).fill(0b111111))
    .tile(1, 1, 0, 3, new Array(12).fill(0b111000), true)
    .transparent(5);
  const dec = new CdgDecoder(w.toBuffer());
  dec.seekPacket(dec.packetCount);
  assert.equal(px(dec, 6, 12), 1 ^ 3);
  assert.equal(px(dec, 9, 12), 1);
  const lut = dec.rgba32({ transparentBg: true });
  assert.equal(lut[0] >>> 24, 0, 'paper is transparent');
  assert.equal(lut[5] >>> 24, 0, 'defined transparent colour');
  assert.equal(lut[1], 0xffffffff);
  assert.equal(dec.rgba32()[0] >>> 24, 255);
});

test('scroll copy wraps, scroll preset fills, offsets shift the view', () => {
  const w = new CdgWriter().loadColors(PALETTE).memoryPreset(0)
    .tile(0, 0, 3, 3, new Array(12).fill(0)) // top-left tile colour 3
    .scroll({ vCmd: 2, copy: true }); // up 12 px -> top row wraps to the bottom
  const dec = new CdgDecoder(w.toBuffer());
  dec.seekPacket(dec.packetCount);
  assert.equal(px(dec, 0, 0), 0);
  assert.equal(px(dec, 0, 204), 3);

  const w2 = new CdgWriter().loadColors(PALETTE).memoryPreset(0)
    .tile(0, 0, 3, 3, new Array(12).fill(0))
    .scroll({ color: 5, hCmd: 1, copy: false }); // right 6 px, vacated column filled
  const d2 = new CdgDecoder(w2.toBuffer());
  d2.seekPacket(d2.packetCount);
  assert.equal(px(d2, 0, 0), 5);
  assert.equal(px(d2, 6, 0), 3);

  const w3 = new CdgWriter().loadColors(PALETTE).memoryPreset(0)
    .tile(2, 2, 1, 1, new Array(12).fill(0))
    .scroll({ hOffset: 3, vOffset: 5 });
  const d3 = new CdgDecoder(w3.toBuffer());
  d3.seekPacket(d3.packetCount);
  assert.equal(d3.hOffset, 3);
  assert.equal(d3.vOffset, 5);
  // visible (9, 19) shows buffer (12, 24) = tile (2, 2)
  assert.equal(d3.displayIndex(9, 19), 1);
  const idx = d3.indices();
  assert.equal(idx.length, 288 * 192);
  assert.equal(idx[(19 - 12) * 288 + (9 - 6)], 1);
});

test('seeking backwards replays from the start; seekTime uses 300 packets/s', () => {
  const w = new CdgWriter().loadColors(PALETTE).memoryPreset(1).padToTime(2).memoryPreset(2);
  const dec = new CdgDecoder(w.toBuffer());
  assert.equal(dec.seekTime(1), true);
  assert.equal(dec.bgColor, 1);
  dec.seekTime(3);
  assert.equal(dec.bgColor, 2);
  assert.equal(dec.seekTime(3), false, 'nothing changed');
  dec.seekTime(0.5);
  assert.equal(dec.bgColor, 1);
  assert.equal(dec.packetCount, 601); // 2 colour packets + preset + padding to 600 + preset
  assert.ok(Math.abs(dec.duration - 601 / 300) < 1e-9);
});

test('text rendering, lyrics frame picker and scale2x', () => {
  const w = new CdgWriter().loadColors(PALETTE).memoryPreset(0).padToTime(10)
    .text('HELLO WORLD', 8, 3, 1, 0).padToTime(20).memoryPreset(0).padToTime(30);
  const buf = w.toBuffer();
  const best = pickLyricsFrame(buf, { from: 0, to: 1, step: 1 });
  assert.ok(best.time >= 10 && best.time < 20, `picked ${best.time}`);
  assert.ok(best.ink > 0.01);

  const src = Uint8Array.from([0, 1, 1, 1]); // 2x2: diagonal edge
  const out = scale2x(src, 2, 2);
  assert.equal(out.length, 16);
  assert.equal(out[0], 0);
  assert.equal(out[15], 1);
});

test('decodes a large stream quickly (seek from 0 to the end)', () => {
  const w = new CdgWriter().loadColors(PALETTE).memoryPreset(0);
  for (let i = 0; i < 5000; i++) w.tile(i % 18, i % 50, 0, 1 + (i % 4), new Array(12).fill(i & 63)).pad(10);
  const dec = new CdgDecoder(w.toBuffer());
  const t0 = performance.now();
  dec.seekPacket(dec.packetCount);
  dec.seekPacket(0);
  dec.seekPacket(dec.packetCount);
  assert.ok(performance.now() - t0 < 200);
});
