// Host app building blocks: song rows/lists, add-to-queue dialog, song details, invite.
import { html, useState, useEffect, useRef, useMemo } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { api, qrUrl } from '/js/lib/api.js';
import { Icon, Cover, SingerBadge, Modal, Spinner, formatDuration, useAsync, toast } from '/js/lib/ui.js';
import { formatKey, formatTempo, KEY_MIN, KEY_MAX, clampTempo } from '/shared/protocol.js';
import { store, ui, act, openAdd, openDetails, setLastSinger } from './state.js';

// ---- song rows -----------------------------------------------------------------------

export function SongRow({ song, index }) {
  const st = useStore(store, (s) => s.state);
  const queued = song.q || st?.queue?.some((e) => e.songId === song.id) || st?.current?.songId === song.id;
  const sung = song.sung || st?.tonight?.some((h) => h.songId === song.id);
  const fav = st?.favorites?.includes(song.id);
  return html`<div class="song-row" onClick=${() => openDetails(song.id)}>
    ${index !== undefined && html`<span class="idx dim">${index + 1}</span>`}
    <${Cover} song=${song} />
    <div class="grow">
      <div class="t ellipsis">${song.title}
        ${song.x ? html` <span class="tag x">E</span>` : null}
        ${song.duet ? html` <span class="tag duet">DUET</span>` : null}
      </div>
      <div class="a ellipsis">${song.artist}${song.year ? ` · ${song.year}` : ''}</div>
    </div>
    <div class="marks">
      ${sung && html`<span class="mark sung" title="Sung tonight">✓ sung</span>`}
      ${queued && html`<span class="mark queued" title="In the queue">in queue</span>`}
      ${fav && html`<${Icon} name="heart" size=${14} class="fav" />`}
    </div>
    ${song.v > 1 && html`<span class="tag" title="Versions">${song.v}×</span>`}
    <span class="d">${formatDuration(song.dur)}</span>
    <button class="btn icon small primary" title="Add to queue" onClick=${(e) => { e.stopPropagation(); openAdd(song); }}><${Icon} name="plus" size=${18} /></button>
  </div>`;
}

/** Paged list of songs. `load(offset, limit)` returns { total, items }. */
export function SongList({ load, deps = [], empty = 'No songs found', pageSize = 60, numbered = false, header = null }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fuzzy, setFuzzy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    Promise.resolve(load(0, pageSize)).then((r) => {
      if (my !== seq.current) return;
      setItems(r.items);
      setTotal(r.total);
      setFuzzy(!!r.fuzzy);
      setLoading(false);
    }, (e) => { if (my === seq.current) { setError(e.message); setLoading(false); } });
  }, deps);
  const more = async () => {
    const my = seq.current;
    setLoading(true);
    const r = await load(items.length, pageSize);
    if (my !== seq.current) return;
    setItems((list) => [...list, ...r.items]);
    setLoading(false);
  };
  if (error) return html`<div class="empty"><div class="big">⚠️</div>${error}</div>`;
  if (!loading && !items.length) return html`<div class="empty"><div class="big">🔍</div>${empty}</div>`;
  return html`<div class="song-list">
    ${header}
    ${fuzzy && html`<div class="hint muted">Showing close matches (typo-tolerant search)</div>`}
    ${items.map((s, i) => html`<${SongRow} key=${s.id} song=${s} index=${numbered ? i : undefined} />`)}
    ${loading && html`<div class="center" style=${{ padding: '20px' }}><${Spinner} /></div>`}
    ${!loading && items.length < total && html`<div class="center" style=${{ padding: '14px' }}><button class="btn" onClick=${more}>Show more (${(total - items.length).toLocaleString()} left)</button></div>`}
  </div>`;
}

// ---- add to queue --------------------------------------------------------------------

export function AddDialog() {
  const add = useStore(ui, (s) => s.addFor);
  if (!add) return null;
  return html`<${AddDialogInner} key=${add.song.id} add=${add} />`;
}

