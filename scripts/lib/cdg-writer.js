// CD+G writer used by tests and by scripts/make-demo-library.js to create synthetic karaoke
// graphics: colour tables, presets, tiles, scrolling and text with a karaoke highlight wipe.
// Not used at runtime.
import { CDG_INSTR, CDG_PACKET_SIZE, CDG_PACKETS_PER_SECOND, CDG_WIDTH, CDG_HEIGHT, CDG_VISIBLE_X, CDG_VISIBLE_Y, CDG_VISIBLE_WIDTH, CDG_VISIBLE_HEIGHT } from '../../shared/cdg.js';
import { GLYPHS, FONT_HEIGHT } from './cdg-font.js';

const W = CDG_WIDTH;
const H = CDG_HEIGHT;

export class CdgWriter {
  constructor() {
    this.chunks = [];
    this.count = 0;
    this.screen = new Uint8Array(W * H);
  }

  /** Current time in seconds (packets written / 300). */
  get time() {
    return this.count / CDG_PACKETS_PER_SECOND;
  }

  packet(instr, data = []) {
    const p = new Uint8Array(CDG_PACKET_SIZE);
    p[0] = 9;
    p[1] = instr;
    for (let i = 0; i < data.length && i < 16; i++) p[4 + i] = data[i] & 0x3f;
    this.chunks.push(p);
    this.count++;
  }

  /** Pads with empty (non-CDG) packets until `seconds`. */
  padTo(seconds) {
    const n = Math.round(seconds * CDG_PACKETS_PER_SECOND) - this.count;
    if (n > 0) {
      this.chunks.push(new Uint8Array(CDG_PACKET_SIZE * n));
      this.count += n;
    }
  }

  /** colors: 16 × [r, g, b] with 4-bit components (0–15). */
  loadColors(colors) {
    for (const [instr, base] of [[CDG_INSTR.LOAD_COLORS_LOW, 0], [CDG_INSTR.LOAD_COLORS_HIGH, 8]]) {
      const data = [];
      for (let i = 0; i < 8; i++) {
        const [r, g, b] = colors[base + i] || [0, 0, 0];
        data.push(((r & 15) << 2) | ((g & 15) >> 2), ((g & 3) << 4) | (b & 15));
      }
      this.packet(instr, data);
    }
  }

  memoryPreset(color, repeats = 1) {
    for (let r = 0; r < repeats; r++) this.packet(CDG_INSTR.MEMORY_PRESET, [color, r]);
    this.screen.fill(color);
  }

  borderPreset(color) {
    this.packet(CDG_INSTR.BORDER_PRESET, [color]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= CDG_VISIBLE_X && x < CDG_VISIBLE_X + CDG_VISIBLE_WIDTH && y >= CDG_VISIBLE_Y && y < CDG_VISIBLE_Y + CDG_VISIBLE_HEIGHT;
        if (!inside) this.screen[y * W + x] = color;
      }
    }
  }

  /** rows: 12 numbers of 6 bits (bit 5 = leftmost pixel). */
  tile(row, col, c0, c1, rows, xor = false) {
    this.packet(xor ? CDG_INSTR.TILE_XOR : CDG_INSTR.TILE_NORMAL, [c0, c1, row, col, ...rows]);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 6; x++) {
        const i = (row * 12 + y) * W + col * 6 + x;
        const c = (rows[y] >> (5 - x)) & 1 ? c1 : c0;
        this.screen[i] = xor ? this.screen[i] ^ c : c;
      }
    }
  }

  /** hCmd/vCmd: 0 none, 1 right/down, 2 left/up. */
  scroll(copy, color, hCmd = 0, hOffset = 0, vCmd = 0, vOffset = 0) {
    this.packet(copy ? CDG_INSTR.SCROLL_COPY : CDG_INSTR.SCROLL_PRESET, [color, (hCmd << 4) | hOffset, (vCmd << 4) | vOffset]);
    const dx = hCmd === 1 ? 6 : hCmd === 2 ? -6 : 0;
    const dy = vCmd === 1 ? 12 : vCmd === 2 ? -12 : 0;
    if (!dx && !dy) return;
    const src = this.screen.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sx = x - dx;
        let sy = y - dy;
        if (copy) { sx = (sx + W) % W; sy = (sy + H) % H; }
        this.screen[y * W + x] = sx >= 0 && sx < W && sy >= 0 && sy < H ? src[sy * W + sx] : color;
      }
    }
  }

  /** Emits the tile packets needed to turn the current screen into `target` (300×216 indices). */
  drawFrame(target) {
    for (let row = 0; row < 18; row++) {
      for (let col = 0; col < 50; col++) {
        if (!tileDiffers(this.screen, target, row, col)) continue;
        const counts = new Map();
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 6; x++) {
            const c = target[(row * 12 + y) * W + col * 6 + x];
            counts.set(c, (counts.get(c) || 0) + 1);
          }
        }
        const colors = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
        const c0 = colors[0];
        const c1 = colors[1] ?? c0;
        this.tile(row, col, c0, c1, tileBits(target, row, col, (c) => c === c1 && c1 !== c0));
        // Tiles with more than two colours: flip the remaining pixels with XOR packets.
        for (const extra of colors.slice(2)) {
          this.tile(row, col, 0, c0 ^ extra, tileBits(target, row, col, (c) => c === extra), true);
        }
      }
    }
  }

  toBuffer() {
    const out = new Uint8Array(this.count * CDG_PACKET_SIZE);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function tileDiffers(a, b, row, col) {
  for (let y = 0; y < 12; y++) {
    const i = (row * 12 + y) * W + col * 6;
    for (let x = 0; x < 6; x++) if (a[i + x] !== b[i + x]) return true;
  }
  return false;
}

function tileBits(target, row, col, pred) {
  const rows = [];
  for (let y = 0; y < 12; y++) {
    let bits = 0;
    for (let x = 0; x < 6; x++) if (pred(target[(row * 12 + y) * W + col * 6 + x])) bits |= 1 << (5 - x);
    rows.push(bits);
  }
  return rows;
}

export function textWidth(text) {
  let w = 0;
  for (const ch of text) w += (GLYPHS.get(ch.charCodeAt(0)) || GLYPHS.get(63)).advance;
  return w;
}

/**
 * Draws `text` into a 300×216 index frame at (x, y) = top-left of the 24 px line.
 * Pixels left of `highlightX` use `highlightColor` (the karaoke wipe); `shadowColor`
 * draws a 1 px drop shadow for legibility.
 */
export function drawText(frame, text, x, y, color, { highlightX = -1, highlightColor = color, shadowColor = -1 } = {}) {
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS.get(ch.charCodeAt(0)) || GLYPHS.get(63);
    for (let gy = 0; gy < FONT_HEIGHT; gy++) {
      const bits = g.rows[gy];
      if (!bits) continue;
      for (let gx = 0; gx < g.width; gx++) {
        if (!((bits >> (g.width - 1 - gx)) & 1)) continue;
        const px = cx + gx;
        const py = y + gy;
        if (shadowColor >= 0 && px + 1 < W && py + 1 < H) {
          const si = (py + 1) * W + px + 1;
          if (frame[si] !== color && frame[si] !== highlightColor) frame[si] = shadowColor;
        }
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        frame[py * W + px] = px < highlightX ? highlightColor : color;
      }
    }
    cx += g.advance;
  }
  return cx - x;
}

/** x position that centres `text` inside the visible area. */
export function centeredX(text) {
  return CDG_VISIBLE_X + Math.max(0, Math.round((CDG_VISIBLE_WIDTH - textWidth(text)) / 2));
}
