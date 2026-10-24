// A stand-in for autokaraoke (tests, and OPENKARAOKE_FAKE_MAKER=1 to try the Karaoke maker page
// by hand): the same tool interface as autokaraokeTool() in ./autokaraoke.js. "make" writes a
// real karaoke pair — the song's own MP3 (or a tone), a word-timed timing.json and a CDG drawn
// from it — and prints autokaraoke's messages; "render" redraws the CDG from a timing.json.
// Uses the test CDG writer in scripts/lib (imported only here, and only when asked for).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CdgWriter, drawText, centeredX, textWidth } from '../../scripts/lib/cdg-writer.js';
import { wrapLine } from '../../scripts/make-demo-library.js';
import { CDG_VISIBLE_Y } from '../../shared/cdg.js';
import { writePcmWav } from '../stems/wav.js';
import { readTiming, timingToLrc } from '../../shared/timing.js';

const PALETTE = [[0, 0, 3], [15, 15, 15], [15, 11, 0], [0, 0, 0], [15, 11, 0], [11, 13, 15]];
const BG = 0;
const UNSUNG = 1;
const SUNG = 2;
const OUTLINE = 3;
const TITLE = 4;
const ARTIST = 5;
const PAGE_ROWS = 4;
const PAGE_GAP = 8;
const LEAD = 1.5;

/**
 * A CDG for a timing.json song (autokaraoke's format): pages of up to four rows, each word wiped
 * over its own start → end. `duration` seconds long (the MP3's length).
 */
export function cdgFromTiming(song, duration) {
  const w = new CdgWriter();
  w.loadColors(PALETTE);
  w.memoryPreset(BG, 2);
  w.borderPreset(BG);
  const frame = new Uint8Array(w.screen.length);
  frame.fill(BG);
  if (song.title) drawText(frame, song.title, centeredX(song.title), 84, TITLE, { shadowColor: OUTLINE });
  if (song.artist) drawText(frame, song.artist, centeredX(song.artist), 114, ARTIST, { shadowColor: OUTLINE });
  w.drawFrame(frame);
  // Rows: a line wraps into one or two; each row keeps its words' times and x positions.
  const rows = [];
  for (const line of song.lines) {
    const text = line.words.map((x) => x.text).join(' ');
    let wi = 0;
    for (const rowText of wrapLine(text)) {
      const n = rowText.split(' ').length;
      const words = line.words.slice(wi, wi + n);
      wi += n;
      const x = centeredX(rowText);
      let cx = x;
      const spans = words.map((word, i) => {
        const span = { x0: cx, x1: cx + textWidth(word.text), start: word.start, end: word.end };
        cx += textWidth(word.text + (i < words.length - 1 ? ' ' : ''));
        return span;
      });
      if (spans.length) rows.push({ text: rowText, x, spans, start: spans[0].start, end: spans.at(-1).end });
    }
  }
  const pages = [];
  for (const row of rows) {
    const page = pages.at(-1);
    if (page && page.length < PAGE_ROWS && row.start - page.at(-1).end < PAGE_GAP) page.push(row);
    else pages.push([row]);
  }
  const wipeAt = (row, t) => {
    let hx = -1;
    for (const s of row.spans) {
      if (t >= s.end) hx = s.x1;
      else if (t > s.start) hx = s.x0 + Math.round(((t - s.start) / Math.max(0.01, s.end - s.start)) * (s.x1 - s.x0));
    }
    return hx;
  };
  const draw = (page, t) => {
    frame.fill(BG);
    page.forEach((row, k) => drawText(frame, row.text, row.x, CDG_VISIBLE_Y + 22 + k * 42, UNSUNG, { highlightX: wipeAt(row, t), highlightColor: SUNG, shadowColor: OUTLINE }));
    w.drawFrame(frame);
  };
  for (const page of pages) {
    const from = Math.max(w.time, page[0].start - LEAD);
    if (from >= duration) break;
    w.padTo(from);
    draw(page, -1);
    for (let t = page[0].start; t <= page.at(-1).end + 0.1 && t < duration; t += 0.1) {
      w.padTo(Math.max(w.time, t));
      draw(page, t);
    }
  }
  w.padTo(Math.max(w.time, duration));
  return w.toBuffer();
}

