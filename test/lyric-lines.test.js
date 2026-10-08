// The lyric layouts (docs/PLAN.md §9.6): the sung lines found in a disc (shared/lyric-lines.js) and
// when and where they show (shared/lyric-layout.js), on discs in the styles real discs use
// (test/lyric-discs.js) and on the demo library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLines, linesAsync, MIN_LINES } from '../shared/lyric-lines.js';
import {
  twoLinePlan, shown, scrollPlan, focusAt, stopAt, scrollAlpha, countdownAt, verses, lineScale, ease,
  LEAD, MOVE, FADE_OUT, COUNTDOWN, BREAK, HOLD, SWAP, MIN_LEAD,
} from '../shared/lyric-layout.js';
import { LYRICS_LAYOUTS, DEFAULT_LYRICS_LAYOUT, normalizeLyricsLayout } from '../shared/lyrics.js';
import { CdgWriter, textWidth } from '../scripts/lib/cdg-writer.js';
import { makeCdg, DEMO_SONGS, wrapLine } from '../scripts/make-demo-library.js';
import { pagesDisc, rollingDisc, duetDisc, popOnDisc } from './lyric-discs.js';

const STYLES = { pages: pagesDisc(), rolling: rollingDisc(), duet: duetDisc() };
const found = Object.fromEntries(Object.entries(STYLES).map(([k, d]) => [k, analyzeLines(d.bytes)]));
const demoTiming = (song) => {
  const bar = 240 / song.bpm;
  return { duration: (4 + song.lyrics.length * 2) * bar, barSec: bar, introBars: 2, lineBars: 2 };
};
const demos = DEMO_SONGS.map((song) => ({ song, a: analyzeLines(makeCdg(song, demoTiming(song))) }));

test('settings: the layouts and their default', () => {
  assert.deepEqual(LYRICS_LAYOUTS, ['page', 'lines', 'scroll']);
  assert.equal(DEFAULT_LYRICS_LAYOUT, 'page');
  for (const v of LYRICS_LAYOUTS) assert.equal(normalizeLyricsLayout(v), v);
  for (const bad of ['', 'Lines', '__proto__', 'toString', 3, null, undefined, {}, ['scroll']]) assert.equal(normalizeLyricsLayout(bad), 'page', String(bad));
});

test('lines: every sung line of each disc style, in order, at the disc’s own moments', () => {
  for (const [name, d] of Object.entries(STYLES)) {
    const a = found[name];
    assert.ok(a.ok, `${name}: ${a.reason}`);
    assert.equal(a.lines.length, d.lines.length, `${name}: one line per sung line`);
    assert.ok(a.coverage > 0.95, `${name}: the singing is in the lines (${a.coverage})`);
    a.lines.forEach((l, i) => {
      const want = d.lines[i];
      assert.ok(Math.abs(l.start - want.start) < 0.05, `${name} ${i} "${want.text}": starts at ${l.start}, sung from ${want.start}`);
      assert.ok(l.end <= want.end + 0.05 && l.end > want.end - 0.4, `${name} ${i}: ends at ${l.end} (${want.end})`);
      const slack = name === 'rolling' ? 6 : 4; // (the highlight bar reaches 2 px past the words)
      assert.ok(Math.abs(l.w - textWidth(want.text)) <= slack, `${name} ${i}: as wide as its words (${l.w}, ${textWidth(want.text)})`);
    });
  }
  // the titles, the info card ("KEY OF G"), the countdown squares and "INSTRUMENTAL" are never sung
  assert.ok(found.pages.lines[0].start > 9, 'nothing before the first sung line');
});

test('lines: each pixel turns at its moment of the wipe; the unsung copy has no sung colour', () => {
  const YELLOW = 2;
  for (const l of found.pages.lines) {
    let sungInUnsung = 0;
    let yellow = 0;
    for (let i = 0; i < l.ink.length; i++) {
      if (l.unsung[i] === YELLOW) sungInUnsung++;
      if (l.sung[i] === YELLOW) yellow++;
    }
    assert.equal(sungInUnsung, 0, 'unsung: white letters only');
    assert.ok(yellow > 200, 'sung: yellow letters');
    // left to right: the first sung moment of each 8-pixel column never goes back by more than a step
    let prev = 0;
    for (let x = 0; x < l.w; x += 8) {
      let first = Infinity;
      for (let y = 0; y < l.h; y++) if (l.at[y * l.w + x] > 0) first = Math.min(first, l.at[y * l.w + x]);
      if (first === Infinity) continue;
      assert.ok(first >= prev - 15, `column ${x}: ${first} after ${prev}`);
      prev = first;
    }
  }
  // the highlight bar behind the rolling disc's wipe belongs to its line: background before, bar after
  const BAR = 2;
  const r = found.rolling.lines[0];
  let bar = 0;
  for (let i = 0; i < r.ink.length; i++) if (r.sung[i] === BAR && r.unsung[i] === 0 && r.at[i] > 0) bar++;
  assert.ok(bar > 500, `the bar is sung with the words (${bar} px)`);
});

