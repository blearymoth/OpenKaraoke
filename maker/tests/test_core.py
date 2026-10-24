import numpy as np
import pytest

from autokaraoke import cdg, render
from autokaraoke.align import parse_lyrics, transfer_timing
from autokaraoke.timing import Line, Song, Word, clean, from_dict, to_dict, to_lrc


def _song(n_lines=6, gap_after=None, start=5.0):
    lines, t = [], start
    for i in range(n_lines):
        ws = []
        for w in f"line {i} has some words in it".split():
            ws.append(Word(w, t, t + 0.35))
            t += 0.45
        lines.append(Line(ws))
        t += 0.8
        if gap_after is not None and i == gap_after:
            t += 15
    return clean(Song("Test Song", "Test Artist", "en", t + 3, lines))


# ---------------------------------------------------------------- packets

def test_color_table_roundtrip():
    pal = [(i, 15 - i, (i * 7) % 16) for i in range(16)]
    screen, decoded = cdg.decode(b"".join(cdg.load_colors(pal)))
    assert decoded == pal


def test_tile_packet_layout():
    bits = np.zeros((12, 6), bool)
    bits[0, 0] = bits[11, 5] = True
    p = cdg.tile_packet(3, 7, 1, 2, bits)
    assert len(p) == 24 and p[0] == 0x09 and p[1] == cdg.TILE_NORMAL
    assert list(p[4:8]) == [1, 2, 3, 7]
    assert p[8] == 0b100000 and p[19] == 0b000001
    assert all(b & 0xC0 == 0 for b in p[4:20])


@pytest.mark.parametrize("seed", range(30))
def test_tile_ops_reach_target(seed):
    rng = np.random.default_rng(seed)
    ncol = rng.integers(1, 6)
    colors = rng.choice(16, size=ncol, replace=False)
    cur = rng.choice(colors, size=(12, 6)).astype(np.uint8)
    want = rng.choice(colors, size=(12, 6)).astype(np.uint8)
    tile = cur.copy()
    for op in cdg.tile_ops(cur, want):
        cdg.apply_op(tile, op)
    assert (tile == want).all()


def test_wipe_change_is_one_xor_packet():
    cur = np.zeros((12, 6), np.uint8)
    cur[2:10, 1:5] = render.UNSUNG
    cur[1, :] = render.OUTLINE
    want = cur.copy()
    want[2:10, 1:3] = render.SUNG
    ops = cdg.tile_ops(cur, want)
    assert len(ops) == 1 and ops[0][0] is True


# ---------------------------------------------------------------- rendering

def _decode_at(data, t):
    n = int(t * cdg.PACKETS_PER_SECOND) * cdg.PACKET_SIZE
    return cdg.decode(data[:n])[0]


def test_render_length_and_final_screen():
    song = _song()
    data = render.render(song, song.duration)
    assert len(data) % 24 == 0
    assert len(data) // 24 == int(np.ceil(song.duration * 300))
    end = cdg.decode(data)[0]
    # last line fully sung, no unsung text left on the final screen
    assert (end == render.SUNG).any()
    assert not (end == render.UNSUNG).any()


def test_lines_drawn_before_sung_and_wipe_progresses():
    song = _song()
    stats = {}
    data = render.render(song, song.duration, stats=stats)
    assert stats["late_s"] < 0.2
    first = song.lines[0]
    before = _decode_at(data, first.start - 0.2)
    assert (before == render.UNSUNG).sum() > 200 and not (before == render.SUNG).any()
    w = first.words
    mid = _decode_at(data, (w[1].start + w[1].end) / 2)
    after = _decode_at(data, w[2].end + 0.05)
    assert 0 < (mid == render.SUNG).sum() < (after == render.SUNG).sum()


def test_new_page_after_long_gap():
    song = _song(n_lines=6, gap_after=2)
    stats = {}
    data = render.render(song, song.duration, stats=stats)
    assert stats["pages"] == 2
    # in the middle of the gap the old page is still up, fully sung
    gap_t = song.lines[2].end + 5
    s = _decode_at(data, gap_t)
    assert (s == render.SUNG).any() and not (s == render.UNSUNG).any()
    # just before the second page starts, its lines are drawn unsung
    s = _decode_at(data, song.lines[3].start - 0.2)
    assert (s == render.UNSUNG).any() and not (s == render.SUNG).any()


