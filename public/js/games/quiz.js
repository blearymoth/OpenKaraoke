// Music quiz (PLAN §13.1): host setup and controls, the TV show (clips, lyrics screens, zooming
// covers, answers, leaderboards, podium) and the phones' answer pad.
//
// Audio: the server puts a clip descriptor in the TV view only ({ q, kind, trackId, url, start,
// dur, semitones, rate, reverse, reveal… }). The main display decodes the track with the karaoke
// AudioEngine, keeps just the slices it needs, and plays them between songs (no song is current
// while the quiz runs). When the clip starts it reports tv.game { event: 'clip', q } so the
// server can start the answer timer.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Countdown, AnswerTile, Leaderboard, Podium, PlayerChip, SongArt, Confetti, SelectField, FilterFields, ensureCss } from './common.js';
import { useFetch } from '../lib/components.js';
import { CdgRenderer } from '../lib/cdg-canvas.js';
import { qrSrc } from '../lib/theme.js';
import { findLyricsFrame } from '/shared/cdg.js';
import { QUIZ_ROUNDS, QUIZ_ROUND_INFO } from '/shared/quiz.js';
import { usePhaseControl } from './phase-control.js';

ensureCss('/css/games/quiz.css');

export const icon = '❓';
export const blurb = 'Guess the song from its intro, lyrics or cover — fastest right answer wins.';

const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
/** "Ana", "Ana & Ben", "Ana, Ben & Cy" — or "4 players" when the list gets long. */
const names = (list) => (list.length > 3 ? `${list.length} players` : list.length > 1 ? `${list.slice(0, -1).join(', ')} & ${list.at(-1)}` : list[0] || '');

// ---- host ------------------------------------------------------------------------------------

export function Setup({ onStart, busy }) {
  const facets = useFetch('/api/browse/facets');
  const [questions, setQuestions] = useState('10');
  const [seconds, setSeconds] = useState('20');
  const [rounds, setRounds] = useState(QUIZ_ROUNDS);
  const [popular, setPopular] = useState(false);
  const [filter, setFilter] = useState({});
  const toggle = (r) => setRounds((list) => QUIZ_ROUNDS.filter((x) => (x === r ? !list.includes(r) : list.includes(x))));
  return html`<div class="g-setup quiz-setup">
    <div class="row-3">
      <${SelectField} label="Questions" value=${questions} onChange=${setQuestions} options=${[5, 10, 15, 20, 25, 30].map((n) => [String(n), `${n} questions`])} />
      <${SelectField} label="Time to answer" value=${seconds} onChange=${setSeconds} options=${[10, 15, 20, 25, 30].map((n) => [String(n), `${n} seconds`])} />
      <div class="field"><span>Songs</span>
        <label class="qz-switch">
          <span class="switch"><input type="checkbox" checked=${popular} onChange=${(e) => setPopular(e.currentTarget.checked)} /><span></span></span>
          Only popular songs
        </label>
      </div>
    </div>
    <div class="field"><span>Round types</span>
      <div class="chips qz-rounds">${QUIZ_ROUNDS.map((r) => {
        const info = QUIZ_ROUND_INFO[r];
        const on = rounds.includes(r);
        return html`<button type="button" key=${r} class=${`chip ${on ? 'on' : ''}`} aria-pressed=${on} title=${info.hint} onClick=${() => toggle(r)}>${info.icon} ${info.label}</button>`;
      })}</div>
      <span class="hint">${rounds.length ? 'Round types take turns. Cover and decade rounds only use songs with artwork or a known year.' : 'Pick at least one round type.'}</span>
    </div>
    <${FilterFields} facets=${facets.data} value=${filter} onChange=${setFilter} />
    <button class="btn primary" disabled=${busy || !rounds.length} onClick=${() => onStart({ questions: Number(questions), seconds: Number(seconds), rounds, popular, ...filter })}>Start the quiz</button>
  </div>`;
}

const NEXT_LABEL = {
  'get-ready': 'Start the question now',
  question: 'Close the question',
  reveal: 'Next',
  leaderboard: 'Next question',
  final: 'Finish',
};

