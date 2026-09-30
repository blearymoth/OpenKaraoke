// Right-hand panel: queue (drag to reorder), requests awaiting approval, tonight's history.
import { html, useState } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { Icon, Cover, SingerBadge, Modal, formatDuration, formatEta, timeAgo, names, useNow } from '/js/lib/ui.js';
import { formatKey, formatTempo, KEY_MIN, KEY_MAX, clampTempo } from '/shared/protocol.js';
import { store, ui, act, openDetails } from './state.js';

export function QueuePanel() {
  const st = useStore(store, (s) => s.state);
  const tab = useStore(ui, (s) => s.queueTab);
  if (!st) return null;
  const setTab = (t) => ui.set({ queueTab: t });
  return html`<aside class="queue-panel">
    <div class="tabs">
      <button class=${tab === 'queue' ? 'on' : ''} onClick=${() => setTab('queue')}>Queue <span class="count">${st.queue.length}</span></button>
      <button class=${tab === 'requests' ? 'on' : ''} onClick=${() => setTab('requests')}>Requests ${st.pending.length ? html`<span class="badge">${st.pending.length}</span>` : null}</button>
      <button class=${tab === 'tonight' ? 'on' : ''} onClick=${() => setTab('tonight')}>Tonight</button>
    </div>
    ${tab === 'queue' && html`<${QueueList} st=${st} />`}
    ${tab === 'requests' && html`<${Requests} st=${st} />`}
    ${tab === 'tonight' && html`<${Tonight} st=${st} />`}
  </aside>`;
}

function QueueList({ st }) {
  const [drag, setDrag] = useState(null); // { id, over }
  const [edit, setEdit] = useState(null);
  const q = st.queue;
  const total = q.reduce((a, e) => a + (e.dur || 0) / (e.tempo || 1), 0);
  const onDrop = (index) => {
    if (drag && drag.id) act('queue.move', { entryId: drag.id, index });
    setDrag(null);
  };
  return html`<div class="queue-body">
    ${st.current && html`<div class="now-card">
      <div class="label">${st.player.state === 'intro' ? 'Starting' : st.player.state === 'paused' ? 'Paused' : 'On stage'}</div>
      <div class="row">
        <${Cover} song=${{ id: st.current.songId }} size=${48} />
        <div class="grow">
          <div class="t ellipsis">${st.current.title}</div>
          <div class="a ellipsis">${st.current.artist}</div>
          <div class="who">${st.current.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${20} />`)} ${names(st.current.singers)}</div>
        </div>
      </div>
    </div>`}
    ${!q.length && html`<div class="empty"><div class="big">🎶</div>The queue is empty.<br /><span class="dim">Search for a song, or invite guests with the QR code.</span></div>`}
    <ol class="queue" onDragOver=${(e) => e.preventDefault()}>
      ${q.map((e, i) => html`<li key=${e.id}
          class=${`q-item${drag?.id === e.id ? ' dragging' : ''}${drag?.over === i ? ' over' : ''}`}
          draggable="true"
          onDragStart=${(ev) => { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.id); setDrag({ id: e.id, over: i }); }}
          onDragOver=${(ev) => { ev.preventDefault(); if (drag && drag.over !== i) setDrag({ ...drag, over: i }); }}
          onDrop=${(ev) => { ev.preventDefault(); onDrop(i); }}
          onDragEnd=${() => setDrag(null)}>
        <span class="grip" title="Drag to reorder"><${Icon} name="drag" size=${16} /></span>
        <span class="pos">${i + 1}</span>
        <div class="grow" onClick=${() => openDetails(e.songId)} style=${{ cursor: 'pointer', minWidth: 0 }}>
          <div class="t ellipsis">${e.title}</div>
          <div class="who ellipsis">${e.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${18} />`)} <b>${names(e.singers)}</b> <span class="dim">· ${e.artist}</span></div>
          <div class="meta">
            <span>${formatEta(e.eta)}</span>
            ${e.key ? html`<span class="tag">Key ${formatKey(e.key)}</span>` : null}
            ${e.tempo !== 1 ? html`<span class="tag">${formatTempo(e.tempo)}</span>` : null}
            ${e.source === 'guest' ? html`<span class="tag" title=${`Requested by ${e.addedByName}`}>📱</span>` : null}
          </div>
        </div>
        <div class="q-actions">
          <button class="btn icon small ghost" title="Play now" onClick=${() => act('player.play', { entryId: e.id })}><${Icon} name="play" size=${14} /></button>
          ${i > 0 && html`<button class="btn icon small ghost" title="Play next" onClick=${() => act('queue.move', { entryId: e.id, index: 0 })}><${Icon} name="top" size=${16} /></button>`}
          <button class="btn icon small ghost" title="Edit" onClick=${() => setEdit(e)}><${Icon} name="edit" size=${15} /></button>
          <button class="btn icon small ghost danger" title="Remove" onClick=${() => act('queue.remove', { entryId: e.id })}><${Icon} name="x" size=${16} /></button>
        </div>
      </li>`)}
    </ol>
    ${q.length > 0 && html`<div class="queue-foot">
      <span class="dim">${q.length} song${q.length > 1 ? 's' : ''} · ${formatDuration(total)}</span>
      <span class="grow"></span>
      <button class="btn small ghost" title="Shuffle (keeps rotation fair)" onClick=${() => act('queue.shuffle')}><${Icon} name="shuffle" size=${15} /></button>
      <button class="btn small ghost danger" onClick=${() => { if (confirm('Clear the whole queue?')) act('queue.clear'); }}>Clear</button>
    </div>`}
    ${edit && html`<${EditEntry} entry=${edit} singers=${st.singers} onClose=${() => setEdit(null)} />`}
  </div>`;
}

