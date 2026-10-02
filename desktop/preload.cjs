// The only bridge between the host page and the desktop app (the page runs sandboxed, without
// Node): it can open the TV window, ask for a folder with the system's own dialog and follow the
// app's updates. The main process only answers pages of the app's own server.
const { contextBridge, ipcRenderer } = require('electron');

const update = (what, value) => ipcRenderer.invoke('okd:update', what, value);

// The menu's "Check for updates…" shows Settings → About.
ipcRenderer.on('okd:show', (_event, hash) => {
  if (typeof hash === 'string' && /^#\/[\w/-]*$/.test(hash)) location.hash = hash;
});

contextBridge.exposeInMainWorld('okDesktop', Object.freeze({
  /** Opens (or brings back) the TV window: { already, second, fullscreen }. */
  openTv: () => ipcRenderer.invoke('okd:open-tv'),
  /** The system's folder dialog: the chosen folder, or null. */
  pickFolder: () => ipcRenderer.invoke('okd:pick-folder'),
  /**
   * Updates (desktop/updater.mjs). Each call resolves to { ok, state } or { ok: false, error };
   * state = { status, version, latest, progress, error, kind, autoCheck, hasToken, needsToken, … }.
   */
  updates: Object.freeze({
    get: () => update('get'),
    check: () => update('check'),
    install: () => update('install'),
    restart: () => update('restart'),
    setAutoCheck: (on) => update('auto', !!on),
    setToken: (token) => update('token', String(token ?? '')),
    /** Calls fn(state) on every change; returns the function that stops it. */
    onChange: (fn) => {
      const listener = (_event, state) => fn(state);
      ipcRenderer.on('okd:update-state', listener);
      return () => ipcRenderer.removeListener('okd:update-state', listener);
    },
  }),
}));
