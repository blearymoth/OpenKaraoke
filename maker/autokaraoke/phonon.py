"""Phonon-2 (Fermion Research, `pip install fermion-research`): fast English speech recognition
with a time for every word, the lyric timer tried first; Whisper (align.py) is the second.

Phonon-2 transcribes; it doesn't force-align a given text. So for known lyrics it hears the vocal
(favouring the lyrics' rarer words, its "hotwords") and the times go onto the lyrics' words through
align.transfer_timing, letter by letter, as Whisper's do. align.Timer decides when that is good
enough and when Whisper takes over (another language, little of the lyrics heard, no Phonon-2).

Its weights (≈158 MB) live in the models folder: <models>/fermion/ ($FERMION_CACHE_DIR).
"""

import os
from pathlib import Path

from .timing import Line, Word

MODEL = "phonon-2"
SIZE = 158e6  # bytes, for messages before a download starts
MAX_HOTWORDS = 25  # Phonon-2's limit
MAX_CHARS = 42  # a transcribed line is split past this many characters (as Whisper's are)
COMMON = set("""a an and are as at be but by do for from go got have he her him his how i if in is it
its just like me my no not now of oh on or our out she so that the then there they this to up was we
what when where who will with yeah you your""".split())


def cache_dir(mdir):
    return Path(mdir) / "fermion"


def configure(mdir):
    """Point Phonon's downloads at the models folder (before fermion is used)."""
    os.environ["FERMION_CACHE_DIR"] = str(cache_dir(mdir))
    os.environ.setdefault("FERMION_DEVICE", "cpu")  # (the pip install has the CPU engine on Linux)


def available():
    """Is fermion-research installed in this environment?"""
    try:
        import fermion  # noqa: F401
    except Exception:  # noqa: BLE001 - any import failure means: not usable here
        return False
    return True


def _profile():
    from fermion.transcribe import _resolve
    from fermion._speech import fetch
    repo, key, pin, _ = _resolve(MODEL)
    return fetch, repo, key, pin


def cached(mdir):
    """Are Phonon-2's weights in the models folder?"""
    if not available():
        return False
    configure(mdir)
    try:
        fetch, repo, _, pin = _profile()
        return bool(fetch.installed(repo, pin["unpack_dir"]))
    except (Exception, SystemExit):  # noqa: BLE001 - another fermion version: treated as not downloaded
        return False


def folder(mdir):
    """Where the unpacked weights are, or None."""
    if not cached(mdir):
        return None
    try:
        fetch, repo, _, pin = _profile()
        return Path(fetch.profile_dir(repo, pin["unpack_dir"]))
    except (Exception, SystemExit):  # noqa: BLE001
        return None


def download(mdir, log=print):
    configure(mdir)
    fetch, repo, key, pin = _profile()
    log(f"Downloading Phonon-2 ({SIZE / 1e6:.0f} MB) ...")
    fetch.ensure(repo, key, pin)


def load(mdir, log=print):
    import fermion
    configure(mdir)
    log("Loading Phonon-2 ...")
    return fermion.load_speech(MODEL)


def hotwords(lyric_lines, n=MAX_HOTWORDS):
    """The lyrics' unusual words (names, long words; once each, longest first): Phonon-2 favours
    them while it listens."""
    seen = {}
    for line in lyric_lines:
        for w in line:
            k = "".join(c for c in w if c.isalnum() or c in "'-").strip("'-")
            if len(k) >= 4 and k.lower() not in COMMON and k.lower() not in seen:
                seen[k.lower()] = k
    return sorted(seen.values(), key=len, reverse=True)[:n]


def heard(speech, vocals16k, hot=None):
    """[(text, start, end)] for every word Phonon-2 hears in the vocal (mono float32, 16 kHz)."""
    import numpy as np
    result = speech.transcribe_array_detailed(np.asarray(vocals16k, dtype=np.float32), hotwords=hot or [])
    words = result.words if getattr(result, "timed", True) else None
    if not words:
        return []
    return [(str(w["text"]).strip(), float(w["start"]), float(w["end"])) for w in words if str(w["text"]).strip()]


def lines_of(words, max_chars=MAX_CHARS, gap=0.8):
    """Heard words → lines: a new line after a pause of `gap` s, or past `max_chars` characters."""
    lines, cur, length = [], [], 0
    for text, start, end in words:
        if cur and (start - cur[-1].end > gap or length + 1 + len(text) > max_chars):
            lines.append(Line(cur))
            cur, length = [], 0
        cur.append(Word(text, start, max(end, start)))
        length += len(text) + (1 if length else 0)
    if cur:
        lines.append(Line(cur))
    return lines
