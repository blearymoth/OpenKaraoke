# The Karaoke maker's engine (`autokaraoke`)

The Python side of **Settings → Karaoke maker** (docs/PLAN.md §31). It turns a song — a file or a
YouTube link — into an MP3 + CDG pair:

1. Demucs removes the lead vocal (`htdemucs`).
2. Whisper (via stable-ts) times the lyrics word by word: typed or looked-up lyrics are
   force-aligned to the vocal; with none, Whisper writes down what it hears.
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
MP3 encoder. From a terminal: `maker/install.sh [--cpu|--gpu] [--no-youtube]`.

## The command line (OpenKaraoke reads it)

OpenKaraoke runs `python -m autokaraoke …` from that environment (`server/maker/autokaraoke.js`)
and reads its output. Keep these stable: the `make`, `render`, `setup`, `retime`, `words` and `lyrics`
commands and options, and the progress lines `server/maker/autokaraoke.js` matches.

## Tests

```bash
cd maker && python -m pytest -q
```

They need `numpy`, `pillow` and `pytest` only: the ML parts are mocked, and there is no network.
