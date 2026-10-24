"""YouTube fetch: title parsing, and real yt-dlp downloads from a local HTTP server
(the generic extractor), so no network access is needed."""

import functools
import http.server
import json
import shutil
import subprocess
import threading

import pytest

from autokaraoke import cli, youtube
from autokaraoke.youtube import clean_title, guess_artist_title


@pytest.mark.parametrize("raw,want", [
    ("Artist - Song (Official Video)", "Artist - Song"),
    ("Artist - Song [Official Music Video]", "Artist - Song"),
    ("Artist - Song (Lyrics)", "Artist - Song"),
    ("Artist - Song (Remastered 2011)", "Artist - Song"),
    ("Artist - Song (2009 Remaster)", "Artist - Song"),
    ("Artist - Song (HD)", "Artist - Song"),
    ("Artist - Song | Some Label", "Artist - Song"),
    ("Artist - Song (Live at Wembley)", "Artist - Song (Live at Wembley)"),
    ("Artist - Song (feat. Other)", "Artist - Song (feat. Other)"),
    ('"Song Title"', "Song Title"),
])
def test_clean_title(raw, want):
    assert clean_title(raw) == want


def test_guess_prefers_music_metadata():
    info = {"title": "whatever (Official Video)", "artists": ["A", "B"], "track": "Real Song"}
    assert guess_artist_title(info) == ("A, B", "Real Song")


def test_guess_splits_title_then_falls_back_to_channel():
    assert guess_artist_title({"title": "Band – Tune (Official Audio)", "uploader": "x"}) == ("Band", "Tune")
    assert guess_artist_title({"title": "Tune (Lyric Video)", "uploader": "BandVEVO"}) == ("Band", "Tune")
    assert guess_artist_title({"title": "Tune", "channel": "Band - Topic"}) == ("Band", "Tune")


# ------------------------------------------------------------ real yt-dlp, local server

yt_dlp = pytest.importorskip("yt_dlp")
pytestmark_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


@pytest.fixture
def server(tmp_path, monkeypatch):
    for k in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("no_proxy", "*")
    root = tmp_path / "www"
    root.mkdir()
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=f=330:d=3",
                    "-metadata", "title=Some Band - Some Song (Official Video)",
                    str(root / "clip.mp3")], check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a: None
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/clip.mp3"
    httpd.shutdown()


def _tags(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return {k.lower(): v for k, v in json.loads(out)["format"].get("tags", {}).items()}


@pytestmark_ffmpeg
def test_fetch_downloads_names_and_tags(tmp_path, server):
    out = tmp_path / "dl"
    cli.main(["fetch", server, "--out", str(out)])
    files = list(out.iterdir())
    assert len(files) == 1
    # the generic extractor's title is the file name, so the name comes from it
    f = files[0]
    assert f.suffix == ".mp3" and f.stat().st_size > 1000
    assert _tags(f)["title"] == f.stem.split(" - ")[-1]
    cli.main(["fetch", server, "--out", str(out)])           # second download doesn't overwrite
    assert len(list(out.iterdir())) == 2


@pytestmark_ffmpeg
def test_download_to_cache_reuses_file(tmp_path, server):
    logs = []
    p1, _, _ = youtube.download(server, tmp_path / "cache", rename=False, log=logs.append)
    p2, _, _ = youtube.download(server, tmp_path / "cache", rename=False, log=logs.append)
    assert p1 == p2 and any("earlier download" in m for m in logs)


@pytestmark_ffmpeg
def test_make_accepts_url(tmp_path, server, monkeypatch):
    seen = {}

    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    real_probe = cli.audio.probe

    def probe(path):
        seen["path"] = path
        raise SystemExit(0)

    monkeypatch.setattr(cli.audio, "probe", probe)
    with pytest.raises(SystemExit):
        cli.main(["make", server, "--out", str(tmp_path / "out")])
    assert str(seen["path"]).startswith(str(tmp_path / "xdg" / "autokaraoke" / "downloads"))
    assert real_probe(seen["path"])[0] > 2.5
