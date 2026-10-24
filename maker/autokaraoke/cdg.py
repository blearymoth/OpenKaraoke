"""Low-level CD+G (TV graphics) packet encoding.

A CDG stream is a sequence of 24-byte packets played at 300 packets per second.
Only the "TV graphics" command (0x09) is used. Screen: 300x216 pixels, 50x18 tiles
of 6x12 pixels, 16 palette colours (4 bits per channel). The safe visible area
excludes the outer tile ring: tile columns 1..48, tile rows 1..16.

Reference: "CD+G Revealed" (Jim Bumgardner) and the Red Book subcode spec.
"""

import numpy as np

W, H = 300, 216
TILE_W, TILE_H = 6, 12
COLS, ROWS = W // TILE_W, H // TILE_H  # 50 x 18
PACKETS_PER_SECOND = 300
PACKET_SIZE = 24

CMD_TV_GRAPHICS = 0x09
MEMORY_PRESET = 1
BORDER_PRESET = 2
TILE_NORMAL = 6
SCROLL_PRESET = 20
SCROLL_COPY = 24
LOAD_COLORS_LO = 30
LOAD_COLORS_HI = 31
TILE_XOR = 38

EMPTY = bytes(PACKET_SIZE)


def packet(instruction, data):
    """Build one packet. Data bytes only carry 6 bits; parity bytes stay zero."""
    if len(data) > 16:
        raise ValueError("CDG packet data is at most 16 bytes")
    b = bytearray(PACKET_SIZE)
    b[0] = CMD_TV_GRAPHICS
    b[1] = instruction
    for i, v in enumerate(data):
        b[4 + i] = v & 0x3F
    return bytes(b)


def memory_preset(color, repeat=0):
    return packet(MEMORY_PRESET, [color & 0x0F, repeat & 0x0F])


def border_preset(color):
    return packet(BORDER_PRESET, [color & 0x0F])


def load_colors(palette):
    """palette: 16 (r, g, b) tuples with 0..15 channels -> two packets."""
    if len(palette) != 16:
        raise ValueError("palette needs exactly 16 colours")
    out = []
    for instr, colors in ((LOAD_COLORS_LO, palette[:8]), (LOAD_COLORS_HI, palette[8:])):
        data = []
        for r, g, b in colors:
            for c in (r, g, b):
                if not 0 <= c <= 15:
                    raise ValueError(f"colour channel {c} outside 0..15")
            data += [(r << 2) | (g >> 2), ((g & 0x03) << 4) | b]
        out.append(packet(instr, data))
    return out


def scroll_packet(color, v_cmd=0, h_cmd=0, copy=False):
    """Scroll the whole screen by one step: v_cmd 2 = up 12 px, 1 = down 12 px;
    h_cmd 2 = left 6 px, 1 = right 6 px. Preset (default) fills the vacated edge with
    `color`; copy wraps the pixels that leave the screen round to the other side.
    Pixel offsets are always 0, so every step is a whole tile."""
    return packet(SCROLL_COPY if copy else SCROLL_PRESET,
                  [color & 0x0F, (h_cmd & 3) << 4, (v_cmd & 3) << 4])


def tile_packet(row, col, color0, color1, bits, xor=False):
    """bits: (12, 6) bool array; True pixels take color1, False take color0."""
    data = [color0 & 0x0F, color1 & 0x0F, row & 0x1F, col & 0x3F]
    weights = np.array([32, 16, 8, 4, 2, 1], dtype=np.uint8)
    rows = (bits.astype(np.uint8) * weights).sum(axis=1)
    data += [int(v) for v in rows]
    return packet(TILE_XOR if xor else TILE_NORMAL, data)


