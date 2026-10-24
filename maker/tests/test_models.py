"""Models folder resolution and offline switching (no ML packages needed)."""

import os

import pytest

from autokaraoke import cli, models

HASH = "0123456789abcdef0123456789abcdef01234567"


def fake_hf(mdir, repo, name, sigs, missing=()):
    snap = mdir / "huggingface" / "hub" / f"models--adefossez--{repo}" / "snapshots" / HASH
    snap.mkdir(parents=True)
    (snap.parent.parent / "refs").mkdir()
    (snap.parent.parent / "refs" / "main").write_text(HASH)
    (snap / f"{name}.yaml").write_text(f"models: {sigs!r}\nweights: [[1., 0.], [0., 1.]]\n")
    for s in sigs:
        if s not in missing:
            (snap / f"{s}.safetensors").write_bytes(b"x" * 2000)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ("AUTOKARAOKE_MODELS", "HF_HOME", "TORCH_HOME", "HF_HUB_OFFLINE", "XDG_DATA_HOME"):
        monkeypatch.delenv(k, raising=False)


def test_models_dir_resolution(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert models.models_dir() == tmp_path / "data" / "autokaraoke" / "models"
    monkeypatch.setenv("AUTOKARAOKE_MODELS", str(tmp_path / "env"))
    assert models.models_dir() == tmp_path / "env"
    assert models.models_dir(str(tmp_path / "flag")) == tmp_path / "flag"


def test_configure_goes_offline_only_when_model_is_present(tmp_path):
    models.configure(tmp_path, "htdemucs")
    assert os.environ["HF_HOME"] == str(tmp_path / "huggingface")
    assert os.environ["TORCH_HOME"] == str(tmp_path / "torch")
    assert "HF_HUB_OFFLINE" not in os.environ          # first run may download
    fake_hf(tmp_path, "HTDemucs", "htdemucs", ["955717e8"])
    models.configure(tmp_path, "htdemucs")
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    models.configure(tmp_path, "htdemucs_ft")           # a model that isn't there
    assert "HF_HUB_OFFLINE" not in os.environ
    models.configure(tmp_path, allow_download=False)
    assert os.environ["HF_HUB_OFFLINE"] == "1"


def test_bag_of_models_needs_every_file(tmp_path):
    sigs = ["f7e0c4bc", "d12395a8", "92cfc3b6", "04573f0d"]
    fake_hf(tmp_path, "HTDemucs-ft", "htdemucs_ft", sigs, missing={"92cfc3b6"})
    assert not models.demucs_cached("htdemucs_ft", tmp_path)
    (next((tmp_path / "huggingface").rglob("snapshots")) / HASH / "92cfc3b6.safetensors").write_bytes(b"x")
    assert models.demucs_cached("htdemucs_ft", tmp_path)
    assert not models.demucs_cached("htdemucs", tmp_path)


def test_setup_check_reports_and_fails_when_missing(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(models, "whisper_file", lambda name, mdir: mdir / "whisper" / f"{name}.pt")
    with pytest.raises(SystemExit):
        cli.main(["setup", "--check", "--models-dir", str(tmp_path)])
    assert "NOT ready" in capsys.readouterr().out
    fake_hf(tmp_path, "HTDemucs", "htdemucs", ["955717e8"])
    (tmp_path / "whisper").mkdir()
    (tmp_path / "whisper" / "medium.pt").write_bytes(b"x" * 3000)
    cli.main(["setup", "--check", "--models-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert "Offline: ready" in out and out.count("ready") >= 3


def test_human_sizes():
    assert models.human(1.53e9) == "1.5 GB"
    assert models.human(84e6) == "84 MB"
    assert models.human(2000) == "2 KB"
