// The player: the desktop bar (what's on, transport, seek, volume, TV status — key, tempo and the
// rest are in the admin panel's Playback tab), the phones' mini player, and their pieces.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore, formatTime, singersText, useTick } from '../lib/store.js';
import { Cover } from '../lib/components.js';
import { store, act, livePosition, toast, openDialog, openPanel, conn } from './state.js';
import { formatKey, formatTempo } from '/shared/protocol.js';
import { LOOPBACK } from './preview.js';

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

export function SeekBar({ dur, disabled, playing }) {
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

export function IntroStatus({ p }) {
  useTick(250);
  const left = Math.max(0, Math.ceil((p.introEndsAt - conn.serverNow()) / 1000));
  if (p.state === 'ready') return html`<span class="bulb-text">Ready — press play</span>`;
  if (!p.hasDisplay) return html`<span class="warn-text">Waiting for a TV display</span>`;
  if (p.displayLocked) return html`<span class="warn-text">Click the TV screen once to allow sound</span>`;
  if (!p.tvReady) return html`<span>Loading on the TV…${left ? ` ${left}` : ''}</span>`;
  return html`<span>Starting in ${left}…</span>`;
}

/** The four transport buttons (restart, play/pause, next singer, stop). `big`: the phone page. */
export function TransportButtons({ state, big = false }) {
  const p = state.player;
  const cur = state.current;
  const hasQueue = state.queue.length > 0;
  const idle = !cur;
  const playing = p.state === 'playing';
  const togglePlay = () => {
    if (idle) act('player.play');
    else if (playing) act('player.pause');
    else act('player.resume');
  };
  return html`<div class=${`buttons ${big ? 'big' : ''}`}>
    <button class="icon-btn" onClick=${() => act('player.restart')} disabled=${idle} aria-label="Restart song" title="Restart"><${Icon} name="restart" /></button>
    <button class="play-btn" onClick=${togglePlay} disabled=${idle && !hasQueue} aria-label=${playing ? 'Pause' : 'Play'} title=${playing ? 'Pause (space)' : 'Play (space)'}>
      <${Icon} name=${playing ? 'pause' : 'play'} size=${big ? 30 : 26} />
    </button>
    <button class="icon-btn" onClick=${() => act('player.next')} disabled=${idle && !hasQueue} aria-label="Next singer" title="Next singer (N)"><${Icon} name="next" /></button>
    <button class="icon-btn" onClick=${() => act('player.stop')} disabled=${idle} aria-label="Stop and return the song to the queue" title="Stop (song goes back to the queue)"><${Icon} name="stop" size=${18} /></button>
  </div>`;
}

export function VolumeControl({ p }) {
  return html`<label class="volume" title="Volume">
    <${Icon} name=${p.volume > 0 ? 'volume' : 'mute'} size=${18} />
    <input type="range" min="0" max="1" step="0.01" value=${p.volume} style=${{ '--p': `${p.volume * 100}%` }} aria-label="Volume"
      onInput=${(e) => e.currentTarget.style.setProperty('--p', `${e.currentTarget.value * 100}%`)}
      onChange=${(e) => act('player.volume', { v: Number(e.currentTarget.value) })} />
  </label>`;
}

/** This page can open a TV window on this computer (the desktop app, or a browser on it). */
export function canOpenTv() {
  return !!window.okDesktop?.openTv || LOOPBACK.has(location.hostname);
}

/** Desktop: what is on, transport and seek, volume and the TV chip (the rest is in the panel). */
export function PlayerBar() {
  const { state } = useStore(store);
  if (!state) return null;
  const p = state.player;
  const cur = state.current;
  const hasQueue = state.queue.length > 0;
  const idle = !cur;
  const tvCount = state.displays.filter((d) => d.display === 'main').length;
  const tune = cur && (p.key !== 0 || p.tempo !== 1) && html`<button class="pill tune-pill" onClick=${() => openPanel('playback', 'sound')}
    aria-label=${`Key ${formatKey(p.key)}, tempo ${formatTempo(p.tempo)}. Open the Sound controls`} title="Key and tempo — open the Sound controls">
    ${[p.key ? `Key ${formatKey(p.key)}` : '', p.tempo !== 1 ? formatTempo(p.tempo) : ''].filter(Boolean).join(' · ')}</button>`;
  return html`<footer class="player" aria-label="Player">
    <div class="now">
      ${cur ? html`<${Cover} songId=${cur.songId} size=${54} />` : html`<div class="cover empty-cover" style="width:54px"><${Icon} name="mic" /></div>`}
      <div class="now-text">
        ${cur
          ? html`<div class="now-line"><span class="ellipsis now-title">${cur.title}</span>${tune}</div>
                <div class="ellipsis now-sub">${cur.artist}${cur.singers.length ? html` · <span class="singer-name">${singersText(cur.singers)}</span>` : ''}</div>`
          : html`<div class="now-title muted">Nothing playing</div><div class="now-sub ellipsis">${state.breakMusic
            ? html`<span title="Break music on the TV">♪ ${state.breakMusic.title} · ${state.breakMusic.artist}</span> <button class="link" onClick=${() => act('break.skip')}>Skip</button>`
            : hasQueue ? 'Press play to start the queue' : 'Add a song to get started'}</div>`}
        ${cur && (p.state === 'intro' || p.state === 'ready') && html`<div class="now-status"><${IntroStatus} p=${p} /></div>`}
        ${cur && p.error && html`<div class="now-status warn-text ellipsis" title=${p.error}>${p.error}</div>`}
      </div>
    </div>

    <div class="transport">
      <${TransportButtons} state=${state} />
      <${SeekBar} dur=${cur ? p.dur || cur.dur : 0} disabled=${idle || p.state === 'intro'} playing=${p.state === 'playing'} />
    </div>

    <div class="controls">
      <${VolumeControl} p=${p} />
      ${tvCount
        ? html`<button class="tv-status on" onClick=${() => openPanel('playback', 'video')} title="TV display connected — show the TV controls"><${Icon} name="tv" size=${18} /><span>TV on</span></button>`
        : html`<button class="tv-status off" onClick=${() => (canOpenTv() ? openTvWindow() : openPanel('devices'))} title="No TV display — open one"><${Icon} name="tv" size=${18} /><span>Open TV</span></button>`}
    </div>
  </footer>`;
}

/** Phones: a slim player (what is on, play/pause, next); tapping it opens the Playback page. */
export function MiniPlayer() {
  const { state } = useStore(store);
  const bar = useRef(null);
  const p = state?.player;
  const cur = state?.current;
  const dur = cur ? p.dur || cur.dur : 0;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (p?.state === 'playing') raf = requestAnimationFrame(tick);
      if (bar.current) bar.current.style.width = `${dur ? Math.min(100, (livePosition() / dur) * 100) : 0}%`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  });
  if (!state) return null;
  const hasQueue = state.queue.length > 0;
  const idle = !cur;
  const playing = p.state === 'playing';
  const togglePlay = () => {
    if (idle) act('player.play');
    else if (playing) act('player.pause');
    else act('player.resume');
  };
  let status = null;
  if (cur && (p.state === 'intro' || p.state === 'ready')) status = html`<${IntroStatus} p=${p} />`;
  else if (cur && p.error) status = html`<span class="warn-text ellipsis">${p.error}</span>`;
  else if (cur && (p.key !== 0 || p.tempo !== 1)) status = html`<span class="faint">${[p.key ? `Key ${formatKey(p.key)}` : '', p.tempo !== 1 ? formatTempo(p.tempo) : ''].filter(Boolean).join(' · ')}</span>`;
  return html`<footer class="player mini" aria-label="Player">
    <button class="now mini" onClick=${() => openPanel('playback')} aria-label=${cur ? `Playback controls: ${cur.title}` : 'Playback controls'}>
      <span class="now-text">
        <span class="ellipsis now-title">${cur ? cur.title : 'Nothing playing'}</span>
        <span class="ellipsis now-sub">${cur
          ? [singersText(cur.singers), cur.artist].filter(Boolean).join(' · ')
          : state.breakMusic ? `♪ ${state.breakMusic.title} · ${state.breakMusic.artist}` : hasQueue ? 'Press play to start the queue' : 'Add a song to get started'}</span>
        ${status && html`<span class="now-status">${status}</span>`}
      </span>
    </button>
    <div class="buttons">
      <button class="play-btn" onClick=${togglePlay} disabled=${idle && !hasQueue} aria-label=${playing ? 'Pause' : 'Play'}><${Icon} name=${playing ? 'pause' : 'play'} size=${24} /></button>
      <button class="icon-btn" onClick=${() => act('player.next')} disabled=${idle && !hasQueue} aria-label="Next singer"><${Icon} name="next" /></button>
    </div>
    <div class="mini-progress" aria-hidden="true"><i ref=${bar}></i></div>
  </footer>`;
}

export function openInvite() {
  openDialog({ type: 'invite' });
}
