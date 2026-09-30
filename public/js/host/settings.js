// Settings UI generated from a descriptor list that mirrors DEFAULT_SETTINGS (server/config.js).
import { html, useState, useEffect } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { api } from '/js/lib/api.js';
import { Icon, Toggle, Modal, Spinner, timeAgo, useNow } from '/js/lib/ui.js';
import { CHANNEL_MODES, CHANNEL_LABELS } from '/shared/protocol.js';
import { store, act, libStore } from './state.js';

const SECTIONS = [
  { id: 'library', label: 'Library', icon: 'folder' },
  { id: 'party', label: 'Party & security', icon: 'lock' },
  { id: 'queue', label: 'Queue & guests', icon: 'users' },
  { id: 'playback', label: 'Playback', icon: 'play' },
  { id: 'display', label: 'TV display', icon: 'tv' },
  { id: 'artwork', label: 'Artwork', icon: 'grid' },
  { id: 'server', label: 'Network', icon: 'wifi' },
];

const FIELDS = {
  library: [
    { path: 'library.rescanOnStart', label: 'Rescan the library when OpenKaraoke starts', type: 'toggle', help: 'Finds new or removed files. Unchanged folders are fast to rescan.' },
    { path: 'library.brandPriority', label: 'Preferred karaoke labels', type: 'list', help: 'Comma separated label codes, best first — e.g. SF, #Z, SC. Used to pick the default version of a song.' },
  ],
  party: [
    { path: 'party.name', label: 'Party name', type: 'text', help: 'Shown on the TV and on guests’ phones.' },
    { path: 'party.adminPin', label: 'Host PIN', type: 'password', help: 'Lets other devices (a tablet or phone) open the host controls. Leave empty to allow host controls only on this computer.' },
    { path: 'party.trustLocalhost', label: 'This computer never needs the PIN', type: 'toggle' },
    { path: 'party.guestsEnabled', label: 'Guests can join and request songs', type: 'toggle' },
    { path: 'party.wifi.show', label: 'Show a Wi-Fi QR code on the TV lobby', type: 'toggle', help: 'Guests can join your Wi-Fi by scanning it.' },
    { path: 'party.wifi.ssid', label: 'Wi-Fi name (SSID)', type: 'text', show: (s) => s.party.wifi.show },
    { path: 'party.wifi.password', label: 'Wi-Fi password', type: 'password', show: (s) => s.party.wifi.show },
    { path: 'party.wifi.security', label: 'Wi-Fi security', type: 'select', options: [['WPA', 'WPA/WPA2/WPA3'], ['WEP', 'WEP'], ['nopass', 'Open network']], show: (s) => s.party.wifi.show },
    { path: 'party.wifi.hidden', label: 'Hidden network', type: 'toggle', show: (s) => s.party.wifi.show },
  ],
  queue: [
    { path: 'queue.mode', label: 'Queue order', type: 'select', options: [['rotation', 'Fair rotation (round-robin by singer)'], ['fifo', 'First come, first served']] },
    { path: 'queue.newcomersFirst', label: 'People who haven’t sung yet go first', type: 'toggle', show: (s) => s.queue.mode === 'rotation' },
    { path: 'queue.requireApproval', label: 'Approve guest requests', type: 'toggle', help: 'Guest songs wait in “Requests” until you accept them.' },
    { path: 'queue.maxPerGuest', label: 'Songs per guest in the queue', type: 'number', min: 0, max: 50, help: '0 = unlimited' },
    { path: 'queue.maxDuration', label: 'Longest song guests may pick', type: 'number', min: 0, max: 60, unit: 'min', scale: 60, help: '0 = no limit' },
    { path: 'queue.allowRepeats', label: 'Allow the same song twice in one party', type: 'toggle' },
    { path: 'queue.explicitFilter', label: 'Hide explicit songs from guests', type: 'toggle' },
    { path: 'queue.guestCanRemoveOwn', label: 'Guests can remove their own songs', type: 'toggle' },
    { path: 'queue.guestsSeeQueue', label: 'Guests can see the whole queue', type: 'toggle' },
    { path: 'queue.guestKeyChange', label: 'Guests can choose a key', type: 'toggle' },
    { path: 'guests.reactions', label: 'Emoji reactions from phones', type: 'toggle' },
    { path: 'guests.photos', label: 'Guests can send photos to the TV', type: 'toggle', soon: true },
    { path: 'guests.photoApproval', label: 'Approve photos before they are shown', type: 'toggle', soon: true },
    { path: 'guests.games', label: 'Guests can join party games', type: 'toggle', soon: true },
  ],
  playback: [
    { path: 'playback.countdown', label: 'Next-singer countdown', type: 'number', min: 0, max: 60, unit: 's' },
    { path: 'playback.startPaused', label: 'Wait for the host to press play after the countdown', type: 'toggle' },
    { path: 'playback.autoAdvance', label: 'Start the next singer automatically', type: 'toggle' },
    { path: 'playback.normalize', label: 'Even out loudness between songs', type: 'toggle' },
    { path: 'playback.defaultChannelMode', label: 'Default channel mode', type: 'select', options: CHANNEL_MODES.map((m) => [m, CHANNEL_LABELS[m]]) },
    { path: 'playback.lyricOffsetMs', label: 'Lyrics offset', type: 'number', min: -2000, max: 2000, step: 10, unit: 'ms', help: 'Positive = lyrics later. Use it if the words look early/late compared to the sound on your TV.' },
    { path: 'playback.fadeSeconds', label: 'Fade out when skipping', type: 'number', min: 0, max: 10, step: 0.5, unit: 's' },
    { path: 'playback.volume', label: 'Default volume', type: 'range', min: 0, max: 1, step: 0.05 },
    { path: 'playback.whenQueueEmpty', label: 'When the queue is empty', type: 'select', options: [['lobby', 'Show the lobby with the QR code'], ['break', 'Break music (coming soon)'], ['autoplay', 'Autoplay sing-alongs (coming soon)']] },
    { path: 'playback.ratingAfterSong', label: 'Guests rate each performance', type: 'toggle', soon: true },
    { path: 'playback.breakMusic.enabled', label: 'Break music between singers', type: 'toggle', soon: true },
    { path: 'playback.breakMusic.source', label: 'Break music source', type: 'select', options: [['library', 'Instrumentals from the library'], ['folder', 'A music folder']], soon: true },
    { path: 'playback.breakMusic.folder', label: 'Break music folder', type: 'text', soon: true },
    { path: 'playback.breakMusic.volume', label: 'Break music volume', type: 'range', min: 0, max: 1, step: 0.05, soon: true },
    { path: 'playback.breakMusic.matchNext', label: 'Match the genre/decade of the next song', type: 'toggle', soon: true },
  ],
  display: [
    { path: 'display.background', label: 'Background behind the lyrics', type: 'select', options: [['art', 'Cover art (blurred)'], ['visualizer', 'Audio visualiser'], ['plain', 'Plain'], ['photos', 'Guest photos (coming soon)']] },
    { path: 'display.cdgTransparent', label: 'Transparent lyrics background', type: 'toggle', help: 'Shows the background through the CDG paper colour.' },
    { path: 'display.cdgSmoothing', label: 'Smooth lyrics on big screens', type: 'toggle' },
    { path: 'display.showQr', label: 'Small join QR code while singing', type: 'toggle' },
    { path: 'display.showTitleCard', label: 'Song title card at the start', type: 'toggle' },
    { path: 'display.showUpNext', label: '“Up next” banner at the end of a song', type: 'toggle' },
    { path: 'display.showProgress', label: 'Progress bar', type: 'toggle' },
    { path: 'display.showTicker', label: 'Ticker with the next singers', type: 'toggle' },
    { path: 'display.tickerMessage', label: 'Ticker message', type: 'text', help: 'e.g. “Drinks 2-for-1 until 10 pm!”' },
    { path: 'display.showReactions', label: 'Floating emoji reactions', type: 'toggle' },
    { path: 'display.accent', label: 'Accent colour', type: 'color' },
    { path: 'display.visualizer', label: 'Visualiser style', type: 'select', options: [['aurora', 'Aurora bars']], show: (s) => s.display.background === 'visualizer' },
  ],
  artwork: [
    { note: 'Automatic cover art and artist pictures arrive in a later version (milestone M5). Until then songs show generated gradient covers.' },
    { path: 'artwork.enabled', label: 'Download cover art', type: 'toggle' },
    { path: 'artwork.providers.deezer', label: 'Deezer', type: 'toggle' },
    { path: 'artwork.providers.musicbrainz', label: 'MusicBrainz / Cover Art Archive', type: 'toggle' },
    { path: 'artwork.providers.theaudiodb', label: 'TheAudioDB (artist pictures)', type: 'toggle' },
    { path: 'artwork.providers.itunes', label: 'iTunes (no caching allowed by its terms)', type: 'toggle' },
    { path: 'artwork.providers.fanarttv', label: 'Fanart.tv (needs your own API key)', type: 'toggle' },
    { path: 'artwork.background', label: 'Use artist pictures as TV backgrounds', type: 'toggle' },
    { path: 'artwork.theaudiodbKey', label: 'TheAudioDB API key', type: 'text', help: '“123” is the free test key.' },
    { path: 'artwork.fanartKey', label: 'Fanart.tv API key', type: 'password' },
    { path: 'artwork.maxCacheMB', label: 'Artwork cache size', type: 'number', min: 100, max: 100000, unit: 'MB' },
  ],
  server: [
    { note: 'Changes here take effect after restarting OpenKaraoke.' },
    { path: 'server.port', label: 'Port', type: 'number', min: 1, max: 65535 },
    { path: 'server.host', label: 'Listen address', type: 'text', help: '0.0.0.0 = reachable from phones on your network; 127.0.0.1 = this computer only.' },
    { path: 'server.publicUrl', label: 'Address for guests', type: 'text', help: 'Leave empty to detect it automatically, e.g. http://192.168.1.20:8080' },
  ],
};

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function patchFor(path, value) {
  const out = {};
  const keys = path.split('.');
  let o = out;
  keys.slice(0, -1).forEach((k) => { o = o[k] = {}; });
  o[keys.at(-1)] = value;
  return out;
}
const save = (path, value) => act('settings.update', { patch: patchFor(path, value) });

