#!/usr/bin/env bash
# Puts Phonon-2 (the first lyric timer, docs/PLAN.md §31.17) into maker/bundled/ for the installers,
# so a PC installing the Karaoke maker never downloads it. Run where Hugging Face is reachable (the
# release workflow does); the folder is not in git (≈180 MB).
#
#   maker/bundle-phonon.sh [--check]
#
# It installs fermion-research (Fermion Research's package, Apache-2.0) in a throwaway environment,
# has it download and unpack Phonon-2 (weights CC-BY-4.0) exactly as it would on the PC, and keeps
# only the unpacked model, in the layout of `<models>/fermion` ($FERMION_CACHE_DIR):
#
#   maker/bundled/fermion/speech/FermionResearch__Phonon-2/<profile>/   the model
#   maker/bundled/fermion/NOTICE-Phonon-2.txt, README.txt                 its licence and changes
#
# Then it loads that copy and transcribes two seconds of silence with it. maker/install.sh copies
# maker/bundled/fermion/speech into the models folder. --check: the last step only, on a bundle
# already there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/bundled/fermion"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CHECK_ONLY=0
[[ "${1:-}" == --check ]] && CHECK_ONLY=1
say() { printf '\n==> %s\n' "$*"; }

say "A throwaway Python environment with fermion-research"
python3 -m venv "$WORK/venv"
PIP=("$WORK/venv/bin/python" -m pip install --quiet --disable-pip-version-check)
"${PIP[@]}" --upgrade pip
"${PIP[@]}" torch --index-url https://download.pytorch.org/whl/cpu
"${PIP[@]}" "fermion-research>=0.2.14"
PY="$WORK/venv/bin/python"

if [[ $CHECK_ONLY == 0 ]]; then
  say "Downloading and unpacking Phonon-2"
  rm -rf "$OUT"
  mkdir -p "$OUT"
  FERMION_CACHE_DIR="$OUT" FERMION_SPEECH_FETCH_ANYWAY=1 FERMION_DEVICE=cpu HF_HOME="$WORK/hf" "$PY" - "$OUT" <<'EOF'
import shutil, sys
from pathlib import Path
from fermion.transcribe import _resolve
from fermion._speech import fetch
out = Path(sys.argv[1])
repo, key, pin, _ = _resolve("phonon-2")
model = Path(fetch.ensure(repo, key, pin))
print(f"unpacked: {model}")
if not fetch.is_model_dir(model):
    sys.exit(f"{model} is not a complete model")
# Only the unpacked model: the download it came from (the Hub's cache) and the locks go.
for p in out.iterdir():
    if p.name != "speech":
        shutil.rmtree(p) if p.is_dir() else p.unlink()
for p in out.rglob("*.lock"):
    p.unlink()
# Its licence: the NOTICE of the weights' repository (what NVIDIA's model was changed into).
try:
    from huggingface_hub import hf_hub_download
    notice = hf_hub_download(repo, "NOTICE")
    shutil.copyfile(notice, out / "NOTICE-Phonon-2.txt")
except Exception as e:  # noqa: BLE001
    sys.exit(f"could not fetch Phonon-2's NOTICE ({e}): it must ship with the weights")
(out / "README.txt").write_text(
    "Phonon-2 by Fermion Research (https://huggingface.co/FermionResearch/Phonon-2),\n"
    "licensed CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). A derivative of NVIDIA's\n"
    "parakeet-tdt-0.6b-v3; the changes are in NOTICE-Phonon-2.txt. Unpacked by fermion-research\n"
    "(Apache-2.0) and shipped unchanged with OpenKaraoke's Karaoke maker.\n", encoding="utf-8")
EOF
fi

say "Loading the bundled copy and transcribing silence with it"
[[ -d "$OUT/speech" ]] || { echo "error: no bundle in $OUT (run without --check)" >&2; exit 1; }
COPY="$WORK/models/fermion"
mkdir -p "$COPY"
cp -a "$OUT/speech" "$COPY/"
# Offline, from a copy, as maker/install.sh leaves it: nothing may be fetched.
FERMION_CACHE_DIR="$COPY" FERMION_DEVICE=cpu HF_HUB_OFFLINE=1 HF_HOME="$WORK/empty-hf" "$PY" - <<'EOF'
import time
import numpy as np
import fermion
t0 = time.time()
speech = fermion.load_speech("phonon-2")
result = speech.transcribe_array_detailed(np.zeros(16000 * 2, dtype=np.float32))
print(f"loaded and ran in {time.time() - t0:.1f}s: {result.triple()[0]!r} (silence: no words expected)")
EOF
du -sh "$OUT"
echo "Phonon-2 is in $OUT"
