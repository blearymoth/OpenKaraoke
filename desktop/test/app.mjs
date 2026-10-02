#!/usr/bin/env node
// The desktop app end to end: Playwright drives the real Electron app (desktop/main.mjs) under
// a virtual X server. `npm --prefix desktop test` (after `npm --prefix desktop install`).
//   APP=<path to a packaged executable> also tests a build (e.g. dist/linux-unpacked/openkaraoke).
// A virtual X server can't show two monitors, so the app is told about two pretend screens side
// by side on one wide one (OPENKARAOKE_FAKE_DISPLAYS): the host's on the left, the TV's right.
// Updates come from a stand-in for GitHub (OPENKARAOKE_UPDATE_API) into a pretend AppImage.
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, check, results, sleep, WsClient } from '../../test/e2e/lib.mjs';
import { makeDemoLibrary } from '../../scripts/make-demo-library.js';
import { fakeGitHub } from '../../test/fake-github.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const out = path.join(ROOT, 'test-results', 'e2e-desktop');
await fs.mkdir(out, { recursive: true });
// APP is relative to where the command was typed (npm runs the script in desktop/).
const executable = process.env.APP ? path.resolve(process.env.INIT_CWD || process.cwd(), process.env.APP) : createRequire(import.meta.url)(path.join(DESKTOP, 'node_modules/electron'));
const appArgs = process.env.APP ? [] : [DESKTOP];

// A virtual X server with one wide screen when there is no display (CI, a terminal over SSH).
let xvfb = null;
if (!process.env.DISPLAY) {
  const display = `:${70 + Math.floor(Math.random() * 20)}`;
  xvfb = spawn('Xvfb', [display, '-screen', '0', '3200x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  process.env.DISPLAY = display;
  await sleep(800);
}
const SCREENS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 720 } },
  { id: 2, bounds: { x: 1280, y: 0, width: 1920, height: 1080 }, workArea: { x: 1280, y: 0, width: 1920, height: 1080 } },
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-desktop-'));
const userData = path.join(tmp, 'profile');
const lib = path.join(tmp, 'Karaoke');
await makeDemoLibrary(lib, { log: () => {} });
// A private repository (pretended) with version 9.9.9; this copy "is" an AppImage, and the new
// one only writes down how it was started.
const TOKEN = `github_pat_${'Zx9'.repeat(10)}`;
const gh = await fakeGitHub({ repo: 'blearymoth/OpenKaraoke', token: TOKEN });
const appImage = path.join(tmp, 'OpenKaraoke.AppImage');
await fs.writeFile(appImage, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const relaunched = path.join(tmp, 'relaunched.txt');
const NEW_APPIMAGE = Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$@" > '${relaunched}'\n`);
gh.publish('9.9.9', { 'OpenKaraoke-9.9.9.AppImage': NEW_APPIMAGE, 'openkaraoke_9.9.9_amd64.deb': Buffer.from('not for this copy') });
const env = {
  ...process.env,
  OPENKARAOKE_USER_DATA: userData,
  OPENKARAOKE_TEST_FOLDER: lib,
  OPENKARAOKE_FAKE_DISPLAYS: JSON.stringify(SCREENS),
  OPENKARAOKE_UPDATE_API: gh.api,
  OPENKARAOKE_TEST_EXTERNAL: '1', // links to other sites are noted, not opened in a browser
  APPIMAGE: appImage,
  PORT: '1', // ignored by the app: it never takes the port from the environment
};
delete env.XDG_SESSION_TYPE; // never restart through XWayland in a test

const { _electron: electron } = loadPlaywright();
const launch = () => electron.launch({
  executablePath: executable,
  // Sandboxing needs a setuid helper or user namespaces, which containers often lack; a fake
  // microphone so that the TV's microphone permission can be tried for real.
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', ...appArgs],
  env,
  timeout: 60_000,
});
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const menuItem = (label) => app.evaluate(({ Menu }, name) => {
  const items = Menu.getApplicationMenu().items.flatMap((m) => m.submenu?.items || []);
  items.find((i) => i.label === name).click();
}, label);
/** Quits the app like the menu does; a quit that hangs fails the test instead of hanging it. */
async function quit(running) {
  let timer;
  try {
    await Promise.race([running.close(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('quitting took more than 30 s')), 30_000); })]);
  } catch (e) {
    running.process()?.kill('SIGKILL');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function poll(fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > until) return v;
    await sleep(200);
  }
}

