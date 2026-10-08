// Admin panel → Playback: what is on (and the vote on its version), the sound (key, tempo,
// channels or the guide singer) and the video (a live preview of the TV, which screen plays,
// a few TV settings at hand).
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { plural, singersText } from '../lib/store.js';
import { Cover, Stepper, Switch, useMedia } from '../lib/components.js';
import { VersionVote } from '../lib/versions.js';
import { act, openDialog, openPanel, toast, previewPref, setPreviewPref, saveSetting } from './state.js';
import { IntroStatus, TransportButtons, SeekBar, VolumeControl, canOpenTv, openTvWindow } from './player.js';
import { VocalsControl } from './vocals.js';
import { LOOPBACK } from './preview.js';
import { KEY_MIN, KEY_MAX, TEMPO_MIN, TEMPO_MAX, TEMPO_STEP, formatKey, formatTempo } from '/shared/protocol.js';
import { normalizeLyricsLook, normalizeLyricsLayout } from '/shared/lyrics.js';

/** display.lyricsLook in a narrow row (Settings → TV display has the long names). */
/** display.lyricsLayout in a narrow row. */
const LYRICS_LAYOUT_SHORT = [['page', 'Pages'], ['lines', 'Two lines'], ['scroll', 'Scrolling']];
const LYRICS_LOOK_SHORT = [['panel', 'On a dark panel'], ['clear', 'With an outline'], ['disc', 'As the disc made them']];

const LABELS = { intro: 'Getting ready', ready: 'Ready to start', playing: 'Singing now', paused: 'Paused' };

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', 'ok', 1500);
  } catch {
    toast(text, 'info', 8000);
  }
}

function VersionRow({ cur }) {
  const v = cur.version;
  const pill = v.status === 'liked'
    ? html`<span class="pill neon">${v.host === 1 ? 'Your pick' : 'Guests like it'}</span>`
    : v.status === 'avoided' ? html`<span class="pill bad">${v.host === -1 ? 'Avoided by you' : 'Avoided'}</span>` : null;
  return html`<div class="pb-version" id="pb-version">
    <div class="pb-version-text">
      <div class="ellipsis"><b>${v.label}</b> <span class="faint">· ${v.count} versions</span></div>
      <div class="faint">${v.plays ? `Sung ${plural(v.plays, 'time')} here` : 'Not sung here before'} ${pill}</div>
      <button class="link" onClick=${() => openDialog({ type: 'song', songId: cur.songId })}>All versions</button>
    </div>
    <${VersionVote} v=${v} onVote=${(x) => act('version.vote', { trackId: cur.trackId, vote: x })} />
  </div>`;
}

