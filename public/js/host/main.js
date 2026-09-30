// Host app shell: top bar + search, navigation, routed main view, queue panel, player bar.
import { html, render, useState, useEffect, useRef } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { Icon, Toasts, Spinner, useDebounced } from '/js/lib/ui.js';
import { store, ui, conn, act } from './state.js';
import { SongDetails, AddDialog, InviteModal, AnnounceModal, PinLogin } from './components.js';
import { QueuePanel } from './queue.js';
import { PlayerBar } from './player-bar.js';
import { Home, Search, Artists, Artist, Tags, Tag, Popular, Favorites, History } from './views.js';
import { Singers, Guests, Displays } from './people.js';
import { Settings } from './settings.js';

const NAV = [
  { href: '#/home', icon: 'home', label: 'Home' },
  { href: '#/search', icon: 'search', label: 'Search' },
  { href: '#/artists', icon: 'mic', label: 'Artists' },
  { href: '#/tags', icon: 'tag', label: 'Collections' },
  { href: '#/popular', icon: 'star', label: 'Popular' },
  { href: '#/favorites', icon: 'heart', label: 'Favourites' },
  { href: '#/queue', icon: 'queue', label: 'Queue', small: true },
  { sep: true },
  { href: '#/singers', icon: 'users', label: 'Singers' },
  { href: '#/guests', icon: 'user', label: 'Guests' },
  { href: '#/history', icon: 'clock', label: 'History' },
  { href: '#/displays', icon: 'tv', label: 'Displays' },
  { href: '#/settings', icon: 'settings', label: 'Settings' },
];

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [path] = h.split('?');
  const parts = path.split('/');
  return { name: parts[0] || 'home', arg: parts.slice(1).join('/') };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => { setRoute(parseHash()); ui.set({ navOpen: false }); document.querySelector('.main')?.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const searchStore = { q: '' };

function TopBar({ route }) {
  const st = useStore(store, (s) => s.state);
  const [q, setQ] = useState(searchStore.q);
  const input = useRef();
  const debounced = useDebounced(q, 160);
  useEffect(() => {
    searchStore.q = debounced;
    ui.set({ q: debounced });
    if (debounced.trim() && route.name !== 'search') location.hash = '#/search';
  }, [debounced]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !isTyping(e)) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const main = st?.displays?.find((d) => d.main);
  return html`<header class="top-bar">
    <button class="btn icon ghost burger" onClick=${() => ui.set((s) => ({ ...s, navOpen: !s.navOpen }))}><${Icon} name="list" /></button>
    <a class="logo" href="#/home"><img src="/img/icon.svg" alt="" /><span class="hide-sm"><span class="gradient-text">Open</span>Karaoke</span></a>
    <div class="search-box">
      <${Icon} name="search" size=${18} />
      <input ref=${input} type="search" placeholder="Search songs or artists  ( / )" value=${q}
        onInput=${(e) => setQ(e.currentTarget.value)}
        onFocus=${() => { if (q.trim() && route.name !== 'search') location.hash = '#/search'; }} />
      ${q && html`<button class="btn icon small ghost" onClick=${() => { setQ(''); input.current?.focus(); }}><${Icon} name="x" size=${16} /></button>`}
    </div>
    ${st && html`<button class="room-chip" title="Invite guests" onClick=${() => ui.set({ invite: true })}><${Icon} name="qr" size=${18} /><span class="hide-sm">Join code</span> <b>${st.party.roomCode}</b></button>`}
    ${st && html`<span class=${`conn-dot ${main ? 'ok' : 'warn'}`} title=${main ? 'TV connected' : 'No TV connected'}></span>`}
  </header>`;
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function Nav({ route }) {
  const st = useStore(store, (s) => s.state);
  const open = useStore(ui, (s) => s.navOpen);
  return html`<nav class=${`side-nav${open ? ' open' : ''}`}>
    ${NAV.map((n, i) => (n.sep ? html`<div key=${i} class="sep"></div>` : html`<a key=${n.href} href=${n.href} class=${`${route.name === n.href.slice(2).split('/')[0] ? 'on' : ''}${n.small ? ' small-only' : ''}`}>
      <${Icon} name=${n.icon} size=${19} /> <span>${n.label}</span>
      ${n.href === '#/queue' && st?.queue?.length ? html`<span class="count">${st.queue.length}</span>` : null}
      ${n.href === '#/guests' && st ? html`<span class="count">${st.guests.filter((g) => g.online).length || ''}</span>` : null}
    </a>`))}
    <div class="nav-foot">
      <button class="btn small ghost" onClick=${() => ui.set({ announce: true })}><${Icon} name="megaphone" size=${16} /> Announce</button>
    </div>
  </nav>`;
}

function MainView({ route }) {
  const q = useStore(ui, (s) => s.q || '');
  switch (route.name) {
    case 'search': return html`<${Search} q=${q} />`;
    case 'artists': return html`<${Artists} letter=${route.arg} />`;
    case 'artist': return html`<${Artist} artistKey=${route.arg} />`;
    case 'tags': return html`<${Tags} />`;
    case 'tag': return html`<${Tag} tag=${route.arg} />`;
    case 'popular': return html`<${Popular} />`;
    case 'favorites': return html`<${Favorites} />`;
    case 'history': return html`<${History} />`;
    case 'singers': return html`<${Singers} />`;
    case 'guests': return html`<${Guests} />`;
    case 'displays': return html`<${Displays} />`;
    case 'settings': return html`<${Settings} section=${route.arg || 'library'} />`;
    case 'queue': return html`<div class="view queue-view"><${QueuePanel} /></div>`;
    default: return html`<${Home} />`;
  }
}

function App() {
  const { state, conn: status, denied } = useStore(store);
  const route = useRoute();
  if (status === 'denied' && denied?.code === 'pin') return html`<${PinLogin} denied=${denied} />`;
  if (!state) {
    return html`<div class="login"><div class="center" style=${{ flexDirection: 'column', gap: '14px' }}><${Spinner} size=${34} /><div class="muted">${status === 'denied' ? denied?.reason : 'Connecting…'}</div></div></div>`;
  }
  return html`<div class="host-app">
    <${TopBar} route=${route} />
    <${Nav} route=${route} />
    <main class="main"><${MainView} route=${route} /></main>
    <div class="queue-col"><${QueuePanel} /></div>
    <${PlayerBar} />
    ${status !== 'open' && html`<div class="offline-bar">Connection lost — reconnecting…</div>`}
    <${AddDialog} />
    <${SongDetails} />
    <${InviteModal} />
    <${AnnounceModal} />
    <${Toasts} />
  </div>`;
}

// ---- keyboard shortcuts --------------------------------------------------------------------
const KEYS = {
  ' ': ['player.toggle'],
  n: ['player.next'],
  N: ['player.next'],
  '+': ['player.key', { delta: 1 }],
  '=': ['player.key', { delta: 1 }],
  '-': ['player.key', { delta: -1 }],
  ']': ['player.tempo', { delta: 0.05 }],
  '[': ['player.tempo', { delta: -0.05 }],
};
window.addEventListener('keydown', (e) => {
  if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.backdrop')) return;
  const k = KEYS[e.key];
  if (!k) return;
  e.preventDefault();
  act(k[0], k[1] || {});
});

render(html`<${App} />`, document.getElementById('app'));
conn.connect();
