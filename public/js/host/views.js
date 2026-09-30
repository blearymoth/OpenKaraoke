// Host main views: home, search, artists, collections, popular, favourites, history.
import { html, useState, useEffect } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { api } from '/js/lib/api.js';
import { Icon, Cover, SingerBadge, Spinner, useAsync, formatDuration, timeAgo, names, useNow } from '/js/lib/ui.js';
import { store, ui, libStore, openAdd, openDetails, conn } from './state.js';
import { SongList, SongRow } from './components.js';
import { openTvWindow } from './player-bar.js';
import { Shelf } from '/js/lib/shelf.js';

export function Home() {
  const st = useStore(store, (s) => s.state);
  const facets = useAsync((signal) => api('/api/browse/facets', { signal }), [st?.library?.songs]);
  const lib = st.library;
  const main = st.displays.find((d) => d.main);
  const surprise = async () => {
    const r = await api('/api/random', { params: { n: 1 } });
    if (r.items[0]) openAdd(r.items[0]);
  };
  return html`<div class="view home">
    <section class="hero card">
      <div class="grow">
        <div class="dim upper">Tonight</div>
        <h1>${st.party.name}</h1>
        <div class="stats-row">
          <div><b>${lib.songs.toLocaleString()}</b><span>songs</span></div>
          <div><b>${lib.artists.toLocaleString()}</b><span>artists</span></div>
          <div><b>${st.singers.length}</b><span>singers</span></div>
          <div><b>${st.guests.filter((g) => g.online).length}</b><span>guests online</span></div>
          <div><b>${st.tonight.length}</b><span>songs sung</span></div>
        </div>
      </div>
      <div class="hero-actions">
        <button class="btn primary" onClick=${() => ui.set({ invite: true })}><${Icon} name="qr" /> Invite guests</button>
        <button class="btn" onClick=${openTvWindow}><${Icon} name="tv" /> ${main ? 'Open another TV' : 'Open TV display'}</button>
        <button class="btn" onClick=${surprise}><${Icon} name="dice" size=${18} /> Surprise me</button>
        <button class="btn" onClick=${() => ui.set({ announce: true })}><${Icon} name="megaphone" size=${18} /> Announcement</button>
      </div>
    </section>
    <${LibraryBanner} lib=${lib} />
    <${HomeShelves} st=${st} tags=${facets.data?.tags || []} />
    ${facets.data?.tags?.length > 0 && html`<section>
      <h2>Collections</h2>
      <div class="chips-wrap">${facets.data.tags.slice(0, 24).map((t) => html`<a class="chip" href=${`#/tag/${encodeURIComponent(t.tag)}`}>${t.tag} <span class="dim">${t.count.toLocaleString()}</span></a>`)}</div>
    </section>`}
  </div>`;
}

const SHELF_SKIP_TAGS = new Set(['Explicit', 'Medleys']);

/** Gallery rows on the home screen: popular, tonight, favourites, random picks, collections. */
function HomeShelves({ st, tags }) {
  const [seed, setSeed] = useState(0);
  const songs = st.library.songs;
  const mark = (s) => (st.current?.songId === s.id || st.queue.some((e) => e.songId === s.id) ? 'queued'
    : st.tonight.some((h) => h.songId === s.id) ? 'sung' : null);
  const common = { onOpen: (s) => openDetails(s.id), onAdd: (s) => openAdd(s), mark };
  const tonight = [];
  for (const h of st.tonight) if (!tonight.some((x) => x.id === h.songId)) tonight.push({ id: h.songId, title: h.title, artist: h.artist });
  const favKey = st.favorites.slice(0, 30).join(',');
  const shelfTags = tags.filter((t) => !SHELF_SKIP_TAGS.has(t.tag) && t.count >= 4).slice(0, 3);
  return html`
    <${Shelf} title="Popular" subtitle="Most versions in your library and most sung here" moreHref="#/popular" deps=${[songs]}
      load=${async (signal) => (await api('/api/browse/popular', { params: { limit: 24 }, signal })).items} ...${common} />
    ${tonight.length > 0 && html`<${Shelf} title="Sung tonight" deps=${[tonight.length]} load=${() => tonight.slice(0, 30)} ...${common} />`}
    ${favKey && html`<${Shelf} title="Favourites" moreHref="#/favorites" deps=${[favKey]}
      load=${async (signal) => (await Promise.all(st.favorites.slice(0, 30).map((id) => api(`/api/songs/${id}`, { signal }).catch(() => null)))).filter(Boolean)} ...${common} />`}
    <${Shelf} title="Random picks" subtitle="Feeling adventurous?" deps=${[songs, seed]} onRefresh=${() => setSeed((x) => x + 1)}
      load=${async (signal) => (await api('/api/random', { params: { n: 18 }, signal })).items} ...${common} />
    ${shelfTags.map((t) => html`<${Shelf} key=${t.tag} title=${t.tag} subtitle=${`${t.count.toLocaleString()} songs`} moreHref=${`#/tag/${encodeURIComponent(t.tag)}`} deps=${[t.tag, songs]}
      load=${async (signal) => (await api(`/api/browse/tag/${encodeURIComponent(t.tag)}`, { params: { limit: 24 }, signal })).items} ...${common} />`)}
  `;
}

export function LibraryBanner({ lib }) {
  const live = useStore(libStore, (s) => s.progress);
  const progress = live || lib.progress;
  if (lib.state === 'unconfigured') {
    return html`<div class="banner warn"><${Icon} name="folder" /> <div class="grow"><b>No karaoke folder yet.</b> Choose the folder with your CDG/MP3 files to build the song index.</div><a class="btn primary" href="#/settings/library">Choose folder</a></div>`;
  }
  if (lib.state === 'offline') {
    return html`<div class="banner err"><${Icon} name="folder" /> <div class="grow"><b>Library drive offline.</b> Plug in the USB drive — songs will play again automatically.</div></div>`;
  }
  if (lib.state === 'scanning') {
    return html`<div class="banner"><${Spinner} size=${18} /> <div class="grow">Scanning the library… ${progress ? `${progress.tracks.toLocaleString()} tracks in ${progress.dirs.toLocaleString()} folders` : ''}</div></div>`;
  }
  if (lib.state === 'partial') {
    return html`<div class="banner warn"><${Icon} name="folder" /> <div class="grow">Some library folders are offline: ${lib.roots.filter((r) => r.online === false).map((r) => r.path).join(', ')}</div></div>`;
  }
  return null;
}

export function Search({ q }) {
  const [tag, setTag] = useState('');
  const facets = useAsync((signal) => api('/api/browse/facets', { signal }), []);
  if (!q.trim()) {
    return html`<div class="view"><div class="empty"><div class="big">🔎</div>Type in the search box to find songs by title or artist.<br /><span class="dim">Typos are OK — “bohemain rapsody” works too.</span></div></div>`;
  }
  return html`<div class="view">
    <div class="row" style=${{ flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
      <h2 class="grow" style=${{ margin: 0 }}>Results for “${q}”</h2>
      <select class="input" style=${{ width: 'auto' }} value=${tag} onChange=${(e) => setTag(e.currentTarget.value)}>
        <option value="">All collections</option>
        ${(facets.data?.tags || []).map((t) => html`<option value=${t.tag}>${t.tag}</option>`)}
      </select>
    </div>
    <${ArtistHits} q=${q} />
    <${SongList} load=${(offset, limit) => api('/api/search', { params: { q, offset, limit, tag } })} deps=${[q, tag]} empty=${`No songs match “${q}”`} />
  </div>`;
}

function ArtistHits({ q }) {
  const { data } = useAsync((signal) => api('/api/artists', { params: { q, limit: 8, sort: 'count' }, signal }), [q]);
  if (!data?.items?.length) return null;
  return html`<div class="artist-hits">
    ${data.items.map((a) => html`<a key=${a.key} class="artist-chip" href=${`#/artist/${encodeURIComponent(a.key)}`}>
      <img src=${`/api/art/artist/${encodeURIComponent(a.key)}`} alt="" loading="lazy" /><span><b>${a.name}</b><span class="dim">${a.count} song${a.count > 1 ? 's' : ''}</span></span>
    </a>`)}
  </div>`;
}

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export function Artists({ letter }) {
  const L = letter || 'A';
  const facets = useAsync((signal) => api('/api/browse/facets', { signal }), []);
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    let alive = true;
    setItems(null);
    api('/api/artists', { params: { letter: L, limit: 400 } }).then((r) => { if (alive) { setItems(r.items); setTotal(r.total); } });
    return () => { alive = false; };
  }, [L]);
  const more = async () => {
    const r = await api('/api/artists', { params: { letter: L, limit: 400, offset: items.length } });
    setItems((x) => [...x, ...r.items]);
  };
  return html`<div class="view">
    <h2>Artists</h2>
    <div class="letters">${LETTERS.map((c) => html`<a class=${`letter${c === L ? ' on' : ''}${facets.data && !facets.data.letters[c] ? ' none' : ''}`} href=${`#/artists/${encodeURIComponent(c)}`}>${c}</a>`)}</div>
    ${!items ? html`<div class="center" style=${{ padding: '30px' }}><${Spinner} /></div>`
      : !items.length ? html`<div class="empty">No artists under ${L}</div>`
        : html`<div class="artist-grid">
          ${items.map((a) => html`<a key=${a.key} class="artist-card" href=${`#/artist/${encodeURIComponent(a.key)}`}>
            <img src=${`/api/art/artist/${encodeURIComponent(a.key)}`} alt="" loading="lazy" />
            <div class="ellipsis"><b>${a.name}</b></div><div class="dim">${a.count} song${a.count > 1 ? 's' : ''}</div>
          </a>`)}
        </div>`}
    ${items && items.length < total && html`<div class="center" style=${{ padding: '14px' }}><button class="btn" onClick=${more}>Show more</button></div>`}
  </div>`;
}

export function Artist({ artistKey }) {
  const { data, error, loading } = useAsync((signal) => api(`/api/artists/${encodeURIComponent(artistKey)}`, { signal }), [artistKey]);
  if (loading) return html`<div class="view center"><${Spinner} /></div>`;
  if (error) return html`<div class="view empty">${error.message}</div>`;
  return html`<div class="view">
    <div class="artist-head">
      <img src=${`/api/art/artist/${encodeURIComponent(artistKey)}`} alt="" />
      <div><div class="dim upper">Artist</div><h1>${data.artist.name}</h1><div class="muted">${data.songs.length} song${data.songs.length > 1 ? 's' : ''}</div></div>
    </div>
    <div class="song-list">${data.songs.map((s) => html`<${SongRow} key=${s.id} song=${s} />`)}</div>
  </div>`;
}

export function Tags() {
  const { data } = useAsync((signal) => api('/api/browse/facets', { signal }), []);
  return html`<div class="view">
    <h2>Collections</h2>
    ${!data ? html`<${Spinner} />` : html`<div class="tag-grid">
      ${data.tags.map((t) => html`<a key=${t.tag} class="tag-card card" href=${`#/tag/${encodeURIComponent(t.tag)}`}><b>${t.tag}</b><span class="dim">${t.count.toLocaleString()} songs</span></a>`)}
    </div>`}
    ${data?.genres?.length > 0 && html`<h2 style=${{ marginTop: '28px' }}>Genres</h2>
      <div class="chips-wrap">${data.genres.slice(0, 40).map((g) => html`<a class="chip" href=${`#/genre/${encodeURIComponent(g.genre)}`}>${g.genre} <span class="dim">${g.count.toLocaleString()}</span></a>`)}</div>`}
    ${data?.decades?.length > 0 && html`<h2 style=${{ marginTop: '28px' }}>Decades</h2>
      <div class="chips-wrap">${data.decades.map((d) => html`<a class="chip" href=${`#/decade/${d.decade}`}>${decadeLabel(d.decade)} <span class="dim">${d.count.toLocaleString()}</span></a>`)}</div>`}
    ${data && !data.genres?.length && html`<p class="muted" style=${{ marginTop: '24px' }}>Genres and decades appear here once cover art and metadata have been looked up online (Settings → Artwork).</p>`}
    ${data?.brands?.length > 0 && html`<h2 style=${{ marginTop: '28px' }}>Karaoke labels in your library</h2>
      <div class="chips-wrap">${data.brands.map((b) => html`<span class="chip" title=${b.name}>${b.brand} <span class="dim">${b.count.toLocaleString()}</span></span>`)}</div>`}
  </div>`;
}

export function Tag({ tag }) {
  const [sort, setSort] = useState('popular');
  return html`<div class="view">
    <div class="row"><h2 class="grow">${tag}</h2>
      <select class="input" style=${{ width: 'auto' }} value=${sort} onChange=${(e) => setSort(e.currentTarget.value)}><option value="popular">Most popular</option><option value="title">A–Z</option></select>
    </div>
    <${SongList} load=${(offset, limit) => api(`/api/browse/tag/${encodeURIComponent(tag)}`, { params: { offset, limit, sort } })} deps=${[tag, sort]} />
  </div>`;
}

export const decadeLabel = (d) => (d >= 2000 ? `${d}s` : `${String(d).slice(2)}s`);

/** Songs of one genre or decade (needs online metadata). */
export function Facet({ kind, value }) {
  const params = kind === 'genre' ? { genre: value } : { decade: value };
  const title = kind === 'genre' ? value : `The ${decadeLabel(Number(value))}`;
  return html`<div class="view">
    <h2>${title}</h2>
    <${SongList} load=${(offset, limit) => api('/api/search', { params: { q: '', offset, limit, ...params } })} deps=${[kind, value]} />
  </div>`;
}

export function Popular() {
  return html`<div class="view">
    <h2>Popular</h2>
    <p class="muted" style=${{ marginTop: '-8px' }}>Ranked by the number of karaoke versions in your library and how often songs are sung here.</p>
    <${SongList} load=${(offset, limit) => api('/api/browse/popular', { params: { offset, limit } })} numbered=${true} />
  </div>`;
}

export function Favorites() {
  const favs = useStore(store, (s) => s.state?.favorites || []);
  const [songs, setSongs] = useState(null);
  const key = favs.join(',');
  useEffect(() => {
    let alive = true;
    Promise.all(favs.slice(0, 200).map((id) => api(`/api/songs/${id}`).catch(() => null))).then((list) => {
      if (alive) setSongs(list.filter(Boolean));
    });
    return () => { alive = false; };
  }, [key]);
  return html`<div class="view">
    <h2>Favourites</h2>
    ${!favs.length ? html`<div class="empty"><div class="big">❤️</div>Tap the heart on a song to keep it here.</div>`
      : !songs ? html`<${Spinner} />`
        : html`<div class="song-list">${songs.map((s) => html`<${SongRow} key=${s.id} song=${s} />`)}</div>`}
  </div>`;
}

export function History() {
  const [list, setList] = useState(null);
  const now = useNow(60000);
  useEffect(() => { conn.request('history.list', { limit: 500 }).then(setList, () => setList([])); }, []);
  return html`<div class="view">
    <h2>History</h2>
    ${!list ? html`<${Spinner} />` : !list.length ? html`<div class="empty"><div class="big">🕘</div>Nothing sung yet.</div>` : html`<table class="history">
      <thead><tr><th>When</th><th>Song</th><th>Singers</th><th>Key</th><th>Played</th></tr></thead>
      <tbody>${list.map((h, i) => html`<tr key=${i} onClick=${() => openDetails(h.songId)}>
        <td class="dim">${timeAgo(h.at, now)}</td>
        <td><b>${h.title}</b> <span class="dim">· ${h.artist}</span></td>
        <td>${(h.singers || []).join(' & ') || '—'}</td>
        <td>${h.key ? (h.key > 0 ? `+${h.key}` : h.key) : ''}</td>
        <td class="dim">${formatDuration(h.playedSec)}${h.skipped ? ' (skipped)' : ''}</td>
      </tr>`)}</tbody>
    </table>`}
  </div>`;
}
