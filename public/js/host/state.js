// Host app: connection, stores and small action helpers.
import { Connection, deviceId, storage } from '/js/lib/ws-client.js';
import { createStore } from '/js/lib/store.js';
import { toast } from '/js/lib/ui.js';

export const store = createStore({ state: null, conn: 'connecting', denied: null });
export const timeStore = createStore({ entryId: null, pos: 0, dur: 0, playing: false, at: 0, localAt: 0 });
export const libStore = createStore({ progress: null });
export const ui = createStore({ addFor: null, details: null, invite: false, announce: false, lastSinger: storage('ok.lastSinger') || null, queueTab: 'queue', navOpen: false });

export const conn = new Connection({
  hello: () => ({ role: 'host', deviceId: deviceId('ok.hostDevice'), token: storage('ok.hostToken') || undefined }),
});

conn.on('welcome', (m) => { if (m.token) storage('ok.hostToken', m.token); });
conn.on('state', (m) => { if (m.role === 'host') store.set({ state: m }); });
conn.on('status', ({ status, detail }) => store.set({ conn: status, denied: status === 'denied' ? detail : null }));
conn.on('time', (m) => timeStore.set({ ...m, localAt: performance.now() }));
conn.on('toast', (m) => toast(m.text, m.level));
conn.on('lib', (m) => libStore.set({ progress: m.status?.progress || null }));

/** Sends a request and shows errors as toasts. Resolves to the reply (or undefined on error). */
export async function act(type, payload = {}, { ok } = {}) {
  try {
    const r = await conn.request(type, payload);
    if (ok) toast(ok, 'ok', 2000);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
}

/** Current song position (s), interpolated between `time` messages. */
export function livePosition() {
  const t = timeStore.get();
  const st = store.get().state;
  if (!st?.current || t.entryId !== st.current.id) return st?.player?.position || 0;
  const tempo = st.player.tempo || 1;
  const extra = t.playing && st.player.state === 'playing' ? ((performance.now() - t.localAt) / 1000) * tempo : 0;
  return Math.min(t.dur || Infinity, t.pos + extra);
}

export function setLastSinger(id) {
  storage('ok.lastSinger', id);
  ui.set({ lastSinger: id });
}

export function openAdd(song, extra = {}) { ui.set({ addFor: { song, ...extra } }); }
export function openDetails(songId) { ui.set({ details: songId }); }
