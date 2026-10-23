// The owner's autokaraoke (blearymoth/SongGetter, PLAN §31), installed on this PC in
// ~/Projects/autokaraoke: it turns a song (a file, or a YouTube link) into an MP3 + CDG karaoke
// pair, and redraws a CDG from an edited timing.json. OpenKaraoke runs its command line — never
// a shell, every value its own argument — and reads its output for the progress; the Karaoke
// maker page (Settings) replaces its GTK windows. Node imports no Python and no ML: the heavy
// part stays in autokaraoke's own environment (<root>/.venv).
//
// Pure helpers (argument lists, progress, the setup check) are exported for the tests; the
// tool itself is `autokaraokeTool()` (server/start.js), or a stand-in (server/maker/fake.js).
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { locateAutokaraoke } from './where.js';
import { gatherSpecs } from '../system/specs.js';

export { locateAutokaraoke, rootFromLauncher } from './where.js';

export const THEMES = ['classic', 'blue', 'green'];
export const WHISPER_MODELS = ['small', 'medium', 'turbo', 'large-v3'];
export const DEMUCS_MODELS = ['htdemucs', 'htdemucs_ft'];
/** Where autokaraoke can look lyrics up (its lyrics_lookup.SOURCES; `make --lyrics-sources`). */
export const LYRICS_SOURCES = ['sidecar', 'lrclib', 'netease', 'lyricsovh'];
/** What a song file may be (anything ffmpeg decodes that people keep music in). */
export const SONG_EXTS = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'mp4', 'm4v', 'mkv', 'webm', 'mov']);
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const MAX_NAME = 120;

/** "Artist - Title.mp3" → { artist, title } (as autokaraoke's window guesses them). */
export function guessNames(file) {
  const stem = path.basename(String(file || '')).replace(/\.[^.]+$/, '');
  const i = stem.indexOf(' - ');
  if (i > 0) return { artist: stem.slice(0, i).trim(), title: stem.slice(i + 3).trim() };
  return { artist: '', title: stem.trim() };
}

/** A name for autokaraoke's --artist / --title: one line, no control characters, ≤ 120. */
export function cleanName(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
}

/** An http(s) link (YouTube or another site yt-dlp knows), or ''. */
export function cleanUrl(v) {
  if (typeof v !== 'string' || v.length > 2000 || /\s/.test(v.trim())) return '';
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function isSongFile(name) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ''));
  return !!m && SONG_EXTS.has(m[1].toLowerCase());
}

/**
 * `python -m autokaraoke make …` (options first, then `--` and the song, so a name that starts
 * with "-" is never an option). Throws on a value that is not allowed.
 */
export function makeArgs({ song, out, lyricsFile = '', artist = '', title = '', language = 'en', theme = 'classic', whisperModel = 'medium', demucsModel = 'htdemucs', lyricsSources = [], keepStems = false }) {
  if (typeof song !== 'string' || !song) throw new Error('No song');
  if (!cleanUrl(song) && !path.isAbsolute(song)) throw new Error('The song must be a file path or a link');
  if (typeof out !== 'string' || !path.isAbsolute(out)) throw new Error('The save folder must be an absolute path');
  if (!THEMES.includes(theme)) throw new Error('Unknown colours');
  if (!WHISPER_MODELS.includes(whisperModel)) throw new Error('Unknown lyric timer model');
  if (!DEMUCS_MODELS.includes(demucsModel)) throw new Error('Unknown vocal remover model');
  if (!LANGUAGE_RE.test(language)) throw new Error('Unknown language');
  const args = ['-m', 'autokaraoke', 'make', '--out', out, '--theme', theme, '--language', language,
    '--whisper-model', whisperModel, '--model', demucsModel];
  if (lyricsFile) {
    if (!path.isAbsolute(lyricsFile)) throw new Error('Bad lyrics file');
    // Typed lyrics are the authority: --retime, or a timing.json left from an earlier make of the
    // same song would be used instead of them.
    args.push('--lyrics', lyricsFile, '--retime');
  } else if (lyricsSources.length) {
    if (!lyricsSources.every((x) => LYRICS_SOURCES.includes(x))) throw new Error('Unknown lyrics source');
    args.push('--lyrics-sources', lyricsSources.join(','));
  }
  if (keepStems) args.push('--keep-stems');
  const a = cleanName(artist);
  const t = cleanName(title);
  if (a) args.push('--artist', a);
  if (t) args.push('--title', t);
  args.push('--', song);
  return args;
}

/** `python -m autokaraoke render <timing.json> --audio <mp3> -O <cdg> [--theme …]`. */
export function renderArgs({ timing, audio, output, theme = '' }) {
  for (const p of [timing, audio, output]) if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Render needs absolute paths');
  const args = ['-m', 'autokaraoke', 'render', '--audio', audio, '-O', output];
  if (theme) {
    if (!THEMES.includes(theme)) throw new Error('Unknown colours');
    args.push('--theme', theme);
  }
  args.push('--', timing);
  return args;
}

