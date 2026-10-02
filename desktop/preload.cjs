// The only bridge between the host page and the desktop app (the page runs sandboxed, without
// Node): it can open the TV window and ask for a folder with the system's own dialog. The main
// process only answers pages of the app's own server.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('okDesktop', Object.freeze({
  /** Opens (or brings back) the TV window: { already, second, fullscreen }. */
  openTv: () => ipcRenderer.invoke('okd:open-tv'),
  /** The system's folder dialog: the chosen folder, or null. */
  pickFolder: () => ipcRenderer.invoke('okd:pick-folder'),
}));
