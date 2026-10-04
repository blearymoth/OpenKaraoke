// CD+G karaoke graphics decoder. Isomorphic: used by the TV renderer (browser) and the
// server (e.g. picking a "lyrics frame" for quiz rounds). No DOM or Node APIs here.
//
// Format (docs/PLAN.md §9.2): 24-byte packets, 300 packets per second. A packet is CD+G when
// (byte0 & 0x3F) === 9; its instruction is byte1 & 0x3F and its 16 data bytes are 4..19
// (6 bits used each). The screen is a 300×216 buffer of 4-bit colour indices; the visible
// area is 288×192 at (6, 12), shifted by the horizontal/vertical scroll offsets.

export const CDG_PACKET_SIZE = 24;
export const CDG_PACKETS_PER_SECOND = 300;
export const CDG_WIDTH = 300;
export const CDG_HEIGHT = 216;
export const CDG_VISIBLE_X = 6;
export const CDG_VISIBLE_Y = 12;
export const CDG_VISIBLE_WIDTH = 288;
export const CDG_VISIBLE_HEIGHT = 192;

export const CDG_INSTR = {
  MEMORY_PRESET: 1,
  BORDER_PRESET: 2,
  TILE_NORMAL: 6,
  SCROLL_PRESET: 20,
  SCROLL_COPY: 24,
  DEFINE_TRANSPARENT: 28,
  LOAD_COLORS_LOW: 30,
  LOAD_COLORS_HIGH: 31,
  TILE_XOR: 38,
};

const W = CDG_WIDTH;
const H = CDG_HEIGHT;

