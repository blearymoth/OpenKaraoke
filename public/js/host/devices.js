// Admin panel → Devices: the TV screens (which one plays the sound, "Identify", pairing), the
// host's own devices and the guests' phones (co-host, disconnect, remove).
import { html, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { plural } from '../lib/store.js';
import { Avatar } from '../lib/components.js';
import { store, act, toast } from './state.js';
import { Menu } from './menu.js';
import { openTvWindow, canOpenTv, openInvite } from './player.js';
import { useStore } from '../lib/store.js';

const hhmm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', 'ok', 1500);
  } catch {
    toast(text, 'info', 8000); // no clipboard (plain http on a phone): show it to type in
  }
}

/** One set of guest actions for the Devices tab and the Singers page (same texts, same toasts). */
export const guestCmds = {
  cohost: (g) => act('guest.cohost', { deviceId: g.deviceId, on: !g.coHost }).then((r) => r && toast(r.coHost ? `${g.name} is now a co-host` : `${g.name} is no longer a co-host`, 'ok')),
  disconnect: (g) => act('guest.kick', { deviceId: g.deviceId }).then((r) => r && toast(`${g.name}’s phone was disconnected`, 'ok')),
  remove: (g) => confirm(`Remove ${g.name} from the party? Their queued songs and version votes are removed too.`) && act('guest.ban', { deviceId: g.deviceId }),
  letBackIn: (g) => act('guest.unban', { deviceId: g.deviceId }),
};

/** The Singers page's buttons for a guest's phone. */
export function GuestButtons({ g }) {
  return html`${!g.banned && html`<button class=${`btn small ${g.coHost ? 'on' : 'ghost'}`} title="A co-host can run the player and approve requests from their phone"
      onClick=${() => guestCmds.cohost(g)}>${g.coHost ? '★ Co-host' : 'Make co-host'}</button>`}
    ${g.banned
      ? html`<button class="btn small ghost" onClick=${() => guestCmds.letBackIn(g)}>Let back in</button>`
      : html`<button class="btn small ghost danger" onClick=${() => guestCmds.remove(g)}>Remove</button>`}`;
}

/** A connected screen: what it is, where, and the buttons to make it play the sound or find it. */
export function DisplayRow({ d }) {
  const main = d.display === 'main';
  const identify = async () => {
    const r = await act('display.identify', { id: d.id });
    if (r) toast(`“${r.name}” shows its name on its screen now`, 'ok');
  };
  return html`<div class="folder-row display-row dev-row">
    <${Icon} name=${main ? 'volume' : 'mute'} size=${20} />
    <div class="grow">
      <div><b>${d.name}</b> <span class=${`pill ${main ? 'ok' : ''}`}>${main ? 'Plays the sound' : 'Muted'}</span></div>
      <div class="hint">${d.local ? 'This computer' : d.ip} · ${d.device}${d.paired ? ' · paired' : ''}${d.since ? ` · since ${hhmm(d.since)}` : ''}</div>
      ${d.audioBlocked && html`<div class="bulb-text">Sound blocked — click the TV once</div>`}
      ${d.standIn && html`<div class="bulb-text">Standing in for the TV that disconnected</div>`}
    </div>
    <div class="dev-actions">
      ${d.kind !== 'board' && (!main || d.standIn) && html`<button class="btn small" onClick=${() => act('display.main', { id: d.id }).then((r) => r && toast('Main display changed', 'ok'))}>${d.standIn ? 'Keep as main' : 'Make main'}</button>`}
      <button class="btn small ghost" onClick=${identify}>Identify</button>
    </div>
  </div>`;
}

/** A screen asking to be paired, with its code. */
export function PairingRow({ p }) {
  return html`<div class="folder-row pairing-row dev-row">
    <div class="pair-code-small">${p.code}</div>
    <div class="grow"><b>Screen at ${p.ip}</b><div class="hint">Asked ${hhmm(p.at)}</div></div>
    <div class="dev-actions">
      <button class="btn small primary" onClick=${() => act('display.approve', { id: p.id }).then((r) => r && toast('Screen paired', 'ok'))}>Approve</button>
      <button class="btn small ghost danger" onClick=${() => act('display.deny', { id: p.id })}>Deny</button>
    </div>
  </div>`;
}

function GuestRow({ g, menu, setMenu }) {
  const open = menu === g.deviceId;
  return html`<div class=${`dev-row guest ${g.online ? '' : 'off'}`}>
    <${Avatar} singer=${g} size=${30} />
    <div class="grow">
      <div><b>${g.name}</b> ${g.coHost && html`<span class="pill bulb">★ Co-host</span>`} ${g.queued > 0 && html`<span class="pill">${g.queued} waiting</span>`} ${g.banned && html`<span class="pill bad">Removed</span>`}</div>
      <div class="hint">${g.online ? g.device || 'Phone' : `last seen ${hhmm(g.lastSeen)}`}</div>
    </div>
    <button class="icon-btn small" aria-label=${`Options for ${g.name}`} aria-haspopup="menu" aria-expanded=${open} onClick=${() => setMenu(open ? null : g.deviceId)}><${Icon} name="more" size=${18} /></button>
    ${open && html`<${Menu} onClose=${() => setMenu(null)} items=${[
      !g.banned && { icon: 'star', label: g.coHost ? 'Remove co-host' : 'Make co-host', run: () => guestCmds.cohost(g) },
      g.online && !g.banned && { icon: 'x', label: 'Disconnect', run: () => guestCmds.disconnect(g) },
      !g.banned && { icon: 'trash', label: 'Remove from the party', danger: true, run: () => guestCmds.remove(g) },
      g.banned && { icon: 'check', label: 'Let back in', run: () => guestCmds.letBackIn(g) },
    ]} />`}
  </div>`;
}

