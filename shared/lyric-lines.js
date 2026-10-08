// The sung lines of a CD+G disc (docs/PLAN.md §9.6), found once when a song loads, so the TV can
// show them in other layouts than the disc's own pages: two lines at a time, or a scrolling list.
// Isomorphic (no DOM or Node APIs): the TV renderer, tests and scripts/lyrics-check.js use it.
//
// A disc draws its words in an "unsung" colour and sings them by re-colouring them (the wipe):
// the same letters, another colour. One pass over the packets watches every tile write: letters
// that change colour without changing shape are being sung. Where that starts, a line is born:
// the band of rows with ink around it (a gap of more than GAP empty rows ends it). From then on
// the line keeps its own copy of its pixels: each one's unsung colour, its sung colour and the
// moment it changed (packet resolution), so it can be drawn at any time, anywhere, before it is on
// the disc's screen and after the disc has erased it. A line ends when the screen is cleared, when
// most of it is erased or written over by other letters, or when it scrolls out of sight.
//
// Words that are never sung (title cards, "KEY OF Bm", credits) never become lines; a screen
// without a background colour (a picture) is skipped. A disc whose wipes can't be followed (too
// few lines, or most of its re-colouring outside them) is not `ok`: the TV keeps the disc's pages.
import {
  CdgDecoder, CDG_INSTR, CDG_PACKET_SIZE, CDG_PACKETS_PER_SECOND, CDG_WIDTH, CDG_HEIGHT,
  CDG_VISIBLE_X, CDG_VISIBLE_Y, CDG_VISIBLE_WIDTH, CDG_VISIBLE_HEIGHT,
} from './cdg.js';

const W = CDG_WIDTH;
const H = CDG_HEIGHT;
const VX0 = CDG_VISIBLE_X;
const VX1 = CDG_VISIBLE_X + CDG_VISIBLE_WIDTH;
const VY0 = CDG_VISIBLE_Y;
const VY1 = CDG_VISIBLE_Y + CDG_VISIBLE_HEIGHT;
const WINDOW = CDG_VISIBLE_WIDTH * CDG_VISIBLE_HEIGHT;

const SETTLE = 4; // packets: a tile written by several packets in a row (NORMAL + XOR) is judged once they stop
export const GAP = 3; // empty rows a line's band may cross (accents, descenders)
export const MAX_LINE_ROWS = 64; // a taller band of ink is not a line of words (a picture, a box)
const MIN_SUNG = 24; // pixels re-coloured, at least, for a line…
const MIN_SUNG_SHARE = 0.05; // …and this share of its ink
const KILL_ERASED = 0.3; // a line with this share of its ink erased is gone
const REPLACE_PX = 6; // a tile that erases and draws this many of a line's pixels writes other letters over it
const NEAR = 3; // pixels: ink this close to a sung pixel is part of the line
const STRAY = 1.5 * CDG_PACKETS_PER_SECOND; // a pause this long in a line's re-colouring: what comes before or after is not its wipe
const REVERSE_MIN = 200; // re-colourings seen one way before the other way counts as a redraw
const KEY_SHARE = 0.35; // background colours: as shared/lyrics.js keyColours (without the look-alikes and holds)
const KEEP_SHARE = 0.2;
const PRESET_SHARE = 0.1;
export const MIN_LINES = 4; // fewer sung lines found: the disc keeps its pages
export const MIN_COVERAGE = 0.6; // share of all the re-colouring that must happen inside the lines found

/** Packets of song time t (s): a pixel sung at packet p shows from t ≥ (p + 1) / 300 (the decoder's position). */
export const packetsAt = (t) => Math.floor(t * CDG_PACKETS_PER_SECOND);

/**
 * The sung lines of `bytes` (a .cdg), synchronously (tests, scripts). → analysis (see linesAsync).
 */
