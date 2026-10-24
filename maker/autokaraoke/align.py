"""Lyrics timing with Whisper via stable-ts: forced alignment of known lyrics, or
transcription when no lyrics are given.

The aligner's word list may tokenise differently from the lyrics file (punctuation,
contractions, merged words), so timings are transferred character by character:
every letter/digit of the aligned words gets a time, the alphanumeric character
streams of both sides are matched with difflib, and each lyric word takes the times
of its first and last matched characters. Unmatched words are interpolated.
"""

import difflib
import re

from .timing import Line, Song, Word

SECTION_RE = re.compile(r"^\s*[\[{].*[\]}]\s*$")  # [Chorus], {Verse 2}


def parse_lyrics(text, keep_sections=False):
    """Lyrics text -> list of word lists (one per non-empty line)."""
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or (not keep_sections and SECTION_RE.match(line)):
            continue
        words = line.split()
        if words:
            lines.append(words)
    return lines


def _norm_chars(text):
    return [c for c in text.lower() if c.isalnum()]


def transfer_timing(lyric_lines, aligned_words):
    """lyric_lines: list of lists of str; aligned_words: list of (text, start, end).
    Returns list of Line with timed Words."""
    # character stream with times from the aligner
    a_chars, a_times = [], []
    for text, start, end in aligned_words:
        cs = _norm_chars(text)
        n = len(cs)
        for k, c in enumerate(cs):
            a_chars.append(c)
            a_times.append((start + (end - start) * k / n, start + (end - start) * (k + 1) / n))
    # character stream of the lyrics, remembering which word each char belongs to
    flat = [w for line in lyric_lines for w in line]
    l_chars, l_owner = [], []
    for wi, w in enumerate(flat):
        for c in _norm_chars(w):
            l_chars.append(c)
            l_owner.append(wi)
    starts, ends = [None] * len(flat), [None] * len(flat)
    sm = difflib.SequenceMatcher(None, l_chars, a_chars, autojunk=False)
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            wi = l_owner[block.a + k]
            s, e = a_times[block.b + k]
            if starts[wi] is None:
                starts[wi] = s
            ends[wi] = e
    _interpolate(starts, ends, flat)
    out, i = [], 0
    for line in lyric_lines:
        words = []
        for w in line:
            words.append(Word(w, starts[i], ends[i]))
            i += 1
        out.append(Line(words))
    return out


def _interpolate(starts, ends, words):
    """Fill words with no matched characters between their timed neighbours."""
    n = len(words)
    known = [i for i in range(n) if starts[i] is not None]
    if not known:
        raise RuntimeError("alignment produced no usable word timings")
    i = 0
    while i < n:
        if starts[i] is not None:
            i += 1
            continue
        j = i
        while j < n and starts[j] is None:
            j += 1
        left = ends[i - 1] if i > 0 else max(0.0, starts[j] - 0.3 * (j - i))
        right = starts[j] if j < n else left + 0.3 * (j - i)
        step = max(right - left, 0.0) / (j - i)
        for k in range(i, j):
            starts[k] = left + step * (k - i)
            ends[k] = starts[k] + step
        i = j
    for k in range(n):
        if ends[k] < starts[k]:
            ends[k] = starts[k]


def load_model(name, device, log=print, mdir=None):
    try:
        import stable_whisper
    except ImportError as e:
        raise SystemExit("Lyrics timing needs stable-ts: pip install 'autokaraoke[ml]'\n"
                         f"({e})")
    from . import models
    mdir = mdir or models.models_dir()
    root = mdir / "whisper"
    if not models.whisper_cached(name, mdir):
        size = models.WHISPER_SIZES.get(name)
        log(f"Downloading Whisper model '{name}'"
            f"{f' ({models.human(size)})' if size else ''} (once) into {root} ...")
    else:
        log(f"Loading Whisper model '{name}' on {device}...")
    try:
        return stable_whisper.load_model(name, device=device, download_root=str(root))
    except (OSError, RuntimeError) as e:
        if not models.whisper_cached(name, mdir):
            raise SystemExit(models.offline_hint(f"Whisper model '{name}'", mdir)) from e
        raise


def _words_of(result):
    return [(w.word, float(w.start), float(w.end)) for w in result.all_words()]


def align(model, vocals16k, lyric_lines, language, log=print):
    """vocals16k: mono float32 numpy at 16 kHz."""
    text = "\n".join(" ".join(line) for line in lyric_lines)
    log(f"Aligning {sum(len(l) for l in lyric_lines)} words of lyrics to the vocals...")
    result = model.align(vocals16k, text, language=language or "en")
    if result is None:
        raise RuntimeError("alignment failed; check that the lyrics match the song")
    return transfer_timing(lyric_lines, _words_of(result))


def transcribe(model, vocals16k, language=None, log=print):
    log("No lyrics given: transcribing the vocals (check the result, Whisper mishears songs)...")
    result = model.transcribe(vocals16k, language=language or None, vad=False)
    try:
        result = result.split_by_gap(0.8).split_by_length(max_chars=42)
    except Exception:  # regrouping is cosmetic; older stable-ts versions differ
        pass
    lines = []
    for seg in result.segments:
        words = [Word(w.word.strip(), float(w.start), float(w.end)) for w in (seg.words or [])
                 if w.word.strip()]
        if words:
            lines.append(Line(words))
    return lines, getattr(result, "language", language or "")