export class CdgDecoder {
  /** @param {Uint8Array|ArrayBuffer} bytes the whole .cdg file */
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.packetCount = Math.floor(this.bytes.length / CDG_PACKET_SIZE);
    this.pixels = new Uint8Array(W * H);
    this.scratch = new Uint8Array(W * H);
    this.palette = new Uint8Array(16 * 3);
    this.version = 0; // bumps on every visible change
    this.reset();
  }

  /** Length in seconds (CDG files run for the whole song). */
  get duration() {
    return this.packetCount / CDG_PACKETS_PER_SECOND;
  }

  reset() {
    this.pixels.fill(0);
    this.palette.fill(0);
    this.position = 0; // index of the next packet to execute
    this.hOffset = 0;
    this.vOffset = 0;
    this.borderColor = 0;
    this.bgColor = 0;
    this.transparentColor = -1; // parsed for compatibility; nothing keys it (it is a 16-entry table, not one colour)
    this.scrollFill = -1; // the colour the latest SCROLL_PRESET filled the uncovered rows/columns with
    this.version++;
  }

  /**
   * Brings the screen to time `t` (seconds). Going backwards replays from the start
   * (a whole song decodes in a few milliseconds). Returns true when the image changed.
   */
  seek(t) {
    if (!Number.isFinite(t)) return false;
    const target = Math.max(0, Math.min(this.packetCount, Math.floor(t * CDG_PACKETS_PER_SECOND)));
    let changed = false;
    if (target < this.position) {
      this.reset();
      changed = true;
    }
    const b = this.bytes;
    for (let i = this.position; i < target; i++) {
      const o = i * CDG_PACKET_SIZE;
      if ((b[o] & 0x3f) !== 9) continue;
      if (this.execute(b[o + 1] & 0x3f, o + 4)) changed = true;
    }
    this.position = target;
    if (changed) this.version++;
    return changed;
  }

  /** Runs one instruction whose data starts at byte offset `d`. Returns true if pixels/colours changed. */
  execute(instr, d) {
    const b = this.bytes;
    switch (instr) {
      case CDG_INSTR.MEMORY_PRESET: {
        const color = b[d] & 0x0f;
        this.pixels.fill(color);
        this.bgColor = color;
        return true;
      }
      case CDG_INSTR.BORDER_PRESET: {
        const color = b[d] & 0x0f;
        this.borderColor = color;
        const px = this.pixels;
        px.fill(color, 0, W * CDG_VISIBLE_Y);
        px.fill(color, W * (CDG_VISIBLE_Y + CDG_VISIBLE_HEIGHT), W * H);
        for (let y = CDG_VISIBLE_Y; y < CDG_VISIBLE_Y + CDG_VISIBLE_HEIGHT; y++) {
          const row = y * W;
          px.fill(color, row, row + CDG_VISIBLE_X);
          px.fill(color, row + CDG_VISIBLE_X + CDG_VISIBLE_WIDTH, row + W);
        }
        return true;
      }
      case CDG_INSTR.TILE_NORMAL:
      case CDG_INSTR.TILE_XOR: {
        const c0 = b[d] & 0x0f;
        const c1 = b[d + 1] & 0x0f;
        const row = b[d + 2] & 0x1f;
        const col = b[d + 3] & 0x3f;
        if (row >= 18 || col >= 50) return false;
        const xor = instr === CDG_INSTR.TILE_XOR;
        const px = this.pixels;
        let i = row * 12 * W + col * 6;
        for (let y = 0; y < 12; y++, i += W) {
          const bits = b[d + 4 + y] & 0x3f;
          for (let x = 0; x < 6; x++) {
            const c = (bits >> (5 - x)) & 1 ? c1 : c0;
            px[i + x] = xor ? px[i + x] ^ c : c;
          }
        }
        return true;
      }
      case CDG_INSTR.SCROLL_PRESET:
      case CDG_INSTR.SCROLL_COPY:
        return this.scroll(b[d] & 0x0f, b[d + 1] & 0x3f, b[d + 2] & 0x3f, instr === CDG_INSTR.SCROLL_COPY);
      case CDG_INSTR.DEFINE_TRANSPARENT:
        this.transparentColor = b[d] & 0x0f;
        return false;
      case CDG_INSTR.LOAD_COLORS_LOW:
      case CDG_INSTR.LOAD_COLORS_HIGH: {
        const base = instr === CDG_INSTR.LOAD_COLORS_LOW ? 0 : 8;
        for (let i = 0; i < 8; i++) {
          const hi = b[d + i * 2] & 0x3f;
          const lo = b[d + i * 2 + 1] & 0x3f;
          const p = (base + i) * 3;
          this.palette[p] = ((hi >> 2) & 0x0f) * 17;
          this.palette[p + 1] = (((hi & 0x03) << 2) | ((lo >> 4) & 0x03)) * 17;
          this.palette[p + 2] = (lo & 0x0f) * 17;
        }
        return true;
      }
      default:
        return false;
    }
  }

  scroll(color, h, v, copy) {
    const hCmd = (h & 0x30) >> 4;
    const vCmd = (v & 0x30) >> 4;
    const hOff = Math.min(h & 0x07, 5);
    const vOff = Math.min(v & 0x0f, 11);
    const changed = hOff !== this.hOffset || vOff !== this.vOffset;
    this.hOffset = hOff;
    this.vOffset = vOff;
    const dx = hCmd === 1 ? 6 : hCmd === 2 ? -6 : 0; // 1 = right, 2 = left
    const dy = vCmd === 1 ? 12 : vCmd === 2 ? -12 : 0; // 1 = down, 2 = up
    if (!dx && !dy) return changed;
    if (!copy) this.scrollFill = color;
    // Row by row (rows are contiguous): the shifted part of the source row, then the part that
    // wraps round (copy) or the fill colour (preset).
    const src = this.pixels;
    const dst = this.scratch;
    for (let y = 0; y < H; y++) {
      let sy = y - dy;
      if (copy) sy = (sy + H) % H;
      const d = y * W;
      if (sy < 0 || sy >= H) {
        dst.fill(color, d, d + W);
        continue;
      }
      const s = sy * W;
      if (dx > 0) {
        dst.set(src.subarray(s, s + W - dx), d + dx);
        if (copy) dst.set(src.subarray(s + W - dx, s + W), d);
        else dst.fill(color, d, d + dx);
      } else if (dx < 0) {
        dst.set(src.subarray(s - dx, s + W), d);
        if (copy) dst.set(src.subarray(s, s - dx), d + W + dx);
        else dst.fill(color, d + W + dx, d + W);
      } else {
        dst.set(src.subarray(s, s + W), d);
      }
    }
    this.pixels = dst;
    this.scratch = src;
    return true;
  }

  /** Colour index at visible pixel (x, y) (0..287, 0..191), honouring the scroll offsets. */
  visibleIndex(x, y) {
    const sx = Math.min(W - 1, x + CDG_VISIBLE_X + this.hOffset);
    const sy = Math.min(H - 1, y + CDG_VISIBLE_Y + this.vOffset);
    return this.pixels[sy * W + sx];
  }

  /** Copies the visible 288×192 area (with scroll offsets) into `out` (Uint8Array of indices). */
  visibleIndices(out = new Uint8Array(CDG_VISIBLE_WIDTH * CDG_VISIBLE_HEIGHT)) {
    const px = this.pixels;
    const ox = CDG_VISIBLE_X + this.hOffset;
    const oy = CDG_VISIBLE_Y + this.vOffset;
    for (let y = 0; y < CDG_VISIBLE_HEIGHT; y++) {
      const sy = Math.min(H - 1, y + oy);
      const srcRow = sy * W;
      const dstRow = y * CDG_VISIBLE_WIDTH;
      for (let x = 0; x < CDG_VISIBLE_WIDTH; x++) out[dstRow + x] = px[srcRow + Math.min(W - 1, x + ox)];
    }
    return out;
  }

  /** How many visible pixels differ from the background colour (used to find lyric-heavy frames). */
  inkCount() {
    const idx = this.visibleIndices();
    let n = 0;
    for (let i = 0; i < idx.length; i++) if (idx[i] !== this.bgColor) n++;
    return n;
  }
}

