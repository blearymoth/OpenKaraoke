// Pitch rings (PLAN §13.9): the main TV listens with the party computer's microphone and
// draws the playfield. The singer's pitch moves a ball; rings scroll in. Phones follow the
// score and do not open a microphone. No reference tone — the ring's height is the target.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Countdown, ensureCss } from './common.js';
import { token } from '../lib/theme.js';
import { detectPitch, pitchHeight, HOLE_CENTS, HZ_INTERVAL_MS } from '/shared/pitch.js';

ensureCss('/css/games/pitch.css');

export const icon = '⭕';
export const blurb = 'Sing to fly a ball through the rings. The TV computer listens.';

const BALL_X = 0.18;
/** The mic is released at the latest this long after the run (the server has already moved on). */
const MIC_SPARE_MS = 2500;

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

/** Opens the microphone (no echo cancelling / noise suppression / auto gain: we want the real pitch). */
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
  analyser.fftSize = 4096;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return { stream, ctx, analyser, buf: new Float32Array(analyser.fftSize) };
}

function closeMic(mic) {
  if (!mic) return;
  for (const t of mic.stream.getTracks()) t.stop();
  mic.ctx.close().catch(() => {});
}

/**
 * On the main TV, during `fly` only: open the mic, report hz ~10×/s, and hand the latest
 * height (or null when there is no pitch) to the playfield. The mic is released when the
 * run ends, the link drops, or this effect cleans up.
 */
function useFly(game, tv, now, onHeight) {
  const micRef = useRef(null);
  const round = game.round;
  const active = !!tv?.main && tv.open !== false && !game.ended && game.phase === 'fly';
  useEffect(() => {
    if (!active) return undefined;
    const p = openMic();
    micRef.current = p;
    p.catch((e) => tv.send({ event: 'error', round, message: micMessage(e) }));
    const release = () => p.then(closeMic, () => {});
    const cap = setTimeout(release, Math.max(0, (game.endsAt || 0) - now()) + MIC_SPARE_MS);
    return () => {
      clearTimeout(cap);
      if (micRef.current === p) micRef.current = null;
      release();
    };
  }, [active, round]);
  useEffect(() => {
    const p = micRef.current;
    if (!active || !p) return undefined;
    let stopped = false;
    let timer = 0;
    const lowHz = game.lowHz;
    const endsAt = game.endsAt;
    p.then((mic) => {
      if (stopped) return;
      let lastSend = 0;
      const step = () => {
        if (stopped) return;
        mic.analyser.getFloatTimeDomainData(mic.buf);
        const det = detectPitch(mic.buf, mic.ctx.sampleRate);
        const hz = det.hz > 0 ? det.hz : 0;
        onHeight(hz > 0 ? pitchHeight(hz, lowHz) : null);
        const t = performance.now();
        if (t - lastSend >= HZ_INTERVAL_MS) {
          lastSend = t;
          tv.send({ event: 'pitch', round, hz: hz > 0 ? hz : null });
        }
        if (now() >= endsAt) {
          stopped = true;
          closeMic(mic);
          return;
        }
        timer = setTimeout(step, 40);
      };
      step();
    }, () => {});
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, round]);
}

function paint(name, fallback) {
  return token(name) || fallback;
}

