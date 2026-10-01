// TV display app (/tv): lobby with join QR, next-singer intro, lyrics with overlays.
import { html, render, useEffect, useRef, useState } from '../vendor/preact.js';
import { Connection } from '../lib/ws-client.js';
import { createStore, useStore, useTick, useInterval, singersText, formatEta, artUrl, artistArtUrl, artStore, noteArt } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { TvController } from './controller.js';
import { GAME_UI } from '../games/index.js';
import { BreakPlayer } from './break-player.js';
import { DENIED_MESSAGES, CHANNEL_MODES, TEMPO_STEP, formatKey, formatTempo } from '/shared/protocol.js';

const params = new URLSearchParams(location.search);
const store = createStore({ status: 'connecting', state: null, display: 'main', denied: null, unlocked: false, help: false, reactions: [], toast: null });

const preview = params.get('display') === 'preview'; // the host's small live preview
const board = params.get('layout') === 'board'; // a queue board for a second screen (muted)
if (board) document.body.classList.add('board-layout');
if (preview) document.body.classList.add('preview');
const conn = new Connection({
  hello: () => ({
    role: 'tv',
    display: preview ? 'preview' : board || params.get('display') === 'mirror' ? 'mirror' : undefined,
    token: localStorage.getItem('ok.tvToken') || undefined, // a screen paired by the host
    hostToken: preview ? localStorage.getItem('ok.hostToken') || undefined : undefined,
  }),
});
const now = () => conn.serverNow();
const controller = new TvController({
  conn,
  canvas: document.getElementById('cdg'),
  video: document.getElementById('video'),
  audio: document.getElementById('audio'),
});

conn.on('welcome', (m) => {
  store.update({ state: m.state, display: m.display, denied: null });
  controller.setDisplay(m.display);
  controller.apply(m.state);
  controller.onWelcome();
  applyBreak(m.state);
});
const breakPlayer = new BreakPlayer({ onEnded: (id) => conn.request('tv.break', { id }).catch(() => {}) });
const applyBreak = (st) => breakPlayer.apply(st?.breakMusic || null, { main: store.get().display === 'main' && !preview, unlocked: controller.unlocked, master: st?.player?.volume ?? 1 });

conn.on('state', (m) => {
  store.update({ state: m.state });
  controller.apply(m.state);
  applyBreak(m.state);
});
conn.on('display', (m) => {
  store.update({ display: m.display });
  controller.setDisplay(m.display);
});
conn.on('time', (m) => controller.onTime(m));
conn.on('status', (status) => store.update({ status }));
conn.on('denied', (m) => store.update({ denied: m.reason }));
conn.on('reaction', (m) => addReaction(m));
conn.on('art', (m) => noteArt(m));
controller.addEventListener('change', () => {
  store.update({ unlocked: controller.unlocked });
  applyBreak(store.get().state);
});

let reactionId = 0;
function addReaction(m) {
  if (store.get().state?.display?.showReactions === false) return;
  const id = ++reactionId;
  const r = { id, emoji: m.emoji, name: m.name, x: 62 + Math.random() * 30, dx: `${Math.round((Math.random() - 0.5) * 16)}vw` };
  store.update((s) => ({ reactions: [...s.reactions.slice(-24), r] }));
  setTimeout(() => store.update((s) => ({ reactions: s.reactions.filter((x) => x.id !== id) })), 4400);
}

// ---- keyboard shortcuts (for a single-screen setup) ---------------------------------------

async function command(t, body) {
  try {
    await conn.request(t, body);
  } catch (e) {
    flash(e.message);
  }
}