function NowSection({ state, full }) {
  const p = state.player;
  const cur = state.current;
  const idle = !cur;
  let status = null;
  if (cur) {
    if (p.state === 'intro' || p.state === 'ready') status = html`<${IntroStatus} p=${p} />`;
    else if (p.error) status = html`<span class="warn-text">${p.error}</span> <button class="btn small" onClick=${() => act('player.resume')}>Try again</button>`;
  }
  if (!status && !p.hasDisplay && (cur || state.queue.length)) {
    status = html`<span class="warn-text">No TV display is connected — songs can’t start.</span>
      ${canOpenTv() ? html`<button class="btn small" onClick=${openTvWindow}>Open TV window</button>` : html`<button class="link" onClick=${() => openPanel('devices')}>Devices</button>`}`;
  } else if (!status && p.displayLocked) status = html`<span class="warn-text">Click the TV screen once to allow sound</span>`;
  if (!status && state.gameBlocks) status = html`<span>A game is using the TV.</span> <a class="link" href="#/games">Games</a>`;
  const next = state.queue[0];
  return html`<section class="pb-section" id="pb-now" aria-labelledby="pb-now-title">
    <h3 id="pb-now-title">Now playing</h3>
    ${cur
      ? html`<div class="pb-now">
          <${Cover} songId=${cur.songId} size=${72} />
          <div class="pb-now-text">
            <div class="pb-label">${LABELS[p.state] || ''}</div>
            <div class="pb-singer ellipsis">${cur.singers.length ? html`${cur.singers[0].emoji} ${singersText(cur.singers)}` : 'Sing along'}</div>
            <div class="ellipsis muted">${cur.title} · ${cur.artist}</div>
            <div class="pb-pills">
              ${p.key !== 0 && html`<span class="pill">Key ${formatKey(p.key)}</span>`}
              ${p.tempo !== 1 && html`<span class="pill">${formatTempo(p.tempo)}</span>`}
              ${cur.kind === 'video' && html`<span class="pill">Video</span>`}
              ${cur.brand && html`<span class="pill">${cur.brand}</span>`}
            </div>
          </div>
        </div>`
      : html`<div class="pb-idle">
          <div class="pb-label">Nothing playing</div>
          ${next
            ? html`<p class="muted">Up next: ${singersText(next.singers) || 'everyone'} — ${next.title}</p>
              <div class="btn-row"><button class="btn small primary" disabled=${state.gameBlocks} onClick=${() => act('player.play')}>Start the queue</button></div>`
            : html`<p class="muted">The queue is empty.</p>`}
          ${state.breakMusic && html`<p class="faint">♪ Break music: ${state.breakMusic.title} · ${state.breakMusic.artist} <button class="link" onClick=${() => act('break.skip')}>Skip</button></p>`}
        </div>`}
    ${status && html`<div class="pb-status">${status}</div>`}
    ${cur?.version && html`<${VersionRow} cur=${cur} />`}
    ${full && html`<div class="pb-transport">
      <${TransportButtons} state=${state} big=${true} />
      <${SeekBar} dur=${cur ? p.dur || cur.dur : 0} disabled=${idle || p.state === 'intro'} playing=${p.state === 'playing'} />
      <div class="pb-volume"><${VolumeControl} p=${p} /></div>
    </div>`}
  </section>`;
}

function SoundSection({ state }) {
  const p = state.player;
  const idle = !state.current;
  return html`<section class="pb-section" id="pb-sound" aria-labelledby="pb-sound-title">
    <h3 id="pb-sound-title">Sound</h3>
    <div class="sound-grid">
      <${Stepper} label="Key" value=${p.key} display=${formatKey(p.key)} min=${KEY_MIN} max=${KEY_MAX} step=${1} disabled=${idle}
        onChange=${(v) => act('player.key', { semitones: v })} onReset=${() => act('player.key', { semitones: 0 })} />
      <${Stepper} label="Tempo" value=${p.tempo} display=${formatTempo(p.tempo)} min=${TEMPO_MIN} max=${TEMPO_MAX} step=${TEMPO_STEP} disabled=${idle}
        onChange=${(v) => act('player.tempo', { rate: v })} onReset=${() => act('player.tempo', { rate: 1 })} />
      <div class="pb-channel" id="pb-vocals">
        <${VocalsControl} p=${p} idle=${idle} />
        <p class="hint">${p.vocals?.adjustable && !idle
          ? 'The original singer on this version: off, quiet or full — the music stays as it is. ⋯ for which side and other versions.'
          : 'Which channels play. For a multiplex track not recognised as one, pick the side without the guide singer — or ⋯ to tell which side the singer is on.'}</p>
      </div>
    </div>
  </section>`;
}

