// The headphone monitor (PLAN §29): the song as the TV plays it — same key, tempo and channels,
// with its own guide-singer level on multiplex tracks — on headphones plugged into this computer,
// kept in time with the TV. It runs the TV's own audio engine in this page, on the output chosen
// for previews, and follows the TV's reported position on the server's clock (shared/monitor.js).
import { html, useEffect, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { createStore, useStore } from '../lib/store.js';
import { AudioEngine } from '../lib/audio-engine.js';
import { Switch } from '../lib/components.js';
import { store, conn, toast } from './state.js';
import { storedSink, LOOPBACK, PreviewOutput } from './preview.js';
import { tvPosition, monitorStep, monitorMix, monitorSource, clampDelay, MAX_DELAY_MS } from '/shared/monitor.js';

const PREFS_KEY = 'ok.monitor'; // { lead, volume, delays: { <output id>: ms } }
const TICK_MS = 200;

const readPrefs = () => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { lead: Number.isFinite(p.lead) ? p.lead : null, volume: Number.isFinite(p.volume) ? p.volume : 0.8, delays: p.delays && typeof p.delays === 'object' ? p.delays : {} };
  } catch {
    return { lead: null, volume: 0.8, delays: {} };
  }
};

export const monitorStore = createStore({ on: false, status: 'off', note: '', err: null, ...readPrefs() });

const savePrefs = () => {
  const { lead, volume, delays } = monitorStore.get();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lead, volume, delays }));
  } catch { /* private window: for this visit only */ }
};

/** The TV that plays the party's sound is on this computer (so the default output is the room's). */
function tvHere(state) {
  return LOOPBACK.has(location.hostname) && (state?.displays || []).some((d) => d.local && d.display === 'main');
}

/** The delay (ms) set for the output the monitor plays on. */
export const delayFor = (sink) => clampDelay(monitorStore.get().delays[sink || 'default'] || 0);

class Monitor {
  constructor() {
    this.engine = null;
    this.timer = null;
    this.loaded = null; // { entryId, trackId, url }
    this.loading = null;
    this.lastSeekAt = -Infinity;
    this.element = null;
    this.sink = '';
  }

  /** Switched on (a click: browsers start audio only after one). False when it can't play here. */
  async start() {
    const state = store.get().state;
    this.sink = storedSink();
    if (!this.sink && tvHere(state) && !window.__okMonitorAnyOutput) {
      monitorStore.update({ status: 'no-output', on: false });
      return false;
    }
    this.engine = new AudioEngine();
    await this.engine.unlock();
    if (this.sink) {
      if (!this.engine.ctx.setSinkId) {
        this.stop();
        monitorStore.update({ status: 'no-sink-api', on: false });
        return false;
      }
      try {
        await this.engine.ctx.setSinkId(this.sink);
      } catch {
        this.stop();
        monitorStore.update({ status: 'no-headphones', on: false });
        return false;
      }
    }
    this.engine.setVolume(monitorStore.get().volume);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    monitorStore.update({ on: true, status: 'waiting', err: null });
    this.tick();
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const e = this.engine;
    this.engine = null;
    this.loaded = null;
    this.loading = null;
    this.failed = null;
    if (e) {
      e.unload();
      clearInterval(e.ticker);
      e.ctx?.close().catch(() => {});
    }
    this.element?.removeAttribute('src');
    this.element = null;
    monitorStore.update({ on: false, status: 'off', err: null });
  }

  /** Loads the song on the TV (once per song, again when the TV reloads it). */
  async load(cur) {
    const src = monitorSource(cur.media);
    const key = `${cur.id}|${cur.trackId}|${src?.url || ''}`;
    if (this.loaded?.key === key || this.loading === key || this.failed === key) return;
    this.loading = key;
    this.loaded = null;
    const e = this.engine;
    try {
      if (!src) throw new Error('waiting');
      if (src.mode === 'buffer') {
        await e.load(cur.trackId, src.url);
      } else {
        this.element ||= new Audio();
        await e.loadElement(cur.trackId, this.element, src.url);
      }
      if (this.engine !== e || this.loading !== key) return;
      this.loaded = { key, entryId: cur.id };
      this.lastSeekAt = -Infinity;
      monitorStore.update({ status: 'waiting' });
    } catch (err) {
      if (err?.superseded || this.engine !== e) return;
      if (this.loading === key) this.loading = null;
      if (err.message !== 'waiting') this.failed = key; // not again until the song (or its file) changes
      monitorStore.update({ status: err.message === 'waiting' ? 'converting' : 'error', note: err.message === 'waiting' ? '' : err.message });
    } finally {
      if (this.loading === key) this.loading = null;
    }
  }

