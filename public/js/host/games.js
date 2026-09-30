// Host: start and run party games (crowd poll, roulette wheel).
import { html, useState } from '/js/vendor/preact.js';
import { useStore } from '/js/lib/store.js';
import { api } from '/js/lib/api.js';
import { Icon, Cover, useAsync, useNow } from '/js/lib/ui.js';
import { store, act, conn } from './state.js';

const SHAPES = ['▲', '◆', '●', '■', '★', '♥'];

export function Games() {
  const st = useStore(store, (s) => s.state);
  const game = st.game;
  return html`<div class="view games">
    <h2>Party games</h2>
    ${game ? html`<${ActiveGame} st=${st} game=${game} />` : html`<div class="game-cards">
      <${PollCard} />
      <${WheelCard} />
      <div class="card pad game-card soon"><div class="big-emoji">⚔️</div><h3>Battle</h3><p class="muted">Two singers, the crowd votes on their phones. Coming soon.</p></div>
      <div class="card pad game-card soon"><div class="big-emoji">🧠</div><h3>Music quiz</h3><p class="muted">Name that tune from the intro, lyrics or cover. Coming soon.</p></div>
    </div>`}
    ${!st.settings.guests.games && html`<p class="muted" style=${{ marginTop: '16px' }}>Guests can't vote right now — turn on “Guests can join party games” in Settings → Queue & guests.</p>`}
  </div>`;
}

function TagSelect({ value, onChange }) {
  const facets = useAsync((signal) => api('/api/browse/facets', { signal }), []);
  return html`<select class="input" value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>
    <option value="">Whole library (popular songs)</option>
    ${(facets.data?.tags || []).map((t) => html`<option value=${t.tag}>${t.tag}</option>`)}
  </select>`;
}

function PollCard() {
  const [tag, setTag] = useState('');
  const [count, setCount] = useState(4);
  const [seconds, setSeconds] = useState(20);
  return html`<div class="card pad game-card">
    <div class="big-emoji">🗳️</div>
    <h3>Crowd poll — “What's next?”</h3>
    <p class="muted">Random songs appear on the TV, everyone votes on their phone, the winner goes to the top of the queue.</p>
    <label class="field-label">Songs from</label>
    <${TagSelect} value=${tag} onChange=${setTag} />
    <div class="row" style=${{ marginTop: '10px' }}>
      <select class="input" value=${count} onChange=${(e) => setCount(Number(e.currentTarget.value))}>${[2, 3, 4, 5, 6].map((n) => html`<option value=${n}>${n} songs</option>`)}</select>
      <select class="input" value=${seconds} onChange=${(e) => setSeconds(Number(e.currentTarget.value))}>${[15, 20, 30, 45, 60].map((n) => html`<option value=${n}>${n} seconds</option>`)}</select>
    </div>
    <button class="btn primary block" style=${{ marginTop: '14px' }} onClick=${() => act('game.start', { type: 'poll', config: { tag, count, seconds } })}><${Icon} name="play" size=${16} /> Start the poll</button>
  </div>`;
}

function WheelCard() {
  const [kind, setKind] = useState('songs');
  const [tag, setTag] = useState('');
  const [dares, setDares] = useState('');
  return html`<div class="card pad game-card">
    <div class="big-emoji">🎡</div>
    <h3>Roulette wheel</h3>
    <p class="muted">Spin for a random song, the next singer, or a dare for the singer on stage.</p>
    <label class="field-label">The wheel picks</label>
    <select class="input" value=${kind} onChange=${(e) => setKind(e.currentTarget.value)}>
      <option value="songs">A song</option>
      <option value="singers">A singer</option>
      <option value="dares">A dare</option>
    </select>
    ${kind === 'songs' && html`<div style=${{ marginTop: '10px' }}><${TagSelect} value=${tag} onChange=${setTag} /></div>`}
    ${kind === 'dares' && html`<textarea class="input" style=${{ marginTop: '10px' }} placeholder="One dare per line (leave empty for the built-in ones)" value=${dares} onInput=${(e) => setDares(e.currentTarget.value)}></textarea>`}
    <button class="btn primary block" style=${{ marginTop: '14px' }} onClick=${() => act('game.start', { type: 'wheel', config: { kind, tag, count: 8, dares: dares.split('\n').map((d) => d.trim()).filter(Boolean) } })}><${Icon} name="play" size=${16} /> Show the wheel</button>
  </div>`;
}

function SingerSelect({ singers, value, onChange }) {
  return html`<select class="input" value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>
    <option value="">No singer (sing-along)</option>
    ${singers.map((s) => html`<option value=${s.id}>${s.emoji} ${s.name}</option>`)}
  </select>`;
}

function ActiveGame({ st, game }) {
  const now = useNow(250);
  const [singerId, setSingerId] = useState('');
  const queue = () => act('game.action', { action: 'queue', singerId: singerId || undefined, position: 'next' }, { ok: 'Added as the next song' });
  const end = () => act('game.end');
  if (game.type === 'poll') {
    const total = game.counts.reduce((a, b) => a + b, 0);
    const left = Math.max(0, Math.ceil((game.endsAt - (now + conn.offset)) / 1000));
    return html`<div class="card pad active-game">
      <div class="row"><h3 class="grow">🗳️ Crowd poll ${game.phase === 'voting' ? html`<span class="tag">${left} s left</span>` : html`<span class="tag">result</span>`}</h3>
        <span class="muted">${game.voters} vote${game.voters === 1 ? '' : 's'}</span></div>
      <div class="poll-options">
        ${game.options.map((o, i) => html`<div key=${o.songId} class=${`poll-opt${game.winner === i ? ' win' : ''}`}>
          <span class=${`shape s${i}`}>${SHAPES[i]}</span>
          <${Cover} song=${{ id: o.songId }} size=${40} />
          <div class="grow" style=${{ minWidth: 0 }}><b class="ellipsis" style=${{ display: 'block' }}>${o.title}</b><span class="muted">${o.artist}</span>
            <div class="bar"><div style=${{ width: `${total ? (game.counts[i] / total) * 100 : 0}%` }}></div></div></div>
          <b class="count">${game.counts[i]}</b>
        </div>`)}
      </div>
      <div class="row" style=${{ marginTop: '14px', flexWrap: 'wrap' }}>
        ${game.phase === 'voting' ? html`<button class="btn primary" onClick=${() => act('game.action', { action: 'close' })}>Close voting now</button>`
          : html`<${SingerSelect} singers=${st.singers} value=${singerId} onChange=${setSingerId} />
            <button class="btn primary" onClick=${async () => { if (await queue()) end(); }}>Queue the winner next</button>
            <button class="btn" onClick=${() => act('game.start', { type: 'poll', config: { count: game.options.length, seconds: game.seconds } })}>New poll</button>`}
        <span class="grow"></span>
        <button class="btn ghost danger" onClick=${end}>End game</button>
      </div>
    </div>`;
  }
  const result = game.phase === 'landed' ? game.segments[game.result] : null;
  return html`<div class="card pad active-game">
    <div class="row"><h3 class="grow">🎡 Roulette wheel — ${game.kind}</h3><span class="tag">${game.phase}</span></div>
    <div class="chips-wrap" style=${{ margin: '10px 0' }}>${game.segments.map((s, i) => html`<span key=${s.id} class=${`chip${result && i === game.result ? ' on' : ''}`}>${game.kind === 'singers' ? s.sub : ''} ${s.label}</span>`)}</div>
    ${result && html`<div class="wheel-result">${game.kind === 'songs' ? '🎵' : game.kind === 'singers' ? '🎤' : '🎭'} <b>${result.label}</b> ${result.sub && game.kind === 'songs' ? html`<span class="muted">· ${result.sub}</span>` : null}</div>`}
    <div class="row" style=${{ marginTop: '14px', flexWrap: 'wrap' }}>
      <button class="btn primary" disabled=${game.phase === 'spinning'} onClick=${() => act('game.action', { action: 'spin' })}><${Icon} name="refresh" size=${16} /> ${game.phase === 'ready' ? 'Spin!' : 'Spin again'}</button>
      ${result && game.kind === 'songs' && html`<${SingerSelect} singers=${st.singers} value=${singerId} onChange=${setSingerId} /><button class="btn" onClick=${queue}>Queue this song next</button>`}
      ${result && game.segments.length > 2 && html`<button class="btn" onClick=${() => act('game.action', { action: 'remove' })}>Remove from the wheel</button>`}
      <span class="grow"></span>
      <button class="btn ghost danger" onClick=${end}>End game</button>
    </div>
  </div>`;
}
