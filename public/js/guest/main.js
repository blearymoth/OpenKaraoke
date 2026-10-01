// Guest app (/j/<ROOM>): join with a name, find songs, request them, follow the queue, react.
import { html, render, useEffect, useMemo, useRef, useState } from '../vendor/preact.js';
import { Connection } from '../lib/ws-client.js';
import { createStore, useStore, toastStore, formatEta, formatTime, singersText, plural, useDebounced, useTick, noteArt, lastArtSeq, setMarks } from '../lib/store.js';
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
  rateHidden: null, // entry id of a rating prompt the guest put away
  time: null,
});

const conn = new Connection({
  hello: () => ({ role: 'guest', room: store.get().code, token: localStorage.getItem('ok.guestToken') || undefined, artSeq: lastArtSeq() }),
});
conn.on('welcome', (m) => {
  noteArt(m.art);
  if (m.token) localStorage.setItem('ok.guestToken', m.token);
  localStorage.setItem('ok.lastRoom', store.get().code);
  setMarks(m.state);
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
  setMarks(m.state);
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
  } else if (m.kind === 'duet') { // the card itself comes with the state (me.invites), in the dock
    if (store.get().sheet) toast(`${m.by || 'Someone'} invited you to sing ${m.title} 🎶`, 'ok', 6000); // the sheet covers the dock
    buzz([80, 60, 80]);
  } else if (m.kind === 'duet-yes') {
    toast(`${m.by} will sing ${m.title} with you 🎶`, 'ok', 5000);
  } else if (m.kind === 'duet-no') {
    toast(`${m.by} can’t join ${m.title} this time`, 'info', 5000);
  } else if (m.kind === 'photo' && m.status === 'approved') {
    toast('The host put your photo on the TV 📸', 'ok', 5000);
  } else if (m.kind === 'mic') { // pass the mic (games/relay.js)
    toast('🎤 You have the mic — sing!', 'ok', 5000);
    buzz([400, 150, 400, 150, 400]);
  } else if (m.kind === 'cohost') {
    toast('The host made you a co-host: player controls are on your Home tab.', 'ok', 6000);
  } else if (m.kind === 'game' && typeof m.text === 'string') {
    toast(m.text.slice(0, 140), 'ok', 6000); // a party game calls on this guest (wheel result…)
    buzz([200, 100, 200]);
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

const RATE_LINGER_MS = 3500; // the rating prompt stays this long after a vote (to change it)

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
      <div class="ellipsis muted">${e.mystery && !e.mine ? '🎁 Mystery song' : `${e.title} · ${e.artist}`}${e.invites?.length ? ` · invited ${e.invites.map((x) => x.name).join(', ')}` : ''}</div>
    </div>
    ${!compact && html`<span class="eta">${formatEta(e.eta)}</span>`}
    ${e.mine && canRemove && !compact && html`<button class="icon-btn small" aria-label=${`Remove ${e.title}`} onClick=${() => confirm(`Remove ${e.title} from the queue?`) && ask('queue.remove', { entryId: e.id })}><${Icon} name="x" size=${18} /></button>`}
  </li>`)}</ol>`;
}

// ---- tabs -----------------------------------------------------------------------------------------

/**
 * "How was …?" after a song: shown on every tab (in the dock) while the rating is open, put
 * away with ✕ or a few seconds after voting (the dock covers the bottom of the page).
 */
function RateCard({ r }) {
  const [busy, setBusy] = useState(false);
  const away = useRef(null);
  useEffect(() => () => clearTimeout(away.current), []);
  const rate = async (stars) => {
    setBusy(true);
    clearTimeout(away.current);
    if (await ask('rate', { entryId: r.entryId, stars })) {
      buzz(20);
      away.current = setTimeout(() => store.update({ rateHidden: r.entryId }), RATE_LINGER_MS);
    }
    setBusy(false);
  };
  return html`<section class="rate-card" aria-label="Rate the performance">
    <div class="rate-head">
      <div class="grow"><b class="ellipsis">How was ${singersText(r.singers) || 'that'}? ⭐</b>
        <p class="muted ellipsis">${r.mine ? 'Thanks for rating!' : `${r.title} · ${r.artist}`}</p></div>
      <button class="icon-btn small" aria-label="Not now" onClick=${() => store.update({ rateHidden: r.entryId })}><${Icon} name="x" size=${18} /></button>
    </div>
    <div class="rate-stars" role="radiogroup" aria-label="Stars">${[1, 2, 3, 4, 5].map((n) => html`<button role="radio" aria-checked=${r.mine === n} aria-label=${`${n} star${n > 1 ? 's' : ''}`} class=${n <= r.mine ? 'on' : ''} disabled=${busy} onClick=${() => rate(n)}>★</button>`)}</div>
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

/** Resizes a picture on the phone (max 1600 px, JPEG) before it is sent. */
async function resizeImage(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not a picture this phone can read.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "Send a photo to the TV": pick or take a picture, it's resized and uploaded. */
function PhotoCard({ state }) {
  const [busy, setBusy] = useState(false);
  const send = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const blob = await resizeImage(file);
      const res = await fetch('/api/photos', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-guest-token': localStorage.getItem('ok.guestToken') || '' }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      toast(data.photo.status === 'approved' ? 'Your photo is on the TV!' : 'Sent! The host will put it on the TV.', 'ok', 5000);
      buzz(20);
    } catch (e) {
      toast(e.message, 'error', 5000);
    }
    setBusy(false);
  };
  const mine = state.me.photos || [];
  const label = { pending: 'Waiting for the host', approved: 'On the TV', rejected: 'Not shown' };
  return html`<section class="photo-card">
    <h2 class="g-h2">Send a photo to the TV 📸</h2>
    <label class=${`btn primary block ${busy ? 'disabled' : ''}`}>
      <input type="file" accept="image/*" hidden disabled=${busy} onChange=${(e) => { send(e.currentTarget.files[0]); e.currentTarget.value = ''; }} />
      <${Icon} name="plus" size=${18} /> ${busy ? 'Sending…' : 'Choose or take a photo'}
    </label>
    ${state.rules.photoApproval && html`<p class="hint">The host checks photos before they appear.</p>`}
    ${mine.length > 0 && html`<ul class="my-photos">${mine.map((p) => html`<li key=${p.id}><span class=${`pill ${p.status === 'rejected' ? 'bad' : ''}`}>${label[p.status] || p.status}</span> <span class="faint">${new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>`)}</ul>`}
  </section>`;
}

/**
 * A duet invitation from another guest (from the state, so it survives a locked phone or a
 * reload): join or decline. The next state drops it once answered.
 */
function InviteCard({ invite, more }) {
  const [busy, setBusy] = useState(false);
  const answer = async (accept) => {
    setBusy(true);
    await ask('duet.answer', { entryId: invite.entryId, accept });
    setBusy(false);
  };
  const when = invite.position === 1 || (invite.eta != null && invite.eta < 45) ? 'up next' : formatEta(invite.eta);
  return html`<section class="invite-card" role="alert">
    <div class="big-emoji">🎶</div>
    <div class="grow"><b>${invite.by?.name || 'Someone'} wants to sing “${invite.title}” with you</b>
      <p class="muted ellipsis">${[invite.artist, when, more ? `${plural(more, 'more invitation')} waiting` : ''].filter(Boolean).join(' · ')}</p>
      <div class="btn-row"><button class="btn primary" disabled=${busy} onClick=${() => answer(true)}>Let’s sing!</button><button class="btn ghost" disabled=${busy} onClick=${() => answer(false)}>No thanks</button></div></div>
  </section>`;
}

/** Prompts that must be seen on every tab — duet invitations, the rating — above the tab bar. */
function Dock({ children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const app = el?.parentElement;
    if (!el || !app) return undefined;
    // Room for the dock under the page and the toasts (it covers the bottom of the screen).
    const fit = () => app.style.setProperty('--dock-h', `${el.offsetHeight}px`);
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      app.style.removeProperty('--dock-h');
    };
  }, []);
  return html`<div class="g-dock" ref=${ref}>${children}</div>`;
}

/** Player and request controls for a guest the host made co-host. */
function CoHostCard({ cohost, state }) {
  const p = cohost.player;
  const playing = p.state === 'playing';
  return html`<section class="cohost-card">
    <h2 class="g-h2">Co-host controls</h2>
    <div class="cohost-buttons">
      <button class="btn" onClick=${() => ask(playing ? 'player.pause' : state.current ? 'player.resume' : 'player.play')}><${Icon} name=${playing ? 'pause' : 'play'} size=${18} /> ${playing ? 'Pause' : 'Play'}</button>
      <button class="btn" onClick=${() => ask('player.next')}><${Icon} name="next" size=${18} /> Next singer</button>
      <span class="key-group"><button class="btn" onClick=${() => ask('player.key', { semitones: p.key - 1 })} aria-label="Key down">Key −</button>
      <span class="num key">${formatKey(p.key)}</span>
      <button class="btn" onClick=${() => ask('player.key', { semitones: p.key + 1 })} aria-label="Key up">Key +</button></span>
    </div>
    ${cohost.pending.length > 0 && html`<h3 class="g-h3">Requests waiting</h3>
      <ul class="cohost-pending">${cohost.pending.map((e) => html`<li key=${e.id}><span class="ellipsis"><b>${e.title}</b> <span class="muted">${singersText(e.singers)}</span></span>
        <button class="btn small primary" onClick=${() => ask('queue.approve', { entryId: e.id })}>Yes</button><button class="btn small ghost" onClick=${() => ask('queue.reject', { entryId: e.id })}>No</button></li>`)}</ul>`}
  </section>`;
}

function HomeTab({ state }) {
  return html`<div class="g-page">
    ${state.cohost && html`<${CoHostCard} cohost=${state.cohost} state=${state} />`}
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

/** A list that failed to load (e.g. too many searches from this Wi-Fi at once): say so, offer a retry. */
function LoadError({ error, onRetry, big = true }) {
  const retry = html`<button class="btn small" onClick=${onRetry}>Try again</button>`;
  if (!big) return html`<p class="hint load-error">${error.message} ${retry}</p>`;
  const busy = error.status === 429;
  return html`<${Empty} icon=${busy ? '⏳' : '⚠️'} title=${busy ? 'One moment…' : 'That didn’t load'}><p>${error.message}</p>${retry}</${Empty}>`;
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
        ${query.trim() && !page.loading && !page.error && html`<p class="hint">${plural(page.total, 'song')}${page.meta.fuzzy ? ' (close matches)' : ''}</p>`}
        <div class="g-songs">${page.items.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => openSong(s.id)}>
          <button class="icon-btn add" aria-label=${`Sing ${s.title}`} onClick=${() => openSong(s.id)}><${Icon} name="plus" size=${22} /></button>
        </${SongRow}>`)}</div>
        ${page.error && !page.loading && html`<${LoadError} error=${page.error} onRetry=${page.retry} big=${!page.items.length} />`}
        ${!page.items.length && !page.loading && !page.error && query.trim() && html`<${Empty} icon="🤷" title="No songs found">Try fewer words, or just the artist.</${Empty}>`}
        ${page.loading && !page.items.length && html`<${Spinner} />`}
        <${MoreSentinel} active=${page.hasMore && !page.error} onMore=${page.more} />`}
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
        </${SongRow}>`)}</div>` : artist.error ? html`<${LoadError} error=${artist.error} onRetry=${artist.reload} />` : html`<${Spinner} />`}
    </div>`;
  }
  return html`<div>
    <div class="g-letters">${letters.filter((l) => l.artists).map((l) => html`<button class=${l.letter === mode.letter ? 'on' : ''} onClick=${() => setMode({ kind: 'artist', letter: l.letter })}>${l.letter}</button>`)}</div>
    <div class="g-artists">${list.items.map((a) => html`<button key=${a.key} onClick=${() => setMode({ kind: 'artist', letter: mode.letter, artist: a.key })}>
      <span class="ellipsis">${a.name}</span><small class="faint">${a.count}</small>
    </button>`)}</div>
    ${list.error && !list.loading && html`<${LoadError} error=${list.error} onRetry=${list.retry} big=${!list.items.length} />`}
    <${MoreSentinel} active=${list.hasMore && !list.error} onMore=${list.more} />
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
  const setInvites = async (e) => {
    const input = e.currentTarget;
    const allow = input.checked;
    if (!(await ask('duet.invites', { allow }))) input.checked = !allow; // refused: show how it is
  };
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
    ${state.rules.photos && html`<${PhotoCard} state=${state} />`}
    <label class="toggle-row"><span><b>Duet invitations</b><br /><span class="hint">Other guests can ask you to sing a song with them.</span></span>
      <span class="switch"><input type="checkbox" checked=${me.profile.duetInvites !== false} aria-label="Duet invitations" onChange=${setInvites} /><span></span></span>
    </label>
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
  const [partner, setPartner] = useState('');
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
      if (partner) body.partners = [partner];
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
        ${state.partners?.length > 0 && html`<label class="field"><span>Sing it with… <span class="hint">(they get asked on their phone)</span></span>
          <select class="select" value=${partner} onChange=${(e) => setPartner(e.currentTarget.value)}>
            <option value="">Just me</option>
            ${state.partners.map((x) => html`<option value=${x.id}>${x.emoji} ${x.name}</option>`)}
          </select></label>`}
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
  const invites = st.me.invites || [];
  const rating = st.rating && !st.rating.own && s.rateHidden !== st.rating.entryId ? st.rating : null;
  const dock = invites.length > 0 || !!rating;
  let view;
  if (s.tab === 'game') view = html`<${GameTab} state=${st} />`;
  else if (s.tab === 'search') view = html`<${SearchTab} state=${st} />`;
  else if (s.tab === 'queue') view = html`<${QueueTab} state=${st} />`;
  else if (s.tab === 'me') view = html`<${MeTab} state=${st} />`;
  else view = html`<${HomeTab} state=${st} />`;
  return html`<div class=${`g-app ${dock ? 'has-dock' : ''}`}>
    <header class="g-top">
      <span class="g-party ellipsis">${st.info.name}</span>
      ${s.status !== 'open' && html`<span class="pill bad">Reconnecting…</span>`}
      <button class="g-me" onClick=${() => setTab('me')} aria-label="Your profile"><${Avatar} singer=${st.me.profile} size=${34} /></button>
    </header>
    ${s.alert?.kind === 'next' && html`<${Alert} alert=${s.alert} />`}
    <main class="g-main">${view}</main>
    ${dock && html`<${Dock}>
      ${invites.length > 0 && html`<${InviteCard} invite=${invites[0]} more=${invites.length - 1} key=${invites[0].entryId} />`}
      ${rating && html`<${RateCard} r=${rating} key=${rating.entryId} />`}
    </${Dock}>`}
    <${Tabs} state=${st} tab=${s.tab} />
    ${s.sheet && html`<${SongSheet} songId=${s.sheet} state=${st} key=${s.sheet} />`}
    ${s.alert?.kind === 'now' && html`<${Alert} alert=${s.alert} />`}
    <${Toasts} store=${toasts.store} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
if (store.get().code) conn.connect();