export function analyzeLines(bytes) {
  const it = lineSteps(bytes);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * The same in slices of about `sliceMs`, so the TV keeps drawing while a song loads. Resolves to
 * null when `cancelled()` turns true (another song loaded).
 * → { ok, lines: [{ start, end, death, appear (s), x, y (visible CD+G px of its top-left at its
 *   start), w, h, unsung, sung (w×h colour indices), at (Int32Array w×h: the packet position from
 *   which the pixel is sung, 0 = never), ink (Uint8Array w×h), palette (48 bytes at its start),
 *   K (background colours at its start), main (the one covering most), sungPx, inkPx }], coverage,
 *   duration, reason }
 */
export async function linesAsync(bytes, { sliceMs = 8, cancelled = () => false } = {}) {
  const it = lineSteps(bytes);
  for (;;) {
    const t0 = now();
    let r;
    do {
      r = it.next();
    } while (!r.done && now() - t0 < sliceMs);
    if (r.done) return r.value;
    await breathe();
    if (cancelled()) return null;
  }
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function breathe() {
  if (typeof MessageChannel !== 'function') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      r();
    };
    ch.port2.postMessage(0);
  });
}

/** Background colours from the window's histogram (`hist`, at offsets 0): big areas and the preset colour. */
function backgroundOf(hist, prev, dec) {
  let K = 0;
  for (let c = 0; c < 16; c++) {
    const share = hist[c] / WINDOW;
    if (share >= KEY_SHARE || ((prev >> c) & 1 && share >= KEEP_SHARE)) K |= 1 << c;
  }
  if (hist[dec.bgColor] / WINDOW >= PRESET_SHARE) K |= 1 << dec.bgColor;
  if (dec.scrollFill >= 0 && hist[dec.scrollFill] > 0) K |= 1 << dec.scrollFill;
  return K;
}

function windowHist(px, hist) {
  hist.fill(0);
  for (let y = VY0; y < VY1; y++) for (let i = y * W + VX0, e = y * W + VX1; i < e; i++) hist[px[i]]++;
}

/** Moves a per-pixel plane the way the decoder's scroll moves its memory (copy wraps round, preset fills). */
function shiftPlane(plane, scratch, dx, dy, copy, fill) {
  for (let y = 0; y < H; y++) {
    let sy = y - dy;
    if (copy) sy = (sy + H) % H;
    const d = y * W;
    if (sy < 0 || sy >= H) {
      scratch.fill(fill, d, d + W);
      continue;
    }
    for (let x = 0; x < W; x++) {
      let sx = x - dx;
      if (copy) sx = (sx + W) % W;
      scratch[d + x] = sx < 0 || sx >= W ? fill : plane[sy * W + sx];
    }
  }
  plane.set(scratch);
}

class Line {
  constructor(y0, y1, start) {
    this.y0 = y0; // memory rows [y0, y1)
    this.y1 = y1;
    const n = W * (y1 - y0);
    this.unsung = new Uint8Array(n);
    this.sung = new Uint8Array(n);
    this.at = new Int32Array(n); // packet position of its latest change (0: never)
    this.at1 = new Int32Array(n); // …and of its first one, with the colour it got then
    this.sung1 = new Uint8Array(n);
    this.ink = new Uint8Array(n);
    this.start = start;
    this.end = start;
    this.death = -1;
    this.appear = start;
    this.inkPx = 0;
    this.sungPx = 0;
    this.erased = 0;
    this.events = 0; // re-colourings inside it
    this.top = y0; // memory row of its top at its start (for its place on the disc)
  }

  /** Pixel `li` turns colour `c` at packet position `at`. */
  sing(li, c, at) {
    if (!this.at1[li]) {
      this.at1[li] = at;
      this.sung1[li] = c;
      this.sungPx++;
    }
    this.sung[li] = c;
    this.at[li] = at;
    this.end = at - 1;
    this.events++;
  }
}

