// Host → Playlists: save the queue as a playlist, keep sets of songs, queue them in one go.
import { html, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural } from '../lib/store.js';
import { SongRow, Empty, Spinner, useFetch, go } from '../lib/components.js';
import { store, act, openDialog, toast } from './state.js';

function PlaylistList({ state }) {
  const [name, setName] = useState('');
  const create = async (e) => {
    e.preventDefault();
    const r = await act('playlist.save', { name, fromQueue: false });
    if (r) {
      setName('');
      go(`/playlists/${r.id}`);
    }
  };
  const fromQueue = async () => {
    const n = prompt('Name for this playlist', `Queue ${new Date().toLocaleDateString()}`);
    if (!n?.trim()) return;
    const r = await act('playlist.save', { name: n, fromQueue: true });
    if (r) toast('Queue saved as a playlist', 'ok');
  };
  return html`<div class="page">
    <header class="page-head"><div><h1>Playlists</h1><p class="muted">Sets of songs to queue in one go — warm-ups, themes, the host’s favourites.</p></div>
      <div class="page-actions">
        <button class="btn" disabled=${!state.queue.length} onClick=${fromQueue}><${Icon} name="list" size=${16} /> Save the queue as a playlist</button>
        <form class="inline-form" onSubmit=${create}><input class="input" placeholder="New playlist name" maxlength="60" value=${name} onInput=${(e) => setName(e.currentTarget.value)} /><button class="btn primary" disabled=${!name.trim()}>Create</button></form>
      </div>
    </header>
    ${state.playlists.length
      ? html`<div class="tag-grid">${state.playlists.map((p) => html`<a class="tag-tile" href=${`#/playlists/${encodeURIComponent(p.id)}`}><b>${p.name}</b><span class="faint">${plural(p.songIds.length, 'song')}</span></a>`)}</div>`
      : html`<${Empty} icon="🎶" title="No playlists yet">Create one here, or use “Add to playlist” in a song’s details.</${Empty}>`}
  </div>`;
}

function PlaylistPage({ state, playlist }) {
  const { data } = useFetch(playlist.songIds.length ? '/api/songs' : null, { ids: playlist.songIds.join(',') }, { ttl: 0 });
  const [singer, setSinger] = useState('');
  const [shuffle, setShuffle] = useState(false);
  const songs = data ? playlist.songIds.map((id) => data.items.find((s) => s.id === id)).filter(Boolean) : null;
  const queueAll = async () => {
    const r = await act('playlist.queue', { id: playlist.id, singerName: singer.trim(), shuffle });
    if (r) toast(`${plural(r.added, 'song')} added to the queue${r.skipped ? ` (${r.skipped} skipped)` : ''}`, 'ok');
  };
  const rename = async () => {
    const n = prompt('New name', playlist.name);
    if (n?.trim()) act('playlist.save', { id: playlist.id, name: n });
  };
  const remove = async () => {
    if (!confirm(`Delete the playlist “${playlist.name}”? The songs stay in the library.`)) return;
    if (await act('playlist.delete', { id: playlist.id })) go('/playlists');
  };
  return html`<div class="page">
    <header class="page-head"><div><p class="muted"><a href="#/playlists">Playlists</a></p><h1>${playlist.name}</h1><p class="muted">${plural(playlist.songIds.length, 'song')}</p></div>
      <div class="page-actions">
        <button class="btn ghost" onClick=${rename}><${Icon} name="edit" size=${16} /> Rename</button>
        <button class="btn ghost danger" onClick=${remove}><${Icon} name="trash" size=${16} /> Delete</button>
      </div>
    </header>
    <section class="playlist-queue">
      <input class="input" placeholder="Who sings? (optional — e.g. Everyone)" maxlength="40" value=${singer} list="ok-singers" onInput=${(e) => setSinger(e.currentTarget.value)} />
      <datalist id="ok-singers">${state.singers.map((x) => html`<option value=${x.name} />`)}<option value="Everyone" /></datalist>
      <label class="check-row"><input type="checkbox" checked=${shuffle} onChange=${(e) => setShuffle(e.currentTarget.checked)} /> Shuffle</label>
      <button class="btn primary" disabled=${!playlist.songIds.length} onClick=${queueAll}><${Icon} name="plus" size=${16} /> Queue all</button>
    </section>
    ${!playlist.songIds.length && html`<${Empty} icon="➕" title="This playlist is empty">Open a song and choose “Add to playlist”.</${Empty}>`}
    ${playlist.songIds.length > 0 && !songs && html`<${Spinner} />`}
    ${songs && html`<div class="song-list">${songs.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => openDialog({ type: 'song', songId: s.id })}>
      <button class="icon-btn small" aria-label=${`Remove ${s.title} from the playlist`} onClick=${() => act('playlist.remove', { id: playlist.id, songId: s.id })}><${Icon} name="x" size=${16} /></button>
      <button class="btn small primary" onClick=${() => openDialog({ type: 'add', songId: s.id })}><${Icon} name="plus" size=${16} /> Queue</button>
    </${SongRow}>`)}</div>`}
  </div>`;
}

export function Playlists({ id }) {
  const { state } = useStore(store);
  if (!id) return html`<${PlaylistList} state=${state} />`;
  const playlist = state.playlists.find((p) => p.id === id);
  if (!playlist) return html`<div class="page"><${Empty} icon="🤷" title="Playlist not found"><a href="#/playlists">All playlists</a></${Empty}></div>`;
  return html`<${PlaylistPage} state=${state} playlist=${playlist} />`;
}
