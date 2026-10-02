#!/usr/bin/env node
// End-to-end checks of the lead vocal control on the demo's multiplex song ("Quiet Storm
// (Multiplex)": the original singer on the left channel, the music alone on the right): the TV
// finds the singer's side while decoding, plays the music alone by default, the host's Lead
// control and Vocals dialog, the TV's chip and shortcut, the guest's song sheet and turn card.
//
//   node test/e2e/vocals.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-vocals');
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
const seen = (page, selector, timeout = 5000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
/** Test only: expose the TV page's controller so its channel matrix can be read. */
const exposeController = (page) => page.route('**/js/tv/main.js', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
});
/** The TV's four channel gains [L→L, R→L, L→R, R→R] once they have settled. */
const gains = async (tv) => {
  await sleep(250); // the gains glide (time constant 20 ms)
  return tv.evaluate(() => window.__tvController.engine.matrix?.map((g) => +g.gain.value.toFixed(3)) || null);
};
const near = (m, want, tol = 0.1) => !!m && m.every((v, i) => Math.abs(v - want[i]) <= tol);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await exposeController(tv);
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');
  await host.click('.admin-panel [role=tab]:has-text("Playback")'); // the sound controls
  check(await seen(host, '.admin-panel select[aria-label="Channel mode"]'), 'nothing playing: the Sound controls have the channel mode');
  check(!(await host.$('.admin-panel select[aria-label="Lead vocal"]')), 'nothing playing: no Lead control');

  // ---- a guest asks for the multiplex song -------------------------------------------------
  // A long countdown keeps the song's intro on screen for the checks below.
  await hostReq('settings.update', { patch: { playback: { countdown: 120 } } });
  const code = app.settings.get('party.roomCode');
  const ann = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'Ann');
  await ann.goto(`${base}/j/${code}`);
  await ann.waitForSelector('.profile-form');
  await ann.fill('.profile-form input', 'Ann');
  await ann.click('.profile-form .btn.primary');
  await ann.waitForSelector('.g-tabs');
  await ann.click('.g-tabs button:has-text("Songs")');
  await ann.fill('.g-search input', 'neon heart');
  await ann.click('.g-songs .song-row:has-text("Neon Heart")');
  await ann.waitForSelector('.sheet .btn.primary');
  check(!(await ann.$('.sheet .toggle-row:has-text("Guide singer")')), 'an ordinary song has no Guide singer switch');
  await ann.click('.sheet-close');
  await ann.fill('.g-search input', 'quiet storm');
  await ann.click('.g-songs .song-row:has-text("Quiet Storm")');
  await ann.waitForSelector('.sheet .btn.primary');
  const guideSwitch = '.sheet .toggle-row:has-text("Guide singer") input';
  check(await seen(ann, guideSwitch), 'the multiplex song has a Guide singer switch');
  check(!(await ann.isChecked(guideSwitch)), 'the guide singer is off unless asked for');
  check(!(await ann.$('.sheet [aria-label="Backing vocals"]')), 'no Backing vocals choice without such versions');
  check(await noSideways(ann), 'the song sheet fits the phone (no sideways scrolling)');
  await shot(ann, 'guest-sheet-guide');
  await ann.click('.sheet .btn.primary');
  check(await seen(ann, '.sheet-done'), 'Ann asked for Quiet Storm');
  await ann.click('.sheet-done .btn');
  await sleep(300);
  // (With the TV on and nothing playing, the first request starts at once.)
  const entry = [room.s.current, ...room.s.queue].find((e) => e?.title.startsWith('Quiet Storm'));
  check(!!entry && !(entry.lead > 0), 'the request has no guide singer');

  // ---- the TV decodes it and finds the singer's side ---------------------------------------
  if (!room.s.current) await hostReq('player.play');
  await tv.waitForSelector('.intro');
  check(await until(() => room.s.player.tvReady, 20000), 'the TV loaded the song');
  const v = room.s.player.vocals;
  check(v?.adjustable && v.side === 'L' && v.source === 'file', `the singer was found on the left channel (${JSON.stringify(v)})`);
  const stored = room.vocals.get(room.s.current.trackId);
  check(stored?.l === 'mpx' && stored.s === 'L', `the analysis is kept for the track (${JSON.stringify(stored)})`);
  check(Math.abs((v?.a ?? 0) - 1) < 0.25, `the music is at the same level on both channels (a = ${v?.a})`);
  check(room.s.player.lead === 0, 'the guide singer starts off');
  check(near(await gains(tv), [0, 1, 0, 1]), `lead off: both speakers play the music channel only (${await gains(tv)})`);
  check(!(await tv.$('.intro .chip:has-text("Guide singer")')), 'TV intro: no guide chip while it is off');

  // ---- host: the Lead control --------------------------------------------------------------
  const leadSelect = '.admin-panel select[aria-label="Lead vocal"]';
  check(await seen(host, leadSelect), 'host: the Sound controls have the Lead control');
  check(!(await host.$('.admin-panel select[aria-label="Channel mode"]')), 'host: the channel mode gives way to it');
  await host.selectOption(leadSelect, '100');
  check(await until(() => room.s.player.lead === 100), 'host: Lead full');
  const full = await gains(tv);
  check(near(full, [1, 0, 1, 0], 0.25), `lead full: the singer's channel as recorded (${full})`);
  check(Math.abs(full[1] + full[0] * v.a - 1) < 0.02, `the music level stays the same (c + g·a = ${full[1] + full[0] * v.a})`);
  check(await seen(tv, '.intro .chip:has-text("Guide singer on")'), 'TV intro: “Guide singer on”');
  await shot(tv, 'tv-intro-guide');
  await host.selectOption(leadSelect, '50');
  check(await until(() => room.s.player.lead === 50), 'host: Lead quiet');
  const quiet = await gains(tv);
  check(near(quiet, [0.25, 0.75, 0.25, 0.75], 0.1), `lead quiet: the singer at a quarter (−12 dB) (${quiet})`);
  check(await seen(tv, '.intro .chip:has-text("Guide singer quiet")'), 'TV intro: “Guide singer quiet”');
  await shot(host, 'host-player-lead');

  // TV shortcut: V (or C) steps the guide singer off → quiet → full.
  await tv.keyboard.press('v');
  check(await until(() => room.s.player.lead === 100), 'TV: V turns the guide singer to full');
  await sleep(400); // (the TV steps from the level it has been told)
  await tv.keyboard.press('v');
  check(await until(() => room.s.player.lead === 0), 'TV: V again turns it off');

  // ---- host: the Vocals dialog ------------------------------------------------------------
  await host.click('.admin-panel .vocals-more');
  check(await seen(host, '.dialog:has-text("Lead vocal (the original singer)")'), 'host: the Vocals dialog opens');
  check(await seen(host, '.dialog .hint:has-text("left")'), 'the dialog says which side the singer is on');
  await host.click('.dialog .btn-row .btn:has-text("Full")');
  check(await until(() => room.s.player.lead === 100), 'dialog: the Full preset');
  check(await until(async () => (await host.inputValue('.dialog input[type="range"]')) === '100'), 'dialog: the slider follows');
  const onPreset = await host.$$eval('.dialog .btn-row .btn.on', (l) => l.map((b) => b.textContent.trim()));
  check(onPreset.join() === 'Full', `dialog: the Full preset is marked (${onPreset})`);
  await (await host.$('.dialog')).screenshot({ path: path.join(out, 'host-vocals-dialog-close.png') });
  await shot(host, 'host-vocals-dialog');
  // Correcting the layout: "ordinary stereo" brings the channel mode back, "Automatic" undoes it.
  await host.click('.dialog details.vocals-layout summary');
  await host.click('.dialog details.vocals-layout .btn:has-text("Ordinary stereo")');
  check(await until(() => room.s.player.vocals && !room.s.player.vocals.adjustable), 'dialog: marked as ordinary stereo');
  check(await seen(host, '.admin-panel select[aria-label="Channel mode"]'), 'host: the channel mode is back');
  check(near(await gains(tv), [1, 0, 0, 1]), 'ordinary stereo: the TV plays both channels as they are');
  check(await seen(host, '.dialog .hint:has-text("No lead vocal")'), 'dialog: no lead vocal now');
  await host.click('.dialog details.vocals-layout:not([open]) summary').catch(() => {});
  await host.click('.dialog details.vocals-layout .btn:has-text("Automatic")');
  check(await until(() => room.s.player.vocals?.adjustable && room.s.player.vocals.side === 'L'), 'dialog: Automatic finds the left side again');
  check(await seen(host, leadSelect), 'host: the Lead control is back');
  await host.click('.dialog .close');

  // ---- the song plays: the singer's phone has the guide switch -----------------------------
  await hostReq('player.resume'); // skips the countdown
  check(await until(async () => room.s.player.state === 'playing' && (await tv.evaluate(() => window.__tvController.engine.playing)), 20000), 'the song plays');
  check(near(await gains(tv), [1, 0, 1, 0], 0.25), 'playing at Lead full: the singer heard as recorded');
  await ann.click('.g-tabs button:first-child');
  const guideBtn = '.g-turn.now .guide-btn';
  check(await seen(ann, `${guideBtn}:has-text("Guide singer: on")`), 'Ann: her turn card has the guide switch, on');
  check(await noSideways(ann), 'the turn card fits the phone');
  await shot(ann, 'guest-turn-guide');
  await ann.click(guideBtn);
  check(await until(() => room.s.player.lead === 0), 'Ann turned the guide singer off');
  check(near(await gains(tv), [0, 1, 0, 1]), 'the TV plays the music alone again');
  check(await seen(ann, `${guideBtn}:has-text("Guide singer: off")`), 'Ann: the switch says off');
  await ann.click(guideBtn);
  check(await until(() => room.s.player.lead === 50), 'Ann turned it back on (quiet)');
  check(await until(async () => (await host.inputValue(leadSelect)) === '50'), 'host: the Lead control follows (quiet)');

  // The host can turn the guests' switch off: the button goes.
  await hostReq('settings.update', { patch: { queue: { guestVocals: false } } });
  check(await until(async () => !(await ann.$(guideBtn)), 3000), 'Ann: no guide switch once the host turns it off');
  await hostReq('settings.update', { patch: { queue: { guestVocals: true }, playback: { countdown: 3 } } });
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