/** The playfield. Rings move by their arrival time; the ball's height is the live pitch. */
function Playfield({ game, now, liveRef, main }) {
  const ref = useRef(null);
  const gameRef = useRef(game);
  gameRef.current = game;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let raf = 0;
    let shown = 0;
    let hold = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const g = gameRef.current;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW < 2 || cssH < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pxW = Math.floor(cssW * dpr);
      const pxH = Math.floor(cssH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ink = paint('--ink', '#fff');
      const ink2 = paint('--ink-2', '#ccc');
      const neon = paint('--neon', '#fff');
      const ok = paint('--ok', '#fff');
      const bad = paint('--bad', '#fff');
      const stage = paint('--stage', '#000');
      const bulb = paint('--bulb', '#fff');
      ctx.fillStyle = stage;
      ctx.fillRect(0, 0, cssW, cssH);
      const pad = cssH * 0.1;
      const inner = cssH - pad * 2;
      const yOf = (height) => pad + (1 - height) * inner;
      const travel = g.travel || 3600;
      const ballX = BALL_X * cssW;
      const t = now();
      // Lane the ball flies.
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = ink2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ballX, pad);
      ctx.lineTo(ballX, cssH - pad);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const hole = (HOLE_CENTS / 1200) * inner;
      const rings = g.rings || [];
      for (const ring of rings) {
        const dt = ring.arriveAt - t;
        const x = ballX + (dt / travel) * (cssW - ballX);
        if (x < -hole * 3 || x > cssW + hole * 3) continue;
        const y = yOf(ring.height);
        ctx.strokeStyle = !ring.scored ? neon : ring.cleared ? ok : bad;
        ctx.lineWidth = Math.max(10, hole * 0.7);
        ctx.beginPath();
        ctx.arc(x, y, hole + ctx.lineWidth * 0.45, 0, Math.PI * 2);
        ctx.stroke();
      }
      const live = liveRef.current;
      const frame = performance.now();
      if (main && typeof live === 'number') {
        shown += (live - shown) * 0.55;
        hold = frame;
      } else if (main) {
        if (frame - hold > 130) shown += (0 - shown) * 0.16;
      } else {
        shown = g.ball || 0;
      }
      const ballR = Math.max(16, hole * 0.62);
      const by = yOf(Math.max(0, Math.min(1, shown)));
      ctx.fillStyle = bulb;
      ctx.beginPath();
      ctx.arc(ballX, by, ballR, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = ink;
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [game.round, main]);
  return html`<canvas ref=${ref} class="pn-field" aria-label="Pitch rings playfield"></canvas>`;
}

function Board({ game }) {
  const rows = game.results || [];
  if (!rows.length) return null;
  return html`<ol class="pn-list">${rows.map((r) => html`<li key=${r.id} class=${`${r.best ? 'best' : ''} ${r.id === game.lastId ? 'last' : ''}`}>
    <span class="label ellipsis">${r.best ? '🏆 ' : ''}${r.label}</span>
    <b class="num">${r.score}<small>/${r.total}</small></b>
  </li>`)}</ol>`;
}

const lastResult = (game) => (game.results || []).find((r) => r.id === game.lastId) || null;

function flashWord(flash) {
  return flash === 'pass' ? 'Through!' : flash === 'miss' ? 'Miss' : '';
}

// ---- host -------------------------------------------------------------------------------------------

export function Setup({ onStart, busy }) {
  const [rings, setRings] = useState('10');
  const [range, setRange] = useState('mid');
  const start = () => onStart({ rings: Number(rings), range });
  const options = [];
  for (let n = 5; n <= 20; n++) options.push([String(n), String(n)]);
  return html`<div class="g-setup pitch-setup">
    <div class="row-2">
      <label class="field"><span>Rings per singer</span>
        <select class="select" value=${rings} onChange=${(e) => setRings(e.currentTarget.value)}>${options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
      </label>
      <label class="field"><span>Range</span>
        <select class="select" value=${range} onChange=${(e) => setRange(e.currentTarget.value)}>
          <option value="low">Low (G3–G4)</option>
          <option value="mid">Mid (C4–C5)</option>
          <option value="high">High (G4–G5)</option>
        </select>
      </label>
    </div>
    <p class="hint">The singer’s pitch moves a ball on the TV. Rings scroll in — sing through the hole. The party computer’s microphone listens; phones only watch. This does not grade a karaoke song.</p>
    <button class="btn primary" disabled=${busy} onClick=${start}>Start Pitch rings</button>
  </div>`;
}

