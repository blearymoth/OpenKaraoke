// Host dialogs: add to queue, song details, edit queue entry, invite, folder picker.
import { html, useEffect, useMemo, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, formatTime, artStore } from '../lib/store.js';
import { Modal, Cover, Spinner, Stepper, useFetch, apiGet, copyText, SongBadges, go, clearFetchCache } from '../lib/components.js';
import { store, act, closeDialog, openDialog, toast } from './state.js';
import { PreviewButton, PreviewOutput } from './preview.js';
import { qrSrc } from '../lib/theme.js';
import { VocalsDialog, vocalsNote } from './vocals.js';
import { KEY_MIN, KEY_MAX, TEMPO_MIN, TEMPO_MAX, TEMPO_STEP, formatKey, formatTempo } from '/shared/protocol.js';

function versionLabel(v) {
  const parts = [v.brandName || v.brand || 'Unknown label'];
  if (v.variant) parts.push(v.variant);
  const note = vocalsNote(v);
  if (note) parts.push(note);
  return `${parts.join(' · ')} (${formatTime(v.dur)})`;
}

/** Guide singer when queueing (only for songs with a version where it can be turned up or down). */
function LeadField({ value, onChange }) {
  return html`<label class="field"><span>Lead vocal</span>
    <select class="select" value=${value === null ? '' : String(value)} onChange=${(e) => onChange(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} aria-label="Lead vocal">
      <option value="">Automatic (this singer’s last)</option>
      <option value="0">Off — no guide singer</option>
      <option value="50">Quiet guide singer</option>
      <option value="100">Full guide singer</option>
    </select></label>`;
}

/** Choose (or type) who sings: recent singers as chips plus a name box. */
function SingerPicker({ singers, value, onChange, onSubmit }) {
  const sorted = useMemo(() => [...singers].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 18), [singers]);
  return html`<div class="field">
    <span>Who's singing?</span>
    <input class="input" value=${value} placeholder="Type a name, or pick someone below" maxlength="40"
      onInput=${(e) => onChange(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') onSubmit(); }} />
    ${sorted.length > 0 && html`<div class="chips">${sorted.map((s) => html`<button class=${`chip ${value.trim().toLowerCase() === s.name.toLowerCase() ? 'on' : ''}`} onClick=${() => onChange(s.name)}>
      <span>${s.emoji}</span>${s.name}${s.online ? html`<i class="dot on" title="Phone connected"></i>` : null}
    </button>`)}</div>`}
  </div>`;
}

