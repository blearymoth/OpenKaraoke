// Preview a version on the host computer (PLAN §10): plays the backing track in this
// browser, optionally on another audio output (headphones) so the party doesn't hear it.
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { createStore, useStore } from '../lib/store.js';

const SINK_KEY = 'ok.previewSink';
const audio = typeof Audio !== 'undefined' ? new Audio() : null;
export const previewStore = createStore({ trackId: null, playing: false, error: null });

if (audio) {
  audio.preload = 'none';
  audio.addEventListener('ended', () => previewStore.update({ playing: false, trackId: null }));
  audio.addEventListener('pause', () => previewStore.update({ playing: false }));
  audio.addEventListener('playing', () => previewStore.update({ playing: true, error: null }));
  audio.addEventListener('error', () => previewStore.update({ playing: false, error: 'This file can’t be previewed here.' }));
}

async function applySink() {
  const id = localStorage.getItem(SINK_KEY);
  if (!id || !audio?.setSinkId) return;
  try {
    await audio.setSinkId(id);
  } catch {
    localStorage.removeItem(SINK_KEY); // the device is gone
  }
}

/** Starts (or stops, when it is the one playing) the preview of a track. */
export async function togglePreview(trackId) {
  if (!audio) return;
  const st = previewStore.get();
  if (st.trackId === trackId && st.playing) {
    audio.pause();
    return;
  }
  previewStore.set({ trackId, playing: false, error: null });
  audio.src = `/media/${encodeURIComponent(trackId)}/audio`;
  await applySink();
  audio.volume = 0.8;
  audio.play().catch((e) => previewStore.update({ playing: false, error: e.message }));
}

export function stopPreview() {
  if (audio && !audio.paused) audio.pause();
  previewStore.set({ trackId: null, playing: false, error: null });
}

export function PreviewButton({ trackId }) {
  const st = useStore(previewStore);
  const on = st.trackId === trackId && st.playing;
  return html`<button class=${`btn small ${on ? 'on' : 'ghost'}`} onClick=${() => togglePreview(trackId)} title="Listen on this computer (not on the TV)">
    <${Icon} name=${on ? 'pause' : 'headphones'} size=${14} /> ${on ? 'Stop' : 'Preview'}
  </button>`;
}

/** Where previews play: pick headphones so guests don't hear them (Chrome/Edge only). */
export function PreviewOutput() {
  const [devices, setDevices] = useState([]);
  const [sink, setSink] = useState(() => localStorage.getItem(SINK_KEY) || '');
  const st = useStore(previewStore);
  useEffect(() => {
    if (!audio?.setSinkId || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.label)))
      .catch(() => {});
  }, []);
  useEffect(() => () => stopPreview(), []);
  const choose = (id) => {
    setSink(id);
    if (id) localStorage.setItem(SINK_KEY, id);
    else localStorage.removeItem(SINK_KEY);
    applySink();
  };
  return html`<div class="preview-output">
    ${st.error && html`<p class="warn-text">${st.error}</p>`}
    ${devices.length > 1
      ? html`<label class="field"><span>Preview plays on</span>
          <select class="select" value=${sink} onChange=${(e) => choose(e.currentTarget.value)}>
            <option value="">This computer’s default output</option>
            ${devices.map((d) => html`<option value=${d.deviceId}>${d.label}</option>`)}
          </select></label>`
      : html`<p class="hint">Previews play on this computer’s default sound output — use headphones if that is also the party speaker.</p>`}
  </div>`;
}
