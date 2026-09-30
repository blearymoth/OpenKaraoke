// Party recap (PLAN §13.7): tonight's highlights as animated slides on the TV (auto-advancing;
// the host can go back and forth), a compact list of the same on the phones.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Switch } from '../lib/components.js';
import { SongArt, SelectField, Podium, Confetti, ensureCss } from './common.js';

ensureCss('/css/games/recap.css');

export const icon = '🏆';
export const blurb = 'Tonight’s highlights on the TV: top singers, best rated, most sung.';

const SLIDE_NAMES = {
  empty: 'No songs yet', totals: 'Tonight in numbers', singers: 'Top singers', rated: 'Best rated',
  artists: 'Most sung artists', favourite: 'Crowd favourite', games: 'Game winners', thanks: 'Thanks!',
};
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const namesOf = (singers) => {
  const names = (singers || []).map((s) => s.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0] || 'Everyone';
};

function Stars({ avg }) {
  const full = Math.round(avg);
  return html`<span class="rc-stars" aria-label=${`${avg} stars`}>${'★'.repeat(full)}<span class="off">${'★'.repeat(Math.max(0, 5 - full))}</span></span>`;
}

/** Counts up from 0 when the slide appears. */
function CountUp({ value, ms = 1400 }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - start) / ms);
      setV(Math.round(value * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return html`<span class="num">${v.toLocaleString()}</span>`;
}

// ---- host ---------------------------------------------------------------------------------------

export function Setup({ onStart, busy }) {
  const [seconds, setSeconds] = useState('7');
  const [loop, setLoop] = useState(false);
  return html`<div class="g-setup recap-setup">
    <div class="rc-setup-row">
      <${SelectField} label="Each slide stays" value=${seconds} onChange=${setSeconds} options=${[['5', '5 seconds'], ['7', '7 seconds'], ['10', '10 seconds'], ['15', '15 seconds']]} />
      <div class="rc-toggle"><${Switch} checked=${loop} onChange=${setLoop} label="Loop" /><span>Start over after the last slide</span></div>
    </div>
    <p class="hint">Totals, top singers, best rated performances, most sung artists, the crowd favourite and game winners — from tonight’s songs (skipped songs don’t count). Phones get a copy.</p>
    <button class="btn primary" disabled=${busy} onClick=${() => onStart({ seconds: Number(seconds), loop })}>Show the recap</button>
  </div>`;
}

export function Control({ game, act }) {
  const go = (action, extra = {}) => act('game.action', { action, ...extra });
  return html`<div class="g-control recap-control">
    <div class="rc-slides" role="tablist">${game.slides.map((s, i) => html`<button type="button" role="tab" key=${s} aria-selected=${i === game.index}
      class=${`chip ${i === game.index ? 'on' : ''}`} disabled=${game.ended} onClick=${() => go('goto', { index: i })}>${i + 1}. ${SLIDE_NAMES[s] || s}</button>`)}</div>
    ${!game.ended && html`<div class="rc-buttons">
      <button class="btn" onClick=${() => go('prev')}>◀ Previous</button>
      <button class="btn" onClick=${() => go('next')}>Next ▶</button>
      <button class="btn ghost" onClick=${() => go(game.auto ? 'pause' : 'play')}>${game.auto ? '⏸ Stop auto-advance' : '▶ Auto-advance'}</button>
      <button class="btn ghost" title="Include songs sung since the recap started" onClick=${() => go('refresh')}>↻ Refresh</button>
    </div>`}
    <p class="hint">${game.recap.totals.songs ? `${plural(game.recap.totals.songs, 'song')} tonight, ${plural(game.recap.totals.singers, 'singer')}.` : 'No songs yet tonight.'} ${game.auto ? `Slides change every ${game.seconds} s.` : ''}</p>
  </div>`;
}

// ---- TV slides --------------------------------------------------------------------------------------

function Totals({ r }) {
  const t = r.totals;
  const tiles = [['🎤', t.songs, t.songs === 1 ? 'song sung' : 'songs sung'], ['⏱️', t.minutes, t.minutes === 1 ? 'minute of singing' : 'minutes of singing'], ['🧑‍🎤', t.singers, t.singers === 1 ? 'singer' : 'singers'], ['🔥', t.reactions, t.reactions === 1 ? 'reaction' : 'reactions']];
  return html`<div class="rc-slide rc-totals">
    <h1 class="display">What a night!</h1>
    <div class="rc-tiles">${tiles.map(([emoji, n, label], i) => html`<div class="rc-tile" style=${{ animationDelay: `${0.15 + i * 0.15}s` }}>
      <span class="emoji" aria-hidden="true">${emoji}</span><b class="display"><${CountUp} value=${n} /></b><span class="label">${label}</span>
    </div>`)}</div>
  </div>`;
}

function Singers({ r }) {
  const rows = r.topSingers.map((s) => ({ ...s, score: s.songs, id: s.name }));
  return html`<div class="rc-slide rc-singers">
    <h1 class="display">Top singers</h1>
    <${Podium} rows=${rows} />
    <p class="rc-sub">${rows.slice(0, 3).map((s) => `${s.name}: ${plural(s.songs, 'song')}`).join(' · ')}</p>
    ${rows.length > 3 && html`<p class="rc-more">${rows.slice(3).map((s) => `${s.name} (${s.songs})`).join(' · ')}</p>`}
  </div>`;
}

function Rated({ r }) {
  return html`<div class="rc-slide rc-rated">
    <h1 class="display">Best rated performances</h1>
    <ol class="rc-rows">${r.bestRated.slice(0, 4).map((p, i) => html`<li key=${i} style=${{ animationDelay: `${0.2 + i * 0.18}s` }}>
      <span class="rank num">${i + 1}</span>
      <${SongArt} songId=${p.songId} size=${250} />
      <div class="what"><b class="ellipsis">${namesOf(p.singers)}</b><span class="ellipsis">${p.title} · ${p.artist}</span></div>
      <div class="score"><${Stars} avg=${p.rating.avg} /><span class="num">${p.rating.avg.toFixed(1)} · ${plural(p.rating.n, 'vote')}</span></div>
    </li>`)}</ol>
  </div>`;
}

function Artists({ r }) {
  const max = Math.max(1, ...r.topArtists.map((a) => a.count));
  return html`<div class="rc-slide rc-artists">
    <h1 class="display">Most sung artists</h1>
    <ol class="rc-bars">${r.topArtists.map((a, i) => html`<li key=${a.artist} style=${{ animationDelay: `${0.2 + i * 0.15}s` }}>
      <span class="name ellipsis">${a.artist}</span>
      <span class="bar"><i style=${{ '--w': `${(a.count / max) * 100}%`, animationDelay: `${0.4 + i * 0.15}s` }}></i></span>
      <b class="num">${a.count}</b>
    </li>`)}</ol>
  </div>`;
}

function Favourite({ r }) {
  const p = r.favourite;
  return html`<div class="rc-slide rc-fav">
    <${SongArt} songId=${p.songId} />
    <div class="what">
      <div class="kicker">Crowd favourite</div>
      <h1 class="display">${namesOf(p.singers)}</h1>
      <p class="song">${p.title} · ${p.artist}</p>
      <p class="fire">🔥 ${plural(p.reactions, 'reaction')}${p.rating ? html` · <${Stars} avg=${p.rating.avg} />` : ''}</p>
    </div>
  </div>`;
}

function Games({ r }) {
  return html`<div class="rc-slide rc-games">
    <h1 class="display">Game winners</h1>
    <div class="rc-trophies">${r.games.map((g, i) => html`<div class="rc-trophy" key=${i} style=${{ animationDelay: `${0.2 + i * 0.15}s` }}>
      <span class="emoji" aria-hidden="true">🏆</span>
      <span class="kicker">${g.label} · ${g.title}</span>
      <b class="ellipsis">${g.winners.join(' & ')}</b>
    </div>`)}</div>
  </div>`;
}

function Thanks({ r, name }) {
  const [run, setRun] = useState(0);
  useEffect(() => { setRun(1); }, []);
  const t = r.totals;
  return html`<div class="rc-slide rc-thanks">
    <div class="emoji" aria-hidden="true">🎤✨</div>
    <h1 class="display">Thanks for singing!</h1>
    <p>${name ? `${name} · ` : ''}${plural(t.songs, 'song')} · ${plural(t.singers, 'singer')} · ${plural(t.minutes, 'minute')}</p>
    <${Confetti} run=${run} />
  </div>`;
}

function Empty() {
  return html`<div class="rc-slide rc-empty">
    <div class="emoji" aria-hidden="true">🎶</div>
    <h1 class="display">No songs yet tonight</h1>
    <p>Grab the mic! The recap fills up as the party sings.</p>
  </div>`;
}

function Slide({ kind, r, name }) {
  switch (kind) {
    case 'totals': return html`<${Totals} r=${r} />`;
    case 'singers': return html`<${Singers} r=${r} />`;
    case 'rated': return html`<${Rated} r=${r} />`;
    case 'artists': return html`<${Artists} r=${r} />`;
    case 'favourite': return r.favourite ? html`<${Favourite} r=${r} />` : null;
    case 'games': return html`<${Games} r=${r} />`;
    case 'thanks': return html`<${Thanks} r=${r} name=${name} />`;
    default: return html`<${Empty} />`;
  }
}

/** A thin bar filling up until the next slide. */
function Progress({ endsAt, now, index }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !endsAt) return;
    const left = Math.max(0, endsAt - now());
    el.style.transition = 'none';
    el.style.width = '0%';
    void el.offsetWidth; // restart
    el.style.transition = `width ${left}ms linear`;
    el.style.width = '100%';
  }, [endsAt, index]);
  return endsAt ? html`<div class="rc-progress" aria-hidden="true"><i ref=${ref}></i></div>` : null;
}

