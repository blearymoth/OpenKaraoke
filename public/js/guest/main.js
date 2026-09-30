// Guest phone app (/j/<code>): join, now singing, search, queue, my songs, reactions.
import { html, render, useState, useEffect } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { storage } from '/js/lib/ws-client.js';
import { api } from '/js/lib/api.js';
import { Icon, Cover, SingerBadge, Spinner, Toasts, toast, useNow, formatDuration, formatEta, names } from '/js/lib/ui.js';
import { REACTIONS, SINGER_EMOJIS, SINGER_COLORS, formatKey } from '/shared/protocol.js';
import { store, conn, act, livePosition, setTab, roomCode } from './state.js';
import { SearchTab, SongSheet, SongItem } from './browse.js';

// ---- join / profile -------------------------------------------------------------------------

function ProfileForm({ initial, onDone, submitLabel }) {
  const [name, setName] = useState(initial?.name || '');
  const [emoji, setEmoji] = useState(initial?.emoji || SINGER_EMOJIS[Math.floor(Math.random() * 12)]);
  const [color, setColor] = useState(initial?.color || SINGER_COLORS[Math.floor(Math.random() * SINGER_COLORS.length)]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await act('guest.update', { name, emoji, color });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    storage('ok.profile', { name: r.data.name, emoji: r.data.emoji, color: r.data.color });
    onDone?.();
  };
  return html`<form class="g-profile" onSubmit=${submit}>
    <div class="preview"><span class="singer-badge" style=${{ '--c': color, width: '84px', height: '84px', fontSize: '46px' }}>${emoji}</span></div>
    <label class="g-field"><span>Your name</span>
      <input class="input big-input" value=${name} onInput=${(e) => setName(e.currentTarget.value)} maxLength="24" placeholder="e.g. Sam" autocomplete="nickname" required />
    </label>
    <div class="g-field"><span>Pick an emoji</span>
      <div class="emoji-grid">${SINGER_EMOJIS.map((x) => html`<button type="button" class=${`emoji${x === emoji ? ' on' : ''}`} onClick=${() => setEmoji(x)}>${x}</button>`)}</div>
    </div>
    <div class="g-field"><span>Your colour</span>
      <div class="swatches">${SINGER_COLORS.map((c) => html`<button type="button" class=${`swatch${c === color ? ' on' : ''}`} style=${{ background: c }} onClick=${() => setColor(c)} aria-label=${c}></button>`)}</div>
    </div>
    ${err && html`<div class="g-error">${err}</div>`}
    <button class="btn primary big block" disabled=${busy || !name.trim()}>${submitLabel}</button>
  </form>`;
}

function JoinScreen({ st }) {
  return html`<div class="g-join">
    <div class="g-join-head">
      <div class="dim upper">You're invited to</div>
      <h1 class="gradient-text">${st.party.name}</h1>
      <p class="muted">Pick songs from ${st.library.songs.toLocaleString()} karaoke tracks and sing along on the big screen.</p>
    </div>
    <${ProfileForm} submitLabel="Join the party 🎤" />
  </div>`;
}

// ---- home ----------------------------------------------------------------------------------------