test('lines: two lines sung at once are two lines', () => {
  const [a, b] = found.duet.lines.slice(3);
  assert.ok(Math.abs(a.start - b.start) < 0.05 && a.y < b.y);
});

test('lines: a disc that never re-colours its words, random bytes, an empty file: not followed', () => {
  const pop = analyzeLines(popOnDisc().bytes);
  assert.equal(pop.ok, false);
  assert.equal(pop.lines.length, 0);
  let seed = 3;
  const rand = new Uint8Array(24 * 300 * 60).map(() => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
  assert.equal(analyzeLines(rand).ok, false);
  assert.equal(analyzeLines(new Uint8Array(0)).ok, false);
  // a picture (no background colour) re-coloured all over: no line
  const w = new CdgWriter();
  w.loadColors(Array.from({ length: 16 }, (_, i) => [i, 15 - i, (i * 5) % 16]));
  w.memoryPreset(0);
  for (let pass = 0; pass < 6; pass++) {
    const f = w.screen.slice();
    for (let i = 0; i < f.length; i++) f[i] = (i * 7 + ((i / 300) | 0) * 3 + pass) % 16;
    w.drawFrame(f);
    w.padTo(w.time + 1);
  }
  assert.equal(analyzeLines(w.toBuffer()).lines.length, 0);
  assert.ok(MIN_LINES >= 3);
});

test('lines: every demo song, its rows in order (pages written over pages, a smooth scroller)', () => {
  for (const { song, a } of demos) {
    const rows = song.scroll ? song.lyrics.length : song.lyrics.flatMap((l) => wrapLine(l)).length;
    assert.ok(a.ok, `${song.title}: ${a.reason}`);
    assert.equal(a.lines.length, rows, `${song.title}: one line per row`);
    for (let j = 1; j < a.lines.length; j++) assert.ok(a.lines[j].start >= a.lines[j - 1].end - 0.05, `${song.title}: line ${j} starts after line ${j - 1} ends`);
  }
});

test('lines: the async pass gives the same lines, and stops when cancelled', async () => {
  const d = STYLES.pages;
  const a = await linesAsync(d.bytes, { sliceMs: 1 });
  assert.deepEqual(a.lines.map((l) => [l.start, l.end, l.w, l.h]), found.pages.lines.map((l) => [l.start, l.end, l.w, l.h]));
  assert.equal(await linesAsync(d.bytes, { sliceMs: 0, cancelled: () => true }), null);
});

test('lines: a long disc is analysed quickly', () => {
  // ≈4 minutes: the pages disc's packets five times over
  const one = STYLES.pages.bytes;
  const long = new Uint8Array(one.length * 5);
  for (let i = 0; i < 5; i++) long.set(one, i * one.length);
  const t0 = performance.now();
  const a = analyzeLines(long);
  const ms = performance.now() - t0;
  assert.equal(a.lines.length, 40);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});

// ---- when and where (shared/lyric-layout.js) -------------------------------------------------

const allSongs = () => [...Object.entries(found).map(([name, a]) => [name, a.lines]), ...demos.map(({ song, a }) => [song.title, a.lines])];

test('two lines: a line never leaves before it is sung, and shows well before', () => {
  for (const [name, lines] of allSongs()) {
    const plan = twoLinePlan(lines);
    const vs = verses(lines);
    lines.forEach((l, j) => {
      const p = plan[j];
      assert.ok(p.out >= l.end, `${name} ${j}: stays until sung`);
      const first = vs.some(([g0]) => g0 === j || g0 + 1 === j);
      // lead: a verse's first two lines LEAD s before it starts (less at the very start of a song); the others for the whole line before
      const lead = l.start - p.in;
      if (first) assert.ok(lead >= Math.min(LEAD, l.start) - 1e-9 || lead >= 2, `${name} ${j}: ${lead.toFixed(2)} s ahead`);
      else if (l.start - lines[j - 1].start >= 0.5) assert.ok(p.in <= lines[j - 2].end + HOLD + FADE_OUT + SWAP + 1e-9, `${name} ${j}: up once the line two before is sung (${lead.toFixed(2)} s ahead)`);
      else assert.ok(p.in <= plan[j - 2].out + FADE_OUT + SWAP + 1e-9 && lead > 0, `${name} ${j}: sung with the line before: up as soon as its place is free`);
      // at least MIN_LEAD ahead, or as much as the line two before leaves (a very short line between)
      if (!first) assert.ok(lead >= Math.min(MIN_LEAD, l.start - lines[j - 2].end - FADE_OUT) - 1e-9, `${name} ${j}: ${lead.toFixed(2)} s ahead`);
      // never two lines in one place at once
      for (let i = 0; i < j; i++) {
        if (plan[i].slot !== p.slot) continue;
        assert.ok(plan[i].out + FADE_OUT <= p.in + 1e-9 || p.out + FADE_OUT <= plan[i].in + 1e-9, `${name}: lines ${i} and ${j} share a place`);
      }
    });
    // while a line is sung, the next one of its verse is up too
    for (let j = 0; j + 1 < lines.length; j++) {
      if (lines[j + 1].start - lines[j].end > BREAK) continue;
      const t = (lines[j].start + lines[j].end) / 2;
      assert.ok(shown(plan[j], t) === 1 && shown(plan[j + 1], t) > 0, `${name} ${j}: the next line is up while it is sung`);
    }
  }
});

test('two lines: places alternate within a verse; a long pause clears the screen', () => {
  const lines = found.pages.lines;
  const plan = twoLinePlan(lines);
  assert.deepEqual(plan.map((p) => p.slot), [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(verses(lines), [[0, 3], [4, 7]], 'the instrumental splits the song');
  const mid = (lines[3].end + lines[4].start) / 2;
  assert.ok(lines[4].start - lines[3].end > BREAK + 4);
  assert.equal(plan.filter((p) => shown(p, mid) > 0).length, 0, 'nothing up in the middle of the instrumental');
  assert.ok(Math.abs(plan[4].in - (lines[4].start - LEAD)) < 1e-9, 'the next verse comes in LEAD s before');
});

test('scrolling: one glide per stop, eased, never backwards, done about when the line starts', () => {
  for (const [name, lines] of allSongs()) {
    const plan = scrollPlan(lines);
    const { at, stop } = plan;
    for (let s = 1; s < at.length; s++) assert.ok(at[s] >= at[s - 1] + (s > 1 ? MOVE : 0) - 1e-9, `${name} stop ${s}: glides never overlap`);
    lines.forEach((l, j) => {
      if (!stop[j]) return;
      assert.ok(at[stop[j]] <= l.start + 1e-9, `${name} ${j}: the glide to it starts by the time it starts`);
      const before = lines.slice(0, j).filter((_, i) => stop[i] < stop[j]);
      const prevEnd = Math.max(...before.map((x) => x.end));
      assert.ok(at[stop[j]] >= Math.min(prevEnd - 0.1, l.start) - 1e-9, `${name} ${j}: the lines before are (nearly) sung`);
    });
    let maxStep = 1;
    for (let k = 1; k < plan.to.length; k++) maxStep = Math.max(maxStep, plan.to[k] - plan.to[k - 1]);
    let prev = -1;
    for (let t = 0; t < lines.at(-1).end + 2; t += 1 / 60) {
      const f = focusAt(plan, t);
      assert.ok(f >= prev - 1e-12, `${name}: the focus never goes back (t ${t.toFixed(2)})`);
      if (prev >= 0) assert.ok(f - prev <= (1.5 * maxStep) / MOVE / 60 + 1e-9, `${name}: at most 1.5× the mean glide speed (t ${t.toFixed(2)})`);
      prev = f;
    }
    // in the middle of each line it is in focus (with the lines sung with it)
    lines.forEach((l, j) => {
      const t = Math.max(l.start + MOVE, (l.start + l.end) / 2);
      if (t > l.end || lines.some((x, i) => i > j && stop[i] !== stop[j] && x.start <= t)) return;
      assert.ok(Math.abs(stopAt(plan, t) - stop[j]) < 1e-9, `${name} ${j}: in focus while sung`);
    });
  }
  const duet = scrollPlan(found.duet.lines);
  assert.equal(duet.stop[3], duet.stop[4], 'two lines sung at once: one stop');
  assert.equal(duet.to[duet.stop[3]], 3.5, '…between them');
});

test('scrolling: the line in focus is the brightest; easing; countdowns; the scale', () => {
  assert.equal(scrollAlpha(0), 1);
  assert.ok(scrollAlpha(1) < 0.7 && scrollAlpha(-1) < scrollAlpha(1), 'sung lines dimmer than the ones to come');
  for (let d = -2; d < 2; d += 0.01) assert.ok(Math.abs(scrollAlpha(d + 0.01) - scrollAlpha(d)) < 0.03, 'no jump in brightness');
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(0.5), 0.5);
  const lines = found.pages.lines;
  assert.equal(countdownAt(lines, 0, lines[0].start - 2.5), 3);
  assert.equal(countdownAt(lines, 0, lines[0].start - 0.2), 1);
  assert.equal(countdownAt(lines, 0, lines[0].start - COUNTDOWN - 0.1), 0);
  assert.equal(countdownAt(lines, 1, lines[1].start - 0.2), 0, 'no countdown right after a line');
  assert.equal(countdownAt(lines, 4, lines[4].start - 1.5), 2, 'after the instrumental');
  const k = lineScale(lines, 1392, 928, { rows: 2.6, gap: 11 });
  assert.ok(Math.abs(k * Math.max(...lines.map((l) => l.w)) - 1392 * 0.96) < 1e-6, 'the widest line fits the box');
  assert.equal(lineScale(lines, 1392, 928, { whole: true }) % 1, 0);
});
