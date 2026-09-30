// TV display app: lobby with QR code, next-singer intro, lyrics stage and overlays.
import { html, render, useEffect, useRef } from '/js/vendor/preact.js';
import { Connection, deviceId, storage } from '/js/lib/ws-client.js';
import { createStore, useStore } from '/js/lib/store.js';
import { qrUrl, artUrl } from '/js/lib/api.js';
import { SingerBadge, Cover, useNow, names } from '/js/lib/ui.js';
import { formatKey, formatTempo } from '/shared/protocol.js';
import { TvPlayer } from './player.js';

const params = new URLSearchParams(location.search);
const display = params.get('display') === 'mirror' ? 'mirror' : 'main';
const store = createStore({ tv: null, pairing: null, conn: 'connecting', denied: null, unlocked: false, reactions: [] });

const conn = new Connection({
  hello: () => ({ role: 'tv', deviceId: deviceId('ok.display'), display, token: storage('ok.tvToken') || undefined, name: params.get('name') || '' }),
});

// The canvas and video live outside Preact so re-renders never recreate them.
const canvas = document.createElement('canvas');
canvas.className = 'cdg';
const video = document.createElement('video');
video.className = 'video off';
video.playsInline = true;
const player = new TvPlayer({ conn, canvas, video });
window.__player = player; // handy for debugging from the console

conn.on('state', (m) => {
  if (m.role === 'tvpending') { store.set({ pairing: m, tv: null }); return; }
  if (m.role !== 'tv') return;
  store.set({ tv: m, pairing: null });
  applyTheme(m.display);
  player.apply(m);
});
conn.on('paired', (m) => {
  storage('ok.tvToken', m.token);
  conn.rehello();
});
conn.on('status', ({ status, detail }) => store.set({ conn: status, denied: status === 'denied' ? detail : null }));

let reactionId = 0;
conn.on('reaction', (m) => {
  if (store.get().tv?.display?.showReactions === false) return;
  const id = ++reactionId;
  const r = { id, emoji: m.emoji, name: m.name, color: m.color, x: 5 + Math.random() * 85 };
  store.set((s) => ({ ...s, reactions: [...s.reactions.slice(-40), r] }));
  setTimeout(() => store.set((s) => ({ ...s, reactions: s.reactions.filter((x) => x.id !== id) })), 3700);
});

function applyTheme(d) {
  if (d?.accent && /^#[0-9a-f]{6}$/i.test(d.accent)) document.documentElement.style.setProperty('--accent', d.accent);
}

// ---- keyboard shortcuts (single-screen use on the party PC) ----------------------------
const KEYS = {
  ' ': ['player.toggle'],
  k: ['player.toggle'],
  ArrowRight: ['player.next'],
  n: ['player.next'],
  ArrowLeft: ['player.restart'],
  ArrowUp: ['player.volume', { delta: 0.05 }],
  ArrowDown: ['player.volume', { delta: -0.05 }],
  '+': ['player.key', { delta: 1 }],
  '=': ['player.key', { delta: 1 }],
  '-': ['player.key', { delta: -1 }],
  ']': ['player.tempo', { delta: 0.05 }],
  '[': ['player.tempo', { delta: -0.05 }],
};
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
  const cmd = KEYS[e.key];
  if (!cmd) return;
  e.preventDefault();
  conn.request(cmd[0], cmd[1] || {}).catch(() => {});
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// hide the mouse pointer when idle
let cursorTimer;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2500);
});

// ---- components ---------------------------------------------------------------------------

function usePosition(ms = 250) {
  useNow(ms);
  return { pos: player.position, dur: player.duration };
}

function Background({ tv, scene }) {
  const cur = tv.current;
  const bgMode = tv.display?.background || 'art';
  const showArt = scene !== 'lobby' && bgMode === 'art' && cur;
  return html`<div class="bg">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    ${showArt && html`<div class="art" key=${cur.songId} style=${{ backgroundImage: `url("${artUrl({ id: cur.songId }, 1000, { plain: true })}")` }}></div>`}
    ${scene !== 'lobby' && bgMode === 'visualizer' && html`<${Visualizer} />`}
    <div class="shade"></div>
  </div>`;
}

