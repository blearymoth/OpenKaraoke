"""Vocal separation with Demucs (htdemucs by default).

Uses demucs' model loading and `apply_model` directly, with audio I/O done through
ffmpeg, so it works with demucs 4.0.x and 4.1.x and does not need torchaudio.
"""

import numpy as np

from . import audio


def pick_device(requested="auto"):
    import torch
    if requested and requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(model_name, mdir=None, log=print):
    """Load a Demucs model; downloads it into the models folder if it isn't there yet
    (call models.configure() first so the caches point at that folder)."""
    try:
        from demucs.pretrained import get_model
    except ImportError as e:
        raise SystemExit("Vocal separation needs Demucs: pip install 'autokaraoke[ml]'\n"
                         f"({e})")
    from . import models
    mdir = mdir or models.models_dir()
    if not models.demucs_cached(model_name, mdir):
        log(f"Downloading Demucs model '{model_name}' (once) into {mdir} ...")
    try:
        model = get_model(model_name)
    except KeyboardInterrupt:
        raise
    except BaseException as e:  # includes SystemExit from demucs' own fatal()
        if not models.demucs_cached(model_name, mdir):
            raise SystemExit(models.offline_hint(f"Demucs model '{model_name}'", mdir)) from e
        raise
    model.eval()
    return model


def separate(path, model_name="htdemucs", device="auto", shifts=1, log=print, mdir=None):
    """Return (vocals, instrumental, sample_rate); arrays are (channels, samples) float32."""
    model = load_model(model_name, mdir, log)
    import torch
    from demucs.apply import apply_model
    device = pick_device(device)
    log(f"Separating vocals with {model_name} on {device}...")
    sr, ch = model.samplerate, model.audio_channels
    if "vocals" not in model.sources:
        raise SystemExit(f"model {model_name} has no 'vocals' stem: {model.sources}")
    mix = torch.from_numpy(audio.load(path, sr, ch))
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((mix - mean) / std)[None], device=device, shifts=shifts,
                          split=True, overlap=0.25, progress=True)[0]
    out = (out * std + mean).cpu().numpy()
    vi = model.sources.index("vocals")
    vocals = out[vi]
    instrumental = np.sum([out[i] for i in range(len(model.sources)) if i != vi], axis=0)
    return vocals.astype(np.float32), instrumental.astype(np.float32), sr
