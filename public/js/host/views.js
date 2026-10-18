// Host main views: home, search, artists, artist page, collections, tag, favourites,
// singers & guests, history.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural, singersText, useDebounced, artistArtUrl, artStore } from '../lib/store.js';
import { SongRow, SongBadges, Cover, Avatar, Empty, Spinner, MoreSentinel, usePaged, useFetch, go, ArtistImage, apiPost } from '../lib/components.js';
import { store, act, openDialog, toast, chooseFolder } from './state.js';
import { openTvWindow, openInvite } from './player.js';
import { GuestButtons } from './devices.js';
import { AVATARS } from '/shared/protocol.js';
import { readFilters, filterParams, filterCount, emptyFilters, TABLE_COLUMNS, CHECK_KINDS, CHECK_REASONS } from '/shared/filters.js';
import { FilterPanel } from '../lib/filters.js';

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

/** A big library's catalog, read from the last scan just after the start (a few seconds). */
function LoadCard() {
  return html`<section class="hero-card slim">
    <div class="spinner"></div>
    <div><h3>Loading your library…</h3><p class="muted">Songs can be searched in a few seconds.</p></div>
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
    ${library.loading ? html`<${LoadCard} />` : library.scanning && html`<${ScanCard} lib=${library} progress=${lib} />`}
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
    <${PageHead} title="Collections" sub="Groups found in your file names: duets, languages, holidays, musicals and more.">
      <a class="btn" href="#/browse"><${Icon} name="list" size=${16} /> Browse with filters</a>
    </${PageHead}>
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

/**
 * Browse with filters: the songs with one of the chosen decades, genres, collections and version
 * types in each group (shared/filters.js), as a list (most popular first) or as the Library
 * table (PLAN §26: every song, sorted by a column, narrowed by a text too). Everything is in the
 * address (#/browse?decade=1980&tag=Duets&view=table&sort=year&dir=desc&q=love), so Back, a
 * reload and a bookmark keep it.
 */
export function BrowseFilters({ query, narrow }) {
  const facets = useFetch('/api/browse/facets', null, { ttl: 3000 }); // genres fill in while the library is looked up
  const filters = readFilters(query);
  const n = filterCount(filters);
  const table = query.get('view') === 'table';
  const sort = TABLE_COLUMNS.some((c) => c.id === query.get('sort')) ? query.get('sort') : 'artist';
  const dir = query.get('dir') === 'desc' ? 'desc' : 'asc';
  const q = (query.get('q') || '').slice(0, 100);
  const check = CHECK_KINDS.includes(query.get('check')) ? query.get('check') : ''; // the year & genre checker
  // A new address from the current one with some parts changed (defaults left out).
  const go = (patch) => {
    const next = { filters, table, sort, dir, q, check, ...patch };
    const qs = new URLSearchParams();
    for (const [k, vs] of Object.entries(filterParams(next.filters))) for (const v of vs) qs.append(k, v);
    if (next.table) qs.set('view', 'table');
    if (next.table && next.sort !== 'artist') qs.set('sort', next.sort);
    if (next.table && next.dir === 'desc') qs.set('dir', 'desc');
    if (next.table && next.q.trim()) qs.set('q', next.q.trim());
    if (next.table && next.check) qs.set('check', next.check);
    const str = qs.toString();
    location.replace(`#/browse${str ? `?${str}` : ''}`);
  };
  const setFilters = (f) => go({ filters: f });
  return html`<div class="page">
    <${PageHead} title="Browse" sub=${table
      ? 'Every song in the library: sort by any column, narrow it with the filters or a few words.'
      : 'The most popular songs that match. Pick as many as you like: a song needs one of them in each group.'}>
      <div class="segmented" role="group" aria-label="Show as">
        <button class=${table ? '' : 'on'} aria-pressed=${!table} onClick=${() => go({ table: false })}><${Icon} name="list" size=${15} /> List</button>
        <button class=${table ? 'on' : ''} aria-pressed=${table} onClick=${() => go({ table: true })}><${Icon} name="table" size=${15} /> Table</button>
      </div>
    </${PageHead}>
    <div class=${`browse-layout ${table ? 'table' : ''}`}>
      <details class="browse-filters" open=${!narrow && !table} key=${table ? 't' : 'l'}>
        <summary>Filters${n ? html` <span class="badge neon">${n}</span>` : ''}</summary>
        <${FilterPanel} facets=${facets.data} value=${filters} onChange=${setFilters}
          metaHint="Decades and genres come from the online song information — they fill in while OpenKaraoke looks up your library (Settings → Artwork)." />
      </details>
      ${table
        ? html`<${LibraryTable} filters=${filters} n=${n} sort=${sort} dir=${dir} q=${q} check=${check} go=${go} genres=${facets.data?.genres || []} />`
        : html`<${BrowseList} filters=${filters} n=${n} setFilters=${setFilters} />`}
    </div>
  </div>`;
}

