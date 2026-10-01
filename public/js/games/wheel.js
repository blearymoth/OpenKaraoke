// Roulette wheel: the TV spins a big wheel of songs, singers, dares, genres or duet pairs.
// The server draws the result; only the TV knows where the wheel will stop (it animates the
// spin), phones and the host see the result once the wheel has stopped.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { SongArt, Confetti, SelectField, FilterFields, ensureCss } from './common.js';
import { useFetch } from '../lib/components.js';
import {
  WHEEL_KINDS, WHEEL_KIND_LABELS, WHEEL_MIN_SEGMENTS, WHEEL_MAX_SEGMENTS, MAX_DARES, MAX_DARE_LENGTH,
  DEFAULT_DARES, segmentColor, segmentInk, rotationAt,
} from '/shared/wheel.js';

ensureCss('/css/games/wheel.css');

export const icon = '🎡';
export const blurb = 'Spin for a song, a singer, a dare or a duet.';

const KIND_ICONS = { songs: '🎵', singers: '🎤', dares: '🎲', genres: '🎸', duets: '💞' };
const KIND_HINTS = {
  songs: 'Random songs from the library (or a collection, genre or decade). The winner can be queued next.',
  singers: 'Tonight’s singers and the guests on their phones. The winner’s phone buzzes: pick a song!',
  dares: 'Fun party dares. Edit the list below — a random selection goes on the wheel.',
  genres: 'Genres from the song metadata. The winner: a random song of that genre, queued next.',
  duets: 'Random pairs of singers. Queue a random duet song for the lucky pair.',
};

// ---- the wheel ----------------------------------------------------------------------------------

const R = 100; // SVG radius (viewBox −100…100 plus room for the rim)
const HUB = 17;
const xy = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [Number((r * Math.cos(a)).toFixed(2)), Number((r * Math.sin(a)).toFixed(2))];
};
const point = (deg, r) => xy(deg, r).join(' ');

function wheelLabel(seg, kind) {
  if (kind === 'singers') return `${seg.emoji || ''} ${seg.label}`.trim();
  return seg.label;
}

/** The static wheel drawing (segments, labels, rim bulbs), memo-friendly: no rotation here. */
function WheelSvg({ segments, kind, win = -1 }) {
  const n = Math.max(1, segments.length);
  const seg = 360 / n;
  const r = R - 6;
  const font = n <= 3 ? 13 : n <= 4 ? 11.5 : n <= 6 ? 10 : n <= 8 ? 9.5 : n <= 10 ? 8.6 : 7.8;
  const avail = r - HUB - 9;
  const maxChars = 22;
  return html`<svg class="wheel-svg" viewBox="-100 -100 200 200" aria-hidden="true">
    <circle r=${R} class="wheel-rim" />
    ${segments.map((s, i) => {
      const color = segmentColor(i, n);
      const a0 = -90 + i * seg;
      const a1 = a0 + seg;
      const mid = a0 + seg / 2;
      const d = n === 1 ? `M ${-r} 0 A ${r} ${r} 0 1 1 ${r} 0 A ${r} ${r} 0 1 1 ${-r} 0 Z` : `M 0 0 L ${point(a0, r)} A ${r} ${r} 0 ${seg > 180 ? 1 : 0} 1 ${point(a1, r)} Z`;
      let text = wheelLabel(s, kind);
      if ([...text].length > maxChars) text = `${[...text].slice(0, maxChars - 1).join('').trim()}…`;
      const width = [...text].length * font * 0.56;
      return html`<g key=${i} class=${`wheel-seg ${win === i ? 'win' : ''}`}>
        <path d=${d} style=${{ fill: color }} />
        <g transform=${`rotate(${mid.toFixed(2)})`}>
          <text x=${r - 7} y="0" text-anchor="end" dominant-baseline="central" font-size=${font} style=${{ fill: segmentInk(i, n) }}
            textLength=${width > avail ? avail : undefined} lengthAdjust=${width > avail ? 'spacingAndGlyphs' : undefined}>${text}</text>
        </g>
      </g>`;
    })}
    ${segments.length > 1 && segments.map((_, i) => {
      const [x2, y2] = xy(-90 + i * seg, r);
      return html`<line key=${`l${i}`} class="wheel-divider" x1="0" y1="0" x2=${x2} y2=${y2} />`;
    })}
    ${Array.from({ length: 24 }, (_, i) => {
      const [cx, cy] = xy(i * 15, R - 3);
      return html`<circle key=${`b${i}`} class=${`wheel-bulb ${i % 2 ? 'odd' : ''}`} r="2.1" cx=${cx} cy=${cy} />`;
    })}
  </svg>`;
}