/** The live preview: one muted TV page, only while it can be seen. */
function PreviewFrame({ state, narrow }) {
  const [on, setOn] = useState(() => previewPref(narrow));
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [theatre, setTheatre] = useState(false);
  const bigger = useRef(null);
  const close = useRef(null);
  useEffect(() => {
    const v = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, []);
  useEffect(() => {
    if (!theatre) return undefined;
    close.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') setTheatre(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [theatre]);
  const wasTheatre = useRef(false);
  useEffect(() => {
    if (wasTheatre.current && !theatre) bigger.current?.focus();
    wasTheatre.current = theatre;
  }, [theatre]);
  const main = state.displays.find((d) => d.display === 'main');
  // The TV went away: no big view waiting to pop up again by itself when one connects.
  useEffect(() => { if (!main && theatre) setTheatre(false); }, [!!main]);
  const lan = state.info.lanUrls?.[0] || state.info.baseUrl;
  const show = (v) => {
    setOn(v);
    setPreviewPref(v);
    if (!v) setTheatre(false);
  };
  if (!main) {
    return html`<div class="preview-empty">
      <span>No TV display is connected.</span>
      ${canOpenTv()
        ? html`<button class="btn small" onClick=${openTvWindow}><${Icon} name="tv" size=${16} /> Open TV window</button>`
        : html`<span class="hint">On the TV, open <code>${lan}/tv</code>.</span><button class="btn small ghost" onClick=${() => copyText(`${lan}/tv`)}>Copy link</button>`}
      ${state.pairings.length > 0 && html`<button class="link" onClick=${() => openPanel('devices')}>${plural(state.pairings.length, 'screen')} waiting to pair</button>`}
    </div>`;
  }
  if (!on) return html`<button class="preview-off" onClick=${() => show(true)}><${Icon} name="eye" size=${18} /> Show live preview</button>`;
  const src = `/tv?display=preview&fullscreen=0${LOOPBACK.has(location.hostname) ? '' : '&video=0'}`;
  return html`
    ${theatre && html`<div class="preview-backdrop" onClick=${() => setTheatre(false)}></div>`}
    <div class=${`preview-frame${theatre ? ' theatre' : ''}`} role=${theatre ? 'dialog' : undefined} aria-modal=${theatre ? 'true' : undefined} aria-label=${theatre ? 'Big TV preview' : undefined}>
      ${visible && html`<iframe src=${src} title="Live TV preview" tabindex="-1"></iframe>`}
      <div class="preview-chips">
        <span class="pill"><span class="live-dot"></span> Live</span>
        ${main.standIn && html`<span class="pill bulb">Stand-in TV</span>`}
        ${state.player.displayLocked && html`<span class="pill bulb">Click the TV once to allow sound</span>`}
      </div>
      <div class="preview-tools">
        ${theatre
          ? html`<button ref=${close} class="icon-btn small preview-close" aria-label="Close the big preview" onClick=${() => setTheatre(false)}><${Icon} name="x" size=${16} /></button>`
          : html`<button ref=${bigger} class="icon-btn small" aria-label="Show the preview bigger" title="Bigger" onClick=${() => setTheatre(true)}><${Icon} name="fullscreen" size=${16} /></button>
            <button class="icon-btn small" aria-label="Hide the preview" title="Hide" onClick=${() => show(false)}><${Icon} name="x" size=${16} /></button>`}
      </div>
    </div>`;
}

/** The desktop app's TV window: open, full screen, on which screen. */
function TvWindowControls() {
  const tv = window.okDesktop.tv;
  const [st, setSt] = useState(null);
  useEffect(() => {
    const off = tv.onChange((s) => setSt(s));
    tv.get().then(setSt).catch(() => {});
    return off;
  }, []);
  if (!st) return null;
  const screen = st.screens.find((x) => x.id === st.screenId);
  const run = async (p) => {
    try {
      setSt(await p);
    } catch (e) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), 'error');
      tv.get().then(setSt).catch(() => {});
    }
  };
  return html`<div class="tv-window">
    <p>${!st.open ? 'TV window: closed'
      : st.fullscreen ? (screen ? `TV window: full screen on ${screen.name} (${screen.size})` : 'TV window: full screen')
        : st.placeable === false ? 'TV window: open (not full screen)' : 'TV window: open on this screen (not full screen)'}</p>
    <div class="btn-row">
      ${st.open
        ? html`<button class="btn small" onClick=${() => run(tv.close())}>Close</button>
          <button class=${`btn small ${st.fullscreen ? 'on' : ''}`} aria-pressed=${st.fullscreen} onClick=${() => run(tv.fullscreen(!st.fullscreen))}>Full screen</button>
          ${st.placeable !== false && st.screens.length > 1 && html`<label class="qs-row"><span>Show it on</span>
            <select class="select" value=${st.screenId ?? ''} onChange=${(e) => run(tv.place(Number(e.currentTarget.value)))}>
              ${st.screens.map((x) => html`<option value=${x.id}>${x.name} — ${x.size}${x.host ? ' (this screen)' : ''}</option>`)}
            </select></label>`}
          ${st.placeable === false && html`<p class="hint">To move it to the TV: <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>→</kbd> or drag it there — it goes full screen by itself.</p>`}`
        : html`<button class="btn small" onClick=${() => run(tv.open())}><${Icon} name="tv" size=${16} /> Open TV window</button>`}
    </div>
  </div>`;
}

