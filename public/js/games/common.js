// Building blocks shared by the party games' screens (TV, host, phones).
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { useTick, artUrl } from '../lib/store.js';
import { ANSWER_COLORS, ANSWER_SHAPES } from '/shared/protocol.js';

const loadedCss = new Set();

/** Adds a stylesheet once (each game keeps its CSS in /css/games/<type>.css). */
export function ensureCss(href) {
  if (loadedCss.has(href) || typeof document === 'undefined') return;
  loadedCss.add(href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
ensureCss('/css/games.css');

/** Seconds left until `endsAt` (server time from `now()`), re-rendering 4× a second. */
export function useSecondsLeft(endsAt, now = Date.now) {
  useTick(250);
  return endsAt ? Math.max(0, Math.ceil((endsAt - now()) / 1000)) : 0;
}

/** Ring countdown; `total` seconds is the full circle. */
export function Countdown({ endsAt, total, now, label }) {
  const left = useSecondsLeft(endsAt, now);
  if (!endsAt) return null;
  const circ = 2 * Math.PI * 44;
  const frac = total ? Math.min(1, left / total) : 1;
  return html`<div class=${`g-countdown ${left <= 5 ? 'hurry' : ''}`} role="timer" aria-label=${label || `${left} seconds left`}>
    <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44" /><circle class="arc" cx="50" cy="50" r="44" stroke-dasharray=${circ} stroke-dashoffset=${circ * (1 - frac)} /></svg>
    <b>${left}</b>
  </div>`;
}

/** Kahoot-style answer tile: colour + shape so colour-blind players can play too. */
export function AnswerTile({ index, children, state = 'idle', onClick, disabled, sub }) {
  const Tag = onClick ? 'button' : 'div';
  return html`<${Tag} class=${`g-answer s-${state}`} style=${{ '--answer': ANSWER_COLORS[index % 4] }} onClick=${onClick} disabled=${disabled}>
    <span class="shape" aria-hidden="true">${ANSWER_SHAPES[index % 4]}</span>
    <span class="text">${children}</span>
    ${sub != null && html`<span class="sub">${sub}</span>`}
  </${Tag}>`;
}

/** Horizontal vote bars: items [{ label, votes }], `winner` index highlighted. */
export function VoteBars({ items, winner = -1 }) {
  const max = Math.max(1, ...items.map((i) => i.votes || 0));
  return html`<div class="g-votebars">${items.map((it, i) => html`<div class=${`g-votebar ${winner === i ? 'win' : ''}`} style=${{ '--answer': ANSWER_COLORS[i % 4] }}>
    <span class="shape" aria-hidden="true">${ANSWER_SHAPES[i % 4]}</span>
    <span class="label ellipsis">${it.label}</span>
    <span class="bar"><i style=${{ width: `${((it.votes || 0) / max) * 100}%` }}></i></span>
    <b class="num">${it.votes || 0}</b>
  </div>`)}</div>`;
}

export function PlayerChip({ p, big }) {
  if (!p) return null;
  return html`<span class=${`g-player ${big ? 'big' : ''}`}><span class="avatar" style=${{ '--avatar': p.color }}>${p.emoji || '🎤'}</span><span class="ellipsis">${p.name}</span></span>`;
}

/** Ranked list: rows [{ name, emoji, color, score, delta?, rank? }] (tied rows share a `rank`: 1, 1, 3). */
export function Leaderboard({ rows, max = 10, highlight }) {
  return html`<ol class="g-leaderboard">${rows.slice(0, max).map((r, i) => html`<li class=${highlight && r.id === highlight ? 'me' : ''} key=${r.id || r.name}>
    <span class="rank num">${r.rank || i + 1}</span>
    <${PlayerChip} p=${r} />
    ${r.delta ? html`<span class="delta num">+${r.delta.toLocaleString()}</span>` : null}
    <b class="score num">${Math.round(r.score).toLocaleString()}</b>
  </li>`)}</ol>`;
}

/** Top three on a podium (2nd, 1st, 3rd). Rows with a `rank` share a step when tied (1, 1, 3). */
export function Podium({ rows }) {
  const order = [rows[1], rows[0], rows[2]];
  return html`<div class="g-podium">${order.map((r, i) => {
    if (!r) return null;
    const place = Math.min(3, r.rank || [2, 1, 3][i]);
    return html`<div class=${`step p${place}`} key=${r.id || r.name}>
      <span class="avatar" style=${{ '--avatar': r.color }}>${r.emoji || '🎤'}</span>
      <b class="ellipsis">${r.name}</b>
      <span class="num">${Math.round(r.score).toLocaleString()}</span>
      <div class="block">${place}</div>
    </div>`;
  })}</div>`;
}

/** Song cover (placeholder while unknown) for game screens. */
export function SongArt({ songId, size = 500, class: cls = '' }) {
  return html`<img class=${`g-art ${cls}`} src=${artUrl(songId, size)} alt="" decoding="async" />`;
}

/** A burst of confetti (re-runs when `run` changes). Pure CSS, no canvas. */
export function Confetti({ run = 0, count = 90 }) {
  const [pieces, setPieces] = useState([]);
  const seed = useRef(0);
  useEffect(() => {
    if (!run) return undefined;
    seed.current++;
    const colors = ['#ff3d8b', '#ffc94a', '#45e2a6', '#4cc3ff', '#b388ff', '#fff'];
    setPieces(Array.from({ length: count }, (_, i) => ({
      id: `${seed.current}-${i}`,
      left: Math.random() * 100,
      delay: Math.random() * 0.6,
      dur: 2.4 + Math.random() * 1.8,
      rot: Math.random() * 720 - 360,
      color: colors[i % colors.length],
      w: 6 + Math.random() * 8,
    })));
    const t = setTimeout(() => setPieces([]), 4800);
    return () => clearTimeout(t);
  }, [run]);
  if (!pieces.length) return null;
  return html`<div class="g-confetti" aria-hidden="true">${pieces.map((p) => html`<i key=${p.id} style=${{ left: `${p.left}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, background: p.color, width: `${p.w}px`, '--rot': `${p.rot}deg` }}></i>`)}</div>`;
}

/** Small select for setup forms. options: [[value, label]]. */
export function SelectField({ label, value, options, onChange, hint }) {
  return html`<label class="field"><span>${label}</span>
    <select class="select" value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>${options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
    ${hint && html`<span class="hint">${hint}</span>`}
  </label>`;
}

/** Filter pickers (tag / genre / decade) from /api/browse/facets. */
export function FilterFields({ facets, value, onChange }) {
  const tags = facets?.tags || [];
  const genres = facets?.genres || [];
  const decades = facets?.decades || [];
  const set = (k, v) => onChange({ ...value, [k]: v });
  return html`<div class="row-3">
    <${SelectField} label="Collection" value=${value.tag || ''} onChange=${(v) => set('tag', v)} options=${[['', 'Any'], ...tags.slice(0, 40).map((t) => [t.tag, `${t.tag} (${t.count})`])]} />
    <${SelectField} label="Genre" value=${value.genre || ''} onChange=${(v) => set('genre', v)} options=${[['', 'Any'], ...genres.slice(0, 40).map((g) => [g.genre, `${g.genre} (${g.count})`])]} />
    <${SelectField} label="Decade" value=${value.decade || ''} onChange=${(v) => set('decade', v ? Number(v) : '')} options=${[['', 'Any'], ...decades.map((d) => [d.decade, `${d.decade}s (${d.count})`])]} />
  </div>`;
}

/** Placeholder UI for games that aren't built yet. */
export function ComingSoon() {
  return html`<p class="muted">Coming soon.</p>`;
}