/**
 * The wheel with its pointer. When the view knows where the spin ends (TV, or anyone after the
 * reveal) it animates exactly to it on the server clock; otherwise (phones while spinning) it
 * just whirls.
 */
function Wheel({ game, now, onTick, size = 'tv' }) {
  const rot = useRef(null);
  const pointer = useRef(null);
  const n = game.segments.length;
  const spin = game.spin;
  const spinning = game.phase === 'spinning';
  const known = !!spin && spin.to !== undefined;
  const tick = useRef(onTick);
  tick.current = onTick;
  const whirled = useRef(false); // this wheel whirled blindly (a phone during the spin)
  useEffect(() => {
    const el = rot.current;
    if (!el) return undefined;
    if (!spinning || !known) {
      const deg = known ? spin.to : spinning && spin ? spin.from : game.rotation;
      el.style.transform = `rotate(${deg}deg)`;
      if (spinning && !known) whirled.current = true;
      else if (whirled.current && known) {
        // The result is out: let the phone's wheel glide onto it instead of jumping.
        whirled.current = false;
        el.animate?.([{ transform: `rotate(${deg - 400}deg)` }, { transform: `rotate(${deg}deg)` }], { duration: 1100, easing: 'cubic-bezier(0.15, 0.8, 0.3, 1)' });
      }
      return undefined;
    }
    const segDeg = 360 / Math.max(1, n);
    const end = spin.startsAt + spin.duration * 1000;
    let raf = 0;
    let last = null;
    let lastTick = 0;
    const frame = () => {
      const t = now();
      const deg = rotationAt(spin, t);
      el.style.transform = `rotate(${deg}deg)`;
      const k = Math.floor(deg / segDeg);
      if (last !== null && k !== last) {
        const ms = performance.now();
        if (ms - lastTick > 45) {
          lastTick = ms;
          tick.current?.();
          pointer.current?.animate?.([{ transform: 'rotate(-24deg)' }, { transform: 'rotate(0deg)' }], { duration: 140, easing: 'ease-out' });
        }
      }
      last = k;
      if (t < end + 100) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [spin?.seq, spinning, known, n, game.rotation]);
  const win = game.result && !spinning ? game.result.index : -1;
  return html`<div class=${`wheel wheel-${size} ${spinning ? 'is-spinning' : ''} ${win >= 0 ? 'has-result' : ''}`}>
    <div class="wheel-rot" ref=${rot}>
      <div class=${`wheel-inner ${spinning && !known ? 'whirl' : ''}`}><${WheelSvg} segments=${game.segments} kind=${game.kind} win=${win} /></div>
    </div>
    <div class="wheel-hub" aria-hidden="true">${KIND_ICONS[game.kind] || '🎡'}</div>
    <div class="wheel-pointer" ref=${pointer} aria-hidden="true"><svg viewBox="0 0 40 50"><path d="M20 48 L4 12 A17 17 0 1 1 36 12 Z" /><circle cx="20" cy="17" r="6" /></svg></div>
  </div>`;
}

// ---- sounds (TV) --------------------------------------------------------------------------------

/** Output of the TV's audio engine (volume applies), or null when sound is not available. */
function audioOut(tv) {
  const engine = tv?.controller?.engine;
  if (!tv?.main || !engine?.ctx || engine.ctx.state !== 'running') return null;
  return { ctx: engine.ctx, dest: engine.master || engine.ctx.destination };
}

function playTick(tv) {
  const out = audioOut(tv);
  if (!out) return;
  const { ctx, dest } = out;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(2200, t);
  o.frequency.exponentialRampToValueAtTime(700, t + 0.03);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.06);
}

function playFanfare(tv) {
  const out = audioOut(tv);
  if (!out) return;
  const { ctx, dest } = out;
  const t0 = ctx.currentTime + 0.02;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const t = t0 + i * 0.11;
    const len = i === 3 ? 0.7 : 0.16;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + len + 0.02);
  });
}

// ---- results --------------------------------------------------------------------------------

function Avatar({ p, cls = 'avatar-big' }) {
  return html`<span class=${cls} style=${{ '--c': p.color || 'var(--neon)' }}>${p.emoji || '🎤'}</span>`;
}

const short = (text, max = 28) => ([...text].length > max ? `${[...text].slice(0, max - 1).join('').trim()}…` : text);

