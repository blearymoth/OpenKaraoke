// Host dialogs: add to queue, song details, edit queue entry, invite, folder picker.
import { html, useEffect, useMemo, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, formatTime } from '../lib/store.js';
import { Modal, Cover, Spinner, Stepper, useFetch, apiGet, copyText, SongBadges, go } from '../lib/components.js';
import { store, act, closeDialog, openDialog, toast } from './state.js';
import { KEY_MIN, KEY_MAX, TEMPO_MIN, TEMPO_MAX, TEMPO_STEP, formatKey, formatTempo } from '/shared/protocol.js';

function versionLabel(v) {
  const parts = [v.brandName || v.brand || 'Unknown label'];
  if (v.variant) parts.push(v.variant);
  return `${parts.join(' · ')} (${formatTime(v.dur)})`;
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
  const [trackId, setTrackId] = useState(initialTrack || '');
  const [busy, setBusy] = useState(false);
  const submit = async (position) => {
    if (busy) return;
    setBusy(true);
    const body = { songId, singerName: name.trim() || undefined, position };
    if (key !== null) body.key = key;
    if (trackId) body.trackId = trackId;
    const res = await act('queue.add', body);
    setBusy(false);
    if (!res) return;
    if (position === 'now') await act('player.play', { entryId: res.entry.id });
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
      <p class="hint">“Auto” uses the key this singer used last time for this song.</p>
    `}
  </${Modal}>`;
}

export function SongDialog({ songId }) {
  const { state } = useStore(store);
  const { data: song, error } = useFetch(`/api/songs/${encodeURIComponent(songId)}`, null, { ttl: 2000 });
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
          <div class="chips">${song.tags.map((t) => html`<a class="chip" href=${`#/tag/${encodeURIComponent(t)}`} onClick=${closeDialog}>${t}</a>`)}</div>
          <p class="muted">${song.plays ? `Sung ${song.plays} time${song.plays === 1 ? '' : 's'} here.` : 'Never sung here yet.'} ${formatTime(song.dur)} long.</p>
          <div class="btn-row">
            <button class="btn primary" onClick=${() => openDialog({ type: 'add', songId })}><${Icon} name="plus" size=${18} /> Add to queue</button>
            <button class=${`btn ${fav ? 'on' : ''}`} onClick=${() => act('favorite.toggle', { songId })}><${Icon} name=${fav ? 'starFill' : 'star'} size=${18} /> ${fav ? 'Favourite' : 'Add to favourites'}</button>
          </div>
        </div>
      </div>
      <h4 class="section-title">Versions (${song.versions.length})</h4>
      <table class="versions">
        <thead><tr><th>Label</th><th>Version</th><th class="num">Length</th><th>File</th><th></th></tr></thead>
        <tbody>${song.versions.map((v) => html`<tr>
          <td><b>${v.brand || '—'}</b>${v.brandName && v.brandName !== v.brand ? html` <span class="faint">${v.brandName}</span>` : ''}</td>
          <td>${v.variant || html`<span class="faint">Standard</span>`}${v.flags?.mpx ? html` <span class="pill">Multiplex</span>` : ''}${v.flags?.vocals ? html` <span class="pill">Guide vocal</span>` : ''}</td>
          <td class="num">${formatTime(v.dur)}</td>
          <td class="file ellipsis" title=${v.file}>${v.file}</td>
          <td><button class="btn small" onClick=${() => openDialog({ type: 'add', songId, trackId: v.id })}>Queue</button></td>
        </tr>`)}</tbody>
      </table>
    `}
  </${Modal}>`;
}

export function EditDialog({ entryId }) {
  const { state } = useStore(store);
  const entry = state.queue.find((e) => e.id === entryId) || state.pending.find((e) => e.id === entryId);
  const { data: song } = useFetch(entry ? `/api/songs/${encodeURIComponent(entry.songId)}` : null);
  const [name, setName] = useState(entry ? entry.singers.map((s) => s.name).join(' & ') : '');
  const [key, setKey] = useState(entry?.key || 0);
  const [tempo, setTempo] = useState(entry?.tempo || 1);
  const [trackId, setTrackId] = useState(entry?.trackId || '');
  const [mystery, setMystery] = useState(!!entry?.mystery);
  if (!entry) {
    return html`<${Modal} title="Edit song" onClose=${closeDialog}><p>This song is no longer in the queue.</p></${Modal}>`;
  }
  const save = async () => {
    const patch = { key, tempo, trackId, mystery };
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
    <label class="toggle-row"><span><b>Mystery song</b><br /><span class="hint">Guests and the TV see “Surprise!” until it starts.</span></span>
      <span class="switch"><input type="checkbox" checked=${mystery} onChange=${(e) => setMystery(e.currentTarget.checked)} /><span></span></span>
    </label>
  </${Modal}>`;
}

export function InviteDialog() {
  const { state } = useStore(store);
  const info = state.info;
  const qr = `/api/qr.svg?margin=0&dark=%231b1230&light=%23fff8e6&text=${encodeURIComponent(info.joinUrl)}`;
  const wifi = state.settings.party.wifi;
  const printCard = () => {
    const w = window.open('', 'openkaraoke-card', 'width=800,height=1000');
    if (!w) return toast('Pop-up blocked — allow pop-ups to print the card.', 'error');
    w.document.write(`<!doctype html><title>Table card</title><style>
      body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:40px;color:#111}
      h1{font-size:46px;margin:10px 0}p{font-size:22px;margin:8px 0}img{width:360px;height:360px;margin:24px auto;display:block}
      .code{font-size:52px;font-weight:800;letter-spacing:.2em}.url{font-size:20px;color:#444}
      .card{border:3px dashed #999;border-radius:24px;padding:30px;max-width:560px;margin:0 auto}</style>
      <div class="card"><h1>${escapeHtml(info.name)}</h1><p>Scan to pick your karaoke songs</p>
      <img src="${location.origin}${qr}"><div class="code">${info.roomCode}</div><p class="url">${escapeHtml(info.joinUrl)}</p>
      ${wifi?.ssid ? `<p>Wi-Fi: <b>${escapeHtml(wifi.ssid)}</b></p>` : ''}</div>
      <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>`);
    w.document.close();
    return undefined;
  };
  return html`<${Modal} title="Invite guests" onClose=${closeDialog} class="invite">
    <div class="invite-body">
      <div class="marquee"><img src=${qr} alt="QR code to join" /></div>
      <div class="invite-text">
        <p>Guests scan the code with their phone camera — no app needed. They must be on the same Wi-Fi as this computer.</p>
        <div class="invite-code">${info.roomCode}</div>
        <div class="invite-url">
          <input class="input" readonly value=${info.joinUrl} onFocus=${(e) => e.currentTarget.select()} />
          <button class="btn" onClick=${() => copyText(info.joinUrl).then(() => toast('Link copied', 'ok'))}><${Icon} name="link" size=${16} /> Copy</button>
        </div>
        ${info.lanUrls.length > 1 && html`<p class="hint">Phones can't open it? Try another address of this computer: ${info.lanUrls.slice(1).map((u) => html`<code>${u}/j/${info.roomCode}</code> `)}</p>`}
        <div class="btn-row">
          <button class="btn" onClick=${printCard}><${Icon} name="printer" size=${16} /> Print a table card</button>
          <button class="btn ghost" onClick=${() => { closeDialog(); go('/settings/party'); }}>Change code or Wi-Fi</button>
        </div>
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
    case 'edit': return html`<${EditDialog} entryId=${dialog.entryId} />`;
    case 'invite': return html`<${InviteDialog} />`;
    case 'folder': return html`<${FolderDialog} onPick=${dialog.onPick} />`;
    case 'announce': return html`<${AnnounceDialog} />`;
    default: return null;
  }
}

