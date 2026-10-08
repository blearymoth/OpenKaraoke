// The setup window's only bridge to the installer (desktop/setup.mjs). The page runs sandboxed;
// the main process answers its own setup page only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('okSetup', Object.freeze({
  /** { version, user, dir, sizeMb, fromName, installed: { version, shortcut } | null, system, running, atLogin, theme } */
  info: () => ipcRenderer.invoke('oks:info'),
  /** Installs (or updates, repairs) the copy for this person: { ok } or { ok: false, error }. */
  install: (options) => ipcRenderer.invoke('oks:install', { shortcut: !!options?.shortcut, atLogin: !!options?.atLogin }),
  /** Starts the installed copy ('installed') or the system package's ('system'), and closes the setup. */
  launch: (which) => ipcRenderer.invoke('oks:launch', which === 'system' ? 'system' : 'installed'),
  /** Runs this file as the app, without installing (not asked again for this file). */
  runHere: () => ipcRenderer.invoke('oks:run-here'),
  /** Removes the installed copy; with removeData also the settings, song index and pictures. */
  uninstall: (options) => ipcRenderer.invoke('oks:uninstall', { removeData: !!options?.removeData }),
  /** Asks the open OpenKaraoke to save the party and quit; resolves to the new info(). */
  quitRunning: () => ipcRenderer.invoke('oks:quit-running'),
  close: () => ipcRenderer.invoke('oks:close'),
  /** Calls fn(fraction) while the copy is made; returns the function that stops it. */
  onProgress: (fn) => {
    const listener = (_event, fraction) => fn(fraction);
    ipcRenderer.on('oks:progress', listener);
    return () => ipcRenderer.removeListener('oks:progress', listener);
  },
}));
