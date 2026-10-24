"""Turn timed lyrics into a CDG stream.

Screen layout: the visible area (288x192 px) is split into N line slots (default 4).
Lyrics are grouped into pages separated by long instrumental gaps. A page is one
vertical scroll: its first N lines appear together, in order, and when the top line
has been sung the whole block moves up one slot. The finished line leaves at the top
and the next line enters at the bottom, so a later line never appears above the one
still being sung. Words are highlighted with a left-to-right wipe.

The block moves with the CDG scroll instruction (one packet moves the screen up 12 px,
so a slot takes slot_height/12 packets), as real karaoke discs do. Redrawing the lines
tile by tile instead takes over a second, and during that time pieces of the old and
the new lines are on screen together. Before each scroll every outstanding tile update
is sent first, so the screen is always either the previous page of lines or the scrolled
one, never a mixture, and only the new bottom line has to be painted.

Packet budget is 300/s. A scheduler keeps a target image and the image a decoder
would show, and sends changed tiles earliest-deadline-first: wipe tiles are due now,
upcoming lines are due shortly before they are sung. Highlight changes are single XOR
packets per tile, so wipes stay cheap.
"""

import heapq
import math
import shutil
import subprocess
from collections import deque
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import cdg
from .timing import Line

# Palette indices
BG, UNSUNG, SUNG, OUTLINE, TITLE, ARTIST = 0, 1, 2, 3, 4, 5

THEMES = {
    # 4-bit RGB (0..15)
    "classic": {BG: (0, 0, 3), UNSUNG: (15, 15, 15), SUNG: (15, 11, 0), OUTLINE: (0, 0, 0),
                TITLE: (15, 11, 0), ARTIST: (11, 13, 15)},
    "blue": {BG: (0, 0, 0), UNSUNG: (15, 15, 15), SUNG: (2, 11, 15), OUTLINE: (0, 0, 0),
             TITLE: (2, 11, 15), ARTIST: (15, 15, 15)},
    "green": {BG: (0, 2, 1), UNSUNG: (15, 15, 15), SUNG: (5, 15, 6), OUTLINE: (0, 0, 0),
              TITLE: (5, 15, 6), ARTIST: (13, 15, 13)},
}

VIS_X0, VIS_Y0 = cdg.TILE_W, cdg.TILE_H                      # 6, 12
VIS_W, VIS_H = (cdg.COLS - 2) * cdg.TILE_W, (cdg.ROWS - 2) * cdg.TILE_H  # 288, 192
SIDE_PAD = 4
SCROLL_STEP_GAP = 4   # empty packets between the 12 px steps of one scroll (about 70 ms in all)


@dataclass
class Config:
    lines_on_screen: int = 4
    font_path: str = ""
    font_size: int = 0          # 0 = fit to the line height
    outline: int = 2
    theme: str = "classic"
    lead: float = 4.0           # show a page this many seconds before its first word
    page_gap: float = 8.0       # gap (s) between lines that starts a new page
    wipe_step: int = 6          # packets between wipe updates (6 = 50 updates/s)
    title_screen: bool = True


def find_font(path=""):
    if path:
        return path
    if shutil.which("fc-match"):
        for pattern in ("DejaVu Sans Condensed:bold", "DejaVu Sans:bold", "Liberation Sans:bold",
                        "Noto Sans:bold", "sans:bold"):
            try:
                out = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True,
                                     text=True, timeout=10).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if out.lower().endswith((".ttf", ".otf")):
                return out
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
              "/usr/share/fonts/dejavu-sans-fonts/DejaVuSansCondensed-Bold.ttf",
              "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        try:
            ImageFont.truetype(p, 10)
            return p
        except OSError:
            pass
    return ""


class Fonts:
    # A typical lyric line; the default size is the largest that fits it on one row.
    REFERENCE = "Up above the world so high"

    def __init__(self, path, slot_h, outline, size=0, max_w=VIS_W - 2 * SIDE_PAD):
        self.path = path
        self.outline = outline
        self._cache = {}
        if size:
            self.size = size
        else:
            # largest size whose height fits the slot (outline + 2px air) and that fits
            # the reference line within the width
            self.size = 8
            for s in range(8, 80):
                font = self.get(s)
                asc, desc = font.getmetrics()
                if asc + desc + 2 * outline + 2 > slot_h:
                    break
                if font.getlength(self.REFERENCE) + 2 * outline > max_w:
                    break
                self.size = s

    def get(self, size):
        if size not in self._cache:
            if self.path:
                self._cache[size] = ImageFont.truetype(self.path, size)
            else:
                self._cache[size] = ImageFont.load_default(size)
        return self._cache[size]


