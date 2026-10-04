// The TV's lyrics (docs/PLAN.md §9, "Readable lyrics"). The canvas holds the CD+G decoder's whole
// 300×216 memory (with smoothing: Scale2x, 600×432) inside a clipping window; the disc's scroll
// offsets and the smoothed scroll are a compositor transform of the canvas in whole device
// pixels, so a 1-pixel scroll step redraws nothing, and a change redraws only the rectangle of
// memory that changed. Nothing that moves has a CSS filter, mask, backdrop-filter or rounded
// clip (they made software drawing crawl): the plate behind the window is a static element and
// the outline is baked into the pixels. Colours (keying, readable palette, roles) and the scroll
// curve come from /shared/lyrics.js.
//
// DOM (public/tv.html): #lyrics (the box, placed here) > .lyr-plate (static: the panel's plate
// or the disc look's frame) + .lyr-window (position absolute, overflow hidden) > canvas
// (position absolute at 0, 0). The box keeps today's size and place; with smoothing off it
// snaps to a whole number of device pixels per CD+G pixel (when it is smaller than the disc, as
// in the host's preview, it shrinks the way smoothing does).
import { CdgDecoder, scale2xRect, CDG_WIDTH as MW, CDG_HEIGHT as MH, CDG_VISIBLE_X as VX, CDG_VISIBLE_Y as VY, CDG_VISIBLE_WIDTH as VW, CDG_VISIBLE_HEIGHT as VH } from '/shared/cdg.js';
import {
  ScreenKeying, lyricsLut, outlineIndices, rolesFromHist, rolesFromStats, roleStatsAsync, scrollShift, scrollTimeline,
  normalizeLyricsLook, normalizeLyricsMotion,
} from '/shared/lyrics.js';
import { token } from './theme.js';

const MEM = MW * MH;
const HOLD = 0.3; // seconds: a smaller backward step of the clock is held (jitter), a bigger one is a seek

/** The current skin's plate and outline colours (tokens), for setOptions(). */
export function lyricsColours() {
  const rgb = (name) => {
    const m = (token(name) || '').match(/\d+(?:\.\d+)?/g);
    return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null;
  };
  const a = parseFloat(token('--lyrics-plate-alpha'));
  return {
    plate: { rgb: rgb('--lyrics-plate-rgb') || rgb('--night-rgb') || [0, 0, 0], a: Number.isFinite(a) ? a : 0.9 },
    outline: { rgb: rgb('--shade-rgb') || [0, 0, 0], a: 0.9 },
  };
}

export class LyricsRenderer {
  /**
   * elements: { lyrics, plate, win, canvas } (see above); options: as setOptions(). Follows
   * window resizes and devicePixelRatio changes by itself (destroy() stops that).
   */
  constructor({ lyrics, plate, win, canvas }, options = {}) {
    this.lyrics = lyrics;
    this.plateEl = plate;
    this.win = win;
    this.canvas = canvas;
    this.view = lyrics.ownerDocument.defaultView;
    this.g = canvas.getContext('2d', { alpha: true });
    this.look = normalizeLyricsLook(options.look);
    this.motion = normalizeLyricsMotion(options.motion);
    this.smoothing = options.smoothing !== false;
    this.plate = options.plate || { rgb: [0, 0, 0], a: 0.9 };
    this.outline = options.outline || { rgb: [0, 0, 0], a: 0.9 };
    this.lyrics.dataset.look = this.look;
    this.decoder = null;
    this.timeline = null;
    this.roles = null; // the song's colour roles, once the load-time pass is done
    this.gen = 0; // bumps on every load/unload: a late role pass for an old song is dropped
    this.idx = new Uint8Array(MEM); // memory indices with the outline baked in
    this.big = new Uint8Array(MEM * 4); // their Scale2x
    this.drawnMem = new Uint8Array(MEM); // the memory as last drawn
    this.hist = new Uint32Array(16);
    this.keying = new ScreenKeying(); // which colours are background, held still for each screen
    this.lutCache = new Map();
    this.lut = null;
    this.lutKey = '';
    this.full = true;
    this.stale = false;
    this.drawnVersion = -1;
    this.lastT = null;
    this.lastTf = '';
    this.border = '';
    this.layout();
    this.onResize = () => this.layout();
    this.view.addEventListener('resize', this.onResize);
    this.watchDpr();
  }

  /**
   * look: 'panel' | 'clear' | 'disc'; smoothing: rounded letters (Scale2x, filtered) or the
   * disc's square pixels (a whole number of device pixels each); motion: 'smooth' | 'disc';
   * plate, outline: { rgb: [r, g, b], a } (lyricsColours()).
   */
  setOptions({ look = this.look, smoothing = this.smoothing, motion = this.motion, plate = this.plate, outline = this.outline } = {}) {
    look = normalizeLyricsLook(look);
    motion = normalizeLyricsMotion(motion);
    smoothing = smoothing !== false;
    const relayout = smoothing !== this.smoothing || motion !== this.motion;
    const recolour = look !== this.look || JSON.stringify([plate, outline]) !== JSON.stringify([this.plate, this.outline]);
    Object.assign(this, { look, smoothing, motion, plate, outline });
    if (this.lyrics.dataset.look !== look) this.lyrics.dataset.look = look;
    if (recolour) this.stale = true;
    if (relayout) this.layout();
  }