function queuedLine(q) {
  if (!q) return '';
  const who = q.singers?.length ? q.singers.join(' & ') : '';
  return `${q.title} — ${q.artist}${who ? ` · ${who}` : ''}`;
}

/** Headline for a result. */
function resultTitle(game) {
  const r = game.result;
  if (!r) return '';
  if (game.kind === 'singers') return `${r.label}, pick a song!`;
  if (game.kind === 'duets') return 'Duet time!';
  if (game.kind === 'dares') return 'Dare!';
  if (game.kind === 'genres') return `${r.label}!`;
  return 'The wheel has spoken!';
}

/** The big reveal on the TV. */
function TvResult({ game }) {
  const r = game.result;
  const k = game.kind;
  if (k === 'songs') {
    return html`<div class="wheel-reveal song">
      <${SongArt} songId=${r.songId} />
      <div><h2 class="display">${r.label}</h2><p class="sub">${r.sub}</p>
        <p class="next">${r.queued ? `Up next${r.queued.singers.length ? ` for ${r.queued.singers.join(' & ')}` : ''}!` : 'Who’s going to sing it?'}</p></div>
    </div>`;
  }
  if (k === 'singers') {
    const p = r.people?.[0] || { name: r.label, emoji: r.emoji };
    return html`<div class="wheel-reveal person">
      <${Avatar} p=${p} />
      <h2 class="display">${p.name}</h2>
      <p class="next">Pick a song on your phone 🎤</p>
    </div>`;
  }
  if (k === 'duets') {
    const [a, b] = r.people || [];
    return html`<div class="wheel-reveal pair">
      <div class="pair-row">${a && html`<${Avatar} p=${a} />`}<span class="amp">&</span>${b && html`<${Avatar} p=${b} />`}</div>
      <h2 class="display">${r.label}</h2>
      <p class="next">${r.queued ? `Your duet: ${r.queued.title} — ${r.queued.artist}` : 'Get ready to sing together!'}</p>
    </div>`;
  }
  if (k === 'genres') {
    return html`<div class="wheel-reveal genre">
      <div class="big-emoji">🎸</div>
      <h2 class="display">${r.label}</h2>
      <p class="next">${r.queued ? `Up next: ${r.queued.title} — ${r.queued.artist}` : 'A random song from this genre is coming up…'}</p>
    </div>`;
  }
  return html`<div class="wheel-reveal dare">
    <div class="big-emoji">🎲</div>
    <h2 class="display">${r.label}</h2>
  </div>`;
}

// ---- TV --------------------------------------------------------------------------------------

export function Tv({ game, now, tv }) {
  const r = game.result;
  const spinning = game.phase === 'spinning';
  const seen = useRef(r?.seq || 0);
  useEffect(() => {
    if (r && r.seq !== seen.current) {
      seen.current = r.seq;
      playFanfare(tv);
    }
  }, [r?.seq]);
  let title = 'Spin the wheel!';
  if (spinning) title = 'Round and round it goes…';
  else if (r) title = resultTitle(game);
  else if (game.phase === 'done') title = 'Thanks for spinning!';
  const history = game.history.filter((h) => !r || h.seq !== r.seq).slice(-4).reverse();
  return html`<div class=${`scene g-tv wheel-tv fade-in kind-${game.kind}`}>
    <header class="g-tv-head">
      <div><div class="kicker">🎡 Roulette wheel · ${game.kindLabel}</div><h1 class="display">${title}</h1></div>
    </header>
    <div class="wheel-stage">
      <${Wheel} game=${game} now=${now} onTick=${() => playTick(tv)} />
      <div class="wheel-side">
        ${r && !spinning
          ? html`<${TvResult} game=${game} key=${r.seq} />`
          : spinning
            ? html`<div class="wheel-wait"><div class="big-emoji">🤞</div><p>Where will it stop?</p></div>`
            : html`<div class="wheel-wait"><div class="big-emoji">${KIND_ICONS[game.kind]}</div><p>${game.segments.length} on the wheel</p><p class="muted">The host spins it from the Games page.</p></div>`}
      </div>
    </div>
    <p class="g-tv-foot">${history.length ? html`Earlier: ${history.map((h, i) => html`<span class="wheel-hist" key=${h.seq}>${i ? ' · ' : ''}${h.label}</span>`)}` : `${game.spins} ${game.spins === 1 ? 'spin' : 'spins'} so far`}</p>
    ${r && !spinning && html`<${Confetti} run=${r.seq} />`}
  </div>`;
}

// ---- phones ------------------------------------------------------------------------------------