function NowSinging({ st }) {
  useNow(500);
  const cur = st.current;
  if (!cur) {
    return html`<div class="g-card now idle">
      <div class="label">On stage</div>
      <div class="muted">${st.queue.length ? 'The next singer is getting ready…' : 'Nobody is singing yet — be the first!'}</div>
    </div>`;
  }
  const pos = livePosition();
  const dur = st.player.duration || cur.dur || 0;
  return html`<div class="g-card now">
    <div class="label">${st.player.state === 'intro' ? 'Up now' : st.player.state === 'paused' ? 'Paused' : 'Now singing'}</div>
    <div class="row">
      <${Cover} song=${{ id: cur.songId }} size=${64} />
      <div class="grow" style=${{ minWidth: 0 }}>
        <div class="t ellipsis">${cur.title}</div>
        <div class="a ellipsis">${cur.artist}</div>
        <div class="who">${cur.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${22} />`)} <b>${names(cur.singers)}</b></div>
      </div>
    </div>
    ${dur > 0 && html`<div class="g-progress"><div style=${{ width: `${Math.min(100, (pos / dur) * 100)}%` }}></div></div>`}
  </div>`;
}

function MyTurn({ st }) {
  const me = st.me;
  if (me.onStage) {
    return html`<div class="g-card turn hot"><div class="big-emoji">🎤</div><div><b>It's your turn!</b><div class="muted">Grab the mic — the lyrics are on the TV.</div></div></div>`;
  }
  if (me.upNext) {
    return html`<div class="g-card turn warm"><div class="big-emoji">⏭️</div><div><b>You're up next!</b><div class="muted">Get ready near the mic.</div></div></div>`;
  }
  const next = me.entries.find((e) => e.status === 'queued');
  const pending = me.entries.filter((e) => e.status === 'pending');
  if (next) {
    return html`<div class="g-card turn">
      <div class="pos">#${next.position}</div>
      <div class="grow" style=${{ minWidth: 0 }}><b class="ellipsis" style=${{ display: 'block' }}>${next.title}</b><div class="muted">Your turn ${formatEta(next.eta)}</div></div>
    </div>`;
  }
  if (pending.length) {
    return html`<div class="g-card turn"><div class="big-emoji">📨</div><div><b>${pending[0].title}</b><div class="muted">Waiting for the host to approve</div></div></div>`;
  }
  return html`<button class="g-card turn cta" onClick=${() => setTab('search')}>
    <div class="big-emoji">🎶</div><div class="grow"><b>Pick your song</b><div class="muted">Search by title or artist</div></div><${Icon} name="chevron" />
  </button>`;
}

function Reactions({ st }) {
  const [last, setLast] = useState(0);
  if (!st.rules.reactions || !st.current) return null;
  const send = (emoji) => {
    const now = Date.now();
    if (now - last < 350) return;
    setLast(now);
    conn.send('reaction', { emoji });
    try { navigator.vibrate?.(15); } catch { /* ignore */ }
  };
  return html`<div class="g-card">
    <div class="label">Cheer for ${names(st.current.singers)}</div>
    <div class="g-reactions">${REACTIONS.map((e) => html`<button key=${e} onClick=${() => send(e)}>${e}</button>`)}</div>
  </div>`;
}

function HomeTab({ st }) {
  const upcoming = st.queue.slice(0, 3);
  return html`<div class="g-page">
    <${MyTurn} st=${st} />
    <${NowSinging} st=${st} />
    <${Reactions} st=${st} />
    ${upcoming.length > 0 && html`<div class="g-card">
      <div class="row"><div class="label grow">Coming up</div><button class="btn small ghost" onClick=${() => setTab('queue')}>All ${st.queue.length}</button></div>
      ${upcoming.map((e) => html`<div class="g-mini" key=${e.id}>${e.singers[0] && html`<${SingerBadge} singer=${e.singers[0]} size=${30} />`}
        <div class="grow" style=${{ minWidth: 0 }}><b>${names(e.singers)}</b><div class="muted ellipsis">${e.title}</div></div><span class="dim">${formatEta(e.eta)}</span></div>`)}
    </div>`}
    <button class="btn primary big block" onClick=${() => setTab('search')}><${Icon} name="search" /> Find a song</button>
  </div>`;
}

// ---- queue ---------------------------------------------------------------------------------------

function QueueTab({ st }) {
  const remove = async (e) => {
    if (!confirm(`Remove “${e.title}” from the queue?`)) return;
    const r = await act('queue.remove', { entryId: e.id });
    if (!r.ok) toast(r.error, 'error');
  };
  return html`<div class="g-page">
    <h2 class="g-h">Queue</h2>
    ${st.current && html`<div class="g-q current">
      <span class="pos">🎤</span>${st.current.singers[0] && html`<${SingerBadge} singer=${st.current.singers[0]} size=${34} />`}
      <div class="grow" style=${{ minWidth: 0 }}><b class="ellipsis">${st.current.title}</b><div class="muted ellipsis">${names(st.current.singers)} · ${st.current.artist}</div></div>
    </div>`}
    ${!st.queue.length && html`<div class="empty"><div class="big">🎶</div>The queue is empty — add a song!</div>`}
    ${!st.rules.guestsSeeQueue && html`<p class="muted">The host shows only your own songs here.</p>`}
    ${st.queue.map((e, i) => html`<div key=${e.id} class=${`g-q${e.mine ? ' mine' : ''}`}>
      <span class="pos">${i + 1}</span>
      ${e.singers[0] && html`<${SingerBadge} singer=${e.singers[0]} size=${34} />`}
      <div class="grow" style=${{ minWidth: 0 }}>
        <b class="ellipsis">${e.title}</b>
        <div class="muted ellipsis">${names(e.singers)} · ${e.artist}</div>
      </div>
      <div class="eta">${formatEta(e.eta)}${e.key ? html`<div class="dim">key ${formatKey(e.key)}</div>` : null}</div>
      ${e.canRemove && html`<button class="btn icon small ghost danger" aria-label="Remove" onClick=${() => remove(e)}><${Icon} name="x" size=${18} /></button>`}
    </div>`)}
  </div>`;
}

