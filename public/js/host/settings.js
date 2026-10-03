// Settings: one section per group of DEFAULT_SETTINGS (only options that do something today).
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural } from '../lib/store.js';
import { Switch } from '../lib/components.js';
import { store, act, openDialog, toast, chooseFolder, saveSetting } from './state.js';
import { CHANNEL_MODES, CHANNEL_LABELS } from '/shared/protocol.js';
import { THEMES, THEME_IDS, DEFAULT_THEME, accentInk } from '/shared/themes.js';
import { UpdatesBlock } from './updates.js';
import { HotspotBlock } from './hotspot.js';
import { GraphicsBlock } from './graphics.js';
import { DisplayRow, PairingRow } from './devices.js';

const SECTIONS = [
  {
    id: 'party', title: 'Party', icon: 'sparkles', fields: [
      { path: 'party.name', label: 'Party name', type: 'text', help: 'Shown on the TV and on guests’ phones.' },
      { path: 'party.roomCode', label: 'Room code', type: 'roomcode', help: 'The four letters in the join link. After a change, guests need to scan the new QR code.' },
      { path: 'party.guestsEnabled', label: 'Guests can request songs', type: 'bool' },
      { path: 'party.adminPin', label: 'Host PIN', type: 'pin', help: 'Lets you run the party from a phone or tablet: open this page there and enter the PIN. Without a PIN, only this computer can use the host controls.' },
      { path: 'party.trustLocalhost', label: 'This computer never needs the PIN', type: 'bool' },
      { path: 'party.hotspot', type: 'hotspot' }, // its own block (hotspot.js)
      { path: 'party.wifi.ssid', label: 'Home Wi-Fi name', type: 'text', placeholder: 'Your network name' },
      { path: 'party.wifi.password', label: 'Home Wi-Fi password', type: 'password' },
      { path: 'party.wifi.security', label: 'Home Wi-Fi security', type: 'select', options: [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'Open network']] },
      { path: 'party.wifi.show', label: 'Show a QR code for the home Wi-Fi on the TV', type: 'bool', help: 'Guests can join your Wi-Fi by scanning it. While the party hotspot is on, the TV shows the hotspot’s instead.' },
    ],
  },
  { id: 'appearance', title: 'Appearance', icon: 'palette', custom: 'appearance' },
  { id: 'library', title: 'Library', icon: 'folder', custom: 'library' },
  {
    id: 'queue', title: 'Queue & guests', icon: 'list', fields: [
      { path: 'queue.mode', label: 'Queue order', type: 'select', options: [['rotation', 'Fair rotation — one song per singer per round'], ['fifo', 'First come, first served']] },
      { path: 'queue.newcomersFirst', label: 'People who haven’t sung yet go first', type: 'bool', when: (s) => s.queue.mode === 'rotation' },
      { path: 'queue.requireApproval', label: 'Approve guest requests', type: 'bool', help: 'Requests wait in the Requests tab until you accept them.' },
      { path: 'queue.maxPerGuest', label: 'Songs waiting per guest', type: 'number', min: 0, max: 50, help: '0 means no limit.' },
      { path: 'queue.maxDuration', label: 'Longest song guests can pick (minutes)', type: 'minutes', help: '0 means no limit.' },
      { path: 'queue.allowRepeats', label: 'Allow the same song twice in one night', type: 'bool' },
      { path: 'queue.explicitFilter', label: 'Hide explicit songs from guests', type: 'bool' },
      { path: 'queue.guestCanRemoveOwn', label: 'Guests can remove their own songs', type: 'bool' },
      { path: 'queue.guestsSeeQueue', label: 'Guests see the whole queue', type: 'bool', help: 'When off, guests only see their own songs.' },
      { path: 'queue.guestKeyChange', label: 'Guests can choose a key', type: 'bool' },
      { path: 'guests.versionVotes', label: 'Guests can vote on song versions', type: 'bool', help: 'Thumbs up or down on versions played tonight. A version two votes ahead plays by default (even over your preferred labels); one two votes behind only when there is no other. Your own vote always settles it.' },
      { path: 'queue.guestVocals', label: 'Guests can ask for a guide singer', type: 'bool', help: 'On multiplex songs (the original singer on a channel of its own), and versions with or without backing vocals. Singers can switch the guide on or off during their own song.' },
      { path: 'guests.reactions', label: 'Guests can send reactions to the TV', type: 'bool' },
      { path: 'guests.photos', label: 'Guests can send photos to the TV', type: 'bool' },
      { path: 'guests.photoApproval', label: 'Approve photos before they appear', type: 'bool', when: (s) => s.guests.photos },
      { path: 'guests.games', label: 'Guests can play games on their phones', type: 'bool' },
    ],
  },
  {
    id: 'playback', title: 'Playback', icon: 'play', fields: [
      { path: 'playback.countdown', label: 'Countdown before each song (seconds)', type: 'number', min: 0, max: 60 },
      { path: 'playback.autoStart', label: 'Start the first song as soon as it’s queued', type: 'bool', help: 'Only when a TV display is open.' },
      { path: 'playback.autoAdvance', label: 'Move on to the next singer automatically', type: 'bool' },
      { path: 'playback.startPaused', label: 'Wait for play after the countdown', type: 'bool', help: 'The host presses play when the singer is ready.' },
      { path: 'playback.normalize', label: 'Even out loudness between songs', type: 'bool' },
      { path: 'playback.defaultChannelMode', label: 'Default channel mode', type: 'select', options: CHANNEL_MODES.map((m) => [m, CHANNEL_LABELS[m]]), help: 'Changes you make during a song are remembered for that track. Multiplex songs have the guide singer level instead.' },
      { path: 'playback.leadVocal', label: 'Guide singer at the start of a song', type: 'select', options: [[0, 'Off'], [50, 'Quiet'], [100, 'Full']], help: 'On multiplex songs only. A singer’s own choice (when queueing, or last time) comes first.' },
      { path: 'playback.findGuideVocal', label: 'Suggest multiplex songs found by their sound', type: 'bool', help: 'The TV checks each song’s two channels when it loads it. Songs named “Multiplex” are always recognised; for others the Vocals button lights up and you decide.' },
      { path: 'playback.lyricOffsetMs', label: 'Lyrics timing (milliseconds)', type: 'number', min: -2000, max: 2000, step: 10, help: 'Raise it if the lyrics run behind the music (for example with Bluetooth speakers).' },
      { path: 'playback.ratingAfterSong', label: 'Guests rate each performance', type: 'bool', help: 'After a song, phones can give it 1–5 stars for about 40 seconds.' },
      { path: 'playback.breakMusic.enabled', label: 'Break music between singers', type: 'bool', help: 'Quiet music on the TV while nobody sings; it fades out when the next song starts.' },
      { path: 'playback.breakMusic.source', label: 'Break music comes from', type: 'select', options: [['library', 'Backing tracks from the karaoke library'], ['folder', 'A music folder']], when: (s) => s.playback.breakMusic.enabled },
      { path: 'playback.breakMusic.folder', label: 'Music folder', type: 'text', placeholder: '/home/me/Music', help: 'Every audio file inside (and in sub-folders) is played at random.', when: (s) => s.playback.breakMusic.enabled && s.playback.breakMusic.source === 'folder' },
      { path: 'playback.breakMusic.matchNext', label: 'Match the next song’s genre and decade', type: 'bool', when: (s) => s.playback.breakMusic.enabled && s.playback.breakMusic.source === 'library' },
      { path: 'playback.breakMusic.volume', label: 'Break music volume (%)', type: 'percent', when: (s) => s.playback.breakMusic.enabled },
      { path: 'playback.whenQueueEmpty', label: 'When the queue is empty', type: 'select', options: [['lobby', 'Show the lobby and wait'], ['autoplay', 'Start a popular sing-along for everyone']] },
      { path: 'playback.autoplayAfter', label: 'Sing-along after (seconds)', type: 'number', min: 10, max: 600, when: (s) => s.playback.whenQueueEmpty === 'autoplay' },
    ],
  },
  {
    id: 'display', title: 'TV display', icon: 'tv', fields: [
      { path: 'display.background', label: 'Background', type: 'select', options: [['art', 'Cover art and artist photos'], ['photos', 'Guests’ photos'], ['visualizer', 'Moving lights'], ['plain', 'Plain']] },
      { path: 'display.fanart', label: 'Artist photos behind the lyrics', type: 'bool', help: 'Slowly moving photos of the artist when there are some (see Artwork); otherwise the blurred cover.', when: (s) => s.display.background === 'art' },
      { path: 'display.cdgTransparent', label: 'Show the background behind the lyrics', type: 'bool' },
      { path: 'display.cdgSmoothing', label: 'Smooth lyrics text', type: 'bool', help: 'Rounder, sharper-looking letters on big screens.' },
      { path: 'display.showQr', label: 'QR code in the corner while singing', type: 'bool' },
      { path: 'display.showTitleCard', label: 'Singer and song at the start of each song', type: 'bool' },
      { path: 'display.showUpNext', label: '“Up next” reminder near the end of a song', type: 'bool' },
      { path: 'display.showTicker', label: 'Ticker with the next singers', type: 'bool' },
      { path: 'display.tickerMessage', label: 'Ticker message', type: 'text', placeholder: 'For example: Happy birthday, Sam!' },
      { path: 'display.showProgress', label: 'Progress bar', type: 'bool' },
      { path: 'display.showReactions', label: 'Show guests’ reactions', type: 'bool' },
    ],
  },
  { id: 'displays', title: 'Displays', icon: 'tv', custom: 'displays' },
  { id: 'artwork', title: 'Artwork', icon: 'disc', custom: 'artwork' },
  { id: 'about', title: 'About', icon: 'music', custom: 'about' },
];

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const save = (path, value) => saveSetting(path, value);