function Visualizer() {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    const g = c.getContext('2d');
    let raf;
    const data = new Uint8Array(256);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = (c.width = c.clientWidth / 2);
      const h = (c.height = c.clientHeight / 2);
      const an = player.engine.analyser;
      if (!an) return;
      an.getByteFrequencyData(data);
      g.clearRect(0, 0, w, h);
      const bars = 64;
      const bw = w / bars;
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff3d8b';
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) ** 1.6 * 200)] / 255;
        const bh = v * h * 0.7;
        g.fillStyle = accent;
        g.globalAlpha = 0.25 + v * 0.6;
        g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return html`<canvas class="viz" ref=${ref}></canvas>`;
}

function Stage({ tv, visible }) {
  const host = useRef();
  const st = useStore(player.status);
  useEffect(() => {
    host.current.appendChild(canvas);
    host.current.appendChild(video);
  }, []);
  const d = tv.display || {};
  const isVideo = st.kind === 'video';
  useEffect(() => {
    video.className = `video${isVideo ? '' : ' off'}`;
    canvas.style.display = isVideo ? 'none' : '';
    canvas.classList.toggle('pixelated', d.cdgSmoothing === false);
  }, [isVideo, d.cdgSmoothing]);
  const p = tv.player;
  const opaque = d.cdgTransparent === false;
  return html`<div class=${`stage${visible ? '' : ' off'}${opaque ? ' opaque' : ''}`}>
    <div class="screen" ref=${host} style=${opaque && player.cdg.loaded ? { background: player.cdg.paperColor() } : null}></div>
    ${visible && st.loading && html`<div class="center-msg"><div class="spinner"></div><div>Loading…</div></div>`}
    ${visible && st.error && html`<div class="center-msg"><div class="big">⚠️</div><div>${st.error}</div></div>`}
    ${visible && !st.loading && !st.error && p.state === 'paused' && html`<div class="center-msg">
      <div class="big">${p.position > 1 ? '⏸' : '🎤'}</div>
      <div>${p.displayLost ? 'Paused — display reconnected' : p.position > 1 ? 'Paused' : 'Ready when you are!'}</div>
    </div>`}
  </div>`;
}

