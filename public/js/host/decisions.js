// What waits on the host (PLAN §31.12): songs guests asked for from a YouTube link first, then song
// requests, photos and screens waiting. `DecisionPopup` asks about the oldest link request right
// away (non-modal: Approve / Deny / Later); the Decisions page (#/decisions) has everything, with
// the lyrics to check before saying yes — the guest's, or the ones looked up for the song (the
// preview: what is shown is what is used) —, the songs being made, and what came of the last ones.
// Deny (`DenyDialog`) sends the guest a note and, when the library has the song already, that song.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural } from '../lib/store.js';
import { go, Modal, Spinner, useFetch } from '../lib/components.js';
import { store, act, toast, openDialog, openPanel, closeDialog } from './state.js';
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

/** Where the request's lyrics come from, under the box: the guest, a lyrics service, or nothing found. */
function LyricsNote({ r, lyrics, edited, onLookUp, busy }) {
  const p = r.preview;
  const again = html`<button class="btn small ghost" disabled=${busy} onClick=${onLookUp}><${Icon} name="search" size=${14} /> ${p ? 'Look up again' : 'Look them up'}</button>`;
  if (busy || p?.state === 'looking') return html`<p class="hint dec-lyrics-note"><${Spinner} /> Looking the lyrics up…</p>`;
  const note = (cls, text) => html`<div class=${`hint dec-lyrics-note ${cls}`}><span>${text}</span>${again}</div>`;
  if (r.lyricsText && !edited) return note('', `Typed by ${r.name}.`);
  if (p?.state === 'found') {
    return note('found', edited ? 'Your lyrics. Approve uses them as written.'
      : html`Found on <b>${p.label}</b> (${plural(p.lines, 'line')}${p.match ? `, “${p.match}”` : ''}). Approve uses them as written — check them first.`);
  }
  if (p?.state === 'none') return note('', `Nothing found online for “${[p.artist, p.title].filter(Boolean).join(' – ')}”.${lyrics.trim() ? '' : ' Paste them, or they are written down from the singing.'}`);
  if (p?.state === 'failed') return note('', html`<span class="warn-text">${p.error}</span>`);
  return note('', lyrics.trim() ? 'Your lyrics.' : 'No lyrics yet: look them up, paste them, or they are written down from the singing.');
}

/** One request waiting for a yes or no: the link, who asked, the title and the lyrics to check. */
function PendingLink({ r }) {
  const [artist, setArtist] = useState(r.artist || '');
  const [title, setTitle] = useState(r.plainTitle || '');
  const found = r.preview?.state === 'found' ? r.preview.text : '';
  const [lyrics, setLyrics] = useState(r.lyricsText || found);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const edited = useRef(false); // the host typed in the box: a lookup doesn't overwrite it unasked
  // The guessed names and the lookup arrive after the card is up: fill in what the host hasn't touched.
  useEffect(() => { if (!artist && r.artist) setArtist(r.artist); }, [r.artist]);
  useEffect(() => { if (!title && r.plainTitle) setTitle(r.plainTitle); }, [r.plainTitle]);
  useEffect(() => { if (found && !edited.current && !r.lyricsText) setLyrics(found); }, [found]);
  const lookUp = async () => {
    if (!title.trim()) return toast('Fill in the title (and the artist) first', 'error');
    setLooking(true);
    const v = await act('link.lyrics', { id: r.id, artist, title });
    setLooking(false);
    if (!v?.preview) return undefined;
    if (v.preview.state === 'found') {
      if (!edited.current) setLyrics(v.preview.text); // (the box follows the lookups until the host types in it)
      else if (confirm(`Use the lyrics found on ${v.preview.label} in place of the ones in the box?`)) {
        setLyrics(v.preview.text);
        edited.current = false;
      }
    } else if (v.preview.state === 'none') toast('Nothing found online for that song', 'info');
    return undefined;
  };
  const approve = async () => {
    setBusy(true);
    const ok = await act('link.approve', { id: r.id, artist, title, lyrics });
    setBusy(false);
    if (ok) toast('Approved — the Karaoke maker makes it now', 'ok');
  };
  const deny = () => openDialog({ type: 'deny-link', id: r.id, artist, title });
  return html`<div class="dec-card dec-link pending" data-link=${r.id}>
    <div class="dec-head"><span class="pill bulb">${r.name}</span><span class="hint">asked ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    <${LinkOpen} r=${r} />
    <div class="row-2 dec-names">
      <label class="field"><span>Artist</span><input class="input" value=${artist} maxlength="120" placeholder="(from YouTube)" onInput=${(e) => setArtist(e.currentTarget.value)} /></label>
      <label class="field"><span>Title</span><input class="input" value=${title} maxlength="120" placeholder="(from YouTube)" onInput=${(e) => setTitle(e.currentTarget.value)} /></label>
    </div>
    <label class="field"><span>Lyrics ${lyrics.trim() ? `· ${lineCount(lyrics)} lines` : ''}</span>
      <textarea class="input" rows="7" value=${lyrics} placeholder="None yet: look them up, paste them, or they are written down from the singing."
        onInput=${(e) => { edited.current = true; setLyrics(e.currentTarget.value); }}></textarea></label>
    <${LyricsNote} r=${r} lyrics=${lyrics} edited=${edited.current && lyrics !== found && lyrics !== r.lyricsText} onLookUp=${lookUp} busy=${looking} />
    <div class="btn-row">
      <button class="btn primary" disabled=${busy} onClick=${approve}><${Icon} name="check" size=${16} /> Approve</button>
      <button class="btn ghost danger" disabled=${busy} onClick=${deny}>Deny…</button>
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
    ${r.error && html`<p class=${r.state === 'denied' ? 'hint dec-note' : 'warn-text'}>${r.state === 'denied' ? html`Your note: “${r.error}”` : r.error}</p>`}
    ${r.alt && html`<p class="hint dec-note">Pointed to <b>${r.alt.artist ? `${r.alt.artist} – ` : ''}${r.alt.title}</b>.</p>`}
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
    <p class="hint">${r.lyrics ? `With lyrics (${lineCount(r.lyricsText)} lines).`
      : r.preview?.state === 'found' ? `Lyrics found on ${r.preview.label} (${plural(r.preview.lines, 'line')}).`
        : r.preview?.state === 'looking' ? 'Looking the lyrics up…'
          : 'No lyrics found yet: they are written down from the singing.'}${more > 0 ? ` ${plural(more, 'more')} waiting.` : ''}</p>
    <div class="btn-row">
      <button class="btn small primary" onClick=${() => act('link.approve', { id: r.id }).then((ok) => ok && toast('Approved — the Karaoke maker makes it now', 'ok'))}>Approve</button>
      <button class="btn small ghost danger" onClick=${() => openDialog({ type: 'deny-link', id: r.id })}>Deny…</button>
      <button class="btn small ghost" onClick=${putOff}>Later</button>
      <button class="btn small ghost" onClick=${() => go('/decisions')}>Check the lyrics…</button>
    </div>
  </aside>`;
}