function* lineSteps(bytes) {
  const dec = new CdgDecoder(bytes);
  const b = dec.bytes;
  const count = dec.packetCount;
  const inkAt = new Int32Array(W * H).fill(-1); // packet a pixel became ink (-1: background)
  const scratch = new Int32Array(W * H);
  const hist = new Uint32Array(16);
  windowHist(dec.pixels, hist);
  let K = backgroundOf(hist, 0, dec);
  const pending = new Map(); // tile → { before (72 indices), last (packet of its latest write) }
  const alive = [];
  const done = [];
  const owner = new Int16Array(H).fill(-1); // memory row → index in `alive`
  let blob = null; // [y0, y1): rows of this screen too tall for a line (no new line there until the screen changes)
  let allSung = 0; // visible pixels re-coloured anywhere (on screens with a background)
  let linesSung = 0; // …inside a line
  const changes = new Int32Array(72 * 4); // per tile: i, before, after, kind
  const pairs = new Uint32Array(256); // re-colourings sung so far, by (from, to)

  const own = () => {
    owner.fill(-1);
    alive.forEach((l, k) => owner.fill(k, Math.max(0, l.y0), Math.min(H, l.y1)));
  };
  const kill = (line, p) => {
    line.death = p;
    done.push(line);
  };
  const killAll = (p) => {
    for (const l of alive) kill(l, p);
    alive.length = 0;
    owner.fill(-1);
  };
  const rowHasInk = (y) => {
    const px = dec.pixels;
    for (let i = y * W + VX0, e = y * W + VX1; i < e; i++) if (!((K >> px[i]) & 1)) return true;
    return false;
  };

  /** A new line around the re-coloured rows [r0, r1] (null: not a line). */
  const birth = (r0, r1, p, current) => {
    if (!K) return null; // a picture: no background to tell words from
    if (blob && r0 < blob[1] && r1 >= blob[0]) return null;
    let y0 = r0;
    let y1 = r1;
    for (let y = r0 - 1, gap = 0; y >= VY0 && owner[y] < 0; y--) {
      if (rowHasInk(y)) {
        y0 = y;
        gap = 0;
      } else if (++gap > GAP) break;
      if (r1 - y > MAX_LINE_ROWS) break;
    }
    for (let y = r1 + 1, gap = 0; y < VY1 && owner[y] < 0; y++) {
      if (rowHasInk(y)) {
        y1 = y;
        gap = 0;
      } else if (++gap > GAP) break;
      if (y - y0 > MAX_LINE_ROWS) break;
    }
    if (y1 - y0 + 1 > MAX_LINE_ROWS) {
      blob = [y0, y1 + 1];
      return null;
    }
    const line = new Line(y0, y1 + 1, p);
    const px = dec.pixels;
    line.unsung.set(px.subarray(y0 * W, (y1 + 1) * W));
    // this tile and those still being written: their pixels as they were before
    for (const [tile, e] of [...pending, current]) {
      const ty = Math.floor(tile / 50) * 12;
      const tx = (tile % 50) * 6;
      for (let y = 0; y < 12; y++) {
        const my = ty + y;
        if (my < y0 || my > y1) continue;
        for (let x = 0; x < 6; x++) line.unsung[(my - y0) * W + tx + x] = e.before[y * 6 + x];
      }
    }
    let first = p;
    for (let i = 0; i < line.unsung.length; i++) {
      const x = i % W;
      if (x < VX0 || x >= VX1 || (K >> line.unsung[i]) & 1) continue;
      line.ink[i] = 1;
      line.inkPx++;
      const a = inkAt[y0 * W + i];
      if (a >= 0 && a < first) first = a;
    }
    line.sung.set(line.unsung);
    line.appear = first;
    line.palette = Uint8Array.from(dec.palette);
    line.K = K;
    line.main = dec.bgColor;
    for (let c = 0; c < 16; c++) if ((K >> c) & 1 && (!((K >> line.main) & 1) || hist[c] > hist[line.main])) line.main = c;
    alive.push(line);
    owner.fill(alive.length - 1, y0, y1 + 1);
    return line;
  };

  /** Judges one tile now that its packets have stopped: re-coloured letters sing a line, the rest draws or erases. */
  const settle = (tile, e) => {
    const px = dec.pixels;
    const ty = Math.floor(tile / 50) * 12;
    const tx = (tile % 50) * 6;
    const before = e.before;
    const at = e.last + 1;
    let n = 0;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 6; x++) {
        const i = (ty + y) * W + tx + x;
        const a = before[y * 6 + x];
        const c = px[i];
        if (a === c) continue;
        const visible = ty + y >= VY0 && ty + y < VY1 && tx + x >= VX0 && tx + x < VX1;
        if (visible) {
          hist[a]--;
          hist[c]++;
        }
        const ia = !((K >> a) & 1);
        const ib = !((K >> c) & 1);
        const kind = ia && ib ? 1 : ib ? 2 : ia ? 3 : 0; // 1 re-colour, 2 draw, 3 erase
        if (kind === 2) inkAt[i] = e.last;
        else if (kind === 3) inkAt[i] = -1;
        if (!kind || !visible) continue;
        changes[n++] = i;
        changes[n++] = a;
        changes[n++] = c;
        changes[n++] = kind;
      }
    }
    if (n) {
      // A wipe turns unsung colours into sung ones; the reverse (sung letters back to the unsung
      // colour) is a new page written over a sung one: learnt from the wipes so far.
      for (let k = 0; k < n; k += 4) {
        if (changes[k + 3] !== 1) continue;
        const fwd = pairs[changes[k + 1] * 16 + changes[k + 2]];
        const back = pairs[changes[k + 2] * 16 + changes[k + 1]];
        if (back >= REVERSE_MIN && back > 4 * fwd) changes[k + 3] = 4;
      }
      // Singing re-colours letters (and may paint a highlight bar behind them), but never erases:
      // a tile that also erases letters is a redraw (a new page written over the old one, a
      // picture), and its re-colouring is not a wipe.
      let rec = 0;
      let drawn = 0;
      let erased = 0;
      for (let k = 3; k < n; k += 4) if (changes[k] === 1) rec++; else if (changes[k] === 2) drawn++; else if (changes[k] === 3) erased++;
      const singing = rec > 0 && erased <= Math.max(2, rec >> 2);
      if (singing && K) allSung += rec + drawn;
      if (singing) for (let k = 0; k < n; k += 4) if (changes[k + 3] === 1) pairs[changes[k + 1] * 16 + changes[k + 2]]++;
      if (!singing) for (let k = 3; k < n; k += 4) if (changes[k] === 1) changes[k] = 4; // 4: written over
      // per line touched: is it being erased, or written over with other letters?
      const hurt = new Map();
      for (let k = 0; k < n; k += 4) {
        const i = changes[k];
        const o = owner[(i / W) | 0];
        if (o < 0) continue;
        const kind = changes[k + 3];
        if ((kind === 3 || kind === 4) && alive[o].ink[i - alive[o].y0 * W]) hurt.set(o, (hurt.get(o) || 0) + 1);
      }
      const gone = new Set();
      for (const [o, px] of hurt) {
        const line = alive[o];
        line.erased += px;
        if ((!singing && px >= 2 * REPLACE_PX) || line.erased > KILL_ERASED * line.inkPx) gone.add(o);
      }
      if (gone.size) {
        for (const o of [...gone].sort((x, y) => y - x)) {
          kill(alive[o], e.last);
          alive.splice(o, 1);
        }
        own();
      }
      let r0 = H;
      let r1 = -1;
      for (let k = 0; k < n; k += 4) {
        const i = changes[k];
        const y = (i / W) | 0;
        const o = owner[y];
        const kind = changes[k + 3];
        if (o < 0) {
          if (kind === 1) {
            r0 = Math.min(r0, y);
            r1 = Math.max(r1, y);
          }
          continue;
        }
        const line = alive[o];
        const li = i - line.y0 * W;
        const c = changes[k + 2];
        if (kind === 4) continue; // (a few pixels of a line written over: it keeps its own copy)
        if (kind === 1 || (kind === 2 && line.ink[li])) {
          if (!line.ink[li]) { // drawn after the line began, then sung
            line.ink[li] = 1;
            line.inkPx++;
            line.unsung[li] = changes[k + 1];
          }
          if (c !== line.sung[li]) {
            line.sing(li, c, at);
            linesSung++;
          }
        } else if (kind === 2 && singing) { // a highlight bar painted behind the letters as they are sung
          line.ink[li] = 1;
          line.inkPx++;
          line.sing(li, c, at);
          linesSung++;
        } else if (kind === 2) { // more of the line drawn (words that appear just before they are sung)
          line.ink[li] = 1;
          line.inkPx++;
          line.unsung[li] = c;
          line.sung[li] = c;
        }
      }
      if (r1 >= 0) {
        const line = birth(r0, r1, e.last, [tile, e]);
        if (line) {
          for (let k = 0; k < n; k += 4) {
            const i = changes[k];
            if ((changes[k + 3] !== 1 && changes[k + 3] !== 2) || owner[(i / W) | 0] !== alive.length - 1) continue;
            const li = i - line.y0 * W;
            if (!line.ink[li]) {
              line.ink[li] = 1;
              line.inkPx++;
              line.unsung[li] = changes[k + 1];
            }
            line.sing(li, changes[k + 2], at);
            linesSung++;
          }
        }
      }
    }
    K = backgroundOf(hist, K, dec);
  };

  const settleAll = (upTo) => {
    for (const [tile, e] of pending) {
      if (e.last > upTo) continue;
      pending.delete(tile);
      settle(tile, e);
    }
  };

  for (let p = 0; p < count; p++) {
    const o = p * CDG_PACKET_SIZE;
    if ((b[o] & 0x3f) === 9) {
      const instr = b[o + 1] & 0x3f;
      const d = o + 4;
      if (instr === CDG_INSTR.TILE_NORMAL || instr === CDG_INSTR.TILE_XOR) {
        const row = b[d + 2] & 0x1f;
        const col = b[d + 3] & 0x3f;
        if (row < 18 && col < 50) {
          const tile = row * 50 + col;
          const e = pending.get(tile);
          if (e) e.last = p;
          else {
            const before = new Uint8Array(72);
            for (let y = 0; y < 12; y++) before.set(dec.pixels.subarray((row * 12 + y) * W + col * 6, (row * 12 + y) * W + col * 6 + 6), y * 6);
            pending.set(tile, { before, last: p });
          }
        }
        dec.execute(instr, d);
      } else if (instr === CDG_INSTR.MEMORY_PRESET) {
        settleAll(Infinity);
        dec.execute(instr, d);
        killAll(p);
        inkAt.fill(-1);
        windowHist(dec.pixels, hist);
        K = backgroundOf(hist, 0, dec);
        blob = null;
      } else if (instr === CDG_INSTR.SCROLL_PRESET || instr === CDG_INSTR.SCROLL_COPY) {
        const h = b[d + 1] & 0x3f;
        const v = b[d + 2] & 0x3f;
        const dx = ((h & 0x30) >> 4) === 1 ? 6 : ((h & 0x30) >> 4) === 2 ? -6 : 0;
        const dy = ((v & 0x30) >> 4) === 1 ? 12 : ((v & 0x30) >> 4) === 2 ? -12 : 0;
        if (dx || dy) settleAll(Infinity);
        dec.execute(instr, d);
        if (dx || dy) {
          shiftPlane(inkAt, scratch, dx, dy, instr === CDG_INSTR.SCROLL_COPY, -1);
          for (let k = alive.length - 1; k >= 0; k--) {
            const l = alive[k];
            l.y0 += dy;
            l.y1 += dy;
            if (dx || l.y0 < 0 || l.y1 > H || l.y1 <= VY0 || l.y0 >= VY1) {
              kill(l, p);
              alive.splice(k, 1);
            }
          }
          own();
          windowHist(dec.pixels, hist);
          K = backgroundOf(hist, K, dec);
          blob = null;
        }
      } else {
        dec.execute(instr, d);
      }
    }
    if (pending.size) settleAll(p - SETTLE);
    if ((p & 2047) === 2047) yield p;
  }
  settleAll(Infinity);
  killAll(count);
  return finish(done, { allSung, linesSung, duration: count / CDG_PACKETS_PER_SECOND });
}

