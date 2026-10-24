"""Phonon-2 first, Whisper second (align.Timer, phonon.py): known lyrics timed from what Phonon-2
hears when it hears enough of them, else Whisper; Whisper for other languages and when Phonon-2
isn't installed or fails; transcription; the hotwords; `words` and `setup --check` on the command
line. Both models are stand-ins (no fermion-research, no Whisper, no network)."""

import json
import shutil
from types import SimpleNamespace

import numpy as np
import pytest

from autokaraoke import align, audio, cli, phonon, separate

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
LYRICS = [["Hello", "Quillon,", "my", "friend"], ["Thunder", "on", "the", "radio"]]


class FakePhonon:
    """Hears `said` (a list of (text, start, end)); remembers the hotwords it was given."""

    def __init__(self, said, fail=None):
        self.said, self.fail, self.calls = said, fail, []

    def transcribe_array_detailed(self, audio16k, hotwords=None):
        self.calls.append({"n": len(audio16k), "hotwords": list(hotwords or [])})
        if self.fail == "refuse":
            raise SystemExit("phonon-2 is unavailable: this CPU lacks SSE4.1")  # (fermion refuses this way)
        if self.fail:
            raise RuntimeError(self.fail)
        return SimpleNamespace(timed=True, words=[{"text": t, "start": s, "end": e} for t, s, e in self.said])


class FakeWhisper:
    def __init__(self):
        self.calls = []

    def align(self, v, text, language=None):
        self.calls.append(("align", text, language))
        words = text.split()
        return SimpleNamespace(all_words=lambda: [SimpleNamespace(word=w, start=10 + i, end=10.5 + i) for i, w in enumerate(words)])

    def transcribe(self, v, language=None, vad=False):
        self.calls.append(("transcribe", language))
        seg = SimpleNamespace(words=[SimpleNamespace(word=" whisper", start=1.0, end=1.4), SimpleNamespace(word=" heard", start=1.5, end=2.0)])
        return SimpleNamespace(segments=[seg], language=language or "en", split_by_gap=lambda g: SimpleNamespace(
            split_by_length=lambda max_chars: SimpleNamespace(segments=[seg], language=language or "en")))


@pytest.fixture
def models(monkeypatch, tmp_path):
    state = {"phonon": FakePhonon([]), "whisper": FakeWhisper(), "installed": True, "loads": []}
    monkeypatch.setattr(phonon, "available", lambda: state["installed"])
    monkeypatch.setattr(phonon, "cached", lambda mdir: state["installed"])
    monkeypatch.setattr(phonon, "load", lambda mdir, log=print: state["loads"].append("phonon") or state["phonon"])

    def load_whisper(name, device, log=print, mdir=None):
        state["loads"].append(f"whisper {name}")
        return state["whisper"]
    monkeypatch.setattr(align, "load_model", load_whisper)
    monkeypatch.setattr(separate, "pick_device", lambda d="auto": "cpu")
    state["mdir"] = tmp_path / "m"
    return state


def timer(state, choice="phonon", log=None):
    return align.load_timer(choice, "medium", "cpu", log or (lambda m: None), mdir=state["mdir"])


HEARD = [("hello", 1.0, 1.4), ("quill", 1.5, 1.8), ("on", 1.8, 2.0), ("my", 2.1, 2.3), ("friend", 2.4, 3.0),
         ("thunder", 4.0, 4.5), ("on", 4.6, 4.8), ("the", 4.9, 5.0), ("radio", 5.1, 5.9)]


def test_phonon_times_the_lyrics_when_it_hears_them(models):
    models["phonon"] = FakePhonon(HEARD)
    said = []
    t = timer(models, log=said.append)
    lines = align.align(t, np.zeros(16000 * 8, np.float32), LYRICS, "en")
    got = [(w.text, w.start, w.end) for l in lines for w in l.words]
    assert got[0] == ("Hello", 1.0, 1.4)
    assert got[1][0] == "Quillon," and got[1][1] == 1.5 and abs(got[1][2] - 2.0) < 1e-9, "one lyric word over two heard ones"
    assert got[-1] == ("radio", 5.1, 5.9)
    assert t.used == {"phonon"} and models["loads"] == ["phonon"], "Whisper never loaded"
    assert models["phonon"].calls[0]["hotwords"][:2] == ["Quillon", "Thunder"], "the lyrics' rarer words, favoured"
    assert any("Phonon-2 heard 100% of the lyrics" in m for m in said)