def _wrap(words, font, max_w):
    """Greedy word wrap of Word objects -> list of word lists."""
    out, cur = [], []
    for w in words:
        trial = " ".join(x.text for x in cur + [w])
        if cur and font.getlength(trial) > max_w:
            out.append(cur)
            cur = [w]
        else:
            cur.append(w)
    if cur:
        out.append(cur)
    return out


def _balanced_wrap(words, font, max_w):
    """Wrap, then rebalance two-line splits so lines are similar in length."""
    parts = _wrap(words, font, max_w)
    if len(parts) == 2:
        best, best_score = parts, None
        for k in range(1, len(words)):
            a, b = words[:k], words[k:]
            wa = font.getlength(" ".join(x.text for x in a))
            wb = font.getlength(" ".join(x.text for x in b))
            if wa <= max_w and wb <= max_w:
                score = abs(wa - wb)
                if best_score is None or score < best_score:
                    best, best_score = [a, b], score
        parts = best
    return parts


class LineImage:
    """Pre-rendered slot image for one display line plus per-word pixel spans."""

    def __init__(self, words, fonts, width, height):
        self.words = words
        self.start, self.end = words[0].start, words[-1].end
        text = " ".join(w.text for w in words)
        o = fonts.outline
        size = fonts.size
        font = fonts.get(size)
        while size > 8 and font.getlength(text) + 2 * o > width - 2 * SIDE_PAD:
            size -= 1
            font = fonts.get(size)
        fill = _text_mask(text, font, width, height)
        outline = _dilate(fill, o) & ~fill
        self.fill = fill
        self.base = np.full((height, width), BG, np.uint8)
        self.base[outline] = OUTLINE
        self.base[fill] = UNSUNG
        tw = font.getlength(text)
        x0 = (width - tw) / 2
        self.spans = []
        prefix = ""
        for i, w in enumerate(words):
            if i:
                prefix += " "
            a = x0 + font.getlength(prefix)
            prefix += w.text
            b = x0 + font.getlength(prefix)
            self.spans.append((a, b))
        self.cols = np.arange(width)[None, :]
        self._last_x = None

    def wipe_x(self, t):
        x = -1.0
        for (a, b), w in zip(self.spans, self.words):
            if t < w.start:
                break
            dur = max(w.end - w.start, 1e-3)
            x = a + (b - a) * min(1.0, (t - w.start) / dur)
            if t >= w.end:
                x = b
        return x

    def image(self, t):
        x = self.wipe_x(t)
        img = self.base.copy()
        if x >= 0:
            img[self.fill & (self.cols < x)] = SUNG
        return img


def _text_mask(text, font, width, height):
    img = Image.new("L", (width, height), 0)
    d = ImageDraw.Draw(img)
    d.fontmode = "1"
    asc, desc = font.getmetrics()
    x = round((width - font.getlength(text)) / 2)
    y = round((height - (asc + desc)) / 2)
    d.text((x, y), text, font=font, fill=255)
    return np.array(img) > 127


def _dilate(mask, r):
    if r <= 0:
        return mask.copy()
    img = Image.fromarray(mask.astype(np.uint8) * 255)
    return np.array(img.filter(ImageFilter.MaxFilter(2 * r + 1))) > 127


