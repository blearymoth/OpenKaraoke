// Singing battle (PLAN §13.2): VS intro, performances with the normal karaoke on the TV, phone
// voting (A/B or 1–10), match results, knockout bracket, final podium.
import { html, useEffect, useState } from '../vendor/preact.js';
import { useStore, useDebounced } from '../lib/store.js';
import { useFetch, Switch } from '../lib/components.js';
import { Countdown, AnswerTile, SongArt, SelectField, FilterFields, Confetti, ensureCss } from './common.js';
import { ANSWER_COLORS, ANSWER_SHAPES } from '/shared/protocol.js';

ensureCss('/css/games/battle.css');

export const icon = '⚔️';
export const blurb = 'Singers go head to head; the room votes for the winner.';

const FORMATS = [['duel', 'Head-to-head duel (2 singers)'], ['knockout', 'Knockout bracket'], ['showcase', 'Showcase — everyone sings once']];
const MAX = 8;
const PHASE_SECONDS = { vs: 6, waiting: 10, result: 7, final: 12 }; // as on the server (countdown rings)

const who = (game, i) => game.contestants?.[i] || { name: 'To be decided', emoji: '❔', color: '#3a2f5c' };
const sideOf = (m, side) => (side === 'a' ? m.a : m.b);
const score1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Avatar({ c, class: cls = '' }) {
  return html`<span class=${`avatar ${cls}`} style=${{ '--avatar': c?.color }}>${c?.emoji || '🎤'}</span>`;
}

/** Who sings in the current match / showcase, in singing order. */
function lineup(game) {
  if (game.format === 'showcase') return game.perfs || [];
  const m = game.match;
  return m ? m.order.map((side) => m.perfs[side]).filter(Boolean) : [];
}

function songText(p) {
  return p?.title ? `${p.title} — ${p.artist}` : 'Song to be chosen';
}

function resultText(game, m) {
  if (!m?.decided) return '';
  const w = who(game, m.winner);
  return `${w.name} wins${m.walkover ? ' (walkover)' : ''}!`;
}

function pointsText(game, m) {
  if (!m?.points) return '';
  const { a, b } = m.points;
  return game.voting === 'score' ? `${score1(a)} – ${score1(b)}` : `${a} – ${b}`;
}

// ---- host: setup ------------------------------------------------------------------------------

/** The host app's store, loaded lazily: Setup only renders on the host page (same module). */
function useHostStore() {
  const [mod, setMod] = useState(null);
  useEffect(() => {
    import('../host/state.js').then(setMod, () => {});
  }, []);
  return mod?.store || null;
}

function SingerChips({ store, picked, onToggle }) {
  const { state } = useStore(store);
  const singers = (state?.singers || []).filter((s) => s.name && s.name !== 'Everyone');
  if (!singers.length) return html`<p class="hint">No singers yet — type names below.</p>`;
  return html`<div class="bt-chips">${singers.map((s) => {
    const on = picked.some((p) => p.singerId === s.id);
    return html`<button type="button" key=${s.id} class=${`chip ${on ? 'on' : ''}`} aria-pressed=${on} onClick=${() => onToggle(s)}>${s.emoji} ${s.name}</button>`;
  })}</div>`;
}

