// What waits on the host (PLAN §31.12): songs guests asked for from a YouTube link first, then song
// requests, photos and screens waiting. `DecisionPopup` asks about the oldest link request right
// away (non-modal: Approve / Deny / Later); the Decisions page (#/decisions) has everything, with
// the lyrics to check before saying yes, the songs being made, and what came of the last ones.
import { html, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural } from '../lib/store.js';
import { go } from '../lib/components.js';
import { store, act, toast, openDialog, openPanel } from './state.js';
import { LINK_STATES } from '/shared/maker.js';

const STAGE = { download: 'Downloading', separate: 'Removing the singer', mp3: 'Removing the singer', timing: 'Timing the lyrics', cdg: 'Drawing the lyrics', done: 'Adding it to the library' };
const later = new Set(); // link requests the host put off in the popup (this page load)

/** Everything waiting on the host: link requests, song requests, screens, photos. */
export function decisionsCount(state) {
  if (!state) return 0;
  return (state.linkCounts?.pending || 0) + (state.pending?.length || 0) + (state.pairings?.length || 0)
    + (state.photos?.filter((p) => p.status === 'pending').length || 0);
}

const lineCount = (text) => String(text || '').split('\n').filter((l) => l.trim()).length;

function LinkOpen({ r }) {
  return html`<a class="link ellipsis dec-url" href=${r.url} target="_blank" rel="noopener noreferrer">${r.video || r.url}</a>`;
}

/** One request waiting for a yes or no: the link, who asked, the title and the lyrics to check. */
function PendingLink({ r }) {
  const [artist, setArtist] = useState(r.artist || '');
  const [title, setTitle] = useState(r.plainTitle || '');
  const [lyrics, setLyrics] = useState(r.lyricsText || '');
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    const ok = await act('link.approve', { id: r.id, artist, title, lyrics });
    setBusy(false);
    if (ok) toast('Approved — the Karaoke maker makes it now', 'ok');
  };
  const deny = async () => {
    const reason = prompt('Tell them why? (optional)', '');
    if (reason === null) return;
    setBusy(true);
    await act('link.deny', { id: r.id, reason });
    setBusy(false);
  };
  return html`<div class="dec-card dec-link pending" data-link=${r.id}>
    <div class="dec-head"><span class="pill bulb">${r.name}</span><span class="hint">asked ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    <${LinkOpen} r=${r} />
    <div class="row-2 dec-names">
      <label class="field"><span>Artist</span><input class="input" value=${artist} maxlength="120" placeholder="(from YouTube)" onInput=${(e) => setArtist(e.currentTarget.value)} /></label>
      <label class="field"><span>Title</span><input class="input" value=${title} maxlength="120" placeholder="(from YouTube)" onInput=${(e) => setTitle(e.currentTarget.value)} /></label>
    </div>
    <label class="field"><span>Lyrics ${lyrics.trim() ? `· ${lineCount(lyrics)} lines` : ''}</span>
      <textarea class="input" rows="5" value=${lyrics} placeholder="None typed: they are looked up, or Whisper writes down what it hears." onInput=${(e) => setLyrics(e.currentTarget.value)}></textarea></label>
    <div class="btn-row">
      <button class="btn primary" disabled=${busy} onClick=${approve}><${Icon} name="check" size=${16} /> Approve</button>
      <button class="btn ghost danger" disabled=${busy} onClick=${deny}>Deny</button>
    </div>
  </div>`;
}

function LinkResult({ r }) {
  const songs = r.songId && r.state === 'done';
  return html`<div class=${`dec-card dec-link ${r.state}`} data-link=${r.id}>
    <div class="dec-head"><b class="ellipsis">${r.title}</b><span class=${`pill mk-state ${r.state === 'working' ? 'running' : r.state}`}>${r.waiting ? 'Waiting for the song to end' : LINK_STATES[r.state]}</span></div>
    <div class="hint">${r.name}${r.lyrics ? ' · with lyrics' : ''} · <${LinkOpen} r=${r} /></div>
    ${r.state === 'working' && html`<div class="mk-bar" role="progressbar" aria-valuenow=${r.percent} aria-valuemin="0" aria-valuemax="100"><i style=${`width:${Math.max(3, r.percent)}%`}></i></div>
      <p class="hint">${STAGE[r.stage] || 'Starting'}…</p>`}
    ${r.error && html`<p class="warn-text">${r.error}</p>`}
    <div class="btn-row">
      ${songs && html`<button class="btn small" onClick=${() => openDialog({ type: 'song', songId: r.songId })}>Song details</button>`}
      ${songs && r.queued && html`<span class="hint">Queued for ${r.name}.</span>`}
      ${r.state === 'failed' && html`<button class="btn small" onClick=${() => act('link.retry', { id: r.id })}>Try again</button>`}
      ${['queued', 'working'].includes(r.state) && html`<button class="btn small ghost danger" onClick=${() => act('link.cancel', { id: r.id })}>Cancel</button>`}
      ${!['pending', 'queued', 'working'].includes(r.state) && html`<button class="btn small ghost" onClick=${() => act('link.remove', { id: r.id })}>Remove</button>`}
    </div>
  </div>`;
}