function AddDialogInner({ add }) {
  const st = useStore(store, (s) => s.state);
  const lastSinger = useStore(ui, (s) => s.lastSinger);
  const singers = useMemo(() => [...(st?.singers || [])].sort((a, b) => (b.online - a.online) || (a.sung - b.sung) || a.name.localeCompare(b.name)), [st?.singers]);
  const [singerId, setSingerId] = useState(() => (add.singerId || (singers.some((s) => s.id === lastSinger) ? lastSinger : null)));
  const [newName, setNewName] = useState('');
  const [key, setKey] = useState(0);
  const [tempo, setTempo] = useState(1);
  const [position, setPosition] = useState('rotation');
  const [trackId, setTrackId] = useState(add.trackId || '');
  const [busy, setBusy] = useState(false);
  const detail = useAsync((signal) => (add.song.v > 1 || add.trackId ? api(`/api/songs/${add.song.id}`, { signal }) : null), [add.song.id]);
  const close = () => ui.set({ addFor: null });
  const submit = async (playNow = false) => {
    if (busy) return;
    const payload = { songId: add.song.id, key, tempo, position: position === 'rotation' ? undefined : position };
    if (trackId) payload.trackId = trackId;
    if (newName.trim()) payload.singerName = newName.trim();
    else if (singerId) payload.singerId = singerId;
    setBusy(true);
    const r = await act('queue.add', { ...payload, autostart: !playNow });
    setBusy(false);
    if (!r) return;
    if (playNow) await act('player.play', { entryId: r.entryId });
    else toast(`Added “${add.song.title}”`, 'ok', 2000);
    if (payload.singerId) setLastSinger(payload.singerId);
    else if (payload.singerName) {
      const s = store.get().state?.singers?.find((x) => x.name.toLowerCase() === payload.singerName.toLowerCase());
      if (s) setLastSinger(s.id);
    }
    close();
  };
  const versions = detail.data?.versions || [];
  return html`<${Modal} onClose=${close}>
    <form class="add-dialog" onSubmit=${(e) => { e.preventDefault(); submit(false); }}>
      <div class="row" style=${{ gap: '14px', marginBottom: '16px' }}>
        <${Cover} song=${add.song} size=${64} />
        <div class="grow"><div style=${{ fontWeight: 800, fontSize: '19px' }}>${add.song.title}</div><div class="muted">${add.song.artist}</div></div>
      </div>
      <div class="field-label">Who's singing?</div>
      <div class="singer-pick">
        ${singers.map((s) => html`<button type="button" key=${s.id} class=${`chip${singerId === s.id && !newName ? ' on' : ''}`} onClick=${() => { setSingerId(s.id); setNewName(''); }}>
          <span>${s.emoji}</span>${s.name}${s.online ? html`<span class="dot-online"></span>` : null}${s.queued ? html`<span class="dim">· ${s.queued}</span>` : null}
        </button>`)}
        <button type="button" class=${`chip${!singerId && !newName ? ' on' : ''}`} onClick=${() => { setSingerId(null); setNewName(''); }}>No singer</button>
      </div>
      <input class="input" style=${{ marginTop: '10px' }} placeholder="…or type a new singer's name" value=${newName} onInput=${(e) => setNewName(e.currentTarget.value)} maxLength="24" />

      <div class="add-grid">
        <div>
          <div class="field-label">Key</div>
          <div class="stepper">
            <button type="button" class="btn icon small" onClick=${() => setKey((k) => Math.max(KEY_MIN, k - 1))}><${Icon} name="minus" size=${16} /></button>
            <b>${formatKey(key)}</b>
            <button type="button" class="btn icon small" onClick=${() => setKey((k) => Math.min(KEY_MAX, k + 1))}><${Icon} name="plus" size=${16} /></button>
          </div>
        </div>
        <div>
          <div class="field-label">Tempo</div>
          <div class="stepper">
            <button type="button" class="btn icon small" onClick=${() => setTempo((t) => clampTempo(t - 0.05))}><${Icon} name="minus" size=${16} /></button>
            <b>${formatTempo(tempo)}</b>
            <button type="button" class="btn icon small" onClick=${() => setTempo((t) => clampTempo(t + 0.05))}><${Icon} name="plus" size=${16} /></button>
          </div>
        </div>
        <div>
          <div class="field-label">Position</div>
          <select class="input" value=${position} onChange=${(e) => setPosition(e.currentTarget.value)}>
            <option value="rotation">Fair rotation</option>
            <option value="next">Play next</option>
            <option value="end">End of queue</option>
          </select>
        </div>
      </div>
      ${versions.length > 1 && html`<div>
        <div class="field-label">Version</div>
        <select class="input" value=${trackId || detail.data.best} onChange=${(e) => setTrackId(e.currentTarget.value)}>
          ${versions.map((v) => html`<option value=${v.id}>${v.brandName || v.brand || 'Unknown label'}${v.variant ? ` — ${v.variant}` : ''} (${formatDuration(v.dur)}${v.kind === 'video' ? ', video' : ''})</option>`)}
        </select>
      </div>`}
      <div class="row" style=${{ justifyContent: 'flex-end', marginTop: '20px', flexWrap: 'wrap' }}>
        <button type="button" class="btn ghost" onClick=${close}>Cancel</button>
        <button type="button" class="btn" onClick=${() => submit(true)} disabled=${busy}><${Icon} name="play" size=${16} /> Play now</button>
        <button type="submit" class="btn primary" disabled=${busy}><${Icon} name="plus" size=${16} /> Add to queue</button>
      </div>
    </form>
  </${Modal}>`;
}

