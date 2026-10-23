#!/usr/bin/env node
// End-to-end checks of the lyrics editor (PLAN §31.5) on a song autokaraoke made (the stand-in's
// files): opened from Song details; the preview wipes as the song plays and the sung word lights
// up; nudges with the keys and undo; tap along (hold T); the words edited as text keep their
// times; Save while the song is on — the TV loads the new drawing; Revert; write it back into the
// song's folder (originals kept); a phone's width; no console errors.
//
//   node test/e2e/lyrics-editor.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fakeAutokaraoke, fakeTiming, cdgFromTiming } from '../../server/maker/fake.js';
import { readTiming } from '../../shared/timing.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-lyrics-editor');
await fs.mkdir(out, { recursive: true });

const LYRICS = 'Driving through the night\nNeon on the road\nRadio is on and loud\nWe never go home';
const base = 'Pixel Band - Night Drive';
let folder = '';
/** A song autokaraoke made: a demo MP3 with its timing.json and the CDG drawn from it. */
async function addTracks(lib) {
  const find = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = await find(p); if (r) return r; } else if (/Tempo Tantrum.*\.mp3$/.test(e.name)) return p;
    }
    return null;
  };
  folder = path.join(lib, 'Made');
  await fs.mkdir(folder, { recursive: true });
  await fs.copyFile(await find(lib), path.join(folder, `${base}.mp3`));
  const timing = fakeTiming(LYRICS, { title: 'Night Drive', artist: 'Pixel Band', duration: 30 });
  await fs.writeFile(path.join(folder, `${base}.timing.json`), JSON.stringify(timing));
  await fs.writeFile(path.join(folder, `${base}.cdg`), cdgFromTiming(readTiming(timing), 30));
}