export function Setup({ onStart, busy }) {
  const store = useHostStore();
  const facets = useFetch('/api/browse/facets');
  const [picked, setPicked] = useState([]); // [{ singerId?, name, emoji?, color? }]
  const [name, setName] = useState('');
  const [format, setFormat] = useState('duel');
  const [rounds, setRounds] = useState('1');
  const [songMode, setSongMode] = useState('random');
  const [snippet, setSnippet] = useState('90');
  const [voting, setVoting] = useState('ab');
  const [voteSeconds, setVoteSeconds] = useState('20');
  const [judges, setJudges] = useState(false);
  const [judgeWeight, setJudgeWeight] = useState('3');
  const [auto, setAuto] = useState(false);
  const [filter, setFilter] = useState({});
  const toggle = (s) => setPicked((list) => (list.some((p) => p.singerId === s.id)
    ? list.filter((p) => p.singerId !== s.id)
    : list.length < MAX ? [...list, { singerId: s.id, name: s.name, emoji: s.emoji, color: s.color }] : list));
  const addName = () => {
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n || picked.length >= MAX || picked.some((p) => p.name.toLowerCase() === n.toLowerCase())) return;
    setPicked([...picked, { name: n }]);
    setName('');
  };
  const count = picked.length;
  const problem = count < 2 ? 'Pick at least 2 contestants.'
    : format === 'duel' && count !== 2 ? 'A duel is for exactly 2 singers — choose knockout or showcase for more.' : '';
  const start = () => onStart({
    contestants: picked.map((p) => (p.singerId ? { singerId: p.singerId } : { name: p.name })),
    format, rounds: Number(rounds), songMode, snippet: Number(snippet), voting: format === 'showcase' ? 'score' : voting,
    voteSeconds: Number(voteSeconds), judges, judgeWeight: Number(judgeWeight), auto, ...filter,
  });
  return html`<div class="g-setup battle-setup">
    <div class="field"><span>Contestants (${count}/${MAX})</span>
      ${store ? html`<${SingerChips} store=${store} picked=${picked} onToggle=${toggle} />` : null}
      <div class="inline-form bt-add">
        <input class="input" placeholder="Add a name…" value=${name} maxlength="40" onInput=${(e) => setName(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }} aria-label="Contestant name" />
        <button type="button" class="btn" onClick=${addName} disabled=${!name.trim() || count >= MAX}>Add</button>
      </div>
      ${count > 0 && html`<ol class="bt-picked">${picked.map((p, i) => html`<li key=${p.singerId || p.name}>
        <span class="num">${i + 1}</span><${Avatar} c=${p} /><span class="ellipsis">${p.name}</span>
        <button type="button" class="icon-btn small" aria-label=${`Remove ${p.name}`} onClick=${() => setPicked(picked.filter((x) => x !== p))}>✕</button>
      </li>`)}</ol>`}
    </div>
    <div class="row-3">
      <${SelectField} label="Format" value=${format} onChange=${setFormat} options=${FORMATS} />
      ${format === 'duel'
        ? html`<${SelectField} label="Rounds" value=${rounds} onChange=${setRounds} options=${[['1', 'One round'], ['2', 'Two rounds'], ['3', 'Best of three']]} />`
        : html`<div class="field"><span>Order</span><div class="bt-static">${format === 'knockout' ? 'Random draw into a bracket' : 'Random order'}</div></div>`}
      <${SelectField} label="Songs" value=${songMode} onChange=${setSongMode} options=${[
        ['same', format === 'showcase' ? 'Same song for everyone' : 'Same song for both singers'],
        ['random', 'Random song per performance'],
        ['pick', 'I pick each song'],
      ]} />
    </div>
    <div class="row-3">
      <${SelectField} label="Song length" value=${snippet} onChange=${setSnippet} options=${[['0', 'Full song'], ['90', '90 seconds'], ['60', '60 seconds']]} />
      <${SelectField} label="Phones vote" value=${format === 'showcase' ? 'score' : voting} onChange=${setVoting}
        options=${format === 'showcase' ? [['score', 'Score each performance 1–10']] : [['ab', 'Pick the better performance'], ['score', 'Score each performance 1–10']]} />
      <${SelectField} label="Voting time" value=${voteSeconds} onChange=${setVoteSeconds} options=${[['15', '15 seconds'], ['20', '20 seconds'], ['30', '30 seconds'], ['45', '45 seconds']]} />
    </div>
    ${songMode !== 'pick' && html`<${FilterFields} facets=${facets.data} value=${filter} onChange=${setFilter} />`}
    <div class="bt-toggles">
      <div class="bt-toggle"><${Switch} checked=${judges} onChange=${setJudges} label="Judges" />
        <span>Judges: I enter a 1–10 score per performance${judges ? ',' : ''}</span>
        ${judges && html`<select class="select bt-weight" value=${judgeWeight} aria-label="Judges' weight" onChange=${(e) => setJudgeWeight(e.currentTarget.value)}>
          ${[1, 2, 3, 5, 10].map((n) => html`<option value=${n}>worth ${n} ${n === 1 ? 'vote' : 'votes'}</option>`)}
        </select>`}
      </div>
      <div class="bt-toggle"><${Switch} checked=${auto} onChange=${setAuto} label="Start performances automatically" />
        <span>Start each performance by itself (10 s after the intro)</span></div>
    </div>
    <p class="hint">Contestants can’t vote in their own match. Ties are decided by lot.</p>
    ${problem && count > 0 && html`<p class="warn-text">${problem}</p>`}
    <button class="btn primary" disabled=${busy || !!problem} onClick=${start}>Start the battle</button>
  </div>`;
}

// ---- host: live controls ------------------------------------------------------------------------