const GuestsGroup = ({ state }) => {
  const [menu, setMenu] = useState(null);
  const [all, setAll] = useState(false);
  const [offline, setOffline] = useState(false);
  const online = state.guests.filter((g) => g.online).sort((a, b) => a.name.localeCompare(b.name));
  const away = state.guests.filter((g) => !g.online);
  const shown = all ? online : online.slice(0, 120);
  return html`<section class="dev-group" aria-label="Guests">
    <h3 class="dev-group-title">Guests <span class="badge">${online.length}</span></h3>
    ${online.length
      ? html`${shown.map((g) => html`<${GuestRow} key=${g.deviceId} g=${g} menu=${menu} setMenu=${setMenu} />`)}
        ${online.length > shown.length && html`<button class="btn small ghost" onClick=${() => setAll(true)}>Show all ${online.length}</button>`}`
      : html`<p class="muted">No guests yet — they join by scanning the QR code on the TV. <button class="link" onClick=${openInvite}>Show the invite code</button></p>`}
    ${away.length > 0 && html`<button class="link" onClick=${() => setOffline(!offline)}>${offline ? 'Hide offline guests' : `Show ${plural(away.length, 'offline guest')}`}</button>`}
    ${offline && html`${away.slice(0, 50).map((g) => html`<${GuestRow} key=${g.deviceId} g=${g} menu=${menu} setMenu=${setMenu} />`)}
      <a class="link" href="#/singers">Everyone on the Singers page →</a>`}
  </section>`;
};

export function DevicesTab({ state }) {
  const { clientId } = useStore(store);
  const lan = state.info.lanUrls?.[0] || state.info.baseUrl;
  const onlineGuests = state.guests.filter((g) => g.online).length;
  const hostClients = state.hostClients || [];
  const tvFoot = html`<div class="btn-row">
      ${canOpenTv() && html`<button class="btn small" onClick=${openTvWindow}><${Icon} name="tv" size=${16} /> Open TV window</button>`}
      <button class="btn small ghost" onClick=${() => copyText(`${lan}/tv`)}>Copy link</button>
    </div>
    <p class="hint">Another screen? Open <code>${lan}/tv</code> on it — its code shows up here. <a href="#/settings/displays">Forget paired screens…</a></p>`;
  return html`<div class="devices">
    <div class="dev-summary">
      <span class="pill">${plural(state.displays.length, 'TV screen')}</span>
      <span class="pill">${plural(hostClients.length, 'host device')}</span>
      <span class="pill">${plural(onlineGuests, 'guest phone')}${state.guestsJoining > 0 ? ` · ${plural(state.guestsJoining, 'phone')} joining` : ''}</span>
    </div>
    ${state.pairings.length > 0 && html`<section class="dev-group pairing" aria-label="Waiting to pair">
      <h3 class="dev-group-title"><${Icon} name="tv" size=${16} /> Waiting to pair</h3>
      ${state.pairings.map((p) => html`<${PairingRow} key=${p.id} p=${p} />`)}
      ${state.pairings.length > 1 && html`<div class="btn-row"><button class="btn small ghost danger" onClick=${() => act('display.deny', { all: true })}>Deny all</button></div>`}
    </section>`}
    <section class="dev-group" aria-label="TV screens">
      <h3 class="dev-group-title">TV screens <span class="badge">${state.displays.length}</span></h3>
      ${state.displays.length ? state.displays.map((d) => html`<${DisplayRow} key=${d.id} d=${d} />`) : html`<p class="muted">No TV display is connected.</p>`}
      ${tvFoot}
    </section>
    <section class="dev-group" aria-label="Host devices">
      <h3 class="dev-group-title">Host devices <span class="badge">${hostClients.length}</span></h3>
      ${hostClients.map((h) => html`<div class="dev-row" key=${h.id}>
        <${Icon} name="user" size=${20} />
        <div class="grow">
          <div><b>${h.local ? 'This computer' : `Phone or tablet at ${h.ip}`}</b> ${h.id === clientId && html`<span class="pill neon">This device</span>`}</div>
          <div class="hint">${h.device}${h.since ? ` · since ${hhmm(h.since)}` : ''}</div>
        </div>
      </div>`)}
      <p class="hint">${state.hasPin
        ? 'To sign every phone and tablet out, change the host PIN in Settings → Party.'
        : html`<a href="#/settings/party">Set a host PIN in Settings → Party</a> to run the party from a phone or tablet.`}</p>
    </section>
    <${GuestsGroup} state=${state} />
  </div>`;
}
