// The TV's two-line and scrolling layouts with the song's real words (docs/PLAN.md §9.7): for a
// song autokaraoke made, its timing.json's lines (/shared/lyric-text.js) in the skin's font,
// placed and faded by the same plans as the disc's lines (/shared/lyric-layout.js) — the same
// interface as LineView (./lyric-lines-view.js), so the renderer swaps one for the other. Each
// line is a small canvas: drawn once, and again only while its wipe moves (a whole device pixel at
// a time). Lines move by transforms and fade by opacity; no filter, mask or rounded clip (§9.5).
import { wrapLines, wipeAt, textColours } from '/shared/lyric-text.js';
import { twoLinePlan, shown, scrollPlan, focusAt, stopAt, scrollAlpha, countdownAt } from '/shared/lyric-layout.js';

const FOCUS = 0.4; // where the line in focus sits in the box (from the top), as LineView
const PAIR_CENTRE = 0.6; // where the two lines' middle sits in the box
const SIZE = { lines: 0.125, scroll: 0.095 }; // the font size against the box's height…
const MIN_SIZE = 0.08; // …and the smallest it is shrunk to before long lines are split (lines, scroll × 0.8)
const WIDE = 0.94; // the widest line fills this much of the box at most
const LINE_H = 1.3; // a line's height in font sizes (room for descenders and the outline)
const WEIGHT = 800;

export class TextView {
  /** win: the lyric window (overflow hidden); the view adds its own layer to it. */
  constructor(win) {
    const doc = win.ownerDocument;
    this.layer = doc.createElement('div');
    this.layer.className = 'lyr-lines lyr-text';
    this.count = doc.createElement('div');
    this.count.className = 'lyr-count';
    this.count.innerHTML = '<i></i><i></i><i></i>';
    this.layer.append(this.count);
    win.append(this.layer);
    this.doc = doc;
    this.source = null; // the song's lines (textLines), before splitting
    this.lines = null; // as drawn (long ones split)
    this.disc = null; // the disc's colours (discTextColours), null: autokaraoke's classic theme
    this.items = new Map();
    this.style = { look: 'panel', plate: null, outline: null, font: 'system-ui, sans-serif' };
    this.mode = 'lines';
    this.geo = null;
    this.gen = 0;
  }

  /** lines: textLines() of the song (or null); disc: its colours from the CDG (or null). */
  setSong(lines, disc = null) {
    this.hide();
    this.gen++;
    this.source = lines?.length ? lines : null;
    this.disc = disc;
    this.lines = null;
    this.colours = null;
    if (!this.source) return;
    // The font may still be loading: measured again once it is in (the sizes would be wrong).
    const fonts = this.doc.fonts;
    const gen = this.gen;
    fonts?.load?.(`${WEIGHT} 40px ${this.style.font}`, this.source[0].text).then(() => {
      if (gen === this.gen && this.geo?.box) this.measure(this.geo.box);
    }, () => {});
    if (this.geo?.box) this.measure(this.geo.box);
  }

  /** The disc's colours came in later (a disc's own words: from its sung lines): redraws every line. */
  setDisc(disc) {
    this.disc = disc;
    if (!this.lines) return;
    this.colours = textColours(this.style.look, this.disc, this.style.plate);
    for (const it of this.items.values()) it.drawn = -1;
  }

  /** look, plate, outline, font (a CSS font family): redraws every line. */
  setStyle(style) {
    const next = { ...this.style, ...style };
    const key = JSON.stringify([next.look, next.plate, next.outline, next.font]);
    this.style = next;
    if (key === this.styleKey) return;
    this.styleKey = key;
    this.colours = null;
    if (this.geo?.box) this.measure(this.geo.box);
  }

  /** mode 'lines' | 'scroll'; box: { w, h, dpr } in device pixels (the lyric box). */
  setLayout(mode, box) {
    this.mode = mode;
    this.measure(box);
  }

  /** The disc's background colour (the disc look puts it in the window). */
  get background() {
    const c = this.colours || textColours(this.style.look, this.disc, this.style.plate);
    return `rgb(${c.bg.join(', ')})`;
  }

  fontAt(px) {
    return `${WEIGHT} ${px}px ${this.style.font}`;
  }

