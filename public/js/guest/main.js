// Guest app (/j/<ROOM>): join with a name, find songs, request them, follow the queue, react.
import { html, render, useEffect, useMemo, useRef, useState } from '../vendor/preact.js';
import { Connection } from '../lib/ws-client.js';
import { createStore, useStore, toastStore, formatEta, formatTime, singersText, plural, useDebounced, useTick, noteArt } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { SongRow, Cover, Avatar, Empty, Spinner, MoreSentinel, usePaged, useFetch, Toasts, SongBadges } from '../lib/components.js';
import { AVATARS, COLORS, REACTIONS, DENIED_MESSAGES, GAME_LABELS, formatKey } from '/shared/protocol.js';
import { GAME_UI } from '../games/index.js';

const pathCode = (location.pathname.match(/^\/j\/([A-Za-z]{4})\/?$/) || [])[1];
const toasts = toastStore();
const toast = toasts.show;
const store = createStore({
  code: (pathCode || '').toUpperCase(),
  status: 'connecting',
  state: null,
  denied: null,
  tab: 'home',
  sheet: null, // song id
  alert: null, // { kind: 'next' | 'now', title }
  time: null,
});

const conn = new Connection({
  hello: () => ({ role: 'guest', room: store.get().code, token: localStorage.getItem('ok.guestToken') || undefined }),
});
conn.on('welcome', (m) => {
  if (m.token) localStorage.setItem('ok.guestToken', m.token);
  localStorage.setItem('ok.lastRoom', store.get().code);
  store.update({ state: m.state, denied: null });
});
let lastGameId = null;
conn.on('state', (m) => {
  const game = m.state.game;
  const patch = { state: m.state };
  // A new game starts: jump to the game tab. The game is gone: back home.
  if (game && !game.ended && game.id !== lastGameId && m.state.rules?.games && GAME_UI[game.type]?.Guest) patch.tab = 'game';
  else if (!game && store.get().tab === 'game') patch.tab = 'home';
  lastGameId = game?.id || null;
  store.update(patch);
});
conn.on('time', (m) => store.update({ time: { ...m, recv: performance.now() } }));
conn.on('status', (status) => store.update({ status }));
conn.on('denied', (m) => store.update({ denied: m.reason }));
conn.on('toast', (m) => toast(m.text, m.level === 'error' ? 'error' : 'info'));
conn.on('art', (m) => noteArt(m));
conn.on('notify', (m) => {
  if (m.kind === 'next') {
    store.update({ alert: { kind: 'next', title: m.title } });
    buzz([120, 80, 120]);
  } else if (m.kind === 'now') {
    store.update({ alert: { kind: 'now', title: m.title } });
    buzz([300, 120, 300, 120, 300]);
    setTimeout(() => { if (store.get().alert?.kind === 'now') store.update({ alert: null }); }, 25000);
  } else if (m.kind === 'approved') {
    toast(`The host added ${m.title} to the queue`, 'ok');
  } else if (m.kind === 'rejected') {
    toast(`The host passed on ${m.title} this time`, 'error', 5000);
  }
});

function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch { /* not supported */ }
}

async function ask(t, body) {
  try {
    return await conn.request(t, body);
  } catch (e) {
    toast(e.message, 'error', 5000);
    return null;
  }
}

const setTab = (tab) => {
  store.update({ tab });
  document.querySelector('.g-main')?.scrollTo({ top: 0 });
};
const openSong = (id) => store.update({ sheet: id });

// ---- entry screens ---------------------------------------------------------------------

function EnterCode({ message }) {
  const [code, setCode] = useState(localStorage.getItem('ok.lastRoom') || '');
  const go = (e) => {
    e.preventDefault();
    if (code.length !== 4) return;
    history.replaceState(null, '', `/j/${code}`);
    store.update({ code, denied: null, state: null });
    conn.stopped = false;
    conn.attempt = 0;
    if (conn.pingTimer) conn.open();
    else conn.connect();
  };
  return html`<div class="g-gate"><form class="g-card" onSubmit=${go}>
    <img src="/img/icon.svg" alt="" width="64" height="64" />
    <h1>Join the karaoke</h1>
    <p class="muted">${message || 'Type the four-letter code shown on the TV, or scan the QR code with your camera.'}</p>
    <input class="input code-box" value=${code} maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-label="Party code"
      onInput=${(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
    <button class="btn primary large block" disabled=${code.length !== 4}>Join</button>
  </form></div>`;
}