export function Settings({ section = 'library' }) {
  const st = useStore(store, (s) => s.state);
  const settings = st.settings;
  return html`<div class="view settings">
    <h2>Settings</h2>
    <div class="settings-layout">
      <nav class="settings-nav">${SECTIONS.map((s) => html`<a key=${s.id} class=${section === s.id ? 'on' : ''} href=${`#/settings/${s.id}`}><${Icon} name=${s.icon} size=${17} /> ${s.label}</a>`)}</nav>
      <div class="settings-body card">
        ${section === 'library' && html`<${LibrarySettings} st=${st} />`}
        ${section === 'party' && html`<${PartyExtras} st=${st} />`}
        ${(FIELDS[section] || []).map((f, i) => (f.note ? html`<p key=${i} class="note">${f.note}</p>` : (!f.show || f.show(settings)) && html`<${Field} key=${f.path} f=${f} value=${get(settings, f.path)} />`))}
      </div>
    </div>
  </div>`;
}

function Field({ f, value }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? value;
  let control;
  if (f.type === 'toggle') {
    control = html`<${Toggle} checked=${value} onChange=${(v) => save(f.path, v)} />`;
  } else if (f.type === 'select') {
    control = html`<select class="input" value=${value} onChange=${(e) => save(f.path, e.currentTarget.value)}>${f.options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>`;
  } else if (f.type === 'number') {
    const scale = f.scale || 1;
    control = html`<div class="row" style=${{ gap: '6px' }}><input class="input num" type="number" min=${f.min} max=${f.max} step=${f.step || 1}
      value=${draft ?? Math.round((value / scale) * 100) / 100}
      onInput=${(e) => setDraft(e.currentTarget.value)}
      onBlur=${() => { if (draft !== null) { save(f.path, Number(draft) * scale); setDraft(null); } }}
      onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />${f.unit ? html`<span class="dim">${f.unit}</span>` : null}</div>`;
  } else if (f.type === 'range') {
    control = html`<div class="row"><input type="range" min=${f.min} max=${f.max} step=${f.step} value=${shown}
      onInput=${(e) => setDraft(Number(e.currentTarget.value))} onChange=${(e) => { save(f.path, Number(e.currentTarget.value)); setDraft(null); }} /><span class="dim">${Math.round(shown * 100)} %</span></div>`;
  } else if (f.type === 'color') {
    control = html`<input type="color" value=${value} onChange=${(e) => save(f.path, e.currentTarget.value)} />`;
  } else if (f.type === 'list') {
    control = html`<input class="input" value=${draft ?? (value || []).join(', ')} onInput=${(e) => setDraft(e.currentTarget.value)}
      onBlur=${() => { if (draft !== null) { save(f.path, draft.split(',').map((x) => x.trim()).filter(Boolean)); setDraft(null); } }}
      onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />`;
  } else {
    control = html`<input class="input" type=${f.type === 'password' ? 'password' : 'text'} value=${shown ?? ''} autocomplete="off"
      onInput=${(e) => setDraft(e.currentTarget.value)}
      onBlur=${() => { if (draft !== null) { save(f.path, draft); setDraft(null); } }}
      onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />`;
  }
  const inline = f.type === 'toggle';
  return html`<div class=${`field${inline ? ' inline' : ''}${f.soon ? ' soon' : ''}`}>
    <div class="grow"><div class="label">${f.label}${f.soon ? html` <span class="tag">coming soon</span>` : null}</div>${f.help && html`<div class="help">${f.help}</div>`}</div>
    <div class="control">${control}</div>
  </div>`;
}

