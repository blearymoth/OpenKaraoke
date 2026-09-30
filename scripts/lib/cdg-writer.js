// Minimal CD+G encoder used by tests and the demo-library generator.
// Not needed at runtime.

const GLYPHS = {
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # '],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  0: [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  1: ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  3: ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  4: ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  6: ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  7: ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  8: [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  9: [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  '.': ['     ', '     ', '     ', '     ', '     ', ' ##  ', ' ##  '],
  ',': ['     ', '     ', '     ', '     ', ' ##  ', '  #  ', ' #   '],
  '!': ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '     ', '  #  '],
  '?': [' ### ', '#   #', '    #', '   # ', '  #  ', '     ', '  #  '],
  "'": ['  #  ', '  #  ', ' #   ', '     ', '     ', '     ', '     '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
  '&': [' ##  ', '#  # ', '# #  ', ' #   ', '# # #', '#  # ', ' ## #'],
  ':': ['     ', ' ##  ', ' ##  ', '     ', ' ##  ', ' ##  ', '     '],
  '♪': ['  ## ', '  # #', '  #  ', '  #  ', ' ##  ', '###  ', ' #   '],
};

/** 12×24 pixel bitmap (2×2 tiles) of one character: 5×7 glyph scaled ×2, centred. */
function charBitmap(ch) {
  const g = GLYPHS[ch.toUpperCase()] || GLYPHS['?'];
  const rows = Array.from({ length: 24 }, () => new Array(12).fill(0));
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      if (g[y][x] !== '#') continue;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) rows[5 + y * 2 + dy][1 + x * 2 + dx] = 1;
    }
  }
  return rows;
}

export class CdgWriter {
  constructor() {
    this.packets = [];
  }

  get length() { return this.packets.length; }

  packet(inst, data = []) {
    const p = Buffer.alloc(24);
    p[0] = 0x09;
    p[1] = inst;
    for (let i = 0; i < 16 && i < data.length; i++) p[4 + i] = data[i] & 0x3f;
    this.packets.push(p);
    return this;
  }

  /** Empty (non-CDG) packet = nothing happens for 1/300 s. */
  pad(n = 1) {
    for (let i = 0; i < n; i++) this.packets.push(Buffer.alloc(24));
    return this;
  }

  padToTime(sec) {
    const target = Math.round(sec * 300);
    if (target > this.packets.length) this.pad(target - this.packets.length);
    return this;
  }

  memoryPreset(color, repeat = 0) { return this.packet(1, [color, repeat]); }
  borderPreset(color) { return this.packet(2, [color]); }
  transparent(color) { return this.packet(28, [color]); }

  /** colors: up to 16 [r, g, b] entries with 4-bit components (0..15). */
  loadColors(colors) {
    for (const [inst, base] of [[30, 0], [31, 8]]) {
      const data = [];
      for (let i = 0; i < 8; i++) {
        const [r, g, b] = colors[base + i] || [0, 0, 0];
        data.push(((r & 0x0f) << 2) | ((g & 0x0c) >> 2), ((g & 0x03) << 4) | (b & 0x0f));
      }
      this.packet(inst, data);
    }
    return this;
  }

  /** rows: 12 numbers with 6 bits each (bit 5 = left-most pixel). */
  tile(row, col, c0, c1, rows, xor = false) {
    return this.packet(xor ? 38 : 6, [c0, c1, row, col, ...rows]);
  }

  scroll({ color = 0, hCmd = 0, hOffset = 0, vCmd = 0, vOffset = 0, copy = false }) {
    return this.packet(copy ? 24 : 20, [color, (hCmd << 4) | hOffset, (vCmd << 4) | vOffset]);
  }

  /**
   * Draws text with 12×24 characters. `row` is a tile row (0..17, 2 rows per text line),
   * `col` a tile column (0..49, 2 columns per character).
   */
  text(str, row, col, fg, bg, { xor = false } = {}) {
    [...str].forEach((ch, i) => {
      const bmp = charBitmap(ch);
      for (let ty = 0; ty < 2; ty++) {
        for (let tx = 0; tx < 2; tx++) {
          const rows = [];
          for (let y = 0; y < 12; y++) {
            let bits = 0;
            for (let x = 0; x < 6; x++) bits = (bits << 1) | bmp[ty * 12 + y][tx * 6 + x];
            rows.push(bits);
          }
          if (xor) this.tile(row + ty, col + i * 2 + tx, 0, fg ^ bg, rows, true);
          else this.tile(row + ty, col + i * 2 + tx, bg, fg, rows);
        }
      }
    });
    return this;
  }

  toBuffer() {
    return Buffer.concat(this.packets);
  }
}

/** Column where `str` must start to be centred on the 50-column screen (2 columns/char). */
export function centerCol(str) {
  return Math.max(1, Math.floor((50 - str.length * 2) / 2));
}