const MASK = '••••••'; // the server never sends saved passwords back

function TextField({ f, value }) {
  const hidden = f.type === 'password' && value === MASK;
  const initial = hidden ? '' : value ?? '';
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [value]);
  const [show, setShow] = useState(false);
  const commit = () => {
    if (hidden && !v) return; // keep the saved password
    if (v !== (value ?? '')) save(f.path, v);
  };
  return html`<div class="inline-form">
    <input class="input" type=${f.type === 'password' && !show ? 'password' : 'text'} value=${v} maxlength="200"
      placeholder=${hidden ? 'Saved — type to replace it' : f.placeholder || ''}
      onInput=${(e) => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    ${f.type === 'password' && !hidden && html`<button class="icon-btn small" aria-label=${show ? 'Hide' : 'Show'} onClick=${() => setShow(!show)}><${Icon} name="eye" size=${16} /></button>`}
    ${hidden && html`<button class="btn small ghost danger" onClick=${() => save(f.path, '')}>Remove</button>`}
  </div>`;
}

function NumberField({ f, value, scale = 1 }) {
  const [v, setV] = useState(String(Math.round((value ?? 0) / scale)));
  useEffect(() => setV(String(Math.round((value ?? 0) / scale))), [value]);
  const commit = () => {
    const n = Math.min(f.max ?? 1e9, Math.max(f.min ?? 0, Number(v) || 0));
    if (n * scale !== value) save(f.path, n * scale);
    else setV(String(n));
  };
  return html`<input class="input narrow num" type="number" value=${v} min=${f.min} max=${f.max} step=${f.step || 1}
    onInput=${(e) => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />`;
}

