// Singers, guests and displays.
import { html, useState } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { Icon, SingerBadge, Modal, timeAgo, useNow } from '/js/lib/ui.js';
import { SINGER_EMOJIS, SINGER_COLORS } from '/shared/protocol.js';
import { store, act } from './state.js';
import { openTvWindow } from './player-bar.js';

export function Singers() {
  const st = useStore(store, (s) => s.state);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    if (await act('singer.add', { name })) setName('');
  };
  const singers = [...st.singers].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  return html`<div class="view">
    <h2>Singers</h2>
    <form class="row" onSubmit=${add} style=${{ maxWidth: '520px', marginBottom: '18px' }}>
      <input class="input" placeholder="Add a singer (for people without a phone)" value=${name} onInput=${(e) => setName(e.currentTarget.value)} maxLength="24" />
      <button class="btn primary" disabled=${!name.trim()}><${Icon} name="plus" size=${16} /> Add</button>
    </form>
    ${!singers.length ? html`<div class="empty"><div class="big">🎤</div>No singers yet. Guests appear here when they join with their phone.</div>` : html`<div class="people">
      ${singers.map((s) => html`<div key=${s.id} class="person card">
        <${SingerBadge} singer=${s} size=${46} />
        <div class="grow" style=${{ minWidth: 0 }}>
          <div class="ellipsis"><b>${s.name}</b> ${s.guest ? html`<span class=${`dot-online${s.online ? '' : ' off'}`} title=${s.online ? 'Phone connected' : 'Phone offline'}></span>` : html`<span class="tag">no phone</span>`}</div>
          <div class="dim">${s.sung} sung tonight · ${s.queued} in queue${s.totalSung > s.sung ? ` · ${s.totalSung} all time` : ''}</div>
        </div>
        <button class="btn icon small ghost" title="Edit" onClick=${() => setEdit(s)}><${Icon} name="edit" size=${15} /></button>
        <button class="btn icon small ghost danger" title="Remove" onClick=${() => { if (confirm(`Remove ${s.name}? Their queued songs are removed too.`)) act('singer.remove', { singerId: s.id }); }}><${Icon} name="trash" size=${15} /></button>
      </div>`)}
    </div>`}
    ${edit && html`<${EditSinger} singer=${edit} onClose=${() => setEdit(null)} />`}
  </div>`;
}

function EditSinger({ singer, onClose }) {
  const [name, setName] = useState(singer.name);
  const [emoji, setEmoji] = useState(singer.emoji);
  const [color, setColor] = useState(singer.color);
  const save = async () => {
    if (await act('singer.update', { singerId: singer.id, patch: { name, emoji, color } }) !== undefined) onClose();
  };
  return html`<${Modal} onClose=${onClose}>
    <h2 style=${{ marginTop: 0 }}>Edit singer</h2>
    <input class="input" value=${name} onInput=${(e) => setName(e.currentTarget.value)} maxLength="24" />
    <div class="field-label">Emoji</div>
    <div class="emoji-grid">${SINGER_EMOJIS.map((e) => html`<button type="button" class=${`emoji${e === emoji ? ' on' : ''}`} onClick=${() => setEmoji(e)}>${e}</button>`)}</div>
    <div class="field-label">Colour</div>
    <div class="row" style=${{ flexWrap: 'wrap' }}>${SINGER_COLORS.map((c) => html`<button type="button" class=${`swatch${c === color ? ' on' : ''}`} style=${{ background: c }} onClick=${() => setColor(c)}></button>`)}</div>
    <div class="row" style=${{ justifyContent: 'flex-end', marginTop: '20px' }}>
      <button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn primary" onClick=${save}>Save</button>
    </div>
  </${Modal}>`;
}

