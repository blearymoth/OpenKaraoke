// The mic latency test page (/mictest): measures the real round trip from the speakers back into
// the microphone (shared/latency.js finds the click), lets the owner hear the mic through the
// speakers with simple effects and an adjustable extra delay, and lists what the browser
// reports about its own buffers. Standalone: no server connection, nothing is saved but the
// chosen devices (this browser only).
import { followAppearance } from '/js/lib/theme.js';
import { makeClick, findArrival, summarize, verdict, PRE_ROLL_SECONDS, LISTEN_SECONDS } from '/shared/latency.js';

const CLICKS = 6;
const $ = (id) => document.getElementById(id);
const ms = (seconds) => (Number.isFinite(seconds) ? `${(seconds * 1000).toFixed(1)} ms` : '–');
const sleep = (t) => new Promise((r) => setTimeout(r, t));

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('ok.mictest') || '{}') || {}; } catch { return {}; }
})();
const savePrefs = () => {
  try { localStorage.setItem('ok.mictest', JSON.stringify(prefs)); } catch { /* private window */ }
};

/** Everything that exists while the microphone is open. */
let audio = null;
let builtFor = '';
let listening = false;
let measuring = false;
let lastResult = null;
let fx = 'dry';

const supportsSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
if (!supportsSink) $('speaker-field').hidden = true;
$('buffer').value = ['0', 'interactive', 'balanced'].includes(prefs.buffer) ? prefs.buffer : 'interactive';

function showError(text) {
  $('setup-error').textContent = text || '';
  $('setup-error').hidden = !text;
}

function explain(e) {
  if (!window.isSecureContext) return 'The browser only allows the microphone on a secure page: open this page on the party PC as http://localhost:… (or in the OpenKaraoke desktop app).';
  switch (e?.name) {
    case 'NotAllowedError': return 'The microphone is blocked for this page. Allow it in the browser (the icon at the left of the address bar) and try again.';
    case 'NotFoundError': return 'No microphone was found. Plug one in (or pick another one) and try again.';
    case 'NotReadableError': return 'The microphone is busy or unavailable. Close other apps that use it and try again.';
    case 'NotSupportedError': return 'This browser cannot record audio here.';
    default: return `Could not start the audio: ${e?.message || e}`;
  }
}

const settingsKey = () => [$('mic').value, supportsSink ? $('speaker').value : '', $('buffer').value].join('|');

/** A short, dense stereo reverb tail made from decaying noise (no sample files needed). */
function reverbImpulse(ctx, seconds = 1.6) {
  const len = Math.round(seconds * ctx.sampleRate);
  const pre = Math.round(0.012 * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = pre; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-3.5 * (i - pre)) / ctx.sampleRate) * 0.5;
  }
  return buf;
}

async function openMic(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mediaDevices'), { name: 'NotSupportedError' });
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...base, echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0.003 }, channelCount: { ideal: 1 } },
    });
  } catch (e) {
    if (e?.name !== 'OverconstrainedError') throw e;
    return navigator.mediaDevices.getUserMedia({ audio: deviceId ? base : true });
  }
}

function teardown() {
  if (!audio) return;
  cancelAnimationFrame(audio.raf);
  for (const t of audio.stream.getTracks()) t.stop();
  audio.ctx.close().catch(() => {});
  audio = null;
  builtFor = '';
}

/** Opens the mic and builds the graph for the chosen devices; reuses it when nothing changed. */
async function ensureAudio() {
  const key = settingsKey();
  if (audio && key === builtFor && audio.ctx.state !== 'closed') {
    if (audio.ctx.state !== 'running') await audio.ctx.resume().catch(() => {});
    return audio;
  }
  teardown();
  showError('');
  const stream = await openMic($('mic').value);
  const bufferPref = $('buffer').value;
  let ctx;
  try {
    ctx = new AudioContext({ latencyHint: bufferPref === '0' ? 0 : bufferPref });
    if (supportsSink && $('speaker').value) await ctx.setSinkId($('speaker').value);
    if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), sleep(1500)]);
    if (ctx.state !== 'running') throw new Error('The browser did not start the audio. Click the page once and try again.');
    await ctx.audioWorklet.addModule('/js/mictest/recorder-worklet.js');
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    ctx?.close().catch(() => {});
    throw e;
  }

  const source = ctx.createMediaStreamSource(stream);
  // the recorder (always connected so the worklet keeps running; it outputs silence)
  const recorder = new AudioWorkletNode(ctx, 'ok-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(recorder).connect(mute).connect(ctx.destination);

  // the monitor: mic → volume → extra delay → dry + reverb/echo sends → out (0 while not listening)
  const volume = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const extra = ctx.createDelay(0.5);
  const dry = ctx.createGain();
  const out = ctx.createGain();
  out.gain.value = 0;
  source.connect(volume);
  source.connect(analyser);
  volume.connect(extra).connect(dry).connect(out).connect(ctx.destination);
  const reverbSend = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.buffer = reverbImpulse(ctx);
  extra.connect(reverbSend).connect(convolver).connect(out);
  const echoSend = ctx.createGain();
  const echo = ctx.createDelay(1);
  echo.delayTime.value = 0.32;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.38;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3200;
  extra.connect(echoSend).connect(echo).connect(tone);
  tone.connect(feedback).connect(echo);
  tone.connect(out);

  audio = { ctx, stream, source, recorder, volume, analyser, extra, out, reverbSend, echoSend, jobs: new Map(), nextJob: 1, raf: 0 };
  recorder.port.onmessage = (e) => {
    const job = audio?.jobs.get(e.data.id);
    if (job) { audio.jobs.delete(e.data.id); job(e.data.samples); }
  };
  builtFor = key;
  applyControls();
  meterLoop();
  await listDevices();
  renderFacts();
  return audio;
}

