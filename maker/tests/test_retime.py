"""`retime` (a stretch re-timed with Whisper, mocked here), the timing.json "render" field, and
make's "Times:" line. No models, no network; the CLI parts need ffmpeg."""

import json
import shutil
import subprocess

import numpy as np
import pytest

from autokaraoke import align, audio, cdg, cli, separate
from autokaraoke.timing import Line, Song, Word, from_dict, load_json, save_json, to_dict

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


def song3():
    words = [
        [("one", 1.0, 1.4), ("two", 1.5, 1.9)],
        [("three", 5.0, 5.4), ("four", 5.5, 5.9), ("five", 6.0, 6.4)],
        [("six", 10.0, 10.4)],
    ]
    return Song("T", "A", "en", 12.0, [Line([Word(*w) for w in line]) for line in words])


def evenly(t0, step=0.3):
    """A fake aligner: words one after another from t0 s into the slice."""
    calls = []

    def fn(slice16k, lyric_lines):
        calls.append((len(slice16k), [list(l) for l in lyric_lines]))
        t, out = t0, []
        for line in lyric_lines:
            ws = []
            for w in line:
                ws.append(Word(w, t, t + step - 0.05))
                t += step
            out.append(Line(ws))
        return out
    fn.calls = calls
    return fn


def times(song):
    return [(w.text, round(w.start, 3), round(w.end, 3)) for l in song.lines for w in l.words]


def test_only_the_stretch_moves_and_the_offset_is_added_back():
    song, before = song3(), times(song3())
    fn = evenly(0.5)
    n = align.retime_stretch(song, np.zeros(16000 * 12, np.float32), 4.0, 8.0, fn)
    assert n == 3
    assert fn.calls == [(16000 * 4, [["three", "four", "five"]])], "only that slice, only those words"
    after = times(song)
    assert after[:2] == before[:2] and after[-1] == before[-1], "every other word is untouched"
    assert after[2:5] == [("three", 4.5, 4.75), ("four", 4.8, 5.05), ("five", 5.1, 5.35)]


def test_new_times_never_cross_the_untouched_neighbours():
    song = song3()
    # The aligner claims the words run from before the stretch to past the next word.
    def wild(slice16k, lyric_lines):
        assert lyric_lines == [["two"], ["three", "four", "five"]]
        return [Line([Word("two", -3.0, -2.0)]),
                Line([Word("three", 0.1, 0.4), Word("four", 0.2, 0.3), Word("five", 7.0, 9.0)])]
    align.retime_stretch(song, np.zeros(16000 * 12, np.float32), 1.45, 9.0, wild)
    t = times(song)
    # "two" starts in the stretch too (1.5 >= 1.45), so the picked words are two..five.
    assert t[0] == ("one", 1.0, 1.4) and t[-1] == ("six", 10.0, 10.4)
    starts = [x[1] for x in t]
    ends = [x[2] for x in t]
    assert starts == sorted(starts)
    assert all(e <= s for e, s in zip(ends[:-1], starts[1:])), "no overlap anywhere"
    assert t[1][1] >= 1.45 and t[4][2] <= 9.0, "kept inside the stretch"


def test_a_stretch_with_no_words_or_backwards_is_refused():
    song = song3()
    with pytest.raises(ValueError, match="no words"):
        align.retime_stretch(song, np.zeros(16000 * 12, np.float32), 2.0, 4.0, evenly(0))
    with pytest.raises(ValueError, match="bad stretch"):
        align.retime_stretch(song, np.zeros(16000 * 12, np.float32), 8.0, 4.0, evenly(0))
    with pytest.raises(ValueError, match="less than 0.2"):
        align.retime_stretch(song, np.zeros(16000 * 2, np.float32), 4.0, 8.0, evenly(0))
    assert times(song) == times(song3())


@pytest.fixture
def whisper_mock(monkeypatch):
    seen = {}

    def fake_align(model, vocals16k, lyric_lines, language, log):
        seen["len"], seen["language"] = len(vocals16k), language
        return evenly(0.25)(vocals16k, lyric_lines)
    monkeypatch.setattr(separate, "pick_device", lambda d="auto": "cpu")
    monkeypatch.setattr(align, "load_model", lambda name, device, log, mdir=None: object())
    monkeypatch.setattr(align, "align", fake_align)
    monkeypatch.setenv("AUTOKARAOKE_MODELS", "/nonexistent-models")
    return seen


@needs_ffmpeg
def test_retime_command(tmp_path, whisper_mock, capsys):
    vocal = tmp_path / "vocals.wav"
    audio.save_wav(vocal, 0.1 * np.sin(np.linspace(0, 2000, 16000 * 12))[None, :], 16000)
    timing = tmp_path / "Song.timing.json"
    song = song3()
    song.render = {"theme": "blue"}
    save_json(song, timing)
    original = timing.read_text()
    out = tmp_path / "out.json"
    cli.main(["retime", str(timing), "--vocals", str(vocal), "--from", "4", "--to", "8",
              "--language", "fi", "-O", str(out)])
    assert capsys.readouterr().out.strip() == "Retimed 3 words (4–8 s)"
    assert timing.read_text() == original, "-O leaves the input alone"
    assert whisper_mock == {"len": 16000 * 4, "language": "fi"}
    j = json.loads(out.read_text())
    assert j["version"] == 1 and j["render"] == {"theme": "blue"}, "the rest of the file is kept"
    got = [(w["text"], w["start"]) for l in j["lines"] for w in l["words"]]
    assert got == [("one", 1.0), ("two", 1.5), ("three", 4.25), ("four", 4.55), ("five", 4.85), ("six", 10.0)]
    # In place, the song's own language when none is given.
    cli.main(["retime", str(timing), "--vocals", str(vocal), "--from", "9", "--to", "11"])
    assert "Retimed 1 words (9–11 s)" in capsys.readouterr().out
    assert whisper_mock["language"] == "en"
    assert load_json(timing).lines[-1].words[0].start == 9.25