export function Decisions() {
  const { state } = useStore(store);
  const links = state.links || [];
  const pendingLinks = links.filter((r) => r.state === 'pending');
  const making = links.filter((r) => r.state === 'queued' || r.state === 'working');
  const finished = links.filter((r) => !['pending', 'queued', 'working'].includes(r.state));
  const photos = state.photos?.filter((p) => p.status === 'pending').length || 0;
  const guestLinks = state.settings.maker?.guestLinks;
  const nothing = !pendingLinks.length && !state.pending.length && !state.pairings.length && !photos;
  return html`<div class="page decisions">
    <header class="page-head"><div><h1>Decisions</h1><p class="muted">${nothing ? 'Nothing is waiting for you.' : 'What guests are waiting on.'}</p></div>
      <div class="btn-row"><button class="btn" onClick=${() => go('/settings/maker')}><${Icon} name="sparkles" size=${16} /> Make a song yourself</button></div></header>
    <section class="dec-section" aria-label="Songs from a link">
      <h2 class="section-title">Songs from a link ${pendingLinks.length > 0 && html`<span class="badge bulb">${pendingLinks.length}</span>`}</h2>
      ${!guestLinks && html`<p class="hint">Guests can’t ask for songs from YouTube now — turn it on in <a class="link" href="#/settings/maker">Settings → Karaoke maker</a>.</p>`}
      ${pendingLinks.length ? html`<div class="dec-grid">${pendingLinks.map((r) => html`<${PendingLink} key=${r.id} r=${r} />`)}</div>`
        : guestLinks && html`<p class="hint">None waiting.</p>`}
      ${making.length > 0 && html`<h3 class="dec-sub">Being made</h3><div class="dec-grid">${making.map((r) => html`<${LinkResult} key=${r.id} r=${r} />`)}</div>`}
      ${finished.length > 0 && html`<h3 class="dec-sub">Recent</h3><div class="dec-grid">${finished.slice(0, 12).map((r) => html`<${LinkResult} key=${r.id} r=${r} />`)}</div>
        <div class="btn-row"><button class="btn small ghost" onClick=${() => act('link.clear')}>Clear the finished ones</button></div>`}
    </section>
    <section class="dec-section" aria-label="Song requests">
      <h2 class="section-title">Song requests ${state.pending.length > 0 && html`<span class="badge bulb">${state.pending.length}</span>`}</h2>
      ${state.pending.length ? html`<div class="dec-grid">${state.pending.map((e) => html`<div class="dec-card" key=${e.id}>
        <div class="dec-head"><b class="ellipsis">${e.title}</b><span class="hint">${e.artist}</span></div>
        <div class="hint">${e.addedByName || 'A guest'}</div>
        <div class="btn-row"><button class="btn small primary" onClick=${() => act('queue.approve', { entryId: e.id })}>Approve</button>
          <button class="btn small ghost danger" onClick=${() => act('queue.reject', { entryId: e.id })}>Reject</button></div>
      </div>`)}</div>` : html`<p class="hint">None waiting${state.settings.queue.requireApproval ? '' : ' (guests’ songs go straight into the queue)'}.</p>`}
    </section>
    <section class="dec-section" aria-label="Photos and screens">
      <h2 class="section-title">Photos and screens</h2>
      <p class="hint">${photos ? html`<a class="link" href="#/photos">${plural(photos, 'photo')} waiting</a>` : 'No photos waiting'} ·
        ${state.pairings.length ? html`<button class="link" onClick=${() => openPanel('devices')}>${plural(state.pairings.length, 'screen')} waiting to pair</button>` : 'no screens waiting'}.</p>
    </section>
  </div>`;
}

/** The oldest link request, asked about at once (not in the way: Later puts it off to the Decisions page). */
export function DecisionPopup({ route }) {
  const { state } = useStore(store);
  const [, setTick] = useState(0);
  const r = (state?.links || []).find((x) => x.state === 'pending' && !later.has(x.id));
  if (!r || route?.parts?.[0] === 'decisions') return null;
  const more = (state.linkCounts?.pending || 1) - 1;
  const putOff = () => {
    later.add(r.id);
    setTick((n) => n + 1);
  };
  return html`<aside class="dec-popup" role="status" aria-live="polite" aria-label="A song asked for from a link">
    <div class="dec-head"><span class="pill bulb">${r.name}</span><b>asks for a song from YouTube</b></div>
    <${LinkOpen} r=${r} />
    <p class="hint">${r.lyrics ? `With lyrics (${lineCount(r.lyricsText)} lines).` : 'No lyrics: they are looked up, or written down by Whisper.'}${more > 0 ? ` ${plural(more, 'more')} waiting.` : ''}</p>
    <div class="btn-row">
      <button class="btn small primary" onClick=${() => act('link.approve', { id: r.id }).then((ok) => ok && toast('Approved — the Karaoke maker makes it now', 'ok'))}>Approve</button>
      <button class="btn small ghost danger" onClick=${() => act('link.deny', { id: r.id })}>Deny</button>
      <button class="btn small ghost" onClick=${putOff}>Later</button>
      <button class="btn small ghost" onClick=${() => go('/decisions')}>Check the lyrics…</button>
    </div>
  </aside>`;
}