MIN_RUN = 3


def compare(lyric_lines, heard_lines):
    """How much of the lyrics did Whisper hear? -> (overall, [per-line]) as 0..1 shares
    of the lyrics' letters that also occur, in order, in the transcript."""
    heard = [c for line in heard_lines for w in line.words for c in _norm_chars(w.text)]
    l_chars, owner = [], []
    for li, line in enumerate(lyric_lines):
        for w in line:
            for c in _norm_chars(w):
                l_chars.append(c)
                owner.append(li)
    hits = [0] * len(lyric_lines)
    sm = difflib.SequenceMatcher(None, l_chars, heard, autojunk=False)
    for block in sm.get_matching_blocks():
        if block.size < MIN_RUN:        # scattered single letters match by chance, even for
            continue                    # unrelated texts; only real runs of letters count
        for k in range(block.size):
            hits[owner[block.a + k]] += 1
    totals = [0] * len(lyric_lines)
    for li in owner:
        totals[li] += 1
    per = [h / t if t else 1.0 for h, t in zip(hits, totals)]
    overall = sum(hits) / len(l_chars) if l_chars else 0.0
    return overall, per


def lookup_and_align(model, vocals16k, candidates, language, min_match, log=print):
    """Looked-up lyrics are the authority for the words; Whisper supplies the timing and a
    check. `candidates` is [(source name, lyric lines)] in the person's order. Whisper
    transcribes once and the first candidate it hears at least `min_match` of wins: it is
    force-aligned and its words stand wherever Whisper differs. If none fits, they are
    probably other versions or songs, so the transcript is kept.
    -> (lines, language, source name or None, overall match of the winner or best)"""
    lines, heard_lang = transcribe(model, vocals16k, language, log)
    best = 0.0
    for source, lyric_lines in candidates:
        overall, per = compare(lyric_lines, lines)
        best = max(best, overall)
        log(f"Whisper heard {overall:.0%} of the lyrics from {source}.")
        if overall < min_match:
            continue
        missed = [i + 1 for i, r in enumerate(per) if r < 0.5]
        if missed:
            shown = ", ".join(map(str, missed[:12])) + (" ..." if len(missed) > 12 else "")
            log(f"Lines Whisper barely heard (lyrics used as written, timing is a guess there): {shown}")
        timed = align(model, vocals16k, lyric_lines, language or heard_lang, log)
        return timed, language or heard_lang or "en", source, overall
    if candidates:
        log(f"None reached {min_match:.0%}: these look like other versions or songs. Keeping what "
            "Whisper heard instead (paste the right lyrics to override).")
    return lines, heard_lang, None, best


def retime_stretch(song, vocals16k, start, end, align_fn, sr=16000):
    """Re-time only the words that start inside [start, end] against that slice of the vocal
    (mono float32 at `sr`). `align_fn(slice, lyric_lines)` -> timed Lines for those words, with
    times from the slice's start; the offset is added back. The new times stay between the
    untouched words around the stretch, so every other word keeps its time exactly.
    -> the number of words re-timed. The song is changed in place and cleaned."""
    from .timing import clean
    if not (0 <= start < end):
        raise ValueError(f"bad stretch {start}-{end}: --from must be >= 0 and before --to")
    flat = [(li, w) for li, line in enumerate(song.lines) for w in line.words]
    picked = [k for k, (_, w) in enumerate(flat) if start <= w.start <= end]
    if not picked:
        raise ValueError(f"no words start between {start:g} and {end:g} s")
    first, last = picked[0], picked[-1]
    if picked != list(range(first, last + 1)):
        raise ValueError("the words in that stretch are out of order; clean the timing first")
    a = max(0, int(round(start * sr)))
    b = min(len(vocals16k), int(round(end * sr)))
    if b - a < sr // 5:
        raise ValueError(f"the vocal has less than 0.2 s between {start:g} and {end:g} s")
    lyric_lines, li_prev = [], None
    for k in picked:
        li, w = flat[k]
        if li != li_prev:
            lyric_lines.append([])
            li_prev = li
        lyric_lines[-1].append(w.text)
    timed = [w for line in align_fn(vocals16k[a:b], lyric_lines) for w in line.words]
    if len(timed) != len(picked):
        raise RuntimeError(f"the aligner returned {len(timed)} words for {len(picked)}")
    lo = max(start, flat[first - 1][1].end) if first > 0 else start
    hi = min(b / sr, flat[last + 1][1].start) if last + 1 < len(flat) else b / sr
    offset = a / sr
    prev_end = lo
    for k, nw in zip(picked, timed):
        w = flat[k][1]
        s = min(max(float(nw.start) + offset, prev_end), hi)
        e = min(max(float(nw.end) + offset, s), hi)
        w.start, w.end = s, e
        prev_end = e
    clean(song)
    return len(picked)


def build_song(lines, title, artist, language, duration):
    from .timing import clean
    return clean(Song(title, artist, language or "", duration, lines))
