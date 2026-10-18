// Runs autokaraoke's vocal separator (Demucs htdemucs) the way `autokaraoke make` does:
// models.configure() first, then autokaraoke.separate.separate(), then audio.save_wav() for the
// vocal and the rest ("music"). htdemucs can't tell the lead singer from backing singers: on a
// karaoke track the vocal is its backing vocals, on a recording with the singer it is all of them.
// The model is STEM_MODEL (OPENKARAOKE_STEM_MODEL may name another that autokaraoke knows).
// OpenKaraoke does not import Demucs or PyTorch. The child is the autokaraoke virtualenv's
// Python, found from the launcher ~/.local/bin/autokaraoke (or OPENKARAOKE_AUTOKARAOKE_PYTHON).
// Node itself stays free of runtime npm dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Same order as autokaraoke's cmd_make: configure caches, then separate(), then one WAV. */
export const SEPARATE_PY = `
import sys
from pathlib import Path
from autokaraoke import audio, models

src, vocal_path, music_path, model, device, shifts, mdir = sys.argv[1:8]
audio.require_ffmpeg()
configured = models.configure(models.models_dir(None if mdir in ("", "-") else mdir), model)

def log(msg):
    print(msg, file=sys.stderr, flush=True)

from autokaraoke.separate import separate
vocals, inst, sr = separate(src, model, device or "auto", int(shifts or "1"), log, mdir=configured)
for data, dest in ((inst, music_path), (vocals, vocal_path)):  # the vocal last: it marks the pair done
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(dest) + ".part")
    audio.save_wav(tmp, data, sr)
    tmp.replace(dest)
print("STEMS_OK", flush=True)
`.trim();

/** The venv python next to the program the launcher execs, or ''. */
export function pythonFromLauncher(text) {
  const m = String(text || '').match(/^exec "([^"]+)"/m);
  if (!m) return '';
  return path.join(path.dirname(m[1]), 'python');
}

/** The models folder the launcher exports, or ''. */
export function modelsDirFromLauncher(text) {
  const m = String(text || '').match(/AUTOKARAOKE_MODELS="\$\{AUTOKARAOKE_MODELS:-([^}]+)\}"/);
  return m ? m[1] : '';
}

/**
 * Where the separator lives. `OPENKARAOKE_AUTOKARAOKE_PYTHON` wins; otherwise the launcher
 * ~/.local/bin/autokaraoke; otherwise ~/Projects/autokaraoke/.venv.
 */
export async function resolveAutokaraoke({ env = process.env, homedir = os.homedir(), readFile = fs.readFile } = {}) {
  const fromEnv = env.AUTOKARAOKE_MODELS || '';
  if (env.OPENKARAOKE_AUTOKARAOKE_PYTHON) {
    return { python: env.OPENKARAOKE_AUTOKARAOKE_PYTHON, modelsDir: fromEnv };
  }
  let python = '';
  let modelsDir = fromEnv;
  try {
    const text = await readFile(path.join(homedir, '.local', 'bin', 'autokaraoke'), 'utf8');
    python = pythonFromLauncher(text);
    if (!modelsDir) modelsDir = modelsDirFromLauncher(text);
  } catch { /* no launcher: fall through */ }
  if (!python) python = path.join(homedir, 'Projects', 'autokaraoke', '.venv', 'bin', 'python');
  if (!modelsDir) modelsDir = path.join(homedir, 'Projects', 'autokaraoke', 'models');
  return { python, modelsDir };
}

/** The separation model: htdemucs, or OPENKARAOKE_STEM_MODEL (a name autokaraoke knows). */
export function stemModel(env = process.env) {
  const m = String(env.OPENKARAOKE_STEM_MODEL || '');
  return /^[\w.-]{1,60}$/.test(m) ? m : 'htdemucs';
}

/** argv for `python - <src> <vocal> <music> <model> <device> <shifts> <models>`. The script is stdin. */
export function separateArgs({ python, src, vocal, music, model = 'htdemucs', device = 'auto', shifts = 1, modelsDir = '' }) {
  return {
    cmd: python,
    args: ['-', src, vocal, music || `${vocal}.music.wav`, model, device, String(shifts), modelsDir || '-'],
  };
}

/**
 * Separate `src` into a vocal WAV. `onChild` receives the process so a shutdown can stop it.
 * Resolves only when the script prints STEMS_OK and the vocal file was renamed into place.
 */
export async function runAutokaraokeSeparate({ src, vocal, music, onChild, env = process.env, homedir = os.homedir() } = {}) {
  const { python, modelsDir } = await resolveAutokaraoke({ env, homedir });
  const spec = separateArgs({ python, src, vocal, music, modelsDir, model: stemModel(env) });
  const childEnv = { ...env, PYTHONUNBUFFERED: '1' };
  if (modelsDir) childEnv.AUTOKARAOKE_MODELS = modelsDir;
  await new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    onChild?.(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > 100_000) out = out.slice(-2000);
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 200_000) err = err.slice(-4000);
    });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') reject(new Error('Autokaraoke’s separator was not found. Install autokaraoke, or set OPENKARAOKE_AUTOKARAOKE_PYTHON.'));
      else reject(e);
    });
    child.on('close', (code) => {
      if (code === 0 && out.includes('STEMS_OK')) resolve();
      else {
        const tail = err.trim().split('\n').slice(-4).join(' ').slice(0, 500);
        reject(new Error(tail || `separator exited ${code}`));
      }
    });
    child.stdin.end(SEPARATE_PY);
  });
}
