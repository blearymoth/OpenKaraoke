// Applause meter (PLAN §13.6): the main TV listens with the party PC's microphone for 5 s
// (getUserMedia + AnalyserNode; the TV page on localhost is a secure context), reports the
// level ~5×/s and a final 0–100 score (shared/applause.js); a big gauge shows the result and a
// list compares several singers.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Countdown, ensureCss, useSecondsLeft } from './common.js';
import { levelFromRms, rmsOf, scoreLevels, LEVEL_INTERVAL_MS } from '/shared/applause.js';

ensureCss('/css/games/applause.css');

export const icon = '👏';
export const blurb = 'The TV computer’s microphone measures the cheering.';

const busyPhase = (phase) => phase === 'countdown' || phase === 'measure';

// ---- measuring (main TV only) -----------------------------------------------------------

function micMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError': return 'The browser blocked the microphone.';
    case 'NotFoundError':
    case 'OverconstrainedError': return 'No microphone was found on the TV computer.';
    case 'NotReadableError': return 'The microphone is busy or switched off.';
    case 'NotSupportedError': return 'This browser can’t use a microphone here (it needs localhost or https).';
    default: return String(e?.message || 'The microphone is not available.').slice(0, 150);
  }
}

/** Opens the microphone (no echo cancelling / noise suppression / auto gain: we want the real level). */
async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mediaDevices'), { name: 'NotSupportedError' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    if (e?.name !== 'OverconstrainedError') throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  const ctx = new AudioContext();
  if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  if (ctx.state !== 'running') {
    for (const t of stream.getTracks()) t.stop();
    ctx.close().catch(() => {});
    throw new Error('Click the TV screen once so it can listen (browser audio rules).');
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return { stream, ctx, analyser, buf: new Float32Array(analyser.fftSize) };
}

function closeMic(mic) {
  if (!mic) return;
  for (const t of mic.stream.getTracks()) t.stop();
  mic.ctx.close().catch(() => {});
}

/**
 * On the main TV: opens the mic during the countdown, measures during 'measure' (until the
 * server's endsAt), reports levels ~5×/s and the final score, then releases the mic.
 * `onLevel` gets the instant level (~20×/s) for the local gauge.
 */
