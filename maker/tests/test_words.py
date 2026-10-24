"""`words`: a timing.json for a disc that has a vocal (OpenKaraoke's real words for any disc):
pasted lyrics timed against the vocal, looked-up ones, or what Whisper hears; no CDG drawn;
failures are one "error" line. Whisper is mocked; the CLI parts need ffmpeg."""

import json
import shutil

import numpy as np
import pytest

from autokaraoke import audio, cli

from test_lookup import LYRICS, fakes, service  # noqa: F401 - pytest fixtures

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


@pytest.fixture
def vocal(tmp_path):
    path = tmp_path / "vocal.wav"
    audio.save_wav(path, 0.1 * np.sin(np.linspace(0, 3000, 16000 * 12))[None, :], 16000)
    return path


def words_of(path):
    j = json.loads(path.read_text())
    return j, [w["text"] for l in j["lines"] for w in l["words"]]


@needs_ffmpeg
def test_pasted_lyrics_are_timed_against_the_vocal(tmp_path, vocal, fakes, capsys):
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text(LYRICS + "\n")
    out = tmp_path / "data" / "words.timing.json"
    cli.main(["words", "--vocals", str(vocal), "-O", str(out), "--lyrics", str(lyrics),
              "--title", "Some Song", "--artist", "Some Artist", "--duration", "200", "--language", "fi"])
    assert capsys.readouterr().out.strip().endswith("Words: 3 lines, 10 words")
    j, words = words_of(out)
    assert j["version"] == 1 and j["title"] == "Some Song" and j["artist"] == "Some Artist"
    assert j["duration"] == 200 and j["language"] == "fi"
    assert words[:3] == ["Hello", "hello", "world"] and fakes["transcribe"] == 0
    assert "render" not in j, "no CDG is drawn: nothing to remember about one"
    assert sorted(p.name for p in out.parent.iterdir()) == ["words.timing.json"]


@needs_ffmpeg
def test_looked_up_then_heard(tmp_path, vocal, fakes, service, capsys):
    service.routes["/api/get"] = {"plainLyrics": LYRICS}
    out = tmp_path / "words.timing.json"
    cli.main(["words", "--vocals", str(vocal), "-O", str(out), "--lyrics-sources", "lrclib",
              "--title", "Some Song", "--artist", "Some Artist", "--models-dir", str(tmp_path / "m")])
    err = capsys.readouterr().err
    assert "Looking for lyrics: lrclib" in err and "used the lyrics from LRCLIB" in err
    _, words = words_of(out)
    assert "world" in words and "wurld" not in words, "the lyrics win over the mishearing"
    assert (tmp_path / "words.lyrics.txt").read_text().splitlines() == LYRICS.splitlines()
    assert json.loads(out.read_text())["duration"] == 12, "the vocal's length by default"
    # Nothing found anywhere: what Whisper hears.
    service.routes.clear()
    cli.main(["words", "--vocals", str(vocal), "-O", str(out), "--lyrics-sources", "lrclib",
              "--title", "Nothing Like It", "--models-dir", str(tmp_path / "m")])
    assert "no lyrics found; transcribing instead." in capsys.readouterr().err
    assert "wurld" in words_of(out)[1]


@needs_ffmpeg
def test_failures_say_error_and_exit_non_zero(tmp_path, vocal, fakes, capsys):
    out = tmp_path / "w.json"
    empty = tmp_path / "empty.txt"
    empty.write_text("[Chorus]\n\n")
    for argv in (["--vocals", str(tmp_path / "missing.wav")],
                 ["--vocals", str(empty)],  # not audio
                 ["--vocals", str(vocal), "--lyrics", str(empty)]):
        with pytest.raises(SystemExit) as e:
            cli.main(["words", "-O", str(out), *argv])
        assert e.value.code == 1
        assert "error" in capsys.readouterr().err
    fakes["heard"] = []
    with pytest.raises(SystemExit) as e:
        cli.main(["words", "--vocals", str(vocal), "-O", str(out)])
    assert e.value.code == 1 and "error: no words were found" in capsys.readouterr().err
    assert not out.exists()