function PinField({ hasPin }) {
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState('');
  if (!editing) {
    return html`<div class="inline-form">
      <span class=${hasPin ? '' : 'faint'}>${hasPin ? 'A PIN is set' : 'No PIN'}</span>
      <button class="btn small" onClick=${() => setEditing(true)}>${hasPin ? 'Change' : 'Set a PIN'}</button>
      ${hasPin && html`<button class="btn small ghost danger" onClick=${() => save('party.adminPin', '')}>Remove</button>`}
    </div>`;
  }
  return html`<form class="inline-form" onSubmit=${async (e) => { e.preventDefault(); if (!/^\d{4,8}$/.test(pin)) return toast('Use 4 to 8 digits', 'error'); await save('party.adminPin', pin); setEditing(false); setPin(''); }}>
    <input class="input narrow num" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="4–8 digits" value=${pin} onInput=${(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} autofocus />
    <button class="btn small primary">Save PIN</button><button type="button" class="btn small ghost" onClick=${() => setEditing(false)}>Cancel</button>
  </form>`;
}

function RoomCodeField({ value }) {
  // Random letters from the browser's cryptographic generator (24 letters: 256 % 24 = 16, so
  // bytes ≥ 240 are skipped to keep every letter equally likely).
  const random = () => {
    const out = [];
    while (out.length < 4) {
      for (const n of crypto.getRandomValues(new Uint8Array(8))) if (n < 240 && out.length < 4) out.push('ABCDEFGHJKLMNPQRSTUVWXYZ'[n % 24]);
    }
    return out.join('');
  };
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return html`<div class="inline-form">
    <input class="input narrow code-input" value=${v} maxlength="4" onInput=${(e) => setV(e.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, ''))}
      onBlur=${() => v !== value && (v.length === 4 ? save('party.roomCode', v) : setV(value))} aria-label="Room code" />
    <button class="btn small" onClick=${() => save('party.roomCode', random())}><${Icon} name="refresh" size=${14} /> New code</button>
  </div>`;
}