export function Guests() {
  const st = useStore(store, (s) => s.state);
  const now = useNow(30000);
  const guests = st.guests;
  return html`<div class="view">
    <h2>Guests</h2>
    <p class="muted" style=${{ marginTop: '-8px' }}>Phones that joined with the party QR code. Kick disconnects a phone; ban also removes their songs and blocks them for this party.</p>
    ${!guests.length ? html`<div class="empty"><div class="big">📱</div>No guests yet — show the QR code on the TV.</div>` : html`<div class="people">
      ${guests.map((g) => html`<div key=${g.deviceId} class=${`person card${g.banned ? ' banned' : ''}`}>
        <${SingerBadge} singer=${g} size=${40} />
        <div class="grow" style=${{ minWidth: 0 }}>
          <div class="ellipsis"><b>${g.name}</b> <span class=${`dot-online${g.online ? '' : ' off'}`}></span></div>
          <div class="dim">${g.banned ? 'Banned' : g.online ? 'Connected' : `Last seen ${timeAgo(g.lastSeen, now)}`}</div>
        </div>
        ${g.banned
          ? html`<button class="btn small" onClick=${() => act('guest.ban', { deviceId: g.deviceId, banned: false })}>Unban</button>`
          : html`${g.online && html`<button class="btn small ghost" onClick=${() => act('guest.kick', { deviceId: g.deviceId })}>Kick</button>`}
            <button class="btn small ghost danger" onClick=${() => { if (confirm(`Ban ${g.name} from this party?`)) act('guest.ban', { deviceId: g.deviceId }); }}>Ban</button>`}
      </div>`)}
    </div>`}
  </div>`;
}

export function Displays() {
  const st = useStore(store, (s) => s.state);
  const [code, setCode] = useState('');
  return html`<div class="view">
    <h2>Displays</h2>
    <div class="row" style=${{ flexWrap: 'wrap', marginBottom: '16px' }}>
      <button class="btn primary" onClick=${openTvWindow}><${Icon} name="tv" size=${18} /> Open TV display on the second screen</button>
    </div>
    <div class="card pad">
      <b>Connected displays</b>
      ${!st.displays.length ? html`<p class="muted">No TV display is connected. Open <code>/tv</code> on the TV (second screen of this PC, or any browser on the network).</p>` : html`<div class="people" style=${{ marginTop: '10px' }}>
        ${st.displays.map((d, i) => html`<div key=${d.clientId} class="person">
          <span class="display-icon">${d.main ? '📺' : '🪞'}</span>
          <div class="grow"><b>${d.name || `Display ${i + 1}`}</b> ${d.main ? html`<span class="tag">main · plays audio</span>` : html`<span class="tag">mirror · muted</span>`}
            <div class="dim">${d.local ? 'This computer' : 'Other device on the network'}</div></div>
          ${!d.main && html`<button class="btn small" onClick=${() => act('display.makeMain', { clientId: d.clientId })}>Make main</button>`}
        </div>`)}
      </div>`}
    </div>
    ${st.pendingDisplays.length > 0 && html`<div class="card pad" style=${{ marginTop: '14px' }}>
      <b>Displays waiting for approval</b>
      <p class="muted">A TV on another device shows a 4-digit code. Approve it if the code matches.</p>
      ${st.pendingDisplays.map((p) => html`<div class="row" key=${p.code}><span class="pair-code">${p.code}</span><button class="btn primary small" onClick=${() => act('display.approve', { code: p.code })}>Approve</button></div>`)}
    </div>`}
    <div class="card pad" style=${{ marginTop: '14px' }}>
      <b>Pair a display by code</b>
      <form class="row" style=${{ marginTop: '8px' }} onSubmit=${async (e) => { e.preventDefault(); if (await act('display.approve', { code }) !== undefined) setCode(''); }}>
        <input class="input" style=${{ maxWidth: '160px' }} inputMode="numeric" placeholder="1234" value=${code} onInput=${(e) => setCode(e.currentTarget.value)} />
        <button class="btn" disabled=${code.length < 4}>Approve</button>
      </form>
    </div>
    <div class="card pad tips" style=${{ marginTop: '14px' }}>
      <b>Tips</b>
      <ul>
        <li>Best: run <code>bin/open-tv.sh</code> on the party PC — it opens the TV full-screen on the second monitor with sound allowed (no click needed).</li>
        <li>Add <code>?display=mirror</code> to the TV address for extra screens that show lyrics without sound.</li>
        <li>Keyboard on the TV window: <kbd>Space</kbd> play/pause, <kbd>→</kbd> next, <kbd>←</kbd> restart, <kbd>+</kbd>/<kbd>−</kbd> key, <kbd>[</kbd>/<kbd>]</kbd> tempo, <kbd>F</kbd> full screen.</li>
      </ul>
    </div>
  </div>`;
}
