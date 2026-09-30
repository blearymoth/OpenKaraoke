// Settings: one section per group of DEFAULT_SETTINGS (only options that do something today).
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural } from '../lib/store.js';
import { Switch } from '../lib/components.js';
import { store, act, openDialog, toast } from './state.js';
import { CHANNEL_MODES, CHANNEL_LABELS } from '/shared/protocol.js';

const SECTIONS = [
  {
    id: 'party', title: 'Party', icon: 'sparkles', fields: [
      { path: 'party.name', label: 'Party name', type: 'text', help: 'Shown on the TV and on guests’ phones.' },
      { path: 'party.roomCode', label: 'Room code', type: 'roomcode', help: 'The four letters in the join link. After a change, guests need to scan the new QR code.' },
      { path: 'party.guestsEnabled', label: 'Guests can request songs', type: 'bool' },
      { path: 'party.adminPin', label: 'Host PIN', type: 'pin', help: 'Lets you run the party from a phone or tablet: open this page there and enter the PIN. Without a PIN, only this computer can use the host controls.' },
      { path: 'party.trustLocalhost', label: 'This computer never needs the PIN', type: 'bool' },
      { path: 'party.wifi.ssid', label: 'Wi-Fi name', type: 'text', placeholder: 'Your network name' },
      { path: 'party.wifi.password', label: 'Wi-Fi password', type: 'password' },
      { path: 'party.wifi.security', label: 'Wi-Fi security', type: 'select', options: [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'Open network']] },
      { path: 'party.wifi.show', label: 'Show a Wi-Fi QR code on the TV', type: 'bool', help: 'Guests can join your Wi-Fi by scanning it.' },
    ],
  },
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
      { path: 'guests.reactions', label: 'Guests can send reactions to the TV', type: 'bool' },
    ],
  },
  {
    id: 'playback', title: 'Playback', icon: 'play', fields: [
      { path: 'playback.countdown', label: 'Countdown before each song (seconds)', type: 'number', min: 0, max: 60 },
      { path: 'playback.autoStart', label: 'Start the first song as soon as it’s queued', type: 'bool', help: 'Only when a TV display is open.' },
      { path: 'playback.autoAdvance', label: 'Move on to the next singer automatically', type: 'bool' },
      { path: 'playback.startPaused', label: 'Wait for play after the countdown', type: 'bool', help: 'The host presses play when the singer is ready.' },
      { path: 'playback.normalize', label: 'Even out loudness between songs', type: 'bool' },
      { path: 'playback.defaultChannelMode', label: 'Default channel mode', type: 'select', options: CHANNEL_MODES.map((m) => [m, CHANNEL_LABELS[m]]), help: 'Changes you make during a song are remembered for that track.' },
      { path: 'playback.lyricOffsetMs', label: 'Lyrics timing (milliseconds)', type: 'number', min: -2000, max: 2000, step: 10, help: 'Raise it if the lyrics run behind the music (for example with Bluetooth speakers).' },
    ],
  },
  {
    id: 'display', title: 'TV display', icon: 'tv', fields: [
      { path: 'display.background', label: 'Background', type: 'select', options: [['art', 'Blurred cover art'], ['visualizer', 'Moving lights'], ['plain', 'Plain']] },
      { path: 'display.cdgTransparent', label: 'Show the background behind the lyrics', type: 'bool' },
      { path: 'display.cdgSmoothing', label: 'Smooth lyrics text', type: 'bool', help: 'Rounder, sharper-looking letters on big screens.' },
      { path: 'display.showQr', label: 'QR code in the corner while singing', type: 'bool' },
      { path: 'display.showTitleCard', label: 'Singer and song at the start of each song', type: 'bool' },
      { path: 'display.showUpNext', label: '“Up next” reminder near the end of a song', type: 'bool' },
      { path: 'display.showTicker', label: 'Ticker with the next singers', type: 'bool' },
      { path: 'display.tickerMessage', label: 'Ticker message', type: 'text', placeholder: 'For example: Happy birthday, Sam!' },
      { path: 'display.showProgress', label: 'Progress bar', type: 'bool' },
      { path: 'display.showReactions', label: 'Show guests’ reactions', type: 'bool' },
      { path: 'display.accent', label: 'Accent colour', type: 'color' },
    ],
  },
  { id: 'about', title: 'About', icon: 'music', custom: 'about' },
];

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function patchFor(path, value) {
  const keys = path.split('.');
  const patch = {};
  let o = patch;
  keys.slice(0, -1).forEach((k) => { o = o[k] = {}; });
  o[keys.at(-1)] = value;
  return patch;
}

async function save(path, value) {
  const r = await act('settings.update', { patch: patchFor(path, value) });
  if (r) toast('Saved', 'ok', 1200);
}

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
  const random = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
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
  else if (f.type === 'select') control = html`<select class="select" value=${value} onChange=${(e) => save(f.path, e.currentTarget.value)}>${f.options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>`;
  else if (f.type === 'pin') control = html`<${PinField} hasPin=${hasPin} />`;
  else if (f.type === 'roomcode') control = html`<${RoomCodeField} value=${value} />`;
  else if (f.type === 'color') control = html`<input type="color" class="color-input" value=${value} onChange=${(e) => save(f.path, e.currentTarget.value)} aria-label=${f.label} />`;
  return html`<div class=${`setting ${f.type === 'bool' ? 'bool' : ''}`}>
    <div class="setting-text"><b>${f.label}</b>${f.help && html`<p class="hint">${f.help}</p>`}</div>
    <div class="setting-control">${control}</div>
  </div>`;
}

function LibrarySection({ state, lib }) {
  const library = state.library;
  const paths = library.roots.map((r) => r.path);
  const [brands, setBrands] = useState(state.settings.library.brandPriority.join(', '));
  const add = () => openDialog({ type: 'folder', onPick: (p) => act('library.paths', { paths: [...paths.filter((x) => x !== p), p] }) });
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
  `;
}

function About({ state }) {
  const shortcuts = [['Space', 'Play / pause'], ['N', 'Next singer'], ['/', 'Search'], ['← →', 'Seek 5 seconds'], ['+ −', 'Key up / down'], ['[ ]', 'Tempo down / up']];
  return html`<div class="about">
    <p><b>OpenKaraoke ${state.info.version}</b> — your own karaoke party server. ${plural(state.library.songs, 'song')} from ${plural(state.library.tracks, 'track')}.</p>
    <p class="hint">Addresses of this computer: ${state.info.lanUrls.join(', ') || 'none found'}.</p>
    <h3 class="section-title">Keyboard shortcuts</h3>
    <div class="kbd-grid">${shortcuts.map(([k, v]) => html`<kbd>${k}</kbd><span>${v}</span>`)}</div>
    <h3 class="section-title">TV on a second screen</h3>
    <p class="muted">Use <b>Open TV display</b> in the player bar, or run <code>bin/open-tv.sh</code> to start Chrome/Chromium in full screen on the second screen with sound allowed straight away.</p>
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
        ${current.custom === 'library' && html`<${LibrarySection} state=${state} lib=${lib} />`}
        ${current.custom === 'about' && html`<${About} state=${state} />`}
        ${current.fields?.map((f) => html`<${Field} key=${f.path} f=${f} settings=${state.settings} hasPin=${state.hasPin} />`)}
      </section>
    </div>
  </div>`;
}