function Denied({ reason }) {
  if (reason === 'bad_room') return html`<${EnterCode} message=${DENIED_MESSAGES.bad_room} />`;
  const text = reason === 'kicked' ? 'The host disconnected this phone. Reload the page to join again.' : DENIED_MESSAGES[reason] || 'You can’t join right now.';
  return html`<div class="g-gate"><div class="g-card"><div class="big-emoji">🎤</div><h1>Can't join</h1><p class="muted">${text}</p>
    ${reason === 'kicked' && html`<button class="btn primary" onClick=${() => location.reload()}>Reload</button>`}</div></div>`;
}

function ProfileForm({ initial, submitLabel, onDone }) {
  const [name, setName] = useState(initial?.name || '');
  const [emoji, setEmoji] = useState(initial?.emoji || AVATARS[Math.floor(Math.random() * AVATARS.length)]);
  const [color, setColor] = useState(initial?.color || COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const r = await ask('guest.update', { name, emoji, color });
    setBusy(false);
    if (r) onDone?.(r);
  };
  return html`<form class="profile-form" onSubmit=${submit}>
    <div class="avatar-preview" style=${{ '--c': color }}>${emoji}</div>
    <label class="field"><span>Your name (shown on the TV)</span>
      <input class="input big" value=${name} maxlength="24" autocomplete="nickname" enterkeyhint="done" placeholder="Name or nickname"
        onInput=${(e) => setName(e.currentTarget.value)} autofocus=${!initial} />
    </label>
    <div class="field"><span>Pick an avatar</span>
      <div class="emoji-grid" role="radiogroup" aria-label="Avatar">${AVATARS.map((a) => html`<button type="button" role="radio" aria-checked=${a === emoji} class=${a === emoji ? 'on' : ''} onClick=${() => setEmoji(a)}>${a}</button>`)}</div>
    </div>
    <div class="field"><span>And a colour</span>
      <div class="color-row" role="radiogroup" aria-label="Colour">${COLORS.map((c) => html`<button type="button" role="radio" aria-checked=${c === color} aria-label=${c} class=${c === color ? 'on' : ''} style=${{ background: c }} onClick=${() => setColor(c)}></button>`)}</div>
    </div>
    <button class="btn primary large block" disabled=${busy || !name.trim()}>${submitLabel}</button>
  </form>`;
}

function Join({ state }) {
  return html`<div class="g-gate join"><div class="g-card wide">
    <p class="kicker">You're joining</p>
    <h1>${state.info.name}</h1>
    <${ProfileForm} submitLabel="Let's sing" />
    <p class="hint">No account needed. Your phone remembers you for the rest of the party.</p>
  </div></div>`;
}

// ---- pieces -----------------------------------------------------------------------------------

function livePos() {
  const { state, time } = store.get();
  if (!state?.current) return 0;
  const p = state.player;
  if (time && time.entryId === state.current.id) {
    const extra = time.playing && p.state === 'playing' ? (performance.now() - time.recv) / 1000 : 0;
    return Math.min(time.pos + extra, time.dur || p.dur || Infinity);
  }
  return p.pos || 0;
}

function NowSinging({ state }) {
  useTick(1000);
  const cur = state.current;
  if (!cur) {
    return html`<section class="g-now idle"><div class="big-emoji">🎶</div><div><b>Nothing playing right now</b><p class="muted">${state.queue.length ? 'The next song starts soon.' : 'Be the first — pick a song!'}</p></div></section>`;
  }
  const p = state.player;
  const dur = p.dur || cur.dur || 1;
  const pct = Math.min(100, (livePos() / dur) * 100);
  const label = p.state === 'intro' || p.state === 'ready' ? 'Getting ready' : p.state === 'paused' ? 'Paused' : 'Singing now';
  return html`<section class="g-now">
    <${Cover} songId=${cur.songId} size=${64} />
    <div class="g-now-text">
      <div class="label">${label}</div>
      <div class="ellipsis singer">${cur.singers[0]?.emoji || '🎤'} ${singersText(cur.singers) || 'Sing along'}</div>
      <div class="ellipsis muted">${cur.title} · ${cur.artist}</div>
      <div class="bar"><i style=${{ width: `${pct}%` }}></i></div>
    </div>
  </section>`;
}