function SongSearch({ onPick }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const res = useFetch(dq.length >= 2 ? '/api/search' : null, { q: dq, limit: 6 });
  return html`<div class="bt-search">
    <input class="input" type="search" placeholder="Search a song…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Search a song" />
    ${dq.length >= 2 && html`<ul>${(res.data?.items || []).map((s) => html`<li key=${s.id}>
      <span class="ellipsis"><b>${s.title}</b> <span class="muted">${s.artist}</span></span>
      <button type="button" class="btn small" onClick=${() => { onPick(s.id); setQ(''); }}>Choose</button>
    </li>`)}${res.data && !res.data.items.length ? html`<li class="muted">No songs found.</li>` : null}</ul>`}
  </div>`;
}

function JudgeButtons({ p, act }) {
  return html`<div class="bt-judge" role="group" aria-label="Judges' score">
    <span class="hint">Judges</span>
    ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`<button type="button" class=${`bt-jbtn ${p.judge === n ? 'on' : ''}`} aria-pressed=${p.judge === n}
      onClick=${() => act('game.action', { action: 'judge', perfId: p.id, score: p.judge === n ? 0 : n })}>${n}</button>`)}
  </div>`;
}

function PerfRow({ game, p, act, canSong, canJudge, label }) {
  const c = who(game, p.c);
  const [open, setOpen] = useState(false);
  const status = { pending: 'waiting', singing: 'singing now', done: 'sang', skipped: 'skipped' }[p.status];
  return html`<div class=${`bt-perf s-${p.status}`}>
    <div class="bt-perf-head">
      ${label && html`<span class="bt-side" style=${{ '--answer': ANSWER_COLORS[label === 'A' ? 0 : 1] }}>${label}</span>`}
      <${Avatar} c=${c} />
      <b class="ellipsis">${c.name}</b>
      <span class="pill">${status}</span>
      ${game.voting === 'score' && p.score !== undefined && p.status !== 'pending' ? html`<span class="pill bulb num">${score1(p.score)} · ${plural(p.votes, 'vote')}</span>` : null}
    </div>
    <div class="bt-perf-song">
      <span class="ellipsis">${p.title ? html`<b>${p.title}</b> <span class="muted">${p.artist}</span>` : html`<span class="warn-text">${game.songMode === 'pick' ? 'Pick a song' : 'Random song'}</span>`}</span>
      ${canSong && html`<button type="button" class="btn small ghost" onClick=${() => setOpen(!open)}>${open ? 'Done' : 'Change song'}</button>`}
      ${canSong && html`<button type="button" class="btn small ghost" title="Another random song" onClick=${() => act('game.action', { action: 'song', perfId: p.id, random: true })}>🎲 Random</button>`}
    </div>
    ${canSong && (open || (game.songMode === 'pick' && !p.title)) && html`<${SongSearch} onPick=${(songId) => { act('game.action', { action: 'song', perfId: p.id, songId }); setOpen(false); }} />`}
    ${canJudge && html`<${JudgeButtons} p=${p} act=${act} />`}
  </div>`;
}

function phaseText(game) {
  const next = game.perf || game.next;
  const n = next && who(game, next.c).name;
  switch (game.phase) {
    case 'vs': return game.match ? `Intro: ${who(game, game.match.a).name} vs ${who(game, game.match.b).name}` : 'Intro: meet the contestants';
    case 'waiting': return game.auto ? `${n} starts in a moment` : `Waiting for ${n} — press Start when they have the mic`;
    case 'singing': return game.stalled ? 'The song was stopped from the player.' : `${n} is singing`;
    case 'score': return `Phones are scoring ${n}`;
    case 'vote': return 'Phones are voting for the better performance';
    case 'result': return resultText(game, game.match);
    case 'final':
    case 'done': return game.champion >= 0 ? `${who(game, game.champion).name} wins the battle!` : game.ranking ? 'Nobody sang — no winner this time.' : 'The battle was ended early.';
    default: return '';
  }
}