def test_title_screen_and_long_line_wrap():
    words = [Word(w, 10 + i * 0.3, 10 + i * 0.3 + 0.25) for i, w in enumerate(
        "this is a very long line of lyrics that cannot possibly fit on one row".split())]
    song = clean(Song("Title", "Artist", "en", 20, [Line(words)]))
    stats = {}
    data = render.render(song, song.duration, stats=stats)
    assert stats["lines"] >= 2
    title = _decode_at(data, 2.0)
    assert (title == render.TITLE).any() and (title == render.ARTIST).any()


@pytest.mark.parametrize("n", [1, 3, 5, 6])
def test_other_line_counts(n):
    song = _song()
    cfg = render.Config(lines_on_screen=n)
    data = render.render(song, song.duration, cfg)
    assert (cdg.decode(data)[0] == render.SUNG).any()


# ---------------------------------------------------------------- timing / alignment

def test_parse_lyrics_skips_sections():
    text = "[Verse 1]\nHello there\n\n(oh) yeah\n{Chorus}\nBye"
    assert parse_lyrics(text) == [["Hello", "there"], ["(oh)", "yeah"], ["Bye"]]
    assert parse_lyrics(text, keep_sections=True)[0] == ["[Verse", "1]"]


def test_transfer_timing_handles_tokenisation_differences():
    lyrics = [["Don't", "stop", "me"], ["now—", "I'm", "having", "&", "fun"]]
    aligned = [(" Don", 1.0, 1.2), ("'t", 1.2, 1.3), (" stop", 1.4, 1.8), (" me", 1.9, 2.0),
               (" now", 3.0, 3.3), (" I'm", 3.4, 3.6), (" havin'", 3.7, 4.0), (" fun", 4.3, 4.6)]
    lines = transfer_timing(lyrics, aligned)
    w = [x for l in lines for x in l.words]
    assert [x.text for x in w] == ["Don't", "stop", "me", "now—", "I'm", "having", "&", "fun"]
    assert w[0].start == pytest.approx(1.0) and w[0].end == pytest.approx(1.3)
    assert w[5].start == pytest.approx(3.7)
    assert w[5].end <= w[6].start <= w[7].start   # '&' interpolated between neighbours
    assert all(a.start <= b.start for a, b in zip(w, w[1:]))


def test_transfer_timing_with_misheard_words():
    lyrics = [["hold", "me", "closer", "tiny", "dancer"]]
    aligned = [("hold", 0, 0.5), ("me", 0.5, 0.8), ("closer", 0.8, 1.5), ("Tony", 1.5, 2.0),
               ("Danza", 2.0, 2.8)]
    w = transfer_timing(lyrics, aligned)[0].words
    assert all(x.start is not None for x in w)
    assert w[-1].end <= 2.8 + 1e-6 and w[3].start >= 1.5 - 1e-6


def test_json_roundtrip_and_lrc():
    song = _song(2)
    again = from_dict(to_dict(song))
    assert [l.text for l in again.lines] == [l.text for l in song.lines]
    lrc = to_lrc(song)
    assert lrc.startswith("[ti:Test Song]") and "<00:05.00> line" in lrc


def test_clean_fixes_backwards_times():
    song = clean(Song(lines=[Line([Word("a", 5, 4), Word("b", 3, 3.5)])]))
    w = song.lines[0].words
    assert w[0].end >= w[0].start and w[1].start >= w[0].end - 0.05


def test_palette_survives_page_clear_at_time_zero():
    song = _song(2, start=1.0)   # first page is shown at t=0, same moment as the colour table
    data = render.render(song, song.duration)
    _, palette = cdg.decode(data)
    assert palette[render.SUNG] == render.THEMES["classic"][render.SUNG]


# ---------------------------------------------------------------- scrolling the block

def _spaced_song(n_lines=7, gap=2.5, start=5.0):
    """Lines separated by `gap` seconds of silence, so the screen is quiet between them."""
    lines, t = [], start
    for i in range(n_lines):
        ws = []
        for w in f"line {i} has some words".split():
            ws.append(Word(w, t, t + 0.35))
            t += 0.45
        lines.append(Line(ws))
        t += gap
    return clean(Song("Test Song", "Test Artist", "en", t + 3, lines))


def _packets(data):
    return [data[i:i + 24] for i in range(0, len(data), 24)]


def test_scroll_packet_moves_screen_up_and_fills_the_gap():
    bits = np.ones((12, 6), bool)
    base = [cdg.memory_preset(0), cdg.tile_packet(5, 10, 0, 7, bits)]
    up, _ = cdg.decode(b"".join(base + [cdg.scroll_packet(3, v_cmd=2)]))
    rows = np.nonzero((up == 7).any(axis=1))[0]
    assert (rows.min(), rows.max()) == (48, 59)           # was tile row 5 (y 60..71)
    assert (up[-12:] == 3).all()                           # vacated bottom edge takes the fill colour
    wrapped, _ = cdg.decode(b"".join(base + [cdg.scroll_packet(3, v_cmd=2, copy=True)] * 6))
    assert np.nonzero((wrapped == 7).any(axis=1))[0].min() == 204   # copy wraps round to the bottom