function useMeasurement(game, tv, now, onLevel) {
  const micRef = useRef(null);
  const round = game.round;
  const active = !!tv?.main && !game.ended && busyPhase(game.phase);
  useEffect(() => {
    if (!active) return undefined;
    const p = openMic();
    micRef.current = p;
    p.catch((e) => tv.send({ event: 'error', round, message: micMessage(e) }));
    return () => {
      if (micRef.current === p) micRef.current = null;
      p.then(closeMic, () => {});
    };
  }, [active, round]);
  const measuring = active && game.phase === 'measure';
  useEffect(() => {
    const p = micRef.current;
    if (!measuring || !p) return undefined;
    let stopped = false;
    let timer = 0;
    const endsAt = game.endsAt;
    p.then((mic) => {
      const levels = [];
      let energy = 0;
      let blocks = 0;
      let last = performance.now();
      const step = () => {
        if (stopped) return;
        mic.analyser.getFloatTimeDomainData(mic.buf);
        const rms = rmsOf(mic.buf);
        energy += rms * rms;
        blocks++;
        onLevel(levelFromRms(rms));
        const t = performance.now();
        const done = now() >= endsAt;
        if (t - last >= LEVEL_INTERVAL_MS || done) {
          const level = Math.round(levelFromRms(Math.sqrt(energy / blocks)) * 10) / 10;
          energy = 0;
          blocks = 0;
          last = t;
          levels.push(level);
          tv.send({ event: 'level', round, level });
        }
        if (done) {
          stopped = true;
          tv.send({ event: 'result', round, score: scoreLevels(levels) });
          return;
        }
        timer = setTimeout(step, 50);
      };
      step();
    }, () => {});
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [measuring, round]);
}

/** Eases a number towards `target` (ease-out, `ms`). */
function useAnimated(target, ms = 1600) {
  const [v, setV] = useState(0);
  const cur = useRef(0);
  useEffect(() => {
    const from = cur.current;
    const start = performance.now();
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - start) / ms);
      const x = from + (target - from) * (1 - (1 - k) ** 3);
      cur.current = x;
      setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

// ---- pieces -------------------------------------------------------------------------------

/** Semicircle meter 0–100 with a needle. */
function Gauge({ value, live }) {
  const v = Math.max(0, Math.min(100, value || 0));
  const ticks = [0, 25, 50, 75, 100];
  return html`<div class=${`ap-gauge ${live ? 'live' : ''}`} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(v)}>
    <svg viewBox="0 0 200 116" aria-hidden="true">
      <defs><linearGradient id="ap-grad" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" style="stop-color: var(--meter-lo)" /><stop offset="0.55" style="stop-color: var(--meter-mid)" /><stop offset="1" style="stop-color: var(--meter-hi)" />
      </linearGradient></defs>
      <path class="track" d="M 20 100 A 80 80 0 0 1 180 100" />
      <path class="fill" d="M 20 100 A 80 80 0 0 1 180 100" pathLength="100" stroke-dasharray="100 200" stroke-dashoffset=${100 - v} />
      ${ticks.map((t) => {
        const a = Math.PI * (1 - t / 100);
        return html`<line class="tick" x1=${100 + 64 * Math.cos(a)} y1=${100 - 64 * Math.sin(a)} x2=${100 + 56 * Math.cos(a)} y2=${100 - 56 * Math.sin(a)} />`;
      })}
      <g class="needle" style=${{ transform: `rotate(${-90 + v * 1.8}deg)` }}>
        <line x1="100" y1="104" x2="100" y2="34" /><circle cx="100" cy="100" r="7" />
      </g>
    </svg>
    <b class="value num">${Math.round(v)}</b>
  </div>`;
}

/** Holds peaks a little so a level that arrives ~5×/s doesn't flicker (phones, host). */
function useDecay(value) {
  const [v, setV] = useState(0);
  useEffect(() => { setV((prev) => Math.max(value || 0, prev * 0.7)); }, [value]);
  return value ? v : 0;
}

function LevelBar({ value }) {
  const v = Math.max(0, Math.min(100, useDecay(value)));
  return html`<div class="ap-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(v)}><i style=${{ width: `${v}%` }}></i></div>`;
}

function Results({ game, act, max = 30 }) {
  const rows = game.results.slice(-max);
  if (!rows.length) return null;
  return html`<ol class="ap-list">${rows.map((r) => html`<li key=${r.id} class=${`${r.best ? 'best' : ''} ${r.id === game.lastId ? 'last' : ''}`}>
    <span class="label ellipsis">${r.best ? '🏆 ' : ''}${r.label}</span>
    <span class="ap-bar"><i style=${{ width: `${r.score}%` }}></i></span>
    <b class="num">${r.score}</b>
    ${act && !game.ended && html`<button type="button" class="icon-btn small" aria-label=${`Remove ${r.label}`} title="Remove" disabled=${busyPhase(game.phase)} onClick=${() => act('game.action', { action: 'remove', id: r.id })}>✕</button>`}
  </li>`)}</ol>`;
}

const lastResult = (game) => game.results.find((r) => r.id === game.lastId) || null;

// ---- host -------------------------------------------------------------------------------------

export function Setup({ onStart, busy }) {
  const [label, setLabel] = useState('');
  const start = () => onStart({ label: label.trim() });
  return html`<div class="g-setup applause-setup">
    <label class="field"><span>Who is the applause for? (optional)</span>
      <input class="input" value=${label} maxlength="40" placeholder="e.g. Ann" onInput=${(e) => setLabel(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } }} />
    </label>
    <p class="hint">The TV computer listens with its microphone for 5 seconds after a 3-second countdown. Measure several singers one after the other to compare them. Chrome asks once for the microphone on the TV page (bin/open-tv.sh allows it automatically).</p>
    <button class="btn primary" disabled=${busy} onClick=${start}>Start measuring</button>
  </div>`;
}

export function Control({ game, act }) {
  const [label, setLabel] = useState('');
  const busy = busyPhase(game.phase);
  const last = lastResult(game);
  const measure = () => {
    act('game.action', { action: 'measure', label: label.trim() });
    setLabel('');
  };
  return html`<div class="g-control applause-control">
    ${busy && html`<div class="ap-live">
      <b>${game.phase === 'countdown' ? 'Get ready…' : 'Measuring…'}${game.label ? ` (${game.label})` : ''}</b>
      <${LevelBar} value=${game.level} />
      <button class="btn small" onClick=${() => act('game.action', { action: 'cancel' })}>Cancel</button>
    </div>`}
    ${game.micError && html`<div class="ap-error"><p class="warn-text">${game.micError}</p>${game.micHint && html`<p class="hint">${game.micHint}</p>`}</div>`}
    ${last && !busy && html`<p class="ap-last">${last.label}: <b class="num">${last.score}</b>${last.estimated ? html` <span class="hint">(from the live levels)</span>` : ''}</p>`}
    ${!busy && !game.ended && html`<div class="inline-form ap-next">
      <input class="input" value=${label} maxlength="40" placeholder="Next: who is it for? (optional)" aria-label="Who is the next measurement for"
        onInput=${(e) => setLabel(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); measure(); } }} />
      <button class="btn primary" onClick=${measure}>Next measurement</button>
      ${last && html`<button class="btn" onClick=${() => act('game.action', { action: 'again' })}>Measure ${last.label} again</button>`}
    </div>`}
    <${Results} game=${game} act=${act} />
  </div>`;
}