const { chromium } = loadPlaywright();
const tool = fakeAutokaraoke({ seconds: 0.2 });
const { app, base: url } = await startParty({ makerTool: tool, addTracks });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
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
const seen = (page, selector, timeout = 8000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const song = app.library.catalog.search('night drive').items[0];
const trackId = song.trackIds[0];

try {
  await until(() => room.maker.where?.installed);
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  const tvCdgs = [];
  tv.on('request', (r) => { if (/\/media\/[^/]+\/cdg/.test(r.url())) tvCdgs.push(r.url()); });
  await tv.goto(`${url}/tv`);
  await tv.waitForSelector('.lobby');
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${url}/host`);
  await host.waitForSelector('.player');

  // ---- from Song details ----------------------------------------------------------------------------
  await host.evaluate((id) => import('/js/host/state.js').then((m) => m.openDialog({ type: 'song', songId: id })), song.id);
  check(await seen(host, '.dialog button:has-text("Edit lyrics")'), 'Song details: “Edit lyrics” on autokaraoke’s version');
  await host.click('.dialog button:has-text("Edit lyrics")');
  check(await seen(host, '.lyrics-editor .le-lines'), 'the editor opens');
  check(await host.evaluate(() => location.hash) === `#/lyrics/${trackId}`, 'at #/lyrics/<track>');
  const lines = await host.$$eval('.le-line', (l) => l.length);
  const words = await host.$$eval('.le-word', (w) => w.map((x) => x.textContent));
  check(lines === 4 && words[0] === 'Driving' && words.length === 17, `4 lines, 17 words (${lines}, ${words.length})`);

  // ---- play: the preview wipes, the sung word lights up -------------------------------------------------
  await host.keyboard.press(' ');
  check(await until(async () => (await host.$eval('.le-pline span', (s) => parseFloat(s.style.getPropertyValue('--p')) || 0)) > 0, 8000), 'playing: the preview wipes the first word');
  check(await seen(host, '.le-word.now'), 'and the word being sung lights up in the list');
  await shot(host, 'editor-playing');
  await host.keyboard.press(' ');
  check(room.s.player.state !== 'playing', 'Space plays the editor, not the party');

  // ---- nudges with the keys, undo -----------------------------------------------------------------------
  await host.click('.le-word >> nth=2');
  const start0 = Number(await host.inputValue('.le-wtime input >> nth=0'));
  await host.keyboard.press(']');
  await host.keyboard.press(']');
  const start1 = Number(await host.inputValue('.le-wtime input >> nth=0'));
  check(Math.abs(start1 - start0 - 0.1) < 0.011, `] ] : the start 0.1 s later (${start0} → ${start1})`);
  check(await seen(host, '.le-state.dirty'), '“Unsaved changes.”');
  await host.keyboard.press('Control+z');
  await host.keyboard.press('Control+z');
  check(Number(await host.inputValue('.le-wtime input >> nth=0')) === start0, 'Ctrl+Z twice: back as it was');

  // ---- tap along -----------------------------------------------------------------------------------------
  await host.click('button:has-text("Tap along")');
  check(await seen(host, '.le-tap'), 'Tap along: the tap panel');
  await host.click('.le-word >> nth=4'); // "Neon"
  await host.$eval('.le-seek', (el) => { el.value = '5.0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await host.keyboard.press(' ');
  await sleep(600);
  const at = await host.evaluate(() => document.querySelector('audio').currentTime);
  await host.keyboard.down('t');
  await sleep(400);
  await host.keyboard.up('t');
  await host.keyboard.press(' ');
  await host.click('.le-word >> nth=4');
  const tapStart = Number(await host.inputValue('.le-wtime input >> nth=0'));
  const tapEndV = Number(await host.inputValue('.le-wtime input >> nth=1'));
  check(Math.abs(tapStart - at) < 0.3 && tapEndV - tapStart > 0.25 && tapEndV - tapStart < 0.8, `hold T: “Neon” starts as the key goes down and ends as it comes up (${at.toFixed(2)} → ${tapStart}–${tapEndV})`);
  await shot(host, 'editor-tap');

  // ---- the words as text: the times stay -----------------------------------------------------------------
  const throughStart = (await room.lyrics.open(trackId)).timing.lines[0].words[1].start;
  await host.click('button:has-text("Edit the words")');
  const text = await host.inputValue('.le-text textarea');
  await host.fill('.le-text textarea', text.replace('Driving', 'Cruising'));
  await host.click('button:has-text("Use these words")');
  check(await seen(host, '.le-word:text-is("Cruising")'), 'the word changed');
  await host.click('.le-word:text-is("through")');
  check(Number(await host.inputValue('.le-wtime input >> nth=0')) === Number(throughStart.toFixed(2)), 'the other words kept their times');

  // ---- save while the song is on: the TV loads the new drawing --------------------------------------------
  await room.request(asHost, { t: 'settings.update', patch: { playback: { countdown: 1 } } });
  await room.request(asHost, { t: 'queue.add', songId: song.id, singerName: 'Ann' });
  check(await until(() => room.s.player.state === 'playing' && room.s.current?.trackId === trackId, 20000), 'the song plays on the TV');
  tvCdgs.length = 0;
  await host.click('.le-actions button:has-text("Save")');
  check(await seen(host, '.le-state:has-text("Your edit — the TV shows it.")'), 'Save: “Your edit — the TV shows it.”');
  check(await until(() => tvCdgs.some((u) => /cdg\?edit=1$/.test(u))), `the TV loads the new drawing (${tvCdgs.join(', ')})`);
  const draft = JSON.parse(await fs.readFile(path.join(app.dataDir, 'lyrics', trackId, 'timing.json'), 'utf8'));
  check(draft.lines[0].words[0].text === 'Cruising', 'the edit is kept in the data folder');
  check(JSON.parse(await fs.readFile(path.join(folder, `${base}.timing.json`), 'utf8')).lines[0].words[0].text === 'Driving', 'the song’s own files are untouched');
  await shot(host, 'editor-saved');

  // ---- write back into the song's folder -------------------------------------------------------------------
  await host.click('.le-actions button:has-text("Write into the song’s folder")');
  check(await until(async () => JSON.parse(await fs.readFile(path.join(folder, `${base}.timing.json`), 'utf8')).lines[0].words[0].text === 'Cruising'), 'written into the song’s folder');
  check(await fs.stat(path.join(folder, `${base}.timing.json.orig`)).then(() => true, () => false), 'the original kept as .orig');
  check(await seen(host, '.le-state:has-text("autokaraoke’s own timing.")'), 'the song’s files are the edit now');

  // ---- revert -----------------------------------------------------------------------------------------------
  await host.click('.le-word:text-is("Cruising")');
  await host.keyboard.press('.');
  await host.click('.le-actions button:has-text("Save")');
  check(await seen(host, '.le-actions button:has-text("Revert")'), 'edited again: Revert');
  await host.click('.le-actions button:has-text("Revert")');
  check(await seen(host, '.le-state:has-text("autokaraoke’s own timing.")'), 'Revert: back to the song’s own timing');
  check(room.lyrics.cdgFor(trackId) === null, 'and the TV gets the song’s CDG');
  await room.request(asHost, { t: 'player.stop' });

  // ---- a phone ----------------------------------------------------------------------------------------------
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'phone');
  await phone.goto(`${url}/host#/lyrics/${trackId}`);
  await phone.waitForSelector('.le-lines');
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 390, `a phone: no sideways scrolling (${wide} px)`);
  await shot(phone, 'editor-phone');
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