// ---- me --------------------------------------------------------------------------------------------

function MeTab({ st }) {
  const me = st.me;
  const editing = useStore(store, (s) => s.editProfile);
  const favs = me.profile?.favorites || [];
  const [favSongs, setFavSongs] = useState(null);
  const favKey = favs.join(',');
  useEffect(() => {
    let alive = true;
    Promise.all(favs.slice(0, 50).map((id) => api(`/api/songs/${id}`).catch(() => null))).then((l) => { if (alive) setFavSongs(l.filter(Boolean)); });
    return () => { alive = false; };
  }, [favKey]);
  const remove = async (e) => {
    const r = await act('queue.remove', { entryId: e.id });
    if (!r.ok) toast(r.error, 'error');
  };
  if (editing) {
    return html`<div class="g-page">
      <button class="btn small ghost" onClick=${() => store.set({ editProfile: false })}><${Icon} name="back" size=${16} /> Back</button>
      <${ProfileForm} initial=${me.profile} submitLabel="Save" onDone=${() => { store.set({ editProfile: false }); toast('Saved', 'ok', 1500); }} />
    </div>`;
  }
  return html`<div class="g-page">
    <div class="g-card me">
      <span class="singer-badge" style=${{ '--c': me.profile.color, width: '56px', height: '56px', fontSize: '30px' }}>${me.profile.emoji}</span>
      <div class="grow"><b style=${{ fontSize: '19px' }}>${me.profile.name}</b><div class="muted">${me.onStage ? 'On stage right now 🎤' : me.sung ? `${me.sung} song${me.sung > 1 ? 's' : ''} sung tonight 🌟` : 'Ready for your first song?'}</div></div>
      <button class="btn small" onClick=${() => store.set({ editProfile: true })}><${Icon} name="edit" size=${14} /> Edit</button>
    </div>
    <h3 class="g-h">My songs</h3>
    ${!me.entries.length && html`<p class="muted">No songs in the queue yet.</p>`}
    ${me.entries.map((e) => html`<div class="g-q mine" key=${e.id}>
      <span class="pos">${e.status === 'pending' ? '⏳' : `#${e.position}`}</span>
      <div class="grow" style=${{ minWidth: 0 }}><b class="ellipsis">${e.title}</b><div class="muted ellipsis">${e.status === 'pending' ? 'Waiting for approval' : `${e.artist} · ${formatEta(e.eta)}`}</div></div>
      ${st.rules.guestCanRemoveOwn && html`<button class="btn icon small ghost danger" aria-label="Remove" onClick=${() => remove(e)}><${Icon} name="x" size=${18} /></button>`}
    </div>`)}
    <h3 class="g-h">Favourites</h3>
    ${!favs.length ? html`<p class="muted">Tap ♥ on a song to save it for later.</p>` : !favSongs ? html`<${Spinner} />` : html`<div class="g-list">${favSongs.map((s) => html`<${SongItem} key=${s.id} song=${s} />`)}</div>`}
    ${st.tonight.length > 0 && html`<h3 class="g-h">Sung tonight</h3>
      ${st.tonight.slice(0, 15).map((h, i) => html`<div class="g-mini" key=${i}>${h.singers[0] && html`<${SingerBadge} singer=${h.singers[0]} size=${26} />`}<div class="grow" style=${{ minWidth: 0 }}><b class="ellipsis">${h.title}</b><div class="muted ellipsis">${names(h.singers)}</div></div></div>`)}`}
    ${st.rules.maxPerGuest > 0 && html`<p class="dim small-note">You can have up to ${st.rules.maxPerGuest} song${st.rules.maxPerGuest > 1 ? 's' : ''} in the queue at a time.</p>`}
  </div>`;
}