@needs_ffmpeg
def test_retime_failures_say_error_and_exit_non_zero(tmp_path, whisper_mock, capsys):
    timing = tmp_path / "Song.timing.json"
    save_json(song3(), timing)
    for argv in (["--vocals", str(tmp_path / "missing.wav"), "--from", "4", "--to", "8"],
                 ["--vocals", str(timing), "--from", "4", "--to", "8"]):  # not audio
        with pytest.raises(SystemExit) as e:
            cli.main(["retime", str(timing), *argv])
        assert e.value.code == 1
        assert "error" in capsys.readouterr().err
    vocal = tmp_path / "vocals.wav"
    audio.save_wav(vocal, np.zeros((1, 16000 * 12), np.float32), 16000)
    with pytest.raises(SystemExit) as e:
        cli.main(["retime", str(timing), "--vocals", str(vocal), "--from", "2", "--to", "3"])
    assert e.value.code == 1 and "error: no words start" in capsys.readouterr().err


def test_render_field_round_trip_and_older_files():
    d = to_dict(song3())
    assert d["version"] == 1 and "render" not in d, "no field until something sets it"
    d["render"] = {"theme": "green", "lines_on_screen": 3, "lead": 2, "page_gap": "x",
                   "font_size": True, "colour": "red"}
    d["unknown"] = {"anything": 1}
    song = from_dict(d)
    assert song.render == {"theme": "green", "lines_on_screen": 3, "lead": 2.0}, "only known, well-typed options"
    assert to_dict(song)["render"] == song.render and "unknown" not in to_dict(song)


@pytest.fixture
def song_mp3(tmp_path):
    path = tmp_path / "Some Artist - Some Song.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=12",
                    "-ac", "2", "-ar", "44100", str(path)], check=True)
    return path


@pytest.fixture
def make_mocks(monkeypatch, whisper_mock):
    def fake_separate(path, model, device, shifts, log, mdir=None):
        v = np.stack([0.1 * np.sin(np.arange(44100 * 12) / 20)] * 2).astype(np.float32)
        return v, v * 0.5, 44100
    monkeypatch.setattr(separate, "separate", fake_separate)


@needs_ffmpeg
def test_make_and_render_keep_the_render_options(tmp_path, song_mp3, make_mocks, capsys):
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text("Hello hello world\nThis is a test\n", encoding="utf-8")
    out = tmp_path / "out"
    cli.main(["make", str(song_mp3), "--lyrics", str(lyrics), "--out", str(out), "--theme", "green",
              "--lines", "3", "--keep-stems"])
    err = capsys.readouterr().err.splitlines()
    timing = out / "Some Artist - Some Song.timing.json"
    cdg_file = out / "Some Artist - Some Song.cdg"
    j = json.loads(timing.read_text())
    assert j["version"] == 1
    assert j["render"] == {"theme": "green", "lines_on_screen": 3, "font_size": 0, "outline": 2,
                           "lead": 4.0, "page_gap": 8.0}
    # The Times line: every stage, just before Done.
    i = next(k for k, l in enumerate(err) if l.startswith("Times: "))
    assert err[i + 1].startswith("Done: ")
    assert [p.split()[0] for p in err[i][7:].split(", ")] == ["separate", "mp3", "timing", "cdg"]
    assert all(p.split()[1].endswith("s") for p in err[i][7:].split(", "))

    # render with no flags uses the stored options; a flag wins and is stored.
    cli.main(["render", str(timing)])
    assert cdg.decode(cdg_file.read_bytes())[1][2] == (5, 15, 6), "green, from the file"
    cli.main(["render", str(timing), "--theme", "blue"])
    assert cdg.decode(cdg_file.read_bytes())[1][2] == (2, 11, 15)
    assert json.loads(timing.read_text())["render"]["theme"] == "blue"
    assert json.loads(timing.read_text())["render"]["lines_on_screen"] == 3

    # An older file (no "render") gets today's defaults.
    j = json.loads(timing.read_text())
    del j["render"]
    timing.write_text(json.dumps(j))
    cli.main(["render", str(timing)])
    screen, palette = cdg.decode(cdg_file.read_bytes())
    assert palette[0] == (0, 0, 3) and palette[1] == (15, 15, 15) and palette[2] == (15, 11, 0), \
        "classic: background, unsung, sung in entries 0, 1, 2"

    # Re-running make with the kept stems and timing: those stages are cached.
    capsys.readouterr()
    cli.main(["make", str(song_mp3), "--lyrics", str(lyrics), "--out", str(out), "--keep-stems"])
    line = next(l for l in capsys.readouterr().err.splitlines() if l.startswith("Times: "))
    assert "separate cached" in line and "timing cached" in line and "cdg " in line
    assert (out / "Some Artist - Some Song.work" / "vocals.wav").exists()
    assert (out / "Some Artist - Some Song.work" / "instrumental.wav").exists()
