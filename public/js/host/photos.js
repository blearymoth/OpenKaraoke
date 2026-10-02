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
  // The list has every waiting photo but only the newest others; the counts cover them all.
  const counts = state.photoCounts || { total: photos.length, approved: shown.length, rejected: rejected.length };
  const unlisted = counts.total - photos.length;
  const g = state.settings.guests;
  const set = (patch) => act('settings.update', { patch: { guests: patch } });
  // Every waiting photo at once (a flood, or too many to look at): they stay under "Not shown".
  const rejectWaiting = () => act('photo.rejectWaiting').then((r) => r && toast(`${plural(r.count, 'photo')} moved to “Not shown”`, 'ok'));
  return html`<div class="page">
    <header class="page-head"><div><h1>Photos</h1><p class="muted">Guests send photos from their phones; approved ones pop up on the TV and fill the photo wall (TV display → Background → Guests’ photos).</p></div>
      <div class="page-actions">
        <label class="check-row"><${Switch} checked=${g.photos} label="Guests can send photos" onChange=${(v) => set({ photos: v })} /> Photos on</label>
        <label class="check-row"><${Switch} checked=${g.photoApproval} label="Approve first" onChange=${(v) => set({ photoApproval: v })} /> Approve first</label>
        ${counts.total > 0 && html`<button class="btn ghost danger" onClick=${() => confirm('Delete every photo?') && act('photo.clear').then((r) => r && toast('Photos deleted', 'ok'))}>Delete all</button>`}
      </div>
    </header>
    <h2 class="section-title">Waiting for you ${pending.length ? html`<span class="badge neon">${pending.length}</span>` : ''}
      ${pending.length > 1 && html`<span class="grow"></span><button class="btn small ghost" onClick=${rejectWaiting}>Don’t show any</button>`}</h2>
    ${pending.length ? html`<div class="photo-grid">${pending.map((p) => html`<${PhotoTile} key=${p.id} p=${p} />`)}</div>` : html`<p class="muted">No new photos.</p>`}
    <h2 class="section-title">On the TV (${counts.approved})</h2>
    ${shown.length ? html`<div class="photo-grid">${shown.map((p) => html`<${PhotoTile} key=${p.id} p=${p} />`)}</div>`
      : counts.approved ? html`<p class="muted">Only older ones, not listed here.</p>`
      : html`<${Empty} icon="📸" title="No photos yet">Guests find “Send a photo to the TV” on the Me tab of their phone.</${Empty}>`}
    ${rejected.length > 0 && html`<h2 class="section-title">Not shown (${counts.rejected})</h2><div class="photo-grid">${rejected.map((p) => html`<${PhotoTile} key=${p.id} p=${p} />`)}</div>`}
    <p class="hint">${plural(counts.total, 'photo')} kept in the data folder${unlisted > 0 ? ` (${unlisted.toLocaleString()} older ones aren’t listed here)` : ''}. Past 300, “Not shown” photos go first, then the oldest.</p>
  </div>`;
}
