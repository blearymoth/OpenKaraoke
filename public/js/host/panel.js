// The admin panel: Queue (up next, requests, tonight), Playback (what is on, sound, video) and
// Devices (TV screens, host devices, guests' phones). The right-hand column on a computer; on
// phones a "Control" page of its own (#/panel/<tab>).
import { html } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore } from '../lib/store.js';
import { store, PANEL_TABS, setPanelTab, openPanel } from './state.js';
import { QueueTab } from './queue.js';
import { PlaybackTab } from './playback.js';
import { DevicesTab } from './devices.js';

const TABS = { queue: ['list', 'Queue'], playback: ['play', 'Playback'], devices: ['tv', 'Devices'] };

function TabExtra({ tab, state }) {
  const p = state.player;
  if (tab === 'queue') {
    const n = state.pending.length;
    return n ? html`<span class="badge neon" aria-label=${`${n} requests waiting`}>${n}</span>` : html`<span class="badge">${state.queue.length}</span>`;
  }
  if (tab === 'playback') {
    return html`${p.state === 'playing' && html`<span class="live-dot" role="img" aria-label="Playing"></span>`}
      ${!!(p.error || (!p.hasDisplay && (state.current || state.queue.length > 0))) && html`<span class="tab-dot" role="img" aria-label="Needs attention"></span>`}`;
  }
  const n = state.pairings?.length || 0;
  if (n) return html`<span class="badge bulb" aria-label=${`${n} screens waiting to pair`}>${n}</span>`;
  return html`<span class="badge">${state.guests.filter((g) => g.online).length + state.displays.length}</span>`;
}

/** `page`: the phones' Control page (the tab comes from the address). */
export function AdminPanel({ page = false, tab }) {
  const { state, panelTab } = useStore(store);
  if (!state) return null;
  const active = page ? tab : panelTab;
  const choose = (t) => (page ? openPanel(t) : setPanelTab(t));
  const onKey = (e) => {
    const i = PANEL_TABS.indexOf(active);
    const to = { ArrowRight: (i + 1) % PANEL_TABS.length, ArrowLeft: (i - 1 + PANEL_TABS.length) % PANEL_TABS.length, Home: 0, End: PANEL_TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    choose(PANEL_TABS[to]);
    requestAnimationFrame(() => document.getElementById(`ptab-${PANEL_TABS[to]}`)?.focus());
  };
  const body = html`<div class="tabs" role="tablist" aria-label="Admin panel" onKeyDown=${onKey}>
      ${PANEL_TABS.map((t) => html`<button role="tab" id=${`ptab-${t}`} aria-controls=${`ppanel-${t}`} aria-selected=${active === t} tabindex=${active === t ? 0 : -1}
        class=${active === t ? 'on' : ''} onClick=${() => choose(t)}>
        <${Icon} name=${TABS[t][0]} size=${18} /> <span>${TABS[t][1]}</span> <${TabExtra} tab=${t} state=${state} />
      </button>`)}
    </div>
    <div class="panel-body" role="tabpanel" id=${`ppanel-${active}`} aria-labelledby=${`ptab-${active}`}>
      ${active === 'queue' && html`<${QueueTab} state=${state} />`}
      ${active === 'playback' && html`<${PlaybackTab} state=${state} full=${page} />`}
      ${active === 'devices' && html`<${DevicesTab} state=${state} />`}
    </div>`;
  return page
    ? html`<section class="admin-panel" aria-label="Admin panel">${body}</section>`
    : html`<aside class="admin-panel" aria-label="Admin panel">${body}</aside>`;
}
