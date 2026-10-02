// OpenKaraoke as a desktop app (Electron). The server runs inside the app (server/start.js,
// the same code as `node server/index.js`), the host controls are the main window and the TV
// display is a window of its own: full screen on the second screen when there is one, with
// sound and the PC's microphone (applause meter) allowed straight away. Guests' phones still
// join over the network with the QR code on the TV. Updates come from the repository's releases
// (desktop/updater.mjs).
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/start.js';
import { VERSION } from '../server/config.js';
import { logger, setLogSink } from '../server/util/log.js';
import { THEMES, DEFAULT_THEME } from '../shared/themes.js';
import { centredBounds, displayFor, nextDisplay, tvDisplay, visibleBounds } from './displays.mjs';
import { Updater } from './updater.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, 'build', 'icons', '512x512.png');
const PRELOAD = path.join(HERE, 'preload.cjs');
const REPO_NAME = 'blearymoth/OpenKaraoke';
const REPO = `https://github.com/${REPO_NAME}`;

// Test hooks (desktop/test/app.mjs): a separate profile, a folder instead of the folder dialog,
// a pretend set of screens (a virtual X server can't show two monitors), a stand-in for
// GitHub's API, and links to other sites noted in globalThis.okOpenedExternally instead of
// opened (a test machine's browser would start, and outlive the app).
const TEST_FOLDER = process.env.OPENKARAOKE_TEST_FOLDER || '';
const FAKE_DISPLAYS = process.env.OPENKARAOKE_FAKE_DISPLAYS ? JSON.parse(process.env.OPENKARAOKE_FAKE_DISPLAYS) : null;
const UPDATE_API = process.env.OPENKARAOKE_UPDATE_API || undefined;
const openExternal = process.env.OPENKARAOKE_TEST_EXTERNAL
  ? (url) => { (globalThis.okOpenedExternally ||= []).push(url); }
  : (url) => shell.openExternal(url);

app.setName('OpenKaraoke');
app.setPath('userData', process.env.OPENKARAOKE_USER_DATA || path.join(app.getPath('appData'), 'OpenKaraoke'));

/**
 * On a Wayland desktop (Fedora/GNOME, Ubuntu) apps can't place their own windows, so the TV
 * window couldn't go to the TV's screen by itself: the app restarts once through XWayland,
 * where it can. OPENKARAOKE_WAYLAND=1 keeps native Wayland.
 */
function wantsXWayland() {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland' && !!process.env.DISPLAY &&
    !process.env.OPENKARAOKE_WAYLAND && !process.argv.some((a) => a.startsWith('--ozone-platform'));
}

if (wantsXWayland()) {
  app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args: [...process.argv.slice(1), '--ozone-platform=x11'] });
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: that one comes to the front (second-instance below)
} else {
  run();
}

