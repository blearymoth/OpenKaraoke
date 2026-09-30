// CD+G (karaoke graphics) decoder. Isomorphic: used by the TV renderer in the
// browser and by the server (e.g. to pick a "lyrics frame" for quiz rounds).
//
// A CDG stream is 300 packets/s of 24 bytes. The screen is a 300×216 buffer of
// 4-bit colour indices; the visible area is the inner 288×192 (x 6..293, y 12..203)
// shifted by the smooth-scroll offsets.

export const CDG_WIDTH = 300;
export const CDG_HEIGHT = 216;
export const CDG_PACKET = 24;
export const CDG_PACKETS_PER_SECOND = 300;
export const BORDER_X = 6;
export const BORDER_Y = 12;
export const VISIBLE_WIDTH = 288;
export const VISIBLE_HEIGHT = 192;

const CMD_CDG = 0x09;
const MEMORY_PRESET = 1;
const BORDER_PRESET = 2;
const TILE_NORMAL = 6;
const SCROLL_PRESET = 20;
const SCROLL_COPY = 24;
const DEFINE_TRANSPARENT = 28;
const LOAD_COLORS_LOW = 30;
const LOAD_COLORS_HIGH = 31;
const TILE_XOR = 38;

export class CdgDecoder {
  constructor(data = null) {
    this.pixels = new Uint8Array(CDG_WIDTH * CDG_HEIGHT);
    this.scratch = new Uint8Array(CDG_WIDTH * CDG_HEIGHT);
    this.palette = new Uint8Array(16 * 3); // r,g,b 0..255
    this.data = null;
    this.setData(data);
  }

  setData(data) {
    this.data = data ? (data instanceof Uint8Array ? data : new Uint8Array(data)) : null;
    this.packetCount = this.data ? Math.floor(this.data.length / CDG_PACKET) : 0;
    this.reset();
  }

  get duration() { return this.packetCount / CDG_PACKETS_PER_SECOND; }

  reset() {
    this.pixels.fill(0);
    this.palette.fill(0);
    this.position = 0; // next packet to process
    this.hOffset = 0;
    this.vOffset = 0;
    this.borderColor = 0;
    this.bgColor = 0; // colour of the last memory preset (the "paper")
    this.transparent = -1; // colour defined with "define transparent"
    this.dirty = true;
    this.paletteVersion = 0;
    this.version = 0; // bumps whenever the picture changes
  }

  /** Decodes up to (not including) packet `target`; seeks backwards by replaying from 0. */
  seekPacket(target) {
    if (!this.data) return false;
    target = Math.max(0, Math.min(this.packetCount, Math.floor(target)));
    if (target < this.position) this.reset();
    const before = this.version;
    const d = this.data;
    for (let p = this.position; p < target; p++) {
      const o = p * CDG_PACKET;
      if ((d[o] & 0x3f) === CMD_CDG) this.instruction(d[o + 1] & 0x3f, d, o + 4);
    }
    this.position = target;
    return this.version !== before;
  }

  /** Decodes up to the given time in seconds. Returns true if the picture changed. */
  seekTime(sec) {
    return this.seekPacket(Math.floor(sec * CDG_PACKETS_PER_SECOND));
  }

