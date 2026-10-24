"""Command line: autokaraoke make SONG.mp3 [--lyrics lyrics.txt]  |  autokaraoke render ..."""

import argparse
import os
import re
import sys
import time
from pathlib import Path

from . import __version__, audio, lyrics_lookup, models, youtube
from .render import THEMES, Config, render
from .timing import load_json, save_json, to_lrc


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def _safe(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name or "song"


def _guess_title_artist(path, tags):
    title, artist = tags.get("title", ""), tags.get("artist", "")
    if not (title and artist):
        stem = Path(path).stem
        if " - " in stem:
            a, t = stem.split(" - ", 1)
            artist = artist or a.strip()
            title = title or t.strip()
        else:
            title = title or stem
    return title, artist


def _render_cfg(args):
    return Config(lines_on_screen=args.lines, font_path=args.font or "", font_size=args.font_size,
                  theme=args.theme, lead=args.lead, page_gap=args.page_gap,
                  title_screen=not args.no_title)


def _write_cdg(song, duration, cdg_path, args):
    stats = {}
    t0 = time.time()
    data = render(song, duration, _render_cfg(args), stats)
    Path(cdg_path).write_bytes(data)
    log(f"CDG: {stats['lines']} screen lines on {stats['pages']} pages, font {stats['font_size']}px "
        f"({os.path.basename(stats['font'])}), {time.time() - t0:.1f}s")
    if stats["late_s"] > 0.5:
        log(f"  note: some screen updates ran {stats['late_s']:.1f}s behind; lyrics are dense here, "
            "try --lines 3 or a smaller --font-size")


def _sources_of(args):
    try:
        names = lyrics_lookup.parse_sources(args.lyrics_sources) if args.lyrics_sources else []
    except ValueError as e:
        raise SystemExit(str(e))
    return names or list(lyrics_lookup.DEFAULT_SOURCES)


def _lookup_lyrics(args, model, vocals16k, artist, title, duration, mdir, saved_to, src):
    """Lyrics sources as the authority on the words. -> (lines, language), or (None, None)
    when nothing usable was found (the caller then transcribes as usual)."""
    from . import align
    sources = _sources_of(args)
    log(f"Looking for lyrics: {', '.join(sources)}...")
    hits = lyrics_lookup.find(artist, title, duration, sources, mdir, path=src, log=log)
    candidates = []
    for h in hits:
        lyric_lines = align.parse_lyrics(h["text"], args.keep_sections)
        if lyric_lines:
            log(f"  {lyrics_lookup.SOURCES[h['source']].label}: {len(lyric_lines)} lines "
                f"({h['artist']} - {h['title']})")
            candidates.append((h["source"], lyric_lines))
    if not candidates:
        log("  no lyrics found; transcribing instead.")
        return None, None
    lines, language, used, _ = align.lookup_and_align(
        model, vocals16k, candidates, args.language, args.lyrics_min_match, log)
    if used:
        text = next(l for s, l in candidates if s == used)
        saved_to.write_text("\n".join(" ".join(l) for l in text) + "\n", encoding="utf-8")
        log(f"  used the lyrics from {lyrics_lookup.SOURCES[used].label}, saved in {saved_to.name}; "
            "edit them and re-run with --lyrics ... --retime to fix words.")
        return lines, language
    return lines, language


def cmd_lyrics(args):
    """Show what each source has for a song, without making anything."""
    from . import align
    try:
        names = lyrics_lookup.parse_sources(args.sources) if args.sources else list(lyrics_lookup.SOURCES)
    except ValueError as e:
        raise SystemExit(str(e))
    for name in names:
        src = lyrics_lookup.SOURCES[name]
        hits = lyrics_lookup.find(args.artist, args.title, args.duration, [name],
                                  models.models_dir(args.models_dir), log=lambda m: None)
        if not hits:
            print(f"{src.label:<28} nothing found")
            continue
        lines = align.parse_lyrics(hits[0]["text"])
        print(f"{src.label:<28} {len(lines)} lines  ({hits[0]['artist']} - {hits[0]['title']})")
        if args.show:
            print("\n".join(" ".join(l) for l in lines) + "\n")


def cmd_make(args):
    audio.require_ffmpeg()
    if youtube.is_url(args.song):
        src, _, _ = youtube.download(args.song, youtube.cache_dir(), video=False, rename=False,
                                     log=log)
    else:
        src = Path(args.song)
    if not src.is_file():
        raise SystemExit(f"not a file: {src}")
    duration, tags = audio.probe(src)
    title, artist = _guess_title_artist(src, tags)
    title, artist = args.title or title, args.artist or artist
    base = _safe(f"{artist} - {title}" if artist else title)
    out = Path(args.out or src.parent)
    out.mkdir(parents=True, exist_ok=True)
    work = out / f"{base}.work"
    work.mkdir(exist_ok=True)
    vocals_wav, inst_wav = work / "vocals.wav", work / "instrumental.wav"
    timing_path = out / f"{base}.timing.json"
    mp3_path, cdg_path = out / f"{base}.mp3", out / f"{base}.cdg"
    if mp3_path.resolve() == src.resolve():
        raise SystemExit(f"output {mp3_path} would overwrite the input; use --out")
    log(f"{artist or '?'} - {title}  ({duration:.0f}s)")

    # model caches -> one folder; no network once the models are there
    mdir = models.configure(models.models_dir(args.models_dir), args.model)

    # 1. separation (cached)
    device = args.device
    if vocals_wav.exists() and inst_wav.exists() and not args.force:
        log("Using cached stems from " + str(work))
    else:
        from .separate import separate
        vocals, inst, sr = separate(src, args.model, device, args.shifts, log, mdir=mdir)
        audio.save_wav(vocals_wav, vocals, sr)
        audio.save_wav(inst_wav, inst, sr)

    # 2. instrumental MP3
    audio.encode_mp3(inst_wav, mp3_path, title, artist)
    log(f"Instrumental: {mp3_path}")

    # 3. timing (kept if it exists, so hand edits survive re-runs)
    if timing_path.exists() and not args.force and not args.retime:
        log(f"Using existing {timing_path.name} (pass --retime to redo it)")
        song = load_json(timing_path)
    else:
        from . import align
        from .separate import pick_device
        vocals16k = audio.load(vocals_wav, 16000, 1)[0]
        model = align.load_model(args.whisper_model, pick_device(device), log, mdir=mdir)
        if args.lyrics:
            text = Path(args.lyrics).read_text(encoding="utf-8")
            lyric_lines = align.parse_lyrics(text, args.keep_sections)
            if not lyric_lines:
                raise SystemExit("the lyrics file has no lyrics")
            lines = align.align(model, vocals16k, lyric_lines, args.language, log)
            language = args.language or "en"
        else:
            lines = None
            if args.lookup_lyrics or args.lyrics_sources:
                lines, language = _lookup_lyrics(args, model, vocals16k, artist, title, duration,
                                                 mdir, out / f"{base}.lyrics.txt", src)
            if lines is None:
                lines, language = align.transcribe(model, vocals16k, args.language, log)
        song = align.build_song(lines, title, artist, language, duration)
        if not song.lines:
            raise SystemExit("no lyrics found in the vocals")
        save_json(song, timing_path)
        log(f"Timing: {timing_path}")
    song.title, song.artist = title, artist
    (out / f"{base}.lrc").write_text(to_lrc(song), encoding="utf-8")

    # 4. CDG
    _write_cdg(song, duration, cdg_path, args)
    if not args.keep_stems:
        for f in (vocals_wav, inst_wav):
            f.unlink(missing_ok=True)
        try:
            work.rmdir()
        except OSError:
            pass
    log(f"Done: {mp3_path.name} + {cdg_path.name}")


def cmd_fetch(args):
    audio.require_ffmpeg()
    out = Path(args.out or ".")
    urls = []
    for url in args.urls:
        urls += youtube.list_entries(url, args.playlist, log) if args.playlist else [url]
    failed = 0
    for url in urls:
        try:
            path, _, _ = youtube.download(url, out, video=args.video, log=log)
            log(f"  saved {path}")
        except Exception as e:  # keep going through a playlist
            failed += 1
            log(f"  failed: {url}: {e}")
            if len(urls) == 1:
                raise SystemExit(1)
    if failed:
        log(f"{failed} of {len(urls)} downloads failed")
        raise SystemExit(1)


def _whisper_download(name, mdir):
    """Download a Whisper checkpoint without loading it into memory."""
    import whisper
    url = whisper._MODELS.get(name)
    if not url:
        raise SystemExit(f"unknown Whisper model '{name}'; choose from: "
                         + ", ".join(whisper._MODELS))
    root = mdir / "whisper"
    root.mkdir(parents=True, exist_ok=True)
    try:
        whisper._download(url, str(root), False)  # verifies the SHA256 too
    except (OSError, RuntimeError) as e:
        raise SystemExit(models.offline_hint(f"Whisper model '{name}'", mdir)) from e


def cmd_setup(args):
    mdir = models.models_dir(args.models_dir)
    demucs_names = args.demucs_model or ["htdemucs"]
    whisper_names = args.whisper_model or ["medium"]
    if not args.check:
        models.configure(mdir, allow_download=True)
        mdir.mkdir(parents=True, exist_ok=True)
        from .separate import load_model
        for name in demucs_names:
            if models.demucs_cached(name, mdir):
                log(f"Demucs '{name}': already downloaded")
            else:
                load_model(name, mdir, log)
        for name in whisper_names:
            if models.whisper_cached(name, mdir):
                log(f"Whisper '{name}': already downloaded")
            else:
                size = models.WHISPER_SIZES.get(name)
                log(f"Downloading Whisper '{name}'{f' ({models.human(size)})' if size else ''}...")
                _whisper_download(name, mdir)

    ok = True
    print(f"Models folder: {mdir}")
    for name in demucs_names:
        files = models._hf_files(name, mdir)
        size = sum(f.stat().st_size for f in files[1]) if files else 0
        ready = models.demucs_cached(name, mdir)
        ok &= ready
        print(f"  Demucs  {name:<16}{models.human(size) if size else '':>9}   "
              f"{'ready' if ready else 'MISSING'}")
    for name in whisper_names:
        f = models.whisper_file(name, mdir)
        ready = bool(f and f.is_file())
        ok &= ready
        size = f.stat().st_size if ready else 0
        print(f"  Whisper {name:<16}{models.human(size) if size else '':>9}   "
              f"{'ready' if ready else 'MISSING'}")
    print(f"  models total {models.human(models.dir_size(mdir)):>20}")
    if sys.prefix != sys.base_prefix:
        print(f"Software (Python environment {sys.prefix}): {models.human(models.dir_size(sys.prefix))}")
    if ok:
        print("Offline: ready. `make` with these models no longer needs the internet "
              "(only YouTube URLs do).")
    else:
        print("Offline: NOT ready. Run `autokaraoke setup` while connected to the internet.")
        raise SystemExit(1)


def cmd_render(args):
    audio.require_ffmpeg()
    timing = Path(args.timing)
    song = load_json(timing)
    duration = song.duration
    stem = timing.name[:-len(".timing.json")] if timing.name.endswith(".timing.json") else timing.stem
    mp3 = Path(args.audio) if args.audio else timing.with_name(stem + ".mp3")
    if mp3.exists():
        duration, _ = audio.probe(mp3)
    elif not duration:
        raise SystemExit("unknown duration: pass --audio")
    cdg_path = Path(args.output) if args.output else mp3.with_suffix(".cdg")
    _write_cdg(song, duration, cdg_path, args)
    timing.with_name(stem + ".lrc").write_text(to_lrc(song), encoding="utf-8")
    log(f"Wrote {cdg_path}")


def _add_render_opts(p):
    g = p.add_argument_group("screen")
    g.add_argument("--lines", type=int, default=4, help="lyric lines on screen (default 4)")
    g.add_argument("--font", help="TTF/OTF font file (default: DejaVu Sans Condensed Bold via fontconfig)")
    g.add_argument("--font-size", type=int, default=0, help="font size in px (default: auto)")
    g.add_argument("--theme", choices=sorted(THEMES), default="classic")
    g.add_argument("--lead", type=float, default=4.0, help="show lyrics this many seconds early")
    g.add_argument("--page-gap", type=float, default=8.0,
                   help="instrumental gap (s) that starts a fresh screen")
    g.add_argument("--no-title", action="store_true", help="skip the title screen")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="autokaraoke",
                                 description="Turn a song into an MP3+CDG karaoke pair.")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("make", help="song -> instrumental MP3 + CDG (+ timing.json, .lrc)")
    m.add_argument("song", help="input audio (MP3, FLAC, WAV, M4A, ...) or a YouTube URL")
    m.add_argument("-l", "--lyrics", help="plain-text lyrics, one line per sung line (recommended)")
    m.add_argument("-o", "--out", help="output folder (default: next to the song)")
    m.add_argument("--title")
    m.add_argument("--artist")
    m.add_argument("--language", help="lyrics language code, e.g. en, fi (default: en / auto)")
    m.add_argument("--model", default="htdemucs",
                   help="Demucs model: htdemucs (default), htdemucs_ft (better, 4x slower)")
    m.add_argument("--shifts", type=int, default=1, help="Demucs shifts (more = better, slower)")
    m.add_argument("--whisper-model", default="medium",
                   help="Whisper model: small, medium (default), large-v3, ...")
    m.add_argument("--device", default="auto", help="cuda, cpu, mps (default: auto)")
    m.add_argument("--models-dir", help="models folder (default: $AUTOKARAOKE_MODELS or "
                   "~/.local/share/autokaraoke/models)")
    m.add_argument("--lookup-lyrics", action="store_true",
                   help="when no --lyrics is given, look the lyrics up (see --lyrics-sources; default "
                   "sources) and treat them as the authority on the words; Whisper times and checks them")
    m.add_argument("--lyrics-sources", metavar="A,B",
                   help="where to look, in order (implies --lookup-lyrics): "
                   + ", ".join(lyrics_lookup.SOURCES) + ". Default: "
                   + ", ".join(lyrics_lookup.DEFAULT_SOURCES))
    m.add_argument("--lyrics-min-match", type=float, default=0.35, metavar="0..1",
                   help="a lookup that Whisper hears less of than this is ignored as a different "
                   "version or song (default 0.35)")
    m.add_argument("--keep-sections", action="store_true",
                   help="keep [Chorus]-style lines from the lyrics file")
    m.add_argument("--keep-stems", action="store_true", help="keep vocals/instrumental WAVs")
    m.add_argument("--retime", action="store_true", help="redo lyrics timing even if timing.json exists")
    m.add_argument("--force", action="store_true", help="redo everything")
    _add_render_opts(m)
    m.set_defaults(func=cmd_make)

    ly = sub.add_parser("lyrics", help="show what each lyrics source has for a song")
    ly.add_argument("artist")
    ly.add_argument("title")
    ly.add_argument("--duration", type=float, default=0.0, help="song length in s (picks the right version)")
    ly.add_argument("--sources", metavar="A,B", help="sources to ask (default: all)")
    ly.add_argument("--show", action="store_true", help="print the lyrics found")
    ly.add_argument("--models-dir", help="models folder (the lyrics cache lives in it)")
    ly.set_defaults(func=cmd_lyrics)

    st = sub.add_parser("setup", help="download the models once, for offline use (shows disk usage)")
    st.add_argument("--whisper-model", action="append",
                    help="Whisper model(s) to get (default: medium); repeat for several")
    st.add_argument("--demucs-model", action="append",
                    help="Demucs model(s) to get (default: htdemucs); repeat for several")
    st.add_argument("--models-dir", help="models folder (default: $AUTOKARAOKE_MODELS or "
                    "~/.local/share/autokaraoke/models)")
    st.add_argument("--check", action="store_true", help="only report what is downloaded")
    st.set_defaults(func=cmd_setup)

    f = sub.add_parser("fetch", help="download songs or music videos from YouTube (yt-dlp)")
    f.add_argument("urls", nargs="+", help="video or playlist URLs")
    f.add_argument("-o", "--out", help="output folder (default: current folder)")
    f.add_argument("--video", action="store_true",
                   help="download the video (MP4, up to 1080p) instead of just the audio")
    f.add_argument("--playlist", action="store_true", help="download every video of a playlist URL")
    f.set_defaults(func=cmd_fetch)

    r = sub.add_parser("render", help="re-render the CDG from an (edited) timing.json")
    r.add_argument("timing", help="NAME.timing.json")
    r.add_argument("--audio", help="the instrumental MP3 (default: NAME.mp3 next to the json)")
    r.add_argument("-O", "--output", help="CDG path (default: next to the MP3)")
    _add_render_opts(r)
    r.set_defaults(func=cmd_render)


    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