// Another program already has OpenKaraoke's usual port: the app must take the next free one.
const squatter = net.createServer();
const squatting = await new Promise((resolve) => {
  squatter.once('error', () => resolve(false));
  squatter.listen({ port: 6527, host: '0.0.0.0', exclusive: true }, () => resolve(true));
});

let app;
let ws;
let failed = false;
try {
  app = await launch();
  const host = await app.firstWindow();
  await host.waitForURL(/\/host/, { timeout: 30_000 });
  const port = Number(new URL(host.url()).port);
  check(port > 0 && port !== 6527, `with port 6527 taken by another program the app uses ${port}${squatting ? '' : ' (6527 was already busy)'}`);
  const lock = await readJson(path.join(userData, 'data', 'server.json'));
  check(lock.port === port && (await readJson(path.join(userData, 'data', 'settings.json'))).server.port === port, 'the port is in the lock file and kept in the settings');
  check(await host.evaluate(() => typeof window.okDesktop?.openTv === 'function' && typeof window.okDesktop?.pickFolder === 'function' && typeof window.require === 'undefined'),
    'the host page sees the app’s bridge (open TV, pick folder) and no Node');
  const { title, bounds } = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { title: w.getTitle(), bounds: w.getBounds() };
  });
  check(/OpenKaraoke/.test(title) && bounds.width >= 400, `host window "${title}" ${bounds.width}×${bounds.height}`);

  // First start: "Add your karaoke songs" → the folder (the system dialog in real use).
  await host.waitForSelector('.hero-card button:has-text("Choose folder")', { timeout: 20_000 });
  await shot(host, 'host-first-start');
  await host.click('.hero-card button:has-text("Choose folder")');
  const songs = await host.waitForFunction(async () => (await (await fetch('/api/info')).json()).library.songs, null, { timeout: 30_000, polling: 300 }).then((h) => h.jsonValue(), () => 0);
  check(songs >= 5, `choosing the folder scans it (${songs} songs)`);

  // The TV window: on the second screen, full screen, sound allowed without a click.
  ws = new WsClient(`ws://127.0.0.1:${port}/ws`);
  await ws.open({ role: 'host' });
  const tvOpened = app.waitForEvent('window', { timeout: 20_000 });
  await host.click('button:has-text("Open TV display")');
  const tv = await tvOpened;
  await tv.waitForURL(/\/tv/, { timeout: 20_000 });
  await tv.waitForSelector('.tv', { timeout: 20_000 }).catch(() => {});
  const tvWin = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => /\/tv/.test(x.webContents.getURL()));
    return { bounds: w.getBounds(), full: w.isFullScreen(), title: w.getTitle(), menu: w.isMenuBarVisible() };
  });
  check(tvWin.bounds.x >= 1280 && tvWin.full, `the TV window is full screen on the second screen (${JSON.stringify(tvWin.bounds)}, full screen ${tvWin.full})`);
  check(!tvWin.menu, 'the TV window has no menu bar');
  const toast = await host.waitForSelector('.toast:has-text("second screen")', { timeout: 5000 }).then((el) => el.textContent(), () => '');
  check(/second screen/i.test(toast), `the host is told where the TV went ("${toast.trim()}")`);
  await ws.until((s) => s.player?.hasDisplay, 15_000).catch(() => {});
  await sleep(1500); // time for the TV to report whether it may play sound
  check(!(await tv.$('.start')), 'no "click to start" on the TV: sound is allowed straight away');
  check(ws.state.player?.hasDisplay === true && ws.state.player.displayLocked === false, 'the host sees the TV connected with its sound unlocked');
  await shot(tv, 'tv-lobby');

  // The applause meter's microphone: allowed without a prompt (audio only, never the camera).
  const mic = await tv.evaluate(async () => {
    const perm = (await navigator.permissions.query({ name: 'microphone' })).state;
    let audio = 'no';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      audio = 'yes';
    } catch (e) { audio = e.name; }
    let video = 'no';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      video = 'yes';
    } catch (e) { video = e.name; }
    return { perm, audio, video };
  });
  check(mic.perm === 'granted' && mic.audio === 'yes', `the TV may use the microphone (${mic.perm}, ${mic.audio})`);
  check(mic.video !== 'yes', `but not the camera (${mic.video})`);

  // A song: queued from the host, it plays on the TV.
  const song = await host.evaluate(async () => (await (await fetch('/api/search?q=neon%20heart')).json()).items[0]);
  await ws.req('queue.add', { songId: song.id, singerName: 'Ann' });
  await ws.req('player.play').catch(() => {}); // auto-start may have begun it already
  const playing = await ws.until((s) => s.player?.state === 'playing', 30_000).then(() => true, () => false);
  check(playing, 'a queued song plays on the TV window');
  await shot(tv, 'tv-singing');
  await shot(host, 'host-playing');

  // "Open TV display" again: the same window, not a second one.
  await host.click('button:has-text("Open TV display")').catch(() => {});
  await sleep(800);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check(windows === 2, `clicking again brings the TV window forward instead of opening another (${windows} windows)`);

  // Menu: move the TV window to the next screen (here: back to the host's screen, as a window).
  await menuItem('Move TV window to the next screen');
  await sleep(1000);
  const moved = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => /\/tv/.test(x.webContents.getURL()));
    return { bounds: w.getBounds(), full: w.isFullScreen() };
  });
  check(moved.bounds.x < 1280 && !moved.full, `the menu moves it to the next screen: the host's, as a window (${JSON.stringify(moved.bounds)})`);

  // Links to other sites open in the normal browser, never inside the app.
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await host.evaluate(() => window.open('https://example.com/', '_blank'));
  await sleep(500);
  check(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === before, 'an outside link opens no window in the app');
  const navigated = await host.evaluate(() => { location.href = 'https://example.com/'; return location.href; }).catch(() => '');
  await sleep(500);
  check(new URL(host.url()).port === String(port), `the host window stays on the app's pages (${navigated && host.url()})`);
  const external = await app.evaluate(() => globalThis.okOpenedExternally || []);
  check(external.length === 2 && external.every((u) => u === 'https://example.com/'), `both go to the normal browser instead (${JSON.stringify(external)})`);

  // A second start of the app: the running one comes to the front, nothing else happens.
  const second = spawn(executable, ['--no-sandbox', ...appArgs], { env, stdio: 'ignore' });
  const secondExit = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('still running'), 20_000);
    second.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  if (secondExit === 'still running') second.kill();
  check(secondExit === 0, `starting the app again only brings the running one forward (exit ${secondExit})`);

  // Stop the song, then close the host window: the TV window goes with it at once (before the
  // party is saved, which can take seconds with a big library), the app quits, the party is
  // saved and the data folder is free again.
  await ws.req('player.stop').catch(() => {});
  ws.close();
  ws = null;
  const marks = path.join(tmp, 'close-marks.txt');
  await app.evaluate(({ BrowserWindow }, [file, lockFile]) => {
    const nodeFs = process.getBuiltinModule('fs');
    const tvWindow = BrowserWindow.getAllWindows().find((w) => /\/tv/.test(w.webContents.getURL()));
    tvWindow?.once('closed', () => nodeFs.appendFileSync(file, nodeFs.existsSync(lockFile) ? 'tv closed while saving\n' : 'tv closed after saving\n'));
  }, [marks, path.join(userData, 'data', 'server.json')]);
  const exited = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /\/host/.test(w.webContents.getURL())).close());
  await exited;
  app = null;
  const closedTv = (await fs.readFile(marks, 'utf8').catch(() => '')).trim();
  check(closedTv === 'tv closed while saving', `closing the host window closes the TV window with it, straight away (${closedTv || 'the TV window stayed'})`);
  await sleep(300);
  const leftLock = await fs.access(path.join(userData, 'data', 'server.json')).then(() => true, () => false);
  const state = await readJson(path.join(userData, 'data', 'state.json'));
  check(!leftLock && state.queue?.length === 1, `quitting saves the party (${state.queue?.length} song in the queue) and frees the data folder`);

  // Next start: the same port again, even with 6527 free now.
  if (squatting) await new Promise((r) => squatter.close(r));
  app = await launch();
  const again = await app.firstWindow();
  await again.waitForURL(/\/host/, { timeout: 30_000 });
  check(Number(new URL(again.url()).port) === port, `the next start uses the same port again (${new URL(again.url()).port})`);

  // Updates: Help › Check for updates… shows Settings › About and looks. The repository is
  // private, so a token is asked for; with it, 9.9.9 is found, downloaded over the AppImage and
  // started by "Restart now".
  await menuItem('Check for updates…');
  await again.waitForURL(/#\/settings\/about/, { timeout: 10_000 });
  const tokenField = await again.waitForSelector('input[aria-label="GitHub access token"]', { timeout: 20_000 }).then(() => true, () => false);
  const said = (await again.textContent('.updates').catch(() => '')).replace(/\s+/g, ' ');
  check(tokenField && /private/.test(said), `a private repository asks for a token ("${said.slice(0, 120)}")`);
  await again.fill('input[aria-label="GitHub access token"]', TOKEN);
  await again.click('form:has(input[aria-label="GitHub access token"]) button:has-text("Save")');
  const found = await again.waitForSelector('.updates :text("Version 9.9.9 is available")', { timeout: 20_000 }).then(() => true, () => false);
  const pill = await again.textContent('.top-right .pill.neon').catch(() => '');
  check(found && /Update 9\.9\.9/.test(pill), `with the token, version 9.9.9 is found (top bar: "${pill.trim()}")`);
  const config = path.join(userData, 'updates.json');
  check(!(await again.content()).includes(TOKEN) && ((await fs.stat(config)).mode & 0o777) === 0o600,
    'the token is kept in updates.json for this user only, never shown in the page');
  await shot(again, 'host-update-available');
  await again.click('button:has-text("Download and install")');
  const ready = await again.waitForSelector('button:has-text("Restart now")', { timeout: 30_000 }).then(() => true, () => false);
  const swapped = (await fs.readFile(appImage)).equals(NEW_APPIMAGE) && ((await fs.stat(appImage)).mode & 0o111) === 0o111;
  check(ready && swapped, `"Download and install" replaces the AppImage with the checked new one (ready ${ready}, replaced ${swapped})`);
  check(gh.seen.filter((r) => r.at === 'storage').every((r) => !r.auth), 'the token never goes to GitHub’s file storage');
  await shot(again, 'host-update-ready');
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await again.click('button:has-text("Restart now")');
  await closed;
  app = null;
  const started = await poll(() => fs.readFile(relaunched, 'utf8'), 20_000);
  check(!!started && /--no-sandbox/.test(started), `"Restart now" quits and starts the new AppImage with the same options (${(started || 'not started').trim().split('\n').join(' ')})`);
  check(!(await fs.access(path.join(userData, 'data', 'server.json')).then(() => true, () => false)), 'the party was saved and the data folder freed before the restart');
} catch (e) {
  failed = true;
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  ws?.close();
  if (app) await quit(app).catch(() => {});
  if (squatter.listening) squatter.close();
  await gh.close().catch(() => {});
  xvfb?.kill();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(bad.length || failed ? 1 : 0);