function run() {
  const log = logger('desktop');
  let server = null; // what startServer returned
  let base = '';
  let hostWin = null;
  let tvWin = null;
  let updater = null;
  let quitting = false;
  let stopped = false;
  let logFile = '';
  const dataDir = path.join(app.getPath('userData'), 'data');
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');

  // ---- small helpers ------------------------------------------------------------------------
  const ours = (url) => {
    try {
      return !!base && new URL(url).origin === base;
    } catch {
      return false;
    }
  };
  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  let stateTimer = null;
  const saveState = (patch) => {
    const next = { ...readState(), ...patch };
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => fsp.writeFile(stateFile, JSON.stringify(next)).catch(() => {}), 400);
  };
  const displays = () => (FAKE_DISPLAYS || screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea })));
  const primaryId = () => (FAKE_DISPLAYS ? FAKE_DISPLAYS[0].id : screen.getPrimaryDisplay().id);
  const hostDisplay = () => displayFor(displays(), hostWin && !hostWin.isDestroyed() ? hostWin.getBounds() : displays()[0].bounds);
  const themeColor = () => (THEMES[server?.app.settings.get('appearance.theme')] || THEMES[DEFAULT_THEME]).themeColor;

  function openLog() {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'openkaraoke.log');
    try {
      if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
    } catch { /* no log yet */ }
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    out.on('error', () => setLogSink(null));
    setLogSink((line) => out.write(line));
  }

  /** Keeps every window on the app's own pages: other links open in the normal browser. */
  function guard(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      if (ours(url) && new URL(url).pathname === '/tv') {
        openTv();
        return { action: 'deny' };
      }
      // The printable songbook and QR table card open in a window of their own.
      if (url === 'about:blank' || ours(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { contextIsolation: true, sandbox: true } } };
      }
      if (/^https?:\/\//i.test(url)) openExternal(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (win) => guard(win.webContents));
    contents.on('will-navigate', (e, url) => {
      if (ours(url)) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) openExternal(url);
    });
  }

  // ---- permissions: sound output and the microphone for the app's own pages only -------------
  function allowPermissions() {
    // No spell checking (the app needs none): Chromium would download dictionaries from Google.
    session.defaultSession.setSpellCheckerEnabled(false);
    const ALLOWED = new Set(['media', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const url = details?.requestingUrl || contents?.getURL() || '';
      const video = (details?.mediaTypes || []).includes('video');
      callback(ours(url) && ALLOWED.has(permission) && !(permission === 'media' && video));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => (
      ours(origin || details?.requestingUrl || '') && ALLOWED.has(permission) && !(permission === 'media' && details?.mediaType === 'video')
    ));
  }

  // ---- the host window ----------------------------------------------------------------------
  function createHostWindow() {
    const saved = readState().host || {};
    // Where it was last time, else centred on the primary screen (the TV gets another one).
    const primary = displays().find((d) => d.id === primaryId()) || displays()[0];
    const bounds = visibleBounds(displays(), saved.bounds) || centredBounds(primary, 1440, 900);
    hostWin = new BrowserWindow({
      ...bounds,
      minWidth: 400,
      minHeight: 480,
      show: false,
      title: 'OpenKaraoke',
      icon: ICON,
      backgroundColor: themeColor(),
      autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    if (saved.maximized) hostWin.maximize();
    guard(hostWin.webContents);
    hostWin.once('ready-to-show', () => hostWin.show());
    const remember = () => {
      if (!hostWin || hostWin.isDestroyed() || hostWin.isMinimized() || hostWin.isFullScreen()) return;
      saveState({ host: { bounds: hostWin.isMaximized() ? saved.bounds : hostWin.getBounds(), maximized: hostWin.isMaximized() } });
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) hostWin.on(ev, remember);
    hostWin.on('close', (e) => {
      if (quitting || !server?.app.room?.s.current) return;
      const choice = dialog.showMessageBoxSync(hostWin, {
        type: 'question',
        buttons: ['Quit', 'Keep singing'],
        defaultId: 1,
        cancelId: 1,
        title: 'Quit OpenKaraoke?',
        message: 'Quit OpenKaraoke?',
        detail: 'A song is on. Quitting stops the party: the TV, the music and the guests’ phones.',
      });
      if (choice !== 0) e.preventDefault();
    });
    hostWin.on('closed', () => {
      hostWin = null;
      app.quit(); // the TV window goes with it
    });
    hostWin.loadURL(`${base}/host`);
  }

  // ---- the TV window ------------------------------------------------------------------------
  function tvInfo(already) {
    const all = displays();
    const tvOn = displayFor(all, tvWin.getBounds());
    return { already, second: !!tvOn && tvOn.id !== hostDisplay()?.id, fullscreen: tvWin.isFullScreen() };
  }

  /** Puts the TV window on `display`: full screen there unless it is the host window's screen. */
  function placeTv(display) {
    if (!tvWin || !display) return;
    const full = display.id !== hostDisplay()?.id;
    const go = () => {
      if (!tvWin) return;
      tvWin.setBounds(full ? display.bounds : centredBounds(display));
      if (full) tvWin.setFullScreen(true);
    };
    if (tvWin.isFullScreen()) {
      tvWin.setFullScreen(false);
      setTimeout(go, 250); // the window manager first takes it out of full screen
    } else {
      go();
    }
  }

  function openTv() {
    if (tvWin) {
      if (tvWin.isMinimized()) tvWin.restore();
      tvWin.show();
      return tvInfo(true);
    }
    const all = displays();
    const host = hostDisplay();
    const target = tvDisplay(all, host.id, { primaryId: primaryId(), rememberedId: readState().tvDisplay });
    const bounds = target ? target.bounds : centredBounds(host);
    tvWin = new BrowserWindow({
      ...bounds,
      show: false,
      title: 'OpenKaraoke TV',
      icon: ICON,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      fullscreenable: true,
      // Sound without a click (no "click to start"), and no slowing down when it isn't focused.
      webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false },
    });
    tvWin.setMenu(null);
    guard(tvWin.webContents);
    tvWin.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        e.preventDefault();
        tvWin.setFullScreen(!tvWin.isFullScreen());
      }
    });
    tvWin.once('ready-to-show', () => {
      if (target) {
        tvWin.setFullScreen(true);
        tvWin.showInactive(); // the host keeps the keyboard
      } else {
        tvWin.show();
      }
    });
    const remember = () => {
      if (!tvWin) return;
      const on = displayFor(displays(), tvWin.getBounds());
      if (on && on.id !== hostDisplay()?.id) saveState({ tvDisplay: on.id });
    };
    tvWin.on('moved', remember);
    tvWin.on('enter-full-screen', remember);
    tvWin.on('closed', () => { tvWin = null; });
    tvWin.loadURL(`${base}/tv`);
    return { already: false, second: !!target, fullscreen: !!target };
  }

  function moveTvToNextScreen() {
    if (!tvWin) return openTv();
    const all = displays();
    const now = displayFor(all, tvWin.getBounds());
    placeTv(nextDisplay(all, now?.id));
    return tvInfo(true);
  }

  // A TV plugged in while the TV window waits on the host's screen: it moves there by itself.
  // The TV's screen unplugged: the window comes back as a normal window next to the host.
  function watchDisplays() {
    screen.on('display-added', (e, added) => {
      if (!tvWin || FAKE_DISPLAYS) return;
      const host = hostDisplay();
      const on = displayFor(displays(), tvWin.getBounds());
      if (added.id !== host?.id && on?.id === host?.id && !tvWin.isFullScreen()) placeTv(displays().find((d) => d.id === added.id));
    });
    screen.on('display-removed', () => {
      if (!tvWin || FAKE_DISPLAYS) return;
      const all = displays();
      const on = displayFor(all, tvWin.getBounds());
      if (!on || on.id === hostDisplay()?.id) {
        if (tvWin.isFullScreen()) tvWin.setFullScreen(false);
        setTimeout(() => tvWin?.setBounds(centredBounds(hostDisplay())), 250);
      }
    });
  }

  // ---- updates ------------------------------------------------------------------------------
  function startUpdater() {
    updater = new Updater({
      repo: REPO_NAME,
      version: VERSION,
      packaged: app.isPackaged,
      configFile: path.join(app.getPath('userData'), 'updates.json'),
      downloadDir: app.getPath('downloads'),
      // Node's fetch, not Electron's net.fetch: net.fetch would send a private repository's
      // token on to GitHub's file storage when a download is redirected there.
      fetch: globalThis.fetch,
      api: UPDATE_API,
      log: logger('updates'),
      openPath: (file) => shell.openPath(file),
    });
    updater.on('state', (state) => {
      if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send('okd:update-state', state);
    });
    updater.start();
  }

  /** After an update: the new version starts as soon as this one has saved the party and quit. */
  function restartForUpdate() {
    if (updater?.state.status !== 'ready') return false;
    if (server?.app.room?.s.current) {
      const choice = dialog.showMessageBoxSync(hostWin, {
        type: 'question',
        buttons: ['Restart', 'Not now'],
        defaultId: 1,
        cancelId: 1,
        title: 'Restart OpenKaraoke?',
        message: 'Restart OpenKaraoke now?',
        detail: 'A song is on: restarting stops it. The queue and the singers stay.',
      });
      if (choice !== 0) return false;
    }
    // The same command line (e.g. --no-sandbox), with the new AppImage or the updated package.
    app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args: process.argv.slice(1) });
    quitting = true;
    app.quit();
    return true;
  }

  function showUpdates() {
    if (!hostWin) return;
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.show();
    hostWin.webContents.send('okd:show', '#/settings/about');
    updater?.check();
  }

  // ---- menu ---------------------------------------------------------------------------------
  function buildMenu() {
    const about = () => dialog.showMessageBox(hostWin, {
      type: 'info',
      title: 'About OpenKaraoke',
      message: `OpenKaraoke ${VERSION}`,
      detail: `Karaoke parties with your own songs.\n\nHost page: http://localhost:${server.port}/host\nData folder: ${dataDir}\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node.js ${process.versions.node}\nMIT licence — ${REPO}`,
      icon: ICON,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: '&OpenKaraoke',
        submenu: [
          { label: 'Open TV window', accelerator: 'CmdOrCtrl+T', click: () => openTv() },
          { label: 'Move TV window to the next screen', accelerator: 'CmdOrCtrl+Shift+T', click: () => moveTvToNextScreen() },
          { label: 'Close TV window', click: () => tvWin?.close() },
          { type: 'separator' },
          { label: 'Copy the guests’ join link', click: () => clipboard.writeText(server.app.info().joinUrl) },
          { label: 'Open the host page in a browser', click: () => openExternal(`http://localhost:${server.port}/host`) },
          { type: 'separator' },
          { role: 'quit', label: 'Quit OpenKaraoke' },
        ],
      },
      {
        label: '&View',
        submenu: [
          { role: 'reload' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        ],
      },
      {
        label: '&Help',
        submenu: [
          { label: 'Open the data folder', click: () => shell.openPath(dataDir) },
          { label: 'Open the log file', click: () => shell.openPath(logFile) },
          { label: 'OpenKaraoke on GitHub', click: () => openExternal(REPO) },
          { label: 'Check for updates…', click: showUpdates },
          { type: 'separator' },
          { label: 'About OpenKaraoke', click: about },
        ],
      },
    ]));
  }

  // ---- talking to the host page (desktop/preload.cjs) ----------------------------------------
  function listen() {
    const fromUs = (event) => ours(event.senderFrame?.url || '');
    ipcMain.handle('okd:open-tv', (event) => {
      if (!fromUs(event)) throw new Error('Not allowed');
      return openTv();
    });
    ipcMain.handle('okd:pick-folder', async (event) => {
      if (!fromUs(event)) throw new Error('Not allowed');
      if (TEST_FOLDER) return TEST_FOLDER;
      // Start where USB drives are mounted (Fedora/Ubuntu: /run/media/<user> or /media/<user>).
      const user = os.userInfo().username;
      const start = [`/run/media/${user}`, `/media/${user}`, os.homedir()].find((p) => fs.existsSync(p));
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || hostWin, {
        title: 'Choose your karaoke folder',
        buttonLabel: 'Use this folder',
        defaultPath: start,
        properties: ['openDirectory'],
      });
      return r.canceled ? null : r.filePaths[0] || null;
    });
    ipcMain.handle('okd:update', async (event, what, value) => {
      if (!fromUs(event)) throw new Error('Not allowed');
      if (!updater) return { ok: false, error: 'Updates aren’t ready yet.' };
      try {
        if (what === 'get') return { ok: true, state: updater.publicState() };
        if (what === 'check') return { ok: true, state: await updater.check() };
        if (what === 'install') return { ok: true, state: await updater.install() };
        if (what === 'auto') return { ok: true, state: await updater.setAutoCheck(value === true) };
        if (what === 'token') return { ok: true, state: await updater.setToken(typeof value === 'string' ? value : '') };
        if (what === 'restart') return { ok: restartForUpdate(), state: updater.publicState() };
        return { ok: false, error: 'Unknown request' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }

  // ---- start and stop -----------------------------------------------------------------------
  app.on('second-instance', () => {
    if (!hostWin) return;
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.show();
    hostWin.focus();
  });

  app.on('before-quit', (e) => {
    quitting = true;
    updater?.stop();
    if (stopped || !server) return;
    e.preventDefault();
    stopped = true;
    // Saves the party (queue, settings, library index) before the app goes away.
    Promise.race([server.close(), new Promise((r) => setTimeout(r, 8000))])
      .catch((err) => log.error('error while saving', err))
      .finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  // Logging out or shutting down (SIGTERM), Ctrl+C in a terminal, the terminal closing: like Quit.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => app.quit());

  app.whenReady().then(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    openLog();
    log.info(`OpenKaraoke ${VERSION} (desktop), data in ${dataDir}`);
    try {
      // No --port here: the port in Settings (6527 at first), or the next free one.
      server = await startServer({ dataDir, args: {}, env: {}, log });
    } catch (e) {
      log.error('could not start', e);
      dialog.showErrorBox('OpenKaraoke could not start', `${e.message}\n\nThe log file is ${logFile}.`);
      app.exit(1);
      return;
    }
    base = `http://127.0.0.1:${server.port}`;
    log.info(`server on port ${server.port}${server.moved ? ` (${server.wanted} is used by another program)` : ''}`);
    allowPermissions();
    listen();
    buildMenu();
    createHostWindow();
    watchDisplays();
    startUpdater();
  }).catch((e) => {
    log.error('desktop start failed', e);
    app.exit(1);
  });
}
