// Small shared UI kit: icons, cover art, toasts, modal, hooks and formatters.
import { html, useState, useEffect, useRef } from '/js/vendor/preact.js';
import { createStore, useStore } from './store.js';
import { artUrl } from './api.js';
import { formatDuration } from '/shared/text.js';

export { formatDuration };

// ---- icons (24×24 stroke paths) --------------------------------------------
const P = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  next: 'M5 4.5v15l10-7.5zM17 4h2.5v16H17z',
  prev: 'M19 4.5v15L9 12zM4.5 4H7v16H4.5z',
  stop: 'M6 6h12v12H6z',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  top: 'M5 4h14M12 20V8M6 14l6-6 6 6',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  heart: 'M12 20s-7-4.5-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.5-9 9-9 9z',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
  shuffle: 'M4 7h3c4 0 6 10 10 10h3M4 17h3c1.5 0 2.7-1.3 3.7-3M20 7h-3c-1.5 0-2.7 1.3-3.7 3M17 4l3 3-3 3M17 14l3 3-3 3',
  volume: 'M4 9.5h4L13 5v14l-5-4.5H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9.5h4L13 5v14l-5-4.5H4zM17 9l5 6M22 9l-5 6',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  user: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM4 21a8 8 0 0 1 16 0',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  queue: 'M3 6h13M3 12h13M3 18h8M18 15v6M15 18h6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  megaphone: 'M3 10v4h3l7 5V5L6 10zM16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  wave: 'M2 12h2l2-6 3 12 3-16 3 14 2-8 2 4h3',
  key: 'M8 20V4M16 20V4M4 9h16M4 15h16',
  tempo: 'M9 3h6l3 18H6zM12 17l4-9',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v6H4zM17 15h3v6h-3z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  wifi: 'M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01',
};
const FILLED = new Set(['play', 'pause', 'next', 'prev', 'stop']);

export function Icon({ name, size = 20, class: cls = '', style }) {
  const d = P[name] || P.info;
  const filled = FILLED.has(name);
  return html`<svg class=${`icon ${cls}`} width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true" style=${style}
    fill=${filled ? 'currentColor' : 'none'} stroke=${filled ? 'none' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d=${d} /></svg>`;
}

// ---- cover art ---------------------------------------------------------------
/** songId -> version, bumped by the server's `art` events so covers refresh when found. */
export const artVersions = createStore({});
export function bumpArt(ids) {
  if (!ids?.length) return;
  artVersions.set((s) => {
    const n = { ...s };
    for (const id of ids) n[id] = (n[id] || 0) + 1;
    return n;
  });
}
export function useArtVersion(id) {
  return useStore(artVersions, (s) => (id ? s[id] || 0 : 0));
}

export function Cover({ song, size = 44, big = false, class: cls = '' }) {
  const [failed, setFailed] = useState(false);
  const v = useArtVersion(song?.id);
  useEffect(() => { setFailed(false); }, [v]);
  const src = failed ? '/img/icon.svg' : `${artUrl(song, big ? 500 : 250)}${v ? `&r=${v}` : ''}`;
  return html`<div class=${`cover ${cls}`} style=${{ width: `${size}px`, height: `${size}px` }}>
    <img src=${src} alt="" loading="lazy" decoding="async" onError=${() => setFailed(true)} />
  </div>`;
}

/** Round emoji avatar in the singer's colour. `size` 0 = sized by CSS class. */
export function SingerBadge({ singer, size = 28, class: cls = '' }) {
  if (!singer) return null;
  const style = { '--c': singer.color || '#888' };
  if (size) Object.assign(style, { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.55)}px` });
  return html`<span class=${`singer-badge ${cls}`} style=${style} title=${singer.name}>${singer.emoji || '🎤'}</span>`;
}

// ---- toasts --------------------------------------------------------------------
export const toasts = createStore({ list: [] });
let toastId = 0;
export function toast(text, level = 'info', ms = 3500) {
  const id = ++toastId;
  toasts.set((s) => ({ list: [...s.list.slice(-3), { id, text, level }] }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), ms);
}
export function Toasts() {
  const { list } = useStore(toasts);
  return html`<div class="toasts">${list.map((t) => html`<div key=${t.id} class=${`toast ${t.level}`}>${t.text}</div>`)}</div>`;
}

// ---- modal -----------------------------------------------------------------------
export function Modal({ onClose, children, wide = false, class: cls = '' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`<div class="backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`modal ${cls}`} style=${wide ? { width: 'min(900px, 100%)' } : null} role="dialog">${children}</div>
  </div>`;
}

export function Toggle({ checked, onChange, disabled }) {
  return html`<label class="switch"><input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} /><span></span></label>`;
}

export function Spinner({ size = 22 }) {
  return html`<div class="spinner" style=${{ width: `${size}px`, height: `${size}px` }}></div>`;
}

// ---- hooks -----------------------------------------------------------------------
export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return undefined;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

export function useDebounced(value, ms = 150) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Fetches `fn()` whenever `deps` change; returns { data, error, loading }. */
export function useAsync(fn, deps) {
  const [st, setSt] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    setSt((s) => ({ ...s, loading: true }));
    Promise.resolve(fn(ctrl.signal)).then(
      (data) => { if (alive) setSt({ data, error: null, loading: false }); },
      (error) => { if (alive && error?.name !== 'AbortError') setSt({ data: null, error, loading: false }); },
    );
    return () => { alive = false; ctrl.abort(); };
  }, deps);
  return st;
}

// ---- formatting --------------------------------------------------------------------
export function formatEta(sec) {
  if (sec == null) return '';
  if (sec < 60) return '< 1 min';
  const m = Math.round(sec / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  return `~${h} h ${m % 60} min`;
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

export function names(singers) {
  return (singers || []).map((s) => s.name).join(' & ') || '—';
}