function statusText(game) {
  switch (game.phase) {
    case 'get-ready': return 'Get ready — the TV is loading the clip.';
    case 'question': return game.open ? `${game.answered} of ${Math.max(game.expected, game.answered)} answered` : 'Starting the clip on the TV…';
    case 'reveal': return `${plural(game.reveal?.rightCount || 0, 'player')} got it right.`;
    case 'leaderboard': return 'The leaderboard is on the TV.';
    case 'final': return 'The podium is on the TV.';
    default: return 'The quiz is over.';
  }
}

export function Control({ game, act, now }) {
  const r = game.round;
  const rv = game.reveal;
  const over = game.phase === 'final' || game.ended;
  // A double click never also presses the next phase's button (skipping the reveal, or opening
  // the answers before the TV has played the clip).
  const [busy, run] = usePhaseControl(game, act);
  return html`<div class="g-control quiz-control">
    <div class="qz-host-status">
      <${Countdown} endsAt=${game.endsAt} total=${game.phaseSeconds || game.seconds} now=${now} />
      <div class="qz-host-text">
        <b>${over ? 'Final results' : `Question ${game.index + 1} of ${game.total}`}${r && !over ? ` · ${r.icon} ${r.label}` : ''}</b>
        <span class="muted">${statusText(game)}</span>
      </div>
    </div>
    ${rv && html`<p class="qz-host-answer">Answer: <b>${game.choices?.[rv.answer]?.text}</b>${r?.ask !== 'song' ? ` — ${rv.song.title} by ${rv.song.artist}` : ''}</p>`}
    ${game.clipError && html`<p class="warn-text">TV: ${game.clipError}</p>`}
    ${game.asked > game.total && game.index === 0 && html`<p class="hint">The library had songs for ${game.total} of the ${game.asked} questions.</p>`}
    ${game.leaderboard?.length
      ? html`<${Leaderboard} rows=${game.leaderboard} />`
      : html`<p class="hint">Scores show up here once guests answer on their phones.</p>`}
    ${!game.ended && html`<div class="qz-host-actions">
      <button class="btn" disabled=${busy} onClick=${() => run({ action: 'next' })}>${NEXT_LABEL[game.phase] || 'Next'}</button>
      ${game.phase !== 'final' && html`<button class="btn ghost" disabled=${busy} onClick=${() => run({ action: 'final' })}>Show final results</button>`}
    </div>`}
  </div>`;
}

// ---- TV: clips -------------------------------------------------------------------------------

const frames = new Map(); // CDG url → Promise<{ bytes, time }>