function flash(text) {
  store.update({ toast: text });
  clearTimeout(flash.t);
  flash.t = setTimeout(() => store.update({ toast: null }), 2500);
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const st = store.get().state;
  const p = st?.player;
  const k = e.key;
  if (!controller.unlocked) {
    start();
    return;
  }
  if (k === '?' || k === 'h') store.update((s) => ({ help: !s.help }));
  else if (k === 'Escape') store.update({ help: false });
  else if (k === 'f') toggleFullscreen();
  else if (!p) return;
  else if (k === ' ' || k === 'k') command('player.toggle');
  else if (k === 'ArrowRight') command('player.seek', { pos: controller.position() + 5 });
  else if (k === 'ArrowLeft') command('player.seek', { pos: Math.max(0, controller.position() - 5) });
  else if (k === '+' || k === '=') command('player.key', { semitones: p.key + 1 });
  else if (k === '-' || k === '_') command('player.key', { semitones: p.key - 1 });
  else if (k === ']') command('player.tempo', { rate: p.tempo + TEMPO_STEP });
  else if (k === '[') command('player.tempo', { rate: p.tempo - TEMPO_STEP });
  else if (k === 'n') command('player.next');
  else if (k === 'r') command('player.restart');
  else if (k === 'c') command('player.channel', { mode: CHANNEL_MODES[(CHANNEL_MODES.indexOf(p.channel) + 1) % CHANNEL_MODES.length] });
  else if (k === 'ArrowUp') command('player.volume', { v: Math.min(1, p.volume + 0.05) });
  else if (k === 'ArrowDown') command('player.volume', { v: Math.max(0, p.volume - 0.05) });
  else return;
  e.preventDefault();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

let wakeLock = null;
async function start() {
  await controller.unlock().catch(() => {});
  if (!document.fullscreenElement && params.get('fullscreen') !== '0') document.documentElement.requestFullscreen?.().catch(() => {});
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* not allowed */ }
  store.update({ unlocked: controller.unlocked });
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wakeLock?.released) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }
});

// Hide the mouse pointer when it isn't moving.
let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('idle-cursor'), 2500);
});

// Try to start audio straight away: works when Chrome runs with --autoplay-policy=no-user-gesture-required.
controller.engine.init().then(() => {
  if (controller.engine.running) store.update({ unlocked: true });
  controller.engine.ctx.addEventListener('statechange', () => {
    store.update({ unlocked: controller.unlocked });
    applyBreak(store.get().state);
    controller.reportAudio();
    controller.sendReady();
  });
  controller.reportAudio();
});

// ---- animation loop: lyrics, progress bar, visualiser level ------------------------------

const canvas = document.getElementById('cdg');
const stageEl = document.getElementById('stage');
function loop() {
  requestAnimationFrame(loop);
  controller.frame();
  const st = store.get().state;
  const showCdg = !!(st?.current && controller.cdg.loaded && ['playing', 'paused'].includes(st.player.state));
  canvas.classList.toggle('show', showCdg);
  canvas.classList.toggle('pixelated', st?.display?.cdgSmoothing === false);
  stageEl.classList.toggle('boxed', st?.display?.cdgTransparent === false);
  const bar = document.querySelector('.progress i');
  if (bar) {
    const dur = controller.duration();
    bar.style.width = `${dur ? Math.min(100, (controller.position() / dur) * 100) : 0}%`;
  }
  const level = controller.engine.ctx ? controller.engine.level() : 0;
  document.documentElement.style.setProperty('--level', level.toFixed(3));
}
requestAnimationFrame(loop);

// ---- components -------------------------------------------------------------------------------