function StageHud({ tv }) {
  const { pos, dur } = usePosition();
  const cur = tv.current;
  const d = tv.display || {};
  const p = tv.player;
  const next = tv.next?.[0];
  const showCard = d.showTitleCard !== false && p.state === 'playing' && pos < 7;
  const showNext = d.showUpNext !== false && next && dur > 0 && dur - pos < 20 && dur - pos > 0;
  const modified = (p.key || 0) !== 0 || (p.tempo || 1) !== 1;
  return html`<div class="hud">
    <div class="hud-top">
      <div>
        <div class="now-chip">
          ${cur.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${48} />`)}
          <div><div class="who">${names(cur.singers)}</div><div class="what ellipsis">${cur.title} · ${cur.artist}</div></div>
        </div>
        ${modified && html`<div class="chips">
          ${p.key ? html`<span class="c">Key ${formatKey(p.key)}</span>` : null}
          ${p.tempo !== 1 ? html`<span class="c">Tempo ${formatTempo(p.tempo)}</span>` : null}
        </div>`}
      </div>
      ${d.showQr !== false && html`<div class="qr-mini"><img src=${qrUrl(tv.party.joinUrl)} alt="" /><span>${tv.party.roomCode}</span></div>`}
    </div>
    ${showCard && html`<div class="title-card">
      <div class="t">${cur.title}</div>
      <div class="a">${cur.artist}</div>
      <div class="s">${cur.singers.map((s) => html`<${SingerBadge} key=${s.id} singer=${s} size=${40} />`)} <b>${names(cur.singers)}</b></div>
    </div>`}
    ${showNext && html`<div class="upnext">
      ${next.singers[0] && html`<${SingerBadge} singer=${next.singers[0]} size=${56} />`}
      <div><div class="l">Up next</div><div class="n">${names(next.singers)}</div><div class="m">${next.title}</div></div>
    </div>`}
    <div class="bottom">
      ${d.showProgress !== false && html`<div class="progress"><div style=${{ width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }}></div></div>`}
      ${d.showTicker !== false && html`<${Ticker} tv=${tv} />`}
    </div>
  </div>`;
}

function Ticker({ tv }) {
  const items = (tv.next || []).slice(0, 6);
  const msg = tv.display?.tickerMessage;
  if (!items.length && !msg) return null;
  return html`<div class="ticker">
    ${items.length ? html`<span class="label">Next</span>` : null}
    <div class="items">
      ${items.map((e) => html`<div class="item" key=${e.id}>
        ${e.singers[0] && html`<${SingerBadge} singer=${e.singers[0]} size=${30} />`}
        <b>${names(e.singers)}</b><span>${e.title}</span>
      </div>`)}
    </div>
    ${msg && html`<span class="msg">${msg}</span>`}
  </div>`;
}

function Lobby({ tv }) {
  const next = tv.next || [];
  return html`<div class="lobby">
    <div>
      <h1 class="gradient-text">${tv.party.name}</h1>
      <p class="lead">📱 Scan the code to pick a song</p>
      <p class="sub">Search ${tv.library.songs.toLocaleString()} karaoke songs and add yourself to the queue.</p>
      <div class="url">${tv.party.joinUrl.replace(/^https?:\/\//, '')}</div>
      <div class="code">Party code <b>${tv.party.roomCode}</b></div>
      ${next.length > 0 && html`<div class="queue-peek">
        <div class="label" style=${{ color: 'var(--accent)', fontWeight: 800, letterSpacing: '.15em', textTransform: 'uppercase', fontSize: '2vh' }}>Coming up</div>
        ${next.slice(0, 4).map((e) => html`<div class="item" key=${e.id}>${e.singers[0] && html`<${SingerBadge} singer=${e.singers[0]} size=${40} />`}<b>${names(e.singers)}</b><span class="muted">${e.title}</span></div>`)}
      </div>`}
      ${tv.wifi?.ssid && html`<div class="wifi"><img src=${wifiQr(tv.wifi)} alt="" /><div>Wi-Fi<br /><b style=${{ color: '#fff' }}>${tv.wifi.ssid}</b></div></div>`}
    </div>
    <div class="qr-card"><img src=${qrUrl(tv.party.joinUrl, { margin: 1 })} alt="QR code to join" /></div>
    <div class="stats">
      <span><b>${tv.guests}</b> guest${tv.guests === 1 ? '' : 's'} connected</span>
      ${tv.queueLength > 0 && html`<span><b>${tv.queueLength}</b> song${tv.queueLength === 1 ? '' : 's'} in the queue</span>`}
      ${tv.library.state === 'offline' && html`<span style=${{ color: 'var(--err)' }}>⚠ Library drive offline</span>`}
    </div>
  </div>`;
}

function wifiQr(w) {
  const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  const t = w.password ? (w.security || 'WPA') : 'nopass';
  return qrUrl(`WIFI:T:${t};S:${esc(w.ssid)};${w.password ? `P:${esc(w.password)};` : ''}${w.hidden ? 'H:true;' : ''};`, { margin: 1 });
}

function Intro({ tv }) {
  const now = useNow(200);
  const cur = tv.current;
  const p = tv.player;
  const serverNow = now + conn.offset;
  const total = Math.max(1, tv.playback?.countdown || 10);
  const left = Math.max(0, (p.introEndsAt - serverNow) / 1000);
  const frac = Math.min(1, left / total);
  const singer = cur.singers[0];
  const R = 45;
  const C = 2 * Math.PI * R;
  return html`<div class="intro">
    <div class="left">
      <div class="label">Next singer</div>
      ${singer ? html`<${SingerBadge} singer=${singer} size=${0} class="avatar" />` : null}
      <div class="who" style=${{ color: singer?.color || '#fff' }}>${names(cur.singers)}</div>
    </div>
    <div class="right">
      <div class="song">
        <${Cover} song=${{ id: cur.songId }} size=${200} big=${true} />
        <div><div class="t">${cur.title}</div><div class="a">${cur.artist}</div></div>
      </div>
      <div class="count">
        <div class="ring">
          <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r=${R} fill="none" stroke="rgba(255,255,255,.15)" stroke-width="8" />
            <circle cx="50" cy="50" r=${R} fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray=${C} stroke-dashoffset=${C * (1 - frac)} style=${{ transition: 'stroke-dashoffset .2s linear' }} /></svg>
          <b>${Math.ceil(left)}</b>
        </div>
        <div>Get ready — grab the mic! 🎤</div>
      </div>
      ${(p.key || p.tempo !== 1) ? html`<div class="chips" style=${{ marginTop: '3vh' }}>
        ${p.key ? html`<span class="c">Key ${formatKey(p.key)}</span>` : null}
        ${p.tempo !== 1 ? html`<span class="c">Tempo ${formatTempo(p.tempo)}</span>` : null}
      </div>` : null}
    </div>
  </div>`;
}

function Reactions() {
  const list = useStore(store, (s) => s.reactions);
  return html`<div class="reactions">${list.map((r) => html`<div key=${r.id} class="reaction" style=${{ left: `${r.x}%` }}>${r.emoji}<small style=${{ color: r.color }}>${r.name}</small></div>`)}</div>`;
}

function UnlockGate() {
  const unlocked = useStore(store, (s) => s.unlocked);
  if (unlocked) return null;
  const go = async () => {
    await player.unlock().catch(() => {});
    if (params.get('fullscreen') !== '0') document.documentElement.requestFullscreen?.().catch(() => {});
    store.set({ unlocked: player.engine.unlocked });
  };
  return html`<div class="gate" onClick=${go}>
    <div style=${{ fontSize: '12vh' }}>🎤</div>
    <button class="btn primary big">Start the TV display</button>
    <p>Browsers need one click before a page may play sound. Tip: start the TV with <b>bin/open-tv.sh</b> to skip this.</p>
  </div>`;
}

function Splash({ conn: status, denied }) {
  return html`<div class="tv"><div class="bg"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>
    <div class="center-msg">${status === 'denied' ? html`<div class="big">🚫</div><div>${denied?.reason || 'Not allowed'}</div>` : html`<div class="spinner"></div><div>Connecting to OpenKaraoke…</div>`}</div>
  </div>`;
}

function Pairing({ pairing }) {
  return html`<div class="tv pairing"><div class="bg"><div class="blob b1"></div><div class="blob b2"></div></div>
    <div class="center-msg">
      <div>Connect this screen to <b>${pairing.party?.name || 'the party'}</b></div>
      <div class="code">${pairing.pairCode}</div>
      <div style=${{ color: '#cfc9ee' }}>On the host computer, open <b>Displays</b> and approve this code.</div>
    </div>
  </div>`;
}

function App() {
  const s = useStore(store);
  if (s.pairing) return html`<${Pairing} pairing=${s.pairing} />`;
  if (!s.tv) return html`<${Splash} conn=${s.conn} denied=${s.denied} />`;
  const tv = s.tv;
  const p = tv.player;
  const scene = tv.current ? (p.state === 'intro' ? 'intro' : 'stage') : 'lobby';
  const announce = tv.announce && tv.announce.until > Date.now() + conn.offset ? tv.announce : null;
  return html`<div class=${`tv scene-${scene}`}>
    <${Background} tv=${tv} scene=${scene} />
    <${Stage} tv=${tv} visible=${scene === 'stage'} />
    ${scene === 'stage' && html`<${StageHud} tv=${tv} />`}
    ${scene === 'lobby' && html`<${Lobby} tv=${tv} />`}
    ${scene === 'intro' && html`<${Intro} tv=${tv} />`}
    <${Reactions} />
    ${announce && html`<div class="announce" key=${announce.until}>${announce.text}</div>`}
    ${!tv.main && html`<div class="mirror-badge">Mirror display (muted)</div>`}
    ${s.conn !== 'open' && html`<div class="conn-badge">Reconnecting…</div>`}
    ${tv.main && html`<${UnlockGate} />`}
  </div>`;
}

// Announcements expire on their own: re-render when they end.
setInterval(() => {
  const a = store.get().tv?.announce;
  if (a && a.until <= Date.now() + conn.offset) store.set((s) => ({ ...s, tv: { ...s.tv, announce: null } }));
}, 500);

async function boot() {
  render(html`<${App} />`, document.getElementById('app'));
  await player.init();
  // Autoplay allowed (kiosk flag) → no click needed.
  player.engine.ctx.resume().catch(() => {});
  setTimeout(() => store.set({ unlocked: player.engine.unlocked }), 400);
  player.engine.ctx.addEventListener('statechange', () => store.set({ unlocked: player.engine.unlocked }));
  conn.connect();
}

boot();
