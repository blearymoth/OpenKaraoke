// Host app state: one WebSocket connection + a store with the host view from the server.
import { Connection } from '../lib/ws-client.js';
import { createStore, toastStore, noteArt, setMarks } from '../lib/store.js';
import { apiPost, clearFetchCache } from '../lib/components.js';
import { applyAppearance } from '../lib/theme.js';

export const toasts = toastStore();
export const toast = toasts.show;

export const store = createStore({
  status: 'connecting',
  state: null,
  denied: null,
  time: null, // latest { entryId, pos, dur, playing, at } from the TV, with local receive time
  lib: null, // scan progress
  artwork: null, // artwork crawler / provider status (Settings → Artwork)
  dialog: null,
});

export const conn = new Connection({
  hello: () => ({ role: 'host', token: localStorage.getItem('ok.hostToken') || undefined }),
});

let lastLibVersion = null;
conn.on('welcome', (m) => {
  applyAppearance(m.state.settings?.appearance);
  setMarks(m.state);
  store.update({ state: m.state, denied: null });
});
conn.on('state', (m) => {
  const v = m.state.library?.builtAt;
  if (lastLibVersion !== null && v !== lastLibVersion) clearFetchCache();
  lastLibVersion = v;
  applyAppearance(m.state.settings?.appearance);
  setMarks(m.state);
  store.update({ state: m.state });
});
conn.on('time', (m) => store.update({ time: { ...m, recv: performance.now() } }));
conn.on('lib', (m) => {
  if (m.progress) store.update({ lib: m.progress });
});
conn.on('art', (m) => noteArt(m));
conn.on('artwork', (m) => store.update({ artwork: m.status }));
conn.on('status', (status) => store.update({ status }));
conn.on('denied', (m) => store.update({ denied: m.reason }));
conn.on('toast', (m) => toast(m.text, m.level === 'error' ? 'error' : 'info'));

/** Sends a request; shows the error as a toast and resolves to null on failure. */
export async function act(t, body = {}, { quiet = false } = {}) {
  try {
    return await conn.request(t, body);
  } catch (e) {
    if (!quiet) toast(e.message, 'error');
    return null;
  }
}

export async function loginWithPin(pin) {
  const { token } = await apiPost('/api/auth/pin', { pin });
  localStorage.setItem('ok.hostToken', token);
  store.update({ denied: null });
  conn.close();
  conn.stopped = false;
  conn.attempt = 0;
  conn.open();
}

export function openDialog(dialog) {
  store.update({ dialog });
}

export function closeDialog() {
  store.update({ dialog: null });
}

/** Position of the current song, interpolated between the TV's 4 Hz reports. */
export function livePosition() {
  const { state, time } = store.get();
  const p = state?.player;
  if (!p || !state.current) return 0;
  if (time && time.entryId === state.current.id) {
    const extra = time.playing && p.state === 'playing' ? ((performance.now() - time.recv) / 1000) * (p.tempo || 1) : 0;
    return Math.min(time.pos + extra, time.dur || p.dur || Infinity);
  }
  return p.pos || 0;
}
