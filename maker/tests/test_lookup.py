"""Online lyrics lookup: the LRCLIB client (against a local fake server), the
transcript-vs-lyrics comparison, and `make --lookup-lyrics` with the ML stages faked."""

import http.server
import json
import shutil
import subprocess
import threading
import urllib.parse

import numpy as np
import pytest

from autokaraoke import align, cli, lyrics_lookup, separate
from autokaraoke.timing import Line, Word

LYRICS = "Hello hello world\nThis is a test\nSing it again"


class Fake(http.server.BaseHTTPRequestHandler):
    hits = []
    routes = {}

    def do_GET(self):
        Fake.hits.append(self.path)
        u = urllib.parse.urlparse(self.path)
        body = Fake.routes.get(urllib.parse.unquote(u.path))
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture
def service(monkeypatch):
    Fake.hits, Fake.routes = [], {}
    srv = http.server.HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    for var in ("LRCLIB", "NETEASE", "LYRICSOVH"):
        monkeypatch.setenv(f"AUTOKARAOKE_{var}", f"http://127.0.0.1:{srv.server_port}")
    yield Fake
    srv.shutdown()


def _find(sources, **kw):
    return lyrics_lookup.find(kw.pop("artist", "A"), kw.pop("title", "T"), kw.pop("duration", 200.4),
                              sources, kw.pop("mdir", None), log=lambda m: None, **kw)


def test_lrclib_exact_match_and_cache(service, tmp_path):
    service.routes["/api/get"] = {"plainLyrics": LYRICS, "artistName": "A", "trackName": "T"}
    found = _find(["lrclib"], mdir=tmp_path)
    assert found[0]["text"] == LYRICS and found[0]["source"] == "lrclib"
    assert "duration=200" in service.hits[0] and "artist_name=A" in service.hits[0]
    n = len(service.hits)
    assert _find(["lrclib"], mdir=tmp_path)[0]["text"] == LYRICS
    assert len(service.hits) == n          # second time comes from the cache, no network


def test_lrclib_search_picks_the_closest_length_and_strips_timestamps(service):
    service.routes["/api/search"] = [
        {"plainLyrics": "wrong live version", "duration": 300},
        {"syncedLyrics": "[00:01.00] Hello there\n[00:03.50]<00:03.60> General", "duration": 201},
        {"instrumental": True, "duration": 200},
    ]
    assert _find(["lrclib"], artist="")[0]["text"] == "Hello there\nGeneral"


def test_netease_picks_the_right_song_and_drops_credits(service):
    service.routes["/api/search/get"] = {"result": {"songs": [
        {"id": 1, "name": "T (Live)", "duration": 300000, "artists": [{"name": "A"}]},
        {"id": 2, "name": "T", "duration": 201000, "artists": [{"name": "A"}]},
        {"id": 3, "name": "Other", "duration": 200000, "artists": [{"name": "A"}]}]}}
    service.routes["/api/song/lyric"] = {"lrc": {"lyric": "[00:00.00] 作词 : Someone\n"
                                                          "[00:01.00]Hello there\n[00:02.00]General"}}
    found = _find(["netease"])
    assert found[0]["text"] == "Hello there\nGeneral" and found[0]["artist"] == "A"
    assert "id=2" in service.hits[-1]


def test_lyricsovh(service):
    service.routes["/v1/A/T"] = {"lyrics": "Hello there\r\nGeneral"}
    assert _find(["lyricsovh"])[0]["text"] == "Hello there\nGeneral"


def test_sidecar_is_offline_and_reads_txt_or_lrc(service, tmp_path):
    song = tmp_path / "A - T.mp3"
    song.write_bytes(b"x")
    assert _find(["sidecar"], path=song) == []
    (tmp_path / "A - T.lrc").write_text("[00:01.00]Hello there\n[00:02.00]General\n")
    assert _find(["sidecar"], path=song)[0]["text"] == "Hello there\nGeneral"
    (tmp_path / "A - T.txt").write_text("My own\nwords\n")        # .txt wins over .lrc
    assert _find(["sidecar"], path=song)[0]["text"] == "My own\nwords"
    assert service.hits == []