export function Control({ game, act, now }) {
  const ph = game.phase;
  const m = game.match;
  const [busy, setBusy] = useState(false);
  // `step`: the server ignores the click once the battle has moved on (a double click on
  // "Close voting now" must not skip the result screen).
  const run = async (action) => {
    setBusy(true);
    await act('game.action', { action, step: game.step });
    setBusy(false);
  };
  const lock = (p) => p.status === 'pending' && (game.songMode !== 'same' || lineup(game).every((x) => x.status === 'pending'));
  const canSong = (p) => !game.ended && lock(p) && (game.format !== 'showcase' || p.id === game.perf?.id || (ph === 'vs' && p.id === game.next?.id));
  const canJudge = (p) => game.judges && !game.ended && (p.status === 'done' || p.status === 'singing') && !m?.decided && !game.ranking;
  const perfs = lineup(game);
  return html`<div class="g-control battle-control">
    <div class="bt-status">
      <span class="kicker">${m ? m.label : game.format === 'showcase' ? 'Showcase' : 'Battle'}</span>
      <b>${phaseText(game)}</b>
      ${game.endsAt > 0 && html`<${Countdown} endsAt=${game.endsAt} total=${ph === 'vote' || ph === 'score' ? game.voteSeconds : PHASE_SECONDS[ph] || 10} now=${now} />`}
    </div>
    ${game.error && html`<p class="warn-text">${game.error}</p>`}
    ${!game.ended && html`<div class="btn-row">
      ${(ph === 'vs' || ph === 'waiting') && html`<button class="btn primary" disabled=${busy} onClick=${() => run('start')}>▶ Start performance</button>`}
      ${game.stalled && html`<button class="btn primary" disabled=${busy} onClick=${() => run('start')}>▶ Sing it again</button>`}
      ${(ph === 'vs' || ph === 'waiting' || ph === 'singing') && html`<button class="btn" disabled=${busy} onClick=${() => confirm('Skip this performance? It gets no votes.') && act('game.action', { action: 'skip' })}>Skip performance</button>`}
      ${(ph === 'vote' || ph === 'score') && html`<button class="btn" disabled=${busy} onClick=${() => run('close')}>Close voting now</button>`}
      ${(ph === 'result' || ph === 'final') && html`<button class="btn" disabled=${busy} onClick=${() => run('next')}>Continue</button>`}
    </div>`}
    ${ph === 'singing' && !game.stalled && html`<p class="hint">Next on the player bar ends the performance early (voting still happens).</p>`}
    ${m && ph === 'vote' && m.votes && html`<${VoteSplit} game=${game} m=${m} />`}
    ${ph === 'result' && m?.points && html`<p class="bt-points"><b>${pointsText(game, m)}</b>${m.lot ? ' — a tie, decided by lot' : ''}${m.judged ? ` · judges picked ${who(game, sideOf(m, m.judged)).name} (+${game.judgeWeight})` : ''}</p>`}
    ${perfs.length > 0 && !game.ranking && html`<div class="bt-perfs">${perfs.map((p) => html`<${PerfRow} key=${p.id} game=${game} p=${p} act=${act}
      canSong=${canSong(p)} canJudge=${canJudge(p)} label=${m ? p.side.toUpperCase() : ''} />`)}</div>`}
    ${game.format === 'knockout' && html`<${Bracket} game=${game} />`}
    ${game.format === 'duel' && game.rounds > 1 && html`<p class="hint">Rounds won: ${who(game, 0).name} ${game.wins?.[0] || 0} – ${game.wins?.[1] || 0} ${who(game, 1).name}</p>`}
    ${game.ranking && html`<${Standings} game=${game} />`}
  </div>`;
}

// ---- shared pieces -------------------------------------------------------------------------------

function VoteSplit({ game, m }) {
  const total = (m.votes?.a || 0) + (m.votes?.b || 0);
  return html`<div class="bt-split">${['a', 'b'].map((side, i) => {
    const n = m.votes?.[side] || 0;
    return html`<div class="bt-split-row" style=${{ '--answer': ANSWER_COLORS[i] }}>
      <span class="shape" aria-hidden="true">${ANSWER_SHAPES[i]}</span>
      <span class="ellipsis">${who(game, sideOf(m, side)).name}</span>
      <span class="bar"><i style=${{ width: `${total ? (n / total) * 100 : 0}%` }}></i></span>
      <b class="num">${n}</b>
    </div>`;
  })}</div>`;
}

/** Knockout bracket: one column per round. */
export function Bracket({ game }) {
  const rounds = [];
  for (const m of game.matches || []) (rounds[m.round] ||= []).push(m);
  const current = game.match?.id;
  const line = (m, side) => {
    const i = sideOf(m, side);
    if (i < 0) return html`<div class="bt-bline tbd"><span class="ellipsis">${m.bye && side === 'b' ? 'bye' : '…'}</span></div>`;
    const c = who(game, i);
    const cls = m.decided && !m.bye ? (m.winner === i ? 'win' : 'out') : '';
    return html`<div class=${`bt-bline ${cls}`}><${Avatar} c=${c} /><span class="ellipsis">${c.name}</span></div>`;
  };
  return html`<div class="bt-bracket" style=${{ '--cols': rounds.length }}>${rounds.map((list, r) => html`<div class="bt-bcol" key=${r}>
    <div class="bt-bhead">${list[0] ? list[0].label.replace(/ \d+$/, '') : ''}</div>
    ${list.map((m) => html`<div class=${`bt-bmatch ${m.id === current && !game.ranking ? 'now' : ''} ${m.bye ? 'bye' : ''}`} key=${m.id}>${line(m, 'a')}${line(m, 'b')}</div>`)}
  </div>`)}</div>`;
}