async function listDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const fill = (select, kind, fallback, saved) => {
    const current = select.value || saved || '';
    const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    select.replaceChildren(new Option(fallback, ''), ...list.map((d, i) => new Option(d.label || `${fallback.split(' ')[1]} ${i + 1}`, d.deviceId)));
    select.value = list.some((d) => d.deviceId === current) ? current : '';
  };
  fill($('mic'), 'audioinput', 'Default microphone', prefs.mic);
  if (supportsSink) fill($('speaker'), 'audiooutput', 'Default output', prefs.speaker);
}

function applyControls() {
  const volume = Number($('volume').value) / 100;
  const delay = Number($('delay').value) / 1000;
  $('volume-out').textContent = `${$('volume').value} %`;
  $('delay-out').textContent = `${$('delay').value} ms`;
  if (!audio) return;
  const t = audio.ctx.currentTime;
  audio.volume.gain.setTargetAtTime(volume, t, 0.02);
  audio.extra.delayTime.setTargetAtTime(delay, t, 0.02);
  audio.reverbSend.gain.setTargetAtTime(fx === 'reverb' ? 0.45 : 0, t, 0.03);
  audio.echoSend.gain.setTargetAtTime(fx === 'echo' ? 0.5 : 0, t, 0.03);
  audio.out.gain.setTargetAtTime(listening && !measuring ? 1 : 0, t, 0.015);
}