def test_sources_come_back_in_the_given_order_and_missing_ones_are_skipped(service):
    service.routes["/v1/A/T"] = {"lyrics": "from ovh"}
    service.routes["/api/get"] = {"plainLyrics": "from lrclib"}
    assert [h["source"] for h in _find(["lyricsovh", "netease", "lrclib"])] == ["lyricsovh", "lrclib"]


def test_nothing_found_and_unreachable_do_not_raise(service, monkeypatch):
    assert _find(["lrclib", "netease"]) == []
    monkeypatch.setenv("AUTOKARAOKE_LRCLIB", "http://127.0.0.1:9")
    messages = []
    assert lyrics_lookup.find("A", "Other", 200, ["lrclib"], log=messages.append) == []
    assert any("cannot reach" in m for m in messages)


def test_parse_sources():
    assert lyrics_lookup.parse_sources("lrclib, NetEase,lrclib") == ["lrclib", "netease"]
    with pytest.raises(ValueError):
        lyrics_lookup.parse_sources("lrclib,nope")


def _heard(*lines):
    return [Line([Word(w, i, i + 0.2) for i, w in enumerate(l.split())]) for l in lines]


def test_compare_scores_what_was_heard():
    lyr = align.parse_lyrics(LYRICS)
    overall, per = align.compare(lyr, _heard("hello hello world", "this is a test", "sing it again"))
    assert overall == 1.0 and per == [1.0, 1.0, 1.0]
    overall, per = align.compare(lyr, _heard("hello hello world", "sing it again"))
    assert per[0] == 1.0 and per[1] < 0.5 and per[2] == 1.0 and 0.5 < overall < 1.0
    assert align.compare(lyr, _heard("something else entirely"))[0] < 0.35


@pytest.fixture
def fakes(monkeypatch):
    calls = {"align": [], "transcribe": 0}

    def fake_align(model, v, lyric_lines, language, log=print):
        calls["align"].append(lyric_lines)
        t, out = 3.0, []
        for line in lyric_lines:
            ws = []
            for w in line:
                ws.append(Word(w, t, t + 0.3))
                t += 0.4
            out.append(Line(ws))
        return out

    def fake_transcribe(model, v, language=None, log=print):
        calls["transcribe"] += 1
        return _heard(*calls.get("heard", ["hello hello wurld", "this is a test", "sing it again"])), "en"

    def fake_separate(path, model, device, shifts, log, mdir=None):
        n = 44100 * 12
        v = np.stack([0.1 * np.sin(2 * np.pi * 300 * np.arange(n) / 44100)] * 2).astype(np.float32)
        return v, v * 0.5, 44100

    monkeypatch.setattr(separate, "separate", fake_separate)
    monkeypatch.setattr(separate, "pick_device", lambda d="auto": "cpu")
    monkeypatch.setattr(align, "load_model", lambda name, device, log, mdir=None: object())
    monkeypatch.setattr(align, "align", fake_align)
    monkeypatch.setattr(align, "transcribe", fake_transcribe)
    return calls


@pytest.fixture
def song_mp3(tmp_path):
    path = tmp_path / "Some Artist - Some Song.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=12",
                    "-ac", "2", "-ar", "44100", str(path)], check=True)
    return path


needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


def _make(tmp_path, song_mp3, *extra):
    out = tmp_path / "out"
    cli.main(["make", str(song_mp3), "--out", str(out), "--models-dir", str(tmp_path / "m"), *extra])
    return out, json.loads((out / "Some Artist - Some Song.timing.json").read_text())


