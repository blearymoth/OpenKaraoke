#!/usr/bin/env bash
# Installs the Karaoke maker's Python side (the `autokaraoke` package in this folder) for
# OpenKaraoke. Settings → Karaoke maker runs this; it also works from a terminal.
#
# Everything goes to one folder (default ~/.local/share/openkaraoke/autokaraoke):
#   .venv/    the Python environment (PyTorch, Demucs, Phonon-2, Whisper, yt-dlp) with a copy of this code
#   models/   the downloaded models (Demucs, Phonon-2, Whisper)
# This folder (inside OpenKaraoke, read-only in the AppImage) is only read. To uninstall,
# delete the install folder. After this script, making songs works without the internet.
#
# Usage: ./install.sh [--cpu | --gpu] [--whisper-model NAME] [--no-youtube] [--no-phonon] [--no-models]
#                     [--home DIR] [--models-from DIR] [--code-only]
#   --no-phonon        leave out Phonon-2 (the first lyric timer): Whisper times every song
#   --models-from DIR  reuse models already downloaded (e.g. an older autokaraoke install):
#                      hard-linked when on the same disk, else copied; DIR is left as it is
#   --code-only        only refresh the copy of this code in an existing environment
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${OPENKARAOKE_MAKER_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/openkaraoke/autokaraoke}"
TORCH=auto
YOUTUBE=1
PHONON=1
GET_MODELS=1
WHISPER=medium
MODELS_FROM=""
CODE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cpu) TORCH=cpu ;;
    --gpu) TORCH=gpu ;;
    --no-youtube) YOUTUBE=0 ;;
    --no-phonon) PHONON=0 ;;
    --no-models) GET_MODELS=0 ;;
    --code-only) CODE_ONLY=1 ;;
    --whisper-model) WHISPER="${2:?--whisper-model needs a name}"; shift ;;
    --home) DEST="${2:?--home needs a folder}"; shift ;;
    --models-from) MODELS_FROM="${2:?--models-from needs a folder}"; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

VENV="$DEST/.venv"
MODELS="$DEST/models"
say() { printf '\n==> %s\n' "$*"; }
PIP=("$VENV/bin/python" -m pip install --no-cache-dir --disable-pip-version-check)

# pip builds in the source folder, which may be read-only: install from a copy.
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp -r "$SRC/autokaraoke" "$SRC/pyproject.toml" "$SRC/README.md" "$BUILD/"
find "$BUILD" -name __pycache__ -prune -exec rm -rf {} +

EXTRAS=ml
[[ $YOUTUBE == 1 ]] && EXTRAS="$EXTRAS,youtube"
[[ $PHONON == 1 ]] && EXTRAS="$EXTRAS,phonon"