function MyTurn({ state }) {
  const mine = state.queue.find((e) => e.mine);
  const pending = state.me.pending;
  const isCurrent = state.current && state.current.singers.some((s) => s.id === state.me.profile?.singerId);
  if (isCurrent) {
    return html`<section class="g-turn now"><div class="big-emoji">🎤</div><div><b>It's your turn!</b><p>${state.current.title} — the lyrics are on the TV.</p></div></section>`;
  }
  if (mine) {
    const first = mine.position === 1;
    return html`<section class=${`g-turn ${first ? 'next' : ''}`}>
      <div class="pos"><small>You're</small><b>#${mine.position}</b></div>
      <div class="grow"><b>${first ? 'You’re next — get ready!' : `Your turn ${formatEta(mine.eta)}`}</b><p class="ellipsis">${mine.title} · ${mine.artist}</p></div>
    </section>`;
  }
  if (pending.length) {
    return html`<section class="g-turn"><div class="big-emoji">⏳</div><div class="grow"><b>Waiting for the host</b><p class="ellipsis">${pending[0].title} will join the queue once approved.</p></div></section>`;
  }
  return html`<section class="g-turn empty">
    <div class="grow"><b>Pick a song to get in the queue</b><p class="muted">${state.rules.guestsEnabled ? 'Search for any song or artist.' : 'Requests are closed for now.'}</p></div>
    ${state.rules.guestsEnabled && html`<button class="btn primary" onClick=${() => setTab('search')}><${Icon} name="search" size=${18} /> Find a song</button>`}
  </section>`;
}

function Reactions() {
  const [pop, setPop] = useState(null);
  const send = (emoji) => {
    conn.request('reaction', { emoji }).catch(() => {});
    buzz(15);
    setPop(emoji + Date.now());
  };
  return html`<section class="g-reactions">
    <h2>Cheer them on</h2>
    <div class="reaction-grid">${REACTIONS.map((r) => html`<button onClick=${() => send(r)} aria-label=${`Send ${r}`} class=${pop?.startsWith(r) ? 'pop' : ''} key=${r + (pop?.startsWith(r) ? pop : '')}>${r}</button>`)}</div>
  </section>`;
}

function QueueList({ items, state, compact }) {
  const canRemove = state.rules.guestCanRemoveOwn;
  return html`<ol class="g-queue">${items.map((e) => html`<li class=${e.mine ? 'mine' : ''} key=${e.id}>
    <span class="pos num">${e.position}</span>
    <${Avatar} singer=${e.singers[0]} size=${36} />
    <div class="grow">
      <div class="ellipsis"><b>${singersText(e.singers) || 'Anyone'}</b>${e.mine ? html` <span class="you">you</span>` : ''}</div>
      <div class="ellipsis muted">${e.mystery && !e.mine ? '🎁 Mystery song' : `${e.title} · ${e.artist}`}</div>
    </div>
    ${!compact && html`<span class="eta">${formatEta(e.eta)}</span>`}
    ${e.mine && canRemove && !compact && html`<button class="icon-btn small" aria-label=${`Remove ${e.title}`} onClick=${() => confirm(`Remove ${e.title} from the queue?`) && ask('queue.remove', { entryId: e.id })}><${Icon} name="x" size=${18} /></button>`}
  </li>`)}</ol>`;
}

// ---- tabs -----------------------------------------------------------------------------------------

function RateCard({ r }) {
  const [busy, setBusy] = useState(false);
  const rate = async (stars) => {
    setBusy(true);
    if (await ask('rate', { entryId: r.entryId, stars })) buzz(20);
    setBusy(false);
  };
  return html`<section class="rate-card">
    <b>How was ${singersText(r.singers) || 'that'}? ⭐</b>
    <p class="muted ellipsis">${r.title} · ${r.artist}</p>
    <div class="rate-stars" role="radiogroup" aria-label="Stars">${[1, 2, 3, 4, 5].map((n) => html`<button role="radio" aria-checked=${r.mine === n} aria-label=${`${n} star${n > 1 ? 's' : ''}`} class=${n <= r.mine ? 'on' : ''} disabled=${busy} onClick=${() => rate(n)}>★</button>`)}</div>
    <p class="hint">${r.mine ? 'Thanks! You can change it for a few more seconds.' : 'Tap the stars to rate the performance.'}</p>
  </section>`;
}

