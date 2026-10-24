// autokaraoke's timed lyrics (PLAN §31.5), isomorphic: the `NAME.timing.json` it writes next to a
// karaoke pair it made, and what the lyrics editor does to it. The same rules as autokaraoke's
// timing.py and align.py, so a file this edits renders there exactly as one it wrote:
//
//   { "version": 1, "title", "artist", "language", "duration",
//     "lines": [ { "words": [ { "text": "Hello", "start": 12.3, "end": 12.71 }, … ] }, … ],
//     "render": { "theme", "lines_on_screen", "font_size", "outline", "lead", "page_gap" } }
//
// Times are seconds from the start of the audio. "render" (optional) is how autokaraoke drew the
// CDG; an edit keeps it, so a redraw looks like the original. Other fields are ignored.

export const MAX_LINES = 1500;
export const MAX_WORDS = 15000;
const MAX_WORD = 80;
const SECTION_RE = /^\s*[[{].*[\]}]\s*$/; // [Chorus], {Verse 2}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n) => Math.round(n * 1000) / 1000;
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

/**
 * Sane times, as autokaraoke's `clean()`: empty words and lines dropped, lines in order of their
 * first word, every time ≥ 0 and end ≥ start, and a word that starts before the one before it
 * ended (by more than 50 ms) pushed forward.
 */
export function cleanTiming(song) {
  let lines = song.lines
    .map((l) => ({ words: l.words.filter((w) => w.text.trim()).map((w) => ({ text: w.text.trim(), start: Math.max(0, num(w.start)), end: num(w.end) })) }))
    .filter((l) => l.words.length);
  for (const l of lines) for (const w of l.words) w.end = Math.max(w.end, w.start);
  lines = lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.words[0].start - b.l.words[0].start || a.i - b.i).map((x) => x.l);
  let prevEnd = 0;
  for (const l of lines) {
    for (const w of l.words) {
      if (w.start < prevEnd - 0.05) {
        const shift = prevEnd - w.start;
        w.start += shift;
        w.end = Math.max(w.end, w.start);
      }
      prevEnd = Math.max(prevEnd, w.end);
    }
  }
  return { ...song, lines };
}

/** autokaraoke's "render" keys and their kinds (timing.py RENDER_KEYS). */
const RENDER_KEYS = { theme: 'str', lines_on_screen: 'int', font_size: 'int', outline: 'int', lead: 'num', page_gap: 'num' };

/** A timing.json's "render" value → its known, well-typed options, or null. */
export function renderOptions(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  for (const [key, kind] of Object.entries(RENDER_KEYS)) {
    const v = d[key];
    if (kind === 'str') { if (typeof v === 'string' && /^[a-z][\w-]{0,30}$/.test(v)) out[key] = v; }
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000 && (kind === 'num' || Number.isInteger(v))) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** A parsed timing.json (anything else throws), cleaned. */
export function readTiming(d) {
  if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.lines)) throw new Error('Not an autokaraoke timing file (version 1)');
  if (d.lines.length > MAX_LINES) throw new Error('Too many lines');
  let words = 0;
  const lines = d.lines.map((l) => {
    const list = Array.isArray(l?.words) ? l.words : [];
    words += list.length;
    if (words > MAX_WORDS) throw new Error('Too many words');
    return { words: list.map((w) => ({ text: str(w?.text, MAX_WORD), start: num(w?.start), end: num(w?.end) })) };
  });
  const render = renderOptions(d.render);
  return cleanTiming({
    title: str(d.title, 200), artist: str(d.artist, 200), language: str(d.language, 12), duration: Math.max(0, num(d.duration)), lines,
    ...(render ? { render } : {}),
  });
}

/** The file autokaraoke reads back (times to the millisecond). */
export function timingJson(song) {
  return {
    version: 1,
    title: song.title || '',
    artist: song.artist || '',
    language: song.language || '',
    duration: round3(song.duration || 0),
    lines: song.lines.map((l) => ({ words: l.words.map((w) => ({ text: w.text, start: round3(w.start), end: round3(w.end) })) })),
    ...(song.render ? { render: { ...song.render } } : {}),
  };
}