function Field({ f, settings, hasPin }) {
  if (f.when && !f.when(settings)) return null;
  const value = get(settings, f.path);
  let control;
  if (f.type === 'bool') control = html`<${Switch} checked=${!!value} label=${f.label} onChange=${(v) => save(f.path, v)} />`;
  else if (f.type === 'text' || f.type === 'password') control = html`<${TextField} f=${f} value=${value} />`;
  else if (f.type === 'number') control = html`<${NumberField} f=${f} value=${value} />`;
  else if (f.type === 'minutes') control = html`<${NumberField} f=${{ ...f, min: 0, max: 60 }} value=${value} scale=${60} />`;
  else if (f.type === 'percent') control = html`<${NumberField} f=${{ ...f, min: 0, max: 100 }} value=${value} scale=${0.01} />`;
  else if (f.type === 'select') control = html`<select class="select" value=${value} onChange=${(e) => save(f.path, e.currentTarget.value)}>${f.options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>`;
  else if (f.type === 'pin') control = html`<${PinField} hasPin=${hasPin} />`;
  else if (f.type === 'roomcode') control = html`<${RoomCodeField} value=${value} />`;
  return html`<div class=${`setting ${f.type === 'bool' ? 'bool' : ''}`}>
    <div class="setting-text"><b>${f.label}</b>${f.help && html`<p class="hint">${f.help}</p>`}</div>
    <div class="setting-control">${control}</div>
  </div>`;
}

/** Skins for every screen (settings.appearance); the colours are tokens in /css/base.css. */
function AppearanceSection({ state }) {
  const theme = Object.hasOwn(THEMES, state.settings.appearance?.theme) ? state.settings.appearance.theme : DEFAULT_THEME;
  const accent = state.settings.appearance?.accent || '';
  return html`
    <div class="setting column">
      <div class="setting-text"><b>Skin</b><p class="hint">The look of the host controls, the TV and guests’ phones. A change shows everywhere straight away.</p></div>
      <div class="skins" role="radiogroup" aria-label="Skin">
        ${THEME_IDS.map((id) => html`<${SkinCard} key=${id} id=${id} on=${id === theme} accent=${accent} />`)}
      </div>
    </div>
    <div class="setting">
      <div class="setting-text"><b>Accent colour</b><p class="hint">${accent ? 'Your own colour replaces the skin’s, in either skin.' : `The ${THEMES[theme].name} skin’s own colour.`} Buttons, highlights and the TV’s progress bar use it.</p></div>
      <div class="setting-control"><div class="inline-form accent-form">
        <input type="color" class="color-input" value=${accent || THEMES[theme].accent} aria-label="Accent colour" onChange=${(e) => save('appearance.accent', e.currentTarget.value)} />
        <button class="btn small" disabled=${!accent} onClick=${() => save('appearance.accent', '')}>Use the skin’s colour</button>
      </div></div>
    </div>`;
}

