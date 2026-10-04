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
import { chooseBackend, displaySettings, gpuInfoProblem, gpuVerdict, graphicsLine, useLighterEffects, BACKENDS, LIGHTER } from './graphics.mjs';
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
 * The display system (desktop/graphics.mjs): on a Wayland desktop (Ubuntu, Fedora/GNOME) the app
 * runs natively, like Chrome — XWayland, which lets the app place the TV window by itself but
 * draws slowly on some PCs, is a choice in Settings → About (userData/display.json), started
 * through a restart with --ozone-platform=x11.
 */
const DISPLAY_FILE = path.join(app.getPath('userData'), 'display.json');
function readDisplaySettings() {
  try {
    return displaySettings(JSON.parse(fs.readFileSync(DISPLAY_FILE, 'utf8')));
  } catch {
    return displaySettings();
  }
}
const BACKEND = chooseBackend({ platform: process.platform, env: process.env, argv: process.argv, saved: readDisplaySettings() });
const WAYLAND = BACKEND.kind === 'wayland'; // the TV window can't be placed by the app

if (BACKEND.relaunchX11) {
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
  let tvBase = ''; // the TV's own origin (its own zoom level and storage): http://tv.localhost:<port>
  let hostWin = null;
  let tvWin = null;
  let updater = null;
  let quitting = false;
  let saving = null; // the party being saved on the way out
  let saved = false;
  let logFile = '';
  const dataDir = path.join(app.getPath('userData'), 'data');
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');

  // ---- small helpers ------------------------------------------------------------------------
  const ours = (url) => {
    try {
      const { origin } = new URL(url);
      return !!base && (origin === base || origin === tvBase);
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
  const displays = () => (FAKE_DISPLAYS ? FAKE_DISPLAYS.map((d) => ({ ...d, label: d.label || '' })) : screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label || '', bounds: d.bounds, workArea: d.workArea })));
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

  /**
   * Calls `show` once the window has something to show. 'ready-to-show' alone isn't enough: on
   * native Wayland a hidden window never paints, so it never comes — there the page having
   * loaded shows it, and anywhere 3 s at most.
   */
  function whenReady(win, show) {
    let done = false;
    const once = () => {
      if (done || win.isDestroyed()) return;
      done = true;
      show();
    };
    win.once('ready-to-show', once);
    if (WAYLAND) win.webContents.once('did-finish-load', once);
    setTimeout(once, 3000).unref?.();
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

  // ---- graphics: hardware or software, lighter effects, the report in Settings → About ---------
  const gfx = { features: null, ready: false, renderer: '', crashes: [], lighter: false, logged: false };

  /** Asks a page of ours what it sees (WebGL renderer, frame rate, …); null when it can't answer. */
  function ask(win, code, ms = 3000) {
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return Promise.resolve(null);
    return Promise.race([win.webContents.executeJavaScript(code, true).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);
  }
  const RENDERER_JS = `(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  })()`;
  const FRAMES_JS = `new Promise((done) => {
    let n = 0;
    const t0 = performance.now();
    const step = () => {
      n++;
      const t = performance.now() - t0;
      if (t < 1000) requestAnimationFrame(step);
      else done({ fps: Math.round((n * 1000) / t), dpr: devicePixelRatio, width: innerWidth, height: innerHeight });
    };
    requestAnimationFrame(step);
  })`;

  function verdict() {
    return gpuVerdict({ features: gfx.features, renderer: gfx.renderer, ready: gfx.ready });
  }

  /**
   * Lighter effects (CSS under .lite-fx) on the app's own windows, when chosen or when the PC draws
   * in software. data-lighter carries this PC's choice: 'off' keeps the TV page's own automatic
   * lighter effects (public/js/tv/lighter.js) away too.
   */
  function applyLighter(win) {
    if (!win || win.isDestroyed() || !ours(win.webContents.getURL())) return;
    const choice = JSON.stringify(readDisplaySettings().lighter);
    win.webContents.executeJavaScript(`document.documentElement.classList.toggle('lite-fx', ${gfx.lighter}); document.documentElement.dataset.lighter = ${choice};`).catch(() => {});
  }
  function updateGraphics() {
    gfx.lighter = useLighterEffects(readDisplaySettings().lighter, verdict());
    for (const w of BrowserWindow.getAllWindows()) applyLighter(w);
    if (!gfx.logged && gfx.ready && (gfx.renderer || gfx.rendererTried)) {
      gfx.logged = true;
      log.info(`graphics: ${graphicsLine({ ...gfx, kind: BACKEND.kind, ozone: app.commandLine.getSwitchValue('ozone-platform'), session: process.env.XDG_SESSION_TYPE })}`);
    }
  }
  app.on('gpu-info-update', () => {
    gfx.features = app.getGPUFeatureStatus();
    gfx.ready = true;
    updateGraphics();
  });
  app.on('child-process-gone', (e, d) => {
    if (d.type !== 'GPU') return;
    gfx.crashes.push({ reason: d.reason, exitCode: d.exitCode, at: Date.now() });
    log.warn(`the graphics process stopped (${d.reason}, exit ${d.exitCode})`);
  });

  async function graphicsReport() {
    if (!gfx.ready) {
      gfx.features = app.getGPUFeatureStatus();
      gfx.ready = true;
    }
    let devices = [];
    let gpuProblem = '';
    try {
      const info = await app.getGPUInfo('basic');
      devices = (info?.gpuDevice || []).map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: !!d.active, driverVendor: d.driverVendor || '', driverVersion: d.driverVersion || '' }));
    } catch (e) {
      gpuProblem = gpuInfoProblem(e?.message || e);
    }
    const [host, tv] = await Promise.all([ask(hostWin, FRAMES_JS), ask(tvWin, FRAMES_JS)]);
    const primary = screen.getPrimaryDisplay().id;
    const f = gfx.features || {};
    return {
      kind: BACKEND.kind,
      why: BACKEND.why,
      ozone: app.commandLine.getSwitchValue('ozone-platform') || '',
      session: process.env.XDG_SESSION_TYPE || '',
      desktop: process.env.XDG_CURRENT_DESKTOP || '',
      settings: readDisplaySettings(),
      choices: { backend: BACKENDS, lighter: LIGHTER },
      canChooseBackend: BACKEND.kind === 'wayland' || BACKEND.kind === 'xwayland',
      verdict: verdict(),
      lighter: gfx.lighter,
      features: Object.fromEntries(['gpu_compositing', 'rasterization', '2d_canvas', 'webgl', 'video_decode', 'opengl', 'vulkan'].map((k) => [k, f[k] || ''])),
      renderer: gfx.renderer,
      devices,
      gpuProblem,
      crashes: gfx.crashes.length,
      displays: screen.getAllDisplays().map((d) => ({ width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor, hz: Math.round(d.displayFrequency || 0), primary: d.id === primary })),
      windows: {
        host: host && { ...host, zoom: hostWin.webContents.getZoomFactor() },
        tv: tv && { ...tv, zoom: tvWin.webContents.getZoomFactor(), fullscreen: tvWin.isFullScreen() },
      },
      versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    };
  }

  /** chrome://gpu in a window of its own (everything Chromium knows about the graphics). */
  function openGpuPage() {
    const win = new BrowserWindow({ width: 1000, height: 800, title: 'Graphics — OpenKaraoke', icon: ICON, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('chrome://gpu')) e.preventDefault(); });
    win.loadURL('chrome://gpu');
  }

  /** Saves a display choice; a new display system needs a restart (the page offers it). */
  function setDisplay(patch) {
    const next = displaySettings({ ...readDisplaySettings(), ...patch });
    fs.writeFileSync(DISPLAY_FILE, JSON.stringify(next));
    updateGraphics();
    const wantX11 = next.backend === 'x11';
    return { settings: next, restart: (BACKEND.kind === 'xwayland') !== wantX11 && (BACKEND.kind === 'wayland' || BACKEND.kind === 'xwayland') };
  }

  /** Restarts the app on the chosen display system (asks first while a song is on). */
  function restartForDisplay() {
    if (server?.app.room?.s.current) {
      const choice = dialog.showMessageBoxSync(hostWin, {
        type: 'question', buttons: ['Restart', 'Not now'], defaultId: 1, cancelId: 1,
        title: 'Restart OpenKaraoke?', message: 'Restart OpenKaraoke now?',
        detail: 'A song is on: restarting stops it. The queue and the singers stay.',
      });
      if (choice !== 0) return false;
    }
    const args = process.argv.slice(1).filter((a) => !a.startsWith('--ozone-platform'));
    if (readDisplaySettings().backend === 'x11' && process.env.DISPLAY) args.push('--ozone-platform=x11');
    app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args });
    quitting = true;
    app.quit();
    return true;
  }

  /** A message for the host page (shown as a toast). */
  function tellHost(text, level = 'info') {
    if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send('okd:notice', { text, level });
  }

  /**
   * Native Wayland: the app can't put the TV window on the TV, and doesn't learn where its windows
   * are (positions and the page's screen stay as they were). One thing does show a move: GNOME
   * resizes a maximized window to the work area of the screen it is moved to (Super+Shift+→, a
   * drag). The TV window opens maximized; when it is resized like that, it goes full screen —
   * full screen lands on the screen it is on. (Same-sized work areas show nothing: F11.)
   */
  function watchTvMove(win) {
    let settled = null; // its size once maximized and still
    let timer = null;
    const size = () => {
      const b = win.getBounds();
      return `${b.width}x${b.height}`;
    };
    const settle = () => {
      clearTimeout(timer);
      settled = null;
      timer = setTimeout(() => { if (!win.isDestroyed() && win.isMaximized() && !win.isFullScreen()) settled = size(); }, 1200);
    };
    const placed = (on) => win.webContents.executeJavaScript(`document.documentElement.classList.toggle('tv-placed', ${on})`).catch(() => {});
    win.on('maximize', settle);
    win.on('resize', () => {
      if (settled === null || win.isFullScreen() || !win.isMaximized() || size() === settled) return;
      settled = null;
      win.setFullScreen(true);
      tellHost('The TV window is full screen on the TV now.', 'ok');
    });
    win.on('enter-full-screen', () => {
      clearTimeout(timer);
      settled = null;
      placed(true);
    });
    win.on('leave-full-screen', () => {
      placed(false);
      settle();
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
    whenReady(hostWin, () => hostWin.show());
    hostWin.webContents.on('dom-ready', () => applyLighter(hostWin));
    // What draws the pages: the WebGL renderer's name tells a graphics card from software.
    hostWin.webContents.once('did-finish-load', () => {
      ask(hostWin, RENDERER_JS).then((name) => {
        gfx.renderer = String(name || '');
        gfx.rendererTried = true;
        updateGraphics();
      });
    });
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
      closeOtherWindows(); // the TV (and a songbook or table card) at once: saving the party can take seconds
      app.quit();
    });
    hostWin.loadURL(`${base}/host`);
  }

  // ---- the TV window ------------------------------------------------------------------------
  function tvInfo(already) {
    if (WAYLAND) return { already, second: tvWin.isFullScreen(), fullscreen: tvWin.isFullScreen(), wayland: true };
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
    // Native Wayland: windows go where the compositor puts them (the screen under the mouse).
    const target = WAYLAND ? null : tvDisplay(all, host.id, { primaryId: primaryId(), rememberedId: readState().tvDisplay });
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
    tvWin.webContents.on('dom-ready', () => applyLighter(tvWin));
    tvWin.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        e.preventDefault();
        tvWin.setFullScreen(!tvWin.isFullScreen());
      }
    });
    const shown = tvWin;
    whenReady(tvWin, () => {
      if (tvWin !== shown) return;
      if (target) {
        // Shown first (already on the TV's screen), then full screen: an X11 window asked for full
        // screen before it is mapped sometimes stays a window.
        tvWin.once('show', () => setTimeout(() => tvWin?.setFullScreen(true), 300));
        tvWin.showInactive(); // the host keeps the keyboard
      } else if (WAYLAND) {
        tvWin.maximize(); // see watchTvMove()
        tvWin.show();
      } else {
        tvWin.show();
      }
    });
    const remember = () => {
      if (!tvWin || WAYLAND) return; // (Wayland: the app doesn't know where its windows are)
      const on = displayFor(displays(), tvWin.getBounds());
      if (on && on.id !== hostDisplay()?.id) saveState({ tvDisplay: on.id });
    };
    tvWin.on('moved', remember);
    tvWin.on('enter-full-screen', remember);
    for (const ev of ['moved', 'enter-full-screen', 'leave-full-screen', 'show']) tvWin.on(ev, emitTv);
    tvWin.on('closed', () => {
      tvWin = null;
      emitTv();
    });
    if (WAYLAND) watchTvMove(tvWin);
    // Its own origin: zooming the host window (Ctrl +/−, kept per origin) never zooms the TV.
    tvWin.loadURL(`${tvBase}/tv${WAYLAND ? '?place=wayland' : ''}`);
    emitTv();
    return { already: false, second: !!target, fullscreen: !!target, wayland: WAYLAND };
  }

  /** The TV window for the host's Playback tab (okDesktop.tv). */
  function tvState() {
    const all = displays();
    const host = hostDisplay();
    return {
      open: !!tvWin,
      fullscreen: !!tvWin?.isFullScreen(),
      // Native Wayland: the app doesn't know where its windows are, nor can it move them.
      screenId: tvWin && !WAYLAND ? displayFor(all, tvWin.getBounds())?.id ?? null : null,
      placeable: !WAYLAND,
      screens: all.map((d, i) => ({ id: d.id, name: d.label || `Screen ${i + 1}`, size: `${d.bounds.width} × ${d.bounds.height}`, primary: d.id === primaryId(), host: d.id === host?.id })),
    };
  }

  function emitTv() {
    if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send('okd:tv-state', tvState());
  }

  /** Takes the TV window and any other window but the host's away now (closing, quitting). */
  function closeOtherWindows() {
    for (const w of BrowserWindow.getAllWindows()) if (w !== hostWin && !w.isDestroyed()) w.destroy();
    tvWin = null;
  }

  function moveTvToNextScreen() {
    if (!tvWin) return openTv();
    if (WAYLAND) {
      if (tvWin.isFullScreen()) tvWin.setFullScreen(false);
      tvWin.focus();
      tellHost('Wayland doesn’t let apps move their windows: with the TV window in front, press Super+Shift+→ (or ←), or drag it — it goes full screen on the other screen by itself.', 'info');
      return tvInfo(true);
    }
    const all = displays();
    const now = displayFor(all, tvWin.getBounds());
    placeTv(nextDisplay(all, now?.id));
    return tvInfo(true);
  }

  // A TV plugged in while the TV window waits on the host's screen: it moves there by itself.
  // The TV's screen unplugged: the window comes back as a normal window next to the host.
  function watchDisplays() {
    screen.on('display-added', () => emitTv());
    screen.on('display-removed', () => emitTv());
    if (WAYLAND) return; // the compositor moves windows off a screen that goes away by itself
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
          { label: 'Graphics details (chrome://gpu)', click: () => openGpuPage() },
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
    ipcMain.handle('okd:tv', (event, what, value) => {
      if (!fromUs(event)) throw new Error('Not allowed');
      if (what === 'get') { /* just the state */ }
      else if (what === 'open') openTv();
      else if (what === 'close') tvWin?.close();
      else if (what === 'fullscreen') {
        if (typeof value !== 'boolean') throw new Error('Not allowed');
        tvWin?.setFullScreen(value);
      } else if (what === 'place') {
        const d = Number.isSafeInteger(value) ? displays().find((x) => x.id === value) : null;
        if (!d) throw new Error('Not allowed');
        if (!tvWin) throw new Error('Open the TV window first.');
        if (WAYLAND) throw new Error('On Wayland, move the TV window yourself: Super+Shift+→ or drag it there.');
        placeTv(d);
      } else {
        throw new Error('Not allowed');
      }
      return tvState();
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
    ipcMain.handle('okd:graphics', async (event, what, value) => {
      if (!fromUs(event)) throw new Error('Not allowed');
      try {
        if (what === 'get') return { ok: true, report: await graphicsReport() };
        if (what === 'set') {
          const patch = {};
          if (BACKENDS.includes(value?.backend)) patch.backend = value.backend;
          if (LIGHTER.includes(value?.lighter)) patch.lighter = value.lighter;
          return { ok: true, ...setDisplay(patch) };
        }
        if (what === 'restart') return { ok: restartForDisplay() };
        if (what === 'gpu-page') {
          openGpuPage();
          return { ok: true };
        }
        return { ok: false, error: 'Unknown request' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
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
    if (saved || !server) return;
    // Every quit waits for the save: a second request while saving (the last window closing,
    // a signal) must not end the app halfway through it.
    e.preventDefault();
    if (saving) return;
    // The TV goes first, so it doesn't linger (or play on) while the party is saved. The host
    // window stays until the end: it is the app.
    closeOtherWindows();
    // Saves the party (queue, settings, library index) before the app goes away.
    saving = Promise.race([server.close(), new Promise((r) => setTimeout(r, 8000))])
      .catch((err) => log.error('error while saving', err))
      .finally(() => {
        saved = true;
        app.quit();
      });
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
    tvBase = `http://tv.localhost:${server.port}`;
    log.info(`server on port ${server.port}${server.moved ? ` (${server.wanted} is used by another program)` : ''}`);
    allowPermissions();
    listen();
    buildMenu();
    createHostWindow();
    watchDisplays();
    startUpdater();
    log.info(`display system: ${BACKEND.kind} (${BACKEND.why})`);
    // The graphics status comes with the GPU process's first report; without one, read it anyway.
    setTimeout(() => {
      if (gfx.ready) return;
      gfx.features = app.getGPUFeatureStatus();
      gfx.ready = true;
      updateGraphics();
    }, 5000).unref?.();
  }).catch((e) => {
    log.error('desktop start failed', e);
    app.exit(1);
  });
}
