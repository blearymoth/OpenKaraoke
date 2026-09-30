// "What's next?" poll: four songs, phones vote, the winner is queued next.
import { html, useState } from '../vendor/preact.js';
import { Countdown, AnswerTile, VoteBars, SongArt, SelectField, FilterFields, ensureCss } from './common.js';
import { useFetch } from '../lib/components.js';

ensureCss('/css/games/poll.css');

export const icon = '🗳️';
export const blurb = 'Four songs, everyone votes on their phone, the winner is sung next.';

export function Setup({ onStart, busy }) {
  const facets = useFetch('/api/browse/facets');
  const [seconds, setSeconds] = useState('20');
  const [singer, setSinger] = useState('everyone');
  const [filter, setFilter] = useState({});
  return html`<div class="g-setup">
    <div class="row-2">
      <${SelectField} label="Voting time" value=${seconds} onChange=${setSeconds} options=${[['15', '15 seconds'], ['20', '20 seconds'], ['30', '30 seconds'], ['45', '45 seconds']]} />
      <${SelectField} label="The winner is sung by" value=${singer} onChange=${setSinger} options=${[['everyone', 'Everyone (sing-along)'], ['nobody', 'Nobody yet — I’ll pick a singer']]} />
    </div>
    <${FilterFields} facets=${facets.data} value=${filter} onChange=${setFilter} />
    <button class="btn primary" disabled=${busy} onClick=${() => onStart({ seconds: Number(seconds), singer, ...filter })}>Start the poll</button>
  </div>`;
}

export function Control({ game, act }) {
  return html`<div class="g-control">
    <${VoteBars} items=${game.candidates.map((c) => ({ label: `${c.title} — ${c.artist}`, votes: c.votes }))} winner=${game.winner} />
    <p class="hint">${game.total} ${game.total === 1 ? 'vote' : 'votes'} so far.${game.phase === 'result' ? ` ${game.candidates[game.winner]?.title} is next in the queue.` : ''}</p>
    ${game.queueError && html`<p class="warn-text">${game.queueError}</p>`}
    ${game.phase === 'vote' && html`<button class="btn" onClick=${() => act('game.action', { action: 'close' })}>Close voting now</button>`}
  </div>`;
}

export function Tv({ game, now }) {
  const result = game.phase !== 'vote';
  const win = game.candidates[game.winner];
  return html`<div class="scene g-tv poll fade-in">
    <header class="g-tv-head">
      <h1 class="display">${result ? 'The crowd has spoken!' : 'What’s next? Vote on your phone!'}</h1>
      ${!result && html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds} now=${now} />`}
    </header>
    ${result && win
      ? html`<div class="poll-winner">
          <${SongArt} songId=${win.songId} />
          <div><div class="kicker">${game.tie ? 'A tie — decided by lot' : `${win.votes} ${win.votes === 1 ? 'vote' : 'votes'}`}</div>
            <h2 class="display">${win.title}</h2><p>${win.artist}</p><p class="next">Up next — everybody sing!</p></div>
        </div>`
      : html`<div class="poll-grid">${game.candidates.map((c, i) => html`<div class="poll-card" key=${c.songId}>
          <${SongArt} songId=${c.songId} />
          <${AnswerTile} index=${i} sub=${c.votes}><b class="ellipsis">${c.title}</b><small class="ellipsis">${c.artist}</small></${AnswerTile}>
        </div>`)}</div>`}
    <p class="g-tv-foot">${game.total} ${game.total === 1 ? 'vote' : 'votes'}</p>
  </div>`;
}

export function Guest({ game, send, now }) {
  const result = game.phase !== 'vote';
  return html`<div class="g-guest poll">
    <h1 class="g-h1">${result ? 'The winner is…' : 'What should we sing next?'}</h1>
    ${!result && html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds} now=${now} />`}
    <div class="g-answers">${game.candidates.map((c, i) => {
      const state = result ? (i === game.winner ? 'right' : 'dim') : game.myVote === i ? 'picked' : game.myVote >= 0 ? 'dim' : 'idle';
      return html`<${AnswerTile} key=${c.songId} index=${i} state=${state} disabled=${result} onClick=${result ? undefined : () => send({ choice: i })}>
        <b class="ellipsis">${c.title}</b><small class="ellipsis">${c.artist}</small>
      </${AnswerTile}>`;
    })}</div>
    <p class="hint">${result ? 'It’s next in the queue.' : game.myVote >= 0 ? 'Vote counted — you can still change it.' : 'Tap a song to vote.'}</p>
  </div>`;
}
