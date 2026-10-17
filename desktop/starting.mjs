// The window the app shows while it starts: the server starting, a big library loading and the
// host page take seconds (the AppImage, Electron and a slow disk add more), and without it nothing
// on screen says OpenKaraoke has been opened. The app's icon, its name and what it is doing, in
// the skin of the last party; it closes when the host window shows. Its page is desktop/starting/,
// served through okapp://app like the setup window's (desktop/setup.mjs).
import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, normalizeTheme } from '../shared/themes.js';
import { ORIGIN, serveAppScheme } from './setup.mjs';

/** The skin of the last party (data/settings.json), read before the server starts. */
export function savedTheme(dataDir) {
  try {
    return normalizeTheme(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))?.appearance?.theme);
  } catch {
    return normalizeTheme();
  }
}

/**
 * Opens the window and resolves once it is on screen (1.5 s at most), so the server's start, which
 * keeps this thread busy now and then, doesn't hold its first paint back.
 * @returns {Promise<{ status: (text: string) => void, close: () => void, window: BrowserWindow | null }>}
 */
export async function openStarting({ dataDir, icon }) {
  serveAppScheme();
  const theme = savedTheme(dataDir);
  const win = new BrowserWindow({
    width: 360,
    height: 260,
    center: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'OpenKaraoke',
    icon,
    backgroundColor: THEMES[theme].themeColor,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.setMenu(null);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let closed = false;
  win.on('closed', () => { closed = true; });
  // Native Wayland never paints a hidden window ('ready-to-show' doesn't come): the page having
  // loaded shows it too, and 1.5 s at most.
  await new Promise((resolve) => {
    const show = () => {
      if (!closed && !win.isVisible()) win.show();
      resolve();
    };
    win.once('ready-to-show', show);
    win.webContents.once('did-finish-load', show);
    setTimeout(show, 1500).unref?.();
    win.loadURL(`${ORIGIN}/starting/index.html?theme=${theme}`).catch(show);
  });
  return {
    status(text) {
      if (!closed) win.webContents.executeJavaScript(`window.setStatus?.(${JSON.stringify(String(text))})`).catch(() => {});
    },
    close() {
      if (!closed) win.destroy();
      closed = true;
    },
    get window() {
      return closed ? null : win;
    },
  };
}
