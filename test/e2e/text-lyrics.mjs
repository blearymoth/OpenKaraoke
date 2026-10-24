#!/usr/bin/env node
// End-to-end checks of the TV's lyrics as real text (PLAN §9.7) on a song autokaraoke made (the
// stand-in's files): two lines and the scrolling list draw its timing.json's words, every frame
// recorded and checked (a line never moves once up in two lines, never more than two, each wipe
// only goes forward and follows the words' times, the line being sung is up), big enough to read
// across a room; the mirror draws them too; a saved edit changes the words on the TV without
// reloading the song; the setting off (or pages) gives the disc's own lyrics; no console errors.
//
//   node test/e2e/text-lyrics.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fakeTiming, cdgFromTiming } from '../../server/maker/fake.js';
import { readTiming } from '../../shared/timing.js';
import { textLines } from '../../shared/lyric-text.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-text-lyrics');
await fs.mkdir(out, { recursive: true });

const LYRICS = 'Driving through the night\nNeon on the road\nRadio is on and loud\nWe never go home';
const base = 'Pixel Band - Night Drive';
const timing = fakeTiming(LYRICS, { title: 'Night Drive', artist: 'Pixel Band', duration: 30 });
const LINES = textLines(timing);
async function addTracks(lib) {
  const find = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = await find(p); if (r) return r; } else if (/Tempo Tantrum.*\.mp3$/.test(e.name)) return p;
    }
    return null;
  };
  const folder = path.join(lib, 'Made');
  await fs.mkdir(folder, { recursive: true });
  await fs.copyFile(await find(lib), path.join(folder, `${base}.mp3`));
  await fs.writeFile(path.join(folder, `${base}.timing.json`), JSON.stringify(timing));
  await fs.writeFile(path.join(folder, `${base}.cdg`), cdgFromTiming(readTiming(timing), 30));
}