  /** Applies one instruction; `o` is the offset of the 16 data bytes. */
  instruction(inst, d, o) {
    switch (inst) {
      case MEMORY_PRESET: {
        // Repeats (data[1] > 0) are redundant copies for error resilience.
        if ((d[o + 1] & 0x0f) !== 0) return;
        const c = d[o] & 0x0f;
        this.pixels.fill(c);
        this.bgColor = c;
        break;
      }
      case BORDER_PRESET: {
        const c = d[o] & 0x0f;
        this.borderColor = c;
        const px = this.pixels;
        for (let y = 0; y < CDG_HEIGHT; y++) {
          const row = y * CDG_WIDTH;
          if (y < BORDER_Y || y >= CDG_HEIGHT - BORDER_Y) {
            px.fill(c, row, row + CDG_WIDTH);
          } else {
            px.fill(c, row, row + BORDER_X);
            px.fill(c, row + CDG_WIDTH - BORDER_X, row + CDG_WIDTH);
          }
        }
        break;
      }
      case TILE_NORMAL:
      case TILE_XOR: {
        const c0 = d[o] & 0x0f;
        const c1 = d[o + 1] & 0x0f;
        const row = d[o + 2] & 0x1f;
        const col = d[o + 3] & 0x3f;
        if (row >= 18 || col >= 50) return;
        const x0 = col * 6;
        const y0 = row * 12;
        const px = this.pixels;
        const xor = inst === TILE_XOR;
        for (let y = 0; y < 12; y++) {
          const bits = d[o + 4 + y] & 0x3f;
          let i = (y0 + y) * CDG_WIDTH + x0;
          for (let b = 5; b >= 0; b--, i++) {
            const c = (bits >> b) & 1 ? c1 : c0;
            px[i] = xor ? (px[i] ^ c) & 0x0f : c;
          }
        }
        break;
      }
      case SCROLL_PRESET:
      case SCROLL_COPY:
        this.scroll(d[o] & 0x0f, d[o + 1] & 0x3f, d[o + 2] & 0x3f, inst === SCROLL_COPY);
        break;
      case DEFINE_TRANSPARENT:
        this.transparent = d[o] & 0x0f;
        this.paletteVersion++;
        break;
      case LOAD_COLORS_LOW:
      case LOAD_COLORS_HIGH: {
        const base = inst === LOAD_COLORS_LOW ? 0 : 8;
        for (let i = 0; i < 8; i++) {
          const hi = d[o + i * 2] & 0x3f;
          const lo = d[o + i * 2 + 1] & 0x3f;
          const r = (hi & 0x3c) >> 2;
          const g = ((hi & 0x03) << 2) | ((lo & 0x30) >> 4);
          const b = lo & 0x0f;
          const p = (base + i) * 3;
          this.palette[p] = r * 17;
          this.palette[p + 1] = g * 17;
          this.palette[p + 2] = b * 17;
        }
        this.paletteVersion++;
        break;
      }
      default:
        return;
    }
    this.version++;
    this.dirty = true;
  }

  scroll(color, hScroll, vScroll, copy) {
    const hCmd = (hScroll & 0x30) >> 4;
    const vCmd = (vScroll & 0x30) >> 4;
    this.hOffset = Math.min(hScroll & 0x07, 5);
    this.vOffset = Math.min(vScroll & 0x0f, 11);
    const dx = hCmd === 1 ? 6 : hCmd === 2 ? -6 : 0; // 1 = right, 2 = left
    const dy = vCmd === 1 ? 12 : vCmd === 2 ? -12 : 0; // 1 = down, 2 = up
    if (!dx && !dy) return;
    const src = this.pixels;
    const dst = this.scratch;
    for (let y = 0; y < CDG_HEIGHT; y++) {
      let sy = y - dy;
      let fillRow = false;
      if (sy < 0 || sy >= CDG_HEIGHT) {
        if (copy) sy = (sy + CDG_HEIGHT) % CDG_HEIGHT;
        else fillRow = true;
      }
      const drow = y * CDG_WIDTH;
      if (fillRow) { dst.fill(color, drow, drow + CDG_WIDTH); continue; }
      const srow = sy * CDG_WIDTH;
      for (let x = 0; x < CDG_WIDTH; x++) {
        let sx = x - dx;
        if (sx < 0 || sx >= CDG_WIDTH) {
          if (copy) sx = (sx + CDG_WIDTH) % CDG_WIDTH;
          else { dst[drow + x] = color; continue; }
        }
        dst[drow + x] = src[srow + sx];
      }
    }
    this.scratch = src;
    this.pixels = dst;
  }

