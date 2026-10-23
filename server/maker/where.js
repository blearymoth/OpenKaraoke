// Where autokaraoke is on this PC — one answer for everything that uses it: the vocal separator
// (stems/separate.js, PLAN §21, §30), the Karaoke maker and the lyrics editor (§31). The owner's
// copy is ~/Projects/autokaraoke; its installer writes a launcher, ~/.local/bin/autokaraoke, that
// names the folder it runs from and its models folder. Each answer has one override:
//   OPENKARAOKE_AUTOKARAOKE_ROOT    the folder (the SongGetter checkout)
//   OPENKARAOKE_AUTOKARAOKE_PYTHON  its virtualenv's Python
//   AUTOKARAOKE_MODELS              its models folder (autokaraoke's own variable)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

/** The launcher's `exec "<root>/.venv/bin/autokaraoke"` → <root>, or ''. */
export function rootFromLauncher(text) {
  const m = /^exec "([^"]+)"/m.exec(String(text || ''));
  if (!m) return '';
  const bin = path.dirname(m[1]); // <root>/.venv/bin
  return path.basename(bin) === 'bin' && path.basename(path.dirname(bin)) === '.venv' ? path.dirname(path.dirname(bin)) : '';
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

/**
 * Where autokaraoke is: the root (`OPENKARAOKE_AUTOKARAOKE_ROOT`, else the folder the launcher
 * runs from, else ~/Projects/autokaraoke), its Python and models folder.
 * → { root, python, launcher, modelsDir, hasRoot, installed, installer }
 */
export async function locateAutokaraoke({ env = process.env, homedir = os.homedir(), readFile = fs.readFile } = {}) {
  const launcher = path.join(homedir, '.local', 'bin', 'autokaraoke');
  let text = '';
  if (!env.OPENKARAOKE_AUTOKARAOKE_PYTHON || !env.AUTOKARAOKE_MODELS || !env.OPENKARAOKE_AUTOKARAOKE_ROOT) {
    try { text = await readFile(launcher, 'utf8'); } catch { /* no launcher */ }
  }
  const root = env.OPENKARAOKE_AUTOKARAOKE_ROOT || rootFromLauncher(text) || path.join(homedir, 'Projects', 'autokaraoke');
  const python = env.OPENKARAOKE_AUTOKARAOKE_PYTHON || pythonFromLauncher(text) || path.join(root, '.venv', 'bin', 'python');
  const modelsDir = env.AUTOKARAOKE_MODELS || modelsDirFromLauncher(text) || path.join(root, 'models');
  const [hasRoot, installed, installer] = await Promise.all([
    exists(path.join(root, 'autokaraoke', 'cli.py')), exists(python), exists(path.join(root, 'install.sh')),
  ]);
  return { root, python, launcher: text ? launcher : '', modelsDir, hasRoot, installed, installer: installer ? path.join(root, 'install.sh') : '' };
}
