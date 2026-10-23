#!/usr/bin/env node
// End-to-end checks of Settings → Karaoke maker (PLAN §31) with the stand-in autokaraoke: the
// checks of this computer; a song uploaded from the browser, its lyrics pasted, made step by step,
// then queued and played on the TV; a song file chosen on this computer; a link, cancelled; a
// failure with autokaraoke's reason; installing it from the page; a phone's width; no console errors.
//
//   node test/e2e/maker.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fakeAutokaraoke } from '../../server/maker/fake.js';
import { tmpDir } from '../helpers.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-maker');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const tool = fakeAutokaraoke({ seconds: 3, songSeconds: 30 });
const { app, base } = await startParty({ makerTool: tool });
const made = path.join(app.library.paths[0], 'OpenKaraoke Maker');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const seen = (page, selector, timeout = 8000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const room = app.room;
const jobs = () => room.maker.jobs;

// A song to upload: one of the demo library's MP3s under another name.
const demoMp3 = [...app.library.catalog.tracks.values()].find((t) => t.kind === 'cdg' && /Tempo Tantrum/.test(t.name));
const upload = path.join(await tmpDir('ok-up-'), 'Pixel Band - Night Drive.mp3');
await fs.copyFile(app.library.absPath(demoMp3, 'audio'), upload);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.route('**/js/tv/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
  });
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/settings/maker`);
  check(await seen(host, '.maker .mk-form'), 'Settings → Karaoke maker: the form (autokaraoke is installed)');
  check(await seen(host, '.mk-checks li.ok:has-text("Python")') && await seen(host, '.mk-checks li:has-text("Lyric timer · medium")'), 'this computer’s checks and the models');
  check(await seen(host, '.mk-checks li:has-text("No NVIDIA graphics card")'), 'no graphics card: it says the processor does the work');

  // ---- upload, lyrics, make, then queue and play it -----------------------------------------------
  await host.click('.mk-form .segmented button:has-text("Upload")');
  await host.setInputFiles('.mk-form input[type=file][accept*=".mp3"]', upload);
  check(await seen(host, '.mk-chosen:has-text("Pixel Band - Night Drive.mp3")'), 'the upload is in');
  const artist = await host.inputValue('.mk-form .row-2 >> nth=0 >> input >> nth=0');
  const title = await host.inputValue('.mk-form .row-2 >> nth=0 >> input >> nth=1');
  check(artist === 'Pixel Band' && title === 'Night Drive', `artist and title from the file name (${artist} / ${title})`);
  await host.fill('.mk-lyrics textarea', '[Verse]\nDriving through the night\nNeon on the road\nRadio is on');
  check(await seen(host, '.mk-row .hint:has-text("4 lines")'), 'it counts the lyrics lines');
  await host.click('button:has-text("Make karaoke")');
  check(await seen(host, '.mk-job.running .mk-steps li.now:has-text("Remove the singer")'), 'the job: step 2, removing the singer');
  check(await seen(host, '.mk-job .mk-bar'), 'with a progress bar');
  await shot(host, 'maker-running');
  check(await seen(host, '.mk-job.done:has-text("Night Drive") button:has-text("Queue it")', 20000), 'done: it is in the library, “Queue it”');
  const job = jobs().find((j) => j.title === 'Night Drive');
  const lyricsSent = tool.state.runs.find((r) => r.kind === 'make');
  check(!!lyricsSent?.opts.lyricsFile && job.lines.some((l) => /^Aligning \d+ words/.test(l)), 'the lyrics went to autokaraoke');
  check(await fs.stat(path.join(made, 'Pixel Band - Night Drive.cdg')).then(() => true, () => false) && app.library.paths.length === 1, 'saved in the library’s “OpenKaraoke Maker” folder');
  await shot(host, 'maker-done');
  await host.click('.mk-job.done:has-text("Night Drive") button:has-text("Queue it")');
  await host.waitForSelector('.dialog button:has-text("Add to queue")');
  await host.fill('.dialog input >> nth=0', 'Ann').catch(() => {});
  await host.click('.dialog button:has-text("Add to queue")');
  check(await until(() => room.s.current?.title === 'Night Drive' || room.s.queue.some((e) => e.title === 'Night Drive')), 'queued');
  await room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'player.play' }).catch(() => {});
  check(await until(async () => room.s.player.state === 'playing' && room.s.current?.title === 'Night Drive'
    && (await tv.evaluate(() => window.__tvController.engine.playing)), 30000), 'the TV plays the new song');
  await room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'player.stop' });

  // ---- a file on this computer --------------------------------------------------------------------
  await host.click('.mk-form .segmented button:has-text("On this computer")');
  await host.click('.mk-form button:has-text("Choose…")');
  await host.fill('.manual-path input', path.dirname(upload));
  await host.click('.manual-path button');
  check(await seen(host, '.folder.song-file:has-text("Night Drive")'), 'Choose…: the song files in a folder');
  await host.click('.folder.song-file:has-text("Night Drive")');
  check(await seen(host, '.mk-chosen:has-text("Pixel Band - Night Drive.mp3")'), 'picked');

  // ---- a link, cancelled ------------------------------------------------------------------------------
  tool.state.seconds = 12;
  await host.click('.mk-form .segmented button:has-text("Link")');
  await host.fill('input[aria-label="Link to the song"]', 'https://youtu.be/dQw4w9WgXcQ?si=share');
  await host.fill('.mk-form .row-2 >> nth=0 >> input >> nth=0', 'Web Band');
  await host.fill('.mk-form .row-2 >> nth=0 >> input >> nth=1', 'Streamed');
  await host.click('button:has-text("Make karaoke")');
  check(await seen(host, '.mk-job.running:has-text("Streamed") .mk-steps li:has-text("Download")'), 'a link: “Download” comes first');
  await host.click('.mk-job.running:has-text("Streamed") button:has-text("Cancel")');
  check(await seen(host, '.mk-job.cancelled:has-text("Streamed")', 15000), 'cancelled');
  await host.click('.mk-job.cancelled:has-text("Streamed") button:has-text("Remove")');
  check(await until(() => !jobs().some((j) => j.title === 'Streamed')), 'and removed');

  // ---- a failure says autokaraoke's reason ------------------------------------------------------------
  tool.state.seconds = 1;
  tool.state.fail = 'make';
  await host.click('.mk-form .segmented button:has-text("On this computer")');
  await host.click('.mk-form button:has-text("Choose…")');
  await host.fill('.manual-path input', path.dirname(upload));
  await host.click('.manual-path button');
  await host.click('.folder.song-file:has-text("Night Drive")');
  await host.fill('.mk-form .row-2 >> nth=0 >> input >> nth=1', 'Broken Take');
  await host.click('button:has-text("Make karaoke")');
  check(await seen(host, '.mk-job.failed:has-text("Broken Take") .warn-text:has-text("alignment failed")', 15000), 'a failure shows autokaraoke’s reason');
  await host.click('.mk-job.failed .mk-log-box summary');
  check(await seen(host, '.mk-job.failed .mk-log:has-text("Separating vocals")'), 'and its log');
  tool.state.fail = '';

  // ---- a phone (the host on a phone with the PIN): no sideways scrolling -------------------------------
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'phone');
  await phone.goto(`${base}/host#/settings/maker`);
  await phone.waitForSelector('.maker .mk-form');
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 390, `a phone: no sideways scrolling (${wide} px)`);
  await shot(phone, 'maker-phone');
  await phone.close();
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
}

// ---- not installed yet: install it from the page --------------------------------------------------------
const tool2 = fakeAutokaraoke({ installed: false, models: false, seconds: 2 });
const party2 = await startParty({ makerTool: tool2 });
try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host2');
  await host.goto(`${party2.base}/host#/settings/maker`);
  check(await seen(host, '.mk-card:has-text("Install autokaraoke") button:has-text("Install")'), 'not installed: “Install autokaraoke”');
  check(await seen(host, '.mk-checks li:has-text("not installed yet")'), 'it was found in ~/Projects/autokaraoke');
  await host.click('.mk-card:has-text("Install autokaraoke") button:has-text("Install")');
  check(await seen(host, '.mk-task .mk-log:has-text("Installing PyTorch")'), 'the install’s log, as it goes');
  check(await seen(host, '.maker .mk-form', 15000), 'installed: the form is there');
  check(tool2.state.runs.some((r) => r.kind === 'install' && r.opts.gpu === false && r.opts.youtube === true), 'the processor build, with YouTube');
  await shot(host, 'maker-installed');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
  await party2.app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
