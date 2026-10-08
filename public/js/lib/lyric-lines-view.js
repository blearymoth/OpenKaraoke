// The TV's other lyric layouts (docs/PLAN.md §9.6): the disc's sung lines (/shared/lyric-lines.js)
// re-arranged inside the lyric box, two at a time or as a scrolling list (/shared/lyric-layout.js
// says when and where). Each line is a small canvas of its own: drawn once, and again only while
// it is being sung (its pixels turn to their sung colour at the disc's own moments). Lines move
// and fade by compositor transforms and opacity in whole device pixels; nothing has a filter, a
// mask or a rounded clip (PLAN §9.5's rule). The colours are the page's (keying, the readable
// palette, the outline of the clear look), from /shared/lyrics.js.
import { scale2x } from '/shared/cdg.js';
import { lyricsLut, rolesFromHist, OUTLINE_INDEX } from '/shared/lyrics.js';
import { twoLinePlan, shown, scrollPlan, focusAt, stopAt, scrollAlpha, countdownAt, lineScale } from '/shared/lyric-layout.js';

const PAD = 2; // CD+G pixels around each line's ink: room for the outline and Scale2x
const SCROLL_ROWS = 4; // lines (and the gaps between them, each a line high) the scrolling list has room for, at least
const FOCUS = 0.4; // where the line in focus sits in the box (from the top)
const PAIR_CENTRE = 0.6; // where the two lines' middle sits in the box

export class LineView {
  /** win: the lyric window (overflow hidden); the view adds its own layer to it. */
  constructor(win) {
    const doc = win.ownerDocument;
    this.layer = doc.createElement('div');
    this.layer.className = 'lyr-lines';
    this.count = doc.createElement('div');
    this.count.className = 'lyr-count';
    this.count.innerHTML = '<i></i><i></i><i></i>';
    this.layer.append(this.count);
    win.append(this.layer);
    this.doc = doc;
    this.song = null;
    this.items = new Map(); // line index → { el, g, image, u32, idx, big, drawn, key, alpha, tf }
    this.style = { look: 'panel', smoothing: true, plate: null, outline: null, roles: null };
    this.mode = 'lines';
    this.geo = null;
  }

  /** The song's lines (an ok analysis) or null. */
  setSong(analysis) {
    for (const it of this.items.values()) it.el.remove();
    this.items.clear();
    this.song = analysis;
    if (!analysis) return;
    const lines = analysis.lines;
    this.plan = twoLinePlan(lines);
    this.splan = scrollPlan(lines);
    this.sorted = lines.map((l) => {
      const at = [];
      for (let i = 0; i < l.at.length; i++) if (l.at[i] > 0) at.push(l.at[i]);
      return Int32Array.from(at).sort();
    });
    this.geo = null;
  }

  /** look, smoothing, plate, outline, roles (the song's colour roles, or null): redraws every line. */
  setStyle(style) {
    const next = { ...this.style, ...style };
    const key = JSON.stringify([next.look, next.smoothing, next.plate, next.outline, next.roles?.sig || '']);
    this.style = next;
    if (key === this.styleKey) return;
    this.styleKey = key;
    if (this.geo) this.measure(this.geo.box);
  }

  /** mode 'lines' | 'scroll'; box: { w, h, dpr } in device pixels (the lyric box). */
  setLayout(mode, box) {
    this.mode = mode;
    this.measure(box);
  }

  /** Scale and the places that don't move: the two places, or the column's lines. */
  measure(box) {
    for (const it of this.items.values()) it.el.remove(); // (made again at the new size)
    this.items.clear();
    this.dotsKey = null;
    const song = this.song;
    this.geo = { box };
    if (!song || !box) return;
    const lines = song.lines;
    const whole = !this.style.smoothing;
    let hMax = 1;
    for (const l of lines) hMax = Math.max(hMax, l.h);
    const gap = hMax; // CD+G pixels between the scrolling list's lines
    const k = lineScale(lines, box.w, box.h, { rows: this.mode === 'scroll' ? SCROLL_ROWS : 2.6, gap: this.mode === 'scroll' ? gap : hMax * 0.7, whole });
    const g = { box, k, hMax, gap, y: [], centre: [] };
    if (this.mode === 'scroll') {
      let y = 0;
      for (const l of lines) {
        g.y.push(Math.round(y));
        g.centre.push(y + (l.h * k) / 2);
        y += (l.h + gap) * k;
      }
    } else {
      const slotH = hMax * k;
      const gap = Math.round(0.7 * slotH);
      const top = Math.round(box.h * PAIR_CENTRE - slotH - gap / 2);
      g.slots = [top, top + Math.round(slotH) + gap];
      g.slotH = slotH;
    }
    this.geo = g;
  }

  /** Where the panel's plate goes in this layout ({ top, height } in device pixels), null: the whole box. */
  plateBand() {
    const g = this.geo;
    if (!g?.slots) return null;
    const pad = Math.round(g.slotH * 0.55);
    return { top: g.slots[0] - pad, height: g.slots[1] + g.slotH - g.slots[0] + 2 * pad };
  }

