// Where the Karaoke maker's Python side is on this PC — one answer for everything that uses it:
// the vocal separator (stems/separate.js, PLAN §21, §30), the Karaoke maker and the lyrics editor
// (§31). Its code ships with OpenKaraoke (maker/, the `autokaraoke` package); maker/install.sh
// builds its environment and models in ~/.local/share/openkaraoke/autokaraoke (§31.4 b).
//
// Before that install exists, an older copy from the SongGetter repository still works: the
// folder its launcher ~/.local/bin/autokaraoke names, else ~/Projects/autokaraoke (`legacy`).
// Installing then reuses its models. Each answer has one override:
//   OPENKARAOKE_MAKER_HOME          the install folder
//   OPENKARAOKE_AUTOKARAOKE_ROOT    an older SongGetter checkout to use
//   OPENKARAOKE_AUTOKARAOKE_PYTHON  the Python to run
//   AUTOKARAOKE_MODELS              the models folder (autokaraoke's own variable)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The code that ships with OpenKaraoke (read-only inside the AppImage). */
export const BUNDLED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'maker');

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

/** Where maker/install.sh puts the environment and models. */
export function makerHome({ env = process.env, homedir = os.homedir() } = {}) {
  return env.OPENKARAOKE_MAKER_HOME || path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'openkaraoke', 'autokaraoke');
}

/** `__version__ = "0.2.0"` in a package's __init__.py → '0.2.0', or ''. */
export function versionOf(text) {
  const m = /^__version__\s*=\s*["']([^"']+)["']/m.exec(String(text || ''));
  return m ? m[1] : '';
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

/**
 * → { root, python, modelsDir, installed, hasRoot, installer, source, bundled, legacy, legacyModels, launcher }
 *   root       where it is installed (or will be): the maker's home, or an older copy's folder
 *   installed  its Python is there
 *   hasRoot    the code to install from is there (OpenKaraoke's maker/)
 *   installer  maker/install.sh, or ''
 *   bundled    the version that ships with this OpenKaraoke
 *   legacy     the older SongGetter copy in use ('' when the maker's own install is)
 *   legacyModels  an older copy's models folder the installer can reuse, or ''
 */
export async function locateAutokaraoke({ env = process.env, homedir = os.homedir(), readFile = fs.readFile, source = BUNDLED } = {}) {
  const home = makerHome({ env, homedir });
  const homePython = path.join(home, '.venv', 'bin', 'python');
  const launcherPath = path.join(homedir, '.local', 'bin', 'autokaraoke');
  let text = '';
  try { text = await readFile(launcherPath, 'utf8'); } catch { /* no launcher */ }
  const oldRoot = env.OPENKARAOKE_AUTOKARAOKE_ROOT || rootFromLauncher(text) || path.join(homedir, 'Projects', 'autokaraoke');
  const oldPython = pythonFromLauncher(text) || path.join(oldRoot, '.venv', 'bin', 'python');
  const oldModels = modelsDirFromLauncher(text) || path.join(oldRoot, 'models');
  const [ownInstall, oldInstall, oldHasModels, installer, initText] = await Promise.all([
    exists(homePython), exists(oldPython), exists(oldModels), exists(path.join(source, 'install.sh')),
    readFile(path.join(source, 'autokaraoke', '__init__.py'), 'utf8').catch(() => ''),
  ]);
  const useOld = !ownInstall && oldInstall && !env.OPENKARAOKE_MAKER_HOME;
  const root = useOld ? oldRoot : home;
  const python = env.OPENKARAOKE_AUTOKARAOKE_PYTHON || (useOld ? oldPython : homePython);
  const modelsDir = env.AUTOKARAOKE_MODELS || (useOld ? oldModels : path.join(home, 'models'));
  return {
    root,
    python,
    modelsDir,
    installed: env.OPENKARAOKE_AUTOKARAOKE_PYTHON ? await exists(python) : ownInstall || useOld,
    hasRoot: !!initText,
    installer: installer ? path.join(source, 'install.sh') : '',
    source,
    bundled: versionOf(initText),
    legacy: useOld ? oldRoot : '',
    legacyModels: !ownInstall && oldHasModels && !env.OPENKARAOKE_MAKER_HOME ? oldModels : '',
    launcher: text ? launcherPath : '',
  };
}