function GameTab({ state }) {
  const game = state.game;
  const ui = game && GAME_UI[game.type];
  if (!ui?.Guest) return html`<${HomeTab} state=${state} />`;
  return html`<div class="g-page game-tab">
    <p class="kicker">${GAME_LABELS[game.type]}${game.ended ? ' · finished' : ''}</p>
    <${ui.Guest} game=${game} state=${state} now=${() => conn.serverNow()} send=${(m) => ask('game.input', m)} />
  </div>`;
}

function HomeTab({ state }) {
  return html`<div class="g-page">
    ${state.rating && !state.rating.own && html`<${RateCard} r=${state.rating} />`}
    <${MyTurn} state=${state} />
    <${NowSinging} state=${state} />
    ${state.rules.reactions && state.current && html`<${Reactions} />`}
    ${state.queue.length > 0 && html`<section>
      <h2 class="g-h2">Up next <button class="link" onClick=${() => setTab('queue')}>See all</button></h2>
      <${QueueList} items=${state.queue.slice(0, 4)} state=${state} compact />
    </section>`}
    <${Rules} rules=${state.rules} />
  </div>`;
}

function Rules({ rules }) {
  const lines = [];
  if (rules.maxPerGuest) lines.push(`up to ${plural(rules.maxPerGuest, 'song')} waiting per person`);
  if (rules.requireApproval) lines.push('the host approves each request');
  if (!rules.allowRepeats) lines.push('each song once per night');
  if (rules.maxDuration) lines.push(`songs up to ${Math.round(rules.maxDuration / 60)} minutes`);
  if (!lines.length) return null;
  return html`<p class="hint rules">House rules: ${lines.join(', ')}.</p>`;
}

function SearchTab({ state }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState({ kind: 'popular' });
  const query = useDebounced(q, 150);
  const facets = useFetch('/api/browse/facets');
  const tags = (facets.data?.tags || []).filter((t) => t.tag !== 'Explicit' || !state.rules.explicitFilter).slice(0, 14);
  const genres = (facets.data?.genres || []).slice(0, 8);
  const decades = facets.data?.decades || [];
  let path = null;
  let params = {};
  if (query.trim()) { path = '/api/search'; params = { q: query }; }
  else if (mode.kind === 'popular') path = '/api/browse/popular';
  else if (mode.kind === 'tag') { path = `/api/browse/tag/${encodeURIComponent(mode.tag)}`; }
  else if (mode.kind === 'genre') { path = '/api/browse/popular'; params = { genre: mode.genre }; }
  else if (mode.kind === 'decade') { path = '/api/browse/popular'; params = { decade: mode.decade }; }
  else if (mode.kind === 'artist') path = null;
  const page = usePaged(path, params, 40);
  return html`<div class="g-page search">
    <div class="g-search">
      <${Icon} name="search" size=${20} />
      <input type="search" placeholder="Song or artist" value=${q} enterkeyhint="search" autocomplete="off" aria-label="Search songs"
        onInput=${(e) => setQ(e.currentTarget.value)} />
      ${q && html`<button class="icon-btn small" aria-label="Clear" onClick=${() => setQ('')}><${Icon} name="x" size=${18} /></button>`}
    </div>
    ${!query.trim() && html`<div class="g-chips">
      <button class=${`chip ${mode.kind === 'popular' ? 'on' : ''}`} onClick=${() => setMode({ kind: 'popular' })}>Popular</button>
      <button class=${`chip ${mode.kind === 'artist' ? 'on' : ''}`} onClick=${() => setMode({ kind: 'artist', letter: 'A' })}>Artists A–Z</button>
      ${tags.map((t) => html`<button class=${`chip ${mode.kind === 'tag' && mode.tag === t.tag ? 'on' : ''}`} onClick=${() => setMode({ kind: 'tag', tag: t.tag })}>${t.tag}</button>`)}
      ${decades.map((d) => html`<button class=${`chip ${mode.kind === 'decade' && mode.decade === d.decade ? 'on' : ''}`} onClick=${() => setMode({ kind: 'decade', decade: d.decade })}>${d.decade >= 2000 ? `${d.decade}s` : `’${String(d.decade).slice(2)}s`}</button>`)}
      ${genres.map((g) => html`<button class=${`chip ${mode.kind === 'genre' && mode.genre === g.genre ? 'on' : ''}`} onClick=${() => setMode({ kind: 'genre', genre: g.genre })}>${g.genre}</button>`)}
    </div>`}
    ${!query.trim() && mode.kind === 'artist'
      ? html`<${ArtistBrowser} mode=${mode} setMode=${setMode} letters=${facets.data?.letters || []} />`
      : html`
        ${query.trim() && !page.loading && html`<p class="hint">${plural(page.total, 'song')}${page.meta.fuzzy ? ' (close matches)' : ''}</p>`}
        <div class="g-songs">${page.items.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => openSong(s.id)}>
          <button class="icon-btn add" aria-label=${`Sing ${s.title}`} onClick=${() => openSong(s.id)}><${Icon} name="plus" size=${22} /></button>
        </${SongRow}>`)}</div>
        ${!page.items.length && !page.loading && query.trim() && html`<${Empty} icon="🤷" title="No songs found">Try fewer words, or just the artist.</${Empty}>`}
        ${page.loading && !page.items.length && html`<${Spinner} />`}
        <${MoreSentinel} active=${page.hasMore} onMore=${page.more} />`}
  </div>`;
}

function ArtistBrowser({ mode, setMode, letters }) {
  const list = usePaged(mode.artist ? null : '/api/artists', { letter: mode.letter }, 300);
  const artist = useFetch(mode.artist ? `/api/artists/${encodeURIComponent(mode.artist)}` : null);
  if (mode.artist) {
    return html`<div>
      <button class="btn small ghost" onClick=${() => setMode({ kind: 'artist', letter: mode.letter })}><${Icon} name="chevronLeft" size=${16} /> All artists</button>
      ${artist.data ? html`<h2 class="g-h2">${artist.data.artist.name}</h2>
        <div class="g-songs">${artist.data.songs.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => openSong(s.id)}>
          <button class="icon-btn add" aria-label=${`Sing ${s.title}`} onClick=${() => openSong(s.id)}><${Icon} name="plus" size=${22} /></button>
        </${SongRow}>`)}</div>` : html`<${Spinner} />`}
    </div>`;
  }
  return html`<div>
    <div class="g-letters">${letters.filter((l) => l.artists).map((l) => html`<button class=${l.letter === mode.letter ? 'on' : ''} onClick=${() => setMode({ kind: 'artist', letter: l.letter })}>${l.letter}</button>`)}</div>
    <div class="g-artists">${list.items.map((a) => html`<button key=${a.key} onClick=${() => setMode({ kind: 'artist', letter: mode.letter, artist: a.key })}>
      <span class="ellipsis">${a.name}</span><small class="faint">${a.count}</small>
    </button>`)}</div>
    <${MoreSentinel} active=${list.hasMore} onMore=${list.more} />
  </div>`;
}

