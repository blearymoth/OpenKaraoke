// Small shared helpers for the Preact apps: a store, hooks and formatting.
import { useEffect, useReducer, useRef, useState } from '../vendor/preact.js';

/** Minimal observable store: get/set/update/subscribe. */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      state = next;
      for (const fn of subs) fn(state);
    },
    update(patch) {
      this.set({ ...state, ...(typeof patch === 'function' ? patch(state) : patch) });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Re-renders the component whenever the store changes. */
export function useStore(store) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => store.subscribe(force), [store]);
  return store.get();
}

/** Calls `fn` every `ms` (null = paused). */
export function useInterval(fn, ms) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms == null) return undefined;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Forces a re-render every `ms` (for clocks and countdowns). */
export function useTick(ms) {
  const [, set] = useState(0);
  useInterval(() => set((x) => x + 1), ms);
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** "in 4 min" style ETA. */
export function formatEta(sec) {
  if (sec == null) return '';
  if (sec < 45) return 'next';
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  return `in ${h} h ${min % 60} min`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function singersText(singers) {
  if (!singers?.length) return '';
  if (singers.length === 1) return singers[0].name;
  return `${singers.slice(0, -1).map((s) => s.name).join(', ')} & ${singers.at(-1).name}`;
}

// Artwork that changes while a page is open (the server sends `art` events) gets a new URL,
// so the browser loads the new image instead of its cached placeholder.
const artVersions = new Map();
/** The latest `art` event (components re-render; the URLs of changed images differ). */
export const artStore = createStore({ n: 0, songs: [], artists: [] });

/** Handles an `art` event: { songs: [songId], artists: [artistKey] }. */
export function noteArt({ songs = [], artists = [] } = {}) {
  for (const id of songs) artVersions.set(`s:${id}`, (artVersions.get(`s:${id}`) || 0) + 1);
  for (const key of artists) artVersions.set(`a:${key}`, (artVersions.get(`a:${key}`) || 0) + 1);
  if (songs.length || artists.length) artStore.set({ n: artStore.get().n + 1, songs, artists });
}

const ver = (k) => (artVersions.has(k) ? `&v=${artVersions.get(k)}` : '');

export const artUrl = (songId, size = 250) => (songId ? `/api/art/song/${encodeURIComponent(songId)}?s=${size}${ver(`s:${songId}`)}` : '/img/icon.svg');

/** Artist image: type = picture | fanart | logo | cutout | banner (`i` picks one of several fanarts). */
export const artistArtUrl = (key, type = 'picture', { i = 0, size } = {}) => `/api/art/artist/${encodeURIComponent(key)}?type=${type}${i ? `&i=${i}` : ''}${size ? `&s=${size}` : ''}${ver(`a:${key}`)}`;

/**
 * Live "In queue" / "Sung tonight" marks for song lists, fed from the party state so they
 * update without refetching the lists.
 */
export const marksStore = createStore({ ready: false, queued: new Set(), sung: new Set() });

export function setMarks(state) {
  if (!state) return;
  const queued = new Set();
  for (const e of state.queue || []) if (e.songId && !(e.mystery && !e.mine)) queued.add(e.songId);
  if (state.current?.songId && !state.current.mystery) queued.add(state.current.songId);
  const sung = new Set(state.sungTonight || []);
  const prev = marksStore.get();
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  if (prev.ready && same(prev.queued, queued) && same(prev.sung, sung)) return;
  marksStore.set({ ready: true, queued, sung });
}

export function toastStore() {
  const store = createStore([]);
  let n = 0;
  const show = (text, level = 'info', ms = 3500) => {
    const id = ++n;
    store.set([...store.get(), { id, text, level }].slice(-4));
    setTimeout(() => store.set(store.get().filter((t) => t.id !== id)), ms);
  };
  return { store, show };
}