// ---- TV ----------------------------------------------------------------------------------------

/** 3 · 2 · 1 over the gauge, popping in every second. */
function BigCount({ endsAt, now }) {
  const left = Math.max(1, useSecondsLeft(endsAt, now));
  return html`<div class="ap-count" aria-live="polite"><b class="display" key=${left}>${left}</b></div>`;
}

export function Tv({ game, now, tv }) {
  const [live, setLive] = useState(0);
  useMeasurement(game, tv, now, (l) => setLive((prev) => Math.max(l, prev - 3)));
  const last = lastResult(game);
  const result = game.phase === 'result' || (game.phase === 'done' && last);
  const shown = useAnimated(result && last ? last.score : 0, result ? 1800 : 150);
  const measuring = game.phase === 'measure';
  // The main TV shows its own mic level; other screens follow the server's ~5 Hz level.
  const value = measuring ? (tv?.main ? live : game.level) : result ? shown : 0;
  let title = 'Applause meter';
  if (game.phase === 'countdown') title = 'Get ready to cheer…';
  else if (measuring) title = 'Make some noise! 👏';
  else if (result && last) title = `Applause${last.label && !/^Measurement \d+$/.test(last.label) ? ` for ${last.label}` : ''}`;
  else if (game.phase === 'done') title = 'Thanks for cheering!';
  const best = game.results.filter((r) => r.best);
  return html`<div class="scene g-tv applause fade-in">
    <header class="g-tv-head">
      <div><div class="kicker">Applause meter${game.label && busyPhase(game.phase) ? ` · for ${game.label}` : ''}</div><h1 class="display">${title}</h1></div>
      ${busyPhase(game.phase) && html`<${Countdown} endsAt=${game.endsAt} total=${game.phase === 'countdown' ? game.countdown : game.seconds} now=${now} />`}
    </header>
    <div class=${`ap-main ${game.results.length ? 'with-list' : ''}`}>
      <div class=${`ap-stage p-${game.phase}`}>
        <${Gauge} value=${value} live=${measuring} />
        ${game.phase === 'countdown' && html`<${BigCount} endsAt=${game.endsAt} now=${now} />`}
        ${game.micError && !busyPhase(game.phase) && html`<div class="ap-tv-error"><b>🎙️ The microphone isn’t working</b><span>${game.micError}</span></div>`}
        ${result && last && last.best && game.results.length > 1 && html`<div class="ap-record">🏆 Loudest so far!</div>`}
      </div>
      ${game.results.length > 0 && html`<${Results} game=${game} max=${8} />`}
    </div>
    <p class="g-tv-foot">${busyPhase(game.phase) ? 'Clap, cheer, stomp — the TV computer is listening!'
      : game.phase === 'done' && best.length ? `Loudest: ${best.map((r) => r.label).join(' & ')}`
        : 'The host starts the next measurement.'}</p>
  </div>`;
}

// ---- phones -------------------------------------------------------------------------------------

export function Guest({ game, now }) {
  const last = lastResult(game);
  let head = 'Applause meter';
  if (game.phase === 'countdown') head = 'Get ready to cheer!';
  else if (game.phase === 'measure') head = 'Make some noise! 👏';
  else if (game.phase === 'result' && last) head = /^Measurement \d+$/.test(last.label) ? last.label : `Applause for ${last.label}`;
  else if (game.phase === 'done') head = 'The applause meter is over';
  return html`<div class="g-guest applause">
    <h1 class="g-h1">${head}</h1>
    ${game.label && busyPhase(game.phase) && html`<p class="muted">For ${game.label}</p>`}
    ${busyPhase(game.phase) && html`<${Countdown} endsAt=${game.endsAt} total=${game.phase === 'countdown' ? game.countdown : game.seconds} now=${now} />`}
    ${game.phase === 'measure' && html`<${LevelBar} value=${game.level} />`}
    ${game.phase === 'result' && last && html`<div class="ap-score num">${last.score}<small>/100</small></div>`}
    ${game.micError && html`<p class="warn-text">${game.micError}</p>`}
    <p class="hint">${busyPhase(game.phase) ? 'Clap and cheer — the TV computer’s microphone measures the room.' : game.phase === 'ready' ? 'Waiting for the host…' : 'Scores go from 0 to 100.'}</p>
    <${Results} game=${game} />
  </div>`;
}
