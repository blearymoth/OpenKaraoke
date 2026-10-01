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

/** What the result screens say: a winner only when the vote was closed (not when the host ended the poll). */
function outcome(game) {
  const win = game.winner >= 0 ? game.candidates[game.winner] : null;
  return {
    win,
    voting: game.phase === 'vote',
    cancelled: !win && game.phase !== 'vote',
    // Only promise "up next" when the song really was queued; a sing-along only for 'everyone'.
    next: win && game.queued ? (game.singer === 'nobody' ? 'Up next!' : 'Up next — everybody sing!') : '',
  };
}

export function Control({ game, act }) {
  const [busy, setBusy] = useState(false);
  const { win, cancelled } = outcome(game);
  const close = async () => {
    setBusy(true);
    await act('game.action', { action: 'close', step: game.step }); // a double click closes it once
    setBusy(false);
  };
  let line = '';
  if (win && game.queued) line = game.phase === 'result' ? ` ${win.title} is next in the queue.` : ` ${win.title} was queued next.`;
  else if (cancelled) line = ' The poll was ended before the vote closed — nothing was queued.';
  return html`<div class="g-control">
    <${VoteBars} items=${game.candidates.map((c) => ({ label: `${c.title} — ${c.artist}`, votes: c.votes }))} winner=${game.winner} />
    <p class="hint">${game.total} ${game.total === 1 ? 'vote' : 'votes'} so far.${line}</p>
    ${game.queueError && html`<p class="warn-text">${game.queueError}</p>`}
    ${game.phase === 'vote' && html`<button class="btn" disabled=${busy} onClick=${close}>Close voting now</button>`}
  </div>`;
}

export function Tv({ game, now }) {
  const { win, voting, cancelled, next } = outcome(game);
  return html`<div class="scene g-tv poll fade-in">
    <header class="g-tv-head">
      <h1 class="display">${win ? 'The crowd has spoken!' : cancelled ? 'Poll cancelled' : 'What’s next? Vote on your phone!'}</h1>
      ${voting && html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds} now=${now} />`}
    </header>
    ${win
      ? html`<div class="poll-winner">
          <${SongArt} songId=${win.songId} />
          <div><div class="kicker">${game.tie ? 'A tie — decided by lot' : `${win.votes} ${win.votes === 1 ? 'vote' : 'votes'}`}</div>
            <h2 class="display">${win.title}</h2><p>${win.artist}</p>${next && html`<p class="next">${next}</p>`}</div>
        </div>`
      : html`<div class="poll-grid">${game.candidates.map((c, i) => html`<div class="poll-card" key=${c.songId}>
          <${SongArt} songId=${c.songId} />
          <${AnswerTile} index=${i} sub=${c.votes}><b class="ellipsis">${c.title}</b><small class="ellipsis">${c.artist}</small></${AnswerTile}>
        </div>`)}</div>`}
    <p class="g-tv-foot">${game.total} ${game.total === 1 ? 'vote' : 'votes'}</p>
  </div>`;
}

export function Guest({ game, send, now }) {
  const { win, voting, cancelled } = outcome(game);
  let hint = game.myVote >= 0 ? 'Vote counted — you can still change it.' : 'Tap a song to vote.';
  if (win) hint = game.queued ? 'It’s next in the queue.' : '';
  else if (cancelled) hint = 'Nothing was queued this time.';
  return html`<div class="g-guest poll">
    <h1 class="g-h1">${win ? 'The winner is…' : cancelled ? 'The poll was cancelled' : 'What should we sing next?'}</h1>
    ${voting && html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds} now=${now} />`}
    <div class="g-answers">${game.candidates.map((c, i) => {
      const state = win ? (i === game.winner ? 'right' : 'dim') : cancelled ? 'dim' : game.myVote === i ? 'picked' : game.myVote >= 0 ? 'dim' : 'idle';
      return html`<${AnswerTile} key=${c.songId} index=${i} state=${state} disabled=${!voting} onClick=${voting ? () => send({ choice: i }) : undefined}>
        <b class="ellipsis">${c.title}</b><small class="ellipsis">${c.artist}</small>
      </${AnswerTile}>`;
    })}</div>
    ${hint && html`<p class="hint">${hint}</p>`}
  </div>`;
}