function Background() {
  const { state } = useStore(store);
  useStore(artStore);
  const mode = state?.display?.background || 'art';
  const cur = state?.current;
  const singing = cur && ['playing', 'paused', 'intro', 'ready'].includes(state.player.state);
  if (mode === 'plain') return html`<div class="plain-bg" style=${{ background: 'var(--night)' }}></div>`;
  if (mode === 'art' && singing) {
    const art = cur.art || {};
    const fanart = art.fanart && state.display.fanart !== false && !cur.mystery;
    return html`
      <div class="art-bg" key=${cur.songId} style=${{ backgroundImage: `url(${artUrl(cur.mystery ? null : cur.songId, 500)})` }}></div>
      ${fanart && html`<${FanartShow} artistKey=${art.fanart} count=${art.fanartCount || 1} key=${art.fanart} />`}
      <div class="scrim"></div>`;
  }
  const photos = state?.photos?.list || [];
  if (mode === 'photos' && photos.length) return html`<${PhotoShow} photos=${photos} singing=${!!singing} /><div class="scrim"></div>`;
  if (mode === 'art' && !cur && state?.mosaic?.length >= 4) return html`<${Mosaic} ids=${state.mosaic} />`;
  return html`<div class="aurora"><i></i><i></i><i></i></div>`;
}

/** The artist's photos, one after the other, slowly zooming (Ken Burns). */
function FanartShow({ artistKey, count }) {
  const [i, setI] = useState(0);
  useInterval(() => setI((x) => (x + 1) % count), count > 1 ? 20000 : null);
  return html`<div class="fanart-bg" key=${i} style=${{ backgroundImage: `url(${artistArtUrl(artistKey, 'fanart', { i, size: 1000 })})` }}></div>`;
}

/** Guests' photos, one after the other with a slow zoom (the newest first). */
function PhotoShow({ photos }) {
  const [i, setI] = useState(0);
  useInterval(() => setI((x) => x + 1), photos.length > 1 ? 12000 : null);
  const p = photos[(photos.length - 1 - (i % photos.length) + photos.length) % photos.length];
  return html`<div class="photo-bg" key=${p.id} style=${{ backgroundImage: `url(/api/photos/${encodeURIComponent(p.id)})` }}></div>`;
}

/** A newly approved photo, big for a few seconds (small in a corner while someone sings). */
function PhotoFlash({ flash, singing }) {
  return html`<figure class=${`photo-flash ${singing ? 'corner' : ''}`} key=${flash.id}>
    <img src=${`/api/photos/${encodeURIComponent(flash.id)}`} alt="" />
    <figcaption>📸 ${flash.name}</figcaption>
  </figure>`;
}

/** Idle lobby: a slowly drifting wall of covers from the library. */
function Mosaic({ ids }) {
  const tiles = [];
  while (tiles.length < 60) tiles.push(...ids);
  return html`<div class="mosaic" aria-hidden="true">${tiles.slice(0, 60).map((id, i) => html`<img key=${i} src=${artUrl(id, 250)} alt="" decoding="async" />`)}</div><div class="mosaic-scrim"></div>`;
}

