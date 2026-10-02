// Host main views: home, search, artists, artist page, collections, tag, favourites,
// singers & guests, history.
import { html, useEffect, useMemo, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural, singersText, useDebounced, artistArtUrl, artStore } from '../lib/store.js';
import { SongRow, Cover, Avatar, Empty, Spinner, MoreSentinel, usePaged, useFetch, go, ArtistImage } from '../lib/components.js';
import { store, act, openDialog, toast, chooseFolder } from './state.js';
import { openTvWindow, openInvite } from './player.js';
import { AVATARS } from '/shared/protocol.js';

/** Queue + favourite buttons at the end of a song row. */
function RowActions({ song }) {
  const { state } = useStore(store);
  const fav = state?.favorites.includes(song.id);
  return html`
    <button class=${`icon-btn small ${fav ? 'active' : ''}`} aria-label=${fav ? 'Remove from favourites' : 'Add to favourites'} title="Favourite"
      onClick=${() => act('favorite.toggle', { songId: song.id })}><${Icon} name=${fav ? 'starFill' : 'star'} size=${18} /></button>
    <button class="btn small primary" onClick=${() => openDialog({ type: 'add', songId: song.id })}><${Icon} name="plus" size=${16} /> Queue</button>`;
}

export function SongList({ items, empty }) {
  if (!items.length) return empty || null;
  return html`<div class="song-list">${items.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => openDialog({ type: 'song', songId: s.id })}><${RowActions} song=${s} /></${SongRow}>`)}</div>`;
}

function PagedSongs({ path, params, empty }) {
  const page = usePaged(path, params);
  if (page.error) return html`<p class="warn-text">${page.error.message}</p>`;
  if (!page.items.length && page.loading) return html`<${Spinner} />`;
  return html`<${SongList} items=${page.items} empty=${empty} /><${MoreSentinel} active=${page.hasMore} onMore=${page.more} />`;
}

function PageHead({ title, sub, children }) {
  return html`<header class="page-head"><div><h1>${title}</h1>${sub && html`<p class="muted">${sub}</p>`}</div><div class="page-actions">${children}</div></header>`;
}

// ---- home ---------------------------------------------------------------------------

function Onboarding() {
  const pick = () => chooseFolder((p) => act('library.paths', { paths: [p] }).then((r) => r && toast('Scanning your library…', 'ok')));
  return html`<section class="hero-card">
    <div class="hero-emoji">💾</div>
    <div>
      <h2>Add your karaoke songs</h2>
      <p class="muted">Pick the folder with your CDG+MP3 or video files — for example the karaoke folder on your USB drive. Sub-folders are included. The first scan of a big drive takes a few minutes; the songs appear when it's done.</p>
      <button class="btn primary large" onClick=${pick}><${Icon} name="folder" /> Choose folder</button>
    </div>
  </section>`;
}

function ScanCard({ lib, progress }) {
  return html`<section class="hero-card slim">
    <div class="spinner"></div>
    <div><h3>Scanning your library…</h3><p class="muted">${progress ? `${progress.tracks.toLocaleString()} tracks found in ${progress.dirs.toLocaleString()} folders so far.` : 'Starting…'} ${lib.tracks ? `${lib.tracks.toLocaleString()} tracks are already searchable.` : ''}</p></div>
  </section>`;
}

function Stat({ value, label }) {
  return html`<div class="stat"><b class="num">${value}</b><span>${label}</span></div>`;
}

function SongCards({ items }) {
  return html`<div class="card-grid">${items.map((s) => html`<div class="song-card" key=${s.id}>
    <button class="song-card-art" onClick=${() => openDialog({ type: 'song', songId: s.id })} aria-label=${`${s.title} by ${s.artist}`}>
      <${Cover} songId=${s.id} size=${160} big />
    </button>
    <div class="song-card-text">
      <div class="ellipsis song-title">${s.title}</div>
      <div class="ellipsis song-artist">${s.artist}</div>
    </div>
    <button class="icon-btn small add" aria-label=${`Queue ${s.title}`} onClick=${() => openDialog({ type: 'add', songId: s.id })}><${Icon} name="plus" size=${18} /></button>
  </div>`)}</div>`;
}

export function Home() {
  const { state, lib } = useStore(store);
  const popular = useFetch('/api/browse/popular', { limit: 12 });
  const mostSung = useFetch('/api/browse/popular', { sort: 'plays', limit: 6 });
  const facets = useFetch('/api/browse/facets');
  const [seed, setSeed] = useState(0);
  const random = useFetch('/api/random', { n: 6, seed }, { ttl: 0 });
  const library = state.library;
  const noFolder = !library.roots.length;
  const online = state.guests.filter((g) => g.online).length;
  return html`<div class="page home">
    <${PageHead} title=${state.info.name} sub=${state.current ? `Now singing: ${singersText(state.current.singers) || 'someone'} with ${state.current.title}` : 'The party is ready. Guests can join with the code on the TV.'}>
      <button class="btn" onClick=${openInvite}><${Icon} name="qr" size=${18} /> Invite guests</button>
      <button class="btn" onClick=${() => openDialog({ type: 'announce' })}><${Icon} name="megaphone" size=${18} /> Announce</button>
      <button class="btn" onClick=${openTvWindow}><${Icon} name="tv" size=${18} /> Open TV display</button>
    </${PageHead}>
    ${noFolder && html`<${Onboarding} />`}
    ${library.scanning && html`<${ScanCard} lib=${library} progress=${lib} />`}
    ${library.offline && !noFolder && html`<section class="banner warn"><${Icon} name="alert" /> <div><b>The karaoke drive is not connected.</b> Plug it in — OpenKaraoke notices within 20 seconds. Songs from it can't play until then.</div></section>`}
    <div class="stats">
      <${Stat} value=${state.tonight.songs} label="songs sung tonight" />
      <${Stat} value=${state.queue.length} label="in the queue" />
      <${Stat} value=${state.singers.length} label="singers" />
      <${Stat} value=${online} label="phones connected" />
      <${Stat} value=${library.songs.toLocaleString()} label="songs in the library" />
    </div>
    ${popular.data?.items.length > 0 && html`<section>
      <h2 class="section-title">Popular in your library</h2>
      <${SongCards} items=${popular.data.items} />
    </section>`}
    ${mostSung.data?.items.length > 0 && html`<section>
      <h2 class="section-title">Most sung here</h2>
      <${SongList} items=${mostSung.data.items} />
    </section>`}
    ${facets.data?.tags.length > 0 && html`<section>
      <h2 class="section-title">Collections</h2>
      <div class="chips">${facets.data.tags.slice(0, 16).map((t) => html`<a class="chip" href=${`#/tag/${encodeURIComponent(t.tag)}`}>${t.tag} <span class="faint">${t.count.toLocaleString()}</span></a>`)}</div>
    </section>`}
    ${facets.data?.genres?.length > 0 && html`<section>
      <h2 class="section-title">Genres & decades</h2>
      <${GenreChips} facets=${facets.data} />
    </section>`}
    ${random.data?.items.length > 0 && html`<section>
      <h2 class="section-title with-action">Random picks <button class="btn small ghost" onClick=${() => setSeed((x) => x + 1)}><${Icon} name="refresh" size=${16} /> Shuffle</button></h2>
      <${SongList} items=${random.data.items} />
    </section>`}
  </div>`;
}

export const decadeLabel = (d) => (d >= 2000 ? `${d}s` : `’${String(d).slice(2)}s`);

function GenreChips({ facets, limit = 12 }) {
  return html`<div class="chips">
    ${facets.genres.slice(0, limit).map((g) => html`<a class="chip" href=${`#/genre/${encodeURIComponent(g.genre)}`}>${g.genre} <span class="faint">${g.count.toLocaleString()}</span></a>`)}
    ${facets.decades.map((d) => html`<a class="chip" href=${`#/decade/${d.decade}`}>${decadeLabel(d.decade)} <span class="faint">${d.count.toLocaleString()}</span></a>`)}
  </div>`;
}

// ---- search -------------------------------------------------------------------------------

export function Search({ q }) {
  const query = useDebounced(q, 120);
  const artists = useFetch(query.trim().length >= 2 ? '/api/artists' : null, { q: query, sort: 'count', limit: 8 });
  const page = usePaged(query.trim() ? '/api/search' : null, { q: query });
  if (!q.trim()) {
    return html`<div class="page"><${Empty} icon="🔎" title="Search the library">Type a song title or an artist in the search box. Small typos are fine.</${Empty}></div>`;
  }
  return html`<div class="page">
    <${PageHead} title=${`Results for “${q}”`} sub=${page.loading && !page.items.length ? 'Searching…' : `${plural(page.total, 'song')}${page.meta.fuzzy ? ' (including close matches)' : ''}`} />
    ${artists.data?.items.length > 0 && html`<div class="chips artist-chips">${artists.data.items.map((a) => html`<a class="chip" href=${`#/artist/${encodeURIComponent(a.key)}`}><${Icon} name="user" size=${14} /> ${a.name} <span class="faint">${a.count}</span></a>`)}</div>`}
    ${page.error && html`<p class="warn-text">${page.error.message}</p>`}
    <${SongList} items=${page.items} empty=${!page.loading && html`<${Empty} icon="🤷" title="No songs found">Check the spelling, or try just the artist or a few words of the title.</${Empty}>`} />
    <${MoreSentinel} active=${page.hasMore} onMore=${page.more} />
  </div>`;
}

// ---- artists ------------------------------------------------------------------------------------

export function Artists({ letter = 'A' }) {
  const facets = useFetch('/api/browse/facets');
  const [filter, setFilter] = useState('');
  const f = useDebounced(filter, 150);
  const page = usePaged('/api/artists', f ? { q: f } : { letter }, 400);
  const letters = facets.data?.letters || [];
  return html`<div class="page">
    <${PageHead} title="Artists" sub=${f ? `${plural(page.total, 'artist')} matching “${f}”` : `${plural(page.total, 'artist')} under ${letter}`}>
      <input class="input narrow" placeholder="Filter artists" value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} aria-label="Filter artists" />
    </${PageHead}>
    <nav class="letters" aria-label="First letter">${letters.map((l) => html`<a class=${`letter ${l.letter === letter && !f ? 'on' : ''} ${l.artists ? '' : 'none'}`} href=${`#/artists/${encodeURIComponent(l.letter)}`} onClick=${() => setFilter('')}>${l.letter}</a>`)}</nav>
    <div class="artist-grid">${page.items.map((a) => html`<a class="artist-tile" href=${`#/artist/${encodeURIComponent(a.key)}`} key=${a.key}>
      <${ArtistImage} artistKey=${a.key} size=${44} />
      <span class="ellipsis">${a.name}</span><small class="faint">${plural(a.count, 'song')}</small>
    </a>`)}</div>
    ${!page.items.length && !page.loading && html`<${Empty} icon="🎙️" title="No artists here" />`}
    <${MoreSentinel} active=${page.hasMore} onMore=${page.more} />
  </div>`;
}

export function Artist({ artistKey }) {
  useStore(artStore);
  const { data, error, loading, reload } = useFetch(`/api/artists/${encodeURIComponent(artistKey)}`);
  // The first visit asks TheAudioDB for fanart and logos: reload the header when they arrive.
  useEffect(() => artStore.subscribe((ev) => { if (ev.all || ev.artists.includes(artistKey)) reload(); }), [artistKey]);
  // A known logo can still fail to load (dead link, no internet): then the name as text.
  const [badLogo, setBadLogo] = useState('');
  if (error) return html`<div class="page"><${Empty} icon="🤷" title="Artist not found">${error.message}</${Empty}></div>`;
  if (!data || (loading && !data)) return html`<div class="page"><${Spinner} /></div>`;
  const art = data.artist.art || {};
  const logo = art.logo ? artistArtUrl(artistKey, 'logo', { size: 500 }) : '';
  return html`<div class="page">
    <header class=${`artist-head ${art.fanart ? 'with-fanart' : ''}`}>
      ${art.fanart > 0 && html`<div class="artist-fanart" style=${{ backgroundImage: `url(${artistArtUrl(artistKey, 'fanart', { size: 1000 })})` }}></div>`}
      <${ArtistImage} artistKey=${artistKey} size=${132} />
      <div class="artist-head-text">
        <p class="muted">Artist${art.genre ? ` · ${art.genre}` : ''}</p>
        ${logo && logo !== badLogo
          ? html`<h1 class="artist-logo"><img src=${logo} alt=${data.artist.name} onError=${() => setBadLogo(logo)} /></h1>`
          : html`<h1>${data.artist.name}</h1>`}
        <p class="muted">${plural(data.songs.length, 'song')}</p>
      </div>
    </header>
    <${SongList} items=${data.songs} />
  </div>`;
}

// ---- collections -----------------------------------------------------------------------------

export function Collections() {
  const { data } = useFetch('/api/browse/facets', null, { ttl: 3000 }); // genres fill in while the library is looked up
  if (!data) return html`<div class="page"><${Spinner} /></div>`;
  return html`<div class="page">
    <${PageHead} title="Collections" sub="Groups found in your file names: duets, languages, holidays, musicals and more." />
    <div class="tag-grid">${data.tags.map((t) => html`<a class="tag-tile" href=${`#/tag/${encodeURIComponent(t.tag)}`}><b>${t.tag}</b><span class="faint">${plural(t.count, 'song')}</span></a>`)}</div>
    ${!data.tags.length && html`<${Empty} icon="🏷️" title="No collections yet">Collections appear once the library is scanned.</${Empty}>`}
    <h2 class="section-title">Genres</h2>
    ${data.genres?.length
      ? html`<div class="tag-grid">${data.genres.map((g) => html`<a class="tag-tile genre" href=${`#/genre/${encodeURIComponent(g.genre)}`}><b>${g.genre}</b><span class="faint">${plural(g.count, 'song')}</span></a>`)}</div>`
      : html`<p class="muted">Genres and decades come from the online song information — they fill in while OpenKaraoke looks up your library (Settings → Artwork).</p>`}
    ${data.decades?.length > 0 && html`<h2 class="section-title">Decades</h2>
      <div class="tag-grid decades">${data.decades.map((d) => html`<a class="tag-tile decade" href=${`#/decade/${d.decade}`}><b>${decadeLabel(d.decade)}</b><span class="faint">${plural(d.count, 'song')}</span></a>`)}</div>`}
    ${data.brands?.length > 0 && html`<h2 class="section-title">Karaoke labels</h2>
      <div class="chips">${data.brands.slice(0, 40).map((b) => html`<span class="chip static" title=${b.name}>${b.brand} <span class="faint">${b.count.toLocaleString()}</span></span>`)}</div>`}
  </div>`;
}

export function Tag({ tag, sort }) {
  return html`<div class="page">
    <${PageHead} title=${tag}>
      <div class="segmented">
        <a class=${sort !== 'title' ? 'on' : ''} href=${`#/tag/${encodeURIComponent(tag)}`}>Popular</a>
        <a class=${sort === 'title' ? 'on' : ''} href=${`#/tag/${encodeURIComponent(tag)}?sort=title`}>A–Z</a>
      </div>
    </${PageHead}>
    <${PagedSongs} path=${`/api/browse/tag/${encodeURIComponent(tag)}`} params=${{ sort: sort || 'popular' }} />
  </div>`;
}

/** Songs of one genre or decade (from online metadata), most popular first. */
export function Browse({ genre, decade }) {
  const title = genre || decadeLabel(Number(decade));
  return html`<div class="page">
    <${PageHead} title=${title} sub=${genre ? 'Genre' : 'Songs released in this decade'} />
    <${PagedSongs} path="/api/browse/popular" params=${genre ? { genre } : { decade }}
      empty=${html`<${Empty} icon="🎼" title="No songs here yet">More appear while the library is looked up online.</${Empty}>`} />
  </div>`;
}

// ---- favourites ---------------------------------------------------------------------------------

export function Favorites() {
  const { state } = useStore(store);
  const ids = state.favorites;
  const { data, error, reload } = useFetch(ids.length ? '/api/songs' : null, { ids: ids.join(',') }, { ttl: 0 });
  const byId = data && new Map(data.items.map((s) => [s.id, s]));
  return html`<div class="page">
    <${PageHead} title="Favourites" sub=${ids.length ? plural(ids.length, 'song') : ''} />
    ${!ids.length && html`<${Empty} icon="⭐" title="No favourites yet">Press the star next to a song to keep it here for quick access.</${Empty}>`}
    ${ids.length > 0 && error && html`<${Empty} icon="⚠️" title="Couldn’t load the songs">${error.message} <button class="btn small" onClick=${reload}><${Icon} name="refresh" size=${16} /> Try again</button></${Empty}>`}
    ${ids.length > 0 && !error && (byId ? html`<${SongList} items=${ids.map((id) => byId.get(id)).filter(Boolean)} />` : html`<${Spinner} />`)}
  </div>`;
}

// ---- singers & guests -----------------------------------------------------------------------------

function SingerRow({ s }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [emoji, setEmoji] = useState(s.emoji);
  const save = async () => {
    if (await act('singer.update', { singerId: s.id, name, emoji })) setEditing(false);
  };
  if (editing) {
    return html`<tr><td colspan="6"><div class="inline-form">
      <select class="select emoji-select" value=${emoji} onChange=${(e) => setEmoji(e.currentTarget.value)} aria-label="Avatar">${AVATARS.map((a) => html`<option value=${a}>${a}</option>`)}</select>
      <input class="input" value=${name} maxlength="40" onInput=${(e) => setName(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} aria-label="Name" />
      <button class="btn primary small" onClick=${save}>Save</button><button class="btn ghost small" onClick=${() => setEditing(false)}>Cancel</button>
    </div></td></tr>`;
  }
  return html`<tr>
    <td class="lead"><div class="who"><${Avatar} singer=${s} size=${30} /> <b>${s.name}</b></div></td>
    <td class="num" data-label="Sung">${s.sung}</td>
    <td class="num" data-label="Rating">${s.stars ? html`<span class="stars" title="Average rating from guests">★ ${s.stars.toFixed(1)}</span>` : html`<span class="faint">—</span>`}</td>
    <td class="num" data-label="Queued">${s.queued}</td>
    <td>${s.deviceId ? html`<span class=${`dot ${s.online ? 'on' : ''}`}></span> ${s.online ? 'Connected' : 'Phone offline'}` : html`<span class="faint">Added by host</span>`}</td>
    <td class="actions">
      <button class="icon-btn small" aria-label=${`Edit ${s.name}`} onClick=${() => setEditing(true)}><${Icon} name="edit" size=${16} /></button>
      <button class="icon-btn small" aria-label=${`Remove ${s.name}`} onClick=${() => confirm(`Remove ${s.name}? Their queued songs stay, without a singer.`) && act('singer.remove', { singerId: s.id })}><${Icon} name="trash" size=${16} /></button>
    </td>
  </tr>`;
}

export function Singers() {
  const { state } = useStore(store);
  const [name, setName] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await act('singer.add', { name })) setName('');
  };
  const sorted = useMemo(() => [...state.singers].sort((a, b) => b.sung - a.sung || a.name.localeCompare(b.name)), [state.singers]);
  return html`<div class="page">
    <${PageHead} title="Singers" sub="Everyone who has sung or queued tonight. Guests appear when they join from their phone.">
      <form class="inline-form" onSubmit=${add}>
        <input class="input" placeholder="Add a singer without a phone" value=${name} maxlength="40" onInput=${(e) => setName(e.currentTarget.value)} />
        <button class="btn primary">Add</button>
      </form>
    </${PageHead}>
    ${sorted.length
      ? html`<table class="table stack"><thead><tr><th>Singer</th><th class="num">Sung tonight</th><th class="num">Rating</th><th class="num">Queued</th><th>Phone</th><th></th></tr></thead>
        <tbody>${sorted.map((s) => html`<${SingerRow} key=${s.id} s=${s} />`)}</tbody></table>`
      : html`<${Empty} icon="🎤" title="No singers yet">Add names here, type a name when you queue a song, or invite guests to join from their phones.</${Empty}>`}
    <h2 class="section-title">Guests' phones</h2>
    ${state.guests.length
      ? html`<table class="table stack"><thead><tr><th>Guest</th><th>Status</th><th class="num">Songs waiting</th><th></th></tr></thead><tbody>
        ${state.guests.map((g) => html`<tr>
          <td class="lead"><div class="who"><${Avatar} singer=${g} size=${30} /> <b>${g.name}</b></div></td>
          <td>${g.banned ? html`<span class="pill bad">Removed</span>` : html`<span class=${`dot ${g.online ? 'on' : ''}`}></span> ${g.online ? 'Connected' : 'Offline'}`}</td>
          <td class="num" data-label="Songs waiting">${g.queued}</td>
          <td class="actions">${!g.banned && html`<button class=${`btn small ${g.coHost ? 'on' : 'ghost'}`} title="A co-host can run the player and approve requests from their phone"
              onClick=${() => act('guest.cohost', { deviceId: g.deviceId, on: !g.coHost }).then((r) => r && toast(r.coHost ? `${g.name} is now a co-host` : `${g.name} is no longer a co-host`, 'ok'))}>${g.coHost ? '★ Co-host' : 'Make co-host'}</button>`}
            ${g.banned
            ? html`<button class="btn small ghost" onClick=${() => act('guest.unban', { deviceId: g.deviceId })}>Let back in</button>`
            : html`<button class="btn small ghost danger" onClick=${() => confirm(`Remove ${g.name} from the party? Their queued songs are removed too.`) && act('guest.ban', { deviceId: g.deviceId })}>Remove</button>`}</td>
        </tr>`)}</tbody></table>`
      : html`<p class="muted">No guests have joined yet. <button class="link" onClick=${openInvite}>Show the invite code</button></p>`}
  </div>`;
}

// ---- history ---------------------------------------------------------------------------------------

export function History() {
  const { state } = useStore(store);
  const [items, setItems] = useState(null);
  useEffect(() => { act('history.list').then((r) => r && setItems(r.items)); }, [state.tonight.history.length]);
  const list = items || state.tonight.history;
  return html`<div class="page">
    <${PageHead} title="Tonight's history" sub=${`${plural(state.tonight.songs, 'song')} sung since ${new Date(state.session.startedAt).toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`}>
      <button class="btn ghost" onClick=${() => confirm('Start a new party? Tonight’s song counts and history reset; the queue and singers stay.') && act('party.new').then((r) => r && toast('New party started', 'ok'))}><${Icon} name="sparkles" size=${16} /> New party</button>
    </${PageHead}>
    ${list.length
      ? html`<table class="table stack"><thead><tr><th>Time</th><th>Singer</th><th>Song</th><th></th><th></th></tr></thead><tbody>
        ${list.map((h) => html`<tr>
          <td class="num faint">${new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
          <td>${h.singers.join(' & ') || html`<span class="faint">—</span>`}</td>
          <td class="lead"><b>${h.title}</b> <span class="faint">${h.artist}</span></td>
          <td>${h.skipped ? html`<span class="pill">Skipped</span>` : ''}${h.key ? html` <span class="pill">Key ${h.key > 0 ? '+' : ''}${h.key}</span>` : ''}${h.rating ? html` <span class="pill bulb" title=${`${h.rating.n} ${h.rating.n === 1 ? 'vote' : 'votes'}`}>★ ${h.rating.avg.toFixed(1)}</span>` : ''}${h.game ? html` <span class="pill">${h.game}</span>` : ''}</td>
          <td class="actions"><button class="btn small" onClick=${() => openDialog({ type: 'add', songId: h.songId, singerName: h.singers[0] || '' })}>Queue again</button></td>
        </tr>`)}</tbody></table>`
      : html`<${Empty} icon="🕘" title="Nothing sung yet tonight" />`}
  </div>`;
}

