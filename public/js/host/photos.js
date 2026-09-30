// Host → Photos: approve guests' photos before they appear on the TV, remove them later.
import { html } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, plural } from '../lib/store.js';
import { Empty, Switch } from '../lib/components.js';
import { store, act, toast } from './state.js';

function PhotoTile({ p }) {
  return html`<figure class=${`photo-tile ${p.status}`}>
    <img src=${`/api/photos/${encodeURIComponent(p.id)}`} alt=${`Photo from ${p.name}`} loading="lazy" />
    <figcaption><b class="ellipsis">${p.name}</b><span class="faint">${new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></figcaption>
    <div class="photo-actions">
      ${p.status !== 'approved' && html`<button class="btn small primary" onClick=${() => act('photo.approve', { id: p.id })}><${Icon} name="check" size=${14} /> Show on TV</button>`}
      ${p.status === 'pending' && html`<button class="btn small ghost" onClick=${() => act('photo.reject', { id: p.id })}>Don’t show</button>`}
      <button class="icon-btn small" aria-label="Delete photo" title="Delete" onClick=${() => act('photo.remove', { id: p.id })}><${Icon} name="trash" size=${16} /></button>
    </div>
  </figure>`;
}

export function Photos() {
  const { state } = useStore(store);
  const photos = state.photos || [];
  const pending = photos.filter((p) => p.status === 'pending');
  const shown = photos.filter((p) => p.status === 'approved');
  const rejected = photos.filter((p) => p.status === 'rejected');
  const g = state.settings.guests;
  const set = (patch) => act('settings.update', { patch: { guests: patch } });
  return html`<div class="page">
    <header class="page-head"><div><h1>Photos</h1><p class="muted">Guests send photos from their phones; approved ones pop up on the TV and fill the photo wall (TV display → Background → Guests’ photos).</p></div>
      <div class="page-actions">
        <label class="check-row"><${Switch} checked=${g.photos} label="Guests can send photos" onChange=${(v) => set({ photos: v })} /> Photos on</label>
        <label class="check-row"><${Switch} checked=${g.photoApproval} label="Approve first" onChange=${(v) => set({ photoApproval: v })} /> Approve first</label>
        ${photos.length > 0 && html`<button class="btn ghost danger" onClick=${() => confirm('Delete every photo?') && act('photo.clear').then((r) => r && toast('Photos deleted', 'ok'))}>Delete all</button>`}
      </div>
    </header>
    <h2 class="section-title">Waiting for you ${pending.length ? html`<span class="badge neon">${pending.length}</span>` : ''}</h2>
    ${pending.length ? html`<div class="photo-grid">${pending.map((p) => html`<${PhotoTile} key=${p.id} p=${p} />`)}</div>` : html`<p class="muted">No new photos.</p>`}
    <h2 class="section-title">On the TV (${shown.length})</h2>
    ${shown.length ? html`<div class="photo-grid">${shown.map((p) => html`<${PhotoTile} key=${p.id} p=${p} />`)}</div>` : html`<${Empty} icon="📸" title="No photos yet">Guests find “Send a photo to the TV” on the Me tab of their phone.</${Empty}>`}
    ${rejected.length > 0 && html`<h2 class="section-title">Not shown (${rejected.length})</h2><div class="photo-grid">${rejected.map((p) => html`<${PhotoTile} key=${p.id} p=${p} />`)}</div>`}
    <p class="hint">${plural(photos.length, 'photo')} kept in the data folder (at most 300).</p>
  </div>`;
}