export function Tv({ game, st, now }) {
  const r = game.recap;
  return html`<div class="scene g-tv recap">
    <header class="rc-head"><span class="kicker">Party recap · ${st.info?.name || 'Tonight'}</span><span class="rc-count num">${game.index + 1} / ${game.slides.length}</span></header>
    <div class="rc-stage" key=${`${game.index}-${game.slide}`}><${Slide} kind=${game.slide} r=${r} name=${st.info?.name} /></div>
    <footer class="rc-dots" aria-hidden="true">${game.slides.map((s, i) => html`<i key=${s} class=${i === game.index ? 'on' : i < game.index ? 'done' : ''}></i>`)}</footer>
    <${Progress} endsAt=${game.advancing ? game.endsAt : 0} now=${now} index=${game.index} />
  </div>`;
}

// ---- phones ---------------------------------------------------------------------------------------------

export function Guest({ game, state }) {
  const r = game.recap;
  const t = r.totals;
  const on = (kind) => (game.slide === kind && !game.ended ? 'on' : '');
  if (!t.songs) {
    return html`<div class="g-guest recap">
      <h1 class="g-h1">No songs yet tonight</h1>
      <p class="hint">Grab the mic! The recap fills up as the party sings.</p>
      ${r.games.length > 0 && html`<${GuestGames} r=${r} cls=${on('games')} />`}
    </div>`;
  }
  return html`<div class="g-guest recap">
    <h1 class="g-h1">Tonight at ${state.info?.name || 'the party'}</h1>
    <section class=${`rc-card ${on('totals')}`}>
      <div class="rc-mini-tiles">
        <div><b class="num">${t.songs}</b><span>${t.songs === 1 ? 'song' : 'songs'}</span></div>
        <div><b class="num">${t.minutes}</b><span>${t.minutes === 1 ? 'minute' : 'minutes'}</span></div>
        <div><b class="num">${t.singers}</b><span>${t.singers === 1 ? 'singer' : 'singers'}</span></div>
        <div><b class="num">${t.reactions}</b><span>🔥</span></div>
      </div>
    </section>
    ${r.topSingers.length > 0 && html`<section class=${`rc-card ${on('singers')}`}><h2>Top singers</h2>
      <ol class="rc-list">${r.topSingers.map((s, i) => html`<li key=${i}><span class="rank num">${i + 1}</span><span class="avatar" style=${{ '--avatar': s.color }}>${s.emoji || '🎤'}</span><span class="ellipsis">${s.name}</span><b class="num">${plural(s.songs, 'song')}</b></li>`)}</ol>
    </section>`}
    ${r.bestRated.length > 0 && html`<section class=${`rc-card ${on('rated')}`}><h2>Best rated</h2>
      <ol class="rc-list">${r.bestRated.map((p, i) => html`<li key=${i}><span class="rank num">${i + 1}</span><span class="what"><b class="ellipsis">${namesOf(p.singers)}</b><small class="ellipsis">${p.title}</small></span><b class="num">★ ${p.rating.avg.toFixed(1)}</b></li>`)}</ol>
    </section>`}
    ${r.topArtists.length > 0 && t.songs >= 2 && html`<section class=${`rc-card ${on('artists')}`}><h2>Most sung artists</h2>
      <ol class="rc-list">${r.topArtists.map((a, i) => html`<li key=${i}><span class="rank num">${i + 1}</span><span class="ellipsis">${a.artist}</span><b class="num">${a.count}×</b></li>`)}</ol>
    </section>`}
    ${r.favourite && html`<section class=${`rc-card ${on('favourite')}`}><h2>Crowd favourite</h2>
      <p><b>${namesOf(r.favourite.singers)}</b> — ${r.favourite.title}</p><p class="hint">🔥 ${plural(r.favourite.reactions, 'reaction')}</p>
    </section>`}
    ${r.games.length > 0 && html`<${GuestGames} r=${r} cls=${on('games')} />`}
    <p class=${`rc-thanks-line ${on('thanks')}`}>Thanks for singing! 🎤</p>
  </div>`;
}

function GuestGames({ r, cls }) {
  return html`<section class=${`rc-card ${cls}`}><h2>Game winners</h2>
    <ul class="rc-list">${r.games.map((g, i) => html`<li key=${i}><span aria-hidden="true">🏆</span><span class="what"><b class="ellipsis">${g.winners.join(' & ')}</b><small class="ellipsis">${g.label} · ${g.title}</small></span></li>`)}</ul>
  </section>`;
}
