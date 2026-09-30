// UI pieces shared by the host and guest apps.
import { html, useEffect, useRef, useState, useCallback } from '../vendor/preact.js';
import { Icon } from './icons.js';
import { artUrl, artistArtUrl, artStore, formatTime, useStore } from './store.js';

/** JSON fetch helper; adds the host token when there is one. */
export async function apiGet(path, params) {
  const url = new URL(path, location.origin);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const headers = {};
  const token = localStorage.getItem('ok.hostToken');
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code });
  return data;
}

export async function apiPost(path, body) {
  const headers = { 'content-type': 'application/json' };
  const token = localStorage.getItem('ok.hostToken');
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code });
  return data;
}

const fetchCache = new Map();

/** Fetches `path` (with params) and caches the result briefly; `null` path = don't fetch. */
export function useFetch(path, params, { ttl = 15000 } = {}) {
  const key = path ? `${path}?${new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== '' && v !== null))}` : null;
  const cached = key && fetchCache.get(key);
  const [state, setState] = useState(() => ({ data: cached?.data ?? null, error: null, loading: !!key && !cached }));
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!key) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    const hit = fetchCache.get(key);
    if (hit && Date.now() - hit.at < ttl && !reload) {
      setState({ data: hit.data, error: null, loading: false });
      return undefined;
    }
    let alive = true;
    setState((s) => ({ data: hit?.data ?? (s.key === key ? s.data : null), error: null, loading: true, key }));
    apiGet(path, params).then(
      (data) => {
        fetchCache.set(key, { data, at: Date.now() });
        if (fetchCache.size > 200) fetchCache.delete(fetchCache.keys().next().value);
        if (alive) setState({ data, error: null, loading: false, key });
      },
      (error) => alive && setState({ data: null, error, loading: false, key }),
    );
    return () => { alive = false; };
  }, [key, reload]);
  return { ...state, reload: () => setReload((x) => x + 1) };
}

export function clearFetchCache() {
  fetchCache.clear();
}