  /** The font size, the lines as drawn (split where too wide), each word's place, the plans. */
  measure(box) {
    this.hide();
    this.geo = { box };
    if (!this.source || !box) return;
    const g = this.ctx || (this.ctx = this.doc.createElement('canvas').getContext('2d'));
    const widthAt = (px) => {
      g.font = this.fontAt(px);
      return (text) => g.measureText(text).width;
    };
    const maxW = box.w * WIDE;
    let size = Math.round(box.h * SIZE[this.mode === 'scroll' ? 'scroll' : 'lines']);
    let widest = 1;
    const at = widthAt(size);
    for (const l of this.source) widest = Math.max(widest, at(l.text));
    if (widest > maxW) size = Math.max(Math.round(box.h * MIN_SIZE * (this.mode === 'scroll' ? 0.8 : 1)), Math.floor((size * maxW) / widest));
    const width = widthAt(size);
    const lines = wrapLines(this.source, width, maxW);
    const space = width(' ');
    this.metrics = lines.map((l) => {
      const xs = [];
      const ws = [];
      let x = 0;
      for (const w of l.words) {
        xs.push(x);
        const ww = width(w.text);
        ws.push(ww);
        x += ww + space;
      }
      return { xs, ws, w: Math.ceil(x - space) };
    });
    this.lines = lines;
    this.plan = twoLinePlan(lines);
    this.splan = scrollPlan(lines);
    const lineH = Math.round(size * LINE_H);
    const pad = Math.ceil(size * 0.12); // room for the clear look's outline
    const geo = { box, size, lineH, pad, y: [], centre: [] };
    if (this.mode === 'scroll') {
      const pitch = Math.round(lineH * 1.7);
      lines.forEach((l, j) => {
        geo.y.push(j * pitch);
        geo.centre.push(j * pitch + lineH / 2);
      });
      geo.pitch = pitch;
    } else {
      const gap = Math.round(0.45 * lineH);
      const top = Math.round(box.h * PAIR_CENTRE - lineH - gap / 2);
      geo.slots = [top, top + lineH + gap];
    }
    this.geo = geo;
    this.colours = textColours(this.style.look, this.disc, this.style.plate);
  }

  /** Where the panel's plate goes in this layout ({ top, height } in device pixels), null: the whole box. */
  plateBand() {
    const g = this.geo;
    if (!g?.slots) return null;
    const pad = Math.round(g.lineH * 0.45);
    return { top: g.slots[0] - pad, height: g.slots[1] + g.lineH - g.slots[0] + 2 * pad };
  }

  /** Draws song time t (s). */
  render(t) {
    const lines = this.lines;
    const g = this.geo;
    if (!lines || !g?.size) return;
    const want = new Map(); // index → { x, y, alpha }
    let dots = null;
    const left = (j) => Math.round((g.box.w - this.metrics[j].w) / 2);
    if (this.mode === 'scroll') {
      const f = focusAt(this.splan, t);
      const s = stopAt(this.splan, t);
      const j0 = Math.floor(f);
      const j1 = Math.min(lines.length - 1, j0 + 1);
      const c = g.centre[j0] + (g.centre[j1] - g.centre[j0]) * (f - j0);
      const off = Math.round(g.box.h * FOCUS - c);
      for (let j = 0; j < lines.length; j++) {
        const y = g.y[j] + off;
        if (y + g.lineH < -g.pitch || y > g.box.h + g.pitch) continue;
        const mid = y + g.lineH / 2;
        const edge = Math.max(0, Math.min(1, Math.min(mid, g.box.h - mid) / g.pitch));
        const alpha = scrollAlpha(this.splan.stop[j] - s) * edge;
        if (alpha <= 0.01) continue;
        want.set(j, { x: left(j), y, alpha });
        const n = countdownAt(lines, j, t);
        if (n) dots = { n, x: left(j), y };
      }
    } else {
      for (let j = 0; j < lines.length; j++) {
        const p = this.plan[j];
        if (t < p.in || t >= p.out + 1) continue;
        const alpha = shown(p, t);
        if (alpha <= 0) continue;
        want.set(j, { x: left(j), y: g.slots[p.slot], alpha });
        const n = countdownAt(lines, j, t);
        if (n) dots = { n, x: left(j), y: g.slots[p.slot] };
      }
    }
    for (const [j, it] of this.items) {
      if (!want.has(j)) {
        it.el.remove();
        this.items.delete(j);
      }
    }
    const dpr = g.box.dpr;
    for (const [j, w] of want) {
      let it = this.items.get(j);
      if (!it) {
        it = this.make(j);
        this.items.set(j, it);
      }
      const m = this.metrics[j];
      const x = Math.round(wipeAt(lines[j].words, m.xs, m.ws, t));
      if (x !== it.drawn) this.draw(j, it, x);
      const tf = `translate(${(w.x - g.pad) / dpr}px, ${w.y / dpr}px)`;
      if (tf !== it.tf) {
        it.el.style.transform = tf;
        it.tf = tf;
      }
      const a = Math.round(w.alpha * 100) / 100;
      if (a !== it.alpha) {
        it.el.style.opacity = String(a);
        it.alpha = a;
      }
    }
    this.showDots(dots);
  }