function QueueTab({ state }) {
  const pending = state.me.pending;
  return html`<div class="g-page">
    <h1 class="g-h1">Queue</h1>
    ${state.current && html`<div class="g-current"><span class="label">Now</span> <b>${singersText(state.current.singers) || 'Sing along'}</b> <span class="muted">${state.current.title}</span></div>`}
    ${pending.length > 0 && html`<section class="g-pending"><h2 class="g-h2">Waiting for the host</h2>
      ${pending.map((e) => html`<div class="pending-row"><span class="ellipsis"><b>${e.title}</b> <span class="muted">${e.artist}</span></span>
        ${state.rules.guestCanRemoveOwn && html`<button class="icon-btn small" aria-label="Cancel request" onClick=${() => ask('queue.remove', { entryId: e.id })}><${Icon} name="x" size=${18} /></button>`}</div>`)}
    </section>`}
    ${state.queue.length
      ? html`<${QueueList} items=${state.queue} state=${state} />`
      : html`<${Empty} icon="🎶" title=${state.rules.guestsSeeQueue ? 'The queue is empty' : 'None of your songs are waiting'}>Pick a song and you'll be up in no time.</${Empty}>`}
    ${!state.rules.guestsSeeQueue && state.queueLength > state.queue.length && html`<p class="hint">${plural(state.queueLength, 'song')} in the queue in total. The host shows you only your own.</p>`}
  </div>`;
}

function MeTab({ state }) {
  const [editing, setEditing] = useState(false);
  const me = state.me;
  const favIds = me.profile?.favorites || [];
  const favs = useFetch(favIds.length ? '/api/songs' : null, { ids: favIds.join(',') }, { ttl: 0 });
  return html`<div class="g-page">
    ${editing
      ? html`<section class="g-card-inline"><h2 class="g-h2">Edit your profile</h2><${ProfileForm} initial=${me.profile} submitLabel="Save" onDone=${() => { setEditing(false); toast('Saved', 'ok'); }} /></section>`
      : html`<section class="g-profile">
          <div class="avatar-preview" style=${{ '--c': me.profile.color }}>${me.profile.emoji}</div>
          <div class="grow"><h1 class="g-h1">${me.profile.name}</h1><p class="muted">${me.queued ? `${plural(me.queued, 'song')} waiting` : 'No songs waiting'}${me.left !== null ? ` · ${me.left} more allowed` : ''}</p></div>
          <button class="btn small" onClick=${() => setEditing(true)}><${Icon} name="edit" size=${16} /> Edit</button>
        </section>`}
    <section>
      <h2 class="g-h2">Your favourites</h2>
      ${!favIds.length && html`<p class="muted">Tap the star on a song to keep it here for next time.</p>`}
      ${favs.data && html`<div class="g-songs">${favIds.map((id) => favs.data.items.find((s) => s.id === id)).filter(Boolean).map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => openSong(s.id)}>
        <button class="icon-btn add" aria-label=${`Sing ${s.title}`} onClick=${() => openSong(s.id)}><${Icon} name="plus" size=${22} /></button>
      </${SongRow}>`)}</div>`}
    </section>
    <p class="hint">Party: ${state.info.name} · code ${state.info.roomCode}</p>
  </div>`;
}

