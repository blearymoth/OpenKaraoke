"""Audio I/O through the ffmpeg command-line tool (no torchaudio/soundfile needed)."""

import json
import shutil
import subprocess
import wave

import numpy as np


def require_ffmpeg():
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} not found: install FFmpeg (e.g. `sudo dnf install ffmpeg`).")


def load(path, sr, channels):
    """Decode any audio file to float32 numpy of shape (channels, samples)."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-vn", "-f", "f32le",
           "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    data = np.frombuffer(raw, dtype=np.float32)
    return data.reshape(-1, channels).T.copy()


def save_wav(path, audio, sr):
    """audio: (channels, samples) float in [-1, 1] -> 16-bit WAV."""
    a = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    pcm = (a.T * 32767.0).round().astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(a.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def encode_mp3(src, dst, title="", artist="", quality=2):
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn",
           "-codec:a", "libmp3lame", "-q:a", str(quality), "-id3v2_version", "3"]
    if title:
        cmd += ["-metadata", f"title={title}"]
    if artist:
        cmd += ["-metadata", f"artist={artist}"]
    cmd.append(str(dst))
    subprocess.run(cmd, check=True)


def probe(path):
    """Return (duration_seconds, tags dict with lower-case keys)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format",
                          str(path)], capture_output=True, check=True, text=True).stdout
    fmt = json.loads(out).get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return float(fmt.get("duration") or 0.0), tags
