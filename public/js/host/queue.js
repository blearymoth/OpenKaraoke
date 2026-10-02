// Right-hand panel: now singing, the queue (drag to reorder), requests and tonight's history.
import { html, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, formatEta, formatTime, singersText } from '../lib/store.js';
import { Avatar, Cover, Empty } from '../lib/components.js';
import { store, act, openDialog } from './state.js';
import { Menu } from './menu.js';
import { formatKey, formatTempo } from '/shared/protocol.js';

function EntryBadges({ e }) {
  return html`${e.key ? html`<span class="pill">Key ${formatKey(e.key)}</span>` : null}${e.tempo && e.tempo !== 1 ? html`<span class="pill">${formatTempo(e.tempo)}</span>` : null}${e.mystery ? html`<span class="pill bulb">Mystery</span>` : null}`;
}

function QueueItem({ e, index, count, menuOpen, setMenu, drag }) {
  const singer = e.singers[0];
  return html`<li class=${`q-item ${drag.over === index ? 'drop' : ''} ${drag.from === index ? 'dragging' : ''}`}
      draggable="true"
      onDragStart=${(ev) => { drag.start(index); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.id); }}
      onDragOver=${(ev) => { ev.preventDefault(); drag.hover(index); }}
      onDrop=${(ev) => { ev.preventDefault(); drag.drop(index); }}
      onDragEnd=${() => drag.end()}>
    <span class="grip" aria-hidden="true"><${Icon} name="grip" size=${16} /></span>
    <span class="q-pos num">${index + 1}</span>
    <${Avatar} singer=${singer} size=${34} />
    <div class="q-text">
      <div class="q-singer ellipsis">${singersText(e.singers) || html`<span class="faint">No singer</span>`}${e.invites?.length ? html` <span class="faint">(invited ${e.invites.map((x) => x.name).join(', ')})</span>` : ''}</div>
      <div class="q-song ellipsis" title=${`${e.title} by ${e.artist}`}>${e.title} <span class="faint">· ${e.artist}</span></div>
      <div class="q-meta"><span class="faint">${formatEta(e.eta)}</span><${EntryBadges} e=${e} />${e.addedByName && e.addedByName !== 'Host' ? html`<span class="faint">via ${e.addedByName}</span>` : null}</div>
    </div>
    <button class="icon-btn small" aria-label="Song options" onClick=${() => setMenu(menuOpen ? null : e.id)}><${Icon} name="more" size=${18} /></button>
    ${menuOpen && html`<${Menu} onClose=${() => setMenu(null)} items=${[
      { icon: 'play', label: 'Play now', run: () => act('player.play', { entryId: e.id }) },
      index > 0 && { icon: 'arrowUp', label: 'Move to the top', run: () => act('queue.move', { entryId: e.id, index: 0 }) },
      index > 0 && { icon: 'chevronUp', label: 'Move up', run: () => act('queue.move', { entryId: e.id, index: index - 1 }) },
      index < count - 1 && { icon: 'chevronDown', label: 'Move down', run: () => act('queue.move', { entryId: e.id, index: index + 1 }) },
      { icon: 'edit', label: 'Edit singer, key or version', run: () => openDialog({ type: 'edit', entryId: e.id }) },
      { icon: 'trash', label: 'Remove', danger: true, run: () => act('queue.remove', { entryId: e.id }) },
    ]} />`}
  </li>`;
}

function useDrag(queue) {
  const [from, setFrom] = useState(null);
  const [over, setOver] = useState(null);
  return {
    from,
    over,
    start: (i) => setFrom(i),
    hover: (i) => { if (i !== over) setOver(i); },
    drop: (i) => {
      const e = queue[from];
      setFrom(null);
      setOver(null);
      if (e && i !== from) act('queue.move', { entryId: e.id, index: i });
    },
    end: () => { setFrom(null); setOver(null); },
  };
}

function NowCard({ cur, p }) {
  const label = { intro: 'Getting ready', ready: 'Ready to start', playing: 'Singing now', paused: 'Paused' }[p.state] || '';
  return html`<div class="now-card">
    <${Cover} songId=${cur.songId} size=${64} />
    <div class="now-card-text">
      <div class="now-card-label">${label}</div>
      <div class="now-card-singer ellipsis">${cur.singers.length ? html`${cur.singers[0].emoji} ${singersText(cur.singers)}` : 'Sing along'}</div>
      <div class="ellipsis muted">${cur.title} · ${cur.artist}</div>
    </div>
  </div>`;
}