function GuestResult({ game }) {
  const r = game.result;
  if (r.mine) {
    return html`<div class="wheel-guest-card mine">
      <div class="big-emoji">${game.kind === 'duets' ? '💞' : '🎤'}</div>
      <h2>It’s you!</h2>
      <p>${game.kind === 'duets' ? `You’re singing a duet: ${r.label}.` : 'Pick a song in the Songs tab and add it to the queue.'}</p>
      ${r.queued && html`<p class="muted">${queuedLine(r.queued)}</p>`}
    </div>`;
  }
  return html`<div class="wheel-guest-card">
    ${r.songId ? html`<${SongArt} songId=${r.songId} size=${250} class="wheel-guest-art" />` : html`<div class="big-emoji">${r.emoji && game.kind !== 'duets' ? r.emoji : KIND_ICONS[game.kind]}</div>`}
    <h2>${r.label}</h2>
    ${r.sub && game.kind === 'songs' && html`<p class="muted">${r.sub}</p>`}
    ${game.kind === 'singers' && html`<p class="muted">…picks the next song!</p>`}
    ${r.queued && html`<p class="muted">Up next: ${queuedLine(r.queued)}</p>`}
  </div>`;
}

export function Guest({ game, now }) {
  const r = game.result;
  const spinning = game.phase === 'spinning';
  useEffect(() => {
    if (r?.mine) {
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch { /* not supported */ }
    }
  }, [r?.seq, r?.mine]);
  let title = 'Watch the TV!';
  if (spinning) title = 'Spinning…';
  else if (r) title = game.kind === 'dares' ? 'The dare is…' : 'The wheel says…';
  else if (game.phase === 'done') title = 'Thanks for playing!';
  return html`<div class="g-guest wheel-guest">
    <h1 class="g-h1">${title}</h1>
    <${Wheel} game=${game} now=${now} size="phone" />
    ${r && !spinning
      ? html`<${GuestResult} game=${game} key=${r.seq} />`
      : html`<p class="hint">${spinning ? 'Fingers crossed…' : `The host spins the wheel of ${game.kindLabel.toLowerCase()}.`}</p>`}
  </div>`;
}

// ---- host ---------------------------------------------------------------------------------------

export function Setup({ onStart, busy }) {
  const facets = useFetch('/api/browse/facets');
  const hasGenres = (facets.data?.genres || []).length >= 2;
  const [kind, setKind] = useState('songs');
  const [count, setCount] = useState('8');
  const [who, setWho] = useState('all');
  const [filter, setFilter] = useState({});
  const [dares, setDares] = useState(DEFAULT_DARES.join('\n'));
  const kinds = WHEEL_KINDS.filter((k) => k !== 'genres' || hasGenres);
  const lines = dares.split('\n').map((l) => l.trim()).filter(Boolean);
  const tooLong = lines.filter((l) => l.length > MAX_DARE_LENGTH).length;
  const counts = [];
  for (let i = WHEEL_MIN_SEGMENTS; i <= WHEEL_MAX_SEGMENTS; i++) counts.push([String(i), `${i} segments`]);
  const start = () => {
    const config = { kind, count: Number(count) };
    if (kind === 'songs') Object.assign(config, filter);
    if (kind === 'singers' || kind === 'duets') config.who = who;
    if (kind === 'dares') config.dares = dares;
    onStart(config);
  };
  return html`<div class="g-setup wheel-setup">
    <div class="wheel-kinds" role="radiogroup" aria-label="What goes on the wheel">${kinds.map((k) => html`<button key=${k} type="button" role="radio" aria-checked=${kind === k}
      class=${`chip ${kind === k ? 'on' : ''}`} onClick=${() => setKind(k)}><span aria-hidden="true">${KIND_ICONS[k]}</span> ${WHEEL_KIND_LABELS[k]}</button>`)}</div>
    <p class="hint">${KIND_HINTS[kind]}</p>
    <div class="row-3">
      <${SelectField} label="Size of the wheel" value=${count} onChange=${setCount} options=${counts} />
      ${(kind === 'singers' || kind === 'duets') && html`<${SelectField} label="Who’s on the wheel" value=${who} onChange=${setWho}
        options=${[['all', 'Everyone singing tonight'], ['online', 'Only guests with their phone here']]} />`}
    </div>
    ${kind === 'songs' && html`<${FilterFields} facets=${facets.data} value=${filter} onChange=${setFilter} />`}
    ${kind === 'dares' && html`<label class="field"><span>Dares — one per line</span>
      <textarea class="input wheel-dares" rows="8" value=${dares} onInput=${(e) => setDares(e.currentTarget.value)}></textarea>
      <span class=${`hint ${lines.length > MAX_DARES || tooLong || lines.length < 2 ? 'warn-text' : ''}`}>${lines.length} ${lines.length === 1 ? 'dare' : 'dares'}${tooLong ? ` · ${tooLong} too long` : ''} · up to ${MAX_DARES}, ${MAX_DARE_LENGTH} characters each. ${Math.min(Number(count), lines.length)} random ones go on the wheel.</span>
      <button type="button" class="btn small ghost wheel-reset" onClick=${() => setDares(DEFAULT_DARES.join('\n'))}>Reset to the default dares</button>
    </label>`}
    <button class="btn primary" disabled=${busy} onClick=${start}>Show the wheel</button>
  </div>`;
}