  tick() {
    const e = this.engine;
    if (!e) return;
    const { state, time } = store.get();
    const cur = state?.current;
    const p = state?.player;
    if (!cur || !p || !['intro', 'ready', 'playing', 'paused'].includes(p.state)) {
      if (this.loaded || e.track) { e.unload(); this.loaded = null; }
      monitorStore.update({ status: 'idle' });
      return;
    }
    this.load(cur);
    if (!this.loaded || this.loaded.entryId !== cur.id || !e.track) return;
    const prefs = monitorStore.get();
    e.setNormalize(state.settings?.playback?.normalize !== false);
    e.setKey(p.key);
    e.setTempo(p.tempo);
    e.setMix(monitorMix(p, prefs.lead));
    e.setVolume(prefs.volume);
    const report = time && time.entryId === cur.id ? time : null;
    const tvPlaying = p.state === 'playing' && !!report?.playing;
    const step = monitorStep({
      tv: report ? tvPosition(report, conn.serverNow(), p.tempo) : null,
      tvPlaying,
      position: e.position,
      playing: e.playing,
      delayMs: delayFor(this.sink),
      now: performance.now(),
      lastSeekAt: this.lastSeekAt,
    });
    // A jump lands where the TV will be once the engine's own start-up and output delay have passed.
    const lead = () => (e.track.mode === 'buffer' ? (e.ctx.currentTime + 0.05 - e.heardTime()) * (p.tempo || 1) : 0);
    if (step.action === 'play') {
      e.play(step.to + lead());
      this.lastSeekAt = performance.now();
    } else if (step.action === 'seek') {
      e.seek(step.to + lead());
      this.lastSeekAt = performance.now();
    } else if (step.action === 'pause') {
      e.pause();
    }
    monitorStore.update({ status: tvPlaying ? 'in-time' : 'paused', err: step.err ?? null });
  }
}

export const monitor = new Monitor();

/** The Playback tab's monitor card: on/off, where it plays, its guide level, volume and delay. */
export function MonitorCard({ state }) {
  const m = useStore(monitorStore);
  const [sink, setSink] = useState(storedSink);
  useEffect(() => {
    const t = setInterval(() => setSink(storedSink()), 1000); // (chosen in the output picker below)
    return () => clearInterval(t);
  }, []);
  const adjustable = !!state.player?.vocals?.adjustable && !!state.current;
  const lead = m.lead ?? state.player?.lead ?? 0;
  const delay = delayFor(sink);
  const setPref = (patch) => {
    monitorStore.update(patch);
    savePrefs();
  };
  // (The monitor goes on when the card is out of sight: the Queue tab, another page.)
  const toggle = async () => {
    if (m.on) monitor.stop();
    else if (!(await monitor.start())) {
      const why = monitorStore.get().status;
      toast(why === 'no-output' ? 'Choose the headphones first — the default output is the TV’s.'
        : why === 'no-sink-api' ? 'This browser can’t send the monitor to headphones: use Chrome, Edge or the OpenKaraoke app.'
        : 'Those headphones aren’t there (unplugged?) — choose them again.', 'error', 6000);
    }
  };
  const STATUS = {
    off: '', waiting: 'Loading the song…', idle: 'Nothing playing', paused: 'Paused with the TV',
    'in-time': 'In time with the TV', converting: 'The video is still being converted', error: `Can’t play this song here: ${m.note}`,
  };
  return html`<div class="monitor-card" id="pb-monitor">
    <div class="monitor-head">
      <div><b><${Icon} name="headphones" size=${16} /> Headphone monitor</b>
        <p class="hint">The song as the TV plays it, in time, on headphones on this computer — with its own guide singer level.</p></div>
      <${Switch} checked=${m.on} label="Headphone monitor" onChange=${toggle} />
    </div>
    ${m.on && html`<p class=${`monitor-status ${m.status}`} role="status">${STATUS[m.status] || ''}</p>`}
    <${PreviewOutput} displays=${state.displays} what="The monitor and previews" label="Headphones (the monitor and previews)" />
    ${adjustable && html`<label class="monitor-row"><span>Guide singer</span>
      <input type="range" min="0" max="100" step="5" value=${lead} aria-label="Guide singer in the headphones"
        style=${{ '--p': `${lead}%` }} onInput=${(e) => setPref({ lead: Number(e.currentTarget.value) })} />
      <b class="num">${lead}</b></label>`}
    ${adjustable && html`<p class="hint monitor-sub">${m.lead === null
      ? 'As the room — move it for a guide in the headphones only.'
      : html`The room: ${state.player.lead}. <button class="link" onClick=${() => setPref({ lead: null })}>As the room</button>`}</p>`}
    <label class="monitor-row"><span>Volume</span>
      <input type="range" min="0" max="1" step="0.05" value=${m.volume} aria-label="Monitor volume"
        style=${{ '--p': `${m.volume * 100}%` }} onInput=${(e) => setPref({ volume: Number(e.currentTarget.value) })} /></label>
    <label class="monitor-row"><span>Delay</span>
      <input type="range" min=${-MAX_DELAY_MS} max=${MAX_DELAY_MS} step="10" value=${delay} aria-label="Headphone delay"
        style=${{ '--p': `${((delay + MAX_DELAY_MS) / (2 * MAX_DELAY_MS)) * 100}%` }}
        onInput=${(e) => setPref({ delays: { ...m.delays, [sink || 'default']: clampDelay(e.currentTarget.value) } })} />
      <b class="num">${delay > 0 ? '+' : ''}${delay} ms</b></label>
    <p class="hint">Headphones behind the TV (Bluetooth often is)? Move Delay right until the two line up. It is kept for each output.</p>
  </div>`;
}
