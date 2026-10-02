// The only bridge between the host page and the desktop app (the page runs sandboxed, without
// Node): it can open the TV window, ask for a folder with the system's own dialog, follow the
// app's updates and show its graphics report. The main process only answers pages of the app's
// own server.
const { contextBridge, ipcRenderer } = require('electron');

const update = (what, value) => ipcRenderer.invoke('okd:update', what, value);
const graphics = (what, value) => ipcRenderer.invoke('okd:graphics', what, value);

// The menu's "Check for updates…" shows Settings → About.
ipcRenderer.on('okd:show', (_event, hash) => {
  if (typeof hash === 'string' && /^#\/[\w/-]*$/.test(hash)) location.hash = hash;
});

contextBridge.exposeInMainWorld('okDesktop', Object.freeze({
  /** Opens (or brings back) the TV window: { already, second, fullscreen, wayland }. */
  openTv: () => ipcRenderer.invoke('okd:open-tv'),
  /** The system's folder dialog: the chosen folder, or null. */
  pickFolder: () => ipcRenderer.invoke('okd:pick-folder'),
  /**
   * Graphics (desktop/graphics.mjs): get() → { ok, report } (display system, hardware or software,
   * features, renderer, screens, frame rates); set({ backend, lighter }) → { ok, settings, restart };
   * restart() starts the app again on the chosen display system; gpuPage() opens chrome://gpu.
   */
  graphics: Object.freeze({
    get: () => graphics('get'),
    set: (patch) => graphics('set', { backend: patch?.backend, lighter: patch?.lighter }),
    restart: () => graphics('restart'),
    gpuPage: () => graphics('gpu-page'),
  }),
  /** Calls fn({ text, level }) when the app has something to tell (e.g. how to move the TV window). */
  onNotice: (fn) => {
    const listener = (_event, notice) => fn(notice);
    ipcRenderer.on('okd:notice', listener);
    return () => ipcRenderer.removeListener('okd:notice', listener);
  },
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
