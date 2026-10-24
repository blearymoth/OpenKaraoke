"""Lyrics sources: where `make` can get the words from, besides your own lyrics file.

A source is one small function, `fetch(ctx, http_get) -> {"text", "artist", "title"} | None`,
registered in SOURCES. `ctx` has artist, title, duration (s) and path (the song file, or None).
Sources are tried in the order the person gives them; every hit is a *candidate* that
`align.lookup_and_align` checks against what Whisper hears, and the first one that fits wins.

    sidecar   offline   `Artist - Title.txt` / `.lrc` next to the song
    lrclib    online    lrclib.net: open, free, no key (default)
    netease   online    music.163.com: unofficial, often time-synced, big Asian + pop catalogue
    lyricsovh online    api.lyrics.ovh: unofficial aggregator, often down

Only used when asked for (`make --lookup-lyrics` / `--lyrics-sources`, or the window's
switch). Found lyrics are cached next to the models, so a second run needs no network.
The HTTP function is injectable for tests.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import __version__

DURATION_SLACK = 10.0          # a hit this far off in length is a different version
LRC_STAMP = re.compile(r"\[\d+:\d+(?:[.:]\d+)?\]|<\d+:\d+(?:[.:]\d+)?>")
CREDIT = re.compile(r"^\s*(作词|作曲|编曲|制作人|混音|母带|Lyrics by|Music by|Composed by|"
                    r"Written by|Produced by)\s*[:：]", re.I)


def http_get_json(url, timeout=10):
    """GET -> parsed JSON; None for 404; LookupError if the service cannot be reached."""
    req = urllib.request.Request(url, headers={"User-Agent": f"autokaraoke/{__version__}",
                                               "Referer": "https://music.163.com/"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise LookupError(f"service answered HTTP {e.code}") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise LookupError(f"cannot reach the service: {e}") from e


def strip_timestamps(text):
    lines = (LRC_STAMP.sub("", l).strip() for l in text.splitlines())
    return "\n".join(l for l in lines if l and not CREDIT.match(l))


def _norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _slug(artist, title):
    return re.sub(r"[^a-z0-9]+", "-", f"{artist} {title}".lower()).strip("-")[:120] or "song"


# ---- sources -------------------------------------------------------------------------

def _sidecar(ctx, http_get):
    path = ctx.get("path")
    if not path:
        return None
    path = Path(path)
    for ext in (".txt", ".lrc"):
        f = path.with_suffix(ext)
        if f.is_file():
            text = f.read_text(encoding="utf-8", errors="replace")
            text = strip_timestamps(text) if ext == ".lrc" else text.strip()
            if text:
                return {"text": text, "artist": ctx["artist"], "title": ctx["title"]}
    return None


def _lrclib_text(hit):
    if not hit or hit.get("instrumental"):
        return ""
    plain = (hit.get("plainLyrics") or "").strip()
    return plain or strip_timestamps(hit.get("syncedLyrics") or "")


def _lrclib(ctx, http_get):
    base = os.environ.get("AUTOKARAOKE_LRCLIB") or "https://lrclib.net"
    artist, title, duration = ctx["artist"], ctx["title"], ctx["duration"]
    q = {"track_name": title}
    if artist:
        q["artist_name"] = artist
    hit = None
    if artist and duration:
        hit = http_get(f"{base}/api/get?" + urllib.parse.urlencode({**q, "duration": round(duration)}))
        if not _lrclib_text(hit):
            hit = None
    if hit is None:
        results = http_get(f"{base}/api/search?" + urllib.parse.urlencode(q)) or []
        usable = [h for h in results if _lrclib_text(h)]
        if duration:
            usable = [h for h in usable
                      if abs(float(h.get("duration") or 0) - duration) <= DURATION_SLACK]
            usable.sort(key=lambda h: abs(float(h.get("duration") or 0) - duration))
        hit = usable[0] if usable else None
    if hit is None:
        return None
    return {"text": _lrclib_text(hit), "artist": hit.get("artistName", artist),
            "title": hit.get("trackName", title)}


def _netease(ctx, http_get):
    base = os.environ.get("AUTOKARAOKE_NETEASE") or "https://music.163.com"
    artist, title, duration = ctx["artist"], ctx["title"], ctx["duration"]
    q = urllib.parse.urlencode({"s": f"{artist} {title}".strip(), "type": 1, "limit": 8})
    res = http_get(f"{base}/api/search/get?{q}") or {}
    songs = (res.get("result") or {}).get("songs") or []
    want = _norm(title)
    songs = [s for s in songs if want and _norm(s.get("name")).startswith(want)]
    if duration:
        songs = [s for s in songs if abs(float(s.get("duration") or 0) / 1000 - duration) <= DURATION_SLACK]
        songs.sort(key=lambda s: abs(float(s.get("duration") or 0) / 1000 - duration))
    if not songs:
        return None
    song = songs[0]
    res = http_get(f"{base}/api/song/lyric?" + urllib.parse.urlencode({"id": song["id"], "lv": 1})) or {}
    text = strip_timestamps(((res.get("lrc") or {}).get("lyric")) or "")
    if not text:
        return None
    names = ", ".join(a.get("name", "") for a in song.get("artists") or [])
    return {"text": text, "artist": names or artist, "title": song.get("name", title)}


def _lyricsovh(ctx, http_get):
    base = os.environ.get("AUTOKARAOKE_LYRICSOVH") or "https://api.lyrics.ovh"
    if not (ctx["artist"] and ctx["title"]):
        return None
    url = f"{base}/v1/{urllib.parse.quote(ctx['artist'], safe='')}/{urllib.parse.quote(ctx['title'], safe='')}"
    text = ((http_get(url) or {}).get("lyrics") or "").replace("\r\n", "\n").strip()
    return {"text": text, "artist": ctx["artist"], "title": ctx["title"]} if text else None


@dataclass(frozen=True)
class Source:
    name: str
    label: str
    note: str
    online: bool
    fetch: Callable


SOURCES = {s.name: s for s in (
    Source("sidecar", "Lyrics file next to the song", "Artist - Title.txt or .lrc. Works offline.",
           False, _sidecar),
    Source("lrclib", "LRCLIB", "lrclib.net: open and free, no key. Smaller catalogue.", True, _lrclib),
    Source("netease", "NetEase", "music.163.com: unofficial, large catalogue, often time-synced.",
           True, _netease),
    Source("lyricsovh", "lyrics.ovh", "api.lyrics.ovh: unofficial aggregator, often down.", True,
           _lyricsovh),
)}
DEFAULT_SOURCES = ("sidecar", "lrclib")


def parse_sources(text):
    """'lrclib, netease' -> ['lrclib', 'netease']; raises ValueError on an unknown name."""
    names = [n.strip().lower() for n in (text or "").split(",") if n.strip()]
    bad = [n for n in names if n not in SOURCES]
    if bad:
        raise ValueError(f"unknown lyrics source {', '.join(bad)}; choose from: {', '.join(SOURCES)}")
    return list(dict.fromkeys(names))


def cache_file(mdir, source, artist, title):
    return Path(mdir) / "lyrics" / f"{source}-{_slug(artist, title)}.json"


def find(artist, title, duration=0.0, sources=DEFAULT_SOURCES, mdir=None, path=None,
         http_get=http_get_json, log=print):
    """-> [{"text", "artist", "title", "source"}, ...] in source order (sources with nothing
    are skipped, unreachable ones are logged and skipped). The song's own file is never read
    for online sources, and nothing is fetched for a source that has a cached answer."""
    ctx = {"artist": artist or "", "title": title or "", "duration": float(duration or 0), "path": path}
    found = []
    for name in sources:
        src = SOURCES[name]
        cache = cache_file(mdir, name, ctx["artist"], ctx["title"]) if mdir and src.online else None
        hit = None
        if cache and cache.is_file():
            try:
                hit = json.loads(cache.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                hit = None
        if hit is None:
            if not ctx["title"]:
                continue
            try:
                hit = src.fetch(ctx, http_get)
            except LookupError as e:
                log(f"  {src.label}: {e}")
                continue
            if hit and cache:
                try:
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    cache.write_text(json.dumps(hit, ensure_ascii=False), encoding="utf-8")
                except OSError:
                    pass
        if hit and (hit.get("text") or "").strip():
            found.append({**hit, "source": name})
        else:
            log(f"  {src.label}: nothing found")
    return found
