// Host → Games: start a party game, then run it (PLAN §13).
import { html, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore } from '../lib/store.js';
import { store, act, conn } from './state.js';
import { GAME_UI } from '../games/index.js';
import { GAME_TYPES, GAME_LABELS } from '/shared/protocol.js';

const now = () => conn.serverNow();

function GameCard({ type, open, onOpen, busy, onStart }) {
  const ui = GAME_UI[type];
  return html`<section class=${`game-card ${open ? 'open' : ''} ${ui.comingSoon ? 'soon' : ''}`}>
    <h3><span class="emoji" aria-hidden="true">${ui.icon}</span> ${GAME_LABELS[type]}</h3>
    <p class="muted">${ui.blurb}</p>
    ${open
      ? html`<${ui.Setup} onStart=${onStart} busy=${busy} />`
      : html`<button class="btn" disabled=${ui.comingSoon} onClick=${onOpen}>${ui.comingSoon ? 'Coming soon' : 'Set up'}</button>`}
  </section>`;
}

function LiveGame({ game, state }) {
  const ui = GAME_UI[game.type];
  return html`<section class="game-live">
    <div class="game-live-head">
      <span class="emoji" style="font-size:30px" aria-hidden="true">${ui?.icon}</span>
      <h2>${GAME_LABELS[game.type] || game.type} ${game.ended ? html`<span class="pill">Finished</span>` : html`<span class="pill live">Running</span>`}</h2>
      ${!game.ended && html`<button class="btn ghost danger" onClick=${() => confirm('End the game now?') && act('game.end')}><${Icon} name="stop" size=${16} /> End game</button>`}
      ${game.ended && html`<button class="btn primary" onClick=${() => act('game.close')}><${Icon} name="check" size=${16} /> Close${game.exclusive ? ' and back to karaoke' : ''}</button>`}
    </div>
    ${ui && html`<${ui.Control} game=${game} act=${act} now=${now} state=${state} />`}
  </section>`;
}

export function Games() {
  const { state } = useStore(store);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const start = async (type, config) => {
    setBusy(true);
    const r = await act('game.start', { type, config });
    setBusy(false);
    if (r) setOpen(null);
  };
  return html`<div class="page games">
    <header class="page-head"><div><h1>Games</h1><p class="muted">Party games on the TV — guests play on their phones.${state.current ? ' Most games need the TV: they start once the current song is finished or stopped.' : ''}</p></div></header>
    ${state.game && html`<${LiveGame} game=${state.game} state=${state} />`}
    <div class="game-grid">${GAME_TYPES.map((type) => html`<${GameCard} key=${type} type=${type} open=${open === type} busy=${busy || (state.game && !state.game.ended)}
      onOpen=${() => setOpen(type)} onStart=${(config) => start(type, config)} />`)}</div>
  </div>`;
}