function PartyExtras({ st }) {
  return html`<div class="field">
    <div class="grow"><div class="label">Party code</div><div class="help">Part of the join link and QR code. A new code stops old links from working.</div></div>
    <div class="control row"><b class="code-chip">${st.party.roomCode}</b>
      <button class="btn small" onClick=${() => { if (confirm('Make a new party code?')) act('party.newCode'); }}>New code</button></div>
  </div>
  <div class="field">
    <div class="grow"><div class="label">New party</div><div class="help">Clears the queue, tonight’s history and “sung tonight” counts. Guests keep their names.</div></div>
    <div class="control"><button class="btn danger" onClick=${() => { if (confirm('Start a new party? The queue and tonight’s history are cleared.')) act('party.new', {}, { ok: 'New party started' }); }}>Start new party</button></div>
  </div>`;
}

function LibrarySettings({ st }) {
  const lib = st.library;
  const live = useStore(libStore, (s) => s.progress);
  const [picker, setPicker] = useState(false);
  const now = useNow(10000);
  const paths = st.settings.library.paths || [];
  const setPaths = (list) => act('settings.update', { patch: { library: { paths: list } } });
  return html`<div class="lib-settings">
    <div class="label" style=${{ marginBottom: '8px' }}>Karaoke folders</div>
    ${!paths.length && html`<p class="muted">No folder yet. Add the folder that contains your CDG+MP3 (or MP4) karaoke files — e.g. on your USB drive.</p>`}
    ${paths.map((p) => {
      const r = lib.roots.find((x) => x.path === p);
      return html`<div class="folder-row" key=${p}>
        <${Icon} name="folder" size=${18} />
        <div class="grow ellipsis" title=${p}>${p}</div>
        ${r && html`<span class=${`tag${r.online === false ? ' x' : ''}`}>${r.online === false ? 'offline' : `${r.tracks.toLocaleString()} tracks`}</span>`}
        <button class="btn icon small ghost danger" title="Remove" onClick=${() => { if (confirm(`Remove ${p} from the library?`)) setPaths(paths.filter((x) => x !== p)); }}><${Icon} name="x" size=${16} /></button>
      </div>`;
    })}
    <div class="row" style=${{ marginTop: '12px', flexWrap: 'wrap' }}>
      <button class="btn primary" onClick=${() => setPicker(true)}><${Icon} name="plus" size=${16} /> Add folder</button>
      <button class="btn" disabled=${!paths.length || lib.state === 'scanning'} onClick=${() => act('library.rescan', {}, { ok: 'Rescanning…' })}><${Icon} name="refresh" size=${16} /> Rescan now</button>
    </div>
    <div class="lib-status">
      ${lib.state === 'scanning' ? html`<${Spinner} size=${16} /> Scanning… ${live ? `${live.tracks.toLocaleString()} tracks, ${live.dirs.toLocaleString()} folders` : ''}`
        : html`<b>${lib.songs.toLocaleString()}</b> songs · <b>${lib.tracks.toLocaleString()}</b> tracks · <b>${lib.artists.toLocaleString()}</b> artists
          ${lib.lastScan ? html` · last scan ${timeAgo(lib.lastScan.at, now)} (${(lib.lastScan.ms / 1000).toFixed(1)} s${lib.lastScan.errorCount ? `, ${lib.lastScan.errorCount} problem(s)` : ''})` : ''}`}
    </div>
    ${picker && html`<${FolderPicker} onClose=${() => setPicker(false)} onPick=${(p) => { setPicker(false); if (!paths.includes(p)) setPaths([...paths, p]); }} />`}
  </div>`;
}