  showDots(d) {
    const key = d ? `${d.n}|${d.x}|${d.y}` : '';
    if (key === this.dotsKey) return;
    this.dotsKey = key;
    const el = this.count;
    el.classList.toggle('on', !!d);
    if (!d) return;
    const g = this.geo;
    const size = Math.max(4, Math.round(g.size * 0.3));
    const dpr = g.box.dpr;
    el.style.setProperty('--dot', `${size / dpr}px`);
    el.style.transform = `translate(${d.x / dpr}px, ${(d.y - size * 1.4) / dpr}px)`;
    [...el.children].forEach((dot, i) => dot.classList.toggle('lit', i < d.n));
  }

  make(j) {
    const g = this.geo;
    const el = this.doc.createElement('canvas');
    el.className = 'lyr-line lyr-text-line';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', this.lines[j].text);
    el.width = this.metrics[j].w + 2 * g.pad;
    el.height = g.lineH;
    Object.assign(el.style, { width: `${el.width / g.box.dpr}px`, height: `${el.height / g.box.dpr}px`, opacity: '0' });
    this.layer.insertBefore(el, this.count);
    return { el, g: el.getContext('2d', { alpha: true }), drawn: -1, alpha: -1, tf: '' };
  }

  /** Paints line j with its first x device pixels (from the text's left edge) sung. */
  draw(j, it, x) {
    const geo = this.geo;
    const { g, el } = it;
    const words = this.lines[j].words;
    const { xs } = this.metrics[j];
    const c = this.colours;
    const base = Math.round(geo.lineH * 0.74); // the baseline: descenders fit below it
    g.clearRect(0, 0, el.width, el.height);
    g.font = this.fontAt(geo.size);
    g.textBaseline = 'alphabetic';
    const paint = (fill) => {
      g.fillStyle = fill;
      for (let i = 0; i < words.length; i++) g.fillText(words[i].text, geo.pad + xs[i], base);
    };
    if (this.style.look === 'clear') {
      const o = this.style.outline || { rgb: [0, 0, 0], a: 0.9 };
      g.lineJoin = 'round';
      g.lineWidth = Math.max(2, geo.size * 0.14);
      g.strokeStyle = `rgba(${o.rgb.join(', ')}, ${o.a})`;
      for (let i = 0; i < words.length; i++) g.strokeText(words[i].text, geo.pad + xs[i], base);
    }
    paint(`rgb(${c.unsung.join(', ')})`);
    if (x > 0) {
      g.save();
      g.beginPath();
      g.rect(0, 0, geo.pad + x, el.height);
      g.clip();
      g.clearRect(0, 0, geo.pad + x, el.height); // (the unsung letters' edges don't show round the sung ones)
      if (this.style.look === 'clear') for (let i = 0; i < words.length; i++) g.strokeText(words[i].text, geo.pad + xs[i], base);
      paint(`rgb(${c.sung.join(', ')})`);
      g.restore();
    }
    it.drawn = x;
    el.dataset.sung = String(x);
  }

  /** Takes every line off the screen (the other view is drawing). */
  hide() {
    for (const it of this.items.values()) it.el.remove();
    this.items.clear();
    this.showDots(null);
  }

  clear() {
    this.setSong(null);
  }
}