function QueueTab({ state }) {
  const [menu, setMenu] = useState(null);
  const drag = useDrag(state.queue);
  const q = state.queue;
  const total = q.reduce((s, e) => s + (e.dur || 0) / (e.tempo || 1), 0);
  return html`
    ${state.current && html`<${NowCard} cur=${state.current} p=${state.player} />`}
    ${q.length
      ? html`<div class="q-summary faint">${q.length} song${q.length === 1 ? '' : 's'}, about ${Math.round(total / 60)} min</div>
        <ol class="q-list">${q.map((e, i) => html`<${QueueItem} key=${e.id} e=${e} index=${i} count=${q.length} menuOpen=${menu === e.id} setMenu=${setMenu} drag=${drag} />`)}</ol>
        <div class="q-foot">
          <button class="btn small ghost" onClick=${() => act('queue.shuffle')}><${Icon} name="shuffle" size=${16} /> Shuffle</button>
          <button class="btn small ghost danger" onClick=${() => { if (confirm(`Remove all ${q.length} songs from the queue?`)) act('queue.clear'); }}><${Icon} name="trash" size=${16} /> Clear</button>
        </div>`
      : html`<${Empty} icon="🎶" title="The queue is empty">Search for a song and press <b>Queue</b>, or let guests scan the QR code on the TV.</${Empty}>`}
  `;
}

function RequestsTab({ state }) {
  const pending = state.pending;
  if (!pending.length) {
    return html`<${Empty} icon="📥" title="No requests waiting">${state.settings.queue.requireApproval ? 'Guest requests will appear here for you to approve.' : 'Turn on “Approve guest requests” in Settings to review songs before they join the queue.'}</${Empty}>`;
  }
  return html`<div class="q-foot top"><button class="btn small primary" onClick=${async () => { for (const e of pending) await act('queue.approve', { entryId: e.id }); }}><${Icon} name="check" size=${16} /> Approve all</button></div>
    <ol class="q-list">${pending.map((e) => html`<li class="q-item" key=${e.id}>
      <${Avatar} singer=${e.singers[0]} size=${34} />
      <div class="q-text">
        <div class="q-singer ellipsis">${singersText(e.singers) || e.addedByName}</div>
        <div class="q-song ellipsis">${e.title} <span class="faint">· ${e.artist}</span></div>
        <div class="q-meta"><span class="faint">${formatTime(e.dur)}</span><${EntryBadges} e=${e} /></div>
      </div>
      <button class="icon-btn small ok" aria-label="Approve" title="Approve" onClick=${() => act('queue.approve', { entryId: e.id })}><${Icon} name="check" size=${18} /></button>
      <button class="icon-btn small" aria-label="Reject" title="Reject" onClick=${() => act('queue.reject', { entryId: e.id })}><${Icon} name="x" size=${18} /></button>
    </li>`)}</ol>`;
}

function HistoryTab({ state }) {
  const items = state.tonight.history;
  if (!items.length) return html`<${Empty} icon="🕘" title="Nothing sung yet tonight">Finished songs show up here so you can queue them again.</${Empty}>`;
  return html`<ol class="q-list">${items.map((h) => html`<li class="q-item" key=${h.at}>
    <span class="q-time faint num">${new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    <div class="q-text">
      <div class="q-singer ellipsis">${h.singers.join(' & ') || 'No singer'}</div>
      <div class="q-song ellipsis">${h.title} <span class="faint">· ${h.artist}</span></div>
      ${h.skipped && html`<div class="q-meta"><span class="pill">Skipped</span></div>`}
    </div>
    <button class="icon-btn small" aria-label="Queue again" title="Queue again" onClick=${() => openDialog({ type: 'add', songId: h.songId, singerName: h.singers[0] || '' })}><${Icon} name="plus" size=${18} /></button>
  </li>`)}</ol>`;
}

export function QueuePanel() {
  const { state } = useStore(store);
  const [tab, setTab] = useState('queue');
  if (!state) return null;
  const pendingCount = state.pending.length;
  return html`<aside class="queue-panel" aria-label="Queue">
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected=${tab === 'queue'} class=${tab === 'queue' ? 'on' : ''} onClick=${() => setTab('queue')}>Queue <span class="badge">${state.queue.length}</span></button>
      <button role="tab" aria-selected=${tab === 'requests'} class=${tab === 'requests' ? 'on' : ''} onClick=${() => setTab('requests')}>Requests ${pendingCount ? html`<span class="badge neon">${pendingCount}</span>` : null}</button>
      <button role="tab" aria-selected=${tab === 'history'} class=${tab === 'history' ? 'on' : ''} onClick=${() => setTab('history')}>History</button>
    </div>
    <div class="panel-body">
      ${tab === 'queue' && html`<${QueueTab} state=${state} />`}
      ${tab === 'requests' && html`<${RequestsTab} state=${state} />`}
      ${tab === 'history' && html`<${HistoryTab} state=${state} />`}
    </div>
  </aside>`;
}