const lrcTime = (t) => {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

/** Enhanced (word-timed) LRC, as autokaraoke's to_lrc. */
export function timingToLrc(song) {
  const out = [];
  if (song.title) out.push(`[ti:${song.title}]`);
  if (song.artist) out.push(`[ar:${song.artist}]`);
  for (const l of song.lines) {
    const parts = [`[${lrcTime(l.words[0].start)}]`];
    for (const w of l.words) parts.push(`<${lrcTime(w.start)}> ${w.text}`);
    parts.push(`<${lrcTime(l.words.at(-1).end)}>`);
    out.push(parts.join(' '));
  }
  return `${out.join('\n')}\n`;
}

/** Lyrics text → word lists, one per sung line ([Chorus]-style lines skipped), as autokaraoke reads them. */
export function parseLyrics(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !SECTION_RE.test(l)).map((l) => l.split(/\s+/));
}

/** The song's words as text, one line per sung line (what the editor's text box shows). */
export function timingText(song) {
  return song.lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n');
}

const normChars = (text) => [...String(text).toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));

/** Pairs [i, j] of a longest common subsequence of two short arrays (dynamic programming). */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

const LCS_MAX = 6000; // characters a side (≈36M cells): longer goes line by line

/**
 * New words, old times (autokaraoke's align.transfer_timing): every letter or digit of the timed
 * words gets a time, the two character streams are matched, and each new word takes the times of
 * its first and last matched characters; words with nothing matched are spread between their
 * timed neighbours. `lyricLines`: lists of words. `timed`: [{ text, start, end }]. → lines of words.
 */
export function transferTiming(lyricLines, timed) {
  const aChars = [];
  const aTimes = [];
  for (const w of timed) {
    const cs = normChars(w.text);
    cs.forEach((c, k) => {
      aChars.push(c);
      aTimes.push([w.start + ((w.end - w.start) * k) / cs.length, w.start + ((w.end - w.start) * (k + 1)) / cs.length]);
    });
  }
  const flat = lyricLines.flat();
  const lChars = [];
  const owner = [];
  flat.forEach((w, wi) => {
    for (const c of normChars(w)) {
      lChars.push(c);
      owner.push(wi);
    }
  });
  const starts = new Array(flat.length).fill(null);
  const ends = new Array(flat.length).fill(null);
  const match = (li, ai) => {
    const wi = owner[li];
    const [s, e] = aTimes[ai];
    if (starts[wi] === null) starts[wi] = s;
    ends[wi] = e;
  };
  if (lChars.length <= LCS_MAX && aChars.length <= LCS_MAX) {
    for (const [i, j] of lcsPairs(lChars, aChars)) match(i, j);
  } else {
    // Very long: match in windows of the same share of each stream.
    const step = 2000;
    for (let i0 = 0; i0 < lChars.length; i0 += step) {
      const j0 = Math.floor((i0 / lChars.length) * aChars.length);
      const j1 = Math.floor((Math.min(lChars.length, i0 + step) / lChars.length) * aChars.length);
      for (const [i, j] of lcsPairs(lChars.slice(i0, i0 + step), aChars.slice(j0, j1))) match(i0 + i, j0 + j);
    }
  }
  interpolate(starts, ends);
  let k = 0;
  return lyricLines.map((line) => ({ words: line.map((text) => ({ text, start: starts[k], end: ends[k++] })) }));
}