/** A skin to pick, with a small live sample drawn with that skin's own tokens. */
function SkinCard({ id, on, accent }) {
  const t = THEMES[id];
  const sample = accent ? { '--neon': accent, '--neon-ink': accentInk(accent) } : undefined;
  return html`<button type="button" role="radio" aria-checked=${on ? 'true' : 'false'} class=${`skin-card ${on ? 'on' : ''}`} data-skin=${id}
    onClick=${() => !on && save('appearance.theme', id)}>
    <span class="skin-sample" data-theme=${id} style=${sample} aria-hidden="true">
      <span class="skin-panel">
        <span class="skin-title"><img src="/img/icon.svg" alt="" width="26" height="26" /><b>Karaoke Night</b></span>
        <span class="skin-line">Up next: <em>Sam</em> · room <em>ABCD</em></span>
        <span class="skin-row"><span class="skin-button">Sing</span><i></i><i></i><i></i></span>
      </span>
    </span>
    <span class="skin-name"><b>${t.name}</b>${on && html`<span class="pill neon">In use</span>`}</span>
    <span class="hint">${t.description}</span>
  </button>`;
}

function LibrarySection({ state, lib }) {
  const library = state.library;
  const paths = library.roots.map((r) => r.path);
  const [brands, setBrands] = useState(state.settings.library.brandPriority.join(', '));
  const add = () => chooseFolder((p) => act('library.paths', { paths: [...paths.filter((x) => x !== p), p] }));
  const last = library.lastScan;
  return html`
    <div class="setting column">
      <div class="setting-text"><b>Karaoke folders</b><p class="hint">Every sub-folder is included. Files are never changed.</p></div>
      <div class="folders">
        ${library.roots.map((r) => html`<div class="folder-row">
          <span class=${`dot ${r.online ? 'on' : 'bad'}`} title=${r.online ? 'Connected' : 'Not found'}></span>
          <div class="grow"><div class="ellipsis mono">${r.path}</div><div class="hint">${r.online ? plural(r.tracks, 'track') : 'Not connected — plug in the drive'}</div></div>
          <button class="btn small ghost danger" onClick=${() => confirm(`Stop using ${r.path}? Its songs disappear from the library.`) && act('library.paths', { paths: paths.filter((p) => p !== r.path) })}>Remove</button>
        </div>`)}
        <div class="btn-row">
          <button class="btn primary" onClick=${add}><${Icon} name="folder" size=${16} /> Add folder</button>
          <button class="btn" disabled=${library.scanning || !paths.length} onClick=${() => act('library.rescan')}><${Icon} name="refresh" size=${16} /> ${library.scanning ? 'Scanning…' : 'Scan for new songs'}</button>
        </div>
        ${library.scanning && html`<p class="hint">${lib ? `${lib.tracks.toLocaleString()} tracks found in ${lib.dirs.toLocaleString()} folders…` : 'Starting…'}</p>`}
        ${last && !library.scanning && html`<p class="hint">Last scan ${new Date(last.at).toLocaleString()}: ${plural(last.tracks, 'track')} in ${(last.ms / 1000).toFixed(1)} s${last.errorCount ? `, ${plural(last.errorCount, 'problem')} (e.g. ${last.errors[0]?.error})` : ''}.</p>`}
      </div>
    </div>
    <div class="setting">
      <div class="setting-text"><b>Preferred karaoke labels</b><p class="hint">When a song has several versions, these labels are picked first. Use the codes from the file names, for example: SF, SC, ZM.</p></div>
      <div class="setting-control"><input class="input" value=${brands} placeholder="SF, SC" onInput=${(e) => setBrands(e.currentTarget.value)}
        onBlur=${() => save('library.brandPriority', brands.split(',').map((b) => b.trim()).filter(Boolean))} /></div>
    </div>
    <${Field} f=${{ path: 'library.rescanOnStart', label: 'Look for new songs every time OpenKaraoke starts', type: 'bool' }} settings=${state.settings} />
    <${SongbookBlock} />
  `;
}