  /** Colour index shown at visible coordinate (x, y) of the 300×216 screen. */
  displayIndex(x, y) {
    if (x < BORDER_X || x >= CDG_WIDTH - BORDER_X || y < BORDER_Y || y >= CDG_HEIGHT - BORDER_Y) {
      return this.pixels[y * CDG_WIDTH + x];
    }
    return this.pixels[(y + this.vOffset) * CDG_WIDTH + x + this.hOffset];
  }

  /**
   * Writes the visible picture as colour indices (w×h, optionally without the border).
   * @returns {Uint8Array}
   */
  indices({ border = false, out } = {}) {
    const w = border ? CDG_WIDTH : VISIBLE_WIDTH;
    const h = border ? CDG_HEIGHT : VISIBLE_HEIGHT;
    const dst = out || new Uint8Array(w * h);
    const px = this.pixels;
    const x0 = border ? 0 : BORDER_X;
    const y0 = border ? 0 : BORDER_Y;
    for (let y = 0; y < h; y++) {
      const sy = y + y0;
      const inner = sy >= BORDER_Y && sy < CDG_HEIGHT - BORDER_Y;
      for (let x = 0; x < w; x++) {
        const sx = x + x0;
        const inside = inner && sx >= BORDER_X && sx < CDG_WIDTH - BORDER_X;
        dst[y * w + x] = inside ? px[(sy + this.vOffset) * CDG_WIDTH + sx + this.hOffset] : px[sy * CDG_WIDTH + sx];
      }
    }
    return dst;
  }

  /**
   * RGBA lookup for the current palette (Uint32 little-endian ABGR, as ImageData expects).
   * With `transparentBg`, the paper colour and the "transparent" colour get alpha 0.
   */
  rgba32({ transparentBg = false } = {}) {
    const out = new Uint32Array(16);
    const p = this.palette;
    for (let i = 0; i < 16; i++) {
      const clear = transparentBg && (i === this.bgColor || i === this.transparent);
      const a = clear ? 0 : 255;
      out[i] = ((a << 24) | (p[i * 3 + 2] << 16) | (p[i * 3 + 1] << 8) | p[i * 3]) >>> 0;
    }
    return out;
  }

  /** Share of visible pixels that differ from the paper colour (0..1) — "how much text is on screen". */
  inkRatio() {
    const idx = this.indices();
    let n = 0;
    for (let i = 0; i < idx.length; i++) if (idx[i] !== this.bgColor) n++;
    return n / idx.length;
  }
}

/**
 * Scale2x / EPX on an index buffer: doubles resolution while keeping edges crisp,
 * so text looks smooth when scaled up on a big TV.
 */
export function scale2x(src, w, h, dst = new Uint8Array(w * h * 4)) {
  const w2 = w * 2;
  for (let y = 0; y < h; y++) {
    const up = y > 0 ? y - 1 : y;
    const dn = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const p = src[y * w + x];
      const a = src[up * w + x];
      const d = src[dn * w + x];
      const c = src[y * w + (x > 0 ? x - 1 : x)];
      const b = src[y * w + (x < w - 1 ? x + 1 : x)];
      let e0 = p; let e1 = p; let e2 = p; let e3 = p;
      if (a !== d && c !== b) {
        if (c === a) e0 = a;
        if (a === b) e1 = b;
        if (c === d) e2 = c;
        if (d === b) e3 = d;
      }
      const o = (y * 2) * w2 + x * 2;
      dst[o] = e0;
      dst[o + 1] = e1;
      dst[o + w2] = e2;
      dst[o + w2 + 1] = e3;
    }
  }
  return dst;
}

/**
 * Picks a time (seconds) between `from` and `to` (fractions of the song) where the
 * screen shows the most lyrics — used for "lyrics peek" quiz questions.
 */
export function pickLyricsFrame(data, { from = 0.3, to = 0.7, step = 2 } = {}) {
  const dec = new CdgDecoder(data);
  const dur = dec.duration;
  let best = { time: dur * from, ink: -1 };
  for (let t = dur * from; t <= dur * to; t += step) {
    dec.seekTime(t);
    const ink = dec.inkRatio();
    if (ink > best.ink) best = { time: t, ink };
  }
  return best;
}
