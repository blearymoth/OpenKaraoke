// Pass the mic (PLAN §13.5): runs alongside the karaoke. While a song plays, the server hands
// the mic to another participant at random moments: the TV flashes "PASS THE MIC ➜ NAME"
// (TvOverlay, drawn over the lyrics) and that guest's phone buzzes (notify kind 'mic').
import { html, useEffect, useState } from '../vendor/preact.js';
import { useStore, useTick } from '../lib/store.js';
import { SelectField, PlayerChip, ensureCss } from './common.js';
import { singerColor } from '/shared/protocol.js';

ensureCss('/css/games/relay.css');

export const icon = '🎤';
export const blurb = 'During a song the mic is passed around — the TV says who’s next.';

const MIN_OPTIONS = [['5', '5 seconds'], ['10', '10 seconds'], ['15', '15 seconds'], ['20', '20 seconds'], ['30', '30 seconds'], ['45', '45 seconds'], ['60', '1 minute']];
const MAX_OPTIONS = [['20', '20 seconds'], ['30', '30 seconds'], ['40', '40 seconds'], ['60', '1 minute'], ['90', '90 seconds'], ['120', '2 minutes']];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The host app's store, loaded lazily: Setup only renders on the host page. */
function useHostStore() {
  const [mod, setMod] = useState(null);
  useEffect(() => {
    import('../host/state.js').then(setMod, () => {});
  }, []);
  return mod?.store || null;
}

function GuestPicker({ store, picked, onToggle }) {
  const { state } = useStore(store);
  const guests = (state?.guests || []).filter((g) => !g.banned);
  if (!guests.length) return html`<p class="hint">No guests have joined with a phone yet.</p>`;
  return html`<div class="rl-chips">${guests.map((g) => {
    const on = picked.includes(g.deviceId);
    return html`<button type="button" key=${g.deviceId} class=${`chip ${on ? 'on' : ''} ${g.online ? '' : 'offline'}`} aria-pressed=${on} onClick=${() => onToggle(g.deviceId)}>
      ${g.emoji || '🎤'} ${g.name}${g.online ? '' : ' (away)'}
    </button>`;
  })}</div>`;
}

export function Setup({ onStart, busy }) {
  const store = useHostStore();
  const [who, setWho] = useState('everyone');
  const [picked, setPicked] = useState([]);
  const [min, setMin] = useState('15');
  const [max, setMax] = useState('40');
  const toggle = (id) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const problem = who === 'pick' && picked.length < 2 ? 'Pick at least 2 guests.' : Number(min) > Number(max) ? 'The shortest time is longer than the longest.' : '';
  const start = () => onStart({ participants: who === 'everyone' ? 'everyone' : picked, min: Number(min), max: Number(max) });
  return html`<div class="g-setup relay-setup">
    <${SelectField} label="Who passes the mic" value=${who} onChange=${setWho}
      options=${[['everyone', 'Everyone with a phone (guests who join later too)'], ['pick', 'Guests I pick']]} />
    ${who === 'pick' && html`<div class="field"><span>Participants (${picked.length})</span>
      ${store ? html`<${GuestPicker} store=${store} picked=${picked} onToggle=${toggle} />` : null}
    </div>`}
    <div class="row-2 rl-row">
      <${SelectField} label="Pass after at least" value=${min} onChange=${setMin} options=${MIN_OPTIONS} />
      <${SelectField} label="…and at most" value=${max} onChange=${setMax} options=${MAX_OPTIONS} />
    </div>
    <p class="hint">Only singing time counts: the clock stops while a song is paused and between songs. Nobody gets the mic twice in a row, and everyone gets a turn.</p>
    ${problem && html`<p class="warn-text">${problem}</p>`}
    <button class="btn primary" disabled=${busy || !!problem} onClick=${start}>Start passing the mic</button>
  </div>`;
}

