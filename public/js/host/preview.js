// Preview a version on the host computer (PLAN §10): plays the backing track in this
// browser, optionally on another audio output (headphones) so the party doesn't hear it.
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { createStore, useStore } from '../lib/store.js';

const SINK_KEY = 'ok.previewSink';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
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
 * The TV page never chooses an output: on this computer it plays on the system's default one,
 * so the advice here never says to change that (it would move the party's sound too).
 */
export function PreviewOutput({ displays = [] }) {
  const canChoose = !!(audio?.setSinkId && window.isSecureContext && navigator.mediaDevices?.enumerateDevices);
  const [devices, setDevices] = useState([]);
  const [sink, setSink] = useState(storedSink);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const st = useStore(previewStore);
  const [inUse, setInUse] = useState(audio?.sinkId || '');
  // The host page and the TV that plays the party's sound run on this same computer.
  const tvHere = typeof location !== 'undefined' && LOOPBACK.has(location.hostname) && displays.some((d) => d.local && d.display === 'main');
  const refresh = () => listOutputs().then((list) => {
    setDevices(list);
    if (list.some((d) => d.named)) setNote('');
  }).catch(() => {});
  useEffect(() => {
    if (!canChoose) return undefined;
    // Outputs, and the output previews will really use (the headphones chosen before may not
    // be allowed yet): again when devices change, when the microphone is allowed in the site
    // settings (the way to name outputs on a computer without one) and when the page is back.
    const recheck = () => {
      refresh();
      applySink().then(() => setInUse(audio.sinkId || ''));
    };
    recheck();
    let perm = null;
    let gone = false;
    navigator.permissions?.query({ name: 'microphone' }).then((p) => {
      if (gone) return;
      perm = p;
      p.addEventListener('change', recheck);
    }).catch(() => {});
    navigator.mediaDevices.addEventListener?.('devicechange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      gone = true;
      perm?.removeEventListener('change', recheck);
      navigator.mediaDevices.removeEventListener?.('devicechange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, []);
  useEffect(() => () => stopPreview(), []);
  const choose = (id) => {
    setSink(id);
    try {
      if (id) localStorage.setItem(SINK_KEY, id);
      else localStorage.removeItem(SINK_KEY);
    } catch { /* private mode: this page only */ }
    applySink().then(() => setInUse(audio.sinkId || ''));
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
        ? `This computer has no microphone, and the browser only names sound outputs to pages allowed to use one. To allow it (nothing is recorded): click the icon left of the address → Site settings → Microphone: Allow. The outputs then appear here. A headset with a microphone works too.${tvHere ? ' Don’t change the system’s default output instead: the TV plays on it.' : ''}`
        : 'The browser didn’t allow it. You can allow it with the icon next to the address.');
    }
    setAsking(false);
  };
  const named = devices.some((d) => d.named);
  return html`<div class="preview-output">
    ${st.error && html`<p class="warn-text">${st.error}</p>`}
    ${canChoose && (named || inUse)
      ? html`<label class="field"><span>Preview plays on</span>
          <select class="select" value=${sink} onChange=${(e) => choose(e.currentTarget.value)}>
            <option value="">${tvHere ? 'This computer’s default output (the TV’s)' : 'This computer’s default output'}</option>
            ${devices.map((d) => html`<option value=${d.id}>${d.label}</option>`)}
            ${sink && !devices.some((d) => d.id === sink) && html`<option value=${sink}>${inUse === sink ? 'The headphones chosen before' : 'Your headphones (not connected)'}</option>`}
          </select></label>`
      : html`<p class="hint">${tvHere
          ? 'Previews play on this computer’s default sound output, like the TV, so the party hears them.'
          : 'Previews play on this computer’s default sound output — use headphones if that is also the party speaker.'}
          ${canChoose && html` <button class="link" disabled=${asking} onClick=${ask}>Choose headphones…</button>`}</p>`}
    ${note && html`<p class="hint">${note}</p>`}
  </div>`;
}