/** Current `location.hash` split into a path and query params. */
export function useHashRoute() {
  const parse = () => {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [p, q] = raw.split('?');
    return { path: p || '/', parts: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q || '') };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function go(path) {
  if (location.hash !== `#${path}`) location.hash = path;
}

export function Cover({ songId, size = 48, big = false }) {
  useStore(artStore); // new artwork → new URL
  return html`<div class="cover" style=${{ width: `${size}px` }}>
    <img src=${artUrl(songId, big ? 500 : 250)} alt="" loading="lazy" decoding="async" />
  </div>`;
}

/** Round artist picture (falls back to a placeholder on the server). */
export function ArtistImage({ artistKey, size = 44, class: cls = '' }) {
  useStore(artStore);
  return html`<img class=${cls} src=${artistArtUrl(artistKey, 'picture', { size: size > 200 ? 500 : 250 })} alt="" loading="lazy" decoding="async" width=${size} height=${size} />`;
}

export function Avatar({ singer, size = 32 }) {
  return html`<span class="avatar" title=${singer?.name || ''} style=${{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.55)}px`, '--avatar': singer?.color }}>${singer?.emoji || '🎤'}</span>`;
}

export function SongBadges({ song }) {
  return html`${song.duet ? html`<span class="mini-badge" title="Duet"><${Icon} name="duet" size=${14} /></span>` : null}${song.x ? html`<span class="tag-e" title="Explicit">E</span>` : null}`;
}

/** One song in a list: cover, title, artist, badges, duration and an action area. */
export function SongRow({ song, onOpen, children, highlight }) {
  return html`<div class=${`song-row ${highlight ? 'hl' : ''}`} role="button" tabindex="0"
      onClick=${() => onOpen?.(song)} onKeyDown=${(e) => { if (e.key === 'Enter') onOpen?.(song); }}>
    <${Cover} songId=${song.id} size=${44} />
    <div class="song-text">
      <div class="song-title ellipsis">${song.title} <${SongBadges} song=${song} /></div>
      <div class="song-artist ellipsis">${song.artist}</div>
    </div>
    ${song.v > 1 ? html`<span class="versions" title=${`${song.v} versions`}>${song.v}×</span>` : null}
    <span class="dur num">${song.dur ? formatTime(song.dur) : ''}</span>
    <div class="row-actions" onClick=${(e) => e.stopPropagation()}>${children}</div>
  </div>`;
}

export function Modal({ title, onClose, children, footer, wide, class: cls = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    const first = ref.current?.querySelector('input, select, textarea, button:not(.close)');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return html`<div class="scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`dialog ${wide ? 'wide' : ''} ${cls}`} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <div class="dialog-head">
        <h2>${title}</h2>
        <button class="icon-btn close" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
      </div>
      <div class="dialog-body">${children}</div>
      ${footer && html`<div class="dialog-foot">${footer}</div>`}
    </div>
  </div>`;
}

export function Empty({ icon = '🎤', title, children }) {
  return html`<div class="empty"><div class="big">${icon}</div>${title && html`<h3>${title}</h3>`}${children && html`<div>${children}</div>`}</div>`;
}

export function Toasts({ store }) {
  const toasts = useStore(store);
  return html`<div class="toasts" aria-live="polite">${toasts.map((t) => html`<div class=${`toast ${t.level}`} key=${t.id}>${t.text}</div>`)}</div>`;
}

export function Spinner() {
  return html`<div class="spinner" role="status" aria-label="Loading"></div>`;
}

export function Switch({ checked, onChange, label, disabled }) {
  return html`<label class="switch" title=${label}>
    <input type="checkbox" checked=${checked} disabled=${disabled} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span></span>
  </label>`;
}

/** Stepper like "−  +2  +" used for key and tempo. */
export function Stepper({ label, value, display, onChange, step = 1, min, max, onReset, disabled }) {
  const set = (v) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
  return html`<div class="stepper" aria-label=${label}>
    <button class="icon-btn small" onClick=${() => set(value - step)} disabled=${disabled || value <= min} aria-label=${`${label} down`}><${Icon} name="minus" size=${16} /></button>
    <button class="stepper-value" onClick=${onReset} disabled=${disabled} title=${`${label} — click to reset`}><small>${label}</small><b>${display}</b></button>
    <button class="icon-btn small" onClick=${() => set(value + step)} disabled=${disabled || value >= max} aria-label=${`${label} up`}><${Icon} name="plus" size=${16} /></button>
  </div>`;
}

/** Infinite list helper: calls `onMore` when the sentinel scrolls into view. */
export function MoreSentinel({ onMore, active }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active || !ref.current) return undefined;
    const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) onMore(); }, { rootMargin: '400px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [active, onMore]);
  return html`<div ref=${ref} class="sentinel">${active ? html`<${Spinner} />` : null}</div>`;
}

/** Paged song list for an API endpoint returning { total, items }. */
export function usePaged(path, params, pageSize = 60) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({});
  const key = path ? `${path}?${JSON.stringify(params)}` : null;
  const seq = useRef(0);
  const load = useCallback(async (offset) => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const data = await apiGet(path, { ...params, limit: pageSize, offset });
      if (my !== seq.current) return;
      setItems((prev) => (offset ? [...prev, ...data.items] : data.items));
      setTotal(data.total ?? data.items.length);
      if (!offset) {
        const { items: _items, ...rest } = data;
        setMeta(rest);
      }
      setError(null);
    } catch (e) {
      if (my === seq.current) setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [key]);
  useEffect(() => {
    setItems([]);
    setTotal(0);
    setMeta({});
    load(0);
  }, [key]);
  const more = useCallback(() => { if (!loading && items.length < total) load(items.length); }, [loading, items.length, total, load]);
  return { items, total, loading, error, more, meta, hasMore: items.length < total };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}
