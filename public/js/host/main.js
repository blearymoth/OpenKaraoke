// Host app (/host): KaraFun-style layout — top bar, navigation, main view, queue panel, player bar.
import { html, render, useEffect, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore } from '../lib/store.js';
import { useHashRoute, go, Toasts, Spinner } from '../lib/components.js';
import { store, conn, toasts, act, loginWithPin, livePosition } from './state.js';
import { PlayerBar, openInvite } from './player.js';
import { QueuePanel } from './queue.js';
import { Dialogs } from './dialogs.js';
import { Home, Search, Artists, Artist, Collections, Tag, Browse, Favorites, Singers, History } from './views.js';
import { Playlists } from './playlists.js';
import { Photos } from './photos.js';
import { Settings } from './settings.js';
import { Games } from './games.js';
import { TEMPO_STEP, DENIED_MESSAGES } from '/shared/protocol.js';
import { followAppearance } from '../lib/theme.js';

const NAV = [
  ['/', 'home', 'Home'],
  ['/search', 'search', 'Search'],
  ['/artists', 'mic', 'Artists'],
  ['/tags', 'tag', 'Collections'],
  ['/favorites', 'star', 'Favourites'],
  ['/playlists', 'music', 'Playlists'],
  ['/singers', 'users', 'Singers'],
  ['/games', 'game', 'Games'],
  ['/photos', 'eye', 'Photos'],
  ['/history', 'history', 'History'],
  ['/settings', 'settings', 'Settings'],
  ['/queue', 'list', 'Queue', 'mobile-only'],
];

/** Whether a media query matches, following changes (window resized, phone rotated). */
function useMedia(query) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}

const searchStore = { q: new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '' };

function TopBar({ route }) {
  const { state, status } = useStore(store);
  const [q, setQ] = useState(searchStore.q);
  const input = useRef(null);
  const narrow = useMedia('(max-width: 900px)'); // phones: a short placeholder, no keyboard shortcut
  useEffect(() => {
    const focus = () => input.current?.focus();
    document.addEventListener('ok:focus-search', focus);
    return () => document.removeEventListener('ok:focus-search', focus);
  }, []);
  const onInput = (v) => {
    setQ(v);
    searchStore.q = v;
    const target = `#/search?q=${encodeURIComponent(v)}`;
    if (route.parts[0] === 'search') history.replaceState(null, '', target);
    else location.hash = target.slice(1);
    document.dispatchEvent(new CustomEvent('ok:search', { detail: v }));
  };
  const lib = state.library;
  return html`<header class="topbar">
    <a class="brand" href="#/"><img src="/img/icon.svg" alt="" /><span>OpenKaraoke</span></a>
    <label class="search-box">
      <${Icon} name="search" size=${18} />
      <input ref=${input} type="search" placeholder=${narrow ? 'Song or artist' : 'Search songs or artists  ( / )'} value=${q} aria-label="Search songs or artists"
        onInput=${(e) => onInput(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Escape') { onInput(''); e.currentTarget.blur(); } }} />
    </label>
    <div class="top-right">
      ${lib.scanning && html`<span class="pill live"><span class="spinner tiny"></span> Scanning library</span>`}
      ${lib.offline && lib.roots.length > 0 && html`<a class="pill bad" href="#/settings/library"><${Icon} name="alert" size=${14} /> Drive not connected</a>`}
      ${status !== 'open' && html`<span class="pill bad">Reconnecting…</span>`}
      ${state.pairings?.length > 0 && html`<a class="pill bulb" href="#/settings/displays"><${Icon} name="tv" size=${14} /> Screen waiting: ${state.pairings[0].code}</a>`}
      <button class="code-chip" onClick=${openInvite} title="Invite guests"><${Icon} name="qr" size=${16} /> <span class="label">Room</span> <b>${state.info.roomCode}</b></button>
    </div>
  </header>`;
}

function Nav({ route }) {
  const { state } = useStore(store);
  const section = { artist: 'artists', tag: 'tags', genre: 'tags', decade: 'tags' }[route.parts[0]] || route.parts[0] || '';
  const active = `/${section}`;
  return html`<nav class="nav" aria-label="Main">
    ${NAV.map(([path, icon, label, cls]) => html`<a class=${`${active === path ? 'on' : ''} ${cls || ''}`} href=${`#${path}`} aria-current=${active === path ? 'page' : undefined}>
      <${Icon} name=${icon} /> <span>${label}</span>
      ${path === '/queue' && state.queue.length ? html`<span class="badge neon">${state.queue.length}</span>` : null}
      ${path === '/games' && state.game && !state.game.ended ? html`<span class="badge neon">live</span>` : null}
      ${path === '/photos' && state.photos?.some((p) => p.status === 'pending') ? html`<span class="badge neon">${state.photos.filter((p) => p.status === 'pending').length}</span>` : null}
    </a>`)}
  </nav>`;
}