/** Printable songbook: opens an A4 page (print or save as PDF) or downloads a CSV. */
function SongbookBlock() {
  const [sort, setSort] = useState('artist');
  const [popular, setPopular] = useState('0');
  const [columns, setColumns] = useState('3');
  const [explicit, setExplicit] = useState(true);
  const url = (format) => `/api/export/songbook?${new URLSearchParams({ format, sort, popular, columns, explicit: explicit ? '1' : '0' })}`;
  return html`<div class="setting column">
    <div class="setting-text"><b>Printable songbook</b><p class="hint">A list of every song for the tables, with the join QR code on top. Opens in a new tab: print it or save it as a PDF. The whole library is many pages — “most popular” keeps it short.</p></div>
    <div class="row-3 songbook-form">
      <label class="field"><span>Order</span><select class="select" value=${sort} onChange=${(e) => setSort(e.currentTarget.value)}><option value="artist">By artist</option><option value="title">By title</option></select></label>
      <label class="field"><span>Songs</span><select class="select" value=${popular} onChange=${(e) => setPopular(e.currentTarget.value)}>
        <option value="0">All songs</option><option value="250">250 most popular</option><option value="1000">1,000 most popular</option><option value="5000">5,000 most popular</option></select></label>
      <label class="field"><span>Columns</span><select class="select" value=${columns} onChange=${(e) => setColumns(e.currentTarget.value)}><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
    </div>
    <label class="check-row"><${Switch} checked=${explicit} label="Include explicit songs" onChange=${setExplicit} /> Include explicit songs</label>
    <div class="btn-row">
      <a class="btn primary" href=${url('html')} target="_blank" rel="noopener"><${Icon} name="printer" size=${16} /> Open songbook</a>
      <a class="btn" href=${url('csv')} download="songbook.csv"><${Icon} name="list" size=${16} /> Download CSV</a>
    </div>
  </div>`;
}

const CRAWL_STATE = {
  running: 'Looking songs up…',
  waiting: 'Waiting: a service asked us to slow down, or the internet is not reachable. It carries on by itself.',
  done: 'Everything has been looked up.',
  paused: 'Background lookups are paused.',
  off: 'Off.',
  idle: 'Starts shortly after OpenKaraoke starts.',
};
const PROVIDER_NOTES = {
  deezer: 'Covers, artist pictures, genre, year, explicit flag and popularity. No key needed.',
  musicbrainz: 'Fallback for songs Deezer doesn’t know: covers from the Cover Art Archive and the year. Slow (one request a second).',
  theaudiodb: 'Artist photos, logos and cut-outs for the TV and artist pages.',
  itunes: 'Extra fallback. Apple’s terms don’t allow keeping its artwork, so it is off by default.',
  fanarttv: 'HD artist backgrounds and logos. Needs your own API key (below).',
};
const STATUS_TEXT = { ok: 'OK', offline: 'Not reachable', limited: 'Asked us to slow down', error: 'Problem' };