function BrowseList({ filters, n, setFilters }) {
  const page = usePaged('/api/browse/popular', filterParams(filters));
  return html`<section class="browse-results" aria-label="Songs">
    <p class="muted browse-count">${page.loading && !page.items.length ? 'Looking…' : n ? plural(page.total, 'song') : `All ${plural(page.total, 'song')}, most popular first`}
      ${n > 0 && html` · <button class="link" onClick=${() => setFilters(emptyFilters())}>Clear filters</button>`}</p>
    ${page.error && html`<p class="warn-text">${page.error.message}</p>`}
    <${SongList} items=${page.items} empty=${!page.loading && !page.error && html`<${Empty} icon="🎚️" title="No songs match all of these">Take a filter or two away.</${Empty}>`} />
    <${MoreSentinel} active=${page.hasMore && !page.error} onMore=${page.more} />
  </section>`;
}

const CHECK_COLUMNS = ['title', 'artist', 'year', 'genre']; // the checker's sortable columns

/**
 * The Library table: one row per song, every column sorts (a click on the sorted one turns it
 * around), 100 rows at a time as you scroll. The text box narrows it by words in the title or
 * artist and keeps the column order (the top search ranks by relevance instead). "Show" switches
 * to the year & genre checker (PLAN §27): only the songs that need a look, why, and how to fix it.
 */