// ---- song sheet ----------------------------------------------------------------------------------

function SongSheet({ songId, state }) {
  const { data: song, error } = useFetch(`/api/songs/${encodeURIComponent(songId)}`);
  const [key, setKey] = useState(null);
  const [mystery, setMystery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);
  const fav = state.me.profile?.favorites?.includes(songId);
  const close = () => store.update({ sheet: null });
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const sing = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { songId };
      if (key !== null) body.key = key;
      if (mystery) body.mystery = true;
      const r = await conn.request('queue.add', body);
      setDone(r);
      buzz(30);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return html`<div class="sheet-scrim" onClick=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Song">
      <div class="sheet-grip"></div>
      <button class="icon-btn sheet-close" aria-label="Close" onClick=${close}><${Icon} name="x" /></button>
      ${error && html`<p class="warn-text">${error.message}</p>`}
      ${!song && !error && html`<${Spinner} />`}
      ${song && !done && html`
        <div class="sheet-head">
          <${Cover} songId=${song.id} size=${112} big />
          <div class="grow">
            <h2>${song.title} <${SongBadges} song=${song} /></h2>
            <p class="muted">${song.artist}</p>
            ${(song.meta?.year || song.meta?.genre) && html`<p class="faint">${[song.meta.year, song.meta.genre].filter(Boolean).join(' · ')}</p>`}
            <p class="faint">${formatTime(song.dur)}${song.plays ? ` · sung ${plural(song.plays, 'time')} here` : ''}</p>
          </div>
        </div>
        ${state.rules.guestKeyChange && html`<div class="field"><span>Key</span>
          <div class="key-row" role="radiogroup" aria-label="Key">
            <button role="radio" aria-checked=${key === null} class=${key === null ? 'on' : ''} onClick=${() => setKey(null)}>Auto</button>
            ${[-3, -2, -1, 1, 2, 3].map((k) => html`<button role="radio" aria-checked=${key === k} class=${key === k ? 'on' : ''} onClick=${() => setKey(k)}>${formatKey(k)}</button>`)}
          </div>
          <p class="hint">Lower if it's too high for you. “Auto” is the original key (or the one you used last time).</p>
        </div>`}
        <label class="toggle-row"><span><b>Mystery song</b><br /><span class="hint">Everyone else sees a surprise until you start.</span></span>
          <span class="switch"><input type="checkbox" checked=${mystery} onChange=${(e) => setMystery(e.currentTarget.checked)} /><span></span></span>
        </label>
        ${err && html`<p class="sheet-error">${err}</p>`}
        <div class="sheet-actions">
          <button class=${`icon-btn big-star ${fav ? 'active' : ''}`} aria-label=${fav ? 'Remove from favourites' : 'Add to favourites'} onClick=${() => ask('favorite.toggle', { songId })}><${Icon} name=${fav ? 'starFill' : 'star'} size=${24} /></button>
          <button class="btn primary large grow" disabled=${busy || !state.rules.guestsEnabled} onClick=${sing}><${Icon} name="mic" /> ${state.rules.guestsEnabled ? 'Sing it!' : 'Requests are closed'}</button>
        </div>`}
      ${done && html`<div class="sheet-done">
        <div class="big-emoji">${done.pending ? '📨' : done.started ? '🎤' : '🎉'}</div>
        <h2>${done.pending ? 'Request sent!' : done.started ? 'You’re on — head to the mic!' : `You're #${done.index + 1} in the queue`}</h2>
        <p class="muted">${done.pending ? 'The host will approve it shortly.' : done.started ? 'Your song is starting on the TV.' : `${done.eta < 45 ? 'You’re next!' : `Your turn is ${formatEta(done.eta)}.`} We'll buzz your phone when it's time to get ready.`}</p>
        <button class="btn primary large block" onClick=${() => { close(); setTab('home'); }}>Done</button>
      </div>`}
    </div>
  </div>`;
}