/** The CDG screen with the most lyrics between `from` and `to` of the song. */
function lyricsFrame(clip) {
  if (frames.has(clip.cdg)) return frames.get(clip.cdg);
  const p = fetch(clip.cdg).then(async (r) => {
    if (!r.ok) throw new Error(`Could not load the lyrics (HTTP ${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { bytes, time: findLyricsFrame(bytes, { from: clip.from, to: clip.to }).time };
  });
  frames.set(clip.cdg, p);
  p.catch(() => frames.delete(clip.cdg));
  while (frames.size > 3) frames.delete(frames.keys().next().value);
  return p;
}

/**
 * Cuts `dur` seconds from `start` out of decoded channels (copies), optionally skipping leading
 * silence and reversing, with short fades so nothing clicks.
 */
export function cutClip(channels, sampleRate, { start = 0, dur = 10, skipSilence = false, reverse = false }) {
  const len = channels[0].length;
  let a = Math.max(0, Math.min(len - 1, Math.floor(start * sampleRate)));
  if (skipSilence) {
    const limit = Math.min(len, a + 15 * sampleRate);
    let i = a;
    outer: for (; i < limit; i++) for (const ch of channels) if (Math.abs(ch[i]) > 0.02) break outer;
    if (i < limit) a = Math.max(a, i - Math.floor(0.05 * sampleRate));
  }
  const n = Math.max(1, Math.min(Math.floor(dur * sampleRate), len - a));
  const fadeIn = Math.min(n >> 2, Math.floor(0.02 * sampleRate));
  const fadeOut = Math.min(n >> 1, Math.floor(0.6 * sampleRate));
  const out = channels.map((ch) => {
    const c = ch.slice(a, a + n);
    if (reverse) c.reverse();
    for (let i = 0; i < fadeIn; i++) c[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) c[n - 1 - i] *= i / fadeOut;
    return c;
  });
  return { channels: out, start: a / sampleRate };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isQuizTrack = (engine) => !!engine.track?.id?.startsWith('quiz:');

/** Plays quiz clips on the main display's AudioEngine (one per TV controller). */
class QuizPlayer {
  constructor(controller) {
    this.controller = controller;
    this.prepared = new Map(); // `${gameId}:${q}` → Promise<{ main, reveal, gainDb }>
    this.token = 0;
  }

  get engine() {
    return this.controller.engine;
  }

  /** Decodes the question's track once and keeps only the slices it needs. */
  prepare(gameId, clip) {
    const k = `${gameId}:${clip.q}`;
    if (this.prepared.has(k)) return this.prepared.get(k);
    const p = (async () => {
      const src = clip.kind === 'audio' ? clip : clip.reveal;
      if (!src?.url) return { main: null, reveal: null, gainDb: 0 };
      const [prep, frame] = await Promise.all([
        this.engine.prepare(src.trackId, src.url),
        clip.kind === 'lyrics' && clip.reveal?.atLyrics ? lyricsFrame(clip).catch(() => null) : null,
      ]);
      this.engine.cache.delete(src.trackId); // the full decode is big: keep only the slices
      const sr = this.engine.ctx.sampleRate;
      const main = clip.kind === 'audio' ? cutClip(prep.channels, sr, clip) : null;
      let reveal = null;
      if (clip.reveal) {
        let start = clip.reveal.start;
        if (clip.reveal.fromClip && main) start = main.start;
        if (frame) start = Math.max(0, frame.time - 1);
        reveal = cutClip(prep.channels, sr, { start, dur: clip.reveal.dur });
      }
      return { main, reveal, gainDb: prep.gainDb };
    })();
    this.prepared.set(k, p);
    p.catch(() => this.prepared.delete(k));
    while (this.prepared.size > 3) this.prepared.delete(this.prepared.keys().next().value);
    return p;
  }

  /** Plays the question clip ('main', with its effects) or the answer ('reveal', as is). */
  async play(gameId, clip, which) {
    const token = ++this.token;
    const prep = await this.prepare(gameId, clip);
    const part = prep?.[which];
    if (token !== this.token || !part) return false;
    await this.fadeOut(0.25);
    const c = this.controller;
    if (token !== this.token || c.entryId) return false; // a song is on: never touch the karaoke
    const fx = which === 'main' ? { key: clip.semitones || 0, tempo: clip.rate || 1 } : { key: 0, tempo: 1 };
    c.gameAudio = { ...fx, channel: clip.channel || 'stereo' };
    const e = this.engine;
    e.setChannelMode(c.gameAudio.channel);
    // loadChannels hands the arrays to the audio worklet: give it copies so a replay still works.
    await e.loadChannels(`quiz:${gameId}:${clip.q}:${which}`, part.channels.map((ch) => ch.slice()), { gainDb: prep.gainDb });
    if (token !== this.token || c.entryId) return false;
    e.setKey(fx.key);
    e.setTempo(fx.tempo);
    e.play(0);
    return true;
  }

  async fadeOut(seconds) {
    const e = this.engine;
    if (!e.ctx || !isQuizTrack(e) || !e.playing) return;
    e.rampFade(0, seconds);
    await sleep(seconds * 1000);
  }

  stop(seconds = 0.8) {
    const token = ++this.token;
    this.fadeOut(seconds).then(() => {
      if (token === this.token && isQuizTrack(this.engine) && this.engine.playing) this.engine.pause();
    });
  }

  release() {
    this.stop();
    this.prepared.clear();
    this.controller.gameAudio = null;
  }
}

const quizPlayers = new WeakMap();
function playerFor(controller) {
  if (!quizPlayers.has(controller)) quizPlayers.set(controller, new QuizPlayer(controller));
  return quizPlayers.get(controller);
}

/** Main display: preload the current and next clips, play the question and the answer. */
function useClipAudio(game, tv) {
  const player = tv.main && tv.controller ? playerFor(tv.controller) : null;
  const clip = game.clip;
  const pre = game.preload;
  useEffect(() => {
    if (!player) return;
    if (clip) player.prepare(game.id, clip).catch(() => {});
    // The next question decodes while this one is on (one after the other: decoding is heavy).
    if (pre) (clip ? player.prepare(game.id, clip) : Promise.resolve()).catch(() => {}).then(() => player.prepare(game.id, pre)).catch(() => {});
  }, [player, clip?.q, pre?.q]);
  useEffect(() => {
    if (!player) return;
    if (game.phase === 'question' && clip?.kind === 'audio') {
      const q = clip.q;
      player.play(game.id, clip, 'main').then(
        (ok) => { if (ok) tv.send({ event: 'clip', q }); },
        (e) => { if (!e.superseded) tv.send({ event: 'error', q, error: e.message }); },
      );
    } else if (game.phase === 'reveal' && clip) {
      player.play(game.id, clip, 'reveal').catch(() => {});
    } else {
      player.stop();
    }
  }, [player, game.phase, game.index]);
  useEffect(() => () => player?.release(), [player]);
}

/** Warms the browser cache for the next cover (all displays). */
function usePreloadImages(game) {
  useEffect(() => {
    for (const c of [game.clip, game.preload]) {
      if (c?.kind === 'cover') new Image().src = c.art;
    }
  }, [game.clip?.q, game.preload?.q]);
}

// ---- TV: scenes ------------------------------------------------------------------------------

export function Tv({ game, st, now, tv }) {
  useClipAudio(game, tv);
  usePreloadImages(game);
  const k = `${game.phase}-${game.index}`;
  switch (game.phase) {
    case 'get-ready': return html`<${TvReady} key=${k} game=${game} now=${now} st=${st} />`;
    case 'question': return html`<${TvQuestion} key=${k} game=${game} now=${now} tv=${tv} />`;
    case 'reveal': return html`<${TvReveal} key=${k} game=${game} />`;
    case 'leaderboard': return html`<${TvBoard} key=${k} game=${game} now=${now} st=${st} />`;
    default: return html`<${TvFinal} key="final" game=${game} />`;
  }
}

function JoinCorner({ st }) {
  const url = st?.info?.joinUrl;
  if (!url || st.display?.showQr === false) return null;
  const hs = st.hotspot; // the party hotspot: its Wi-Fi first
  return html`<div class="qz-join">
    ${hs && html`<img src=${qrSrc(hs.qr)} alt="" /><span>1 · Join the Wi-Fi<b>${hs.ssid}</b></span>`}
    <img src=${qrSrc(url)} alt="" />
    <span>${hs ? '2 · ' : ''}Play along on your phone<b>${url.replace(/^https?:\/\//, '')}</b></span>
  </div>`;
}

function TvReady({ game, now, st }) {
  const r = game.round;
  return html`<div class="scene g-tv quiz qz-ready">
    <header class="g-tv-head">
      <div class="kicker">${icon} Music quiz</div>
      <${Countdown} endsAt=${game.endsAt} total=${game.phaseSeconds} now=${now} />
    </header>
    <div class="qz-ready-card">
      <div class="qz-num display">Question ${game.index + 1}<small> of ${game.total}</small></div>
      ${r && html`<div class="qz-round-big"><span class="qz-round-icon" aria-hidden="true">${r.icon}</span><b class="display">${r.label}</b></div>
        <p class="qz-ready-prompt">${r.prompt}</p>`}
    </div>
    <${JoinCorner} st=${st} />
  </div>`;
}

function TvQuestion({ game, now, tv }) {
  const r = game.round || {};
  const clip = game.clip;
  const sent = useRef(false);
  const ready = () => {
    if (sent.current || !tv.main || !clip) return;
    sent.current = true;
    tv.send({ event: 'clip', q: clip.q });
  };
  let stage;
  if (clip?.kind === 'lyrics') stage = html`<${LyricsFrame} clip=${clip} onReady=${ready} />`;
  else if (clip?.kind === 'cover') stage = html`<${CoverZoom} clip=${clip} seconds=${game.seconds} onReady=${ready} />`;
  else stage = html`<${Listening} round=${r} hint=${game.hint} />`;
  return html`<div class="scene g-tv quiz qz-question">
    <header class="g-tv-head">
      <div class="qz-head">
        <div class="kicker">Question ${game.index + 1} of ${game.total} · ${r.icon} ${r.label}</div>
        <h1 class="display">${r.prompt}</h1>
      </div>
      ${game.open ? html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds} now=${now} />` : html`<div class="qz-wait" aria-label="Starting">${r.icon}</div>`}
    </header>
    <div class="qz-stage">${stage}</div>
    <div class="qz-answers">${(game.choices || []).map((c, i) => html`<${AnswerTile} key=${i} index=${i}>
      <b class="ellipsis">${c.text}</b>${c.sub && html`<small class="ellipsis">${c.sub}</small>`}
    </${AnswerTile}>`)}</div>
    <p class="g-tv-foot">${game.open ? `${game.answered} of ${Math.max(game.expected, game.answered)} answered` : 'Listen…'}</p>
  </div>`;
}

function Listening({ round, hint }) {
  return html`<div class=${`qz-listen ${round.type || ''}`}>
    <div class="qz-eq" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => html`<i key=${i} style=${{ animationDelay: `${((i * 263) % 700) / 1000}s`, animationDuration: `${0.55 + ((i * 97) % 40) / 100}s` }}></i>`)}</div>
    ${hint
      ? html`<div class="qz-hint"><b class="display">${hint.title}</b><span>${hint.artist}</span></div>`
      : html`<div class="qz-listen-icon" aria-hidden="true">${round.icon}</div>`}
  </div>`;
}

/** A static CD+G lyrics screen (the one with the most text between 30 and 70 % of the song). */
function LyricsFrame({ clip, onReady }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    lyricsFrame(clip).then(({ bytes, time }) => {
      if (!alive || !ref.current) return;
      const r = new CdgRenderer(ref.current);
      r.setOptions({ smoothing: true, transparent: false });
      r.load(bytes);
      r.render(time);
      onReady();
    }).catch(() => {
      if (!alive) return;
      setFailed(true);
      onReady();
    });
    return () => { alive = false; };
  }, [clip.cdg]);
  return html`<div class="qz-lyrics">
    <canvas ref=${ref} width="576" height="384" aria-label="Lyrics"></canvas>
    ${failed && html`<p class="qz-fail">The lyrics could not be loaded — take a guess!</p>`}
  </div>`;
}

/** The cover, zoomed in on a random spot, slowly zooming out while the timer runs. */
function CoverZoom({ clip, seconds, onReady }) {
  const [go, setGo] = useState(false);
  const loaded = () => {
    setGo(true);
    onReady();
  };
  return html`<div class="qz-cover">
    <img class=${go ? 'go' : ''} src=${clip.art} alt="" onLoad=${loaded} onError=${loaded}
      style=${{ transformOrigin: `${clip.zoom?.x ?? 50}% ${clip.zoom?.y ?? 50}%`, animationDuration: `${Math.max(5, seconds * 0.9)}s` }} />
  </div>`;
}

function TvReveal({ game }) {
  const rv = game.reveal;
  const r = game.round || {};
  if (!rv) return null;
  const song = rv.song;
  return html`<div class="scene g-tv quiz qz-reveal">
    <header class="g-tv-head">
      <div class="qz-head">
        <div class="kicker">Question ${game.index + 1} of ${game.total} · ${r.icon} ${r.label}</div>
        <h1 class="display">${rv.rightCount ? `${plural(rv.rightCount, 'player')} got it right!` : game.answered ? 'Nobody got it!' : 'Nobody answered!'}</h1>
      </div>
    </header>
    <div class="qz-reveal-main">
      <div class="qz-song">
        <${SongArt} songId=${song.songId} />
        <div class="qz-song-text">
          <div class="kicker">The answer${r.ask === 'decade' ? `: ${game.choices?.[rv.answer]?.text}` : ''}</div>
          <h2 class="display">${song.title}</h2>
          <p>${song.artist}${song.year ? html` · <span class="num">${song.year}</span>` : ''}</p>
        </div>
      </div>
      ${rv.right.length > 0 && html`<ol class="qz-right">${rv.right.map((p, i) => html`<li key=${p.id} class=${i === 0 ? 'fastest' : ''}>
        <${PlayerChip} p=${p} />${i === 0 && html`<span class="qz-fast">fastest</span>`}<b class="num">+${fmt(p.points)}</b>
      </li>`)}</ol>`}
    </div>
    <div class="qz-answers">${(game.choices || []).map((c, i) => html`<${AnswerTile} key=${i} index=${i} state=${i === rv.answer ? 'right' : 'wrong'} sub=${rv.counts?.[i] ?? 0}>
      <b class="ellipsis">${c.text}</b>${c.sub && html`<small class="ellipsis">${c.sub}</small>`}
    </${AnswerTile}>`)}</div>
  </div>`;
}

function TvBoard({ game, now, st }) {
  return html`<div class="scene g-tv quiz qz-board">
    <header class="g-tv-head">
      <div class="qz-head"><div class="kicker">After ${game.index + 1} of ${game.total} questions</div><h1 class="display">Leaderboard</h1></div>
      <${Countdown} endsAt=${game.endsAt} total=${game.phaseSeconds} now=${now} />
    </header>
    ${game.leaderboard?.length
      ? html`<${Leaderboard} rows=${game.leaderboard} max=${8} />`
      : html`<p class="qz-empty">No scores yet — answer on your phone to get on the board!</p>`}
    <p class="g-tv-foot">Next up: question ${game.index + 2}</p>
    <${JoinCorner} st=${st} />
  </div>`;
}

function TvFinal({ game }) {
  const rows = game.leaderboard || [];
  const rest = rows.slice(3, 8);
  const winners = game.winners || []; // everyone tied for the top score; none when nobody scored
  const title = winners.length > 1 ? `${names(winners)} share the crown!`
    : winners.length ? `${winners[0]} is the quiz champion!`
      : rows.length ? 'Nobody scored — thanks for playing!' : 'Thanks for playing!';
  return html`<div class="scene g-tv quiz qz-final">
    <${Confetti} run=${winners.length ? 1 : 0} />
    <header class="qz-final-head">
      <div class="kicker">${icon} Music quiz · final results</div>
      <h1 class="display">${title}</h1>
    </header>
    ${winners.length ? html`<${Podium} rows=${rows} />` : html`<p class="qz-empty">${rows.length ? 'Not a single right answer this time.' : 'Nobody answered this time.'}</p>`}
    ${winners.length > 0 && rest.length > 0 && html`<p class="g-tv-foot qz-rest">${rest.map((r, i) => html`<span key=${r.id}>${r.rank || i + 4}. ${r.name} <b class="num">${fmt(r.score)}</b></span>`)}</p>`}
  </div>`;
}

// ---- phones ------------------------------------------------------------------------------------

export function Guest({ game, send, now }) {
  const [sending, setSending] = useState(-1);
  const me = game.me || { choice: -1 };
  const r = game.round || {};
  const phase = game.phase;
  useEffect(() => setSending(-1), [game.index, phase]);
  const answer = async (i) => {
    if (sending >= 0 || me.choice >= 0 || !game.open) return;
    setSending(i);
    const res = await send({ q: game.index, choice: i });
    if (!res) setSending(-1);
  };
  const mine = me.choice >= 0 ? me.choice : sending;
  const head = html`<p class="qz-g-kicker">${phase === 'final' || phase === 'done' ? 'Final results' : `Question ${game.index + 1} of ${game.total} · ${r.icon || ''} ${r.label || ''}`}</p>`;

  if (phase === 'get-ready') {
    return html`<div class="g-guest quiz qz-g-ready">
      ${head}
      <div class="qz-g-icon" aria-hidden="true">${r.icon}</div>
      <h1 class="g-h1">${r.prompt}</h1>
      <${Countdown} endsAt=${game.endsAt} total=${game.phaseSeconds} now=${now} />
      <p class="hint">Watch and listen to the TV — the answers appear here.</p>
      <${MyScore} me=${me} />
    </div>`;
  }

  if (phase === 'question') {
    const locked = mine >= 0;
    return html`<div class="g-guest quiz">
      ${head}
      <h1 class="g-h1">${r.prompt}</h1>
      ${game.hint && html`<p class="qz-g-hint"><b>${game.hint.title}</b> · ${game.hint.artist}</p>`}
      ${game.open ? html`<${Countdown} endsAt=${game.endsAt} total=${game.seconds} now=${now} />` : html`<p class="hint">Listen…</p>`}
      <div class="g-answers qz-pad">${(game.choices || []).map((c, i) => html`<${AnswerTile} key=${i} index=${i}
        state=${locked ? (i === mine ? 'picked' : 'dim') : 'idle'} disabled=${locked || !game.open}
        onClick=${locked ? undefined : () => answer(i)}>
        <b>${c.text}</b>${c.sub && html`<small class="ellipsis">${c.sub}</small>`}
      </${AnswerTile}>`)}</div>
      <p class="hint">${locked ? `Locked in! ${game.answered} of ${Math.max(game.expected, game.answered)} answered.` : game.open ? 'Tap your answer — faster answers score more.' : 'Get ready to tap…'}</p>
    </div>`;
  }

  if (phase === 'reveal') {
    const res = me.result;
    const rv = game.reveal || {};
    let verdict;
    if (!res) verdict = html`<div class="qz-verdict none"><b>The answer</b><span>Answer the next question to join in!</span></div>`;
    else if (res.correct) verdict = html`<div class="qz-verdict right"><b>✔ Correct!</b><span class="num">+${fmt(res.points)}${res.bonus ? ` · 🔥 ${me.streak} in a row` : ''}</span></div>`;
    else verdict = html`<div class="qz-verdict wrong"><b>${res.answered ? '✘ Not this time' : '⏱ Too slow'}</b><span>${res.answered ? 'Better luck on the next one!' : 'No answer this time.'}</span></div>`;
    return html`<div class="g-guest quiz">
      ${head}
      ${verdict}
      <div class="g-answers qz-pad">${(game.choices || []).map((c, i) => html`<${AnswerTile} key=${i} index=${i}
        state=${i === rv.answer ? 'right' : i === me.choice ? 'picked' : 'wrong'} sub=${i === me.choice ? (i === rv.answer ? '✔' : '✘') : undefined}>
        <b>${c.text}</b>${c.sub && html`<small class="ellipsis">${c.sub}</small>`}
      </${AnswerTile}>`)}</div>
      <${MyScore} me=${me} />
    </div>`;
  }

  if (phase === 'leaderboard') {
    return html`<div class="g-guest quiz">
      ${head}
      <h1 class="g-h1">Leaderboard</h1>
      <${MyScore} me=${me} big />
      <${Leaderboard} rows=${game.leaderboard || []} max=${10} highlight=${me.id} />
    </div>`;
  }

  // final / done
  const rows = game.leaderboard || [];
  const winners = game.winners || [];
  let title = 'Thanks for playing!';
  if (me.rank === 1 && winners.length) title = me.tied ? '🏆 You share the win!' : '🏆 You won the quiz!';
  else if (me.rank && winners.length) title = `You finished ${me.tied ? 'joint ' : ''}${ordinal(me.rank)}!`;
  else if (winners.length) title = `${names(winners)} ${winners.length > 1 ? 'share the win' : 'wins'}!`;
  else if (rows.length) title = 'Nobody scored — thanks for playing!';
  return html`<div class="g-guest quiz">
    ${head}
    <h1 class="g-h1">${title}</h1>
    <${MyScore} me=${me} big />
    <${Leaderboard} rows=${rows} max=${10} highlight=${me.id} />
  </div>`;
}

function MyScore({ me, big }) {
  if (!me?.id) return null;
  return html`<div class=${`qz-me ${big ? 'big' : ''}`}>
    <span>${me.rank ? `#${me.rank}` : ''}</span>
    <b class="num">${fmt(me.score)} <small>points</small></b>
    ${me.streak >= 2 && html`<span class="qz-streak">🔥 ${me.streak}</span>`}
  </div>`;
}