function App() {
  const s = useStore(store);
  const st = s.state;
  useEffect(() => {
    if (st?.display?.accent) document.documentElement.style.setProperty('--neon', st.display.accent);
  }, [st?.display?.accent]);
  if (s.denied === 'pairing_required') return html`<${Pairing} />`;
  if (s.denied) {
    return html`<div class="denied"><div style="font-size:12vh">📺</div><h2>This screen can't join</h2><p>${DENIED_MESSAGES[s.denied] || s.denied}</p></div>`;
  }
  if (!st) return html`<div class="denied"><div class="spinner"></div><p>Connecting to OpenKaraoke…</p></div>`;
  const p = st.player;
  const game = st.game;
  const gameUi = game && GAME_UI[game.type];
  const tv = { conn, controller, main: s.display === 'main', open: s.status === 'open', send: (m) => conn.request('tv.game', m).catch(() => null) };
  // An exclusive game owns the TV; its results stay up until the next song starts. A game that
  // sings songs itself (`showSongs`: battle) lets the karaoke scene show while its song is on.
  const gameScene = !!(game?.exclusive && gameUi?.Tv && (!game.ended || !st.current) && !(game.showSongs && st.current));
  let scene;
  if (board) scene = html`<${Board} st=${st} />`;
  else if (gameScene) scene = html`<${gameUi.Tv} game=${game} st=${st} now=${now} tv=${tv} key=${game.id} />`;
  else if (!st.current || p.state === 'idle') scene = html`<${Lobby} st=${st} />`;
  else if (p.state === 'intro' || p.state === 'ready') scene = html`<${Intro} st=${st} />`;
  else scene = html`<${Singing} st=${st} />`;
  return html`
    ${scene}
    ${game && gameUi?.TvOverlay && html`<${gameUi.TvOverlay} game=${game} st=${st} now=${now} tv=${tv} />`}
    ${st.rating && !gameScene && p.state !== 'playing' && p.state !== 'paused' && html`<${RatingOverlay} r=${st.rating} />`}
    ${st.photos?.flash && !gameScene && html`<${PhotoFlash} flash=${st.photos.flash} singing=${!!st.current && p.state !== 'idle'} />`}
    ${st.announcement && html`<div class="announce" key=${st.announcement.id}><div>${st.announcement.text}</div></div>`}
    <div class="reactions">${s.reactions.map((r) => html`<div class="reaction" key=${r.id} style=${{ left: `${r.x}%`, '--dx': r.dx }}><b>${r.emoji}</b>${r.name && html`<span>${r.name}</span>`}</div>`)}</div>
    ${s.status !== 'open' && html`<div class="conn-lost">Reconnecting to the server…</div>`}
    ${s.display === 'mirror' && !preview && !board && html`<div class="mirror-badge">Mirror display (muted)</div>`}
    ${s.toast && html`<div class="conn-lost" style="background:var(--stage-3);color:var(--ink)">${s.toast}</div>`}
    ${s.help && html`<${Help} />`}
    ${!s.unlocked && s.display === 'main' && !preview && html`<${StartOverlay} />`}
  `;
}

function StartOverlay() {
  return html`<div class="start" onClick=${start}>
    <div class="big-btn"><${Icon} name="play" /></div>
    <h2>Click to start the TV display</h2>
    <p>Browsers only play sound after a click. This screen plays the music, so put it on the TV connected to the speakers. Press F for full screen, or ? for keyboard shortcuts.</p>
  </div>`;
}

/**
 * A screen on another computer: show a pairing code until the host approves it
 * (Settings → Displays), then keep the token and connect as a TV display.
 */
function Pairing() {
  const [pair, setPair] = useState(null); // { id, code } | { error }
  const [status, setStatus] = useState('waiting');
  const request = async () => {
    setStatus('waiting');
    try {
      const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPair(data);
    } catch (e) {
      setPair({ error: e.message });
    }
  };
  useEffect(() => { request(); }, []);
  useInterval(async () => {
    if (!pair?.id) return;
    try {
      const r = await (await fetch(`/api/pair/${encodeURIComponent(pair.id)}`)).json();
      if (r.status === 'approved' && r.token) {
        localStorage.setItem('ok.tvToken', r.token);
        store.update({ denied: null });
        // The socket keeps retrying after the refusal: reconnect now, with the token.
        clearTimeout(conn.retryTimer);
        conn.attempt = 0;
        conn.open();
      } else if (r.status === 'denied' || r.status === 'expired') {
        setStatus(r.status);
        setPair(null);
      }
    } catch { /* server restarting: keep polling */ }
  }, pair?.id ? 2000 : null);
  return html`<div class="denied pairing">
    <div style="font-size:10vh">📺</div>
    <h2>Connect this screen to the party</h2>
    ${pair?.code && html`<div class="pair-code">${pair.code.split('').map((d) => html`<b>${d}</b>`)}</div>
      <p>On the computer running OpenKaraoke, open the host page → <b>Settings → Displays</b> and approve the screen with this code.</p>`}
    ${pair?.error && html`<p>${pair.error}</p><button class="btn primary large" onClick=${request}>Try again</button>`}
    ${status === 'denied' && html`<p>The host did not approve this screen.</p><button class="btn primary large" onClick=${request}>Ask again</button>`}
    ${status === 'expired' && html`<p>The code expired.</p><button class="btn primary large" onClick=${request}>Show a new code</button>`}
  </div>`;
}