function VideoSection({ state, narrow }) {
  const main = state.displays.find((d) => d.display === 'main');
  const switchable = state.displays.filter((d) => d.kind !== 'board').length >= 2;
  const lan = state.info.lanUrls?.[0] || state.info.baseUrl;
  const settings = state.settings;
  const offset = settings.playback.lyricOffsetMs || 0;
  return html`<section class="pb-section" id="pb-video" aria-labelledby="pb-video-title">
    <h3 id="pb-video-title">Video</h3>
    <h4>Live preview</h4>
    <${PreviewFrame} state=${state} narrow=${narrow} />
    <h4>TV output</h4>
    <div class="pb-output">
      ${main
        ? html`<span><span class="live-dot"></span> ${main.local ? 'Main TV on this computer plays the sound.' : `Main TV at ${main.ip} plays the sound.`}</span>`
        : html`<span class="warn-text">No TV display is connected.</span>`}
      ${switchable && html` <button class="link" onClick=${() => openPanel('devices')}>Change</button>`}
    </div>
    ${window.okDesktop?.tv
      ? html`<${TvWindowControls} />`
      : canOpenTv()
        ? html`<div class="btn-row"><button class="btn small" onClick=${openTvWindow}><${Icon} name="tv" size=${16} /> Open TV window</button></div>
          <p class="hint">Click the TV window once to allow sound; F switches full screen.</p>`
        : html`<p class="hint">On the TV, open <code>${lan}/tv</code>. <button class="link" onClick=${() => copyText(`${lan}/tv`)}>Copy link</button></p>`}
    <details class="pb-quick" id="pb-quick">
      <summary>On the TV</summary>
      <div class="qs-rows">
        <label class="qs-row"><span>Background</span>
          <select class="select" value=${settings.display.background} aria-label="Background" onChange=${(e) => saveSetting('display.background', e.currentTarget.value, { quiet: true })}>
            <option value="art">Cover art and artist photos</option><option value="photos">Guests’ photos</option><option value="visualizer">Moving lights</option><option value="plain">Plain</option>
          </select></label>
        <div class="qs-row"><span>Lyrics timing<br /><span class="hint">Raise it if the lyrics run behind the music.</span></span>
          <${Stepper} label="Lyrics" value=${offset} display=${`${offset > 0 ? '+' : ''}${offset} ms`} min=${-2000} max=${2000} step=${50}
            onChange=${(v) => saveSetting('playback.lyricOffsetMs', v, { quiet: true })} onReset=${() => saveSetting('playback.lyricOffsetMs', 0, { quiet: true })} /></div>
        <label class="qs-row"><span>Lyrics layout</span>
          <select class="select" value=${normalizeLyricsLayout(settings.display.lyricsLayout)} aria-label="Lyrics layout" onChange=${(e) => saveSetting('display.lyricsLayout', e.currentTarget.value, { quiet: true })}>
            ${LYRICS_LAYOUT_SHORT.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select></label>
        <label class="qs-row"><span>Lyrics look</span>
          <select class="select" value=${normalizeLyricsLook(settings.display.lyricsLook)} aria-label="Lyrics look" onChange=${(e) => saveSetting('display.lyricsLook', e.currentTarget.value, { quiet: true })}>
            ${LYRICS_LOOK_SHORT.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select></label>
        <div class="qs-row"><span>QR code in the corner</span>
          <${Switch} checked=${!!settings.display.showQr} label="QR code in the corner" onChange=${(v) => saveSetting('display.showQr', v, { quiet: true })} /></div>
      </div>
      <div class="btn-row"><button class="btn small" onClick=${() => openDialog({ type: 'announce' })}><${Icon} name="megaphone" size=${16} /> Announce on the TV</button><a class="link" href="#/settings/display">All TV settings</a></div>
    </details>
  </section>`;
}

/** `full`: the phone page, which also has the transport, seek and volume (desktop: the bar). */
export function PlaybackTab({ state, full = false }) {
  const narrow = useMedia('(max-width: 900px)');
  return html`<div class="playback">
    <${NowSection} state=${state} full=${full} />
    <${SoundSection} state=${state} />
    <${VideoSection} state=${state} narrow=${narrow} />
  </div>`;
}
