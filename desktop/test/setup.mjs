#!/usr/bin/env node
// The one-download installer end to end (desktop/setup.mjs, desktop/install.mjs): Playwright
// clicks through the setup window under a virtual X server, in a home folder of its own.
//   Run it without installing → Install (with a start at login) → Start OpenKaraoke → the setup
//   again (installed: Start / Repair / Uninstall) → the installed app's Settings → About (start at
//   login, server mode, Uninstall…) → the menu entry's Uninstall (--uninstall).
// By default the app runs from the source code and "the AppImage" is a small script that writes
// down how it was started. SETUP_APPIMAGE=<a built AppImage> runs the real one instead (the
// release workflow does, with APPIMAGE_EXTRACT_AND_RUN=1 where FUSE is missing): then the
// installed copy really starts, as OpenKaraoke.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, check, results, sleep } from '../../test/e2e/lib.mjs';
import { installPaths, menuEntry } from '../install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const out = path.join(ROOT, 'test-results', 'e2e-setup');
await fs.mkdir(out, { recursive: true });
const REAL = process.env.SETUP_APPIMAGE ? path.resolve(process.env.INIT_CWD || process.cwd(), process.env.SETUP_APPIMAGE) : '';
const electronBin = createRequire(import.meta.url)(path.join(DESKTOP, 'node_modules/electron'));