function Standings({ game, highlight = -1 }) {
  const value = (r) => (game.format === 'showcase' ? (r.skipped ? 'skipped' : score1(r.score))
    : game.format === 'duel' ? plural(r.wins, 'round') + (game.voting === 'ab' ? ` · ${plural(r.points, 'vote')}` : ` · ${score1(r.points)} pts`)
      : r.note);
  return html`<ol class="bt-standings">${game.ranking.map((r) => {
    const c = who(game, r.c);
    return html`<li key=${r.c} class=${r.c === highlight ? 'me' : ''}>
      <span class="rank num">${r.place}</span><${Avatar} c=${c} /><span class="ellipsis">${c.name}</span><b class="num">${value(r)}</b>
    </li>`;
  })}</ol>`;
}

// ---- TV ------------------------------------------------------------------------------------------

function Fighter({ game, p, c, side }) {
  return html`<div class=${`bt-fighter side-${side}`}>
    <span class="bt-avatar" style=${{ '--c': c.color }}>${c.emoji || '🎤'}</span>
    <b class="display ellipsis">${c.name}</b>
    ${game.songMode !== 'same' && html`<span class="ellipsis">${songText(p)}</span>`}
  </div>`;
}

function TvHead({ game, title, now, total }) {
  const kicker = game.match ? `⚔️ Battle · ${game.match.label}` : '⚔️ Battle · Showcase';
  return html`<header class="g-tv-head">
    <div class="bt-head"><div class="kicker">${kicker}</div><h1 class="display">${title}</h1></div>
    ${game.endsAt > 0 && total ? html`<${Countdown} endsAt=${game.endsAt} total=${total} now=${now} />` : null}
  </header>`;
}

function VsScene({ game, now }) {
  const m = game.match;
  if (!m) {
    return html`<div class="scene g-tv battle fade-in">
      <${TvHead} game=${game} title="Meet the contestants!" />
      <div class="bt-lineup">${(game.perfs || []).map((p, i) => {
        const c = who(game, p.c);
        return html`<div class="bt-lineup-item" key=${p.id} style=${{ animationDelay: `${i * 0.15}s` }}>
          <span class="bt-avatar" style=${{ '--c': c.color }}>${c.emoji}</span><b class="ellipsis">${c.name}</b><span class="num">#${i + 1}</span>
        </div>`;
      })}</div>
      <p class="g-tv-foot">${game.songMode === 'same' && game.perfs?.[0]?.title ? `Everyone sings “${game.perfs[0].title}”. ` : ''}Score every performance from 1 to 10 on your phone — the best average wins!</p>
    </div>`;
  }
  const same = game.songMode === 'same' && m.perfs.a?.title;
  return html`<div class="scene g-tv battle fade-in">
    <${TvHead} game=${game} title=${game.format === 'duel' && game.rounds > 1 ? `Round ${m.round + 1}` : m.label === 'Final' ? 'The final!' : 'Get ready to vote!'} />
    <div class="bt-versus">
      <${Fighter} game=${game} p=${m.perfs.a} c=${who(game, m.a)} side="a" />
      <div class="bt-vs-mark display">VS</div>
      <${Fighter} game=${game} p=${m.perfs.b} c=${who(game, m.b)} side="b" />
    </div>
    <p class="g-tv-foot">${same ? html`Both sing <b>“${m.perfs.a.title}”</b> by ${m.perfs.a.artist}` : game.voting === 'ab' ? 'Vote for the better performance on your phone after both have sung' : 'Score each performance 1–10 on your phone'}</p>
  </div>`;
}