function LibraryTable({ filters, n, sort, dir, q, check, go, genres }) {
  const [text, setText] = useState(q);
  const typed = useDebounced(text, 250);
  useEffect(() => { if (typed.trim() !== q) go({ q: typed }); }, [typed]);
  useEffect(() => { if (q !== text.trim()) setText(q); }, [q]); // Back, or Clear
  const params = { ...filterParams(filters), sort, dir, q, check: check || undefined };
  const [round, setRound] = useState(0); // "Accept all" loads the list again
  const page = usePaged('/api/library/songs', { ...params, round }, 100);
  const sortBy = (c) => go(c.id === sort ? { dir: dir === 'asc' ? 'desc' : 'asc' } : { sort: c.id, dir: c.first });
  const narrowed = n > 0 || !!q;
  const columns = check ? TABLE_COLUMNS.filter((c) => CHECK_COLUMNS.includes(c.id)) : TABLE_COLUMNS;
  const acceptAll = async () => {
    const res = await apiPost('/api/library/meta/accept', params).catch((e) => toast(e.message, 'error'));
    if (!res) return;
    toast(res.changed ? `${plural(res.changed, 'song')} changed — undo each one in its row.` : 'Nothing to change.', 'ok');
    setRound((x) => x + 1);
  };
  const count = check ? (narrowed ? `${plural(page.total, 'song')} to check` : `${plural(page.total, 'song')} to check in the library`)
    : narrowed ? plural(page.total, 'song') : `All ${plural(page.total, 'song')}`;
  return html`<section class=${`browse-results lib ${check ? 'checking' : ''}`} aria-label="Library">
    <div class="lib-tools">
      <label class="lib-text"><${Icon} name="search" size=${16} />
        <input type="search" placeholder="Filter by artist or title" aria-label="Filter by artist or title" value=${text}
          onInput=${(e) => setText(e.currentTarget.value)} /></label>
      <label class="lib-show"><span class="muted">Show</span>
        <select class="select" aria-label="Show" value=${check} onChange=${(e) => go({ check: e.currentTarget.value, ...(e.currentTarget.value && !CHECK_COLUMNS.includes(sort) ? { sort: 'artist', dir: 'asc' } : {}) })}>
          <option value="">Every song</option>
          <option value="any">Years and genres to check</option>
          <option value="year">Years to check</option>
          <option value="genre">Genres to check</option>
        </select></label>
      <p class="muted browse-count">${page.loading && !page.items.length ? 'Looking…' : count}
        ${narrowed && html` · <button class="link" onClick=${() => { setText(''); go({ filters: emptyFilters(), q: '' }); }}>Clear</button>`}</p>
      ${check && page.meta.suggested > 0 && html`<button class="btn small" onClick=${acceptAll}><${Icon} name="check" size=${15} /> Use all ${plural(page.meta.suggested, 'suggestion')}</button>`}
    </div>
    ${check && html`<p class="hint lib-check-hint">Years and genres come from the online song information: a compilation or a remaster often shows a later year. Click a year or genre to change it, or press Right when it is right as it is. Yours are kept, and win over the online ones everywhere.</p>`}
    ${page.error && html`<p class="warn-text">${page.error.message}</p>`}
    <div class="lib-wrap">
      <table class="lib-table">
        <thead><tr>
          ${columns.map((c) => html`<th key=${c.id} class=${`col-${c.id} ${c.num ? 'num' : ''}`} aria-sort=${c.id === sort ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} title=${c.hint || undefined}>
            <button onClick=${() => sortBy(c)}>${c.label}${c.id === sort ? html` <${Icon} name=${dir === 'asc' ? 'chevronUp' : 'chevronDown'} size=${14} />` : ''}</button></th>`)}
          ${check && html`<th class="col-why"><span>Why</span></th>`}
          <th class="col-actions"><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>${page.items.map((s) => (check
          ? html`<${CheckRow} key=${s.id} song=${s} update=${page.update} genres=${genres} />`
          : html`<${LibraryRow} key=${s.id} song=${s} />`))}</tbody>
      </table>
    </div>
    ${!page.items.length && !page.loading && !page.error && html`<${Empty} icon=${check ? '✅' : '🎚️'} title=${check ? 'Nothing to check here' : narrowed ? 'No songs match all of these' : 'No songs yet'}>${check
      ? 'Every year and genre in this view looks fine (or is yours).' : narrowed ? 'Take a filter or a word away.' : 'Songs appear once the library is scanned.'}</${Empty}>`}
    <${MoreSentinel} active=${page.hasMore && !page.error} onMore=${page.more} />
  </section>`;
}

function LibraryRow({ song: s }) {
  const open = () => openDialog({ type: 'song', songId: s.id });
  const labels = s.labels || [];
  return html`<tr class="lib-row" tabindex="0" onClick=${open} onKeyDown=${(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
    <td class="col-title"><div class="lib-title"><span class="ellipsis">${s.title}</span><${SongBadges} song=${s} /></div></td>
    <td class="col-artist"><span class="ellipsis">${s.artist}</span></td>
    <td class="col-label" title=${labels.join(', ')}><span class="ellipsis">${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` +${labels.length - 3}` : ''}</span></td>
    <td class="col-year num">${s.year || html`<span class="faint">—</span>`}${s.own?.year ? html`<${OwnMark} />` : ''}</td>
    <td class="col-genre"><span class="ellipsis">${s.genre || html`<span class="faint">—</span>`}${s.own?.genre ? html`<${OwnMark} />` : ''}</span></td>
    <td class="col-versions num">${s.v}</td>
    <td class="col-plays num">${s.plays || html`<span class="faint">0</span>`}</td>
    <td class="col-actions" onClick=${(e) => e.stopPropagation()}><div class="lib-actions"><${RowActions} song=${s} /></div></td>
  </tr>`;
}