function FolderPicker({ onClose, onPick }) {
  const [path, setPath] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null);
    setErr('');
    api('/api/fs/list', { params: { path } }).then((d) => { if (alive) { setData(d); setTyped(d.path); } }, (e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [path]);
  return html`<${Modal} onClose=${onClose} wide=${true}>
    <h2 style=${{ marginTop: 0 }}>Choose the karaoke folder</h2>
    <form class="row" onSubmit=${(e) => { e.preventDefault(); setPath(typed); }}>
      <button type="button" class="btn icon" title="Up" disabled=${!data?.parent} onClick=${() => setPath(data.parent)}><${Icon} name="up" size=${18} /></button>
      <input class="input" value=${typed} placeholder="/run/media/you/DRIVE/Karaoke" onInput=${(e) => setTyped(e.currentTarget.value)} />
      <button class="btn">Go</button>
    </form>
    ${!path && html`<p class="muted">Suggested places (USB drives are usually under /run/media/<i>you</i>):</p>`}
    ${err && html`<p class="err">${err}</p>`}
    <div class="folder-list">
      ${!data ? html`<${Spinner} />` : data.dirs.length ? data.dirs.map((d) => html`<button key=${d.path} class="folder-item" onClick=${() => setPath(d.path)}><${Icon} name="folder" size=${18} /> ${d.name}</button>`)
        : html`<p class="muted">No sub-folders here.</p>`}
    </div>
    ${data?.path && html`<div class="row" style=${{ marginTop: '14px' }}>
      <span class="grow muted ellipsis">${data.karaokeFiles ? `${data.karaokeFiles} karaoke file(s) directly in this folder` : 'Sub-folders are scanned too.'}</span>
      <button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn primary" onClick=${() => onPick(data.path)}>Use this folder</button>
    </div>`}
  </${Modal}>`;
}