/** Crops each line to its ink, drops the ones barely sung, sorts by when their singing starts. */
function finish(found, { allSung, linesSung, duration }) {
  const lines = [];
  let kept = 0;
  for (const l of found) {
    if (l.sungPx < MIN_SUNG || l.sungPx < MIN_SUNG_SHARE * l.inkPx) continue;
    const rows = l.y1 - l.y0;
    let x0 = W;
    let x1 = -1;
    let y0 = rows;
    let y1 = -1;
    for (let y = 0; y < rows; y++) {
      for (let x = VX0; x < VX1; x++) {
        if (!l.ink[y * W + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) continue;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const crop = (src, Type) => {
      const out = new Type(w * h);
      for (let y = 0; y < h; y++) out.set(src.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
      return out;
    };
    const last = crop(l.at, Int32Array);
    const lastColour = crop(l.sung, Uint8Array);
    const at = crop(l.at1, Int32Array);
    const sung = crop(l.sung1, Uint8Array);
    const unsung = crop(l.unsung, Uint8Array);
    // When its singing really starts and ends: the biggest burst of first changes (no gap of more
    // than STRAY inside). Pixels changed long before it (a page being drawn) take their latest
    // change if that is in the burst, else just keep their last colour; changes after it (the next
    // page drawn over) are left out.
    const times = at.filter((v) => v > 0).sort();
    let best = [0, 0];
    for (let i = 0, from = 0; i <= times.length; i++) {
      if (i < times.length && (i === from || times[i] - times[i - 1] <= STRAY)) continue;
      if (i - from > best[1] - best[0]) best = [from, i];
      from = i;
    }
    const first = times[best[0]] ?? l.start + 1;
    const lastOk = times[best[1] - 1] ?? first;
    let start = Infinity;
    let end = 0;
    for (let i = 0; i < at.length; i++) {
      if (!at[i]) continue;
      if (at[i] < first) {
        if (last[i] >= first && last[i] <= lastOk) {
          at[i] = last[i];
          sung[i] = lastColour[i];
        } else {
          unsung[i] = last[i] < first ? lastColour[i] : unsung[i];
          at[i] = 0;
          continue;
        }
      } else if (at[i] > lastOk) {
        at[i] = 0;
        continue;
      }
      if (at[i] < start) start = at[i];
      if (at[i] > end) end = at[i];
    }
    if (!Number.isFinite(start)) continue;
    // What belongs to the words: ink within NEAR pixels of a pixel that is sung (the letters, their
    // outline or shadow, a highlight bar). Leftovers that are never sung (a strip of an old bar, a
    // neighbour's descender) become background.
    const ink = crop(l.ink, Uint8Array);
    const across = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (at[y * w + x] <= 0) continue;
        across.fill(1, y * w + Math.max(0, x - NEAR), y * w + Math.min(w, x + NEAR + 1));
      }
    }
    let bx0 = w;
    let bx1 = -1;
    let by0 = h;
    let by1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!ink[i]) continue;
        let near = false;
        for (let yy = Math.max(0, y - NEAR); yy <= Math.min(h - 1, y + NEAR) && !near; yy++) near = !!across[yy * w + x];
        if (!near) {
          ink[i] = 0;
          unsung[i] = sung[i] = l.main;
          at[i] = 0;
          continue;
        }
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
    const fw = bx1 - bx0 + 1;
    const fh = by1 - by0 + 1;
    const tight = (src) => {
      const o = new src.constructor(fw * fh);
      for (let y = 0; y < fh; y++) o.set(src.subarray((by0 + y) * w + bx0, (by0 + y) * w + bx0 + fw), y * fw);
      return o;
    };
    kept += l.events;
    let inkPx = 0;
    for (const v of ink) inkPx += v;
    lines.push({
      start: start / CDG_PACKETS_PER_SECOND,
      end: end / CDG_PACKETS_PER_SECOND,
      death: l.death / CDG_PACKETS_PER_SECOND,
      appear: (l.appear + 1) / CDG_PACKETS_PER_SECOND,
      x: x0 + bx0 - VX0,
      y: l.top + y0 + by0 - VY0,
      w: fw,
      h: fh,
      unsung: tight(unsung),
      sung: tight(sung),
      at: tight(at),
      ink: tight(ink),
      palette: l.palette,
      K: l.K,
      main: l.main,
      sungPx: l.sungPx,
      inkPx,
    });
  }
  lines.sort((a, b) => a.start - b.start || a.y - b.y);
  const coverage = allSung ? kept / allSung : 0;
  let reason = '';
  if (lines.length < MIN_LINES) reason = `${lines.length} sung line(s) found`;
  else if (coverage < MIN_COVERAGE) reason = `only ${Math.round(coverage * 100)} % of the singing is in lines`;
  return { ok: !reason, reason, lines, coverage, duration, linesSung };
}
