// Bottom player bar: transport, seek, key, tempo, channel mode, volume, TV status.
import { html, useState, useEffect } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { Icon, Cover, SingerBadge, formatDuration, useNow, names, toast } from '/js/lib/ui.js';
import { formatKey, formatTempo, CHANNEL_MODES, CHANNEL_LABELS } from '/shared/protocol.js';
import { store, act, livePosition, openDetails } from './state.js';

/** Opens the TV page on the second screen when the browser can (Window Management API). */
export async function openTvWindow() {
  const url = '/tv';
  if ('getScreenDetails' in window) {
    try {
      const sd = await window.getScreenDetails();
      const other = sd.screens.find((s) => s !== sd.currentScreen && !s.isPrimary) || sd.screens.find((s) => s !== sd.currentScreen);
      if (other) {
        window.open(url, 'ok-tv', `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`);
        toast(`TV display opened on “${other.label || 'second screen'}” — click “Start” on it to go full screen`, 'ok', 6000);
        return;
      }
    } catch { /* permission denied or unsupported */ }
  }
  window.open(url, 'ok-tv', 'popup,width=1280,height=720');
  toast('Drag the TV window to the TV screen and click “Start” to go full screen (or use bin/open-tv.sh)', 'info', 7000);
}

export function PlayerBar() {
  const st = useStore(store, (s) => s.state);
  useNow(250);
  const [seeking, setSeeking] = useState(null);
  if (!st) return null;
  const p = st.player;
  const cur = st.current;
  const pos = seeking ?? livePosition();
  const dur = p.duration || cur?.dur || 0;
  const playing = p.state === 'playing' || p.state === 'intro';
  const main = st.displays.find((d) => d.main);
  const volPct = Math.round((p.volume ?? 0.9) * 100);
  return html`<footer class="player-bar">
    <div class="pb-now">
      ${cur ? html`
        <${Cover} song=${{ id: cur.songId }} size=${52} />
        <div class="grow" style=${{ minWidth: 0, cursor: 'pointer' }} onClick=${() => openDetails(cur.songId)}>
          <div class="t ellipsis">${cur.title}</div>
          <div class="a ellipsis">${cur.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${18} />`)} ${names(cur.singers)} · ${cur.artist}</div>
        </div>` : html`<div class="muted">${st.queue.length ? `${st.queue.length} song${st.queue.length > 1 ? 's' : ''} waiting — press play` : 'Nothing playing'}</div>`}
    </div>
    <div class="pb-center">
      <div class="transport">
        <button class="btn icon ghost" title="Restart song (←)" disabled=${!cur} onClick=${() => act('player.restart')}><${Icon} name="restart" size=${18} /></button>
        <button class="btn icon play" title="Play / pause (space)" disabled=${!cur && !st.queue.length} onClick=${() => act('player.toggle')}><${Icon} name=${playing ? 'pause' : 'play'} size=${22} /></button>
        <button class="btn icon ghost" title="Next singer (N)" disabled=${!cur && !st.queue.length} onClick=${() => act('player.next')}><${Icon} name="next" size=${18} /></button>
        <button class="btn icon ghost" title="Stop" disabled=${!cur} onClick=${() => act('player.stop')}><${Icon} name="stop" size=${16} /></button>
        ${p.state === 'intro' && html`<button class="btn small" onClick=${() => act('player.skipIntro')}>Start now</button>`}
      </div>
      <div class="seek">
        <span class="time">${formatDuration(pos)}</span>
        <input type="range" min="0" max=${Math.max(1, dur)} step="0.5" value=${pos} disabled=${!cur}
          onInput=${(e) => setSeeking(Number(e.currentTarget.value))}
          onChange=${(e) => { act('player.seek', { pos: Number(e.currentTarget.value) }); setTimeout(() => setSeeking(null), 400); }} />
        <span class="time">${formatDuration(dur)}</span>
      </div>
    </div>
    <div class="pb-right">
      <div class="knob" title="Key (+/−)">
        <span class="lbl">Key</span>
        <button class="btn icon small ghost" onClick=${() => act('player.key', { delta: -1 })}><${Icon} name="minus" size=${14} /></button>
        <b class=${p.key ? 'changed' : ''} onDblClick=${() => act('player.key', { semitones: 0 })}>${formatKey(p.key)}</b>
        <button class="btn icon small ghost" onClick=${() => act('player.key', { delta: 1 })}><${Icon} name="plus" size=${14} /></button>
      </div>
      <div class="knob" title="Tempo ([ / ])">
        <span class="lbl">Tempo</span>
        <button class="btn icon small ghost" onClick=${() => act('player.tempo', { delta: -0.05 })}><${Icon} name="minus" size=${14} /></button>
        <b class=${p.tempo !== 1 ? 'changed' : ''} onDblClick=${() => act('player.tempo', { rate: 1 })}>${formatTempo(p.tempo)}</b>
        <button class="btn icon small ghost" onClick=${() => act('player.tempo', { delta: 0.05 })}><${Icon} name="plus" size=${14} /></button>
      </div>
      <select class="input channel" title="Channels (multiplex / vocal cut)" value=${p.channel} onChange=${(e) => act('player.channel', { mode: e.currentTarget.value })}>
        ${CHANNEL_MODES.map((m) => html`<option value=${m}>${CHANNEL_LABELS[m]}</option>`)}
      </select>
      <div class="vol" title=${`Volume ${volPct} %`}>
        <${Icon} name=${volPct ? 'volume' : 'mute'} size=${18} />
        <${VolumeSlider} value=${p.volume ?? 0.9} />
      </div>
      <button class=${`tv-status ${main ? 'ok' : 'bad'}`} title=${main ? 'TV display connected' : 'No TV display — click to open one'} onClick=${() => (main ? (location.hash = '#/displays') : openTvWindow())}>
        <${Icon} name="tv" size=${18} /><span class="dot"></span>
      </button>
    </div>
  </footer>`;
}

let volTimer = null;
let volPending = null;
function sendVolume(v) {
  volPending = v;
  if (volTimer) return;
  volTimer = setTimeout(() => {
    volTimer = null;
    act('player.volume', { v: volPending });
  }, 80);
}

function VolumeSlider({ value }) {
  const [v, setV] = useState(value);
  const [active, setActive] = useState(false);
  useEffect(() => { if (!active) setV(value); }, [value, active]);
  return html`<input type="range" min="0" max="1" step="0.01" value=${v}
    onPointerDown=${() => setActive(true)}
    onInput=${(e) => { const n = Number(e.currentTarget.value); setV(n); sendVolume(n); }}
    onChange=${() => setActive(false)} />`;
}