function RatingOverlay({ r }) {
  const who = singersText(r.singers) || 'the singer';
  const full = Math.round(r.avg);
  return html`<div class="tv-rating" key=${r.entryId}>
    <span class="stars" aria-label=${`${r.avg} stars`}>${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>
    <div><b>${r.votes ? `${r.avg.toFixed(1)} from ${r.votes} ${r.votes === 1 ? 'vote' : 'votes'}` : 'Rate the performance!'}</b><span>Give ${who} stars for “${r.title}” on your phone</span></div>
  </div>`;
}

function Help() {
  const rows = [
    ['Space', 'Play / pause'], ['← →', 'Back / forward 5 seconds'], ['+ −', 'Key up / down'], ['[ ]', 'Slower / faster'],
    ['N', 'Next singer'], ['R', 'Restart song'], ['C', 'Channel mode'], ['↑ ↓', 'Volume'], ['F', 'Full screen'], ['?', 'Show or hide this help'],
  ];
  return html`<div class="help" onClick=${() => store.update({ help: false })}><div>
    <h3>Keyboard shortcuts</h3>
    ${rows.map(([k, v]) => html`<kbd>${k}</kbd><span>${v}</span>`)}
  </div></div>`;
}

function Clock() {
  useTick(10000);
  return html`<div class="clock">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
}

/** /tv?layout=board — who's singing and who's next, big, for a screen by the bar or the stage. */
function Board({ st }) {
  useTick(5000);
  const cur = st.current;
  const qr = `/api/qr.svg?margin=0&dark=%231b1230&light=%23fff8e6&text=${encodeURIComponent(st.info.joinUrl)}`;
  return html`<div class="scene board fade-in">
    <header class="board-head"><img src="/img/icon.svg" alt="" /><h1 class="display">${st.info.name}</h1><${Clock} /></header>
    <section class="board-now">
      ${cur
        ? html`<img class="board-cover" src=${artUrl(cur.mystery ? null : cur.songId, 250)} alt="" />
          <div class="ellipsis"><small>${st.player.state === 'playing' || st.player.state === 'paused' ? 'Singing now' : 'Getting ready'}</small>
            <b class="display ellipsis">${cur.singers[0]?.emoji || '🎤'} ${singersText(cur.singers) || 'Sing along'}</b><span class="ellipsis">${cur.title} · ${cur.artist}</span></div>`
        : html`<div><small>Nobody is singing</small><b class="display">Pick a song — you could be next!</b></div>`}
    </section>
    <ol class="board-list">${st.queue.slice(0, 8).map((e, i) => html`<li key=${e.id}>
      <span class="pos num">${i + 1}</span>
      <span class="avatar" style=${{ '--avatar': e.singers[0]?.color }}>${e.singers[0]?.emoji || '🎤'}</span>
      <div class="ellipsis"><b class="ellipsis">${singersText(e.singers) || 'Anyone'}</b><span class="ellipsis">${e.mystery ? '🎁 Mystery song' : `${e.title} · ${e.artist}`}</span></div>
      <span class="eta">${formatEta(e.eta)}</span>
    </li>`)}</ol>
    ${st.queueLength > 8 && html`<p class="board-more">+ ${st.queueLength - 8} more in the queue</p>`}
    ${!st.queue.length && html`<p class="board-more">The queue is empty.</p>`}
    <footer class="board-join"><img src=${qr} alt="" /><div><b>Scan to sing</b><span>${st.info.joinUrl.replace(/^https?:\/\//, '')} · room ${st.info.roomCode}</span></div></footer>
  </div>`;
}

function Lobby({ st }) {
  const info = st.info;
  const qr = `/api/qr.svg?margin=0&dark=%231b1230&light=%23fff8e6&text=${encodeURIComponent(info.joinUrl)}`;
  const next = st.queue.slice(0, 4);
  return html`<div class="scene lobby fade-in">
    <div class="lobby-top">
      <img src="/img/icon.svg" alt="" />
      <h1 class="display">${info.name}</h1>
      <${Clock} />
    </div>
    <div class="lobby-main">
      ${st.display.showQr !== false && html`<div class="marquee"><img src=${qr} alt="QR code to join" /></div>`}
      <div class="join">
        <h2 class="display">Scan to sing</h2>
        <p>${st.guestsEnabled ? 'Point your phone camera at the code, pick a name and choose your songs. We’ll call you up when it’s your turn.' : 'Song requests from phones are closed right now. Ask the host to add your song.'}</p>
        <div class="url">${info.joinUrl.replace(/^https?:\/\//, '')}</div>
        <div class="code-row">Room code <span class="code">${info.roomCode}</span></div>
        ${st.wifi && html`<div class="wifi"><img src=${`/api/qr.svg?margin=0&text=${encodeURIComponent(st.wifi.qr)}`} alt="Wi-Fi QR code" /><span>Wi-Fi: <b>${st.wifi.ssid}</b><br />Scan to connect</span></div>`}
      </div>
    </div>
    ${st.breakMusic && store.get().display === 'main' && html`<div class="break-now" key=${st.breakMusic.id}>♪ ${st.breakMusic.title} · ${st.breakMusic.artist}</div>`}
    <div class="lobby-bottom">
      ${next.length
        ? html`<h3>Up next</h3><div class="upnext-row">${next.map((e) => html`<div class="upnext-item">
            <span class="avatar" style=${{ '--avatar': e.singers[0]?.color }}>${e.singers[0]?.emoji || '🎤'}</span>
            <div class="ellipsis"><b class="ellipsis">${singersText(e.singers) || 'Anyone'}</b><span class="ellipsis">${e.title}</span></div>
          </div>`)}</div>`
        : html`<div class="lobby-empty">${st.library.songs ? `${st.library.songs.toLocaleString()} songs ready to sing. The first song you pick starts the party.` : 'The song library is empty — add your karaoke folder in the host settings.'}</div>`}
    </div>
  </div>`;
}

function Intro({ st }) {
  useTick(250);
  const cur = st.current;
  const p = st.player;
  const singer = cur.singers[0];
  const total = Math.max(1, st.playback.countdown || 1);
  const left = Math.max(0, Math.ceil((p.introEndsAt - conn.serverNow()) / 1000));
  const frac = Math.min(1, left / total);
  let status = 'Get ready!';
  let warn = false;
  if (controller.error) { status = `Can't play this song: ${controller.error}`; warn = true; }
  else if (!p.hasDisplay && store.get().display !== 'main') status = 'Waiting for the main TV display';
  else if (!controller.loaded) status = 'Loading the song…';
  else if (!controller.unlocked) { status = 'Click the screen to allow sound'; warn = true; }
  else if (p.state === 'ready') status = 'Ready when you are — the host starts the song';
  else if (left === 0) status = 'Here we go!';
  const circ = 2 * Math.PI * 44;
  const cover = cur.art?.cover && !cur.mystery;
  const logo = cur.art?.logo && !cur.mystery;
  return html`<div class="scene intro fade-in" key=${cur.id}>
    <div class="kicker">${cur.mystery ? 'Mystery song!' : 'Next singer'}</div>
    ${cover
      ? html`<div class="intro-art"><img class="intro-cover" src=${artUrl(cur.songId, 500)} alt="" /><div class="avatar-big" style=${{ '--c': singer?.color }}>${singer?.emoji || '🎤'}</div></div>`
      : html`<div class="avatar-big" style=${{ '--c': singer?.color }}>${singer?.emoji || '🎤'}</div>`}
    <div class="name display">${singersText(cur.singers) || 'Grab the mic!'}</div>
    <div class="song"><b>${cur.title}</b> by ${cur.artist}${cur.year && !cur.mystery ? html` <span class="year">(${cur.year})</span>` : ''}</div>
    ${logo && html`<img class="artist-logo" src=${artistArtUrl(cur.art.logo, 'logo', { size: 500 })} alt="" />`}
    ${(p.key !== 0 || p.tempo !== 1) && html`<div class="meta">
      ${p.key !== 0 && html`<span class="chip">Key ${formatKey(p.key)}</span>`}
      ${p.tempo !== 1 && html`<span class="chip">Tempo ${formatTempo(p.tempo)}</span>`}
    </div>`}
    ${p.state === 'intro' && left > 0 && html`<div class="countdown">
      <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44" /><circle class="arc" cx="50" cy="50" r="44" stroke-dasharray=${circ} stroke-dashoffset=${circ * (1 - frac)} /></svg>
      <b>${left}</b>
    </div>`}
    <div class=${`status ${warn ? 'warn' : ''}`}>${status}</div>
  </div>`;
}

function Singing({ st }) {
  const cur = st.current;
  const p = st.player;
  const d = st.display;
  useTick(1000);
  const pos = controller.position();
  const dur = controller.duration();
  const next = st.game?.showSongs && !st.game.ended ? null : st.queue[0]; // a battle decides who's next
  const showUpNext = d.showUpNext !== false && next && dur > 0 && dur - pos < 20 && dur - pos > 1;
  const ticker = d.showTicker !== false && (st.queue.length || d.tickerMessage);
  return html`<div class=${`scene ${ticker ? 'with-ticker' : ''}`}>
    ${d.showTitleCard !== false && pos < 12 && html`<div class="titlecard" key=${cur.id}>
      ${cur.art?.cover && !cur.mystery && html`<img class="tc-cover" src=${artUrl(cur.songId, 250)} alt="" />`}
      <span class="avatar" style=${{ '--avatar': cur.singers[0]?.color }}>${cur.singers[0]?.emoji || '🎤'}</span>
      <div class="ellipsis"><b class="display ellipsis">${singersText(cur.singers) || 'Sing along!'}</b><span>${cur.title} by ${cur.artist}</span></div>
    </div>`}
    ${d.showQr !== false && html`<div class="corner-qr"><img src=${`/api/qr.svg?margin=0&dark=%231b1230&light=%23fff8e6&text=${encodeURIComponent(st.info.joinUrl)}`} alt="" /><span>${st.info.roomCode}</span></div>`}
    ${showUpNext && html`<div class="upnext-banner">
      <span class="avatar" style=${{ '--avatar': next.singers[0]?.color }}>${next.singers[0]?.emoji || '🎤'}</span>
      <div><small>Up next, get ready</small><b>${singersText(next.singers) || 'Next song'}</b></div>
    </div>`}
    ${ticker && html`<div class="ticker">
      ${st.queue.length > 0 && html`<span class="label">Up next</span>`}
      <div class="names">${st.queue.slice(0, 5).map((e) => html`<span>${e.singers[0]?.emoji || '🎤'} ${singersText(e.singers) || 'Anyone'} <em>${e.title}</em></span>`)}</div>
      ${d.tickerMessage && html`<span class="message">${d.tickerMessage}</span>`}
    </div>`}
    ${d.showProgress !== false && html`<div class="progress"><i></i></div>`}
    ${p.state === 'paused' && !controller.error && html`<div class="paused-pill"><${Icon} name="pause" /> Paused</div>`}
    ${(controller.error || p.error) && html`<div class="tv-error"><b>Can't play this song</b><span>${controller.error || p.error}</span></div>`}
  </div>`;
}

render(html`<${Background} />`, document.getElementById('bg'));
render(html`<${App} />`, document.getElementById('app'));
conn.connect();