function EditEntry({ entry, singers, onClose }) {
  const [key, setKey] = useState(entry.key || 0);
  const [tempo, setTempo] = useState(entry.tempo || 1);
  const [singerIds, setSingerIds] = useState(entry.singerIds || []);
  const toggle = (id) => setSingerIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const save = async () => {
    if (await act('queue.update', { entryId: entry.id, patch: { key, tempo, singerIds } }) !== undefined) onClose();
  };
  return html`<${Modal} onClose=${onClose}>
    <h2 style=${{ marginTop: 0 }}>${entry.title}</h2>
    <div class="muted" style=${{ marginTop: '-8px', marginBottom: '14px' }}>${entry.artist}</div>
    <div class="field-label">Singers (first one leads the rotation)</div>
    <div class="singer-pick">
      ${singers.map((s) => html`<button key=${s.id} type="button" class=${`chip${singerIds.includes(s.id) ? ' on' : ''}`} onClick=${() => toggle(s.id)}>${s.emoji} ${s.name}${singerIds[0] === s.id ? ' ★' : ''}</button>`)}
    </div>
    <div class="add-grid" style=${{ gridTemplateColumns: '1fr 1fr' }}>
      <div><div class="field-label">Key</div><div class="stepper">
        <button class="btn icon small" onClick=${() => setKey((k) => Math.max(KEY_MIN, k - 1))}><${Icon} name="minus" size=${16} /></button><b>${formatKey(key)}</b>
        <button class="btn icon small" onClick=${() => setKey((k) => Math.min(KEY_MAX, k + 1))}><${Icon} name="plus" size=${16} /></button></div></div>
      <div><div class="field-label">Tempo</div><div class="stepper">
        <button class="btn icon small" onClick=${() => setTempo((t) => clampTempo(t - 0.05))}><${Icon} name="minus" size=${16} /></button><b>${formatTempo(tempo)}</b>
        <button class="btn icon small" onClick=${() => setTempo((t) => clampTempo(t + 0.05))}><${Icon} name="plus" size=${16} /></button></div></div>
    </div>
    <div class="row" style=${{ justifyContent: 'flex-end', marginTop: '20px' }}>
      <button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn primary" onClick=${save}>Save</button>
    </div>
  </${Modal}>`;
}

function Requests({ st }) {
  if (!st.pending.length) {
    return html`<div class="empty"><div class="big">📬</div>No requests waiting.<br /><span class="dim">${st.settings.queue.requireApproval ? 'Guest requests appear here for approval.' : 'Turn on "Approve guest requests" in Settings → Queue & guests to review requests first.'}</span></div>`;
  }
  return html`<ol class="queue">
    ${st.pending.map((e) => html`<li key=${e.id} class="q-item">
      <${Cover} song=${{ id: e.songId }} size=${40} />
      <div class="grow" style=${{ minWidth: 0 }}>
        <div class="t ellipsis">${e.title}</div>
        <div class="who ellipsis">${e.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${18} />`)} <b>${names(e.singers)}</b> <span class="dim">· ${e.artist}</span></div>
      </div>
      <button class="btn icon small primary" title="Approve" onClick=${() => act('queue.approve', { entryId: e.id })}><${Icon} name="check" size=${16} /></button>
      <button class="btn icon small ghost danger" title="Reject" onClick=${() => act('queue.reject', { entryId: e.id })}><${Icon} name="x" size=${16} /></button>
    </li>`)}
  </ol>`;
}

function Tonight({ st }) {
  const now = useNow(30000);
  if (!st.tonight.length) return html`<div class="empty"><div class="big">🕘</div>Songs sung tonight will appear here.</div>`;
  return html`<ol class="queue">
    ${st.tonight.map((h) => html`<li key=${h.entryId} class="q-item" onClick=${() => openDetails(h.songId)} style=${{ cursor: 'pointer' }}>
      <${Cover} song=${{ id: h.songId }} size=${40} />
      <div class="grow" style=${{ minWidth: 0 }}>
        <div class="t ellipsis">${h.title}</div>
        <div class="who ellipsis">${h.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${18} />`)} ${names(h.singers)} <span class="dim">· ${timeAgo(h.at, now)}</span></div>
      </div>
    </li>`)}
  </ol>`;
}
