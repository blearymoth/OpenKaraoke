// TV scenes for party games: crowd poll with live vote bars, roulette wheel.
import { html, useState, useEffect, useRef } from '/js/vendor/preact.js';
import { Cover, useNow } from '/js/lib/ui.js';
import { qrUrl } from '/js/lib/api.js';
import { SINGER_COLORS } from '/shared/protocol.js';

const SHAPES = ['▲', '◆', '●', '■', '★', '♥'];

export function GameScene({ tv, offset }) {
  const g = tv.game;
  return html`<div class="game-scene">
    ${g.type === 'poll' ? html`<${Poll} g=${g} tv=${tv} offset=${offset} />` : html`<${Wheel} g=${g} offset=${offset} />`}
  </div>`;
}

function Poll({ g, tv, offset }) {
  const now = useNow(200);
  const total = g.counts.reduce((a, b) => a + b, 0);
  const left = Math.max(0, (g.endsAt - (now + offset)) / 1000);
  const voting = g.phase === 'voting';
  return html`<div class="poll-scene">
    <div class="game-head">
      <div>
        <div class="game-label">${voting ? 'Crowd poll' : 'The crowd has chosen'}</div>
        <h1>${voting ? 'What should we sing next?' : g.options[g.winner]?.title}</h1>
        ${voting ? html`<div class="sub">Vote on your phone — ${g.voters} vote${g.voters === 1 ? '' : 's'} so far</div>` : html`<div class="sub">${g.options[g.winner]?.artist} · ${g.counts[g.winner]} vote${g.counts[g.winner] === 1 ? '' : 's'}</div>`}
      </div>
      ${voting && html`<div class="poll-timer"><b>${Math.ceil(left)}</b></div>`}
      ${voting && html`<div class="qr-mini"><img src=${qrUrl(tv.party.joinUrl)} alt="" /><span>${tv.party.roomCode}</span></div>`}
    </div>
    <div class=${`poll-grid n${g.options.length}`}>
      ${g.options.map((o, i) => {
        const pct = total ? g.counts[i] / total : 0;
        const win = !voting && g.winner === i;
        return html`<div key=${o.songId} class=${`poll-card c${i}${win ? ' win' : ''}${!voting && !win ? ' lose' : ''}`}>
          <div class="fill" style=${{ height: `${pct * 100}%` }}></div>
          <span class="shape">${SHAPES[i]}</span>
          <${Cover} song=${{ id: o.songId }} size=${150} big=${true} />
          <div class="txt"><div class="t">${o.title}</div><div class="a">${o.artist}</div></div>
          <div class="votes">${g.counts[i]}</div>
        </div>`;
      })}
    </div>
  </div>`;
}

/** Wheel angle (deg, clockwise) that puts `pos` segments under the top pointer. */
function targetAngle(pos, n) {
  return (360 - ((pos * 360) / n) % 360) % 360;
}

function Wheel({ g, offset }) {
  const n = g.segments.length;
  const [rot, setRot] = useState({ deg: 0, ms: 0 });
  const last = useRef({ spinId: 0, deg: 0 });
  useEffect(() => {
    if (g.spinId === last.current.spinId || g.result == null) return;
    last.current.spinId = g.spinId;
    const base = last.current.deg;
    const target = targetAngle(g.result + (g.offset ?? 0.5), n);
    const deg = base + (g.turns || 5) * 360 + ((target - (base % 360)) + 360) % 360;
    last.current.deg = deg;
    const elapsed = Date.now() + offset - g.spinStartedAt;
    const ms = Math.max(0, g.spinMs - elapsed);
    setRot({ deg, ms: ms > 400 ? ms : 0 });
  }, [g.spinId, g.result]);
  const landed = g.phase === 'landed' ? g.segments[g.result] : null;
  const R = 100;
  const arc = (i) => {
    const a0 = ((i / n) * 2 * Math.PI) - Math.PI / 2;
    const a1 = (((i + 1) / n) * 2 * Math.PI) - Math.PI / 2;
    const p = (a) => `${(Math.cos(a) * R).toFixed(2)} ${(Math.sin(a) * R).toFixed(2)}`;
    return `M0 0 L${p(a0)} A${R} ${R} 0 ${n <= 2 ? 1 : 0} 1 ${p(a1)} Z`;
  };
  return html`<div class="wheel-scene">
    <div class="game-head">
      <div>
        <div class="game-label">Roulette wheel</div>
        <h1>${landed ? (g.kind === 'singers' ? `${landed.sub || '🎤'} ${landed.label}!` : landed.label) : g.phase === 'spinning' ? 'Spinning…' : g.kind === 'singers' ? 'Who sings next?' : g.kind === 'dares' ? 'Dare time!' : 'Spin for a song!'}</h1>
        ${landed && landed.sub && g.kind === 'songs' && html`<div class="sub">${landed.sub}</div>`}
      </div>
    </div>
    <div class=${`wheel-wrap${landed ? ' landed' : ''}`}>
      <div class="pointer"></div>
      <svg class="wheel" viewBox="-104 -104 208 208" style=${{ transform: `rotate(${rot.deg}deg)`, transition: rot.ms ? `transform ${rot.ms}ms cubic-bezier(.12,.7,.08,1)` : 'none' }}>
        <circle r="103" fill="#0b0a12" />
        ${g.segments.map((s, i) => {
          const mid = ((i + 0.5) / n) * 360;
          const label = s.label.length > 22 ? `${s.label.slice(0, 21)}…` : s.label;
          return html`<g key=${s.id}>
            <path d=${arc(i)} fill=${s.color || SINGER_COLORS[i % SINGER_COLORS.length]} stroke="#0b0a12" stroke-width="1.2" opacity=${landed && i !== g.result ? 0.45 : 1} />
            <text transform=${`rotate(${mid - 90}) translate(58 0)`} text-anchor="middle" dominant-baseline="middle" font-size=${n > 10 ? 6 : 7.5} font-weight="800" fill="#fff">${label}</text>
          </g>`;
        })}
        <circle r="14" fill="#fff" /><circle r="9" fill="var(--accent)" />
      </svg>
    </div>
  </div>`;
}