export function Control({ game, act, state }) {
  const r = game.result;
  const [forWho, setFor] = useState('everyone');
  const [busy, setBusy] = useState(false);
  const run = async (body) => {
    setBusy(true);
    await act('game.action', body);
    setBusy(false);
  };
  const spinning = game.phase === 'spinning';
  const canQueue = r && ['songs', 'genres', 'duets'].includes(game.kind);
  const singers = (state?.singers || []).filter((x) => x.name && x.name.toLowerCase() !== 'everyone');
  const queueLabel = game.kind === 'songs' ? 'Queue it next' : game.kind === 'genres' ? `Queue a random ${r?.label || ''} song` : 'Queue a duet for both';
  let status = `The wheel is on the TV with ${game.segments.length} ${game.kindLabel.toLowerCase()}.`;
  if (spinning) status = 'Spinning… the result shows on the TV when the wheel stops.';
  else if (game.phase === 'done') status = `Finished after ${game.spins} ${game.spins === 1 ? 'spin' : 'spins'}.`;
  return html`<div class="g-control wheel-control">
    ${r && !spinning
      ? html`<div class="wheel-host-result">
          <span class="big" aria-hidden="true">${r.emoji && game.kind !== 'duets' ? r.emoji : KIND_ICONS[game.kind]}</span>
          <div><div class="kicker">${resultTitle(game)}</div><b class="label">${r.label}</b>${r.sub && game.kind === 'songs' ? html` <span class="muted">— ${r.sub}</span>` : ''}</div>
        </div>`
      : html`<p class="muted">${status}</p>`}
    ${canQueue && !game.ended && !r.queued && html`<div class="wheel-queue">
      ${game.kind !== 'duets' && html`<${SelectField} label="Sung by" value=${forWho} onChange=${setFor}
        options=${[['everyone', 'Everyone (sing-along)'], ...singers.map((x) => [x.id, x.name]), ['nobody', 'Nobody yet — I’ll assign it']]} />`}
      <button class="btn bulb" disabled=${busy} onClick=${() => run({ action: 'queue', for: game.kind === 'duets' ? undefined : forWho })}>${queueLabel}</button>
    </div>`}
    ${r?.queued && html`<p class="wheel-ok">✓ Queued next: ${queuedLine(r.queued)}</p>`}
    ${r && !spinning && !game.ended && r.people && html`<p class="hint">${r.notified ? `${r.notified === 1 ? 'Their phone' : `${r.notified} phones`} buzzed.` : 'No phone connected for this result.'}
      ${' '}<button class="btn small ghost" disabled=${busy} onClick=${() => run({ action: 'buzz' })}>Buzz again</button></p>`}
    ${!game.ended && html`<div class="wheel-actions">
      ${game.phase === 'ready' && html`<button class="btn primary large" disabled=${busy} onClick=${() => run({ action: 'spin' })}>🎡 Spin the wheel!</button>`}
      ${game.phase === 'result' && html`<button class="btn primary" disabled=${busy} onClick=${() => run({ action: 'spin' })}>🎡 Spin again</button>
        <button class="btn" disabled=${busy || !game.canRemove} title=${game.canRemove ? '' : 'Only two left on the wheel'} onClick=${() => run({ action: 'spin', remove: true })}>Spin again without “${short(r?.label || '')}”</button>`}
      ${spinning && html`<button class="btn primary large" disabled>Spinning…</button>`}
    </div>`}
    <div class="wheel-seglist" aria-label="On the wheel">${game.segments.map((s, i) => html`<span key=${i} class=${`chip ${r && !spinning && r.index === i ? 'on' : ''}`}>
      <i class="dot" style=${{ background: segmentColor(i, game.segments.length) }}></i>${wheelLabel(s, game.kind)}</span>`)}</div>
  </div>`;
}
