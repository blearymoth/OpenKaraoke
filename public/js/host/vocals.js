// Lead and backing vocals on the host page (shared/vocals.js). On a version with the original
// singer on a channel of its own (multiplex) the player bar's speaker control becomes "Lead": off,
// quiet or full — exact, the music stays as it is. Backing vocals are part of the music on both
// channels: only another version changes them. The Vocals dialog has the level, which side the
// singer is on (corrections are kept per track) and the other versions.
import { html } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { Modal, Spinner, useFetch } from '../lib/components.js';
import { useStore, formatTime } from '../lib/store.js';
import { store, act, openDialog, closeDialog, toast, livePosition } from './state.js';
import { CHANNEL_MODES, CHANNEL_LABELS } from '/shared/protocol.js';
import { LEAD_PRESETS, LEAD_STEP, formatLead } from '/shared/vocals.js';
export { vocalsNote } from '../lib/versions.js';

const PRESETS = [[LEAD_PRESETS.off, 'Off'], [LEAD_PRESETS.quiet, 'Quiet'], [LEAD_PRESETS.full, 'Full']];
const SIDE = { L: 'left', R: 'right' };

/** "Lead off" … for the player bar and queue lists. */
export function leadText(lead) {
  return lead <= 0 ? 'off' : lead === LEAD_PRESETS.quiet ? 'quiet' : lead >= 100 ? 'full' : formatLead(lead);
}

/** The player bar's control: "Lead" on a multiplex version, else the channel mode. */
export function VocalsControl({ p, idle }) {
  const v = p.vocals;
  const open = () => openDialog({ type: 'vocals' });
  const more = html`<button class=${`icon-btn small vocals-more ${v?.ask || v?.suggest ? 'attention' : ''}`} onClick=${open} disabled=${idle}
    aria-label="Vocals" title=${v?.ask ? 'Which side is the singer on? — Vocals' : v?.suggest ? 'A guide singer was found — Vocals' : 'Vocals: lead and backing vocals, versions'}><${Icon} name="more" size=${16} /></button>`;
  if (v?.adjustable && !idle) {
    const custom = !PRESETS.some(([x]) => x === p.lead);
    return html`<div class="channel vocals-control" title="The original singer on this version (a channel of its own): off, quiet or full — the music stays as it is">
      <${Icon} name="mic" size=${18} />
      <select class="select" value=${String(p.lead)} aria-label="Lead vocal" onChange=${(e) => act('player.lead', { level: Number(e.currentTarget.value) })}>
        ${PRESETS.map(([x, label]) => html`<option value=${x}>Lead ${label.toLowerCase()}</option>`)}
        ${custom && html`<option value=${p.lead}>Lead ${formatLead(p.lead)}</option>`}
      </select>
      ${more}
    </div>`;
  }
  return html`<div class="channel" title="Speakers: which channels play (for a multiplex track that wasn’t recognised, the side without the guide singer)">
    <${Icon} name="headphones" size=${18} />
    <select class="select" value=${p.channel} disabled=${idle} onChange=${(e) => act('player.channel', { mode: e.currentTarget.value })} aria-label="Channel mode">
      ${CHANNEL_MODES.map((m) => html`<option value=${m}>${CHANNEL_LABELS[m]}</option>`)}
    </select>
    ${more}
  </div>`;
}

/** Another version of the song that is on: it starts again with it (asked once it is well under way). */
async function switchVersion(v, label) {
  if (livePosition() > 15 && !confirm(`Switch to ${label}? The song starts again from the beginning.`)) return;
  if (await act('player.version', { trackId: v.id })) {
    toast(`${label}: starting again`, 'ok');
    closeDialog();
  }
}

const brandOf = (v) => v.brandName || v.brand || 'Another label';