export function Control({ game, act, state }) {
  const others = (state?.guests || []).filter((g) => !g.banned && !game.participants.some((p) => p.deviceId === g.deviceId));
  const status = game.ended ? `The mic was passed ${plural(game.passes, 'time')}.`
    : game.phase === 'live' ? `A song is playing — the next pass comes in about ${game.nextIn ?? '…'} s.`
      : 'Waiting for a song: the clock only runs while a song is playing.';
  return html`<div class="g-control relay-control">
    <div class="rl-holder">
      <span class="hint">Has the mic</span>
      ${game.holder ? html`<${PlayerChip} p=${game.holder} big />` : html`<b class="muted">Nobody yet</b>`}
      ${!game.ended && html`<button class="btn primary" disabled=${!game.count || (game.count < 2 && !!game.holder)} onClick=${() => act('game.action', { action: 'pass' })}>🎤 Pass the mic now</button>`}
    </div>
    <p class="hint">${status} Passes every ${game.min}–${game.max} s of singing.</p>
    ${game.stuck && !game.ended && html`<p class="warn-text">A pass was due, but there was nobody else to pass to — at least 2 participants are needed.</p>`}
    <div class="field"><span>Participants (${game.count})${game.everyone ? ' — everyone with a phone' : ''}</span>
      ${game.participants.length
        ? html`<ul class="rl-list">${game.participants.map((p) => html`<li key=${p.deviceId} class=${p.holder ? 'holder' : ''}>
            <${PlayerChip} p=${p} />
            <span class=${`dot ${p.online ? 'on' : ''}`} title=${p.online ? 'Online' : 'Phone away'}></span>
            <span class="hint num">${plural(p.turns, 'turn')}</span>
            ${!game.ended && html`<button type="button" class="icon-btn small" aria-label=${`Take ${p.name} out`} title="Take out of the game" onClick=${() => act('game.action', { action: 'remove', deviceId: p.deviceId })}>✕</button>`}
          </li>`)}</ul>`
        : html`<p class="hint">Nobody yet — guests join by opening the party page on their phone.</p>`}
    </div>
    ${!game.ended && others.length > 0 && html`<label class="field"><span>Add a guest</span>
      <select class="select" value="" onChange=${(e) => { const id = e.currentTarget.value; if (id) act('game.action', { action: 'add', deviceId: id }); }}>
        <option value="">Choose…</option>
        ${others.map((g) => html`<option value=${g.deviceId}>${g.emoji || ''} ${g.name}${g.online ? '' : ' (away)'}</option>`)}
      </select>
    </label>`}
  </div>`;
}

/** Big "PASS THE MIC ➜ NAME" over the lyrics for a few seconds, plus a small holder badge. */
export function TvOverlay({ game, st, now }) {
  useTick(250);
  if (game.ended) return null;
  const flash = game.flash && now() < game.flash.until ? game.flash : null;
  const singing = !!st.current && (st.player.state === 'playing' || st.player.state === 'paused');
  return html`
    ${flash && html`<div class="rl-flash" key=${flash.seq} role="alert">
      <span class="kick display">Pass the mic</span>
      <span class="arrow" aria-hidden="true">➜</span>
      <span class="avatar" style=${{ '--avatar': singerColor(flash.color) }}>${flash.emoji || '🎤'}</span>
      <span class="name display ellipsis">${flash.name}</span>
    </div>`}
    ${!flash && singing && game.holder && html`<div class="rl-badge"><span aria-hidden="true">🎤</span><span class="avatar" style=${{ '--avatar': singerColor(game.holder.color) }}>${game.holder.emoji || '🎤'}</span><b class="ellipsis">${game.holder.name}</b></div>`}
  `;
}

export function Tv() {
  return null;
}

export function Guest({ game, state }) {
  const singing = !!state.current && state.player?.state === 'playing';
  if (game.ended) {
    return html`<div class="g-guest relay">
      <h1 class="g-h1">Pass the mic is over</h1>
      <p class="hint">The mic went round ${plural(game.passes, 'time')}. Thanks for playing!</p>
    </div>`;
  }
  return html`<div class="g-guest relay">
    ${game.mine
      ? html`<div class=${`rl-mine ${game.flash?.mine ? 'fresh' : ''}`} role="status">
          <div class="big">🎤</div>
          <h1 class="g-h1">You have the mic!</h1>
          <p>Sing your heart out — it moves on in a little while.</p>
        </div>`
      : html`<div class="rl-now">
          <span class="hint">${game.holder ? 'The mic is with' : 'Get ready'}</span>
          ${game.holder ? html`<${PlayerChip} p=${game.holder} big />` : html`<b>The first pass is coming up</b>`}
        </div>`}
    <p class="hint">${!game.joined ? 'You’re not in this round — enjoy the show!'
      : singing ? 'Stay ready: the TV shows who’s next, and your phone buzzes when it’s you.'
        : 'The mic moves while a song is playing.'}</p>
    ${game.participants.length > 0 && html`<ul class="rl-list">${game.participants.map((p) => html`<li key=${p.id} class=${p.holder ? 'holder' : ''}>
      <${PlayerChip} p=${p} /><span class="hint num">${plural(p.turns, 'turn')}</span>
    </li>`)}</ul>`}
  </div>`;
}