function Alert({ alert }) {
  const dismiss = () => store.update({ alert: null });
  if (alert.kind === 'now') {
    return html`<div class="g-alert now" onClick=${dismiss} role="alert">
      <div class="big-emoji">🎤</div><h1>It's your turn!</h1><p>${alert.title}</p><p class="muted">Head to the mic — the lyrics are on the TV.</p>
      <button class="btn primary large">Got it</button>
    </div>`;
  }
  return html`<div class="g-banner" role="alert"><b>You're up next!</b> <span class="ellipsis">${alert.title}</span><button class="icon-btn small" aria-label="Dismiss" onClick=${dismiss}><${Icon} name="x" size=${18} /></button></div>`;
}

// ---- shell ------------------------------------------------------------------------------------------

function Tabs({ state, tab }) {
  const mineCount = state.me.queued;
  const items = [['home', 'home', 'Home'], ['search', 'search', 'Songs'], ['queue', 'list', 'Queue'], ['me', 'user', 'Me']];
  if (state.game && state.rules.games && GAME_UI[state.game.type]?.Guest) items.unshift(['game', 'game', 'Game']);
  return html`<nav class="g-tabs">${items.map(([id, icon, label]) => html`<button class=${tab === id ? 'on' : ''} aria-current=${tab === id ? 'page' : undefined} onClick=${() => setTab(id)}>
    <${Icon} name=${icon} size=${22} /><span>${label}</span>${id === 'queue' && mineCount ? html`<i class="badge neon">${mineCount}</i>` : null}
  </button>`)}</nav>`;
}

function App() {
  const s = useStore(store);
  useEffect(() => {
    const accent = s.state?.accent;
    if (accent) document.documentElement.style.setProperty('--neon', accent);
  }, [s.state?.accent]);
  if (!s.code) return html`<${EnterCode} />`;
  if (s.denied) return html`<${Denied} reason=${s.denied} />`;
  const st = s.state;
  if (!st) return html`<div class="g-gate"><${Spinner} /><p class="muted">Joining the party…</p></div>`;
  if (!st.me.profile) return html`<${Join} state=${st} /><${Toasts} store=${toasts.store} />`;
  let view;
  if (s.tab === 'game') view = html`<${GameTab} state=${st} />`;
  else if (s.tab === 'search') view = html`<${SearchTab} state=${st} />`;
  else if (s.tab === 'queue') view = html`<${QueueTab} state=${st} />`;
  else if (s.tab === 'me') view = html`<${MeTab} state=${st} />`;
  else view = html`<${HomeTab} state=${st} />`;
  return html`<div class="g-app">
    <header class="g-top">
      <span class="g-party ellipsis">${st.info.name}</span>
      ${s.status !== 'open' && html`<span class="pill bad">Reconnecting…</span>`}
      <button class="g-me" onClick=${() => setTab('me')} aria-label="Your profile"><${Avatar} singer=${st.me.profile} size=${34} /></button>
    </header>
    ${s.alert?.kind === 'next' && html`<${Alert} alert=${s.alert} />`}
    <main class="g-main">${view}</main>
    <${Tabs} state=${st} tab=${s.tab} />
    ${s.sheet && html`<${SongSheet} songId=${s.sheet} state=${st} key=${s.sheet} />`}
    ${s.alert?.kind === 'now' && html`<${Alert} alert=${s.alert} />`}
    <${Toasts} store=${toasts.store} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
if (store.get().code) conn.connect();
