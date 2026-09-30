// Guest: search & browse, song rows and the "Sing it!" sheet.
import { html, useState, useEffect, useRef } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { api } from '/js/lib/api.js';
import { Icon, Cover, Spinner, useAsync, useDebounced, formatDuration, formatEta } from '/js/lib/ui.js';
import { formatKey } from '/shared/protocol.js';
import { store, act, openSong, setTab } from './state.js';

export function SongItem({ song }) {
  const st = useStore(store, (s) => s.state);
  const queued = st?.queue?.some((e) => e.songId === song.id) || st?.current?.songId === song.id;
  const sung = st?.tonight?.some((h) => h.songId === song.id);
  return html`<button class="g-song" onClick=${() => openSong(song)}>
    <${Cover} song=${song} size=${50} />
    <span class="grow">
      <span class="t">${song.title}${song.x ? html` <span class="tag x">E</span>` : null}${song.duet ? html` <span class="tag duet">DUET</span>` : null}</span>
      <span class="a">${song.artist}</span>
    </span>
    ${queued ? html`<span class="mark q">queued</span>` : sung ? html`<span class="mark s">sung</span>` : html`<span class="d">${formatDuration(song.dur)}</span>`}
  </button>`;
}

function Results({ load, deps, empty }) {
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [fuzzy, setFuzzy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setItems(null);
    load(0).then((r) => { if (my === seq.current) { setItems(r.items); setTotal(r.total); setFuzzy(!!r.fuzzy); } }, () => { if (my === seq.current) setItems([]); });
  }, deps);
  const more = async () => {
    const r = await load(items.length);
    setItems((x) => [...x, ...r.items]);
  };
  if (!items) return html`<div class="center pad"><${Spinner} /></div>`;
  if (!items.length) return html`<div class="empty"><div class="big">🔍</div>${empty}</div>`;
  return html`<div class="g-list">
    ${fuzzy && html`<div class="hint">Close matches:</div>`}
    ${items.map((s) => html`<${SongItem} key=${s.id} song=${s} />`)}
    ${items.length < total && html`<button class="btn block" style=${{ marginTop: '10px' }} onClick=${more}>Show more</button>`}
  </div>`;
}

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export function SearchTab() {
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('popular');
  const [letter, setLetter] = useState('A');
  const [artist, setArtist] = useState(null);
  const dq = useDebounced(q.trim(), 200);
  const facets = useAsync((signal) => api('/api/browse/facets', { signal }), []);
  const tags = (facets.data?.tags || []).slice(0, 14);
  const input = useRef();
  const page = 40;
  let body;
  if (dq) {
    body = html`<${Results} deps=${[dq]} empty=${`Nothing found for “${dq}”. Check the spelling or try the artist name.`}
      load=${(offset) => api('/api/search', { params: { q: dq, offset, limit: page, fits: 1 } })} />`;
  } else if (chip === 'artists' && artist) {
    body = html`<div>
      <button class="btn small ghost" onClick=${() => setArtist(null)}><${Icon} name="back" size=${16} /> Artists</button>
      <h3 class="g-h">${artist.name}</h3>
      <${Results} deps=${[artist.key]} empty="No songs" load=${async () => { const r = await api(`/api/artists/${encodeURIComponent(artist.key)}`); return { total: r.songs.length, items: r.songs }; }} />
    </div>`;
  } else if (chip === 'artists') {
    body = html`<div>
      <div class="g-letters">${LETTERS.map((c) => html`<button class=${c === letter ? 'on' : ''} onClick=${() => setLetter(c)}>${c}</button>`)}</div>
      <${ArtistList} letter=${letter} onPick=${setArtist} />
    </div>`;
  } else if (chip === 'popular') {
    body = html`<${Results} deps=${['popular']} empty="No songs yet" load=${(offset) => api('/api/browse/popular', { params: { offset, limit: page, fits: 1 } })} />`;
  } else {
    body = html`<${Results} deps=${[chip]} empty="No songs" load=${(offset) => api(`/api/browse/tag/${encodeURIComponent(chip)}`, { params: { offset, limit: page, fits: 1 } })} />`;
  }
  return html`<div class="g-page">
    <div class="g-search">
      <${Icon} name="search" size=${20} />
      <input ref=${input} type="search" enterkeyhint="search" placeholder="Song or artist…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} autocomplete="off" autocorrect="off" spellcheck=${false} />
      ${q && html`<button class="btn icon small ghost" onClick=${() => { setQ(''); input.current?.focus(); }}><${Icon} name="x" size=${16} /></button>`}
    </div>
    ${!dq && html`<div class="g-chips">
      <button class=${`chip${chip === 'popular' ? ' on' : ''}`} onClick=${() => setChip('popular')}>🔥 Popular</button>
      <button class=${`chip${chip === 'artists' ? ' on' : ''}`} onClick=${() => { setChip('artists'); setArtist(null); }}>🎤 Artists</button>
      ${tags.map((t) => html`<button key=${t.tag} class=${`chip${chip === t.tag ? ' on' : ''}`} onClick=${() => setChip(t.tag)}>${t.tag}</button>`)}
    </div>`}
    ${body}
  </div>`;
}