def test_encoder_sends_pending_tiles_before_it_scrolls():
    enc = render.Encoder()
    enc.clear(render.BG)
    img = np.full((48, 288), render.BG, np.uint8)
    img[10:30, 20:200] = render.UNSUNG
    enc.paint(12, 6, img, deadline=5.0)
    enc.scroll_up(48, render.BG, now=0.0)
    kinds = [p[1] & 0x3F for p in enc.pending]
    first_scroll = kinds.index(cdg.SCROLL_PRESET)
    assert kinds.count(cdg.SCROLL_PRESET) == 4             # 48 px = 4 steps of 12
    assert {cdg.TILE_NORMAL, cdg.TILE_XOR} & set(kinds[:first_scroll])   # the picture is complete before it moves
    assert not enc.heap and not enc.dirty                   # nothing left that refers to old positions
    assert (enc.cur == enc.target).all()                    # both models moved together
    assert not (enc.cur[12:60] == render.UNSUNG).any()      # the line scrolled out through the top


@pytest.mark.parametrize("n", [2, 3, 4])
def test_block_scroll_costs_a_few_packets_and_repaints_only_the_new_line(n):
    song = _spaced_song()
    cfg = render.Config(lines_on_screen=n)
    data = render.render(song, song.duration, cfg)
    pk = _packets(data)
    slot_h = ((cdg.ROWS - 2) // n) * cdg.TILE_H
    scrolls = [i for i, p in enumerate(pk) if p[1] & 0x3F == cdg.SCROLL_PRESET]
    assert len(scrolls) == (len(song.lines) - 1) * (slot_h // cdg.TILE_H)
    bottom_rows = range(1 + (n - 1) * (slot_h // cdg.TILE_H), 1 + n * (slot_h // cdg.TILE_H))
    for k in range(len(song.lines) - 1):
        first = scrolls[k * (slot_h // cdg.TILE_H)]
        # nothing is being sung for 2 s after a scroll, so any tile sent in the next 0.6 s
        # is the incoming line, which must sit in the bottom slot
        for p in pk[first + 4 * (slot_h // cdg.TILE_H): first + int(0.6 * 300)]:
            if p[1] & 0x3F in (cdg.TILE_NORMAL, cdg.TILE_XOR):
                assert (p[6] & 0x1F) in bottom_rows, "a scroll must not trigger a repaint of the other lines"


def test_screen_after_a_scroll_is_exactly_the_scrolled_page():
    n = 4
    song = _spaced_song()
    cfg = render.Config(lines_on_screen=n)
    data = render.render(song, song.duration, cfg)
    slot_h = ((cdg.ROWS - 2) // n) * cdg.TILE_H
    fonts = render.Fonts(render.find_font(cfg.font_path), slot_h, cfg.outline, cfg.font_size)
    display = render.layout(song, cfg, fonts, slot_h)
    assert len(display) == len(song.lines)                 # short lines: no wrapping
    for s in (0, 1, 2):                                    # after line s is sung the block moves up
        t = song.lines[s].end + 1.5                        # scroll at +0.2 s, new line painted by now
        screen, _ = cdg.decode(data[: int(t * 300) * 24])
        expected = np.full((n * slot_h, 288), render.BG, np.uint8)
        for slot in range(n):
            idx = s + 1 + slot
            if idx < len(display):
                expected[slot * slot_h:(slot + 1) * slot_h] = display[idx].image(t)
        assert (screen[12:12 + n * slot_h, 6:294] == expected).all(), f"after line {s}"


def test_no_scroll_when_a_page_ends_and_the_next_one_starts_clean():
    song = _spaced_song(n_lines=6, gap=2.5)
    for line in song.lines[3:]:                            # a long instrumental break after line 2
        for w in line.words:
            w.start += 20
            w.end += 20
    song.duration += 20
    data = render.render(song, song.duration)
    kinds = [p[1] & 0x3F for p in _packets(data)]
    assert kinds.count(cdg.SCROLL_PRESET) == 4 * (2 + 2)   # two scrolls on page one, two on page two
    t = song.lines[3].start - 0.3
    screen, _ = cdg.decode(data[: int(t * 300) * 24])
    assert (screen == render.UNSUNG).any() and not (screen == render.SUNG).any()
