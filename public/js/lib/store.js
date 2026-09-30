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

export const artUrl = (songId, size = 250) => (songId ? `/api/art/song/${encodeURIComponent(songId)}?s=${size}` : '/img/icon.svg');

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