// ---- song details ---------------------------------------------------------------------

export function SongDetails() {
  const id = useStore(ui, (s) => s.details);
  if (!id) return null;
  return html`<${SongDetailsInner} key=${id} id=${id} />`;
}

function SongDetailsInner({ id }) {
  const { data, error, loading } = useAsync((signal) => api(`/api/songs/${id}`, { signal }), [id]);
  const favs = useStore(store, (s) => s.state?.favorites || []);
  const [preview, setPreview] = useState(null);
  const close = () => ui.set({ details: null });
  const fav = favs.includes(id);
  return html`<${Modal} onClose=${close} wide=${true}>
    ${loading && html`<div class="center" style=${{ padding: '40px' }}><${Spinner} /></div>`}
    ${error && html`<div class="empty">${error.message}</div>`}
    ${data && html`<div class="details">
      <div class="details-head">
        <${Cover} song=${data} size=${140} big=${true} />
        <div class="grow">
          <div class="dim" style=${{ fontSize: '12px', letterSpacing: '.1em', textTransform: 'uppercase' }}>Song</div>
          <h2>${data.title}</h2>
          <div class="artists">${data.artists.map((a, i) => html`${i ? ' · ' : ''}<a href=${`#/artist/${encodeURIComponent(a.key)}`} onClick=${close}>${a.name}</a>`)}</div>
          <div class="row" style=${{ flexWrap: 'wrap', marginTop: '10px', gap: '6px' }}>
            ${data.tags.map((t) => html`<a class="tag" href=${`#/tag/${encodeURIComponent(t)}`} onClick=${close}>${t}</a>`)}
            ${data.x ? html`<span class="tag x">Explicit</span>` : null}
            <span class="dim" style=${{ fontSize: '13px' }}>${formatDuration(data.dur)} · ${data.versions.length} version${data.versions.length > 1 ? 's' : ''}${data.plays ? ` · sung ${data.plays}× here` : ''}</span>
          </div>
          <div class="row" style=${{ marginTop: '14px', flexWrap: 'wrap' }}>
            <button class="btn primary" onClick=${() => { close(); openAdd(data); }}><${Icon} name="plus" size=${16} /> Add to queue</button>
            <button class=${`btn${fav ? ' fav-on' : ''}`} onClick=${() => act('favorite.toggle', { songId: id })}><${Icon} name="heart" size=${16} /> ${fav ? 'Favourite' : 'Add to favourites'}</button>
          </div>
        </div>
      </div>
      <h3>Versions</h3>
      <table class="versions">
        <thead><tr><th>Label</th><th>Variant</th><th>Length</th><th class="hide-sm">File</th><th></th></tr></thead>
        <tbody>
          ${data.versions.map((v) => html`<tr key=${v.id} class=${v.id === data.best ? 'best' : ''}>
            <td><b>${v.brand || '—'}</b>${v.brandName && v.brandName !== v.brand ? html` <span class="dim">${v.brandName}</span>` : null}${v.id === data.best ? html` <span class="tag">default</span>` : null}</td>
            <td>${v.variant || html`<span class="dim">—</span>`}${v.flags?.mpx ? html` <span class="tag">multiplex</span>` : null}</td>
            <td>${formatDuration(v.dur)}</td>
            <td class="hide-sm file ellipsis" title=${v.file}>${v.file}</td>
            <td class="row" style=${{ justifyContent: 'flex-end', gap: '6px' }}>
              ${v.kind !== 'video' && html`<button class="btn small" title="Preview on this computer" onClick=${() => setPreview(preview === v.id ? null : v.id)}><${Icon} name="headphones" size=${14} /></button>`}
              <button class="btn small" onClick=${() => { close(); openAdd(data, { trackId: v.id }); }}>Queue</button>
            </td>
          </tr>`)}
        </tbody>
      </table>
      ${preview && html`<div class="preview"><span class="muted">Preview (plays here, not on the TV):</span><audio src=${`/media/${preview}/audio`} controls autoplay /></div>`}
    </div>`}
  </${Modal}>`;
}

// ---- invite ------------------------------------------------------------------------------

export function InviteModal() {
  const open = useStore(ui, (s) => s.invite);
  const party = useStore(store, (s) => s.state?.party);
  if (!open || !party) return null;
  const close = () => ui.set({ invite: false });
  return html`<${Modal} onClose=${close}>
    <div class="invite">
      <h2>Invite guests</h2>
      <p class="muted">Guests scan this code with their phone camera (same Wi-Fi) to pick songs.</p>
      <div class="qr-big"><img src=${qrUrl(party.joinUrl, { margin: 1 })} alt="Join QR code" /></div>
      <div class="join-url">${party.joinUrl}</div>
      <div class="code-line">Party code <b>${party.roomCode}</b></div>
      ${party.lanUrls?.length > 1 && html`<details class="muted"><summary>Other network addresses</summary>${party.lanUrls.map((u) => html`<div>${u}/j/${party.roomCode}</div>`)}</details>`}
      <div class="row" style=${{ justifyContent: 'center', marginTop: '16px', flexWrap: 'wrap' }}>
        <button class="btn" onClick=${() => navigator.clipboard?.writeText(party.joinUrl).then(() => toast('Link copied', 'ok'))}><${Icon} name="link" size=${16} /> Copy link</button>
        <a class="btn" href="/print/qr" target="_blank"><${Icon} name="qr" size=${16} /> Print table card</a>
        <button class="btn" onClick=${async () => { if (confirm('Make a new party code? Guests will need to scan the new QR code.')) await act('party.newCode'); }}><${Icon} name="refresh" size=${16} /> New code</button>
        <button class="btn primary" onClick=${close}>Done</button>
      </div>
    </div>
  </${Modal}>`;
}

export function AnnounceModal() {
  const open = useStore(ui, (s) => s.announce);
  const [text, setText] = useState('');
  const [secs, setSecs] = useState(10);
  if (!open) return null;
  const close = () => ui.set({ announce: false });
  return html`<${Modal} onClose=${close}>
    <form onSubmit=${async (e) => { e.preventDefault(); if (await act('announce', { text, seconds: secs }) !== undefined) { setText(''); close(); } }}>
      <h2 style=${{ marginTop: 0 }}>Announcement on the TV</h2>
      <input class="input" autoFocus placeholder="e.g. Pizza is here! 🍕" value=${text} onInput=${(e) => setText(e.currentTarget.value)} maxLength="200" />
      <div class="row" style=${{ marginTop: '12px' }}>
        <span class="muted">Show for</span>
        <select class="input" style=${{ width: 'auto' }} value=${secs} onChange=${(e) => setSecs(Number(e.currentTarget.value))}>
          ${[5, 10, 20, 30, 60].map((n) => html`<option value=${n}>${n} seconds</option>`)}
        </select>
        <span class="grow"></span>
        <button type="button" class="btn ghost" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${!text.trim()}><${Icon} name="megaphone" size=${16} /> Show</button>
      </div>
    </form>
  </${Modal}>`;
}

/** Remote host login with the PIN (the party PC itself never needs it). */
export function PinLogin({ denied }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const noPin = denied?.reason && /only available on the party computer/.test(denied.reason);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/auth/pin', { method: 'POST', body: { pin, deviceId: 'host-web' } });
      localStorage.setItem('ok.hostToken', JSON.stringify(r.token));
      location.reload();
    } catch (x) { setErr(x.message); }
  };
  return html`<div class="login">
    <form class="card" onSubmit=${submit}>
      <div style=${{ fontSize: '44px' }}>🎛️</div>
      <h2>Host controls</h2>
      ${noPin ? html`<p class="muted">${denied.reason}</p>` : html`
        <p class="muted">Enter the host PIN to control the party from this device.</p>
        <input class="input pin" type="password" inputMode="numeric" autoFocus value=${pin} onInput=${(e) => setPin(e.currentTarget.value)} placeholder="PIN" />
        ${err && html`<div class="err">${err}</div>`}
        <button class="btn primary block" style=${{ marginTop: '12px' }}>Unlock</button>`}
      <a class="muted" href="/" style=${{ display: 'block', marginTop: '14px' }}>← Back</a>
    </form>
  </div>`;
}
