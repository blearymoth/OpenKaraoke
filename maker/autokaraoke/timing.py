"""Timed-lyrics data model, JSON round-trip and LRC export.

timing.json (hand-editable; re-render with `autokaraoke render`):
{
  "version": 1,
  "title": "...", "artist": "...", "language": "en", "duration": 213.4,
  "lines": [ {"words": [ {"text": "Hello", "start": 12.30, "end": 12.71}, ... ]}, ... ]
}
Times are seconds from the start of the audio.
"""

import json
from dataclasses import dataclass, field


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Line:
    words: list

    @property
    def start(self):
        return self.words[0].start

    @property
    def end(self):
        return self.words[-1].end

    @property
    def text(self):
        return " ".join(w.text for w in self.words)


@dataclass
class Song:
    title: str = ""
    artist: str = ""
    language: str = ""
    duration: float = 0.0
    lines: list = field(default_factory=list)


def clean(song):
    """Drop empty lines, sort, and make times sane (non-negative, ordered, end >= start)."""
    lines = [Line([w for w in l.words if w.text.strip()]) for l in song.lines]
    lines = [l for l in lines if l.words]
    prev_end = 0.0
    for line in lines:
        for w in line.words:
            w.text = w.text.strip()
            w.start = max(float(w.start), 0.0)
            w.end = max(float(w.end), w.start)
    lines.sort(key=lambda l: l.start)
    for line in lines:
        for w in line.words:
            if w.start < prev_end - 0.05:  # overlapping/backwards timing: push forward
                shift = prev_end - w.start
                w.start += shift
                w.end = max(w.end, w.start)
            prev_end = max(prev_end, w.end)
    song.lines = lines
    return song


def to_dict(song):
    return {
        "version": 1,
        "title": song.title,
        "artist": song.artist,
        "language": song.language,
        "duration": round(song.duration, 3),
        "lines": [
            {"words": [{"text": w.text, "start": round(w.start, 3), "end": round(w.end, 3)}
                       for w in line.words]}
            for line in song.lines
        ],
    }


def from_dict(d):
    if d.get("version") != 1:
        raise ValueError("unsupported timing.json version")
    song = Song(d.get("title", ""), d.get("artist", ""), d.get("language", ""),
                float(d.get("duration", 0)))
    for line in d.get("lines", []):
        song.lines.append(Line([Word(w["text"], float(w["start"]), float(w["end"]))
                                for w in line["words"]]))
    return clean(song)


def save_json(song, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_dict(song), f, ensure_ascii=False, indent=1)
        f.write("\n")


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return from_dict(json.load(f))


def _ts(t):
    m, s = divmod(max(t, 0.0), 60)
    return f"{int(m):02d}:{s:05.2f}"


def to_lrc(song):
    """Enhanced LRC: [mm:ss.xx] <mm:ss.xx> word <mm:ss.xx> word ..."""
    out = []
    if song.title:
        out.append(f"[ti:{song.title}]")
    if song.artist:
        out.append(f"[ar:{song.artist}]")
    for line in song.lines:
        parts = [f"[{_ts(line.start)}]"]
        for w in line.words:
            parts.append(f"<{_ts(w.start)}> {w.text}")
        parts.append(f"<{_ts(line.end)}>")
        out.append(" ".join(parts))
    return "\n".join(out) + "\n"
