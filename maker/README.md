# The Karaoke maker's engine (`autokaraoke`)

The Python side of **Settings → Karaoke maker** (docs/PLAN.md §31). It turns a song — a file or a
YouTube link — into an MP3 + CDG pair:

1. Demucs removes the lead vocal (`htdemucs`).
2. The lyrics are timed word by word, by two timers (`--lyric-timer phonon`, the default):
   - **Phonon-2** first (Fermion Research's `fermion-research`, ≈158 MB, English, fast on a
     processor): it hears the vocal, favouring the lyrics' unusual words, and its word times go onto
     the typed or looked-up lyrics letter by letter (`align.transfer_timing`);
   - **Whisper** (via stable-ts) when Phonon-2 can't: a song not in English, under 60 % of the
     lyrics heard, or Phonon-2 not installed. Whisper force-aligns the lyrics to the vocal.

   With no lyrics, the first timer that can writes down what it hears. `Lyric timer: …` says which
   timed the song. `--lyric-timer whisper` uses Whisper only.
3. A CDG is drawn with a word-by-word wipe.

```
Artist - Title.mp3           instrumental
Artist - Title.cdg           the lyrics, same length as the MP3
Artist - Title.timing.json   word timings (the lyrics editor edits these)
Artist - Title.lrc           word-timed LRC, for other players
```

This used to be its own repository (blearymoth/SongGetter). It now lives here, and OpenKaraoke's
page replaces its windows.

## Installing

Use Settings → Karaoke maker → Install. It runs `install.sh`, which builds a Python environment
in `~/.local/share/openkaraoke/autokaraoke/` with a copy of this folder and downloads the models
(about 4 GB, or 8 GB with an NVIDIA graphics card). It needs Python 3.10+ and FFmpeg with the LAME
MP3 encoder. From a terminal: `maker/install.sh [--cpu|--gpu] [--no-youtube] [--no-phonon]`.
Phonon-2 runs on the processor (its pip package has no CUDA engine), which is fast enough for it.
Its weights (≈158 MB, CC-BY-4.0) come from Fermion Research's repository on Hugging Face: `setup`
downloads them through fermion-research, which checks them against the SHA-256 it pins.

## The command line (OpenKaraoke reads it)

OpenKaraoke runs `python -m autokaraoke …` from that environment (`server/maker/autokaraoke.js`)
and reads its output. Keep these stable: the `make`, `render`, `setup`, `retime`, `words` and `lyrics`
commands and options, and the progress lines `server/maker/autokaraoke.js` matches.

## Tests

```bash
cd maker && python -m pytest -q
```

They need `numpy`, `pillow` and `pytest` only: the ML parts are mocked, and there is no network.
