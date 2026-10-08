// The setup window: what "Install OpenKaraoke" (the AppImage inside OpenKaraoke-Setup.zip) shows
// when it isn't the installed copy — Install (or Update, Repair), Start OpenKaraoke, Run it
// without installing, Uninstall. It runs beside an OpenKaraoke that may be open, so it uses a
// throwaway browser profile, starts no server and serves its page itself (okapp://app: the
// page in desktop/setup/, the styles, fonts and scripts from public/ and shared/). The file work
// is desktop/install.mjs.
import { app, BrowserWindow, Menu, ipcMain, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, normalizeTheme } from '../shared/themes.js';
import { install, launchEnv, readInstall, rememberPortable, runningServer, setupFile, startsAtLogin, uninstall } from './install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'okapp';
const ORIGIN = `${SCHEME}://app`;
/** Where the .deb and .rpm put the app (a copy installed for everyone). */
export const SYSTEM_COPY = '/opt/OpenKaraoke/openkaraoke';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** Before the app is ready: the page's own scheme, and a throwaway profile. */
export function prepareSetup() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openkaraoke-setup-'));
  app.setPath('userData', profile);
  app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
}

/** Runs a helper program (gio, update-desktop-database) when there is one; never fails. */
function run(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** Starts another program on its own (it outlives the setup), outside this AppImage's environment. */
export function startDetached(command) {
  const extra = process.env.OPENKARAOKE_TEST_LAUNCH_ARGS ? JSON.parse(process.env.OPENKARAOKE_TEST_LAUNCH_ARGS) : [];
  const child = spawn(command[0], [...command.slice(1), ...extra], { detached: true, stdio: 'ignore', cwd: os.homedir(), env: launchEnv(process.env) });
  child.on('error', () => {});
  child.unref();
}

/** A problem as the person reads it. */
function friendly(e, paths) {
  if (e?.code === 'ENOSPC') return 'There isn’t enough free space on this computer: OpenKaraoke needs about 300 MB.';
  if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') return `OpenKaraoke can’t write to ${path.dirname(e.path || paths.dir)} (no permission there).`;
  return e?.message || String(e);
}

/**
 * Shows the setup window. `from` the AppImage this runs from, `paths` from installPaths(),
 * `userData` the app's real profile (~/.config/OpenKaraoke: its settings, whether it runs),
 * `icon` the app's icon file.
 */
export function runSetup({ from, paths, userData, version, icon, log = console }) {
  let win = null;
  const trash = (dir) => run('gio', ['trash', '--', dir]);
  const tilde = (p) => (p.startsWith(`${os.homedir()}/`) ? `~/${p.slice(os.homedir().length + 1)}` : p);
  const theme = () => {
    try {
      return normalizeTheme(JSON.parse(fs.readFileSync(path.join(userData, 'data', 'settings.json'), 'utf8'))?.appearance?.theme);
    } catch {
      return normalizeTheme();
    }
  };

  async function info() {
    const size = (() => {
      try {
        return fs.statSync(from).size;
      } catch {
        return 0;
      }
    })();
    return {
      version,
      user: os.userInfo().username,
      dir: tilde(paths.dir),
      sizeMb: Math.max(10, Math.round(size / 1e7) * 10),
      fromName: path.basename(from || ''),
      installed: await readInstall(paths),
      system: fs.existsSync(SYSTEM_COPY),
      running: !!runningServer(path.join(userData, 'data')),
      atLogin: startsAtLogin(paths),
      theme: theme(),
    };
  }

  const quitSoon = () => setTimeout(() => app.quit(), 400);

  function listen() {
    const fromPage = (event) => {
      if (!String(event.senderFrame?.url || '').startsWith(`${ORIGIN}/`)) throw new Error('Not allowed');
    };
    ipcMain.handle('oks:info', (event) => {
      fromPage(event);
      return info();
    });
    ipcMain.handle('oks:install', async (event, o) => {
      fromPage(event);
      try {
        await install({
          from, paths, iconFrom: icon, version, shortcut: o?.shortcut === true, atLogin: o?.atLogin === true, run,
          progress: (f) => { if (win && !win.isDestroyed()) win.webContents.send('oks:progress', f); },
        });
        log.info?.(`installed ${version} in ${paths.dir}`);
        return { ok: true };
      } catch (e) {
        log.error?.('install failed', e);
        return { ok: false, error: friendly(e, paths) };
      }
    });
    ipcMain.handle('oks:launch', (event, which) => {
      fromPage(event);
      const program = which === 'system' ? SYSTEM_COPY : paths.appImage;
      if (!fs.existsSync(program)) return { ok: false, error: 'OpenKaraoke isn’t installed there any more: install it again.' };
      startDetached([program]);
      quitSoon();
      return { ok: true };
    });
    ipcMain.handle('oks:run-here', (event) => {
      fromPage(event);
      try {
        rememberPortable(userData, from);
      } catch (e) {
        log.warn?.('could not remember the choice', e);
      }
      startDetached([from, '--no-setup']);
      quitSoon();
      return { ok: true };
    });
    ipcMain.handle('oks:uninstall', async (event, o) => {
      fromPage(event);
      if (runningServer(path.join(userData, 'data'))) return { ok: false, error: 'OpenKaraoke is open: quit it first (OpenKaraoke → Quit), then try again.' };
      try {
        await uninstall({ paths, removeData: o?.removeData === true, userData, run, trash });
        log.info?.(`uninstalled from ${paths.dir}${o?.removeData === true ? ' (and the settings)' : ''}`);
        return { ok: true };
      } catch (e) {
        log.error?.('uninstall failed', e);
        return { ok: false, error: friendly(e, paths) };
      }
    });
    // "Quit it for me": the open OpenKaraoke saves the party and quits (it treats SIGTERM as Quit).
    ipcMain.handle('oks:quit-running', async (event) => {
      fromPage(event);
      const running = runningServer(path.join(userData, 'data'));
      if (running) {
        try {
          process.kill(running.pid, 'SIGTERM');
        } catch { /* gone already */ }
        for (let i = 0; i < 100 && runningServer(path.join(userData, 'data')); i++) await new Promise((r) => setTimeout(r, 200));
      }
      return info();
    });
    ipcMain.handle('oks:close', (event) => {
      fromPage(event);
      app.quit();
    });
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 700,
      height: 700,
      minWidth: 460,
      minHeight: 520,
      show: false,
      title: 'OpenKaraoke Setup',
      icon,
      backgroundColor: THEMES[theme()].themeColor,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(HERE, 'setup', 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault(); });
    let shown = false;
    const show = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      win.show();
    };
    // Native Wayland never paints a hidden window ('ready-to-show' doesn't come): the page having
    // loaded shows it too, and 3 s at most.
    win.once('ready-to-show', show);
    win.webContents.once('did-finish-load', show);
    setTimeout(show, 3000).unref?.();
    win.on('closed', () => { win = null; });
    win.loadURL(`${ORIGIN}/setup/index.html`);
  }

  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    protocol.handle(SCHEME, async (request) => {
      const url = new URL(request.url);
      const file = url.host === 'app' ? setupFile(url.pathname) : null;
      if (!file) return new Response('Not found', { status: 404 });
      try {
        return new Response(await fsp.readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    Menu.setApplicationMenu(null);
    listen();
    createWindow();
  });
}