  /** Draws song time t (s). */
  render(t) {
    const song = this.song;
    const g = this.geo;
    if (!song || !g?.k) return;
    const lines = song.lines;
    const tp = Math.floor(t * 300);
    const want = new Map(); // index → { x, y, alpha }
    let dots = null;
    if (this.mode === 'scroll') {
      const f = focusAt(this.splan, t);
      const s = stopAt(this.splan, t);
      const j0 = Math.floor(f);
      const j1 = Math.min(lines.length - 1, j0 + 1);
      const c = g.centre[j0] + (g.centre[j1] - g.centre[j0]) * (f - j0);
      const off = Math.round(g.box.h * FOCUS - c);
      const pitch = (g.hMax + g.gap) * g.k;
      for (let j = 0; j < lines.length; j++) {
        const y = g.y[j] + off;
        const h = lines[j].h * g.k;
        if (y + h < -pitch || y > g.box.h + pitch) continue;
        const mid = y + h / 2;
        const edge = Math.max(0, Math.min(1, Math.min(mid, g.box.h - mid) / pitch));
        const alpha = scrollAlpha(this.splan.stop[j] - s) * edge; // (lines sung together are in focus together)
        if (alpha <= 0.01) continue;
        want.set(j, { x: Math.round((g.box.w - lines[j].w * g.k) / 2), y, alpha });
        const n = countdownAt(lines, j, t);
        if (n) dots = { n, x: Math.round((g.box.w - lines[j].w * g.k) / 2), y };
      }
    } else {
      for (let j = 0; j < lines.length; j++) {
        const p = this.plan[j];
        if (t < p.in || t >= p.out + 1) continue;
        const alpha = shown(p, t);
        if (alpha <= 0) continue;
        const l = lines[j];
        const y = g.slots[p.slot] + Math.round(((g.hMax - l.h) * g.k) / 2);
        const x = Math.round((g.box.w - l.w * g.k) / 2);
        want.set(j, { x, y, alpha });
        const n = countdownAt(lines, j, t);
        if (n) dots = { n, x, y };
      }
    }
    for (const [j, it] of this.items) {
      if (!want.has(j)) {
        it.el.remove();
        this.items.delete(j);
      }
    }
    for (const [j, w] of want) {
      let it = this.items.get(j);
      if (!it) {
        it = this.make(j);
        this.items.set(j, it);
      }
      const n = upper(this.sorted[j], tp);
      if (n !== it.drawn) this.draw(j, it, tp, n);
      const dpr = g.box.dpr;
      const tf = `translate(${(w.x - PAD * g.k) / dpr}px, ${(w.y - PAD * g.k) / dpr}px)`;
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
    const size = Math.max(4, Math.round(g.hMax * g.k * 0.32));
    const dpr = g.box.dpr;
    el.style.setProperty('--dot', `${size / dpr}px`);
    el.style.transform = `translate(${d.x / dpr}px, ${(d.y - size * 2.2) / dpr}px)`;
    [...el.children].forEach((dot, i) => dot.classList.toggle('lit', i < d.n));
  }

  make(j) {
    const l = this.song.lines[j];
    const el = this.doc.createElement('canvas');
    el.className = 'lyr-line';
    const pw = l.w + 2 * PAD;
    const ph = l.h + 2 * PAD;
    const s = this.style.smoothing ? 2 : 1;
    el.width = pw * s;
    el.height = ph * s;
    const g = this.geo;
    Object.assign(el.style, {
      width: `${(pw * g.k) / g.box.dpr}px`, height: `${(ph * g.k) / g.box.dpr}px`, opacity: '0',
      imageRendering: this.style.smoothing ? 'auto' : 'pixelated',
    });
    this.layer.insertBefore(el, this.count);
    const ctx = el.getContext('2d', { alpha: true });
    const image = ctx.createImageData(el.width, el.height);
    return { el, g: ctx, image, u32: new Uint32Array(image.data.buffer), idx: new Uint8Array(pw * ph), big: s === 2 ? new Uint8Array(pw * ph * 4) : null, drawn: -1, key: '', lut: null, alpha: -1, tf: '' };
  }

  /** Paints line j as it is at packet position tp (`n` of its pixels sung). */
  draw(j, it, tp, n) {
    const l = this.song.lines[j];
    const st = this.style;
    const pw = l.w + 2 * PAD;
    const ph = l.h + 2 * PAD;
    const key = `${st.look}|${st.roles?.sig || ''}|${st.plate?.rgb}|${st.plate?.a}|${st.outline?.rgb}`;
    if (key !== it.key) {
      it.key = key;
      it.lut = lyricsLut(st.look, l.palette, l.K, l.main, st.roles || lineRoles(l), st.plate, st.outline);
    }
    const idx = it.idx;
    idx.fill(l.main);
    for (let y = 0; y < l.h; y++) {
      for (let x = 0; x < l.w; x++) {
        const i = y * l.w + x;
        idx[(y + PAD) * pw + x + PAD] = l.at[i] > 0 && l.at[i] <= tp ? l.sung[i] : l.unsung[i];
      }
    }
    if (st.look === 'clear') outline(idx, pw, ph, l.K);
    const src = it.big ? scale2x(idx, pw, ph, it.big) : idx;
    const lut = it.lut;
    const u = it.u32;
    for (let i = 0; i < src.length; i++) u[i] = lut[src[i]];
    it.g.putImageData(it.image, 0, 0);
    it.drawn = n;
  }

  clear() {
    this.setSong(null);
    this.showDots(null);
  }
}

/** The number of sorted values ≤ v. */
function upper(a, v) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Until the song's colour roles are in: every colour of the line is a fill. */
function lineRoles(l) {
  const hist = new Uint32Array(16);
  for (let i = 0; i < l.ink.length; i++) {
    if (!l.ink[i]) continue;
    hist[l.unsung[i]]++;
    hist[l.sung[i]]++;
  }
  return rolesFromHist(hist, l.K);
}

/** The clear look's 1-pixel dark edge: a background pixel next to a letter becomes OUTLINE_INDEX. */
function outline(idx, w, h, K) {
  const src = idx.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!((K >> src[y * w + x]) & 1)) continue;
      let edge = false;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && !edge; yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          if (!((K >> src[yy * w + xx]) & 1)) {
            edge = true;
            break;
          }
        }
      }
      if (edge) idx[y * w + x] = OUTLINE_INDEX;
    }
  }
}