function Aside({ game }) {
  if (game.format === 'knockout') return html`<div class="bt-aside"><${Bracket} game=${game} /></div>`;
  if (game.format === 'showcase') {
    const done = (game.perfs || []).filter((p) => p.score !== undefined || p.status === 'skipped');
    if (!done.length) return null;
    const rows = [...done].sort((x, y) => (y.status === 'skipped' ? -1 : y.score) - (x.status === 'skipped' ? -1 : x.score));
    return html`<div class="bt-aside"><h3>Scores so far</h3><ol class="bt-standings">${rows.map((p, i) => {
      const c = who(game, p.c);
      return html`<li key=${p.id}><span class="rank num">${i + 1}</span><${Avatar} c=${c} /><span class="ellipsis">${c.name}</span><b class="num">${p.status === 'skipped' ? '–' : score1(p.score)}</b></li>`;
    })}</ol></div>`;
  }
  const m = game.match;
  if (!m) return null;
  return html`<div class="bt-aside"><h3>${m.label}</h3><ol class="bt-standings">${m.order.map((side) => {
    const p = m.perfs[side];
    const c = who(game, sideOf(m, side));
    return html`<li key=${side}><${Avatar} c=${c} /><span class="ellipsis">${c.name}</span><b>${p.status === 'done' ? (p.score !== undefined ? score1(p.score) : '✓') : p.status === 'skipped' ? 'skipped' : p.id === game.perf?.id ? 'next' : '…'}</b></li>`;
  })}</ol>${game.format === 'duel' && game.rounds > 1 ? html`<p class="bt-series">Rounds ${game.wins?.[0] || 0} – ${game.wins?.[1] || 0}</p>` : null}</div>`;
}

function NextUpScene({ game, now }) {
  const p = game.perf;
  if (!p) return html`<div class="scene g-tv battle fade-in"><${TvHead} game=${game} title="Battle" /></div>`;
  const c = who(game, p.c);
  const stopped = game.phase === 'singing';
  return html`<div class="scene g-tv battle fade-in" key=${p.id}>
    <${TvHead} game=${game} title=${`Next up: ${c.name}`} now=${now} total=${game.auto && game.phase === 'waiting' ? 10 : 0} />
    <div class="bt-nextup">
      <div class="bt-nextup-main">
        <div class="bt-cover">${p.songId ? html`<${SongArt} songId=${p.songId} />` : html`<div class="bt-cover-empty">🎵</div>`}
          <span class="bt-avatar" style=${{ '--c': c.color }}>${c.emoji}</span></div>
        <div class="bt-nextup-text">
          <b class="display">${p.title || 'Song to be chosen'}</b>
          ${p.artist && html`<span>${p.artist}</span>`}
          <em>${stopped ? 'Paused — the host will carry on in a moment' : game.auto ? 'Get ready!' : 'Grab the mic — the host starts the song'}</em>
        </div>
      </div>
      <${Aside} game=${game} />
    </div>
  </div>`;
}

function ScoreScene({ game, now }) {
  const p = game.perf;
  const c = who(game, p?.c);
  return html`<div class="scene g-tv battle fade-in" key=${p?.id}>
    <${TvHead} game=${game} title=${`Score ${c.name}!`} now=${now} total=${game.voteSeconds} />
    <div class="bt-score">
      <span class="bt-avatar" style=${{ '--c': c.color }}>${c.emoji}</span>
      <div><b class="display">1 – 10</b><span>Give ${c.name} a score for “${p?.title}” on your phone</span>
        <em class="num">${plural(p?.votes || 0, 'vote')}</em></div>
    </div>
    <p class="g-tv-foot">${game.format === 'showcase' ? 'Contestants don’t vote in a showcase.' : 'The singers in this match can’t vote.'}</p>
  </div>`;
}

function VoteScene({ game, now }) {
  const m = game.match;
  const total = (m.votes?.a || 0) + (m.votes?.b || 0);
  return html`<div class="scene g-tv battle fade-in">
    <${TvHead} game=${game} title="Who sang it better? Vote now!" now=${now} total=${game.voteSeconds} />
    <div class="bt-vote">${['a', 'b'].map((side, i) => {
      const c = who(game, sideOf(m, side));
      const n = m.votes?.[side] || 0;
      return html`<div class="bt-vote-card" style=${{ '--answer': ANSWER_COLORS[i] }} key=${side}>
        <div class="bt-vote-top"><span class="shape">${ANSWER_SHAPES[i]}</span><span class="bt-avatar small" style=${{ '--c': c.color }}>${c.emoji}</span>
          <div class="ellipsis"><b class="display ellipsis">${c.name}</b><span class="ellipsis">${m.perfs[side]?.title || ''}</span></div></div>
        <div class="bt-vote-bar"><i style=${{ width: `${total ? (n / total) * 100 : 0}%` }}></i></div>
        <b class="bt-vote-num num">${n}</b>
      </div>`;
    })}</div>
    <p class="g-tv-foot">${plural(total, 'vote')}${game.judges ? ` · the judges’ pick counts as ${plural(game.judgeWeight, 'vote')}` : ''} · the singers can’t vote</p>
  </div>`;
}

