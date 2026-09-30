// Minimal observable store + Preact hook.
import { useState, useEffect, useRef } from '/js/vendor/preact.js';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      if (next === state) return;
      state = next;
      for (const fn of subs) fn(state);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Re-renders when the selected slice changes (shallow compare for plain objects/arrays). */
export function useStore(store, selector = (s) => s) {
  const sel = useRef(selector);
  sel.current = selector;
  const [value, setValue] = useState(() => selector(store.get()));
  const last = useRef(value);
  useEffect(() => {
    const check = (s) => {
      const v = sel.current(s);
      if (!shallowEqual(v, last.current)) {
        last.current = v;
        setValue(() => v);
      }
    };
    check(store.get());
    return store.subscribe(check);
  }, [store]);
  return value;
}

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}