  get loaded() {
    return !!this.decoder;
  }

  /** CSS colour of the disc's border (the disc look's frame), '' before a song. */
  get borderCss() {
    return this.border;
  }

  /** CD+G rows hidden at the top and bottom of the window: the rows the smoothed scroll could show early or late. */
  get insets() {
    const tl = this.motion === 'smooth' ? this.timeline : null;
    return tl?.w ? { top: tl.insTop, bottom: tl.insBot } : { top: 0, bottom: 0 };
  }

  load(bytes) {
    const gen = ++this.gen;
    this.decoder = new CdgDecoder(bytes);
    this.timeline = scrollTimeline(this.decoder.bytes);
    this.roles = null;
    this.keying = new ScreenKeying();
    this.lastT = null;
    this.drawnVersion = -1;
    // (the first 10 s before this returns: a title card's screen is known before it is drawn)
    roleStatsAsync(this.decoder.bytes, { cancelled: () => gen !== this.gen, screens: this.keying.screens, syncSeconds: 10 }).then((stats) => {
      if (!stats || gen !== this.gen) return;
      this.roles = rolesFromStats(stats);
      this.stale = true;
    }, () => {}); // no statistics: every colour stays a fill
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.layout();
  }

  unload() {
    this.gen++;
    this.decoder = null;
    this.timeline = null;
    this.roles = null;
    this.lastT = null;
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.layout();
  }

  destroy() {
    this.gen++;
    this.view.removeEventListener('resize', this.onResize);
    this.dprQuery?.removeEventListener('change', this.onDpr);
  }

  watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = this.view.matchMedia?.(`(resolution: ${this.view.devicePixelRatio || 1}dppx)`);
    this.onDpr = () => {
      this.layout();
      this.watchDpr();
    };
    this.dprQuery?.addEventListener('change', this.onDpr);
  }

  /** Box, window and canvas geometry in whole device pixels; then everything is drawn again. */
  layout() {
    const view = this.view;
    const dpr = view.devicePixelRatio || 1;
    const target = Math.min(0.86 * view.innerHeight * dpr, (0.86 * view.innerWidth * dpr) / 1.5); // today's box height
    // smoothing: a height in multiples of 16 device px (12 CD+G rows are whole device px); off: whole device px per
    // CD+G px, and below one (the host's small preview) the same multiples of 16 as smoothing, filtered
    const sixteens = Math.max(16, Math.floor(target / 16) * 16) / VH;
    const k = this.smoothing || target < VH ? sixteens : Math.floor(target / VH);
    const boxW = VW * k;
    const boxH = VH * k;
    const left = Math.round((view.innerWidth * dpr - boxW) / 2);
    const top = Math.round((view.innerHeight * dpr - boxH) / 2);
    const ins = this.insets;
    const insTop = Math.round(ins.top * k);
    const insBot = Math.round(ins.bottom * k);
    const px = (v) => `${v / dpr}px`;
    Object.assign(this.lyrics.style, { left: px(left), top: px(top), width: px(boxW), height: px(boxH) });
    Object.assign(this.win.style, { left: '0px', top: px(insTop), width: px(boxW), height: px(boxH - insTop - insBot) });
    const c = this.canvas;
    const cw = this.smoothing ? MW * 2 : MW;
    const ch = this.smoothing ? MH * 2 : MH;
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    if (!this.image || this.image.width !== cw || this.image.height !== ch) {
      this.image = this.g.createImageData(cw, ch);
      this.u32 = new Uint32Array(this.image.data.buffer);
    }
    Object.assign(c.style, {
      width: px(MW * k), height: px(MH * k), maxWidth: 'none', maxHeight: 'none', // (base.css caps canvases at 100 %: this one is wider than its window)
      transformOrigin: '0 0', willChange: 'transform', imageRendering: this.smoothing || k < 1 ? 'auto' : 'pixelated', // (a nearest-neighbour shrink drops strokes)
    });
    const root = this.lyrics.ownerDocument.documentElement.style;
    root.setProperty('--lyr-left', px(left));
    root.setProperty('--lyr-top', px(top));
    root.setProperty('--lyr-w', px(boxW));
    root.setProperty('--lyr-h', px(boxH));
    this.k = k;
    this.dpr = dpr;
    this.insTopDev = insTop;
    this.full = true;
    this.lastTf = '';
    if (this.decoder && this.lastT !== null) this.render(this.lastT);
  }

  /** Brings the lyrics to song time `t` (seconds; call every animation frame). Returns true when pixels were drawn. */
  render(t) {
    const d = this.decoder;
    if (!d || !Number.isFinite(t)) return false;
    t = Math.max(0, t);
    if (this.lastT !== null && t < this.lastT && this.lastT - t < HOLD) t = this.lastT;
    this.lastT = t;
    d.seek(t); // a real seek back replays the song from the start: a few milliseconds
    const drew = d.version !== this.drawnVersion || this.stale || this.full ? this.update() : false;
    let v = d.vOffset;
    if (this.motion === 'smooth' && this.timeline) v += scrollShift(this.timeline, t * 300, d.position);
    // A 12-row memory move lowers v by 12 in the same frame as the redraw; 12·k is whole, so they cancel exactly.
    const k = this.k;
    const tx = -Math.round((VX + d.hOffset) * k);
    const ty = -Math.round((VY + v) * k) - this.insTopDev;
    const tf = `translate(${tx / this.dpr}px, ${ty / this.dpr}px)`;
    if (tf !== this.lastTf) {
      this.canvas.style.transform = tf;
      this.lastTf = tf;
    }
    return drew;
  }

  /** Redraws what changed in the decoder's memory (all of it after a colour or layout change). */
  update() {
    const d = this.decoder;
    const mem = d.pixels;
    const look = this.look;
    let K = 0;
    let main = d.bgColor;
    let roles = null;
    if (look !== 'disc') {
      ({ K, main } = this.keying.key(d, this.hist));
      roles = this.roles || rolesFromHist(this.hist, K);
    }
    const p = this.plate;
    const o = this.outline;
    const key = `${look}|${d.palette.join(',')}|${K}|${main}|${roles ? roles.sig : ''}|${p.rgb}|${p.a}|${o.rgb}|${o.a}|${this.smoothing}`;
    if (key !== this.lutKey) {
      this.lutKey = key;
      this.lut = this.cachedLut(key, () => lyricsLut(look, d.palette, K, main, roles, p, o));
      this.full = true;
    }
    const b = d.borderColor * 3;
    const border = `rgb(${d.palette[b]}, ${d.palette[b + 1]}, ${d.palette[b + 2]})`;
    if (border !== this.border) {
      this.border = border;
      this.lyrics.style.setProperty('--disc-border', border);
    }
    let r = { x0: 0, y0: 0, x1: MW, y1: MH };
    if (!this.full) {
      r = this.changed(mem);
      if (!r) {
        this.drawnVersion = d.version;
        this.stale = false;
        return false;
      }
    }
    // the outline of a pixel depends on its 8 neighbours and Scale2x on its 4: grow by 1, then 1 more
    const ax0 = Math.max(0, r.x0 - 1);
    const ay0 = Math.max(0, r.y0 - 1);
    const ax1 = Math.min(MW, r.x1 + 1);
    const ay1 = Math.min(MH, r.y1 + 1);
    outlineIndices(mem, K, look === 'clear', ax0, ay0, ax1, ay1, this.idx);
    const bx0 = Math.max(0, ax0 - 1);
    const by0 = Math.max(0, ay0 - 1);
    const bx1 = Math.min(MW, ax1 + 1);
    const by1 = Math.min(MH, ay1 + 1);
    const s = this.smoothing ? 2 : 1;
    const src = this.smoothing ? scale2xRect(this.idx, MW, MH, bx0, by0, bx1, by1, this.big) : this.idx;
    const lut = this.lut;
    const u = this.u32;
    const rw = MW * s;
    for (let y = by0 * s; y < by1 * s; y++) {
      for (let i = y * rw + bx0 * s, e = y * rw + bx1 * s; i < e; i++) u[i] = lut[src[i]];
    }
    this.g.putImageData(this.image, 0, 0, bx0 * s, by0 * s, (bx1 - bx0) * s, (by1 - by0) * s);
    this.drawnMem.set(mem);
    this.drawnVersion = d.version;
    this.full = false;
    this.stale = false;
    return true;
  }

  /** The rectangle of memory that differs from what was drawn last ({ x0, y0, x1, y1 }, ends excluded), or null. */
  changed(mem) {
    const old = this.drawnMem;
    let x0 = MW;
    let x1 = -1;
    let y0 = -1;
    let y1 = -1;
    for (let y = 0; y < MH; y++) {
      const row = y * MW;
      let a = 0;
      while (a < MW && mem[row + a] === old[row + a]) a++;
      if (a === MW) continue;
      let z = MW - 1;
      while (mem[row + z] === old[row + z]) z--;
      if (y0 < 0) y0 = y;
      y1 = y;
      if (a < x0) x0 = a;
      if (z > x1) x1 = z;
    }
    return y0 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }

  /** Colour tables by key: the last 64 (a palette or keying change costs nothing the second time). */
  cachedLut(key, build) {
    let lut = this.lutCache.get(key);
    if (lut) this.lutCache.delete(key);
    else lut = build();
    this.lutCache.set(key, lut);
    if (this.lutCache.size > 64) this.lutCache.delete(this.lutCache.keys().next().value);
    return lut;
  }
}