function hoursMinutes(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function ArtworkSection({ state }) {
  const { artwork: st } = useStore(store);
  useEffect(() => {
    act('artwork.status', {}, { quiet: true }).then((r) => r && store.update({ artwork: r }));
  }, []);
  const settings = state.settings;
  const on = settings.artwork.enabled;
  const pct = (n) => (st?.songs.total ? `${(n / st.songs.total) * 100}%` : '0%');
  return html`
    <${Field} f=${{ path: 'artwork.enabled', label: 'Find cover art and song information online', type: 'bool', help: 'Covers, artist photos, genres and years come from Deezer, MusicBrainz and TheAudioDB. Only song and artist names are sent; images are kept in the data folder so they also work without internet later.' }} settings=${settings} />
    <${Field} f=${{ path: 'artwork.crawl', label: 'Look up the whole library in the background', type: 'bool', help: 'Most popular songs first, a few per second. Songs on screen and the next singers are always looked up straight away.', when: () => on }} settings=${settings} />
    ${st && on && html`<div class="setting column">
      <div class="setting-text"><b>Progress</b><p class="hint">${CRAWL_STATE[st.state] || st.state}</p></div>
      <div class="art-progress" role="img" aria-label=${`${st.songs.found} of ${st.songs.total} songs have a cover`}>
        <i class="found" style=${{ width: pct(st.songs.found) }}></i><i class="missed" style=${{ width: pct(st.songs.missed) }}></i>
      </div>
      <p class="hint">
        <b>${st.songs.found.toLocaleString()}</b> of ${plural(st.songs.total, 'song')} have a cover · ${st.songs.missed.toLocaleString()} not found online · ${st.songs.pending.toLocaleString()} still to look up${st.perMin ? ` · ${st.perMin.toLocaleString()} a minute` : ''}${st.etaSec ? ` · about ${hoursMinutes(st.etaSec)} left` : ''}.
      </p>
      <p class="hint">${st.artists.pictures.toLocaleString()} of ${plural(st.artists.total, 'artist')} have a picture. Image cache: ${st.cache.mb.toLocaleString()} MB of ${st.cache.maxMb.toLocaleString()} MB (${plural(st.cache.files, 'image')}).</p>
      <div class="btn-row"><button class="btn small" onClick=${() => act('artwork.retry').then((r) => r && toast(r.cleared ? `Looking up ${plural(r.cleared, 'song')} again` : 'Trying again', 'ok'))}><${Icon} name="refresh" size=${14} /> Try songs without a cover again</button></div>
    </div>`}
    ${on && html`<div class="setting column">
      <div class="setting-text"><b>Sources</b></div>
      <div class="providers">${(st?.providers || []).map((p) => html`<div class="provider-row">
        <${Switch} checked=${!!settings.artwork.providers[p.name]} label=${p.label} onChange=${(v) => save(`artwork.providers.${p.name}`, v)} />
        <div class="grow">
          <b>${p.label}</b>
          ${p.on && html` <span class=${`pill ${p.status === 'ok' ? '' : 'bad'}`}>${STATUS_TEXT[p.status] || p.status}${p.pausedSec ? ` · retry in ${p.pausedSec} s` : ''}</span>`}
          <p class="hint">${PROVIDER_NOTES[p.name] || ''}${p.on && p.status !== 'ok' && p.lastError ? ` Last problem: ${p.lastError}` : ''}</p>
        </div>
      </div>`)}</div>
    </div>`}
    ${on && html`
      <${Field} f=${{ path: 'artwork.theaudiodbKey', label: 'TheAudioDB key', type: 'text', placeholder: '123', help: '123 is the free key (30 lookups a minute). Supporters of TheAudioDB get a faster personal key.' }} settings=${settings} />
      <${Field} f=${{ path: 'artwork.fanartKey', label: 'Fanart.tv API key', type: 'text', placeholder: 'Optional', help: 'Get a free key at fanart.tv to add HD artist backgrounds and logos.' }} settings=${settings} />
      <${Field} f=${{ path: 'artwork.maxCacheMB', label: 'Image cache limit (MB)', type: 'number', min: 50, max: 200000, help: 'The least recently shown images are removed when the cache is full. About 20 KB per song thumbnail.' }} settings=${settings} />`}
  `;
}

function DisplaysSection({ state }) {
  const lan = state.info.lanUrls[0] || state.info.baseUrl;
  return html`
    <div class="setting column">
      <div class="setting-text"><b>Connected displays</b><p class="hint">The main display plays the music; the others are muted. When the main TV disconnects, another TV page plays until it is back — mirrors and queue boards stay muted.</p></div>
      ${state.displays.length
        ? html`<div class="folders">${state.displays.map((d) => html`<${DisplayRow} key=${d.id} d=${d} />`)}</div>`
        : html`<p class="muted">No display is connected. Use “Open TV display” on the Home page, or open <code>${lan}/tv</code> on the TV.</p>`}
    </div>
    <div class="setting column">
      <div class="setting-text"><b>Screens waiting to be paired</b>
        <p class="hint">To use a TV or projector attached to another computer (or a smart TV browser), open <code>${lan}/tv</code> on it. It shows a four-digit code: approve it here if the code matches. For a big list of who sings next (by the bar or the stage) open <code>${lan}/tv?layout=board</code> instead.${state.info.mode === 'hotspot' && state.info.baseUrl !== lan ? html` A screen on the party hotspot’s Wi-Fi uses <code>${state.info.baseUrl}/tv</code>.` : ''}</p></div>
      ${state.pairings.length
        ? html`<div class="folders">${state.pairings.map((p) => html`<${PairingRow} key=${p.id} p=${p} />`)}</div>
          ${state.pairings.length > 1 && html`<div class="btn-row"><button class="btn small ghost danger" onClick=${() => act('display.deny', { all: true })}>Deny all</button></div>`}`
        : html`<p class="muted">None right now.</p>`}
    </div>
    <div class="setting">
      <div class="setting-text"><b>Forget paired screens</b><p class="hint">Every screen paired so far has to show a new code and be approved again. Screens on this computer are not affected.</p></div>
      <div class="setting-control"><button class="btn ghost danger" onClick=${() => confirm('Log out every paired screen?') && act('display.forget').then((r) => r && toast('Paired screens forgotten', 'ok'))}>Forget all</button></div>
    </div>`;
}

function About({ state }) {
  const shortcuts = [['Space', 'Play / pause'], ['N', 'Next singer'], ['/', 'Search'], ['← →', 'Seek 5 seconds'], ['+ −', 'Key up / down'], ['[ ]', 'Tempo down / up']];
  return html`<div class="about">
    <p><b>OpenKaraoke ${state.info.version}</b> — your own karaoke party server. ${plural(state.library.songs, 'song')} from ${plural(state.library.tracks, 'track')}.</p>
    <p class="hint">Addresses of this computer: ${state.info.lanUrls.join(', ') || 'none found'}.</p>
    <${UpdatesBlock} />
    <${GraphicsBlock} />
    <h3 class="section-title">Keyboard shortcuts</h3>
    <div class="kbd-grid">${shortcuts.map(([k, v]) => html`<kbd>${k}</kbd><span>${v}</span>`)}</div>
    <h3 class="section-title">TV on a second screen</h3>
    ${window.okDesktop
      ? html`<p class="muted">Use <b>Open TV display</b> on the home page or <b>Open TV window</b> under Devices: the TV window opens full screen on your second screen (connect the TV first — or later, the window moves there by itself). <kbd>F11</kbd> switches full screen on and off; the OpenKaraoke menu (<kbd>Alt</kbd>) can move it to another screen. On native Wayland (see Graphics) move it yourself: <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>→</kbd> or drag it to the TV, and it goes full screen there — or, with the mouse on the TV, <kbd>Ctrl</kbd>+<kbd>T</kbd> opens it right there (then <kbd>F11</kbd>).</p>`
      : html`<p class="muted">Use <b>Open TV display</b> on the home page, or run <code>bin/open-tv.sh</code> to start Chrome/Chromium in full screen on the second screen with sound allowed straight away.</p>`}
  </div>`;
}

export function Settings({ section = 'party' }) {
  const { state, lib } = useStore(store);
  const current = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  return html`<div class="page settings">
    <header class="page-head"><div><h1>Settings</h1><p class="muted">Changes save straight away.</p></div></header>
    <div class="settings-layout">
      <nav class="settings-nav">${SECTIONS.map((s) => html`<a class=${s.id === current.id ? 'on' : ''} href=${`#/settings/${s.id}`}><${Icon} name=${s.icon} size=${18} /> ${s.title}</a>`)}</nav>
      <section class="settings-body">
        <h2>${current.title}</h2>
        ${current.custom === 'appearance' && html`<${AppearanceSection} state=${state} />`}
        ${current.custom === 'library' && html`<${LibrarySection} state=${state} lib=${lib} />`}
        ${current.custom === 'about' && html`<${About} state=${state} />`}
        ${current.custom === 'artwork' && html`<${ArtworkSection} state=${state} />`}
        ${current.custom === 'displays' && html`<${DisplaysSection} state=${state} />`}
        ${current.fields?.map((f) => (f.type === 'hotspot'
          ? html`<${HotspotBlock} key=${f.path} state=${state} />`
          : html`<${Field} key=${f.path} f=${f} settings=${state.settings} hasPin=${state.hasPin} />`))}
      </section>
    </div>
  </div>`;
}