export function Control({ game, act, now }) {
  const [label, setLabel] = useState('');
  const busy = game.phase === 'fly';
  const last = lastResult(game);
  const go = () => {
    act('game.action', { action: 'next', label: label.trim() });
    setLabel('');
  };
  return html`<div class="g-control pitch-control">
    ${busy && html`<div class="pn-live">
      <b>Ring ${game.index} of ${game.total}${game.label ? ` · ${game.label}` : ''}</b>
      <span class="pn-next">Next ring: ${game.note || '—'}</span>
      <span class="num">${game.cleared}/${game.total}</span>
      ${game.flash && html`<span class=${`pn-flash ${game.flash}`}>${flashWord(game.flash)}</span>`}
      <${Countdown} endsAt=${game.endsAt} total=${game.seconds || 1} now=${now} />
    </div>`}
    ${game.micError && html`<div class="pn-error"><p class="warn-text">${game.micError}</p>${game.micHint && html`<p class="hint">${game.micHint}</p>`}</div>`}
    ${last && !busy && html`<p class="pn-last">${last.label}: <b class="num">${last.score}<small>/${last.total}</small></b> rings</p>`}
    ${!busy && !game.ended && html`<div class="inline-form pn-next-row">
      <input class="input" value=${label} maxlength="40" placeholder="Who is singing? (optional)" aria-label="Who is singing"
        onInput=${(e) => setLabel(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
      <button class="btn primary" onClick=${go}>${last ? 'Next singer' : 'Start run'}</button>
      ${last && html`<button class="btn" onClick=${() => act('game.action', { action: 'again' })}>Let ${last.label} try again</button>`}
    </div>`}
    ${busy && game.upcoming?.length > 1 && html`<p class="hint pn-coming">Coming up: ${game.upcoming.slice(1, 6).join(', ')}</p>`}
    <${Board} game=${game} />
  </div>`;
}

// ---- TV ---------------------------------------------------------------------------------------------

export function Tv({ game, now, tv }) {
  const liveRef = useRef(null);
  useFly(game, tv, now, (h) => { liveRef.current = h; });
  const last = lastResult(game);
  const showFlash = game.phase === 'fly' && game.flash && now() - (game.flashAt || 0) < 700;
  let title = 'Pitch rings';
  if (game.phase === 'ready') title = 'Get ready to sing';
  else if (game.phase === 'fly') title = game.label ? game.label : 'Fly!';
  else if (game.phase === 'turn' && last) title = `${last.label} · ${last.score}/${last.total}`;
  else if (game.phase === 'done') title = 'That’s the game';
  const best = (game.results || []).filter((r) => r.best);
  return html`<div class="scene g-tv pitch fade-in">
    <header class="g-tv-head">
      <div>
        <div class="kicker">Pitch rings${game.phase === 'fly' && game.index ? ` · ring ${game.index} of ${game.total}` : ''}</div>
        <h1 class="display">${title}</h1>
      </div>
      ${game.phase === 'fly' && html`<div class="pn-count num" aria-label="Rings cleared">${game.cleared}<small>/${game.total}</small></div>`}
    </header>
    <div class="pn-stage">
      ${game.phase === 'fly' && html`<${Playfield} game=${game} now=${now} liveRef=${liveRef} main=${!!tv?.main} />`}
      ${showFlash && html`<div class=${`pn-fly-flash ${game.flash}`} aria-live="polite">${flashWord(game.flash)}</div>`}
      ${game.phase !== 'fly' && html`<div class="pn-wait">
        ${game.micError && html`<div class="pn-tv-error"><b>The microphone isn’t working</b><span>${game.micError}</span></div>`}
        ${last && html`<div class="pn-result"><b class="num">${last.score}<small>/${last.total}</small></b><span>rings cleared</span></div>`}
        ${(game.results || []).length > 0 && html`<${Board} game=${game} />`}
      </div>`}
    </div>
    <p class="g-tv-foot">${game.phase === 'fly' ? 'Sing — fly the ball through the rings!'
      : game.phase === 'done' && best.length ? `Most rings: ${best.map((r) => r.label).join(' & ')}`
        : game.phase === 'ready' ? 'The host sends the first singer.'
          : 'The host sends the next singer.'}</p>
  </div>`;
}

// ---- phones -----------------------------------------------------------------------------------------

export function Guest({ game, now }) {
  const last = lastResult(game);
  const showFlash = game.phase === 'fly' && game.flash && now() - (game.flashAt || 0) < 900;
  let head = 'Pitch rings';
  if (game.phase === 'ready') head = 'Get ready to sing';
  else if (game.phase === 'fly') head = `Ring ${game.index} of ${game.total}`;
  else if (game.phase === 'turn' && last) head = last.label;
  else if (game.phase === 'done') head = 'Pitch rings is over';
  return html`<div class="g-guest pitch">
    <h1 class="g-h1">${head}</h1>
    ${game.label && game.phase === 'fly' && html`<p class="muted">${game.label}</p>`}
    ${game.phase === 'fly' && html`<div class="pn-cleared num">${game.cleared}<small>/${game.total}</small></div>`}
    ${showFlash && html`<p class=${`pn-flash ${game.flash}`}>${flashWord(game.flash)}</p>`}
    ${game.phase === 'turn' && last && html`<div class="pn-cleared num">${last.score}<small>/${last.total}</small></div>`}
    ${game.phase === 'fly' && html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds || 1} now=${now} />`}
    ${game.micError && html`<p class="warn-text">${game.micError}</p>`}
    <p class="hint">${game.phase === 'fly' ? 'Sing toward the TV — your phone is just watching.'
      : game.phase === 'ready' ? 'Waiting for the host…' : 'Most rings wins.'}</p>
    <${Board} game=${game} />
  </div>`;
}
