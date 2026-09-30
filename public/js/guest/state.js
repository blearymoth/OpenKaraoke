// Guest app: connection and stores.
import { Connection, deviceId, storage } from '/js/lib/ws-client.js';
import { createStore } from '/js/lib/store.js';
import { toast } from '/js/lib/ui.js';

export const roomCode = (location.pathname.split('/')[2] || new URLSearchParams(location.search).get('room') || '').toUpperCase();

export const store = createStore({ state: null, conn: 'connecting', denied: null, tab: 'home', sheet: null, notice: null, editProfile: false });
export const timeStore = createStore({ entryId: null, pos: 0, dur: 0, playing: false, localAt: 0 });

export const conn = new Connection({
  hello: () => ({ role: 'guest', room: roomCode, deviceId: deviceId(), profile: storage('ok.profile') || undefined }),
});

conn.on('state', (m) => {
  if (m.role !== 'guest') return;
  store.set({ state: m });
  if (m.me?.profile) storage('ok.profile', { name: m.me.profile.name, emoji: m.me.profile.emoji, color: m.me.profile.color });
  document.title = `${m.party.name} · Karaoke`;
});
conn.on('status', ({ status, detail }) => store.set({ conn: status, denied: status === 'denied' ? detail : null }));
conn.on('time', (m) => timeStore.set({ ...m, localAt: performance.now() }));
conn.on('notify', (m) => {
  toast(m.text, m.kind === 'rejected' ? 'error' : 'ok', 6000);
  try { navigator.vibrate?.(m.kind === 'now' ? [300, 120, 300, 120, 300] : [200, 100, 200]); } catch { /* not allowed */ }
  if (m.kind === 'next' || m.kind === 'now') store.set({ notice: m });
});
conn.on('denied', (m) => {
  if (m.code === 'banned' || m.code === 'kicked') conn.close();
});

// Phones drop the socket when the screen locks: reconnect as soon as the page is visible again.
document.addEventListener('visibilitychange', () => {
  const s = store.get();
  if (!document.hidden && conn.status !== 'open' && conn.status !== 'connecting' && s.denied?.code !== 'banned') conn.connect();
});

export async function act(type, payload = {}) {
  try {
    return { ok: true, data: await conn.request(type, payload) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function livePosition() {
  const t = timeStore.get();
  const st = store.get().state;
  if (!st?.current) return 0;
  if (t.entryId !== st.current.id) return st.player.position || 0;
  const extra = t.playing && st.player.state === 'playing' ? ((performance.now() - t.localAt) / 1000) * (st.player.tempo || 1) : 0;
  return Math.min(t.dur || Infinity, t.pos + extra);
}

export const openSong = (song) => store.set({ sheet: song });
export const setTab = (tab) => {
  store.set({ tab });
  window.scrollTo(0, 0);
};