export function VocalsDialog() {
  const { state } = useStore(store);
  const cur = state.current;
  const p = state.player;
  const { data: song, error } = useFetch(cur ? `/api/songs/${encodeURIComponent(cur.songId)}` : null, null, { ttl: 2000 });
  if (!cur) return html`<${Modal} title="Vocals" onClose=${closeDialog}><p class="muted">Nothing is playing.</p></${Modal}>`;
  const v = p.vocals || {};
  const others = (song?.versions || []).filter((x) => x.id !== cur.trackId);
  const adjustableOther = others.find((x) => x.vocals?.lead === 'adjustable') || others.find((x) => x.vocals?.lead === 'multiplex');
  const withoutBgv = others.filter((x) => x.vocals?.bgv === 'without');
  const withBgv = v.bgv === 'without' ? others.filter((x) => x.vocals?.bgv !== 'without') : [];
  const layout = (value) => act('player.layout', { layout: value });
  let lead;
  if (v.adjustable) {
    lead = html`<p class="hint">On this version the original singer is on the <b>${SIDE[v.side]}</b> channel${v.source === 'host' ? ' (as you set)' : ''}: the level turns only the singer up or down — the music stays as it is.</p>
      <div class="vocals-level">
        <input type="range" min="0" max="100" step=${LEAD_STEP} value=${p.lead} aria-label="Lead vocal level" style=${{ '--p': `${p.lead}%` }}
          onInput=${(e) => e.currentTarget.style.setProperty('--p', `${e.currentTarget.value}%`)}
          onChange=${(e) => act('player.lead', { level: Number(e.currentTarget.value) })} />
        <b class="num">${formatLead(p.lead)}</b>
      </div>
      <div class="btn-row">${PRESETS.map(([x, label]) => html`<button class=${`btn small ${p.lead === x ? 'on' : ''}`} onClick=${() => act('player.lead', { level: x })}>${label}</button>`)}</div>`;
  } else if (v.ask) {
    lead = html`<p class="hint">This version is named “Multiplex”, but which channel has the singer isn’t clear. Listen for a moment: which side is the original singer on?</p>
      <div class="btn-row"><button class="btn small" onClick=${() => layout('mpxL')}>Singer on the left</button><button class="btn small" onClick=${() => layout('mpxR')}>Singer on the right</button><button class="btn small ghost" onClick=${() => layout('stereo')}>It’s ordinary stereo</button></div>`;
  } else if (v.suggest) {
    lead = html`<p class="hint">The original singer seems to be on the <b>${SIDE[v.suggest]}</b> channel of this version (found by its sound). Listen: if one side has the original singer and the other doesn’t, use it — then the Lead control turns only the singer up or down.</p>
      <div class="btn-row"><button class="btn small primary" onClick=${() => layout(v.suggest === 'L' ? 'mpxL' : 'mpxR')}>Yes — use it</button><button class="btn small ghost" onClick=${() => layout('stereo')}>No, it’s ordinary stereo</button></div>`;
  } else if (v.mixed) {
    lead = html`<p class="hint">The original singer is mixed into the music on this version: it can’t be turned down — only another version takes them out.</p>`;
  } else {
    lead = html`<p class="hint">No lead vocal on this version.</p>`;
  }
  return html`<${Modal} title="Vocals" onClose=${closeDialog}>
    <div class="song-head"><div><div class="song-head-title">${cur.title}</div><div class="muted">${cur.artist}${cur.brand ? ` · ${cur.brand}` : ''}</div></div></div>
    <h4 class="section-title">Lead vocal (the original singer)</h4>
    ${lead}
    ${!v.adjustable && adjustableOther && html`<div class="btn-row"><button class="btn small" onClick=${() => switchVersion(adjustableOther, brandOf(adjustableOther))}>Switch to ${brandOf(adjustableOther)} — ${adjustableOther.vocals.lead === 'adjustable' ? 'lead vocal adjustable' : 'multiplex (guide singer on its own channel)'}</button></div>`}
    ${(v.adjustable || v.source === 'host') && html`<details class="vocals-layout"><summary>Wrong side, or not a multiplex track?</summary>
      <div class="btn-row"><button class="btn small" onClick=${() => layout('mpxL')}>Singer on the left</button><button class="btn small" onClick=${() => layout('mpxR')}>Singer on the right</button><button class="btn small" onClick=${() => layout('stereo')}>Ordinary stereo</button><button class="btn small ghost" onClick=${() => layout('auto')}>Automatic</button></div>
      <p class="hint">Kept for this version of the song.</p></details>`}
    <h4 class="section-title">Backing vocals</h4>
    <p class="hint">${v.bgv === 'without' ? 'This version has no backing vocals.' : v.bgv === 'with' ? 'This version has backing vocals.' : 'Backing vocals are part of the music on this version — only another version can change them.'}</p>
    ${!song && !error && html`<${Spinner} />`}
    ${[...withoutBgv, ...withBgv].length > 0 && html`<div class="btn-row">${[...withoutBgv, ...withBgv].map((x) => html`<button class="btn small" onClick=${() => switchVersion(x, brandOf(x))}>
      Switch to ${brandOf(x)} — ${x.vocals?.bgv === 'without' ? 'without' : 'with'} backing vocals (${formatTime(x.dur)})</button>`)}</div>`}
    ${others.length > 0 && !withoutBgv.length && !withBgv.length && v.bgv !== 'without' && html`<p class="hint">No version of this song is marked “without backing vocals”.</p>`}
  </${Modal}>`;
}