def test_whisper_when_phonon_hears_too_little_or_fails(models):
    models["phonon"] = FakePhonon([("something", 1.0, 2.0), ("else", 2.0, 3.0)])
    said = []
    t = timer(models, log=said.append)
    lines = align.align(t, np.zeros(16000 * 8, np.float32), LYRICS, "en")
    assert lines[0].words[0].start == 10, "Whisper's times"
    assert t.used == {"whisper"} and models["whisper"].calls[0][0] == "align"
    assert any(m.startswith("Under 60%") for m in said)
    models["phonon"] = FakePhonon([], fail="out of memory")
    t = timer(models, log=said.append)
    align.align(t, np.zeros(16000, np.float32), LYRICS, "en")
    assert t.used == {"whisper"} and any("could not time them (out of memory)" in m for m in said)
    models["phonon"] = FakePhonon([], fail="refuse")
    t = timer(models, log=said.append)
    align.align(t, np.zeros(16000, np.float32), LYRICS, "en")
    assert t.used == {"whisper"}, "a refusal (SystemExit) falls back too"


def test_whisper_for_other_languages_when_not_installed_or_chosen(models):
    models["phonon"] = FakePhonon(HEARD)
    t = timer(models)
    align.align(t, np.zeros(16000, np.float32), LYRICS, "fi")
    assert t.used == {"whisper"} and models["whisper"].calls[-1] == ("align", "Hello Quillon, my friend\nThunder on the radio", "fi")
    t = timer(models, choice="whisper")
    align.align(t, np.zeros(16000, np.float32), LYRICS, "en")
    assert t.used == {"whisper"} and models["phonon"].calls == []
    models["installed"] = False
    said = []
    t = timer(models, log=said.append)
    align.align(t, np.zeros(16000, np.float32), LYRICS, "en")
    assert t.used == {"whisper"} and "Phonon-2 is not installed here: Whisper times this song." in said


def test_transcription_phonon_first(models):
    models["phonon"] = FakePhonon([("one", 0.0, 0.3), ("two", 0.4, 0.6), ("three", 2.0, 2.4)])
    t = timer(models)
    lines, language = align.transcribe(t, np.zeros(16000, np.float32), None)
    assert [[w.text for w in l.words] for l in lines] == [["one", "two"], ["three"]], "a new line after a pause"
    assert language == "en" and t.used == {"phonon"}
    models["phonon"] = FakePhonon([])
    t = timer(models)
    lines, _ = align.transcribe(t, np.zeros(16000, np.float32), None)
    assert [w.text for w in lines[0].words] == ["whisper", "heard"] and t.used == {"whisper"}


def test_hotwords_and_lines():
    lyric = [["the", "Quillon", "quillon", "Ada!", "and", "love"], ["Zebra-crossing", "you", "Ada"]]
    assert phonon.hotwords(lyric) == ["Zebra-crossing", "Quillon", "love"], "once each, longest first, no little words"
    many = [[f"Word{i:02d}" for i in range(40)]]
    assert len(phonon.hotwords(many)) == 25
    long = [(f"w{i}", i * 0.2, i * 0.2 + 0.1) for i in range(30)]
    assert all(sum(len(w.text) + 1 for w in l.words) - 1 <= phonon.MAX_CHARS for l in phonon.lines_of(long))


@needs_ffmpeg
def test_words_command_says_which_timer(tmp_path, models, capsys):
    models["phonon"] = FakePhonon(HEARD)
    vocal = tmp_path / "vocal.wav"
    audio.save_wav(vocal, np.zeros((1, 16000 * 8), np.float32), 16000)
    lyrics = tmp_path / "l.txt"
    lyrics.write_text("\n".join(" ".join(l) for l in LYRICS))
    out = tmp_path / "w.json"
    cli.main(["words", "--vocals", str(vocal), "-O", str(out), "--lyrics", str(lyrics), "--models-dir", str(tmp_path / "m")])
    assert "Lyric timer: Phonon-2" in capsys.readouterr().err
    assert json.loads(out.read_text())["lines"][1]["words"][3]["start"] == 5.1
    cli.main(["words", "--vocals", str(vocal), "-O", str(out), "--lyrics", str(lyrics), "--lyric-timer", "whisper",
              "--models-dir", str(tmp_path / "m")])
    assert "Lyric timer: Whisper" in capsys.readouterr().err


def test_setup_check_lists_phonon(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(phonon, "available", lambda: True)
    monkeypatch.setattr(phonon, "folder", lambda mdir: None)
    with pytest.raises(SystemExit):  # (Demucs and Whisper are missing here)
        cli.main(["setup", "--check", "--models-dir", str(tmp_path)])
    row = [l for l in capsys.readouterr().out.splitlines() if "Phonon" in l]
    assert len(row) == 1 and row[0].startswith("  Phonon  phonon-2") and row[0].endswith("MISSING")
    monkeypatch.setattr(phonon, "available", lambda: False)
    with pytest.raises(SystemExit):
        cli.main(["setup", "--check", "--models-dir", str(tmp_path)])
    assert "Phonon" not in capsys.readouterr().out, "no fermion-research: Whisper only, nothing to list"