# Phonon-2 as the installers ship it (maker/bundled/, from maker/bundle-phonon.sh): copied into the
# models folder, so it isn't downloaded. An existing copy is left as it is.
seed_phonon() {
  [[ $PHONON == 1 && -d "$SRC/bundled/fermion/speech" ]] || return 0
  say "Phonon-2 (it came with OpenKaraoke)"
  mkdir -p "$MODELS/fermion/speech"
  local d
  for d in "$SRC/bundled/fermion/speech"/*/; do
    [[ -e "$MODELS/fermion/speech/$(basename "$d")" ]] || cp -a "${d%/}" "$MODELS/fermion/speech/"
  done
  cp -f "$SRC/bundled/fermion/"*.txt "$MODELS/fermion/" 2>/dev/null || true
}

# Phonon-2's weights (≈158 MB) into the models folder; Whisper times songs until they are there.
get_phonon() {
  AUTOKARAOKE_MODELS="$MODELS" "$VENV/bin/python" -c 'from autokaraoke import models, phonon; phonon.download(models.models_dir())' \
    || echo "Phonon-2 could not be downloaded now: Whisper times songs until it is (Settings → Karaoke maker → Download)." >&2
}

if [[ $CODE_ONLY == 1 ]]; then
  [[ -x "$VENV/bin/python" ]] || { echo "error: no install in $DEST to update" >&2; exit 1; }
  say "Updating the Karaoke maker's code in $DEST"
  "${PIP[@]}" -q --no-deps --force-reinstall "$BUILD"
  # Phonon-2 came with 0.4.0: an older environment gets it (a few hundred MB, once) and its weights.
  if [[ $PHONON == 1 ]] && ! "$VENV/bin/python" -c 'import fermion' 2>/dev/null; then
    say "Installing Phonon-2, the first lyric timer"
    "${PIP[@]}" -q "fermion-research>=0.2.14"
  fi
  if [[ $PHONON == 1 ]]; then
    seed_phonon
    [[ $GET_MODELS == 1 ]] && get_phonon # (nothing to fetch when it came with OpenKaraoke)
  fi
  echo "autokaraoke $("$VENV/bin/python" -m autokaraoke --version)"
  exit 0
fi

# --- prerequisites -----------------------------------------------------------
PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
  echo "error: Python 3.10 or newer is required (found: $("$PY" --version 2>&1 || echo none))." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "error: FFmpeg is required (Ubuntu: sudo apt install ffmpeg · Fedora: sudo dnf install ffmpeg-free)" >&2
  exit 1
fi
encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
if ! grep -q libmp3lame <<<"$encoders"; then
  echo "warning: this FFmpeg has no MP3 encoder (libmp3lame); MP3 output will fail." >&2
fi
if [[ $TORCH == auto ]]; then
  if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then TORCH=gpu; else TORCH=cpu; fi
fi

# --- Python environment --------------------------------------------------------
mkdir -p "$DEST"
say "Creating the Python environment in $VENV"
"$PY" -m venv "$VENV"
"${PIP[@]}" -q --upgrade pip
case "$TORCH" in
  cpu)
    say "Installing PyTorch (CPU-only build)"
    "${PIP[@]}" torch torchaudio --index-url https://download.pytorch.org/whl/cpu ;;
  gpu)
    DRIVER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1 | cut -d. -f1 || true)"
    if [[ -n "$DRIVER" && "$DRIVER" -lt 580 ]]; then
      # PyPI's default build needs CUDA 13 (driver 580+); older drivers get the CUDA 12.8 build
      say "Installing PyTorch for CUDA 12.8 (NVIDIA driver $DRIVER)"
      "${PIP[@]}" torch torchaudio --index-url https://download.pytorch.org/whl/cu128
    else
      say "Installing PyTorch with CUDA (NVIDIA driver ${DRIVER:-unknown})"
      "${PIP[@]}" torch torchaudio
    fi ;;
esac
say "Installing the Karaoke maker and its dependencies ($EXTRAS)"
"${PIP[@]}" "$BUILD[$EXTRAS]"

# --- models ----------------------------------------------------------------------
if [[ -n "$MODELS_FROM" && -d "$MODELS_FROM" && ! -e "$MODELS" ]]; then
  say "Reusing the models in $MODELS_FROM"
  cp -al "$MODELS_FROM" "$MODELS" 2>/dev/null || { rm -rf "$MODELS"; cp -a "$MODELS_FROM" "$MODELS"; }
fi
seed_phonon
if [[ $GET_MODELS == 1 ]]; then
  say "Downloading the models (once)"
  AUTOKARAOKE_MODELS="$MODELS" "$VENV/bin/python" -m autokaraoke setup --whisper-model "$WHISPER"
fi

# --- summary -------------------------------------------------------------------
say "Done"
GPU_OK="$("$VENV/bin/python" -c 'import torch; print("yes" if torch.cuda.is_available() else "no")' 2>/dev/null || echo "?")"
echo "PyTorch build: $TORCH   (GPU usable: $GPU_OK)"
SIZED=("$VENV"); [[ -d "$MODELS" ]] && SIZED+=("$MODELS")
echo "Space used: $(du -sch "${SIZED[@]}" 2>/dev/null | tail -n1 | cut -f1 || echo ?)"