export function AddDialog({ songId, trackId: initialTrack, singerName = '' }) {
  const { state } = useStore(store);
  const { data: song, error } = useFetch(`/api/songs/${encodeURIComponent(songId)}`);
  const [name, setName] = useState(singerName);
  const [key, setKey] = useState(null);
  const [lead, setLead] = useState(null);
  const [trackId, setTrackId] = useState(initialTrack || '');
  const [partner, setPartner] = useState('');
  const [duet, setDuet] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (position) => {
    if (busy) return;
    setBusy(true);
    const body = { songId, singerName: name.trim() || undefined, position };
    if (duet && partner.trim()) body.partnerName = partner.trim();
    if (key !== null) body.key = key;
    if (lead !== null) body.lead = lead;
    if (trackId) body.trackId = trackId;
    const res = await act('queue.add', body);
    setBusy(false);
    if (!res) return;
    toast(position === 'now' ? `Starting ${song?.title || 'the song'}` : res.started ? `${song?.title || 'Song'} is starting` : `Added ${song?.title || 'the song'}${name.trim() ? ` for ${name.trim()}` : ''}`, 'ok');
    closeDialog();
  };
  return html`<${Modal} title="Add to queue" onClose=${closeDialog} footer=${html`
      <button class="btn ghost" onClick=${() => submit('now')} disabled=${busy || !song}>Play now</button>
      <button class="btn" onClick=${() => submit('next')} disabled=${busy || !song}>Play next</button>
      <button class="btn primary" onClick=${() => submit(undefined)} disabled=${busy || !song}><${Icon} name="plus" size=${18} /> Add to queue</button>`}>
    ${error && html`<p class="warn-text">${error.message}</p>`}
    ${!song && !error && html`<${Spinner} />`}
    ${song && html`
      <div class="song-head">
        <${Cover} songId=${song.id} size=${72} />
        <div><div class="song-head-title">${song.title} <${SongBadges} song=${song} /></div><div class="muted">${song.artist} · ${formatTime(song.dur)}</div></div>
      </div>
      <${SingerPicker} singers=${state.singers} value=${name} onChange=${setName} onSubmit=${() => submit(undefined)} />
      ${duet
        ? html`<label class="field"><span>Duet with</span>
            <input class="input" value=${partner} placeholder="Second singer’s name" maxlength="40" list="ok-singer-names" onInput=${(e) => setPartner(e.currentTarget.value)} />
            <datalist id="ok-singer-names">${state.singers.map((x) => html`<option value=${x.name} />`)}</datalist></label>`
        : html`<button class="link duet-link" onClick=${() => setDuet(true)}>+ Add a duet partner</button>`}
      <div class="row-2">
        <div class="field"><span>Key</span>
          <${Stepper} label="Key" value=${key ?? 0} display=${key === null ? 'Auto' : formatKey(key)} min=${KEY_MIN} max=${KEY_MAX} onChange=${setKey} onReset=${() => setKey(null)} />
        </div>
        ${song.versions.length > 1 && html`<label class="field"><span>Version</span>
          <select class="select" value=${trackId} onChange=${(e) => setTrackId(e.currentTarget.value)}>
            <option value="">Best available</option>
            ${song.versions.map((v) => html`<option value=${v.id}>${versionLabel(v)}</option>`)}
          </select></label>`}
      </div>
      ${song.vocalOptions?.lead && html`<${LeadField} value=${lead} onChange=${setLead} />`}
      <p class="hint">“Auto” uses the key this singer used last time for this song.${song.vocalOptions?.lead ? ' A guide singer picks a version where it can be turned up or down.' : ''}</p>
    `}
  </${Modal}>`;
}