/** `python -m autokaraoke setup [--check] --whisper-model … --demucs-model …`. */
export function setupArgs({ check = false, whisperModel = 'medium', demucsModel = 'htdemucs' } = {}) {
  if (!WHISPER_MODELS.includes(whisperModel) || !DEMUCS_MODELS.includes(demucsModel)) throw new Error('Unknown model');
  return ['-m', 'autokaraoke', 'setup', ...(check ? ['--check'] : []), '--whisper-model', whisperModel, '--demucs-model', demucsModel];
}

/** install.sh's options: the graphics card or the processor, YouTube or not. */
export function installArgs(script, { gpu = false, youtube = true } = {}) {
  if (typeof script !== 'string' || !path.isAbsolute(script)) throw new Error('No installer');
  return [script, gpu ? '--gpu' : '--cpu', ...(youtube ? [] : ['--no-youtube'])];
}

/**
 * Output in chunks → whole lines and progress-bar updates (a carriage return redraws a bar: a
 * status, not a line), as autokaraoke's own window does (job.split_progress).
 */
export function splitProgress(pending, data) {
  let rest = pending + data;
  const lines = [];
  let status = null;
  for (;;) {
    const nl = rest.indexOf('\n');
    const cr = rest.indexOf('\r');
    if (nl === -1 && cr === -1) break;
    if (cr !== -1 && (nl === -1 || cr < nl)) {
      const piece = rest.slice(0, cr).trim();
      rest = rest.slice(cr + 1);
      if (piece) status = piece;
    } else {
      const piece = rest.slice(0, nl).replace(/\r$/, '').trimEnd();
      rest = rest.slice(nl + 1);
      if (piece.trim()) lines.push(piece);
    }
  }
  return { pending: rest, lines, status };
}

/** The steps of making a song, in order (the page shows them). */
export const MAKE_STAGES = ['download', 'separate', 'mp3', 'timing', 'cdg', 'done'];

/**
 * One line (or status) of `autokaraoke make` → what changed: `{ stage, percent, mp3, cdg, timing, duration }`
 * (only the keys it tells). Matches autokaraoke's own messages (cli.py, separate.py, align.py).
 */
export function readMakeLine(text, { status = false } = {}) {
  const s = String(text || '').trim();
  const out = {};
  const pct = /(\d{1,3}(?:\.\d+)?)%/.exec(s);
  if (/^\[(?:download|youtube|info)\]/i.test(s) || /^Downloading (?!Demucs|Whisper)/.test(s)) {
    out.stage = 'download';
    if (pct) out.percent = Math.min(100, Number(pct[1]));
    return out;
  }
  if (status) { // a progress bar (Demucs's tqdm while separating, Whisper's while timing)
    if (pct) out.percent = Math.min(100, Number(pct[1]));
    return out;
  }
  let m;
  if ((m = /\((\d+)s\)\s*$/.exec(s)) && / - |\?/.test(s)) out.duration = Number(m[1]);
  if (/^Looking for lyrics:/.test(s)) return { stage: 'timing', lyricsFrom: 'looking' };
  if ((m = /^used the lyrics from (.+?), saved in /.exec(s))) return { lyricsFrom: m[1].slice(0, 40) };
  if (/^no lyrics found; transcribing instead|^No lyrics given: transcribing/.test(s)) return { stage: 'timing', lyricsFrom: 'whisper' };
  if (/^Separating vocals with|^Using cached stems/.test(s)) Object.assign(out, { stage: 'separate', percent: /^Using cached/.test(s) ? 100 : 0 });
  else if ((m = /^Instrumental: (.+\.mp3)$/.exec(s))) Object.assign(out, { stage: 'timing', percent: 0, mp3: m[1] });
  else if (/^(?:Loading Whisper model|Downloading Whisper model|Aligning \d+ words|No lyrics given|Using existing .*timing\.json)/.test(s)) out.stage = 'timing';
  else if ((m = /^Timing: (.+\.timing\.json)$/.exec(s))) Object.assign(out, { stage: 'cdg', percent: 0, timing: m[1] });
  else if (/^CDG: /.test(s)) out.stage = 'cdg';
  else if ((m = /^Done: (.+\.mp3) \+ (.+\.cdg)$/.exec(s))) Object.assign(out, { stage: 'done', percent: 100, mp3Name: m[1], cdgName: m[2] });
  return out;
}

/**
 * `autokaraoke setup --check` → `{ models: [{ kind, name, size, ready }], total, software, offline, folder }`.
 * Lines like "  Demucs  htdemucs           80 MB   ready" and "Offline: ready. …".
 */
