#!/usr/bin/env node
// End-to-end checks of the lyric layouts on the TV (docs/PLAN.md §9.6): "two lines" and the
// "scrolling" list, on discs in the styles real discs use (test/lyric-discs.js). Every animation
// frame of a few windows of each song is recorded — each line's place, opacity and how much of it
// is sung — and checked against the plan (shared/lyric-layout.js) worked out here from the disc:
//   - readable: the words reach 7:1 against the panel, are at least 4.5 % of the screen high, never
//     overlap each other and stay inside the lyric box (so no overlay covers them);
//   - not jittery: the clock never goes back; a shown two-line line never moves; the scrolling list
//     only moves during its glides, never backwards, at most 1.5× the glide's mean speed, and puts
//     the focus exactly where the plan says on every frame; opacity never jumps; each line's wipe is
//     the disc's own, pixel for pixel, and never goes back;
//   - not confusing: the line being sung is always fully shown, the next one is up by the middle of
//     the current one, lines appear in the order they are sung (and well before the disc shows them
//     at its page turns), a countdown precedes a verse, a long instrumental clears the screen, and a
//     disc whose lines can't be followed keeps its pages.
// Also: the three looks (no filter on anything that moves), a switch while singing, the mirror and
// the host's preview. Screenshots in the output folder.
//
//   node test/e2e/layouts.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { wavBuffer } from '../../scripts/make-demo-library.js';
import { analyzeLines } from '../../shared/lyric-lines.js';
import { twoLinePlan, shown, scrollPlan, focusAt, stopAt, scrollAlpha, MOVE, BREAK, LEAD, FADE_OUT } from '../../shared/lyric-layout.js';
import { pagesDisc, rollingDisc, duetDisc, popOnDisc } from '../lyric-discs.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-layouts');
await fs.mkdir(out, { recursive: true });

const DISCS = {
  pages: { artist: 'The Lanterns', title: 'Harbour Lights', ...pagesDisc() },
  rolling: { artist: 'Rolling Tide', title: 'Line By Line', ...rollingDisc() },
  duet: { artist: 'Two Voices', title: 'High And Low (Duet)', ...duetDisc() },
  popon: { artist: 'Pop On', title: 'Never Wiped', ...popOnDisc() },
};
for (const d of Object.values(DISCS)) d.a = analyzeLines(d.bytes);

/** Writes a track (CD+G + a quiet tone as long as it) into the library folder. */
async function writeTrack(lib, d) {
  const dir = path.join(lib, d.artist[0].toUpperCase(), d.artist);
  await fs.mkdir(dir, { recursive: true });
  const rate = 22050;
  const n = Math.round((d.bytes.length / 7200) * rate);
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.03 * Math.sin((2 * Math.PI * 220 * i) / rate);
  const wav = wavBuffer(tone, tone);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  const name = `${d.artist} - ${d.title} [LT Karaoke]`;
  await fs.writeFile(path.join(dir, `${name}.cdg`), d.bytes);
  await fs.writeFile(path.join(dir, `${name}.wav`), wav);
}