export function SongDialog({ songId }) {
  const { state } = useStore(store);
  const { data: song, error, reload } = useFetch(`/api/songs/${encodeURIComponent(songId)}`, null, { ttl: 2000 });
  useEffect(() => artStore.subscribe((ev) => { if (ev.all || ev.songs.includes(songId)) reload(); }), [songId]);
  const fav = state.favorites.includes(songId);
  return html`<${Modal} title="Song details" wide onClose=${closeDialog}>
    ${error && html`<p class="warn-text">${error.message}</p>`}
    ${!song && !error && html`<${Spinner} />`}
    ${song && html`
      <div class="song-detail">
        <${Cover} songId=${song.id} size=${160} big />
        <div class="song-detail-text">
          <h3>${song.title} <${SongBadges} song=${song} /></h3>
          <div class="artist-links">${song.artists.map((a, i) => html`${i ? ' & ' : ''}<a href=${`#/artist/${encodeURIComponent(a.key)}`} onClick=${closeDialog}>${a.name}</a>`)}</div>
          <div class="chips">${song.tags.map((t) => html`<a class="chip" href=${`#/tag/${encodeURIComponent(t)}`} onClick=${closeDialog}>${t}</a>`)}
            ${song.meta?.genre && html`<a class="chip" href=${`#/genre/${encodeURIComponent(song.meta.genre)}`} onClick=${closeDialog}>${song.meta.genre}</a>`}
            ${song.meta?.year > 0 && html`<a class="chip" href=${`#/decade/${Math.floor(song.meta.year / 10) * 10}`} onClick=${closeDialog}>${song.meta.year}</a>`}</div>
          ${song.meta?.album && html`<p class="muted ellipsis" title=${song.meta.album}>From the album <b>${song.meta.album}</b></p>`}
          <p class="muted">${song.plays ? `Sung ${song.plays} time${song.plays === 1 ? '' : 's'} here.` : 'Never sung here yet.'} ${formatTime(song.dur)} long.</p>
          <p class="hint art-source">${artSource(song.meta)} <button class="link" onClick=${() => openDialog({ type: 'artwork', songId })}>Change cover</button></p>
          <div class="btn-row">
            <button class="btn primary" onClick=${() => openDialog({ type: 'add', songId })}><${Icon} name="plus" size=${18} /> Add to queue</button>
            <button class=${`btn ${fav ? 'on' : ''}`} onClick=${() => act('favorite.toggle', { songId })}><${Icon} name=${fav ? 'starFill' : 'star'} size=${18} /> ${fav ? 'Favourite' : 'Add to favourites'}</button>
            <${AddToPlaylist} songId=${songId} playlists=${state.playlists} />
          </div>
        </div>
      </div>
      <h4 class="section-title">Versions (${song.versions.length})</h4>
      <table class="versions">
        <thead><tr><th>Label</th><th>Version</th><th class="num">Length</th><th>File</th><th></th></tr></thead>
        <tbody>${song.versions.map((v) => html`<tr>
          <td><b>${v.brand || '—'}</b>${v.brandName && v.brandName !== v.brand ? html` <span class="faint">${v.brandName}</span>` : ''}</td>
          <td>${v.variant || html`<span class="faint">Standard</span>`}${v.vocals?.lead === 'adjustable' ? html` <span class="pill" title="The original singer is on a channel of its own: off, quiet or full">Lead vocal adjustable</span>` : v.flags?.mpx ? html` <span class="pill">Multiplex</span>` : ''}${v.vocals?.lead === 'mixed' ? html` <span class="pill">Original singer mixed in</span>` : ''}${v.vocals?.bgv === 'without' ? html` <span class="pill">No backing vocals</span>` : v.vocals?.bgv === 'with' ? html` <span class="pill">Backing vocals</span>` : ''}</td>
          <td class="num">${formatTime(v.dur)}</td>
          <td class="file ellipsis" title=${v.file}>${v.file}</td>
          <td class="actions">${v.kind !== 'video' && html`<${PreviewButton} trackId=${v.id} />`}<button class="btn small" onClick=${() => openDialog({ type: 'add', songId, trackId: v.id })}>Queue</button></td>
        </tr>`)}</tbody>
      </table>
      <${PreviewOutput} displays=${state.displays} />
    `}
  </${Modal}>`;
}

/** "Add to playlist ▾" for the song details (creates a playlist when there is none). */
function AddToPlaylist({ songId, playlists }) {
  const add = async (value) => {
    if (!value) return;
    let id = value;
    if (value === 'new') {
      const name = prompt('Name of the new playlist');
      if (!name?.trim()) return;
      const r = await act('playlist.save', { name });
      if (!r) return;
      id = r.id;
    }
    const r = await act('playlist.add', { id, songId });
    if (r) toast('Added to the playlist', 'ok');
  };
  return html`<select class="select playlist-select" value="" onChange=${(e) => { add(e.currentTarget.value); e.currentTarget.value = ''; }} aria-label="Add to playlist">
    <option value="">Add to playlist…</option>
    ${playlists.map((p) => html`<option value=${p.id}>${p.name} (${p.songIds.length})</option>`)}
    <option value="new">New playlist…</option>
  </select>`;
}

function artSource(meta) {
  if (!meta) return 'Cover: not looked up yet.';
  if (meta.manual) return meta.cover ? 'Cover chosen by you.' : 'No cover (your choice).';
  if (meta.cover) return `Cover and details from ${meta.provider}${meta.confidence ? ` (${Math.round(meta.confidence * 100)} % match)` : ''}.`;
  return 'No cover found online.';
}

/** Downsizes a picture in the browser (JPEG, longest side `max` px). */
async function resizeImage(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not a picture.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "Fix artwork": pick one of the candidates the providers know, no cover, or look up again. */
export function ArtworkDialog({ songId }) {
  const { data: song } = useFetch(`/api/songs/${encodeURIComponent(songId)}`, null, { ttl: 0 });
  const [found, setFound] = useState({ loading: true, items: [], errors: [] });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    act('artwork.candidates', { songId }).then((r) => setFound({ loading: false, items: r?.items || [], errors: r?.errors || [] }));
  }, [songId]);
  const back = () => openDialog({ type: 'song', songId });
  const run = async (t, body, done) => {
    setBusy(true);
    const r = await act(t, { songId, ...body });
    setBusy(false);
    if (r) {
      toast(typeof done === 'function' ? done(r) : done, 'ok');
      clearFetchCache(); // song details, lists and facets show the new metadata
      back();
    }
  };
  return html`<${Modal} title="Choose the cover" wide onClose=${closeDialog} footer=${html`
      <button class="btn ghost danger" disabled=${busy} onClick=${() => run('artwork.none', {}, 'This song shows no cover now')}>No cover</button>
      <button class="btn ghost" disabled=${busy} onClick=${() => run('artwork.refresh', {}, (r) => (r.found ? 'Found a cover' : 'Still no cover found'))}><${Icon} name="refresh" size=${16} /> Look up again</button>
      <button class="btn" onClick=${back}>Back</button>`}>
    ${song && html`<div class="song-head">
      <${Cover} songId=${songId} size=${64} />
      <div><div class="song-head-title">${song.title}</div><div class="muted">${song.artist}</div></div>
    </div>`}
    <label class="btn upload-cover">
      <input type="file" accept="image/*" hidden disabled=${busy} onChange=${async (e) => {
        const file = e.currentTarget.files[0];
        e.currentTarget.value = '';
        if (!file) return;
        setBusy(true);
        try {
          const blob = await resizeImage(file, 1200);
          const res = await fetch(`/api/art/song/${encodeURIComponent(songId)}/cover`, { method: 'POST', headers: { 'content-type': 'image/jpeg', ...(localStorage.getItem('ok.hostToken') ? { authorization: `Bearer ${localStorage.getItem('ok.hostToken')}` } : {}) }, body: blob });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
          toast('Your picture is the cover now', 'ok');
          clearFetchCache();
          back();
        } catch (err) {
          toast(err.message, 'error');
        }
        setBusy(false);
      }} />
      <${Icon} name="plus" size=${16} /> Upload your own picture
    </label>
    ${found.loading && html`<${Spinner} />`}
    ${found.errors.map((e) => html`<p class="warn-text">${e}</p>`)}
    ${!found.loading && !found.items.length && html`<p class="muted">No covers found for this song. Check the internet connection, or use “No cover”.</p>`}
    <div class="art-candidates">${found.items.map((c) => html`<button class=${`art-candidate ${c.current ? 'on' : ''}`} disabled=${busy} onClick=${() => run('artwork.choose', { candidateId: c.id }, 'Cover saved')}>
      <img src=${c.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" />
      <b class="ellipsis" title=${`${c.title} ${c.version}`}>${c.title} <span class="faint">${c.version}</span></b>
      <span class="ellipsis muted">${c.artist}</span>
      <span class="ellipsis faint" title=${c.album}>${[c.album, c.year || ''].filter(Boolean).join(' · ')}</span>
      <span class="art-candidate-foot"><span class="pill">${c.provider}</span> <span class=${c.confidence >= 0.62 ? 'good' : 'faint'}>${Math.round(c.confidence * 100)} %</span>${c.current ? html` <span class="pill neon">Current</span>` : ''}</span>
    </button>`)}</div>
  </${Modal}>`;
}

export function EditDialog({ entryId }) {
  const { state } = useStore(store);
  const entry = state.queue.find((e) => e.id === entryId) || state.pending.find((e) => e.id === entryId);
  const { data: song } = useFetch(entry ? `/api/songs/${encodeURIComponent(entry.songId)}` : null);
  const [name, setName] = useState(entry ? entry.singers.map((s) => s.name).join(' & ') : '');
  const [key, setKey] = useState(entry?.key || 0);
  const [tempo, setTempo] = useState(entry?.tempo || 1);
  const [lead, setLead] = useState(Number.isInteger(entry?.lead) ? entry.lead : null);
  const [trackId, setTrackId] = useState(entry?.trackId || '');
  const [mystery, setMystery] = useState(!!entry?.mystery);
  if (!entry) {
    return html`<${Modal} title="Edit song" onClose=${closeDialog}><p>This song is no longer in the queue.</p></${Modal}>`;
  }
  const save = async () => {
    const patch = { key, tempo, trackId, mystery, lead };
    const current = entry.singers.map((s) => s.name).join(' & ');
    if (name.trim() !== current) patch.singerName = name.trim();
    if (await act('queue.update', { entryId, patch })) closeDialog();
  };
  return html`<${Modal} title="Edit queued song" onClose=${closeDialog} footer=${html`
      <button class="btn ghost danger" onClick=${async () => { if (await act('queue.remove', { entryId })) closeDialog(); }}><${Icon} name="trash" size=${16} /> Remove</button>
      <button class="btn primary" onClick=${save}>Save</button>`}>
    <div class="song-head">
      <${Cover} songId=${entry.songId} size=${56} />
      <div><div class="song-head-title">${entry.title}</div><div class="muted">${entry.artist}</div></div>
    </div>
    <${SingerPicker} singers=${state.singers} value=${name} onChange=${setName} onSubmit=${save} />
    <div class="row-2">
      <div class="field"><span>Key</span><${Stepper} label="Key" value=${key} display=${formatKey(key)} min=${KEY_MIN} max=${KEY_MAX} onChange=${setKey} onReset=${() => setKey(0)} /></div>
      <div class="field"><span>Tempo</span><${Stepper} label="Tempo" value=${tempo} display=${formatTempo(tempo)} min=${TEMPO_MIN} max=${TEMPO_MAX} step=${TEMPO_STEP} onChange=${setTempo} onReset=${() => setTempo(1)} /></div>
    </div>
    ${song?.versions?.length > 1 && html`<label class="field"><span>Version</span>
      <select class="select" value=${trackId} onChange=${(e) => setTrackId(e.currentTarget.value)}>
        ${song.versions.map((v) => html`<option value=${v.id}>${versionLabel(v)}</option>`)}
      </select></label>`}
    ${song?.vocalOptions?.lead && html`<${LeadField} value=${lead} onChange=${setLead} />`}
    <label class="toggle-row"><span><b>Mystery song</b><br /><span class="hint">Guests and the TV see “Surprise!” until it starts.</span></span>
      <span class="switch"><input type="checkbox" checked=${mystery} onChange=${(e) => setMystery(e.currentTarget.checked)} /><span></span></span>
    </label>
  </${Modal}>`;
}

export function InviteDialog() {
  const { state } = useStore(store);
  const info = state.info;
  const qr = qrSrc(info.joinUrl);
  const wifi = state.settings.party.wifi;
  const hotspot = state.hotspot?.tv || null; // the party hotspot is on: joining its Wi-Fi is step 1
  const wifiQr = hotspot ? qrSrc(hotspot.qr) : '';
  const printCard = () => {
    const w = window.open('', 'openkaraoke-card', 'width=800,height=1000');
    if (!w) return toast('Pop-up blocked — allow pop-ups to print the card.', 'error');
    const join = `<img src="${location.origin}${qr}"><div class="code">${info.roomCode}</div><p class="url">${escapeHtml(info.joinUrl)}</p>`;
    w.document.write(`<!doctype html><title>Table card</title><style>
      body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:40px;color:#111}
      h1{font-size:46px;margin:10px 0}p{font-size:22px;margin:8px 0}img{width:360px;height:360px;margin:24px auto;display:block}
      .code{font-size:52px;font-weight:800;letter-spacing:.2em}.url{font-size:20px;color:#444}
      .card{border:3px dashed #999;border-radius:24px;padding:30px;max-width:560px;margin:0 auto}
      .steps{display:flex;gap:28px;justify-content:center;text-align:center}.steps>div{flex:1}.steps img{width:250px;height:250px;margin:14px auto}
      .steps h2{font-size:26px;margin:6px 0}.steps .code{font-size:40px}.no{display:inline-block;width:44px;height:44px;line-height:44px;border-radius:50%;background:#111;color:#fff;font-weight:800;font-size:26px}
      .pw{font-family:ui-monospace,monospace;font-size:24px;font-weight:700;letter-spacing:.06em;overflow-wrap:anywhere}.steps>div{min-width:0}
      .hotspot .card{max-width:720px}</style>
      ${hotspot
        ? `<div class="hotspot"><div class="card"><h1>${escapeHtml(info.name)}</h1><p>Pick your karaoke songs on your phone — two scans</p>
          <div class="steps"><div><span class="no">1</span><h2>Join the Wi-Fi</h2><img src="${location.origin}${wifiQr}">
            <p>Network <b>${escapeHtml(hotspot.ssid)}</b></p><p>Password <span class="pw">${escapeHtml(hotspot.password)}</span></p></div>
          <div><span class="no">2</span><h2>Open the party</h2>${join}</div></div></div></div>`
        : `<div class="card"><h1>${escapeHtml(info.name)}</h1><p>Scan to pick your karaoke songs</p>
          ${join}${wifi?.ssid ? `<p>Wi-Fi: <b>${escapeHtml(wifi.ssid)}</b></p>` : ''}</div>`}
      <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>`);
    w.document.close();
    return undefined;
  };
  const link = html`<div class="invite-url">
    <input class="input" readonly value=${info.joinUrl} onFocus=${(e) => e.currentTarget.select()} aria-label="Join link" />
    <button class="btn" onClick=${() => copyText(info.joinUrl).then(() => toast('Link copied', 'ok'))}><${Icon} name="link" size=${16} /> Copy</button>
  </div>`;
  const buttons = html`<div class="btn-row">
    <button class="btn" onClick=${printCard}><${Icon} name="printer" size=${16} /> Print a table card</button>
    <button class="btn ghost" onClick=${() => { closeDialog(); go('/settings/party'); }}>Change code or Wi-Fi</button>
  </div>`;
  if (hotspot) {
    return html`<${Modal} title="Invite guests" onClose=${closeDialog} class="invite two-steps" wide>
      <div class="invite-steps">
        <section class="invite-step" aria-label="Step 1: join the party Wi-Fi">
          <h3><span class="step-no">1</span> Join the Wi-Fi</h3>
          <div class="marquee"><img src=${wifiQr} alt="QR code to join the party Wi-Fi" /></div>
          <dl class="wifi-facts">
            <dt>Network</dt><dd>${hotspot.ssid}</dd>
            <dt>Password</dt><dd class="mono">${hotspot.password}</dd>
          </dl>
        </section>
        <section class="invite-step" aria-label="Step 2: open the party">
          <h3><span class="step-no">2</span> Open the party</h3>
          <div class="marquee"><img src=${qr} alt="QR code to open the party" /></div>
          <div class="invite-code">${info.roomCode}</div>
        </section>
      </div>
      <div class="invite-text">
        <p>Guests scan <b>1</b> with their phone camera to join this computer’s own Wi-Fi, then <b>2</b> to open the party — no app needed. If the phone says the network has no internet, they choose to <b>stay connected</b>.</p>
        ${link}
        ${buttons}
      </div>
    </${Modal}>`;
  }
  return html`<${Modal} title="Invite guests" onClose=${closeDialog} class="invite">
    <div class="invite-body">
      <div class="marquee"><img src=${qr} alt="QR code to join" /></div>
      <div class="invite-text">
        <p>Guests scan the code with their phone camera — no app needed. They must be on the same Wi-Fi as this computer.</p>
        <div class="invite-code">${info.roomCode}</div>
        ${link}
        ${info.lanUrls.length > 1 && html`<p class="hint">Phones can't open it? Try another address of this computer: ${info.lanUrls.slice(1).map((u) => html`<code>${u}/j/${info.roomCode}</code> `)}</p>`}
        ${state.hotspot && !state.hotspot.enabled && html`<p class="hint">No Wi-Fi the guests can use? This computer can make its own: <a href="#/settings/party" onClick=${closeDialog}>Settings → Party → Party hotspot</a>.</p>`}
        ${buttons}
      </div>
    </div>
  </${Modal}>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function FolderDialog({ onPick }) {
  const [path, setPath] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState('');
  const load = async (p) => {
    setError(null);
    try {
      const d = await apiGet('/api/fs/list', { path: p });
      setData(d);
      setPath(d.path);
      setManual(d.path);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(''); }, []);
  const crumbs = path ? path.split('/').filter(Boolean).map((part, i, all) => ({ name: part, path: `/${all.slice(0, i + 1).join('/')}` })) : [];
  return html`<${Modal} title="Choose your karaoke folder" wide onClose=${closeDialog} footer=${html`
      <span class="hint grow">${path ? (data?.karaokeFiles ? `${data.karaokeFiles} karaoke files directly in this folder.` : 'Sub-folders are scanned too.') : 'Pick a drive or folder.'}</span>
      <button class="btn ghost" onClick=${closeDialog}>Cancel</button>
      <button class="btn primary" disabled=${!path} onClick=${() => { onPick(path); closeDialog(); }}>Use this folder</button>`}>
    <div class="crumbs">
      <button class="chip" onClick=${() => load('')}><${Icon} name="home" size=${14} /> Drives</button>
      ${crumbs.map((c) => html`<${Icon} name="chevronRight" size=${14} /><button class="chip" onClick=${() => load(c.path)}>${c.name}</button>`)}
    </div>
    <form class="manual-path" onSubmit=${(e) => { e.preventDefault(); load(manual); }}>
      <input class="input" value=${manual} placeholder="/run/media/you/DRIVE/Karaoke" onInput=${(e) => setManual(e.currentTarget.value)} />
      <button class="btn">Go</button>
    </form>
    ${error && html`<p class="warn-text">${error}</p>`}
    <div class="folder-list">
      ${data?.parent && html`<button class="folder" onClick=${() => load(data.parent)}><${Icon} name="chevronLeft" size=${18} /> Up one level</button>`}
      ${data?.dirs.map((d) => html`<button class="folder" onClick=${() => load(d.path)}><${Icon} name="folder" size=${18} /> <span class="ellipsis">${d.name}</span></button>`)}
      ${data && !data.dirs.length && html`<p class="hint">No sub-folders here.</p>`}
      ${!data && !error && html`<${Spinner} />`}
    </div>
  </${Modal}>`;
}

export function AnnounceDialog() {
  const { state } = useStore(store);
  const [text, setText] = useState('');
  const [seconds, setSeconds] = useState(10);
  const send = async () => {
    if (!text.trim()) return;
    if (await act('announce', { text, seconds })) {
      toast('Showing on the TV', 'ok');
      closeDialog();
    }
  };
  return html`<${Modal} title="Announce on the TV" onClose=${closeDialog} footer=${html`
      ${state.announcement && html`<button class="btn ghost" onClick=${() => act('announce', { text: '' }).then(closeDialog)}>Clear current</button>`}
      <button class="btn primary" disabled=${!text.trim()} onClick=${send}><${Icon} name="megaphone" size=${18} /> Show on TV</button>`}>
    <label class="field"><span>Message</span>
      <textarea class="input" maxlength="140" placeholder="Pizza is here! 🍕" value=${text} onInput=${(e) => setText(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
    </label>
    <label class="field"><span>Show it for</span>
      <select class="select" value=${seconds} onChange=${(e) => setSeconds(Number(e.currentTarget.value))}>
        ${[5, 10, 20, 30, 60].map((n) => html`<option value=${n}>${n} seconds</option>`)}
      </select>
    </label>
  </${Modal}>`;
}

export function Dialogs() {
  const { dialog } = useStore(store);
  if (!dialog) return null;
  switch (dialog.type) {
    case 'add': return html`<${AddDialog} ...${dialog} key=${dialog.songId} />`;
    case 'song': return html`<${SongDialog} songId=${dialog.songId} key=${dialog.songId} />`;
    case 'artwork': return html`<${ArtworkDialog} songId=${dialog.songId} key=${dialog.songId} />`;
    case 'edit': return html`<${EditDialog} entryId=${dialog.entryId} />`;
    case 'invite': return html`<${InviteDialog} />`;
    case 'vocals': return html`<${VocalsDialog} />`;
    case 'folder': return html`<${FolderDialog} onPick=${dialog.onPick} />`;
    case 'announce': return html`<${AnnounceDialog} />`;
    default: return null;
  }
}