def tile_ops(cur, want):
    """Cheapest list of (xor, color0, color1, bits) ops turning tile `cur` into `want`.

    Two strategies, whichever needs fewer packets:
      * XOR from the current contents: one packet per distinct (cur ^ want) value.
        A highlight wipe (unsung -> sung on fill pixels only) is a single packet.
      * Direct: one normal packet with the two most common colours, plus one XOR
        packet per extra colour.
    """
    diff = cur ^ want
    if not diff.any():
        return []
    xor_vals = np.unique(diff[diff != 0])
    colors, counts = np.unique(want, return_counts=True)
    n_direct = 1 + max(0, len(colors) - 2)
    if len(xor_vals) <= n_direct:
        return [(True, 0, int(v), diff == v) for v in xor_vals]
    order = colors[np.argsort(-counts, kind="stable")]
    c0 = int(order[0])
    c1 = int(order[1]) if len(order) > 1 else c0
    ops = [(False, c0, c1, want == c1)]
    for c in order[2:]:
        ops.append((True, 0, int(c) ^ c0, want == c))
    return ops


def apply_op(tile, op):
    """Apply an op to a (12, 6) uint8 tile exactly as a decoder would."""
    xor, c0, c1, bits = op
    vals = np.where(bits, c1, c0).astype(np.uint8)
    if xor:
        tile ^= vals
    else:
        tile[:] = vals


def decode(stream):
    """Minimal reference decoder (for tests): returns (screen, palette) after the stream.
    Supports the instructions this encoder emits (presets, colour tables, scrolls,
    normal/XOR tiles)."""
    screen = np.zeros((H, W), dtype=np.uint8)
    palette = [(0, 0, 0)] * 16
    for i in range(0, len(stream), PACKET_SIZE):
        p = stream[i:i + PACKET_SIZE]
        if (p[0] & 0x3F) != CMD_TV_GRAPHICS:
            continue
        instr = p[1] & 0x3F
        d = [x & 0x3F for x in p[4:20]]
        if instr == MEMORY_PRESET:
            screen[:] = d[0] & 0x0F
        elif instr == BORDER_PRESET:
            c = d[0] & 0x0F
            screen[:TILE_H, :] = c
            screen[-TILE_H:, :] = c
            screen[:, :TILE_W] = c
            screen[:, -TILE_W:] = c
        elif instr in (LOAD_COLORS_LO, LOAD_COLORS_HI):
            base = 0 if instr == LOAD_COLORS_LO else 8
            for k in range(8):
                hi, lo = d[2 * k], d[2 * k + 1]
                palette[base + k] = (hi >> 2, ((hi & 3) << 2) | (lo >> 4), lo & 0x0F)
        elif instr in (SCROLL_PRESET, SCROLL_COPY):
            color = d[0] & 0x0F
            h_cmd, v_cmd = (d[1] & 0x30) >> 4, (d[2] & 0x30) >> 4
            dx = {1: 6, 2: -6}.get(h_cmd, 0)
            dy = {1: 12, 2: -12}.get(v_cmd, 0)
            if dx or dy:
                if instr == SCROLL_COPY:
                    screen = np.roll(screen, (dy, dx), axis=(0, 1))
                else:
                    moved = np.full_like(screen, color)
                    ys, yd = (slice(0, H - dy), slice(dy, H)) if dy >= 0 else (slice(-dy, H), slice(0, H + dy))
                    xs, xd = (slice(0, W - dx), slice(dx, W)) if dx >= 0 else (slice(-dx, W), slice(0, W + dx))
                    moved[yd, xd] = screen[ys, xs]
                    screen = moved
        elif instr in (TILE_NORMAL, TILE_XOR):
            c0, c1, row, col = d[0] & 0x0F, d[1] & 0x0F, d[2] & 0x1F, d[3] & 0x3F
            if row >= ROWS or col >= COLS:
                continue
            bits = np.array([[(d[4 + y] >> (5 - x)) & 1 for x in range(6)] for y in range(12)], bool)
            y0, x0 = row * TILE_H, col * TILE_W
            apply_op(screen[y0:y0 + TILE_H, x0:x0 + TILE_W], (instr == TILE_XOR, c0, c1, bits))
    return screen, palette