function ResultScene({ game }) {
  const m = game.match;
  const w = who(game, m.winner);
  const perfOf = (side) => m.perfs[side];
  return html`<div class="scene g-tv battle fade-in">
    <${Confetti} run=${m.id} count=${60} />
    <${TvHead} game=${game} title=${resultText(game, m)} />
    <div class="bt-result">
      <div class="bt-winner"><span class="crown">👑</span><span class="bt-avatar" style=${{ '--c': w.color }}>${w.emoji}</span></div>
      <div class="bt-result-text">
        ${['a', 'b'].map((side) => {
          const c = who(game, sideOf(m, side));
          const p = perfOf(side);
          return html`<div class=${`bt-result-row ${m.winner === sideOf(m, side) ? 'win' : ''}`} key=${side}>
            <${Avatar} c=${c} /><span class="ellipsis">${c.name}</span>
            <b class="num">${p?.status === 'skipped' ? 'skipped' : game.voting === 'score' ? score1(m.points[side]) : plural(m.points[side], 'vote')}</b>
            ${p?.judge || p?.reactions ? html`<small>${[p.judge ? `judges ${p.judge}` : '', p.reactions ? `${p.reactions} ❤` : ''].filter(Boolean).join(' · ')}</small>` : null}
          </div>`;
        })}
        ${m.lot && html`<p class="kicker">A tie — decided by lot!</p>`}
        ${m.judged && html`<p class="muted">Judges’ pick: ${who(game, sideOf(m, m.judged)).name} (+${game.judgeWeight})</p>`}
      </div>
      ${game.format === 'knockout' && html`<div class="bt-aside"><${Bracket} game=${game} /></div>`}
      ${game.format === 'duel' && game.rounds > 1 && html`<div class="bt-aside"><h3>Rounds</h3><p class="bt-series big">${who(game, 0).name} ${game.wins?.[0] || 0} – ${game.wins?.[1] || 0} ${who(game, 1).name}</p></div>`}
    </div>
  </div>`;
}

function FinalScene({ game }) {
  if (game.champion < 0 || !game.ranking) {
    return html`<div class="scene g-tv battle fade-in"><${TvHead} game=${game} title="The battle is over" /><p class="g-tv-foot">Thanks for singing!</p></div>`;
  }
  const w = who(game, game.champion);
  return html`<div class="scene g-tv battle fade-in">
    <${Confetti} run=${game.id} />
    <header class="g-tv-head"><div class="bt-head"><div class="kicker">⚔️ Battle${game.finalLot ? ' · a tie, decided by lot' : ''}</div><h1 class="display">${w.name} wins the battle!</h1></div></header>
    <div class="bt-final">
      <div class="bt-champion"><span class="crown">🏆</span><span class="bt-avatar huge" style=${{ '--c': w.color }}>${w.emoji}</span><b class="display ellipsis">${w.name}</b></div>
      <${Standings} game=${game} highlight=${game.champion} />
    </div>
  </div>`;
}

export function Tv({ game, now }) {
  const ph = game.phase;
  if (!game.contestants) return null;
  if (ph === 'final' || ph === 'done') return html`<${FinalScene} game=${game} />`;
  if (ph === 'vs') return html`<${VsScene} game=${game} now=${now} />`;
  if (ph === 'score') return html`<${ScoreScene} game=${game} now=${now} />`;
  if (ph === 'vote' && game.match) return html`<${VoteScene} game=${game} now=${now} />`;
  if (ph === 'result' && game.match) return html`<${ResultScene} game=${game} />`;
  return html`<${NextUpScene} game=${game} now=${now} />`;
}

/** During a battle song: a small "who's battling" badge over the karaoke. */
export function TvOverlay({ game, st }) {
  if (game.ended || !st.current || st.current.game !== game.id || !game.contestants) return null;
  const m = game.match;
  const label = m ? m.label : `Showcase · ${(game.perfs || []).findIndex((p) => p.id === game.perf?.id) + 1} of ${game.perfs?.length || 0}`;
  return html`<div class="bt-badge">
    <span class="bt-badge-kicker">⚔️ ${label}</span>
    ${m && html`<span class="bt-badge-vs"><${Avatar} c=${who(game, m.a)} /><span class="ellipsis">${who(game, m.a).name}</span><em>vs</em><${Avatar} c=${who(game, m.b)} /><span class="ellipsis">${who(game, m.b).name}</span></span>`}
  </div>`;
}