class Encoder:
    """Keeps target/current screens and emits one packet per step, EDF over dirty tiles."""

    def __init__(self):
        self.cur = np.zeros((cdg.H, cdg.W), np.uint8)
        self.target = np.zeros((cdg.H, cdg.W), np.uint8)
        self.heap, self.dirty, self.seq = [], {}, 0
        self.pending = deque()
        self.out = []
        self.late = 0.0  # worst lateness (s) of a tile vs. its deadline

    def send(self, packets):
        self.pending.extend(packets)

    def clear(self, color):
        # drop queued tile updates (the screen is about to be wiped) but keep control
        # packets such as the colour table that may not have been sent yet
        keep = [p for p in self.pending if p[1] not in (cdg.TILE_NORMAL, cdg.TILE_XOR)]
        self.pending = deque(keep)
        self.heap, self.dirty = [], {}
        self.cur[:] = color
        self.target[:] = color
        self.pending.extend([cdg.memory_preset(color, 0), cdg.memory_preset(color, 1)])

    def paint(self, y, x, img, deadline):
        h, w = img.shape
        self.target[y:y + h, x:x + w] = img
        ch = self.target[y:y + h, x:x + w] != self.cur[y:y + h, x:x + w]
        if not ch.any():
            return
        ty, tx = y // cdg.TILE_H, x // cdg.TILE_W
        tiles = ch.reshape(h // cdg.TILE_H, cdg.TILE_H, w // cdg.TILE_W, cdg.TILE_W).any(axis=(1, 3))
        for r, c in zip(*np.nonzero(tiles)):
            key = (ty + int(r), tx + int(c))
            old = self.dirty.get(key)
            if old is None or deadline < old:
                self.dirty[key] = deadline
                self.seq += 1
                heapq.heappush(self.heap, (deadline, self.seq, key))

    def _next_dirty(self, now):
        """Queue the packets for the most urgent dirty tile; False when none is left."""
        while self.heap:
            deadline, _, key = heapq.heappop(self.heap)
            if self.dirty.get(key) != deadline:
                continue
            del self.dirty[key]
            self.late = max(self.late, now - deadline)
            r, c = key
            ys, xs = slice(r * cdg.TILE_H, (r + 1) * cdg.TILE_H), slice(c * cdg.TILE_W, (c + 1) * cdg.TILE_W)
            cur, want = self.cur[ys, xs], self.target[ys, xs]
            for op in cdg.tile_ops(cur, want):
                cdg.apply_op(cur, op)
                xor, c0, c1, bits = op
                self.pending.append(cdg.tile_packet(r, c, c0, c1, bits, xor))
            return True
        return False

    def scroll_up(self, pixels, color, now):
        """Move the whole screen up by `pixels` (a multiple of 12) with scroll packets.

        Every tile update that is still outstanding is queued first, so the scroll moves a
        finished picture. The packets that follow it only have to paint what the scroll
        revealed. `color` fills the vacated bottom edge (the background colour)."""
        if pixels <= 0 or pixels % cdg.TILE_H:
            raise ValueError("scroll distance must be a positive multiple of 12 pixels")
        while self._next_dirty(now):
            pass
        for i in range(pixels // cdg.TILE_H):
            if i:
                self.pending.extend([cdg.EMPTY] * SCROLL_STEP_GAP)
            self.pending.append(cdg.scroll_packet(color, v_cmd=2))
        for img in (self.cur, self.target):
            img[:-pixels] = img[pixels:].copy()
            img[-pixels:] = color

    def step(self, now):
        while not self.pending and self._next_dirty(now):
            pass
        self.out.append(self.pending.popleft() if self.pending else cdg.EMPTY)


def layout(song, cfg, fonts, slot_h):
    """Song lines -> display lines (wrapped), as LineImage objects."""
    font = fonts.get(fonts.size)
    max_w = VIS_W - 2 * SIDE_PAD - 2 * cfg.outline
    out = []
    for line in song.lines:
        for part in _balanced_wrap(line.words, font, max_w):
            out.append(LineImage(part, fonts, VIS_W, slot_h))
    return out


def _title_image(song, fonts, slot_h):
    img = np.full((VIS_H, VIS_W), BG, np.uint8)
    big = fonts.get(max(fonts.size + 4, 10))
    small = fonts.get(fonts.size)
    blocks = []
    max_w = VIS_W - 2 * SIDE_PAD - 2 * fonts.outline
    from .timing import Word  # local import to avoid cycles in type hints
    for text, font, color in ((song.title, big, TITLE), (song.artist, small, ARTIST)):
        if not text:
            continue
        for part in _wrap([Word(t, 0, 0) for t in text.split()], font, max_w):
            blocks.append((" ".join(w.text for w in part), font, color))
    if not blocks:
        return img
    rows = []
    for text, font, color in blocks:
        asc, desc = font.getmetrics()
        h = asc + desc + 2 * fonts.outline + 4
        m = _text_mask(text, font, VIS_W, h)
        rows.append((m, _dilate(m, fonts.outline) & ~m, color, h))
    total = sum(r[3] for r in rows)
    y = max(0, (VIS_H - total) // 2)
    for fill, outl, color, h in rows:
        if y + h > VIS_H:
            break
        region = img[y:y + h]
        region[outl] = OUTLINE
        region[fill] = color
        y += h
    return img


def render(song, duration, cfg=None, stats=None):
    """Return the CDG byte stream for `song` (timing.Song) lasting `duration` seconds.

    If `stats` is a dict it receives diagnostics: display lines, pages, font size and
    `late_s`, the worst delay of any screen update behind its deadline."""
    cfg = cfg or Config()
    n = cfg.lines_on_screen
    if not 1 <= n <= 8:
        raise ValueError("lines_on_screen must be 1..8")
    rows_per_slot = (cdg.ROWS - 2) // n
    slot_h = rows_per_slot * cdg.TILE_H
    top = VIS_Y0 + ((cdg.ROWS - 2) - rows_per_slot * n) // 2 * cdg.TILE_H
    fonts = Fonts(find_font(cfg.font_path), slot_h, cfg.outline, cfg.font_size)
    palette = [(0, 0, 0)] * 16
    for k, v in THEMES[cfg.theme].items():
        palette[k] = v
    lines = layout(song, cfg, fonts, slot_h)

    # Pages: break where the gap between lines is long.
    pages = []
    for li in lines:
        if pages and li.start - pages[-1][-1].end < cfg.page_gap:
            pages[-1].append(li)
        else:
            pages.append([li])

    events = []  # (time, order, kind, payload)
    order = 0

    def ev(t, kind, payload=None):
        nonlocal order
        order += 1
        events.append((max(0.0, t), order, kind, payload))

    prev_end = None
    first_show = max(0.0, pages[0][0].start - cfg.lead) if pages else 0.0
    if cfg.title_screen and (song.title or song.artist) and (not pages or first_show >= 2.0):
        ev(0.0, "title")
    for page in pages:
        show = page[0].start - cfg.lead
        if prev_end is not None:
            show = max(show, prev_end + 1.0)
        show = max(0.0, min(show, page[0].start - 0.5))
        ev(show, "clear")
        # Window 0 shows this page's first lines. Each later window starts once the
        # line scrolling off the top has finished, so the block moves up together.
        ev(show, "window", (page, 0))
        for s in range(len(page) - 1):
            ev(page[s].end + 0.2, "window", (page, s + 1))
        prev_end = page[-1].end
    events.sort(key=lambda e: (e[0], e[1]))

    enc = Encoder()
    enc.clear(BG)
    enc.pending.extendleft(reversed(cdg.load_colors(palette) + [cdg.border_preset(BG)]))

    total = int(math.ceil(max(duration, lines[-1].end + 2.0 if lines else 1.0) * cdg.PACKETS_PER_SECOND))
    shown = {}       # slot -> LineImage currently in that slot
    ei = 0
    for k in range(total):
        now = k / cdg.PACKETS_PER_SECOND
        while ei < len(events) and events[ei][0] <= now:
            _, _, kind, payload = events[ei]
            ei += 1
            if kind == "clear":
                enc.clear(BG)
                shown.clear()
            elif kind == "title":
                enc.paint(VIS_Y0, VIS_X0, _title_image(song, fonts, slot_h), first_show)
            elif kind == "window":
                page, start = payload
                if start == 0:
                    # first lines of the page, drawn ahead of the first sung word; each line
                    # is due before it is sung, so the first one is painted first
                    shown.clear()
                    for slot, li in enumerate(page[:n]):
                        shown[slot] = li
                        enc.paint(top + slot * slot_h, VIS_X0, li.image(now), max(0.0, li.start - 0.3))
                else:
                    # the top line is done: move the block up one slot and paint only the
                    # line that enters at the bottom (if the page has one left)
                    enc.scroll_up(slot_h, BG, now)
                    shown = {slot - 1: li for slot, li in shown.items() if slot >= 1}
                    incoming = start + n - 1
                    if incoming < len(page):
                        li = page[incoming]
                        shown[n - 1] = li
                        deadline = max(now + 0.05, li.start - 0.3)
                        enc.paint(top + (n - 1) * slot_h, VIS_X0, li.image(now), deadline)
        if k % cfg.wipe_step == 0:
            for slot, li in shown.items():
                if li.start - 0.05 <= now <= li.end + 0.1:
                    enc.paint(top + slot * slot_h, VIS_X0, li.image(now), now)
        enc.step(now)
    if stats is not None:
        stats.update(lines=len(lines), pages=len(pages), font_size=fonts.size,
                     font=fonts.path or "(Pillow default)", late_s=round(enc.late, 3))
    return b"".join(enc.out)