export function readSetupCheck(text) {
  const out = { models: [], total: '', software: '', offline: false, folder: '' };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = /^(Demucs|Whisper)\s+(\S+)\s+(.*?)\s*(ready|MISSING)$/.exec(line))) {
      out.models.push({ kind: m[1].toLowerCase(), name: m[2], size: m[3].trim(), ready: m[4] === 'ready' });
    } else if ((m = /^models total\s+(.+)$/.exec(line))) out.total = m[1].trim();
    else if ((m = /^Software \(Python environment .*\): (.+)$/.exec(line))) out.software = m[1].trim();
    else if ((m = /^Models folder: (.+)$/.exec(line))) out.folder = m[1].trim();
    else if (/^Offline: ready/.test(line)) out.offline = true;
  }
  return out;
}

/** "GPU 0: NVIDIA GeForce RTX 3080 (UUID: …)" → "NVIDIA GeForce RTX 3080" (as autokaraoke's installer). */
export function gpuNameOf(text) {
  const first = String(text || '').trim().split('\n')[0] || '';
  let name = first.includes(':') ? first.slice(first.indexOf(':') + 1).trim() : first;
  if (name.includes(' (')) name = name.slice(0, name.indexOf(' ('));
  return name.trim();
}

function run(file, args, { timeout = 30000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || ''), err: String(stderr || ''), missing: err?.code === 'ENOENT' });
    });
  });
}

/**
 * The real tool. `check()` looks at this computer and the install; `start(kind, opts)` runs one
 * of make / render / setup / install and streams its output: → { done: Promise<{ code, signal }>, cancel() }.
 */
export function autokaraokeTool({ env = process.env, homedir = os.homedir() } = {}) {
  const childEnv = (where, extra = {}) => {
    const e = { ...env, PYTHONUNBUFFERED: '1', ...extra };
    if (where.modelsDir) e.AUTOKARAOKE_MODELS = where.modelsDir;
    return e;
  };
  return {
    locate: () => locateAutokaraoke({ env, homedir }),

    async check(where, { whisperModel = 'medium', demucsModel = 'htdemucs' } = {}) {
      const [py, ff, specs] = await Promise.all([
        run(where.installed ? where.python : 'python3', ['--version']),
        run('ffmpeg', ['-hide_banner', '-encoders']),
        gatherSpecs({ run: (f, a) => run(f, a, { timeout: 8000 }), diskPaths: [where.modelsDir, where.root, homedir] }),
      ]);
      const out = {
        python: py.code === 0 ? (py.out || py.err).trim().replace(/^Python\s+/, '') : '',
        ffmpeg: ff.missing ? 'missing' : /libmp3lame/.test(ff.out + ff.err) ? 'ready' : 'no-mp3',
        gpu: [...specs.gpus].sort((a, b) => b.memMB - a.memMB)[0]?.name || '',
        specs,
        version: '',
        setup: null,
      };
      if (where.installed) {
        const e = childEnv(where);
        const [ver, setup] = await Promise.all([
          run(where.python, ['-m', 'autokaraoke', '--version'], { env: e }),
          run(where.python, setupArgs({ check: true, whisperModel, demucsModel }), { env: e, timeout: 60000 }),
        ]);
        out.version = (ver.out || ver.err).trim().split('\n')[0].slice(0, 40);
        out.setup = readSetupCheck(setup.out);
        // What this copy can do: looking lyrics up came with its lyrics-lookup version.
        const help = await run(where.python, ['-m', 'autokaraoke', 'make', '--help'], { env: e });
        out.features = { lookup: /--lyrics-sources/.test(help.out + help.err) };
      }
      return out;
    },

    start(where, kind, opts = {}) {
      let file;
      let args;
      let cwd;
      let extra = {};
      if (kind === 'install') {
        file = 'bash';
        args = installArgs(where.installer, opts);
        cwd = where.root;
      } else {
        file = where.python;
        args = kind === 'make' ? makeArgs(opts) : kind === 'render' ? renderArgs(opts) : setupArgs(opts);
        // A long job on the party PC: fewer threads, so the TV's sound and drawing keep theirs.
        const threads = String(Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 2));
        if (kind === 'make') extra = { OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads };
      }
      const child = spawn(file, args, { cwd, env: childEnv(where, extra), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      if (kind === 'make' || kind === 'render') {
        try { os.setPriority(child.pid, 19); } catch { /* not allowed: normal priority */ }
      }
      let pending = '';
      const feed = (chunk) => {
        const r = splitProgress(pending, String(chunk));
        pending = r.pending;
        for (const line of r.lines) opts.onLine?.(line);
        if (r.status) opts.onStatus?.(r.status);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      const done = new Promise((resolve) => {
        child.on('error', (e) => {
          opts.onLine?.(e.code === 'ENOENT' ? `${file} was not found` : String(e.message));
          resolve({ code: -1, signal: null });
        });
        child.on('close', (code, signal) => {
          if (pending.trim()) opts.onLine?.(pending.trim());
          resolve({ code, signal });
        });
      });
      return {
        done,
        cancel() {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
        },
      };
    },
  };
}