// ---- phones --------------------------------------------------------------------------------------

function NotVoting({ game }) {
  return html`<p class="bt-own">${game.me >= 0 ? 'You’re in this battle — let the others vote 😉' : 'Choose a name on the Me tab to vote.'}</p>`;
}

export function Guest({ game, send, now }) {
  const ph = game.phase;
  const m = game.match;
  if (!game.contestants) return null;
  if (ph === 'final' || ph === 'done') {
    const w = game.champion >= 0 ? who(game, game.champion) : null;
    return html`<div class="g-guest battle">
      <h1 class="g-h1">${w ? `${w.name} wins the battle! 🏆` : 'The battle is over'}</h1>
      ${game.finalLot && html`<p class="hint">A tie — decided by lot.</p>`}
      ${game.ranking && html`<${Standings} game=${game} highlight=${game.me} />`}
    </div>`;
  }
  if (ph === 'vote' && m) {
    return html`<div class="g-guest battle">
      <h1 class="g-h1">Who sang it better?</h1>
      <${Countdown} endsAt=${game.endsAt} total=${game.voteSeconds} now=${now} />
      ${game.canVote
        ? html`<div class="g-answers">${['a', 'b'].map((side, i) => {
          const c = who(game, sideOf(m, side));
          const state = game.myPick === side ? 'picked' : game.myPick ? 'dim' : 'idle';
          return html`<${AnswerTile} key=${side} index=${i} state=${state} onClick=${() => send({ pick: side })}>
            <b class="ellipsis">${c.emoji} ${c.name}</b><small class="ellipsis">${m.perfs[side]?.title || ''}</small>
          </${AnswerTile}>`;
        })}</div>
        <p class="hint">${game.myPick ? 'Vote counted — you can still change it.' : 'Tap the better performance.'}</p>`
        : html`<${NotVoting} game=${game} />`}
    </div>`;
  }
  if (ph === 'score') {
    const c = who(game, game.perf?.c);
    return html`<div class="g-guest battle">
      <h1 class="g-h1">Score ${c.name}!</h1>
      <${Countdown} endsAt=${game.endsAt} total=${game.voteSeconds} now=${now} />
      ${game.canVote
        ? html`<div class="bt-scores" role="radiogroup" aria-label="Score">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`<button role="radio" aria-checked=${game.myScore === n}
            class=${game.myScore === n ? 'on' : ''} onClick=${() => send({ score: n })}>${n}</button>`)}</div>
          <p class="hint">${game.myScore ? `You gave ${game.myScore} — you can still change it.` : `How good was “${game.perf?.title}”? 10 is the best.`}</p>`
        : html`<${NotVoting} game=${game} />`}
    </div>`;
  }
  if (ph === 'result' && m) {
    return html`<div class="g-guest battle">
      <h1 class="g-h1">${resultText(game, m)}</h1>
      <p class="bt-guest-points num">${pointsText(game, m)}${game.voting === 'ab' ? ' votes' : ''}</p>
      ${m.lot && html`<p class="hint">A tie — decided by lot.</p>`}
      ${game.myPick && html`<p class="hint">You voted for ${who(game, sideOf(m, game.myPick)).name}.</p>`}
    </div>`;
  }
  // vs / waiting / singing
  const p = game.perf || game.next;
  const c = p && who(game, p.c);
  const mine = p && p.c === game.me;
  return html`<div class="g-guest battle">
    ${m ? html`<div class="bt-guest-vs">
        <span><${Avatar} c=${who(game, m.a)} /><b class="ellipsis">${who(game, m.a).name}</b></span>
        <em>vs</em>
        <span><${Avatar} c=${who(game, m.b)} /><b class="ellipsis">${who(game, m.b).name}</b></span>
      </div><p class="hint">${m.label}</p>`
      : html`<h1 class="g-h1">Showcase</h1>`}
    ${p && html`<div class=${`bt-guest-next ${mine ? 'mine' : ''}`}>
      <small>${ph === 'singing' ? 'Singing now' : 'Next up'}</small>
      <b>${mine ? (ph === 'singing' ? 'You — go go go! 🎤' : 'You! Head to the mic 🎤') : c.name}</b>
      <span class="ellipsis">${songText(p)}</span>
    </div>`}
    <p class="hint">${game.voting === 'ab' ? 'Voting opens after both performances.' : 'Scoring opens right after each performance.'}${game.me >= 0 ? ' Contestants can’t vote in their own match.' : ''}</p>
  </div>`;
}
