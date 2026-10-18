#!/usr/bin/env node
// End-to-end checks of the headphone monitor (Playback → Sound): it won't play on the TV's own
// output, it plays the song in time with the TV (start, a seek, pause and play, a new song), with
// the TV's key, and on a multiplex track its own guide level; the delay slider moves it ahead;
// it keeps going when the card is out of sight; no console errors.
//
//   node test/e2e/monitor.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-monitor');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
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
const song = (q) => app.library.catalog.search(q).items[0];
const seen = (page, selector, timeout = 6000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  // Test only: the TV's controller, to read its engine.
  await tv.route('**/js/tv/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
  });
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');
  await host.click('.admin-panel [role=tab]:has-text("Playback")');
  check(await seen(host, '#pb-monitor'), 'Playback → Sound has the headphone monitor');

  // The TV plays on this computer's default output: without headphones chosen, no.
  await host.click('#pb-monitor .switch');
  check(await seen(host, '.toast:has-text("Choose the headphones first")'), 'no headphones chosen: it won’t play on the TV’s output');
  check(!(await host.isChecked('#pb-monitor .switch input')), 'and stays off');

  // (Test only: headless Chromium has no headphones, so let it play on the default output.)
  await host.evaluate(() => { window.__okMonitorAnyOutput = true; });
  await host.click('#pb-monitor .switch');
  check(await until(() => host.isChecked('#pb-monitor .switch input')), 'switched on');

  const tvPos = () => tv.evaluate(() => window.__tvController.engine.position);
  /** The monitor's engine: 'position', 'playing', 'key', 'matrix' or 'on' (null when it has none). */
  const mon = (what) => host.evaluate(async (w) => {
    const eng = (await import('/js/host/monitor.js')).monitor.engine;
    if (!eng) return null;
    if (w === 'matrix') return eng.matrix.map((g) => +g.gain.value.toFixed(2));
    return w === 'on' ? true : eng[w];
  }, what);
  /** How far the monitor is from the TV (seconds; positive: ahead), read back to back. */
  const gap = async () => {
    const a = await tvPos();
    const b = await mon('position');
    const c = await tvPos();
    return b - (a + c) / 2;
  };
  const inTime = async (want = 0, tol = 0.1, ms = 15000) => until(async () => Math.abs((await gap()) - want) < tol, ms);

  // ---- a song: the monitor follows the TV ----------------------------------------------------
  await hostReq('settings.update', { patch: { playback: { countdown: 1 } } });
  await hostReq('queue.add', { songId: song('tempo tantrum').id, singerName: 'Ann' });
  check(await until(async () => room.s.player.state === 'playing' && (await tv.evaluate(() => window.__tvController.engine.playing)), 30000), 'the song plays on the TV');
  check(await inTime(), `the monitor plays in time with the TV (${(await gap()).toFixed(3)} s)`);
  check(await seen(host, '#pb-monitor .monitor-status:has-text("In time with the TV")'), 'it says so');
  await shot(host, 'monitor-on');

  await hostReq('player.seek', { pos: 15 });
  check(await until(async () => Math.abs((await tvPos()) - 15) < 1.5), 'the TV jumps to 0:15');
  check(await inTime(), `the monitor follows the jump (${(await gap()).toFixed(3)} s)`);

  await hostReq('player.pause');
  check(await until(async () => (await mon('playing')) === false), 'pause on the TV: the monitor pauses');
  await hostReq('player.resume');
  check(await inTime(), `play again: in time (${(await gap()).toFixed(3)} s)`);

  await hostReq('player.key', { semitones: 2 });
  check(await until(async () => (await mon('key')) === 2), 'the TV’s key (+2) in the headphones too');
  await hostReq('player.key', { semitones: 0 });

  // The delay slider: headphones 200 ms late → the monitor plays 200 ms ahead.
  await host.$eval('#pb-monitor input[aria-label="Headphone delay"]', (el) => {
    el.value = '200';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check(await seen(host, '#pb-monitor b:has-text("+200 ms")'), 'Delay: +200 ms');
  check(await inTime(0.2, 0.1), `the monitor plays 0.2 s ahead (${(await gap()).toFixed(3)} s)`);
  await host.$eval('#pb-monitor input[aria-label="Headphone delay"]', (el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ---- out of sight: it keeps playing -----------------------------------------------------------
  await hostReq('player.seek', { pos: 2 }); // (the demo songs are 30 s long)
  check(await inTime(), 'back to 0:02, in time');
  await host.click('.admin-panel [role=tab]:has-text("Queue")');
  await sleep(1000);
  const away = await gap();
  check((await mon('playing')) === true && Math.abs(away) < 0.15, `on the Queue tab the monitor keeps playing, in time (${away.toFixed(3)} s)`);
  await host.click('.admin-panel [role=tab]:has-text("Playback")');

  // ---- the multiplex song: its own guide level ---------------------------------------------------
  const mpx = song('quiet storm');
  await hostReq('queue.add', { songId: mpx.id, singerName: 'Bo', position: 'next' });
  await hostReq('player.next');
  check(await until(async () => room.s.current?.songId === mpx.id && room.s.player.state === 'playing' && room.s.player.vocals?.adjustable, 40000), 'Quiet Storm (multiplex) plays');
  check(await inTime(), `a new song: the monitor loads it and plays in time (${(await gap()).toFixed(3)} s)`);
  check(room.s.player.lead === 0, 'the room hears no guide singer');
  await host.waitForSelector('#pb-monitor input[aria-label="Guide singer in the headphones"]');
  await host.$eval('#pb-monitor input[aria-label="Guide singer in the headphones"]', (el) => {
    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(600);
  const tvGains = await tv.evaluate(() => window.__tvController.engine.matrix.map((g) => +g.gain.value.toFixed(2)));
  const monGains = await mon('matrix');
  check(JSON.stringify(tvGains) === '[0,1,0,1]', `the TV: the music channel only (${tvGains})`);
  check(Math.abs(monGains[0] - 1) < 0.2 && Math.abs(monGains[1]) < 0.2, `the headphones: the guide singer as recorded (${monGains})`);
  await shot(host, 'monitor-guide');

  // Off: it stops.
  await host.click('#pb-monitor .switch');
  check(await until(async () => (await mon('on')) === null), 'switched off: the monitor’s engine is gone');
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