function Main({ route }) {
  const [q, setQ] = useState(searchStore.q);
  useEffect(() => {
    const on = (e) => setQ(e.detail);
    document.addEventListener('ok:search', on);
    return () => document.removeEventListener('ok:search', on);
  }, []);
  const [a, b] = route.parts;
  switch (a) {
    case undefined: return html`<${Home} />`;
    case 'search': return html`<${Search} q=${q} />`;
    case 'artists': return html`<${Artists} letter=${b || 'A'} key=${b || 'A'} />`;
    case 'artist': return html`<${Artist} artistKey=${b} key=${b} />`;
    case 'tags': return html`<${Collections} />`;
    case 'tag': return html`<${Tag} tag=${b} sort=${route.query.get('sort')} key=${`${b}:${route.query.get('sort')}`} />`;
    case 'genre': return html`<${Browse} genre=${b} key=${`g:${b}`} />`;
    case 'decade': return html`<${Browse} decade=${b} key=${`d:${b}`} />`;
    case 'favorites': return html`<${Favorites} />`;
    case 'playlists': return html`<${Playlists} id=${b} key=${b || 'all'} />`;
    case 'singers': return html`<${Singers} />`;
    case 'games': return html`<${Games} />`;
    case 'photos': return html`<${Photos} />`;
    case 'history': return html`<${History} />`;
    case 'settings': return html`<${Settings} section=${b} />`;
    case 'queue': return html`<div class="page queue-page"><${QueuePanel} /></div>`;
    default: return html`<div class="page"><p>Page not found. <a href="#/">Go home</a></p></div>`;
  }
}

function PinScreen({ reason }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => followAppearance(), []); // no party state here to carry a skin switch
  if (reason !== 'pin_required') {
    return html`<div class="gate"><div class="gate-card">
      <img src="/img/icon.svg" alt="" width="64" height="64" />
      <h1>Host controls are locked</h1>
      <p class="muted">${DENIED_MESSAGES[reason] || reason}</p>
      <p class="hint">On the computer running OpenKaraoke: Settings → Party → Host PIN.</p>
    </div></div>`;
  }
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await loginWithPin(pin);
    } catch (err) {
      setError(err.message);
      setPin('');
    }
    setBusy(false);
  };
  return html`<div class="gate"><form class="gate-card" onSubmit=${submit}>
    <img src="/img/icon.svg" alt="" width="64" height="64" />
    <h1>Enter the host PIN</h1>
    <p class="muted">You're controlling the party from another device. The PIN is set on the computer running OpenKaraoke.</p>
    <input class="input pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autofocus value=${pin} aria-label="Host PIN"
      onInput=${(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} />
    ${error && html`<p class="warn-text">${error}</p>`}
    <button class="btn primary large block" disabled=${busy || pin.length < 4}>Unlock</button>
  </form></div>`;
}

function App() {
  const s = useStore(store);
  const route = useHashRoute();
  if (s.denied) return html`<${PinScreen} reason=${s.denied} />`;
  if (!s.state) return html`<div class="gate"><${Spinner} /><p class="muted">Connecting to OpenKaraoke…</p></div>`;
  return html`<div class="app">
    <${TopBar} route=${route} />
    <${Nav} route=${route} />
    <main class="main" id="main"><${Main} route=${route} /></main>
    <${QueuePanel} />
    <${PlayerBar} />
    <${Dialogs} />
    <${Toasts} store=${toasts.store} />
  </div>`;
}

// ---- keyboard shortcuts ---------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  if (typing || e.ctrlKey || e.metaKey || e.altKey || store.get().dialog) return;
  const st = store.get().state;
  if (!st) return;
  const p = st.player;
  const k = e.key;
  if (k === '/') document.dispatchEvent(new Event('ok:focus-search'));
  else if (k === ' ') {
    if (!st.current) act('player.play');
    else act(p.state === 'playing' ? 'player.pause' : 'player.resume');
  } else if (k === 'n' || k === 'N') act('player.next');
  else if (!st.current) return;
  else if (k === 'ArrowRight') act('player.seek', { pos: livePosition() + 5 });
  else if (k === 'ArrowLeft') act('player.seek', { pos: Math.max(0, livePosition() - 5) });
  else if (k === '+' || k === '=') act('player.key', { semitones: p.key + 1 });
  else if (k === '-') act('player.key', { semitones: p.key - 1 });
  else if (k === ']') act('player.tempo', { rate: p.tempo + TEMPO_STEP });
  else if (k === '[') act('player.tempo', { rate: p.tempo - TEMPO_STEP });
  else return;
  e.preventDefault();
});

render(html`<${App} />`, document.getElementById('app'));
conn.connect();