function ArtistList({ letter, onPick }) {
  const { data } = useAsync((signal) => api('/api/artists', { params: { letter, limit: 600 }, signal }), [letter]);
  if (!data) return html`<div class="center pad"><${Spinner} /></div>`;
  if (!data.items.length) return html`<div class="empty">No artists under ${letter}</div>`;
  return html`<div class="g-list">${data.items.map((a) => html`<button key=${a.key} class="g-artist" onClick=${() => onPick(a)}>
    <img src=${`/api/art/artist/${encodeURIComponent(a.key)}`} alt="" loading="lazy" />
    <span class="grow"><b>${a.name}</b></span><span class="dim">${a.count}</span><${Icon} name="chevron" size=${16} />
  </button>`)}</div>`;
}

// ---- song sheet ---------------------------------------------------------------------------

export function SongSheet() {
  const song = useStore(store, (s) => s.sheet);
  if (!song) return null;
  return html`<${SheetInner} key=${song.id} song=${song} />`;
}

function SheetInner({ song }) {
  const st = useStore(store, (s) => s.state);
  const { data } = useAsync((signal) => api(`/api/songs/${song.id}`, { signal }), [song.id]);
  const [key, setKey] = useState(0);
  const [trackId, setTrackId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const close = () => store.set({ sheet: null });
  const rules = st.rules;
  const favs = st.me?.profile?.favorites || [];
  const fav = favs.includes(song.id);
  const mine = st.me.entries.length;
  const limitReached = rules.maxPerGuest > 0 && mine >= rules.maxPerGuest;
  const sing = async () => {
    setBusy(true);
    setError('');
    const payload = { songId: song.id };
    if (rules.guestKeyChange && key) payload.key = key;
    if (trackId) payload.trackId = trackId;
    const r = await act('queue.add', payload);
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.error);
  };
  const versions = data?.versions || [];
  const s = data || song;
  return html`<div class="sheet-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) close(); }}>
    <div class="sheet" role="dialog">
      <div class="grabber"></div>
      ${result ? html`<div class="sheet-done">
        <div class="big-emoji">${result.pending ? '📨' : result.started ? '🎤' : '🎉'}</div>
        <h2>${result.pending ? 'Request sent!' : result.started ? 'You’re on — grab the mic!' : 'You’re in the queue!'}</h2>
        <p class="muted">${result.pending ? 'The host will approve your song soon.' : result.started ? 'Your song starts in a few seconds.' : `You’re #${(result.index ?? 0) + 1} in the queue${result.eta != null ? ` · ${formatEta(result.eta)}` : ''}.`}</p>
        <p><b>${s.title}</b><br /><span class="muted">${s.artist}</span></p>
        <div class="row" style=${{ gap: '10px' }}>
          <button class="btn block" onClick=${() => { close(); setTab('queue'); }}>See the queue</button>
          <button class="btn primary block" onClick=${close}>Done</button>
        </div>
      </div>` : html`
        <div class="sheet-head">
          <${Cover} song=${s} size=${96} big=${true} />
          <div class="grow">
            <h2>${s.title}</h2>
            <div class="muted">${s.artist}</div>
            <div class="row" style=${{ gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
              ${s.dur ? html`<span class="tag">${formatDuration(s.dur)}</span>` : null}
              ${(data?.tags || []).slice(0, 3).map((t) => html`<span class="tag">${t}</span>`)}
              ${s.x ? html`<span class="tag x">Explicit</span>` : null}
            </div>
          </div>
          <button class=${`btn icon ghost fav${fav ? ' on' : ''}`} title="Favourite" onClick=${() => act('favorite.toggle', { songId: song.id })}><${Icon} name="heart" size=${22} /></button>
        </div>
        ${versions.length > 1 && html`<label class="g-field"><span>Version</span>
          <select class="input" value=${trackId || data.best} onChange=${(e) => setTrackId(e.currentTarget.value)}>
            ${versions.map((v) => html`<option value=${v.id}>${v.brandName || v.brand || 'Karaoke'}${v.variant ? ` — ${v.variant}` : ''} (${formatDuration(v.dur)})</option>`)}
          </select></label>`}
        ${rules.guestKeyChange && html`<div class="g-field"><span>Key</span>
          <div class="stepper">
            <button class="btn icon" onClick=${() => setKey((k) => Math.max(-3, k - 1))} aria-label="Lower"><${Icon} name="minus" size=${18} /></button>
            <b>${key === 0 ? 'Original' : formatKey(key)}</b>
            <button class="btn icon" onClick=${() => setKey((k) => Math.min(3, k + 1))} aria-label="Higher"><${Icon} name="plus" size=${18} /></button>
          </div></div>`}
        ${error && html`<div class="g-error">${error}</div>`}
        ${limitReached && !error && html`<div class="g-error">You already have ${mine} song${mine > 1 ? 's' : ''} in the queue (limit ${rules.maxPerGuest}).</div>`}
        <button class="btn primary big block" disabled=${busy || limitReached} onClick=${sing}>🎤 ${busy ? 'Adding…' : 'Sing it!'}</button>
        <button class="btn ghost block" style=${{ marginTop: '6px' }} onClick=${close}>Cancel</button>
      `}
    </div>
  </div>`;
}