const OwnMark = () => html`<span class="own-mark" title="Yours (set by you, kept over the online one)" aria-label="set by you">●</span>`;

/**
 * One song in the year & genre checker: its year and genre (click to change; yours are marked,
 * with a way back to the online one), why it is here, the suggestions, "Find the first release"
 * (asks the providers) and "Right as it is". A fixed row stays, ticked, until the list reloads.
 */
function CheckRow({ song: s, update, genres }) {
  const [busy, setBusy] = useState('');
  const save = async (patch, what) => {
    setBusy(what);
    try {
      const res = await apiPost('/api/library/meta', { songId: s.id, ...patch });
      // The row as the server has it now (an undone value loses its "yours" mark too).
      update(s.id, (x) => ({ ...res.row, check: res.check || x.check, found: x.found, done: !res.check }));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const findYear = async () => {
    setBusy('find');
    try {
      const res = await apiPost('/api/library/meta/first-year', { songId: s.id });
      if (res.found) update(s.id, (x) => ({ ...x, check: res.check || x.check, found: res.found }));
      else toast(`No first release found for ${s.title}.`, 'info');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const why = s.check?.why || [];
  const sug = s.check?.suggest || {};
  const yearReason = why.some((w) => w !== 'no-genre');
  // "Right as it is": the year and genre it has become yours (so it isn't asked about again) —
  // only when nothing is missing (a missing year or genre can't be right).
  const canConfirm = !why.includes('no-year') && !why.includes('no-genre');
  const right = () => save({ ...(s.year ? { year: s.year } : {}), ...(s.genre ? { genre: s.genre } : {}) }, 'right');
  return html`<tr class=${`lib-row meta-row ${s.done ? 'done' : ''}`}>
    <td class="col-title"><div class="lib-title"><button class="link ellipsis" onClick=${() => openDialog({ type: 'song', songId: s.id })}>${s.title}</button></div></td>
    <td class="col-artist"><span class="ellipsis">${s.artist}</span></td>
    <td class="col-year num"><${EditCell} kind="year" song=${s} busy=${busy === 'year'} onSave=${(v) => save({ year: v }, 'year')} /></td>
    <td class="col-genre"><${EditCell} kind="genre" song=${s} busy=${busy === 'genre'} genres=${genres} onSave=${(v) => save({ genre: v }, 'genre')} /></td>
    <td class="col-why">${s.done
      ? html`<span class="ok-text"><${Icon} name="check" size=${14} /> Done</span>`
      : html`<ul class="why">${why.map((w) => html`<li key=${w}>${CHECK_REASONS[w] || w}</li>`)}</ul>
        ${s.found && html`<p class="faint found">First out in ${s.found.year}${s.found.album ? ` (${s.found.album})` : ''} — ${s.found.provider}</p>`}
        <div class="why-actions">
          ${sug.year && html`<button class="btn small" disabled=${!!busy} onClick=${() => save({ year: sug.year }, 'year')}>Use ${sug.year}</button>`}
          ${sug.genre && html`<button class="btn small" disabled=${!!busy} onClick=${() => save({ genre: sug.genre }, 'genre')}>Use ${sug.genre}</button>`}
          ${yearReason && !s.found && html`<button class="btn small ghost" disabled=${!!busy} onClick=${findYear}>${busy === 'find' ? 'Looking…' : 'Find the first release'}</button>`}
        </div>`}</td>
    <td class="col-actions"><div class="lib-actions">
      ${!s.done && canConfirm && html`<button class="btn small ghost" disabled=${!!busy} onClick=${right} title="The year and genre shown are right: keep them as yours">
        <${Icon} name="check" size=${15} /> Right</button>`}
    </div></td>
  </tr>`;
}

/** A year or genre that changes when clicked: Enter or leaving saves, Escape doesn't; yours can go back to the online one. */
function EditCell({ kind, song, busy, genres = [], onSave }) {
  const [editing, setEditing] = useState(false);
  const value = song[kind] || '';
  const own = !!song.own?.[kind];
  const label = kind === 'year' ? 'year' : 'genre';
  if (editing) {
    const close = (v) => {
      setEditing(false);
      if (v === null || String(v) === String(value)) return;
      const max = new Date().getFullYear() + 1;
      if (kind === 'year' && v && !(Number.isInteger(Number(v)) && v >= 1900 && v <= max)) {
        toast(`A year from 1900 to ${max}, please.`, 'error'); // (the server says the same)
        return;
      }
      onSave(v ? (kind === 'year' ? Number(v) : v) : null);
    };
    return html`<span class="edit-cell editing"><${EditInput} kind=${kind} value=${value} label=${`The ${label} of ${song.title}`} genres=${genres} onClose=${close} /></span>`;
  }
  return html`<span class=${`edit-cell ${own ? 'own' : ''}`}>
    <button class="edit-value" disabled=${busy} onClick=${() => setEditing(true)} aria-label=${`Change the ${label} of ${song.title}${value ? ` (${value})` : ''}`}
      title=${own ? 'Yours — click to change' : 'Click to change'}>${busy ? '…' : value || html`<span class="faint">—</span>`}</button>
    ${own && html`<button class="icon-btn small undo" disabled=${busy} onClick=${() => onSave(null)} aria-label=${`Back to the online ${label}`} title=${`Back to the online ${label}`}><${Icon} name="restart" size=${13} /></button>`}
  </span>`;
}

/** The input of an EditCell: focused at once; closes once (Enter or leaving: the text, Escape: null). */
function EditInput({ kind, value, label, genres, onClose }) {
  const ref = useRef(null);
  const closed = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const close = (v) => {
    if (closed.current) return;
    closed.current = true;
    onClose(v);
  };
  return html`<input ref=${ref} class="input" type=${kind === 'year' ? 'number' : 'text'} min=${kind === 'year' ? 1900 : undefined}
      max=${kind === 'year' ? new Date().getFullYear() + 1 : undefined} list=${kind === 'genre' ? 'ok-genres' : undefined}
      maxlength=${kind === 'genre' ? 40 : undefined} value=${value} aria-label=${label}
      onKeyDown=${(e) => { if (e.key === 'Enter') close(e.currentTarget.value.trim()); else if (e.key === 'Escape') close(null); }}
      onBlur=${(e) => close(e.currentTarget.value.trim())} />
    ${kind === 'genre' && html`<datalist id="ok-genres">${genres.map((g) => html`<option value=${g.genre} />`)}</datalist>`}`;
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
          <td class="actions"><${GuestButtons} g=${g} /></td>
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
          <td class="lead"><button class="link" onClick=${() => openDialog({ type: 'song', songId: h.songId })}><b>${h.title}</b></button> <span class="faint">${h.artist}</span></td>
          <td>${h.skipped ? html`<span class="pill">Skipped</span>` : ''}${h.key ? html` <span class="pill">Key ${h.key > 0 ? '+' : ''}${h.key}</span>` : ''}${h.rating ? html` <span class="pill bulb" title=${`${h.rating.n} ${h.rating.n === 1 ? 'vote' : 'votes'}`}>★ ${h.rating.avg.toFixed(1)}</span>` : ''}${h.game ? html` <span class="pill">${h.game}</span>` : ''}</td>
          <td class="actions"><button class="btn small" onClick=${() => openDialog({ type: 'add', songId: h.songId, singerName: h.singers[0] || '' })}>Queue again</button></td>
        </tr>`)}</tbody></table>`
      : html`<${Empty} icon="🕘" title="Nothing sung yet tonight" />`}
  </div>`;
}