function meterLoop() {
  const data = new Float32Array(audio.analyser.fftSize);
  const tick = () => {
    if (!audio) return;
    audio.analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    const db = 20 * Math.log10(Math.max(peak, 1e-6));
    const fill = $('meter');
    fill.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100)).toFixed(1)}%`;
    fill.classList.toggle('clip', db > -1);
    audio.raf = requestAnimationFrame(tick);
  };
  audio.raf = requestAnimationFrame(tick);
}

/** Records the mic for the context frames [from, from + frames). */
function record(from, frames) {
  return new Promise((resolve) => {
    const id = audio.nextJob++;
    audio.jobs.set(id, resolve);
    audio.recorder.port.postMessage({ id, from, frames });
  });
}

async function measure() {
  if (measuring) return;
  measuring = true;
  setBusy(true);
  const progress = $('measure-progress');
  try {
    await ensureAudio();
    applyControls(); // the speakers stay quiet except for the clicks
    const { ctx } = audio;
    const sr = ctx.sampleRate;
    const clickData = makeClick(sr);
    const click = ctx.createBuffer(1, clickData.length, sr);
    click.copyToChannel(clickData, 0);
    const pre = Math.round(PRE_ROLL_SECONDS * sr);
    const frames = pre + Math.round(LISTEN_SECONDS * sr);
    const results = [];
    for (let i = 0; i < CLICKS; i++) {
      progress.textContent = `Click ${i + 1} of ${CLICKS}…`;
      const at = Math.round((ctx.currentTime + 0.3) * sr);
      const recording = record(at - pre, frames);
      const node = new AudioBufferSourceNode(ctx, { buffer: click });
      node.connect(ctx.destination);
      node.start(at / sr);
      const samples = await recording;
      results.push(findArrival(samples, pre, sr));
      await sleep(150);
    }
    const sum = summarize(results.map((r) => r.ms));
    lastResult = { ...sum, clicks: results, at: new Date().toISOString() };
    showResult(lastResult);
    progress.textContent = '';
  } catch (e) {
    progress.textContent = '';
    showError(explain(e));
  } finally {
    measuring = false;
    setBusy(false);
    applyControls();
    renderFacts();
  }
}

function showResult(r) {
  const v = verdict(r.median);
  const box = $('result');
  box.hidden = false;
  box.dataset.level = v.level;
  $('result-ms').textContent = r.median == null ? '–' : Math.round(r.median);
  const strong = document.createElement('strong');
  strong.textContent = v.title;
  $('verdict').replaceChildren(strong, document.createTextNode(v.text));
  const each = r.clicks.map((c) => (c.ms == null ? 'not heard' : `${c.ms.toFixed(1)}`)).join(' · ');
  let detail = `Each click (ms): ${each}.`;
  if (r.heard === 0) detail = 'None of the clicks were heard. Turn the speakers up, bring the mic closer to a speaker, check the mic is the one selected above, and try again.';
  else if (r.heard < r.total) detail += ' Some clicks were not heard: a louder speaker or a closer mic gives a steadier result.';
  if (r.heard > 1 && r.spread > 8) detail += ` The results vary by ${r.spread.toFixed(0)} ms, which usually means noise or an unstable connection (Bluetooth): measure again in a quieter moment.`;
  $('result-detail').textContent = detail;
}

function setBusy(busy) {
  $('measure-btn').disabled = busy;
  $('listen-btn').disabled = busy;
  for (const id of ['mic', 'speaker', 'buffer']) $(id).disabled = busy;
}

async function toggleListen() {
  if (listening) {
    listening = false;
    applyControls();
    $('listen-btn').textContent = 'Start listening';
    $('listen-btn').classList.add('primary');
    return;
  }
  try {
    await ensureAudio();
    listening = true;
    applyControls();
    $('listen-btn').textContent = 'Stop listening';
    $('listen-btn').classList.remove('primary');
  } catch (e) {
    showError(explain(e));
  }
  renderFacts();
}

function facts() {
  const rows = [];
  const track = audio?.stream.getAudioTracks()[0];
  const s = track?.getSettings?.() || {};
  const ctx = audio?.ctx;
  const ua = /(?:Chrome|Chromium|Firefox|Edg|Electron)\/[\d.]+/g;
  rows.push(['Browser', (navigator.userAgent.match(ua) || [navigator.userAgent]).join(', ')]);
  rows.push(['Microphone', track?.label || '–']);
  if (supportsSink) rows.push(['Speakers', $('speaker').selectedOptions[0]?.textContent || 'Default output']);
  rows.push(['Audio buffer setting', $('buffer').selectedOptions[0]?.textContent || '–']);
  rows.push(['Sample rate', ctx ? `${ctx.sampleRate} Hz` : '–']);
  rows.push(['Input latency (mic)', Number.isFinite(s.latency) ? ms(s.latency) : '–']);
  rows.push(['Processing buffer (baseLatency)', ctx ? ms(ctx.baseLatency) : '–']);
  rows.push(['Output latency (outputLatency)', ctx && 'outputLatency' in ctx ? ms(ctx.outputLatency) : '–']);
  const est = ctx ? (Number.isFinite(s.latency) ? s.latency : 0) + (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : NaN;
  rows.push(['Browser estimate, total', ctx ? ms(est) : '–']);
  rows.push(['Voice processing', track ? ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => s[k]).join(', ') || 'off' : '–']);
  rows.push(['Measured round trip', lastResult?.median != null ? `${lastResult.median.toFixed(1)} ms (${lastResult.heard}/${lastResult.total} clicks, spread ${lastResult.spread.toFixed(1)} ms)` : lastResult ? 'not heard' : 'not measured yet']);
  return rows;
}

function renderFacts() {
  const dl = $('facts');
  dl.replaceChildren(...facts().flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

async function copyResults() {
  const text = ['OpenKaraoke mic latency test', ...facts().map(([k, v]) => `${k}: ${v}`)];
  if (lastResult) text.push(`Clicks (ms): ${lastResult.clicks.map((c) => (c.ms == null ? 'not heard' : c.ms.toFixed(1))).join(', ')}`);
  try {
    await navigator.clipboard.writeText(text.join('\n'));
    $('copy-done').textContent = 'Copied.';
  } catch {
    $('copy-done').textContent = 'Could not copy; select the text above instead.';
  }
  setTimeout(() => { $('copy-done').textContent = ''; }, 3000);
}

// ---- wiring ------------------------------------------------------------------------------------
$('measure-btn').addEventListener('click', measure);
$('listen-btn').addEventListener('click', toggleListen);
$('copy-btn').addEventListener('click', copyResults);
$('volume').addEventListener('input', applyControls);
$('delay').addEventListener('input', applyControls);
for (const chip of document.querySelectorAll('[data-fx]')) {
  chip.addEventListener('click', () => {
    fx = chip.dataset.fx;
    for (const c of document.querySelectorAll('[data-fx]')) {
      c.classList.toggle('on', c === chip);
      c.setAttribute('aria-checked', String(c === chip));
    }
    applyControls();
  });
}
for (const id of ['mic', 'speaker', 'buffer']) {
  $(id).addEventListener('change', async () => {
    prefs[id] = $(id).value;
    savePrefs();
    if (!audio) { renderFacts(); return; }
    const wasListening = listening;
    listening = false;
    teardown();
    try {
      await ensureAudio();
      listening = wasListening;
      applyControls();
    } catch (e) {
      showError(explain(e));
      $('listen-btn').textContent = 'Start listening';
      $('listen-btn').classList.add('primary');
    }
    renderFacts();
  });
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (audio) listDevices(); });
window.addEventListener('pagehide', teardown);

// Device names are only visible once the mic is allowed; if it already is, show them now.
navigator.permissions?.query({ name: 'microphone' }).then((p) => { if (p.state === 'granted') listDevices(); }).catch(() => {});
if (!window.isSecureContext) showError(explain());
applyControls();
renderFacts();
setInterval(() => { if (audio) renderFacts(); }, 2000); // outputLatency settles after the first sound
followAppearance();