// ---- shell -------------------------------------------------------------------------------------------

function Notice() {
  const n = useStore(store, (s) => s.notice);
  const me = useStore(store, (s) => s.state?.me);
  useEffect(() => {
    if (!n) return undefined;
    const id = setTimeout(() => store.set({ notice: null }), 12000);
    return () => clearTimeout(id);
  }, [n]);
  if (!n || (n.kind === 'next' && !me?.upNext) || (n.kind === 'now' && !me?.onStage)) return null;
  return html`<div class=${`g-notice ${n.kind}`} onClick=${() => store.set({ notice: null })}>
    <div class="big-emoji">${n.kind === 'now' ? '🎤' : '⏭️'}</div>
    <div><b>${n.kind === 'now' ? "It's your turn!" : "You're up next!"}</b><div>${n.title || ''}</div></div>
  </div>`;
}

const TABS = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'search', icon: 'search', label: 'Songs' },
  { id: 'queue', icon: 'queue', label: 'Queue' },
  { id: 'me', icon: 'user', label: 'Me' },
];

function Shell({ st }) {
  const tab = useStore(store, (s) => s.tab);
  const status = useStore(store, (s) => s.conn);
  const mineCount = st.me.entries.length;
  return html`<div class="g-app">
    <header class="g-top">
      <div class="grow ellipsis"><b>${st.party.name}</b></div>
      <span class="singer-badge" style=${{ '--c': st.me.profile.color, width: '32px', height: '32px', fontSize: '18px' }} onClick=${() => setTab('me')}>${st.me.profile.emoji}</span>
    </header>
    ${status !== 'open' && html`<div class="g-offline">Reconnecting…</div>`}
    ${st.library.state === 'offline' && html`<div class="g-offline warn">The song library is offline right now.</div>`}
    <main>
      ${tab === 'home' && html`<${HomeTab} st=${st} />`}
      ${tab === 'search' && html`<${SearchTab} />`}
      ${tab === 'queue' && html`<${QueueTab} st=${st} />`}
      ${tab === 'me' && html`<${MeTab} st=${st} />`}
    </main>
    <nav class="g-tabs">${TABS.map((t) => html`<button key=${t.id} class=${tab === t.id ? 'on' : ''} onClick=${() => setTab(t.id)}>
      <${Icon} name=${t.icon} size=${22} /><span>${t.label}</span>
      ${t.id === 'me' && mineCount ? html`<span class="badge">${mineCount}</span>` : null}
    </button>`)}</nav>
    <${SongSheet} />
    <${Notice} />
  </div>`;
}

function Denied({ denied }) {
  const icon = denied?.code === 'banned' ? '🚫' : denied?.code === 'closed' ? '⏸️' : '🔑';
  return html`<div class="g-center">
    <div class="big-emoji">${icon}</div>
    <h2>${denied?.code === 'room' ? 'Party code not found' : 'Can’t join right now'}</h2>
    <p class="muted">${denied?.reason || 'Not allowed'}</p>
    ${denied?.code !== 'banned' && html`<button class="btn primary" onClick=${() => { store.set({ denied: null }); conn.connect(); }}>Try again</button>`}
  </div>`;
}

function App() {
  const s = useStore(store, (x) => ({ state: x.state, conn: x.conn, denied: x.denied }));
  let body;
  if (s.conn === 'denied' || (s.denied && !s.state)) body = html`<${Denied} denied=${s.denied} />`;
  else if (!s.state) body = html`<div class="g-center"><${Spinner} size=${34} /><p class="muted">Joining the party…</p></div>`;
  else if (!s.state.me.profile) body = html`<${JoinScreen} st=${s.state} />`;
  else body = html`<${Shell} st=${s.state} />`;
  return html`${body}<${Toasts} />`;
}

if (!roomCode) {
  render(html`<div class="g-center"><div class="big-emoji">📷</div><h2>Scan the QR code on the TV</h2><p class="muted">It opens this page with the party code.</p></div>`, document.getElementById('app'));
} else {
  render(html`<${App} />`, document.getElementById('app'));
  conn.connect();
}
