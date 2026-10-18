#!/usr/bin/env node
// End-to-end checks of separated vocals on an ordinary version (PLAN §30): the host separates
// the song on now (a stand-in separator), the TV switches to the stems where it is in the song,
// the Vocals level (off/quiet/full) on the TV, the headphone monitor's own level, the song
// dialog's per-version button, the next song plays its file again; no console errors.
//
//   node test/e2e/stems.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { writePcmWav } from '../../server/stems/wav.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-stems');
await fs.mkdir(out, { recursive: true });

// A stand-in for autokaraoke: the music a 220 Hz tone, the vocal 880 Hz, as long as the demo songs.
let separations = 0;
const stemRun = async ({ music, vocal }) => {
  separations++;
  await sleep(800);
  await writePcmWav(music, { hz: 220, seconds: 30 });
  await writePcmWav(vocal, { hz: 880, seconds: 30 });
};
const { chromium } = loadPlaywright();
const { app, base } = await startParty({ stemRun });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 20000) => {
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
const song = (q) => app.library.catalog.search(q).items[0];
const seen = (page, selector, timeout = 8000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.route('**/js/tv/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
  });
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const engine = (what) => tv.evaluate((w) => {
    const e = window.__tvController.engine;
    if (w === 'vox') return e.voxGains ? +e.voxGains[0].gain.value.toFixed(2) : null;
    if (w === 'mode') return e.track?.mode || null;
    return e[w];
  }, what);
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');
  await host.click('.admin-panel [role=tab]:has-text("Playback")');

  // ---- an ordinary song: separate it while it plays --------------------------------------------
  await hostReq('settings.update', { patch: { playback: { countdown: 1 } } });
  const tempo = song('tempo tantrum');
  await hostReq('queue.add', { songId: tempo.id, singerName: 'Ann' });
  check(await until(async () => room.s.player.state === 'playing' && (await engine('playing'))), 'Tempo Tantrum plays (its file)');
  check((await engine('mode')) === 'buffer', 'the TV plays the file');
  check(await seen(host, '#pb-stems button:has-text("Separate the vocals")'), 'Playback → Sound: “Separate the vocals”');
  await hostReq('player.seek', { pos: 8 });
  await sleep(500);
  await host.click('#pb-stems button:has-text("Separate the vocals")');
  check(await seen(host, '#pb-stems:has-text("Separating the vocals")'), 'it says it is separating');
  check(await until(async () => (await engine('mode')) === 'stems', 30000), 'when ready the TV plays the stems');
  const posAfter = await engine('position');
  check(posAfter > 7 && posAfter < 16, `where it was in the song (${posAfter.toFixed(1)} s, not from the start)`);
  check(await until(() => engine('playing')), 'and goes on playing');
  check(separations === 1, 'separated once');

  // ---- the Vocals level -------------------------------------------------------------------------
  check(await seen(host, '#pb-stems input[aria-label="Vocals (separated)"]'), 'the Vocals level');
  check((await engine('vox')) === 1, 'as recorded at first (100)');
  await host.click('#pb-stems .btn-row button:has-text("Off")');
  check(await until(async () => room.s.player.vox === 0 && (await engine('vox')) === 0), 'Off: the TV plays the music alone');
  await host.click('#pb-stems .btn-row button:has-text("Quiet")');
  check(await until(async () => room.s.player.vox === 50 && Math.abs((await engine('vox')) - 0.25) < 0.02), 'Quiet: the vocals at a quarter (−12 dB)');
  await shot(host, 'stems-level');

  // ---- the headphone monitor: the stems, with its own level ----------------------------------------
  await host.evaluate(() => { window.__okMonitorAnyOutput = true; });
  await host.click('#pb-monitor .switch');
  const mon = (w) => host.evaluate(async (what) => {
    const e = (await import('/js/host/monitor.js')).monitor.engine;
    if (!e) return null;
    if (what === 'vox') return e.voxGains ? +e.voxGains[0].gain.value.toFixed(2) : null;
    if (what === 'mode') return e.track?.mode || null;
    return e[what];
  }, w);
  check(await until(async () => (await mon('mode')) === 'stems' && (await mon('playing'))), 'the monitor plays the stems too');
  check(await until(async () => Math.abs((await mon('vox')) - 0.25) < 0.02), 'at the room’s level until moved');
  await host.$eval('#pb-monitor input[aria-label="Vocals in the headphones"]', (el) => {
    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check(await until(async () => (await mon('vox')) === 1 && Math.abs((await engine('vox')) - 0.25) < 0.02), 'its own level: full in the headphones, quiet in the room');
  await host.click('#pb-monitor .switch');

  // ---- the song dialog: the versions -------------------------------------------------------------
  const neon = song('neon heart');
  await host.evaluate((id) => import('/js/host/state.js').then((m) => m.openDialog({ type: 'song', songId: id })), neon.id);
  check(await seen(host, '.dialog button:has-text("Separate vocals")'), 'song dialog: each audio version has “Separate vocals”');
  await host.click('.dialog button:has-text("Separate vocals") >> nth=0');
  check(await until(() => neon.trackIds.some((id) => room.stemAsked(id)) && separations === 2, 10000), 'it separates that version ahead of its song');
  await host.keyboard.press('Escape');
  await host.evaluate((id) => import('/js/host/state.js').then((m) => m.openDialog({ type: 'song', songId: id })), tempo.id);
  check(await seen(host, '.dialog .pill:has-text("Vocals separated")'), 'a separated version says so');
  await shot(host, 'stems-dialog');
  await host.keyboard.press('Escape');

  // ---- the next song plays its file -----------------------------------------------------------------
  await hostReq('queue.add', { songId: song('high notes').id, singerName: 'Bo', position: 'next' });
  await hostReq('player.next');
  check(await until(async () => room.s.current?.title === 'High Notes Only' && (await engine('mode')) === 'buffer' && (await engine('playing'))), 'the next song plays its own file');
  check(room.s.player.vox === 100 && room.playerView().stems === 'idle', 'with no separated vocals');
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
