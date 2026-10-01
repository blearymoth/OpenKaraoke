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

const storedSink = () => {
  try {
    return localStorage.getItem(SINK_KEY) || '';
  } catch {
    return '';
  }
};

/** Plays previews on the chosen output ('' = the default one). */
async function applySink() {
  if (!audio?.setSinkId) return;
  const id = storedSink();
  try {
    await audio.setSinkId(id);
  } catch {
    // Unplugged, or not allowed (yet) in this browser session: the default output for now,
    // but keep the choice for when the headphones are back.
    await audio.setSinkId('').catch(() => {});
  }
}

/** Audio outputs other than the default one (without permission browsers hide their names, or all of them). */
async function listOutputs() {
  const list = await navigator.mediaDevices.enumerateDevices();
  return list
    .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Sound output ${i + 1}`, named: !!d.label }));
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
  // Stopped (the dialog closed) or another version chosen while the output was being set.
  if (previewStore.get().trackId !== trackId) return;
  audio.volume = 0.8;
  audio.play().catch((e) => {
    // Interrupted by Stop, by closing the dialog or by a newer preview: not an error to show.
    if (e?.name === 'AbortError' || previewStore.get().trackId !== trackId) return;
    previewStore.update({ playing: false, error: e?.message || 'This file can’t be previewed here.' });
  });
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

/**
 * Where previews play: pick headphones so the party doesn't hear them (browsers that can
 * choose the output: Chrome/Edge, Firefox). Browsers only name the outputs, and let a page
 * use them, after the person allowed it once: "Choose headphones…" asks.
 */
export function PreviewOutput() {
  const canChoose = !!(audio?.setSinkId && window.isSecureContext && navigator.mediaDevices?.enumerateDevices);
  const [devices, setDevices] = useState([]);
  const [sink, setSink] = useState(storedSink);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const st = useStore(previewStore);
  const refresh = () => listOutputs().then(setDevices).catch(() => {});
  useEffect(() => {
    if (!canChoose) return undefined;
    refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
  }, []);
  useEffect(() => () => stopPreview(), []);
  const choose = (id) => {
    setSink(id);
    try {
      if (id) localStorage.setItem(SINK_KEY, id);
      else localStorage.removeItem(SINK_KEY);
    } catch { /* private mode: this page only */ }
    applySink();
  };
  const ask = async () => {
    setAsking(true);
    setNote('');
    const picker = !!navigator.mediaDevices.selectAudioOutput;
    try {
      if (picker) {
        // The browser's own picker (Firefox): the answer is the output to use.
        const dev = await navigator.mediaDevices.selectAudioOutput();
        const list = await listOutputs().catch(() => []);
        setDevices(list.some((d) => d.id === dev.deviceId) ? list : [...list, { id: dev.deviceId, label: dev.label || 'Headphones', named: true }]);
        choose(dev.deviceId);
      } else {
        // Chrome names the outputs once the page may use the microphone (nothing is recorded).
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of stream.getTracks()) t.stop();
        const list = await listOutputs();
        setDevices(list);
        if (!list.some((d) => d.named)) setNote('No other sound output found — plug in the headphones and try again.');
      }
    } catch (e) {
      setNote(!picker && e?.name === 'NotFoundError'
        ? 'The browser only lists sound outputs to pages that may use a microphone, and this computer has none. Make the headphones the default output in the system’s sound settings instead.'
        : 'The browser didn’t allow it. You can allow it with the icon next to the address.');
    }
    setAsking(false);
  };
  return html`<div class="preview-output">
    ${st.error && html`<p class="warn-text">${st.error}</p>`}
    ${canChoose && devices.some((d) => d.named)
      ? html`<label class="field"><span>Preview plays on</span>
          <select class="select" value=${sink} onChange=${(e) => choose(e.currentTarget.value)}>
            <option value="">This computer’s default output</option>
            ${devices.map((d) => html`<option value=${d.id}>${d.label}</option>`)}
            ${sink && !devices.some((d) => d.id === sink) && html`<option value=${sink}>Your headphones (not connected)</option>`}
          </select></label>`
      : html`<p class="hint">Previews play on this computer’s default sound output — use headphones if that is also the party speaker.
          ${canChoose && html` <button class="link" disabled=${asking} onClick=${ask}>Choose headphones…</button>`}</p>`}
    ${note && html`<p class="hint">${note}</p>`}
  </div>`;
}
