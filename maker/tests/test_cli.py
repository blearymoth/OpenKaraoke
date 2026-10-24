"""CLI glue test with the ML stages replaced by fakes (no torch/models needed)."""

import json
import shutil
import subprocess

import numpy as np
import pytest

from autokaraoke import align, cdg, cli, separate
from autokaraoke.timing import Line, Word

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


@pytest.fixture
def song_mp3(tmp_path):
    path = tmp_path / "Some Artist - Some Song.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=12",
                    "-ac", "2", "-ar", "44100", str(path)], check=True)
    return path


@pytest.fixture
def fakes(monkeypatch):
    calls = {"separate": 0, "align": 0}

    def fake_separate(path, model, device, shifts, log, mdir=None):
        calls["separate"] += 1
        n = 44100 * 12
        t = np.arange(n) / 44100
        v = np.stack([0.1 * np.sin(2 * np.pi * 300 * t)] * 2).astype(np.float32)
        return v, v * 0.5, 44100

    def fake_align(model, vocals16k, lyric_lines, language, log):
        calls["align"] += 1
        assert vocals16k.ndim == 1 and len(vocals16k) > 16000 * 10
        out, t = [], 3.0
        for line in lyric_lines:
            ws = []
            for w in line:
                ws.append(Word(w, t, t + 0.3))
                t += 0.4
            out.append(Line(ws))
        return out

    monkeypatch.setattr(separate, "separate", fake_separate)
    monkeypatch.setattr(separate, "pick_device", lambda d="auto": "cpu")
    monkeypatch.setattr(align, "load_model", lambda name, device, log, mdir=None: object())
    monkeypatch.setattr(align, "align", fake_align)
    return calls


def test_make_and_rerender(tmp_path, song_mp3, fakes):
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text("[Chorus]\nHello hello world\nThis is a test\n", encoding="utf-8")
    out = tmp_path / "out"
    cli.main(["make", str(song_mp3), "--lyrics", str(lyrics), "--out", str(out)])
    base = out / "Some Artist - Some Song"
    mp3, cdg_file, timing = (base.with_suffix(x) for x in (".mp3", ".cdg", ".timing.json"))
    assert mp3.exists() and cdg_file.exists() and timing.exists()
    assert base.with_suffix(".lrc").exists()
    data = cdg_file.read_bytes()
    assert len(data) % 24 == 0 and abs(len(data) / 24 / 300 - 12) < 0.2
    j = json.loads(timing.read_text())
    assert j["title"] == "Some Song" and j["artist"] == "Some Artist"
    assert [len(l["words"]) for l in j["lines"]] == [3, 4]
    assert not (out / "Some Artist - Some Song.work").exists()   # stems cleaned up

    # hand-edit the timing, re-render only the CDG
    j["lines"][0]["words"][0]["text"] = "HELLO"
    timing.write_text(json.dumps(j))
    cli.main(["render", str(timing), "--theme", "blue", "--lines", "3"])
    assert cdg_file.read_bytes() != data
    screen, palette = cdg.decode(cdg_file.read_bytes())
    assert palette[2] == (2, 11, 15)

    # re-running make keeps the edited timing
    cli.main(["make", str(song_mp3), "--lyrics", str(lyrics), "--out", str(out)])
    assert fakes["align"] == 1 and fakes["separate"] == 2
    assert json.loads(timing.read_text())["lines"][0]["words"][0]["text"] == "HELLO"


def test_refuses_to_overwrite_input(tmp_path, fakes):
    src = tmp_path / "Some Song.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=d=2", str(src)], check=True)
    with pytest.raises(SystemExit):
        cli.main(["make", str(src)])
