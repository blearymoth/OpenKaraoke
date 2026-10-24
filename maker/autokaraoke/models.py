"""Where the ML models live, and keeping runs offline once they are downloaded.

All models go into one folder, so everything can be measured, moved or deleted together:

    <models>/huggingface/   Demucs weights (HuggingFace cache layout)
    <models>/torch/         Demucs weights from the legacy download site (fallback)
    <models>/whisper/       Whisper checkpoints

The folder is, in order: --models-dir, $AUTOKARAOKE_MODELS, ~/.local/share/autokaraoke/models.
`configure()` must run before torch / demucs / huggingface_hub are imported, because they
read these environment variables at import time.
"""

import os
import re
from pathlib import Path

DEMUCS_NAMESPACE = "adefossez"
# Whisper checkpoint sizes (bytes), for messages before a download starts
WHISPER_SIZES = {"tiny": 75e6, "base": 145e6, "small": 484e6, "medium": 1.53e9,
                 "large-v1": 3.09e9, "large-v2": 3.09e9, "large-v3": 3.09e9, "large": 3.09e9,
                 "large-v3-turbo": 1.62e9, "turbo": 1.62e9}


def models_dir(override=None):
    if override:
        return Path(override).expanduser().resolve()
    env = os.environ.get("AUTOKARAOKE_MODELS")
    if env:
        return Path(env).expanduser().resolve()
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "autokaraoke" / "models"


def configure(mdir, demucs_model=None, allow_download=True):
    """Point the model caches at `mdir`. If the Demucs model is already there (or
    downloads are not allowed), switch HuggingFace to offline mode so nothing touches
    the network."""
    mdir = Path(mdir)
    os.environ["HF_HOME"] = str(mdir / "huggingface")
    os.environ["TORCH_HOME"] = str(mdir / "torch")
    if not allow_download or (demucs_model and demucs_cached(demucs_model, mdir)):
        os.environ["HF_HUB_OFFLINE"] = "1"
    else:
        os.environ.pop("HF_HUB_OFFLINE", None)
    return mdir


def _hf_repo(name):
    ns = DEMUCS_NAMESPACE
    if "/" in name:
        ns, name = name.split("/", 1)
    if name == "htdemucs":
        repo = "HTDemucs"
    elif name.startswith("htdemucs_"):
        repo = "HTDemucs-" + name[len("htdemucs_"):]
    else:
        repo = "Demucs-" + name
    return f"models--{ns}--{repo}", name


def _hf_files(name, mdir):
    """Files of a cached Demucs bag: (yaml, [safetensors...]) or None if incomplete."""
    repo, short = _hf_repo(name)
    snaps = Path(mdir) / "huggingface" / "hub" / repo / "snapshots"
    for snap in sorted(snaps.glob("*")):
        y = snap / f"{short}.yaml"
        if not y.is_file():
            continue
        text = y.read_text(encoding="utf-8", errors="replace")
        # bag yaml: "models: ['955717e8', ...]" or a block list "- 955717e8"
        m = re.search(r"models:\s*\[([^\]]*)\]", text)
        sigs = re.findall(r"[0-9a-f]{8}", m.group(1)) if m else re.findall(r"^\s*-\s*'?([0-9a-f]{8})", text, re.M)
        files = [snap / f"{s}.safetensors" for s in sigs]
        if sigs and all(f.is_file() for f in files):
            return y, files
    return None


def _legacy_cached(name, mdir):
    """Weights fetched through demucs' legacy torch-hub path (demucs 4.0.x, or its
    fallback when HuggingFace is unreachable): checkpoints/<sig>-<hash>.th."""
    try:
        import demucs
    except ImportError:
        return False
    bag = Path(demucs.__file__).parent / "remote" / f"{name}.yaml"
    if not bag.is_file():
        return False
    sigs = re.findall(r"[0-9a-f]{8}", bag.read_text(encoding="utf-8", errors="replace"))
    ckpts = Path(mdir) / "torch" / "hub" / "checkpoints"
    return bool(sigs) and all(any(ckpts.glob(f"{s}-*.th")) for s in sigs)


def demucs_cached(name, mdir):
    return bool(_hf_files(name, mdir)) or _legacy_cached(name, mdir)


def whisper_file(name, mdir):
    """Path whisper would use for checkpoint `name` (None for unknown names)."""
    try:
        import whisper
        url = whisper._MODELS.get(name)
    except ImportError:
        url = None
    if url:
        return Path(mdir) / "whisper" / os.path.basename(url)
    if os.path.isfile(name):  # a local checkpoint path
        return Path(name)
    return None


def whisper_cached(name, mdir):
    f = whisper_file(name, mdir)
    return bool(f and f.is_file())


def dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def human(n):
    if n >= 1e9:
        return f"{n / 1e9:.1f} GB"
    if n >= 1e6:
        return f"{n / 1e6:.0f} MB"
    return f"{n / 1e3:.0f} KB"


def offline_hint(what, mdir):
    return (f"{what} is not downloaded yet and could not be fetched.\n"
            f"Connect to the internet once and run:  autokaraoke setup"
            f"{'' if str(mdir) == str(models_dir()) else f' --models-dir {mdir}'}\n"
            f"(models folder: {mdir})")