/**
 * Scale2x (EPX) on an index buffer: doubles the resolution while keeping edges crisp,
 * which makes blocky CDG text look smooth on a big TV.
 */
export function scale2x(src, w, h, out = new Uint8Array(w * h * 4)) {
  return scale2xRect(src, w, h, 0, 0, w, h, out);
}

/**
 * Scale2x of the rectangle [x0, x1) × [y0, y1) of `src` (w × h) into `out` (2w × 2h); the rest
 * of `out` is left as it was (the TV redraws only what changed).
 */
export function scale2xRect(src, w, h, x0, y0, x1, y1, out) {
  const ow = w * 2;
  for (let y = y0; y < y1; y++) {
    const up = (y > 0 ? y - 1 : y) * w;
    const row = y * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    let o = y * 2 * ow + x0 * 2;
    for (let x = x0; x < x1; x++, o += 2) {
      const p = src[row + x];
      const a = src[up + x];
      const b = src[row + (x < w - 1 ? x + 1 : x)];
      const c = src[row + (x > 0 ? x - 1 : x)];
      const d = src[down + x];
      out[o] = c === a && c !== d && a !== b ? a : p;
      out[o + 1] = a === b && a !== c && b !== d ? b : p;
      out[o + ow] = d === c && d !== b && c !== a ? c : p;
      out[o + ow + 1] = b === d && b !== a && d !== c ? d : p;
    }
  }
  return out;
}

/**
 * Maps colour indices to RGBA pixels. `alphaFor` gives each of the 16 colours an alpha
 * (0 = transparent) so the background can show artwork behind the lyrics.
 */
export function indicesToRgba(indices, palette, out, alphaFor) {
  const lut = new Uint32Array(16);
  for (let c = 0; c < 16; c++) {
    const a = alphaFor ? alphaFor[c] : 255;
    // little-endian RGBA as a single 32-bit word; premultiplied colour is not needed for ImageData
    lut[c] = ((a & 255) << 24) | (palette[c * 3 + 2] << 16) | (palette[c * 3 + 1] << 8) | palette[c * 3];
  }
  const out32 = new Uint32Array(out.buffer, out.byteOffset, indices.length);
  for (let i = 0; i < indices.length; i++) out32[i] = lut[indices[i]];
  return out;
}

/**
 * Picks the time (seconds) whose screen shows the most lyrics between `from` and `to`
 * (fractions of the song), sampling every `step` seconds.
 */
export function findLyricsFrame(bytes, { from = 0.3, to = 0.7, step = 1 } = {}) {
  const dec = new CdgDecoder(bytes);
  const start = dec.duration * from;
  const end = dec.duration * to;
  let best = start;
  let bestInk = -1;
  for (let t = start; t <= end; t += step) {
    dec.seek(t);
    const ink = dec.inkCount();
    const share = ink / (CDG_VISIBLE_WIDTH * CDG_VISIBLE_HEIGHT);
    if (share < 0.6 && ink > bestInk) {
      bestInk = ink;
      best = t;
    }
  }
  return { time: best, ink: Math.max(0, bestInk) };
}
