// Bottom player bar: what's on, transport, seek, key/tempo, channel mode, volume, TV status.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, formatTime, singersText, useTick } from '../lib/store.js';
import { Cover, Stepper } from '../lib/components.js';
import { store, act, livePosition, toast, openDialog, conn } from './state.js';
import { KEY_MIN, KEY_MAX, TEMPO_MIN, TEMPO_MAX, TEMPO_STEP, formatKey, formatTempo } from '/shared/protocol.js';
import { VocalsControl } from './vocals.js';

/** Opens the TV page, on the second screen when the browser lets us place windows. */
export async function openTvWindow() {
  if (window.okDesktop?.openTv) { // the desktop app opens and places its own TV window
    try {
      const tv = await window.okDesktop.openTv();
      if (tv.already) toast('The TV window is already open.', 'info');
      else if (tv.wayland) toast('TV window opened. Move it to the TV: press Super+Shift+→ (or drag it there) and it goes full screen there by itself. Tip: with the mouse on the TV, Ctrl+T opens it right there — then F11.', 'info', 10000);
      else if (tv.second) toast('The TV window is open full screen on your second screen.', 'ok', 5000);
      else toast('TV window opened. Drag it onto the TV and press F11 for full screen — or connect the TV now: the window moves there by itself.', 'info', 8000);
    } catch (e) {
      toast(`The TV window could not be opened: ${e.message}`, 'error', 7000);
    }
    return;
  }
  const features = (x, y, w, h) => `popup,left=${x},top=${y},width=${w},height=${h}`;
  if ('getScreenDetails' in window) {
    try {
      const details = await window.getScreenDetails();
      const other = details.screens.find((s) => s !== details.currentScreen && !s.isPrimary) || details.screens.find((s) => s !== details.currentScreen);
      if (other) {
        const w = window.open('/tv', 'openkaraoke-tv', features(other.availLeft, other.availTop, other.availWidth, other.availHeight));
        if (w) {
          toast('TV display opened on your second screen. Click it once to start sound and full screen.', 'ok', 6000);
          return;
        }
      }
    } catch { /* permission denied: fall back to a normal popup */ }
  }
  const w = window.open('/tv', 'openkaraoke-tv', features(80, 80, 1280, 720));
  if (w) toast('Drag the TV window onto your TV, then click it and press F for full screen.', 'info', 7000);
  else toast('Your browser blocked the pop-up. Open /tv on the TV instead.', 'error', 7000);
}

function SeekBar({ dur, disabled, playing }) {
  const input = useRef(null);
  const label = useRef(null);
  const [drag, setDrag] = useState(null);
  // Follows the song every frame only while it plays (the position only moves then); otherwise
  // once per render, e.g. after a seek while paused. An idle host page draws nothing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (playing) raf = requestAnimationFrame(tick);
      if (drag !== null || !input.current) return;
      const pos = livePosition();
      input.current.value = String(pos);
      input.current.style.setProperty('--p', `${dur ? (pos / dur) * 100 : 0}%`);
      if (label.current) label.current.textContent = formatTime(pos);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  });
  const commit = (v) => {
    setDrag(null);
    act('player.seek', { pos: Number(v) });
  };
  return html`<div class="seek">
    <span class="num time" ref=${label}>${formatTime(drag ?? 0)}</span>
    <input ref=${input} type="range" min="0" max=${dur || 1} step="0.1" disabled=${disabled} aria-label="Seek"
      onInput=${(e) => { setDrag(Number(e.currentTarget.value)); e.currentTarget.style.setProperty('--p', `${dur ? (e.currentTarget.value / dur) * 100 : 0}%`); if (label.current) label.current.textContent = formatTime(Number(e.currentTarget.value)); }}
      onChange=${(e) => commit(e.currentTarget.value)} />
    <span class="num time">${formatTime(dur)}</span>
  </div>`;
}

function IntroStatus({ p }) {
  useTick(250);
  const left = Math.max(0, Math.ceil((p.introEndsAt - conn.serverNow()) / 1000));
  if (p.state === 'ready') return html`<span class="bulb-text">Ready — press play</span>`;
  if (!p.hasDisplay) return html`<span class="warn-text">Waiting for a TV display</span>`;
  if (p.displayLocked) return html`<span class="warn-text">Click the TV screen once to allow sound</span>`;
  if (!p.tvReady) return html`<span>Loading on the TV…${left ? ` ${left}` : ''}</span>`;
  return html`<span>Starting in ${left}…</span>`;
}