/** Words for a song's lyrics, spread evenly from 3 s: 2.5 s a line (a stand-in for Whisper's timing). */
export function fakeTiming(lyrics, { title = '', artist = '', language = 'en', duration = 30 } = {}) {
  const lines = String(lyrics || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^\s*[[{].*[\]}]\s*$/.test(l));
  const texts = lines.length ? lines : ['La la la la', 'Na na na na na'];
  const per = Math.min(2.5, Math.max(0.8, (duration - 4) / texts.length));
  return {
    version: 1, title, artist, language, duration,
    lines: texts.map((text, i) => {
      const words = text.split(/\s+/);
      const t0 = 3 + i * per;
      const step = (per * 0.85) / words.length;
      return { words: words.map((word, k) => ({ text: word, start: +(t0 + k * step).toFixed(3), end: +(t0 + (k + 1) * step - 0.05).toFixed(3) })) };
    }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The stand-in tool. `state`: installed, models ready, the GPU's name ('' = none), and `fail`
 * ('make' | 'render' | 'setup' | 'install') to make that command fail. `seconds`: how long a make takes.
 */
export function fakeAutokaraoke({ root = '/home/you/.local/share/openkaraoke/autokaraoke', legacy = '', installed = true, models = true, gpu = '', gpuMB = 8192, cores = 8, memGB = 16, freeGB = 120, fail = '', seconds = 1.5, songSeconds = 30, lookup = true, lookupHit = 'Found on the internet\nAll the words are here' } = {}) {
  const state = { installed, models, gpu, gpuMB, cores, memGB, freeGB, fail, seconds, songSeconds, lookup, lookupHit, runs: [] };
  const where = () => ({
    root, python: path.join(root, '.venv', 'bin', 'python'), launcher: '', modelsDir: path.join(root, 'models'),
    hasRoot: true, installed: state.installed, installer: '/opt/OpenKaraoke/maker/install.sh', source: '/opt/OpenKaraoke/maker',
    bundled: '0.2.0', legacy: state.installed ? legacy : '', legacyModels: legacy ? path.join(legacy, 'models') : '',
  });
  return {
    state,
    async locate() { return where(); },

    async check(at, { whisperModel = 'medium', demucsModel = 'htdemucs' } = {}) {
      return {
        python: '3.12.3', ffmpeg: 'ready', gpu: state.gpu, version: state.installed ? '0.2.0' : '', update: false,
        specs: { gpus: state.gpu ? [{ name: state.gpu, memMB: state.gpuMB }] : [], cores: state.cores, memGB: state.memGB, freeGB: state.freeGB },
        features: { lookup: state.installed && state.lookup },
        setup: state.installed ? {
          folder: path.join(root, 'models'),
          models: [
            { kind: 'demucs', name: demucsModel, size: state.models ? '80 MB' : '', ready: state.models },
            { kind: 'whisper', name: whisperModel, size: state.models ? '1.5 GB' : '', ready: state.models },
          ],
          total: state.models ? '1.6 GB' : '0 KB', software: '2.3 GB', offline: state.models,
        } : null,
      };
    },

    start(at, kind, opts = {}) {
      let cancelled = false;
      const say = (line) => { if (!cancelled) opts.onLine?.(line); };
      const bar = (s) => { if (!cancelled) opts.onStatus?.(s); };
      const { onLine, onStatus, ...rest } = opts;
      state.runs.push({ kind, opts: rest });
      const step = state.seconds * 1000 / 8;
      const done = (async () => {
        if (kind === 'install') {
          for (const l of ['==> Creating the Python environment', '==> Installing PyTorch (CPU-only build)', '==> Installing autokaraoke and its dependencies (ml,youtube)', '==> Downloading the models (once)']) {
            await sleep(step);
            say(l);
          }
          if (cancelled) return { code: null, signal: 'SIGTERM' };
          if (state.fail === 'install') return { code: 1, signal: null };
          state.installed = true;
          state.models = true;
          say('==> Done');
          return { code: 0, signal: null };
        }
        if (kind === 'setup') {
          await sleep(step);
          say(`Downloading Whisper '${opts.whisperModel || 'medium'}' (1.5 GB)...`);
          await sleep(step);
          if (cancelled) return { code: null, signal: 'SIGTERM' };
          if (state.fail === 'setup') return { code: 1, signal: null };
          state.models = true;
          say('Offline: ready.');
          return { code: 0, signal: null };
        }
        if (kind === 'render') {
          await sleep(step);
          if (cancelled) return { code: null, signal: 'SIGTERM' };
          if (state.fail === 'render') {
            say('ValueError: bad timing');
            return { code: 1, signal: null };
          }
          const song = readTiming(JSON.parse(await fs.readFile(opts.timing, 'utf8')));
          say(`CDG: ${song.lines.length} screen lines on 1 pages, font 20px (DejaVuSansCondensed-Bold.ttf), 0.1s`);
          const st = await fs.stat(opts.audio).catch(() => null);
          const duration = song.duration || (st ? state.songSeconds : 30);
          await fs.writeFile(opts.output, cdgFromTiming(song, duration));
          // (as autokaraoke: NAME.timing.json → NAME.lrc, any other name → its stem + .lrc)
          const name = path.basename(opts.timing);
          const stem = name.endsWith('.timing.json') ? name.slice(0, -'.timing.json'.length) : name.replace(/\.[^.]*$/, '');
          await fs.writeFile(path.join(path.dirname(opts.timing), `${stem}.lrc`), timingToLrc(song));
          say(`Wrote ${opts.output}`);
          return { code: 0, signal: null };
        }
        // make
        const isUrl = /^https?:/.test(opts.song);
        const names = { artist: opts.artist || 'Unknown', title: opts.title || 'Song' };
        const base = `${names.artist} - ${names.title}`.replace(/[\\/:*?"<>|]/g, '_');
        if (isUrl) {
          for (const p of [10, 55, 100]) {
            await sleep(step / 2);
            say(`[download] ${p}.0% of 4.12MiB`);
          }
        }
        say(`${names.artist} - ${names.title}  (${state.songSeconds}s)`);
        await sleep(step);
        say(`Separating vocals with ${opts.demucsModel || 'htdemucs'} on ${state.gpu ? 'cuda' : 'cpu'}...`);
        for (const p of [20, 60, 100]) {
          await sleep(step);
          bar(`${p}%|${'█'.repeat(p / 10)}${' '.repeat(10 - p / 10)}| ${p}/100`);
        }
        if (cancelled) return { code: null, signal: 'SIGTERM' };
        await fs.mkdir(opts.out, { recursive: true });
        const mp3 = path.join(opts.out, `${base}.mp3`);
        if (!isUrl && /\.mp3$/i.test(opts.song)) await fs.copyFile(opts.song, mp3);
        else await writePcmWav(mp3, { hz: 330, seconds: state.songSeconds }); // (WAV bytes: browsers sniff it)
        say(`Instrumental: ${mp3}`);
        await sleep(step);
        if (state.fail === 'make') {
          say('RuntimeError: alignment failed; check that the lyrics match the song');
          return { code: 1, signal: null };
        }
        let lyrics = opts.lyricsFile ? await fs.readFile(opts.lyricsFile, 'utf8') : '';
        if (!lyrics && opts.lyricsSources?.length) { // (autokaraoke's lyrics lookup)
          say(`Looking for lyrics: ${opts.lyricsSources.join(', ')}...`);
          if (state.lookupHit && opts.lyricsSources.includes('lrclib')) {
            lyrics = state.lookupHit;
            say(`  LRCLIB: ${lyrics.split('\n').length} lines (${names.artist} - ${names.title})`);
            await fs.writeFile(path.join(opts.out, `${base}.lyrics.txt`), `${lyrics}\n`);
            say(`  used the lyrics from LRCLIB, saved in ${base}.lyrics.txt; edit them and re-run with --lyrics ... --retime to fix words.`);
          } else say('  no lyrics found; transcribing instead.');
        } else {
          say(lyrics ? `Aligning ${lyrics.split(/\s+/).filter(Boolean).length} words of lyrics to the vocals...` : 'No lyrics given: transcribing the vocals (check the result, Whisper mishears songs)...');
        }
        await sleep(step);
        if (cancelled) return { code: null, signal: 'SIGTERM' };
        const timing = fakeTiming(lyrics, { ...names, language: opts.language, duration: state.songSeconds });
        const timingPath = path.join(opts.out, `${base}.timing.json`);
        await fs.writeFile(timingPath, `${JSON.stringify(timing, null, 1)}\n`);
        say(`Timing: ${timingPath}`);
        await fs.writeFile(path.join(opts.out, `${base}.lrc`), timingToLrc(readTiming(timing)));
        await sleep(step);
        await fs.writeFile(path.join(opts.out, `${base}.cdg`), cdgFromTiming(readTiming(timing), state.songSeconds));
        say(`CDG: ${timing.lines.length} screen lines on 1 pages, font 20px (DejaVuSansCondensed-Bold.ttf), 0.2s`);
        if (opts.keepStems) { // (--keep-stems: NAME.work/vocals.wav and instrumental.wav stay)
          const work = path.join(opts.out, `${base}.work`);
          await fs.mkdir(work, { recursive: true });
          await writePcmWav(path.join(work, 'vocals.wav'), { hz: 880, seconds: 2 });
          await writePcmWav(path.join(work, 'instrumental.wav'), { hz: 220, seconds: 2 });
        }
        say(`Done: ${base}.mp3 + ${base}.cdg`);
        return { code: 0, signal: null };
      })();
      return {
        done,
        cancel() { cancelled = true; },
      };
    },
  };
}
