"""Download songs (audio) or music videos from YouTube and other sites via yt-dlp.

Audio is kept in its original codec (usually Opus or AAC): re-encoding to MP3 before
vocal separation would only lose quality. Files are named "Artist - Title.ext" and
tagged with the same artist/title, which `autokaraoke make` picks up.

yt-dlp needs a JavaScript runtime for YouTube (deno, node or bun on PATH) and the
`yt-dlp-ejs` helper, both of which `pip install 'autokaraoke[youtube]'` + a runtime cover.
"""

import os
import re
import subprocess
from pathlib import Path

# "(Official Video)", "[Lyrics]", "(HD)", "(Remastered 2011)", ...
_JUNK = re.compile(
    r"\s*[\(\[\{]\s*(?:"
    r"official(?:\s+(?:hd|4k|music))?(?:\s+(?:video|audio|lyrics?(?:\s+video)?|visuali[sz]er|mv))?"
    r"|(?:hd|hq|4k)(?:\s+(?:video|audio|version))?"
    r"|(?:lyrics?|audio|video|visuali[sz]er|mv|explicit|clean)(?:\s+(?:video|version))?"
    r"|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?"
    r")\s*[\)\]\}]",
    re.I,
)
_CHANNEL_JUNK = re.compile(r"\s*(?:-\s*Topic|VEVO|\bOfficial(?:\s+(?:Channel|Music))?)\s*$", re.I)
_DASHES = (" - ", " – ", " — ", " ~ ", " | ")

VIDEO_SORT = ["res:1080", "vcodec:h264", "ext:mp4:m4a"]  # plays in any browser/TV


def clean_title(title):
    t = _JUNK.sub("", title or "")
    t = re.sub(r"\s*\|.*$", "", t) if t.count("|") == 1 and " - " in t else t  # "A - B | Label"
    t = re.sub(r"\s+", " ", t).strip(" -–—\"'“”")
    return t


def guess_artist_title(info):
    """Best (artist, title) for a yt-dlp info dict."""
    artists = info.get("artists") or ([info["artist"]] if info.get("artist") else [])
    track = info.get("track")
    if track and artists:
        return ", ".join(artists), clean_title(track)
    title = clean_title(info.get("title", ""))
    for sep in _DASHES:
        if sep in title:
            a, t = title.split(sep, 1)
            if a.strip() and t.strip():
                return a.strip(), clean_title(t)
    channel = _CHANNEL_JUNK.sub("", info.get("artist") or info.get("uploader") or info.get("channel") or "")
    return channel.strip(), title or info.get("id", "video")


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name[:180] or "song"


def _ydl_class():
    try:
        from yt_dlp import YoutubeDL
    except ImportError as e:
        raise SystemExit("Downloading needs yt-dlp: pip install 'autokaraoke[youtube]'\n"
                         f"({e})")
    return YoutubeDL


def _base_opts(log):
    class _Log:
        def debug(self, msg):
            if not msg.startswith("[debug] "):
                self.info(msg)

        def info(self, msg):
            pass

        def warning(self, msg):
            log(f"  yt-dlp: {msg}")

        def error(self, msg):
            log(f"  yt-dlp: {msg}")

    return {
        "logger": _Log(),
        "noprogress": True,
        # use whichever JavaScript runtime is installed (YouTube needs one)
        "js_runtimes": {"deno": {}, "node": {}, "bun": {}},
        "windowsfilenames": True,
    }


def retag(path, title, artist):
    """Rewrite title/artist tags in place without re-encoding."""
    path = Path(path)
    tmp = path.with_name(path.stem + ".retag" + path.suffix)
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(path), "-map", "0", "-c", "copy",
           "-map_metadata", "-1", "-metadata", f"title={title}"]
    if artist:
        cmd += ["-metadata", f"artist={artist}"]
    cmd.append(str(tmp))
    try:
        subprocess.run(cmd, check=True)
        os.replace(tmp, path)
    except (OSError, subprocess.CalledProcessError):
        tmp.unlink(missing_ok=True)  # tags are a nicety; keep the download either way


def _unique(path):
    if not path.exists():
        return path
    for i in range(2, 1000):
        p = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not p.exists():
            return p
    raise SystemExit(f"too many files named like {path}")


def list_entries(url, playlist, log=print):
    """URLs to download: the video itself, or every entry of a playlist."""
    YoutubeDL = _ydl_class()
    opts = dict(_base_opts(log), noplaylist=not playlist, extract_flat="in_playlist")
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        urls = [e.get("url") or e.get("webpage_url") for e in info.get("entries") or [] if e]
        log(f"Playlist '{info.get('title', '?')}': {len(urls)} videos")
        return [u for u in urls if u]
    return [info.get("webpage_url") or url]


def download(url, dest, video=False, rename=True, log=print):
    """Download one URL into `dest`; returns (path, artist, title).

    rename=False keeps the "<id>.<ext>" name (used for the cache) and reuses an
    earlier download of the same video."""
    YoutubeDL = _ydl_class()
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    # renamed downloads land under a hidden temporary name first, so they can't collide
    # with an existing "Artist - Title" file (or with themselves)
    tmpl = ".autokaraoke-%(id)s.%(ext)s" if rename else "%(id)s.%(ext)s"
    opts = dict(_base_opts(log), noplaylist=True, paths={"home": str(dest)},
                outtmpl={"default": tmpl})
    if video:
        opts.update(format="bv*+ba/b", format_sort=VIDEO_SORT, merge_output_format="mp4")
    else:
        opts.update(format="bestaudio/best")
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info.get("_type") == "playlist":
            raise SystemExit("that URL is a playlist; use `autokaraoke fetch --playlist`")
        artist, title = guess_artist_title(info)
        log(f"{'Video' if video else 'Audio'}: {artist or '?'} - {title}  "
            f"({int(info.get('duration') or 0)}s, {info.get('webpage_url', url)})")
        cached = [p for p in dest.glob(f"{info['id']}.*") if not p.name.endswith((".part", ".ytdl"))]
        if cached and not rename and not video:
            path = cached[0]
            log(f"  using earlier download {path.name}")
        else:
            info = ydl.process_ie_result(info, download=True)
            reqs = info.get("requested_downloads") or [{}]
            path = Path(reqs[0].get("filepath") or ydl.prepare_filename(info))
    retag(path, title, artist)
    if rename:
        final = _unique(dest / (safe_name(f"{artist} - {title}" if artist else title) + path.suffix))
        os.replace(path, final)
        path = final
    return path, artist, title


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return Path(base) / "autokaraoke" / "downloads"


def is_url(s):
    return bool(re.match(r"^https?://", s or "", re.I))