let xvfb = null;
if (!process.env.DISPLAY) {
  const display = `:${90 + Math.floor(Math.random() * 9)}`;
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  process.env.DISPLAY = display;
  await sleep(800);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-setup-'));
const home = path.join(tmp, 'home');
const downloads = path.join(home, 'Downloads');
await fs.mkdir(downloads, { recursive: true });
const userData = path.join(home, '.config', 'OpenKaraoke');
const paths = installPaths({ env: {}, home, desktopDir: path.join(home, 'Desktop') });
const started = path.join(tmp, 'started.txt'); // the pretend AppImage writes how it was started here

/** "Install OpenKaraoke" in Downloads: the real AppImage, or a script standing in for it. */
async function download(name) {
  const file = path.join(downloads, name);
  if (REAL) await fs.copyFile(REAL, file);
  else await fs.writeFile(file, `#!/bin/sh\nprintf '%s\\n' "$0" "$@" "APPIMAGE=$APPIMAGE" "LD=$LD_LIBRARY_PATH" > '${started}'\n`);
  await fs.chmod(file, 0o755);
  return file;
}

const baseEnv = {
  ...process.env,
  HOME: home,
  OPENKARAOKE_TEST_EXTERNAL: '1',
  OPENKARAOKE_FAKE_NMCLI: 'ok',
  // The installed copy started by "Start OpenKaraoke" (outside Playwright) needs it as root/in CI.
  OPENKARAOKE_TEST_LAUNCH_ARGS: JSON.stringify(['--no-sandbox']),
};
for (const k of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_SESSION_TYPE', 'OPENKARAOKE_USER_DATA', 'APPIMAGE', 'APPDIR']) delete baseEnv[k];

const { _electron: electron } = loadPlaywright();
/**
 * Starts `file` as the AppImage would: the real one itself, or Electron from the source with
 * APPIMAGE pointing at the stand-in (what the AppImage runtime sets).
 */
function launch(file, { args = [], env = {} } = {}) {
  return electron.launch({
    executablePath: REAL ? file : electronBin,
    args: REAL ? ['--no-sandbox', ...args] : ['--no-sandbox', DESKTOP, ...args],
    env: { ...baseEnv, ...(REAL ? {} : { APPIMAGE: file }), ...env },
    timeout: 90_000,
  });
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const exists = (f) => fsSync.existsSync(f);
async function poll(fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > until) return v;
    await sleep(200);
  }
}
async function closed(app) {
  if (!app) return;
  await Promise.race([app.waitForEvent('close').catch(() => {}), sleep(20_000)]);
}
/** The pretend AppImage was started, or (the real one) OpenKaraoke runs on this profile: then it is stopped. */
async function startedCopy(what) {
  if (!REAL) return (await poll(() => fs.readFile(started, 'utf8'), 20_000)) || '';
  const lock = await poll(async () => {
    const l = JSON.parse(await fs.readFile(path.join(userData, 'data', 'server.json'), 'utf8'));
    return l.port ? l : null;
  }, 90_000);
  if (!lock) return '';
  const host = await fetch(`http://127.0.0.1:${lock.port}/host`).then((r) => r.status, () => 0);
  process.kill(lock.pid, 'SIGTERM');
  await poll(async () => !exists(path.join(userData, 'data', 'server.json')), 30_000);
  return `${what} running (host page ${host})`;
}

let app = null;
let failed = false;
try {
  // ---- 1. Run it without installing ---------------------------------------------------------
  const tryFile = await download('Try OpenKaraoke');
  app = await launch(tryFile);
  let win = await app.firstWindow();
  await win.waitForSelector('h1', { timeout: 30_000 });
  check(/^okapp:\/\/app\/setup\//.test(win.url()), `an AppImage that isn't installed shows the setup window (${win.url()})`);
  check((await win.textContent('h1')) === 'Install OpenKaraoke', `first page: "${await win.textContent('h1')}"`);
  const facts = (await win.textContent('.facts')).replace(/\s+/g, ' ');
  check(/nothing else to download, no terminal/.test(facts) && /no password needed/.test(facts), 'it says what it will do: no other downloads, no terminal, no password');
  check(await win.evaluate(() => getComputedStyle(document.body).fontFamily && !!document.querySelector('.setup-head img')?.naturalWidth), 'the page has its styles, fonts and icon (served through okapp://)');
  check(await win.evaluate(() => typeof window.require === 'undefined' && typeof window.okSetup?.install === 'function'), 'the page sees the setup bridge and no Node');
  await shot(win, 'setup-1-welcome');
  await win.click('button:has-text("Run it without installing")');
  await closed(app);
  app = null;
  const ranHere = await startedCopy('the downloaded copy');
  check(REAL ? !!ranHere : ranHere.includes('--no-setup') && ranHere.startsWith(tryFile), `"Run it without installing" starts the file itself as the app (${ranHere.trim().split('\n').slice(0, 2).join(' ')})`);
  const remembered = JSON.parse(await fs.readFile(path.join(userData, 'setup.json'), 'utf8')).portable;
  check(remembered?.[0] === tryFile, 'and remembers the file: it starts as the app from then on');
  check(!exists(paths.appImage) && !exists(paths.menuEntry), 'nothing is installed');
  await fs.rm(started, { force: true });

  // ---- 2. Install -----------------------------------------------------------------------------
  const setupFile = await download('Install OpenKaraoke');
  app = await launch(setupFile);
  win = await app.firstWindow();
  await win.waitForSelector('h1:has-text("Install OpenKaraoke")', { timeout: 30_000 });
  await win.click('label.option:has-text("Start OpenKaraoke when I log in")');
  await win.click('button.primary:has-text("Install")');
  await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 60_000 });
  await shot(win, 'setup-2-done');
  const same = (await fs.readFile(paths.appImage)).equals(await fs.readFile(setupFile));
  check(same && ((await fs.stat(paths.appImage)).mode & 0o777) === 0o755, `Install copies the program to ${paths.appImage.replace(home, '~')}, executable`);
  check((await fs.readFile(paths.menuEntry, 'utf8')) === menuEntry(paths), 'a menu entry (with "Uninstall OpenKaraoke" on right-click)');
  check(exists(paths.shortcut) && ((await fs.stat(paths.shortcut)).mode & 0o111) !== 0, 'a desktop shortcut, executable');
  check(exists(paths.autostart) && (await fs.readFile(paths.autostart, 'utf8')).includes(paths.appImage), 'the start at login that was ticked');
  check(JSON.parse(await fs.readFile(paths.info, 'utf8')).version && exists(paths.icon), 'install.json (version) and the icon');
  const doneText = (await win.textContent('main')).replace(/\s+/g, ' ');
  check(/applications menu/.test(doneText) && /Install OpenKaraoke/.test(doneText), 'the last page says where to find it, and that the download can go');
  await win.click('button:has-text("Start OpenKaraoke")');
  await closed(app);
  app = null;
  const launched = await startedCopy('the installed copy');
  check(REAL ? !!launched : launched.startsWith(paths.appImage) && /^APPIMAGE=$/m.test(launched),
    `"Start OpenKaraoke" starts the installed copy, without the setup's AppImage variables (${launched.trim().split('\n')[0]})`);
  await fs.rm(started, { force: true });

  // ---- 3. The setup again: installed — Start / Repair / Uninstall ---------------------------
  app = await launch(setupFile);
  win = await app.firstWindow();
  await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 30_000 });
  check(await win.isVisible('button:has-text("Start OpenKaraoke")') && await win.isVisible('button:has-text("Install again (repair)")') && await win.isVisible('button:has-text("Uninstall OpenKaraoke…")'),
    'opened again, the setup knows it is installed: Start, Install again (repair), Uninstall');
  await shot(win, 'setup-3-installed');
  await fs.rm(paths.menuEntry);
  await win.click('button:has-text("Install again (repair)")');
  await win.waitForSelector('h1:has-text("Install OpenKaraoke")');
  await win.click('button.primary:has-text("Install")');
  await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 60_000 });
  check(exists(paths.menuEntry) && exists(paths.autostart), 'repair puts the menu entry back (the start at login switch shows what is set: on)');
  await win.click('button:has-text("Close")').catch(() => {}); // (the setup quits: the click may not see its end)
  await closed(app);
  app = null;
  // An older copy installed: the setup offers to update it.
  const note = JSON.parse(await fs.readFile(paths.info, 'utf8'));
  await fs.writeFile(paths.info, JSON.stringify({ ...note, version: '0.0.1' }));
  app = await launch(setupFile);
  win = await app.firstWindow();
  await win.waitForSelector('h1', { timeout: 30_000 });
  const updateTitle = await win.textContent('h1');
  const lead = (await win.textContent('.lead')).replace(/\s+/g, ' ');
  check(updateTitle === 'Update OpenKaraoke' && /Version 0\.0\.1 is installed/.test(lead) && await win.isVisible('button.primary:has-text("Update")'),
    `an older copy installed: "${updateTitle}" (${lead.slice(0, 60)}…)`);
  await shot(win, 'setup-3b-update');
  await win.click('button.primary:has-text("Update")');
  await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 60_000 });
  check(JSON.parse(await fs.readFile(paths.info, 'utf8')).version !== '0.0.1', 'Update installs this version over it');
  await win.click('button:has-text("Close")').catch(() => {}); // (the setup quits: the click may not see its end)
  await closed(app);
  app = null;

  // ---- 4. The installed app: Settings → About → On this computer ------------------------------
  if (!REAL) {
    app = await launch(paths.appImage);
    const host = await app.firstWindow();
    await host.waitForURL(/\/host/, { timeout: 60_000 });
    await host.evaluate(() => { location.hash = '#/settings/about'; });
    await host.waitForSelector('.section-title:has-text("On this computer")', { timeout: 20_000 });
    const about = (await host.textContent('.settings-body')).replace(/\s+/g, ' ');
    check(/Installed for you in ~\/\.local\/share\/OpenKaraoke/.test(about), `the installed copy knows how it is installed ("${(about.match(/Installed for you[^.]*\./) || [''])[0]}")`);
    await shot(host, 'app-about-installed');
    const loginSwitch = 'input[aria-label="Start OpenKaraoke when I log in"]';
    const wasOn = await host.isChecked(loginSwitch);
    check(wasOn === exists(paths.autostart), `the switch shows the start at login set up by the installer (${wasOn ? 'on' : 'off'})`);
    await host.click(`label.switch:has(${loginSwitch})`);
    await poll(async () => exists(paths.autostart) !== wasOn, 5000);
    check(exists(paths.autostart) !== wasOn, `Start OpenKaraoke when I log in: switched ${wasOn ? 'off — the autostart entry is gone' : 'on — the autostart entry'}`);
    await host.click(`label.switch:has(${loginSwitch})`);
    await poll(async () => exists(paths.autostart) === wasOn, 5000);
    await host.click('label.switch:has(input[aria-label="Keep the party running when this window is closed"])');
    const bg = await poll(async () => JSON.parse(await fs.readFile(path.join(userData, 'startup.json'), 'utf8')).background === true, 5000);
    check(!!bg, 'Keep the party running when this window is closed (server mode) is saved');
    // Server mode: closing the window leaves the app (and the party) running.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(1500);
    const still = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().length, told: globalThis.okNotified || [] })).catch(() => null);
    const lock = JSON.parse(await fs.readFile(path.join(userData, 'data', 'server.json'), 'utf8'));
    const serving = await fetch(`http://127.0.0.1:${lock.port}/api/info`).then((r) => r.ok, () => false);
    check(still && still.windows === 0 && serving && still.told.includes('OpenKaraoke keeps running'), `server mode: with the window closed the party server keeps running, and says so (${JSON.stringify(still)})`);
    // Started again (from the menu): the window comes back.
    await app.evaluate(({ app: a }) => a.emit('second-instance', {}, ['openkaraoke'], process.cwd()));
    const back = await app.waitForEvent('window', { timeout: 15_000 }).then((w) => w, () => null);
    await back?.waitForURL(/\/host/, { timeout: 20_000 });
    check(!!back, 'starting OpenKaraoke again brings its window back');
    await back.evaluate(() => { location.hash = '#/settings/about'; });
    await back.waitForSelector('.section-title:has-text("On this computer")', { timeout: 20_000 });
    await back.click('label.switch:has(input[aria-label="Keep the party running when this window is closed"])');
    await poll(async () => JSON.parse(await fs.readFile(path.join(userData, 'startup.json'), 'utf8')).background === false, 5000);
    // Quit OpenKaraoke (a visible way out, for server mode): saves and ends.
    const ended = app.waitForEvent('close', { timeout: 30_000 }).then(() => true, () => false);
    await back.click('button:has-text("Quit OpenKaraoke")');
    check(await ended && !exists(path.join(userData, 'data', 'server.json')), 'Settings → About → Quit OpenKaraoke saves the party and quits');
    app = await launch(paths.appImage);
    const again = await app.firstWindow();
    await again.waitForURL(/\/host/, { timeout: 60_000 });
    await again.evaluate(() => { location.hash = '#/settings/about'; });
    await again.waitForSelector('.section-title:has-text("On this computer")', { timeout: 20_000 });
    // Uninstall… asks in the system's own dialog (answered here), keeping the settings.
    await app.evaluate(() => { process.env.OPENKARAOKE_TEST_ANSWER = JSON.stringify({ response: 1 }); });
    await again.click('button:has-text("Uninstall…")');
    await sleep(800);
    check(exists(paths.appImage) && (await app.evaluate(() => globalThis.okAsked || [])).includes('Uninstall OpenKaraoke?'), 'Uninstall… asks first in the system’s own dialog; Cancel changes nothing');
    const gone = app.waitForEvent('close', { timeout: 30_000 }).catch(() => {});
    await app.evaluate(() => { process.env.OPENKARAOKE_TEST_ANSWER = JSON.stringify({ response: 0, checkboxChecked: false }); });
    await again.click('button:has-text("Uninstall…")');
    await gone;
    app = null;
    check(!exists(paths.appImage) && !exists(paths.menuEntry) && !exists(paths.shortcut) && !exists(paths.autostart) && !exists(paths.dir),
      'Settings → About → Uninstall removes the program, the menu entry, the shortcut and the start at login, then the app quits');
    check(exists(path.join(userData, 'data', 'settings.json')), 'the settings are kept (not asked to delete them)');
  }

  // ---- 5. Uninstall in the setup window, settings too ----------------------------------------
  app = await launch(setupFile);
  win = await app.firstWindow();
  await win.waitForSelector('h1', { timeout: 30_000 });
  if ((await win.textContent('h1')) === 'Install OpenKaraoke') {
    await win.click('button.primary:has-text("Install")');
    await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 60_000 });
    await win.click('button:has-text("Close")').catch(() => {}); // (the setup quits: the click may not see its end)
    await closed(app);
    app = await launch(setupFile);
    win = await app.firstWindow();
    await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 30_000 });
  }
  // OpenKaraoke open meanwhile: the setup quits it on request before uninstalling.
  let running = await launch(paths.appImage);
  await (await running.firstWindow()).waitForURL(/\/host/, { timeout: 60_000 });
  await win.click('button:has-text("Uninstall OpenKaraoke…")');
  await win.waitForSelector('h1:has-text("Uninstall OpenKaraoke?")');
  await win.waitForSelector('button:has-text("Quit OpenKaraoke for me")', { timeout: 10_000 });
  check(await win.isDisabled('button.danger:has-text("Uninstall")'), 'with OpenKaraoke open, Uninstall waits — and offers to quit it');
  await shot(win, 'setup-5-running');
  const runningGone = running.waitForEvent('close', { timeout: 30_000 }).then(() => true, () => false);
  await win.click('button:has-text("Quit OpenKaraoke for me")');
  check(await runningGone, '“Quit OpenKaraoke for me” ends the open OpenKaraoke (the party saved)');
  running = null;
  await win.waitForSelector('button.danger:has-text("Uninstall"):not([disabled])', { timeout: 30_000 });
  await win.check('.check-row input[type="checkbox"]');
  await shot(win, 'setup-5-ask-uninstall');
  await win.click('button.danger:has-text("Uninstall")');
  await win.waitForSelector('h1:has-text("OpenKaraoke has been removed")', { timeout: 30_000 });
  check(!exists(paths.appImage) && !exists(paths.menuEntry) && !exists(userData), 'Uninstall in the setup window removes the app and, when ticked, what it saved (Trash or deleted)');
  await win.click('button:has-text("Close")').catch(() => {}); // (the setup quits: the click may not see its end)
  await closed(app);
  app = null;

  // ---- 6. The menu entry's "Uninstall OpenKaraoke" (--uninstall), with the app closed ---------
  app = await launch(setupFile);
  win = await app.firstWindow();
  await win.waitForSelector('h1:has-text("Install OpenKaraoke")', { timeout: 30_000 });
  await win.click('label.option:has-text("Put a shortcut on the desktop")'); // off this time
  await win.click('button.primary:has-text("Install")');
  await win.waitForSelector('h1:has-text("OpenKaraoke is installed")', { timeout: 60_000 });
  check(!exists(paths.shortcut), 'no desktop shortcut when it is switched off');
  await win.click('button:has-text("Close")').catch(() => {}); // (the setup quits: the click may not see its end)
  await closed(app);
  app = null;
  const asked = await new Promise((resolve) => {
    const env = { ...baseEnv, OPENKARAOKE_TEST_ANSWER: JSON.stringify({ response: 0, checkboxChecked: false }), ...(REAL ? {} : { APPIMAGE: paths.appImage }) };
    const child = REAL
      ? spawn(paths.appImage, ['--no-sandbox', '--uninstall'], { env, stdio: 'ignore' })
      : spawn(electronBin, ['--no-sandbox', DESKTOP, '--uninstall'], { env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  check(asked === 0 && !exists(paths.appImage) && !exists(paths.menuEntry), `the menu entry's Uninstall asks, removes it and ends (exit ${asked})`);

  // ---- 7. A release's own AppImage (OpenKaraoke-<version>.AppImage) starts as the app --------
  const releaseFile = await download('OpenKaraoke-9.9.9.AppImage');
  app = await launch(releaseFile);
  const direct = await app.firstWindow();
  await direct.waitForURL(/\/host/, { timeout: 60_000 }).catch(() => {});
  check(/\/host/.test(direct.url()), `a release's own AppImage file starts as the app, no setup (${direct.url().replace(/^http:\/\/[^/]+/, '')})`);
  await app.close();
  app = null;
} catch (e) {
  failed = true;
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  if (app) await app.close().catch(() => app.process()?.kill('SIGKILL'));
  xvfb?.kill();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(bad.length || failed ? 1 : 0);