/** Words with no matched characters: spread between their timed neighbours (0.3 s each at the ends). */
function interpolate(starts, ends) {
  const n = starts.length;
  if (!starts.some((s) => s !== null)) {
    for (let i = 0; i < n; i++) {
      starts[i] = i * 0.3;
      ends[i] = starts[i] + 0.3;
    }
    return;
  }
  let i = 0;
  while (i < n) {
    if (starts[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && starts[j] === null) j++;
    const left = i > 0 ? ends[i - 1] : Math.max(0, starts[j] - 0.3 * (j - i));
    const right = j < n ? starts[j] : left + 0.3 * (j - i);
    const step = Math.max(right - left, 0) / (j - i);
    for (let k = i; k < j; k++) {
      starts[k] = left + step * (k - i);
      ends[k] = starts[k] + step;
    }
    i = j;
  }
  for (let k = 0; k < n; k++) if (ends[k] < starts[k]) ends[k] = starts[k];
}

// ---- editing (the lyrics editor; every operation returns a new song, so undo keeps the old) ----

const r3 = (n) => Math.max(0, Math.round(n * 1000) / 1000);
const copy = (song) => ({ ...song, lines: song.lines.map((l) => ({ words: l.words.map((w) => ({ ...w })) })) });

/** Every word in order: [{ li, wi, w }]. */
export function flatWords(song) {
  const out = [];
  song.lines.forEach((l, li) => l.words.forEach((w, wi) => out.push({ li, wi, w })));
  return out;
}

/** The word being sung at `t` — else the last one that started before it — as { li, wi }, or null. */
export function wordAt(song, t) {
  let found = null;
  for (let li = 0; li < song.lines.length; li++) {
    const words = song.lines[li].words;
    for (let wi = 0; wi < words.length; wi++) {
      if (words[wi].start > t) return found;
      found = { li, wi };
    }
  }
  return found;
}

/** The word `dir` words after (or before) { li, wi }, staying inside the song. */
export function stepWord(song, li, wi, dir) {
  const flat = flatWords(song);
  const i = flat.findIndex((x) => x.li === li && x.wi === wi);
  const j = Math.max(0, Math.min(flat.length - 1, (i < 0 ? 0 : i) + dir));
  return flat.length ? { li: flat[j].li, wi: flat[j].wi } : null;
}

/** One word changed (`start`, `end`, `text`); the end never before the start. */
export function setWord(song, li, wi, patch) {
  const next = copy(song);
  const w = next.lines[li]?.words[wi];
  if (!w) return song;
  if (patch.text !== undefined) {
    const text = String(patch.text).replace(/\s+/g, ' ').trim();
    if (text) w.text = text.slice(0, 80);
  }
  if (Number.isFinite(patch.start)) w.start = r3(patch.start);
  if (Number.isFinite(patch.end)) w.end = r3(patch.end);
  if (w.end < w.start) {
    if (Number.isFinite(patch.end) && !Number.isFinite(patch.start)) w.start = w.end;
    else w.end = w.start;
  }
  return next;
}

/** A word's start, end or both moved by `delta` seconds. */
export function nudgeWord(song, li, wi, which, delta) {
  const w = song.lines[li]?.words[wi];
  if (!w) return song;
  if (which === 'start') return setWord(song, li, wi, { start: Math.min(w.end, w.start + delta) });
  if (which === 'end') return setWord(song, li, wi, { end: Math.max(w.start, w.end + delta) });
  return setWord(song, li, wi, { start: w.start + delta, end: w.end + delta });
}

/** Lines `from` … `to` (inclusive) moved by `delta` seconds (never before 0). */
export function shiftLines(song, from, to, delta) {
  const next = copy(song);
  const first = next.lines[from]?.words[0];
  if (!first) return song;
  const d = Math.max(-first.start, delta);
  for (let li = from; li <= Math.min(to, next.lines.length - 1); li++) {
    for (const w of next.lines[li].words) {
      w.start = r3(w.start + d);
      w.end = r3(w.end + d);
    }
  }
  return next;
}

/**
 * Tap along: the key went down as the word began. Its start is `t`; the word before it ends by
 * then; until the key comes up the word lasts at least to its old end (or 0.3 s).
 */
export function tapDown(song, li, wi, t) {
  const w = song.lines[li]?.words[wi];
  if (!w) return song;
  let next = setWord(song, li, wi, { start: t, end: Math.max(t + 0.3, w.end) });
  const prev = stepWord(next, li, wi, -1);
  if (prev && (prev.li !== li || prev.wi !== wi)) {
    const p = next.lines[prev.li].words[prev.wi];
    if (p.end > t - 0.02) next = setWord(next, prev.li, prev.wi, { end: Math.max(p.start, t - 0.02) });
  }
  return next;
}

/** Tap along: the key came up as the word ended (at least 50 ms after it began). */
export function tapUp(song, li, wi, t) {
  const w = song.lines[li]?.words[wi];
  if (!w) return song;
  return setWord(song, li, wi, { end: Math.max(w.start + 0.05, t) });
}

/** A word removed (a line with no words left goes too). */
export function deleteWord(song, li, wi) {
  const next = copy(song);
  next.lines[li]?.words.splice(wi, 1);
  next.lines = next.lines.filter((l) => l.words.length);
  return next;
}