const { chromium } = loadPlaywright();
const { app, base: url } = await startParty({ addTracks }); // (no autokaraoke: an edit is saved, not drawn)
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const setDisplay = (patch) => hostReq('settings.update', { patch: { display: patch } });
const song = app.library.catalog.search('night drive').items[0];
const trackId = song.trackIds[0];
const exposeController = (page) => page.route('**/js/tv/main.js', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
});
const pos = (page) => page.evaluate(() => window.__tvController.position());
const box = (page) => page.evaluate(() => {
  const l = document.getElementById('lyrics');
  return { layout: l.dataset.layout, source: l.dataset.source, labels: [...l.querySelectorAll('.lyr-text-line')].map((c) => c.getAttribute('aria-label')) };
});
const seekTo = async (page, t) => {
  await hostReq('player.seek', { pos: t });
  await until(async () => Math.abs((await pos(page)) - t) < 0.3, 5000);
};
/** Every animation frame for `ms`: the song time and each text line (its words, place, opacity, wipe). */
const record = (page, ms) => page.evaluate((ms) => new Promise((resolve) => {
  const frames = [];
  const t0 = performance.now();
  const step = () => {
    const c = window.__tvController;
    frames.push({
      t: c.lyrics.lastT,
      dots: document.querySelector('.lyr-text .lyr-count.on') ? 1 : 0,
      items: [...document.querySelectorAll('.lyr-text-line')].map((el) => ({
        label: el.getAttribute('aria-label'), tf: el.style.transform, alpha: Number(el.style.opacity), sung: Number(el.dataset.sung || 0), w: el.width,
        css: el.getBoundingClientRect().height,
      })),
    });
    if (performance.now() - t0 < ms) requestAnimationFrame(step);
    else resolve(frames);
  };
  requestAnimationFrame(step);
}), ms);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1920, height: 1080 } }), 'tv');
  await exposeController(tv);
  const audio = [];
  tv.on('request', (r) => { if (/\/media\/[^/]+\/audio/.test(r.url())) audio.push(r.url()); });
  await tv.goto(`${url}/tv`);
  await tv.waitForSelector('.lobby');
  const mirror = watch(await browser.newPage({ viewport: { width: 720, height: 1280 } }), 'mirror');
  await exposeController(mirror);
  await mirror.goto(`${url}/tv?display=mirror`);
  await mirror.waitForSelector('.lobby');

  // ---- two lines --------------------------------------------------------------------------------------------
  await setDisplay({ lyricsLayout: 'lines', lyricsLook: 'panel' });
  await hostReq('settings.update', { patch: { playback: { countdown: 1 } } });
  await hostReq('queue.add', { songId: song.id, singerName: 'Robin' });
  check(await until(() => room.s.player.state === 'playing' && room.s.current?.trackId === trackId, 20000), 'the made song plays');
  check(await until(async () => (await box(tv)).source === 'text' && (await box(tv)).layout === 'lines'), `two lines: the TV draws the song’s words as text (${JSON.stringify(await box(tv))})`);
  await seekTo(tv, LINES[0].start - 2);
  const rec = await record(tv, 5000);
  await seekTo(tv, LINES[1].start - 0.5);
  const rec2 = await record(tv, 5000);
  const frames = [...rec, ...rec2];
  const bad = [];
  let wiped = 0;
  for (const r of [rec, rec2]) { // (each recording on its own: a seek is between them)
    const placed = new Map();
    const lastSung = new Map();
    for (const f of r) {
      if (f.items.length > 2) bad.push(`${f.items.length} lines at ${f.t.toFixed(2)}`);
      const sung = LINES.find((l) => f.t >= l.start + 0.05 && f.t < l.end - 0.05);
      if (sung && !f.items.some((i) => i.label === sung.text && i.alpha === 1)) bad.push(`“${sung.text}” not up at ${f.t.toFixed(2)}`);
      for (const i of f.items) {
        if (placed.has(i.label) && placed.get(i.label) !== i.tf) bad.push(`“${i.label}” moved at ${f.t.toFixed(2)}`);
        placed.set(i.label, i.tf);
        if ((lastSung.get(i.label) ?? 0) > i.sung) bad.push(`“${i.label}” wiped back at ${f.t.toFixed(2)}`);
        lastSung.set(i.label, i.sung);
        const l = LINES.find((x) => x.text === i.label);
        if (l && f.t < l.start - 0.05 && i.sung > 0) bad.push(`“${i.label}” wiped before it is sung`);
        if (l && f.t > l.end + 0.05 && i.sung < i.w * 0.8) bad.push(`“${i.label}” not wiped after it is sung`);
        if (i.sung > 0 && i.sung < i.w * 0.9) wiped++;
      }
    }
  }
  check(!bad.length && frames.length > 200 && wiped > 30, `two lines, ${frames.length} frames: never more than two, never moving, the wipe forward and on time, the line sung up (${wiped} frames mid-wipe)${bad.length ? `\n  ${[...new Set(bad)].slice(0, 6).join('\n  ')}` : ''}`);
  check(rec.some((f) => f.dots && f.t < LINES[0].start), 'a countdown before the first line');
  const tall = Math.min(...frames.flatMap((f) => f.items.map((i) => i.css / 1.3)));
  check(tall / 1080 >= 0.045, `big enough to read across a room (the font ${(100 * tall / 1080).toFixed(1)} % of the screen high)`);
  await seekTo(tv, LINES[0].start + 0.6);
  await sleep(300);
  await shot(tv, 'text-two-lines');
  check(await until(async () => (await box(mirror)).source === 'text' && (await box(mirror)).labels.length > 0), 'the mirror draws the words too');

  // ---- a saved edit: the words change, the song is not reloaded -----------------------------------------------
  const loads = audio.length;
  const edit = structuredClone(timing);
  edit.lines[0].words[0].text = 'Cruising';
  const saved = await room.lyrics.save(trackId, edit);
  check(saved.drawnNow === false, 'an edit saved (autokaraoke not here: not drawn)');
  await seekTo(tv, LINES[0].start + 0.3);
  check(await until(async () => (await box(tv)).labels.includes('Cruising through the night')), `the TV shows the edited words (${(await box(tv)).labels.join(' | ')})`);
  check(audio.length === loads && room.s.player.state === 'playing', 'without reloading the song');
  await room.lyrics.revert(trackId);
  check(await until(async () => (await box(tv)).labels.includes('Driving through the night')), 'reverted: the song’s own words again');

  // ---- scrolling ------------------------------------------------------------------------------------------------
  await setDisplay({ lyricsLayout: 'scroll', lyricsLook: 'clear' });
  check(await until(async () => (await box(tv)).layout === 'scroll' && (await box(tv)).source === 'text'), 'scrolling: the words as text');
  await seekTo(tv, LINES[1].start + 0.4);
  const srec = await record(tv, 2500);
  const sBad = [];
  for (const f of srec) {
    const sung = LINES.find((l) => f.t >= l.start + 0.5 && f.t < l.end - 0.1);
    const focus = sung && f.items.find((i) => i.label === sung.text);
    if (sung && (!focus || focus.alpha < 0.99)) sBad.push(`“${sung.text}” not in focus at ${f.t.toFixed(2)}`);
  }
  check(!sBad.length && srec.some((f) => f.items.length >= 3), `the line being sung in focus, the others around it${sBad.length ? `: ${sBad.slice(0, 3).join('; ')}` : ''}`);
  await shot(tv, 'text-scroll-clear');

  // ---- off, and pages: the disc's own lyrics --------------------------------------------------------------------
  await setDisplay({ lyricsText: false });
  check(await until(async () => (await box(tv)).source === 'disc' && (await box(tv)).labels.length === 0), 'Real words off: the disc’s own lyrics');
  await setDisplay({ lyricsText: true, lyricsLayout: 'page' });
  check(await until(async () => (await box(tv)).layout === 'page' && (await box(tv)).labels.length === 0), 'pages: the disc, as before');
  await shot(tv, 'text-off-pages');
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
