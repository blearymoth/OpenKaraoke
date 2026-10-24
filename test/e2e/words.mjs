#!/usr/bin/env node
// End-to-end checks of a disc's words (PLAN §31.16) on the demo library's multiplex disc, with the
// stand-in autokaraoke and separator: Song details → "Find the words" → the dialog (pasted lyrics)
// → the version's row follows the job → "Edit lyrics"; Settings → Karaoke maker lists it; the TV
// writes those words in two lines (in the disc's own colours; its CDG unchanged); the editor saves
// an edit (never drawn) that the TV shows, has no write-back, and Remove the words gives the TV the
// disc's lyrics again; a phone's width; no console errors.
//
//   node test/e2e/words.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fakeAutokaraoke } from '../../server/maker/fake.js';
import { fakeStemRun } from '../../server/stems/fake.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-words');
await fs.mkdir(out, { recursive: true });

const LYRICS = 'Quiet storm is rolling in\nHold me through the night\nThunder on the radio\nEverything is right';
const { chromium } = loadPlaywright();
const tool = fakeAutokaraoke({ seconds: 0.4 });
const { app, base } = await startParty({ makerTool: tool, stemRun: (args) => fakeStemRun({ ...args, seconds: 0.2 }) });
app.settings.update({ maker: { duringSongs: true } }); // (the stand-in has no graphics card)
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
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const song = app.library.catalog.search('quiet storm').items[0];
const trackId = song.trackIds[0];
const tvBox = (page) => page.evaluate(() => {
  const l = document.getElementById('lyrics');
  return { layout: l.dataset.layout, source: l.dataset.source, labels: [...l.querySelectorAll('.lyr-text-line')].map((c) => c.getAttribute('aria-label')) };
});

try {
  await until(() => room.maker.checks);
  check(room.stemOk(trackId), 'the demo’s multiplex disc');
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  const cdgs = [];
  tv.on('request', (r) => { if (/\/media\/[^/]+\/cdg/.test(r.url())) cdgs.push(r.url()); });
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');

  // ---- Song details → Find the words ------------------------------------------------------------------
  await host.evaluate((id) => import('/js/host/state.js').then((m) => m.openDialog({ type: 'song', songId: id })), song.id);
  const row = `.versions tr[data-track="${trackId}"]`;
  check(await seen(host, `${row} button:has-text("Find the words")`), 'Song details: “Find the words” on the multiplex version');
  await host.click(`${row} button:has-text("Find the words")`);
  check(await seen(host, '.words-dialog textarea'), 'the dialog: paste the lyrics');
  await host.fill('.words-dialog textarea', LYRICS);
  check(await seen(host, '.dialog :text("4 lines")'), 'it counts the lines');
  await shot(host, 'words-dialog');
  await host.click('.dialog-foot button.primary:has-text("Find the words")');
  check(await seen(host, `${row} .words-state`), 'back on Song details: the row follows the job');
  check(await seen(host, `${row} button:has-text("Edit lyrics")`, 20000), 'done: “Edit lyrics” on the version');
  const run = tool.state.runs.find((r) => r.kind === 'words');
  check(run?.opts.vocals === room.stems.file(trackId, 'vocal.wav'), 'timed against the disc’s own singer, separated first');
  await shot(host, 'words-song-details');
  await host.click('.dialog .close').catch(() => host.keyboard.press('Escape'));

  // ---- Settings → Karaoke maker lists it --------------------------------------------------------------
  await host.evaluate(() => { location.hash = '#/settings/maker'; });
  check(await seen(host, `.words-job.done[data-words="${trackId}"]:has-text("4 lines, from the lyrics you pasted")`), 'Settings → Karaoke maker: “Words for discs”, ready');

  // ---- the TV writes them, in the disc's colours; its CDG is the disc's own ------------------------
  await hostReq('settings.update', { patch: { display: { lyricsLayout: 'lines' }, playback: { countdown: 1 } } });
  await hostReq('queue.add', { songId: song.id, singerName: 'Robin' });
  check(await until(() => room.s.player.state === 'playing' && room.s.current?.trackId === trackId, 20000), 'the disc plays');
  check(await until(async () => (await tvBox(tv)).source === 'text' && (await tvBox(tv)).layout === 'lines', 15000), `two lines: the TV writes the words found (${JSON.stringify(await tvBox(tv))})`);
  await hostReq('player.seek', { pos: 3.2 });
  check(await until(async () => (await tvBox(tv)).labels.includes('Quiet storm is rolling in')), 'the first line, as pasted');
  check(cdgs.every((u) => !/edit=/.test(u)), 'the disc’s own CDG');
  await sleep(400);
  await shot(tv, 'words-tv');

  // ---- the editor: an edit, never drawn, shown on the TV; no write-back; remove --------------------------
  await host.evaluate((id) => { location.hash = `#/lyrics/${id}`; }, trackId);
  check(await seen(host, '.le-state:has-text("The words found for this disc")'), 'the editor: “The words found for this disc”');
  check(await host.$('.le-actions button:has-text("Write into the song’s folder")') === null, 'no write-back into the library');
  await host.click('button:has-text("Edit the words")');
  const text = await host.inputValue('.le-text textarea');
  await host.fill('.le-text textarea', text.replace('Thunder', 'Lightning'));
  await host.click('button:has-text("Use these words")');
  await host.click('.le-actions button:has-text("Save")');
  check(await seen(host, '.le-state:has-text("Your edit — the TV writes it")'), 'saved: “Your edit — the TV writes it”');
  check(tool.state.runs.every((r) => r.kind !== 'render') && room.lyrics.cdgFor(trackId) === null, 'nothing drawn: the disc keeps its CDG');
  await hostReq('player.seek', { pos: 9 });
  check(await until(async () => (await tvBox(tv)).labels.includes('Lightning on the radio'), 10000), `the TV writes the edit (${(await tvBox(tv)).labels.join(' | ')})`);
  await shot(host, 'words-editor');
  await host.click('.le-actions button:has-text("Remove the words")');
  check(await until(async () => (await tvBox(tv)).source === 'disc'), 'Remove the words: the TV shows the disc’s own lyrics again');
  check(await room.lyrics.editable(room.catalog.track(trackId)) === '', 'and they are gone');
  await hostReq('player.stop');

  // ---- a phone -------------------------------------------------------------------------------------------
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'phone');
  await phone.goto(`${base}/host`);
  await phone.waitForSelector('.player, .mini-player, .app');
  await phone.evaluate(([t, s]) => import('/js/host/state.js').then((m) => m.openDialog({ type: 'words', trackId: t, songId: s })), [trackId, song.id]);
  check(await seen(phone, '.words-dialog'), 'the dialog on a phone');
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 390, `no sideways scrolling (${wide} px)`);
  await shot(phone, 'words-phone');
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