def test_first_candidate_that_fits_wins(fakes):
    other = align.parse_lyrics("totally different song\nwith other words")
    mine = align.parse_lyrics(LYRICS)
    lines, lang, used, overall = align.lookup_and_align(
        object(), None, [("lyricsovh", other), ("netease", mine)], None, 0.35, lambda m: None)
    assert used == "netease" and overall > 0.8
    assert [w.text for l in lines for w in l.words][:3] == ["Hello", "hello", "world"]
    lines, lang, used, _ = align.lookup_and_align(object(), None, [("lyricsovh", other)], None, 0.35,
                                                  lambda m: None)
    assert used is None


@needs_ffmpeg
def test_lookup_text_is_the_authority(service, fakes, tmp_path, song_mp3):
    service.routes["/api/get"] = {"plainLyrics": LYRICS}
    out, j = _make(tmp_path, song_mp3, "--lookup-lyrics")
    words = [w["text"] for l in j["lines"] for w in l["words"]]
    assert "world" in words and "wurld" not in words      # lyrics win over the mishearing
    assert (out / "Some Artist - Some Song.lyrics.txt").read_text().splitlines() == LYRICS.splitlines()
    assert fakes["transcribe"] == 1 and len(fakes["align"]) == 1


@needs_ffmpeg
def test_no_lookup_unless_asked(service, fakes, tmp_path, song_mp3):
    service.routes["/api/get"] = {"plainLyrics": LYRICS}
    _, j = _make(tmp_path, song_mp3)
    assert service.hits == [] and fakes["align"] == []
    assert "wurld" in [w["text"] for l in j["lines"] for w in l["words"]]


@needs_ffmpeg
def test_wrong_version_is_ignored(service, fakes, tmp_path, song_mp3):
    service.routes["/api/get"] = {"plainLyrics": "completely different song\nwith other words"}
    out, j = _make(tmp_path, song_mp3, "--lookup-lyrics")
    assert fakes["align"] == []                           # kept the transcript
    assert "wurld" in [w["text"] for l in j["lines"] for w in l["words"]]
    assert not (out / "Some Artist - Some Song.lyrics.txt").exists()


@needs_ffmpeg
def test_sources_option_picks_and_orders_sources(service, fakes, tmp_path, song_mp3):
    service.routes["/v1/Some Artist/Some Song"] = {"lyrics": "bad words here\nnot the song"}
    service.routes["/api/get"] = {"plainLyrics": LYRICS}
    out, j = _make(tmp_path, song_mp3, "--lyrics-sources", "lyricsovh,lrclib")
    assert "world" in [w["text"] for l in j["lines"] for w in l["words"]]
    assert (out / "Some Artist - Some Song.lyrics.txt").read_text().splitlines() == LYRICS.splitlines()
    with pytest.raises(SystemExit):
        _make(tmp_path, song_mp3, "--lyrics-sources", "nope", "--force")


def test_lyrics_command_lists_each_source(service, tmp_path, capsys):
    service.routes["/api/get"] = {"plainLyrics": LYRICS, "artistName": "A", "trackName": "T"}
    cli.main(["lyrics", "A", "T", "--duration", "200", "--sources", "lrclib,netease",
              "--models-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert "LRCLIB" in out and "3 lines" in out and "NetEase" in out and "nothing found" in out


@needs_ffmpeg
def test_unreachable_service_falls_back_to_transcribing(fakes, tmp_path, song_mp3, monkeypatch):
    monkeypatch.setenv("AUTOKARAOKE_LRCLIB", "http://127.0.0.1:9")
    _, j = _make(tmp_path, song_mp3, "--lookup-lyrics")
    assert "wurld" in [w["text"] for l in j["lines"] for w in l["words"]]


@needs_ffmpeg
def test_pasted_lyrics_beat_the_lookup(service, fakes, tmp_path, song_mp3):
    service.routes["/api/get"] = {"plainLyrics": LYRICS}
    mine = tmp_path / "mine.txt"
    mine.write_text("My own words\nHere\n")
    _make(tmp_path, song_mp3, "--lookup-lyrics", "--lyrics", str(mine))
    assert service.hits == [] and fakes["transcribe"] == 0
    assert fakes["align"][0][0] == ["My", "own", "words"]