const { chromium } = loadPlaywright();
const { app, base } = await startParty({ addTracks: async (lib) => { for (const d of Object.values(DISCS)) await writeTrack(lib, d); } });
app.settings.update({ playback: { countdown: 1 }, display: { lighterEffects: 'off' } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const setDisplay = (patch) => hostReq('settings.update', { patch: { display: patch } });
const exposeController = (page) => page.route('**/js/tv/main.js', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
});
const pos = (page) => page.evaluate(() => window.__tvController.position());
const layoutOf = (page) => page.evaluate(() => document.getElementById('lyrics').dataset.layout);
const seekTo = async (page, t) => {
  await hostReq('player.seek', { pos: t });
  await until(async () => Math.abs((await pos(page)) - t) < 0.3, 5000);
};
/** Plays `d` on the TV until its lyrics show in `layout`. */
async function play(page, d, layout) {
  const s = app.library.catalog.search(d.title.replace(/ \(Duet\)$/, '')).items[0];
  await hostReq('queue.add', { songId: s.id, singerName: 'Robin' });
  const title = d.title.replace(/ \(Duet\)$/, '');
  if (!room.s.current) await hostReq('player.play');
  for (let i = 0; i < 6 && !room.s.current?.title.startsWith(title); i++) await hostReq('player.next'); // (adding to an idle party starts it)
  const ok = await until(async () => room.s.current?.title.startsWith(title) && room.s.player.state === 'playing'
    && (await page.evaluate(() => window.__tvController.lyrics.loaded && document.getElementById('lyrics').classList.contains('show')))
    && (await layoutOf(page)) === layout, 30000);
  if (!ok) console.log('  (now:', room.s.current?.title, room.s.player.state, await layoutOf(page), ')');
  return ok;
}

/**
 * Every animation frame for `ms`: the lyrics' time and, per line shown, its index, place (device
 * pixels of its ink's top-left in the box), opacity and sung pixels; the geometry of the layout.
 */
const record = (page, ms) => page.evaluate((ms) => new Promise((done) => {
  const r = window.__tvController.lyrics;
  const v = r.lineView;
  const frames = [];
  const t0 = performance.now();
  const tick = (ts) => {
    const g = v.geo;
    const items = [];
    for (const [j, it] of v.items) {
      const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(it.el.style.transform);
      items.push({ j, x: m ? Math.round(+m[1] * g.box.dpr + 2 * g.k) : NaN, y: m ? Math.round(+m[2] * g.box.dpr + 2 * g.k) : NaN, a: +it.el.style.opacity, n: it.drawn });
    }
    frames.push({ ts, t: r.lastT, layout: r.lyrics.dataset.layout, items, dots: v.dotsKey });
    if (performance.now() - t0 < ms) requestAnimationFrame(tick);
    else done({ frames, k: g.k, box: g.box, slots: g.slots, hMax: g.hMax, gap: g.gap, y: g.y, centre: g.centre });
  };
  requestAnimationFrame(tick);
}), ms);

/** The number of a line's pixels sung at song time t (the disc's own wipe). */
const sungAt = (l, t) => {
  const p = Math.floor(t * 300);
  let n = 0;
  for (let i = 0; i < l.at.length; i++) if (l.at[i] > 0 && l.at[i] <= p) n++;
  return n;
};

/** Checks common to both layouts on recorded frames → a list of problems. */
function commonProblems(rec, d) {
  const bad = [];
  const lines = d.a.lines;
  let prevT = -1;
  const prevA = new Map();
  for (const f of rec.frames) {
    if (f.t < prevT - 1e-9) bad.push(`the clock went back ${prevT.toFixed(3)} → ${f.t.toFixed(3)}`);
    // opacity changes no faster than the quickest fade (a dropped frame in software drawing is a longer step)
    const most = Math.max(1 / 60, f.t - prevT) / FADE_OUT + 0.05;
    prevT = f.t;
    for (const it of f.items) {
      const want = sungAt(lines[it.j], f.t);
      if (it.n !== want) bad.push(`t ${f.t.toFixed(3)} line ${it.j}: ${it.n} pixels sung, the disc has ${want}`);
      const pa = prevA.get(it.j);
      if (pa !== undefined && Math.abs(it.a - pa) > most) bad.push(`t ${f.t.toFixed(3)} line ${it.j}: opacity jumps ${pa} → ${it.a}`);
      prevA.set(it.j, it.a);
      if (it.x < 0 || it.x + lines[it.j].w * rec.k > rec.box.w + 1) bad.push(`line ${it.j} outside the box sideways`);
    }
    for (const j of prevA.keys()) if (!f.items.some((it) => it.j === j) && prevA.get(j) > most) bad.push(`t ${f.t.toFixed(3)} line ${j} vanished at opacity ${prevA.get(j)}`);
    for (const j of [...prevA.keys()]) if (!f.items.some((it) => it.j === j)) prevA.delete(j);
    // the line being sung is up, fully
    lines.forEach((l, j) => {
      if (f.t < l.start + 0.05 || f.t > l.end - 0.05) return;
      const it = f.items.find((x) => x.j === j);
      const full = rec.slots || f.t > l.start + MOVE + 0.05;
      if (!it || it.a < (full ? 0.97 : 0.55)) bad.push(`t ${f.t.toFixed(3)}: line ${j}, being sung, shown at ${it ? it.a : 'nothing'}`);
    });
    // no two lines overlap
    const vis = f.items.filter((it) => it.a > 0.05);
    for (let i = 0; i < vis.length; i++) {
      for (let k = i + 1; k < vis.length; k++) {
        const [p, q] = [vis[i], vis[k]];
        const [lp, lq] = [lines[p.j], lines[q.j]];
        if (p.y < q.y + lq.h * rec.k - 1 && q.y < p.y + lp.h * rec.k - 1 && p.x < q.x + lq.w * rec.k && q.x < p.x + lp.w * rec.k) bad.push(`t ${f.t.toFixed(3)}: lines ${p.j} and ${q.j} overlap`);
      }
    }
  }
  return bad;
}

function twoLineProblems(rec, d) {
  const bad = commonProblems(rec, d);
  const lines = d.a.lines;
  const plan = twoLinePlan(lines);
  const place = new Map();
  for (const f of rec.frames) {
    const vis = f.items.filter((it) => it.a > 0);
    if (vis.length > 2) bad.push(`t ${f.t.toFixed(3)}: ${vis.length} lines up`);
    for (const it of f.items) {
      const was = place.get(it.j);
      if (was && (was[0] !== it.x || was[1] !== it.y)) bad.push(`t ${f.t.toFixed(3)} line ${it.j} moved [${was}] → [${it.x},${it.y}]`);
      place.set(it.j, [it.x, it.y]);
      const want = shown(plan[it.j], f.t);
      if (Math.abs(it.a - want) > 0.06) bad.push(`t ${f.t.toFixed(3)} line ${it.j}: opacity ${it.a}, the plan ${want.toFixed(2)}`);
      if (Math.abs(it.y - rec.slots[plan[it.j].slot] - Math.round(((rec.hMax - lines[it.j].h) * rec.k) / 2)) > 1) bad.push(`line ${it.j} not in its place`);
    }
    plan.forEach((p, j) => {
      if (shown(p, f.t) > 0.1 && !f.items.some((it) => it.j === j)) bad.push(`t ${f.t.toFixed(3)}: line ${j} should be up`);
    });
    // the next line is up by the middle of the line being sung
    lines.forEach((l, j) => {
      if (j + 1 >= lines.length || lines[j + 1].start - l.end > BREAK) return;
      if (f.t < (l.start + l.end) / 2 || f.t > l.end) return;
      if (!f.items.some((it) => it.j === j + 1 && it.a > 0.5)) bad.push(`t ${f.t.toFixed(3)}: line ${j} is sung and line ${j + 1} is not up yet`);
    });
  }
  return bad;
}

function scrollProblems(rec, d) {
  const bad = commonProblems(rec, d);
  const lines = d.a.lines;
  const plan = scrollPlan(lines);
  let maxStop = 1;
  for (let s = 1; s < plan.to.length; s++) maxStop = Math.max(maxStop, plan.to[s] - plan.to[s - 1]);
  const pitch = (rec.hMax + rec.gap) * rec.k;
  let prev = null;
  for (const f of rec.frames) {
    // the column: every line at its place in it, the focus where the plan says
    const fo = focusAt(plan, f.t);
    const j0 = Math.floor(fo);
    const j1 = Math.min(lines.length - 1, j0 + 1);
    const c = rec.centre[j0] + (rec.centre[j1] - rec.centre[j0]) * (fo - j0);
    const off = Math.round(rec.box.h * 0.4 - c);
    const s = stopAt(plan, f.t);
    for (const it of f.items) {
      if (it.y !== rec.y[it.j] + off) bad.push(`t ${f.t.toFixed(3)} line ${it.j} at ${it.y}, the plan ${rec.y[it.j] + off}`);
      const mid = it.y + (lines[it.j].h * rec.k) / 2;
      const edge = Math.max(0, Math.min(1, Math.min(mid, rec.box.h - mid) / pitch));
      const want = scrollAlpha(plan.stop[it.j] - s) * edge;
      if (Math.abs(it.a - want) > 0.02) bad.push(`t ${f.t.toFixed(3)} line ${it.j}: opacity ${it.a}, the plan ${want.toFixed(2)}`);
    }
    for (let i = 1; i < f.items.length; i++) if (f.items[i].j > f.items[i - 1].j && f.items[i].y <= f.items[i - 1].y) bad.push('lines out of order');
    if (prev) {
      const dt = f.t - prev.t;
      for (const it of f.items) {
        const was = prev.items.find((x) => x.j === it.j);
        if (!was) continue;
        const dy = it.y - was.y;
        if (dy > 0) bad.push(`t ${f.t.toFixed(3)} line ${it.j} moved back down ${dy} px`);
        if (-dy > (1.5 * maxStop * pitch * Math.max(dt, 1 / 60)) / MOVE + 2) bad.push(`t ${f.t.toFixed(3)} line ${it.j} jumped ${-dy} px in ${(dt * 1000).toFixed(0)} ms`);
        const gliding = plan.at.some((a) => f.t >= a - 0.02 && prev.t <= a + MOVE + 0.02);
        if (dy && !gliding) bad.push(`t ${f.t.toFixed(3)} line ${it.j} moved outside a glide`);
      }
    }
    prev = f;
  }
  return bad;
}

const summary = (bad) => (bad.length ? `: ${[...new Set(bad)].slice(0, 6).join(' | ')}${bad.length > 6 ? ` … (${bad.length})` : ''}` : '');

/** In the page: the line canvases' pixels against the plate, their height, filters, inside the box. */
const lineFacts = (page) => page.evaluate(() => {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const plate = document.querySelector('.lyr-plate');
  const [pr, pg, pb, pa = 1] = getComputedStyle(plate).backgroundColor.match(/[\d.]+/g).map(Number);
  const back = lum([pr, pg, pb].map((v) => v * pa + 128 * (1 - pa)));
  const box = document.getElementById('lyrics').getBoundingClientRect();
  const pl = plate.getBoundingClientRect();
  const v = window.__tvController.lyrics.lineView;
  let min = 99;
  let opaque = 0;
  let px = 0;
  let outside = 0;
  let offPlate = 0;
  const heights = [];
  const filters = new Set([getComputedStyle(document.querySelector('.lyr-lines')).filter]);
  for (const [j, it] of v.items) {
    const c = it.el;
    filters.add(getComputedStyle(c).filter);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      px++;
      if (d[i + 3] === 255) opaque++;
    }
    // the letters: every colour of the line that is a fill (its outline or halo is an edge, darker on purpose)
    const line = v.song.lines[j];
    const sig = v.style.roles?.sig;
    const used = new Set();
    for (let i = 0; i < line.ink.length; i++) if (line.ink[i]) used.add(line.unsung[i]).add(line.sung[i]);
    for (const col of used) {
      if (sig && sig[col] !== 'f') continue;
      const w = it.lut[col];
      if (!(w >>> 24)) continue;
      const l = lum([w & 255, (w >>> 8) & 255, (w >>> 16) & 255]);
      min = Math.min(min, (Math.max(l, back) + 0.05) / (Math.min(l, back) + 0.05));
    }
    const r = c.getBoundingClientRect();
    if (+c.style.opacity > 0.5) {
      heights.push((v.song.lines[j].h * v.geo.k) / v.geo.box.dpr / innerHeight);
      const ink = { top: r.top + (2 * v.geo.k) / v.geo.box.dpr, bottom: r.bottom - (2 * v.geo.k) / v.geo.box.dpr };
      if (r.left < box.left - 1 || r.right > box.right + 1) outside++;
      if (v.mode === 'lines' && (ink.top < pl.top || ink.bottom > pl.bottom)) offPlate++;
      if (v.mode === 'lines' && (ink.top < box.top || ink.bottom > box.bottom)) outside++;
    }
  }
  return { min, px, opaque, heights, outside, offPlate, filters: [...filters], lines: v.items.size };
});

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1920, height: 1080 } }), 'tv');
  await exposeController(tv);
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const mirror = watch(await browser.newPage({ viewport: { width: 720, height: 1280 } }), 'mirror');
  await mirror.goto(`${base}/tv?display=mirror`);
  await mirror.waitForSelector('.lobby');
  const P = DISCS.pages;
  check(P.a.ok && P.a.lines.length === 8 && DISCS.rolling.a.lines.length === 12 && DISCS.duet.a.lines.length === 5 && !DISCS.popon.a.ok, 'the test discs: 8, 12 and 5 sung lines found; the pop-on disc has none to follow');

  // ---- 1. two lines, on the pages disc --------------------------------------------------------
  await setDisplay({ lyricsLayout: 'lines', lyricsLook: 'panel' });
  check(await play(tv, P, 'lines'), 'two lines: the pages disc plays in the two-line layout');
  const L = P.a.lines;
  const windows = [[L[0].start - 3.4, 7], [L[3].start - 1, 6], [L[4].start - LEAD - 1, 7]];
  let twoBad = [];
  let frames = 0;
  let span = 0;
  for (const [from, ms] of windows.map(([t, s]) => [t, s * 1000])) {
    await seekTo(tv, from);
    const rec = await record(tv, ms);
    frames += rec.frames.length;
    span += rec.frames.at(-1).t - rec.frames[0].t;
    twoBad = twoBad.concat(twoLineProblems(rec, P));
    if (from === windows[0][0]) {
      check(rec.frames.some((f) => f.dots && f.t < L[0].start), 'two lines: a countdown before the first line');
    }
  }
  check(!twoBad.length && frames > 200, `two lines, ${frames} frames over ${span.toFixed(1)} s of song: lines never move once up, never more than two, opacity as planned, each wipe the disc's own, the line sung always up, the next one up by its middle${summary(twoBad)}`);
  // in the middle of the instrumental: nothing
  await seekTo(tv, (L[3].end + L[4].start) / 2);
  await sleep(400);
  const quiet = await tv.evaluate(() => [...window.__tvController.lyrics.lineView.items.values()].filter((it) => +it.el.style.opacity > 0).length);
  check(quiet === 0, `two lines: a 12 s instrumental clears the screen (${quiet} lines up)`);
  // readable: contrast, size, inside the box and the plate
  await seekTo(tv, L[1].start + 0.8);
  await hostReq('player.pause');
  await sleep(300);
  let facts = await lineFacts(tv);
  check(facts.min >= 7 && facts.px > 1000, `two lines: the letters (every fill colour) at 7:1 or more against the panel (worst ${facts.min.toFixed(2)})`);
  check(facts.heights.length === 2 && Math.min(...facts.heights) >= 0.045, `two lines: the words are ${facts.heights.map((h) => (h * 100).toFixed(1)).join(' and ')} % of the screen high (≥ 4.5 %)`);
  check(!facts.outside && !facts.offPlate, `two lines: inside the lyric box and on the panel (${facts.outside} outside, ${facts.offPlate} off the panel)`);
  check(facts.filters.every((f) => f === 'none'), `two lines: no filter on the lines (${facts.filters})`);
  await shot(tv, 'lines-panel');
  // the lead: the disc shows a page's lines at the last moment; here a line is up while the one before is sung
  const plan = twoLinePlan(L);
  const discLead = Math.min(...L.map((l) => l.start - l.appear));
  const ourLead = Math.min(...L.map((l, j) => l.start - plan[j].in));
  check(ourLead >= 1.5, `two lines: every line up ${ourLead.toFixed(1)} s or more before it is sung (the disc: ${discLead.toFixed(1)} s at its page turns)`);
  // the looks
  for (const look of ['clear', 'disc']) {
    await setDisplay({ lyricsLook: look });
    await until(async () => (await tv.evaluate(() => document.getElementById('lyrics').dataset.look)) === look, 3000);
    await sleep(300);
    facts = await lineFacts(tv);
    if (look === 'disc') check(facts.opaque === facts.px && facts.px > 1000, 'two lines, as the disc made them: the lines opaque, in the disc’s colours');
    else check(facts.px > facts.opaque && facts.filters.every((f) => f === 'none'), `two lines, with an outline: drawn with the outline baked in, no filter (${facts.px} px)`);
    await shot(tv, `lines-${look}`);
  }
  await setDisplay({ lyricsLook: 'panel' });
  await hostReq('player.resume');

  // ---- 2. switch to scrolling while singing ---------------------------------------------------
  await setDisplay({ lyricsLayout: 'scroll' });
  check(await until(async () => (await layoutOf(tv)) === 'scroll' && (await layoutOf(mirror)) === 'scroll', 3000), 'switched to scrolling while singing: the TV and the mirror follow');
  let scrollBad = [];
  frames = 0;
  span = 0;
  for (const [from, ms] of [[L[0].start - 3, 9000], [L[3].start - 1, 5000], [L[4].start - 4, 6000]]) {
    await seekTo(tv, from);
    const rec = await record(tv, ms);
    frames += rec.frames.length;
    span += rec.frames.at(-1).t - rec.frames[0].t;
    scrollBad = scrollBad.concat(scrollProblems(rec, P));
  }
  check(!scrollBad.length && frames > 200, `scrolling, ${frames} frames over ${span.toFixed(1)} s of song: every line exactly where the plan puts it, moving only in glides, never back, never faster than 1.5× a glide's mean speed, in order, no overlaps, the line sung in focus, each wipe the disc's own${summary(scrollBad)}`);
  // smooth on a PC that draws in software (headless Chromium does): frames a second and script per
  // frame while the list glides and a line is sung, with lighter effects (Automatic turns them on here)
  await setDisplay({ lighterEffects: 'auto' });
  await sleep(500);
  for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
    await tv.setViewportSize({ width: w, height: h });
    await seekTo(tv, L[1].end - 1.2);
    const perf = await tv.evaluate((ms) => new Promise((done) => {
      const v = window.__tvController.lyrics.lineView;
      const render = v.render;
      const cost = [];
      v.render = function (t) {
        const t0 = performance.now();
        render.call(this, t);
        cost.push(performance.now() - t0);
      };
      const gaps = [];
      let last = 0;
      const t0 = performance.now();
      const tick = (ts) => {
        if (last) gaps.push(ts - last);
        last = ts;
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else {
          v.render = render;
          const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
          done({ fps: 1000 / q(gaps, 0.5), worst: Math.max(...gaps), p95: q(cost, 0.95), max: Math.max(...cost), frames: gaps.length });
        }
      };
      requestAnimationFrame(tick);
    }), 3000);
    console.log(`  ${w}×${h}: ${perf.fps.toFixed(0)} fps (median), longest frame ${perf.worst.toFixed(0)} ms, script ${perf.p95.toFixed(2)} ms at the 95th percentile (max ${perf.max.toFixed(1)})`);
    check(perf.fps >= (w > 2000 ? 30 : 50) && perf.p95 <= 2, `scrolling at ${w}×${h} in software drawing: ${perf.fps.toFixed(0)} frames a second through a glide and a wipe, ${perf.p95.toFixed(2)} ms of script a frame (95th percentile)`);
  }
  await tv.setViewportSize({ width: 1920, height: 1080 });
  await setDisplay({ lighterEffects: 'off' });
  await seekTo(tv, L[2].start + 1);
  await hostReq('player.pause');
  await sleep(300);
  facts = await lineFacts(tv);
  check(facts.min >= 7 && Math.min(...facts.heights) >= 0.045 && !facts.outside, `scrolling: 7:1 or more on the panel (worst ${facts.min.toFixed(2)}), the words ${(Math.min(...facts.heights) * 100).toFixed(1)} % of the screen high, inside the box`);
  await shot(tv, 'scroll-panel');
  await setDisplay({ lyricsLook: 'clear' });
  await sleep(400);
  await shot(tv, 'scroll-clear');
  await setDisplay({ lyricsLook: 'panel' });
  await shot(mirror, 'scroll-mirror');
  await hostReq('player.resume');

  // ---- 3. the rolling disc and the duet ----------------------------------------------------------
  for (const [key, layout] of [['rolling', 'lines'], ['rolling', 'scroll'], ['duet', 'scroll'], ['duet', 'lines']]) {
    const d = DISCS[key];
    await setDisplay({ lyricsLayout: layout });
    check(await play(tv, d, layout), `${key}: plays in the ${layout === 'lines' ? 'two-line' : 'scrolling'} layout`);
    await seekTo(tv, Math.max(0, d.a.lines[0].start - 1));
    const rec = await record(tv, 7000);
    const bad = layout === 'lines' ? twoLineProblems(rec, d) : scrollProblems(rec, d);
    check(!bad.length, `${key}, ${layout}: ${rec.frames.length} frames as planned${summary(bad)}`);
    if (key === 'duet' && layout === 'scroll') {
      const both = d.a.lines[3].start + 1;
      await seekTo(tv, both);
      await hostReq('player.pause');
      await sleep(300);
      const a = await tv.evaluate(() => Object.fromEntries([...window.__tvController.lyrics.lineView.items].map(([j, it]) => [j, +it.el.style.opacity])));
      check(a[3] === 1 && a[4] === 1, `duet, scrolling: the two lines sung at once are both in focus (${a[3]}, ${a[4]})`);
      await shot(tv, 'scroll-duet');
      await hostReq('player.resume');
    }
  }

  // ---- 4. a disc whose lines can't be followed keeps its pages --------------------------------
  await setDisplay({ lyricsLayout: 'lines' });
  check(await play(tv, DISCS.popon, 'page'), 'a disc that never re-colours its words: shown as pages in the two-line layout');
  await sleep(1500);
  const page = await tv.evaluate(() => {
    const c = document.getElementById('cdg');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) ink++;
    return { visible: getComputedStyle(c).visibility, ink, wanted: document.getElementById('lyrics').dataset.layoutWanted };
  });
  check(page.visible === 'visible' && page.ink > 500 && page.wanted === 'lines', `…its page is drawn (${page.ink} px)`);

  // ---- 5. the host's preview and the mirror ----------------------------------------------------
  await setDisplay({ lyricsLayout: 'lines' });
  check(await play(tv, P, 'lines'), 'two lines again');
  await seekTo(tv, L[0].start + 0.5);
  await hostReq('player.pause'); // (one moment: two lines up)
  const host = watch(await browser.newPage({ viewport: { width: 1280, height: 800 } }), 'host');
  await host.goto(`${base}/host`);
  await host.click('.admin-panel [role=tab]:has-text("Playback")');
  const frame = await (await host.waitForSelector('.preview-frame iframe')).contentFrame();
  check(await until(async () => (await frame.evaluate(() => document.getElementById('lyrics')?.dataset.layout)) === 'lines', 15000), 'the host’s preview shows two lines');
  const preview = () => frame.evaluate(() => {
    const box = document.getElementById('lyrics').getBoundingClientRect();
    const all = [...document.querySelectorAll('.lyr-line')];
    const lines = all.filter((c) => +c.style.opacity > 0.5).map((c) => c.getBoundingClientRect());
    return { n: lines.length, all: all.map((c) => c.style.opacity).join(','), inside: lines.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1), w: innerWidth };
  });
  let pv = await preview();
  for (let i = 0; i < 50 && pv.n !== 2; i++) {
    await sleep(100);
    pv = await preview();
  }
  if (pv.n !== 2) console.log('  preview:', JSON.stringify(pv), room.s.player.state, room.s.player.pos);
  check(pv.n === 2 && pv.inside, `…two lines inside its small box (${pv.w} px wide; ${pv.n} up, inside: ${pv.inside})`);
  await hostReq('player.resume');
  await host.close();
  check(await until(async () => (await layoutOf(mirror)) === 'lines'), 'the mirror shows two lines');
  await shot(mirror, 'lines-mirror');
  await hostReq('player.stop');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