export function PlayerBar() {
  const { state } = useStore(store);
  if (!state) return null;
  const p = state.player;
  const cur = state.current;
  const hasQueue = state.queue.length > 0;
  const idle = !cur;
  const playing = p.state === 'playing';
  const tvCount = state.displays.filter((d) => d.display === 'main').length;
  const [previewOpen, setPreviewOpen] = useState(() => localStorage.getItem('ok.tvPreview') === '1');
  useEffect(() => { localStorage.setItem('ok.tvPreview', previewOpen ? '1' : '0'); }, [previewOpen]);
  const togglePlay = () => {
    if (idle) act('player.play');
    else if (playing) act('player.pause');
    else act('player.resume');
  };
  return html`<footer class="player">
    <div class="now">
      ${cur ? html`<${Cover} songId=${cur.songId} size=${54} />` : html`<div class="cover empty-cover" style="width:54px"><${Icon} name="mic" /></div>`}
      <div class="now-text">
        ${cur
          ? html`<div class="ellipsis now-title">${cur.title}</div>
                <div class="ellipsis now-sub">${cur.artist}${cur.singers.length ? html` · <span class="singer-name">${singersText(cur.singers)}</span>` : ''}</div>`
          : html`<div class="now-title muted">Nothing playing</div><div class="now-sub ellipsis">${state.breakMusic
            ? html`<span title="Break music on the TV">♪ ${state.breakMusic.title} · ${state.breakMusic.artist}</span> <button class="link" onClick=${() => act('break.skip')}>Skip</button>`
            : hasQueue ? 'Press play to start the queue' : 'Add a song to get started'}</div>`}
        ${cur && (p.state === 'intro' || p.state === 'ready') && html`<div class="now-status"><${IntroStatus} p=${p} /></div>`}
        ${cur && p.error && html`<div class="now-status warn-text ellipsis" title=${p.error}>${p.error}</div>`}
      </div>
    </div>

    <div class="transport">
      <div class="buttons">
        <button class="icon-btn" onClick=${() => act('player.restart')} disabled=${idle} aria-label="Restart song" title="Restart"><${Icon} name="restart" /></button>
        <button class="play-btn" onClick=${togglePlay} disabled=${idle && !hasQueue} aria-label=${playing ? 'Pause' : 'Play'} title=${playing ? 'Pause (space)' : 'Play (space)'}>
          <${Icon} name=${playing ? 'pause' : 'play'} size=${26} />
        </button>
        <button class="icon-btn" onClick=${() => act('player.next')} disabled=${idle && !hasQueue} aria-label="Next singer" title="Next singer (N)"><${Icon} name="next" /></button>
        <button class="icon-btn" onClick=${() => act('player.stop')} disabled=${idle} aria-label="Stop and return the song to the queue" title="Stop (song goes back to the queue)"><${Icon} name="stop" size=${18} /></button>
      </div>
      <${SeekBar} dur=${cur ? p.dur || cur.dur : 0} disabled=${idle || p.state === 'intro'} playing=${p.state === 'playing'} />
    </div>

    <div class="controls">
      <${Stepper} label="Key" value=${p.key} display=${formatKey(p.key)} min=${KEY_MIN} max=${KEY_MAX} step=${1} disabled=${idle}
        onChange=${(v) => act('player.key', { semitones: v })} onReset=${() => act('player.key', { semitones: 0 })} />
      <${Stepper} label="Tempo" value=${p.tempo} display=${formatTempo(p.tempo)} min=${TEMPO_MIN} max=${TEMPO_MAX} step=${TEMPO_STEP} disabled=${idle}
        onChange=${(v) => act('player.tempo', { rate: v })} onReset=${() => act('player.tempo', { rate: 1 })} />
      <${VocalsControl} p=${p} idle=${idle} />
      <label class="volume" title="Volume">
        <${Icon} name=${p.volume > 0 ? 'volume' : 'mute'} size=${18} />
        <input type="range" min="0" max="1" step="0.01" value=${p.volume} style=${{ '--p': `${p.volume * 100}%` }} aria-label="Volume"
          onInput=${(e) => e.currentTarget.style.setProperty('--p', `${e.currentTarget.value * 100}%`)}
          onChange=${(e) => act('player.volume', { v: Number(e.currentTarget.value) })} />
      </label>
      <button class=${`tv-status ${tvCount ? 'on' : 'off'}`} onClick=${openTvWindow} title=${tvCount ? 'TV display connected — click to open another' : 'No TV display — click to open one'}>
        <${Icon} name="tv" size=${18} /><span>${tvCount ? 'TV on' : 'Open TV'}</span>
      </button>
      <button class=${`icon-btn ${previewOpen ? 'active' : ''}`} onClick=${() => setPreviewOpen(!previewOpen)} aria-pressed=${previewOpen} title="Live preview of the TV">
        <${Icon} name="eye" size=${18} />
      </button>
      ${previewOpen && html`<${TvPreview} onClose=${() => setPreviewOpen(false)} />`}
    </div>
  </footer>`;
}

/** A small live copy of the TV screen (a muted mirror that doesn't count as a display). */
function TvPreview({ onClose }) {
  return html`<div class="tv-preview" role="dialog" aria-label="TV preview">
    <iframe src="/tv?display=preview&fullscreen=0" title="TV preview" tabindex="-1"></iframe>
    <button class="icon-btn small" onClick=${onClose} aria-label="Close the preview"><${Icon} name="x" size=${16} /></button>
  </div>`;
}

export function openInvite() {
  openDialog({ type: 'invite' });
}