const NOTES = ['We already have this song — sing ours!', 'Not tonight, sorry.', 'That link isn’t a song we can sing.', 'The queue is full for tonight.'];

/**
 * No to a song from a link: a note for the guest (quick ones, or typed), and — when the library
 * has the song already — that song, which their phone offers them to sing. The library is searched
 * for the request's song at once; the host can search for another.
 */
export function DenyDialog({ id, artist = '', title = '' }) {
  const { state } = useStore(store);
  const r = (state.links || []).find((x) => x.id === id);
  const [note, setNote] = useState('');
  const [q, setQ] = useState([artist || r?.artist, title || r?.plainTitle].filter(Boolean).join(' ') || r?.video || '');
  const [alt, setAlt] = useState(null);
  const [busy, setBusy] = useState(false);
  const found = useFetch(q.trim() ? '/api/search' : null, { q: q.trim(), limit: 5 }, { ttl: 30000 });
  if (!r) return html`<${Modal} title="Deny" onClose=${closeDialog}><p class="muted">That request was already decided.</p></${Modal}>`;
  const send = async () => {
    setBusy(true);
    const ok = await act('link.deny', { id, reason: note, songId: alt?.id || null });
    setBusy(false);
    if (!ok) return;
    toast(`${r.name} is told${alt ? `, with “${alt.title}” to sing` : ''}`, 'ok');
    closeDialog();
  };
  const items = found.data?.items || [];
  return html`<${Modal} title=${`Deny ${r.name}’s song`} onClose=${closeDialog} footer=${html`
      <button class="btn ghost" onClick=${closeDialog}>Cancel</button>
      <button class="btn danger" disabled=${busy} onClick=${send}>Deny and tell ${r.name}</button>`}>
    <div class="deny-dialog">
      <p class="muted ellipsis">${r.plainTitle ? r.title : r.video || r.url}${r.plainTitle && r.video && r.video !== r.title ? html` <span class="faint">· ${r.video}</span>` : ''}</p>
      <label class="field"><span>A note for ${r.name} (optional)</span>
        <textarea class="input" rows="3" maxlength="200" value=${note} placeholder="Why not, in a few words" onInput=${(e) => setNote(e.currentTarget.value)}></textarea></label>
      <div class="chips deny-notes">${NOTES.map((n) => html`<button class=${`chip ${note === n ? 'on' : ''}`} onClick=${() => setNote(n)}>${n}</button>`)}</div>
      <div class="field"><span>Already in the library? Send them that song to sing</span>
        <input class="input" type="search" value=${q} placeholder="Search the library" aria-label="Search the library" onInput=${(e) => { setQ(e.currentTarget.value); }} /></div>
      <ul class="deny-songs">
        ${found.loading && !items.length && html`<li class="hint"><${Spinner} /></li>`}
        ${q.trim() && !found.loading && !items.length && html`<li class="hint">No song like that here.</li>`}
        ${items.map((s) => html`<li key=${s.id}><button class=${`deny-song ${alt?.id === s.id ? 'on' : ''}`} aria-pressed=${alt?.id === s.id}
          onClick=${() => { setAlt(alt?.id === s.id ? null : s); if (!note) setNote(NOTES[0]); }}>
          <span class="grow ellipsis"><b>${s.title}</b> <span class="muted">${s.artist}</span></span>
          ${alt?.id === s.id ? html`<${Icon} name="check" size=${16} />` : html`<span class="hint">Send this</span>`}</button></li>`)}
      </ul>
    </div>
  </${Modal}>`;
}
