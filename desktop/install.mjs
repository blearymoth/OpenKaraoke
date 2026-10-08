// Installing OpenKaraoke for one person, the way a Windows installer does it, without a terminal
// or a password: the setup file (OpenKaraoke-Setup.zip → "Install OpenKaraoke", an AppImage with
// everything inside) copies itself to ~/.local/share/OpenKaraoke and adds a menu entry, a desktop
// shortcut and, when asked, a start at login; uninstalling takes all of that away again — and,
// when asked, the settings and the song index too. The parts that need no Electron (tested in
// test/desktop.test.js); desktop/setup.mjs is the setup window, desktop/main.mjs the rest.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockHeld } from '../server/util/datalock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** In every desktop entry this file writes: what is ours to update or remove. */
export const MARK = 'X-OpenKaraoke-Install';
const COMMENT = 'Karaoke parties with your own songs: lyrics on the TV, song requests from guests’ phones, party games.';

const absolute = (p, fallback) => (typeof p === 'string' && path.isAbsolute(p) ? p : fallback); // XDG: a relative path is ignored

/**
 * Where the installed copy and its entries go (XDG_DATA_HOME, XDG_CONFIG_HOME); `desktopDir` is
 * the person's desktop folder (Electron's app.getPath('desktop') knows its local name).
 */
export function installPaths({ env = process.env, home = os.homedir(), desktopDir } = {}) {
  const dataHome = absolute(env.XDG_DATA_HOME, path.join(home, '.local', 'share'));
  const configHome = absolute(env.XDG_CONFIG_HOME, path.join(home, '.config'));
  const dir = path.join(dataHome, 'OpenKaraoke');
  return {
    dir,
    appImage: path.join(dir, 'OpenKaraoke.AppImage'),
    icon: path.join(dir, 'openkaraoke.png'),
    info: path.join(dir, 'install.json'),
    // The window's app id is "openkaraoke" (desktop/electron-builder.config.cjs): the entry has to
    // have this name for the dock to show the app's icon on its windows.
    menuEntry: path.join(dataHome, 'applications', 'openkaraoke.desktop'),
    shortcut: path.join(absolute(desktopDir, path.join(home, 'Desktop')), 'OpenKaraoke.desktop'),
    autostart: path.join(configHome, 'autostart', 'openkaraoke.desktop'),
  };
}

/** One argument of a desktop entry's Exec key, quoted and escaped as the Desktop Entry Specification asks. */
export function execArg(arg) {
  const s = String(arg);
  if (/[\0-\x1f]/.test(s)) throw new Error('A path with control characters can’t be put in a menu entry.');
  // Reserved characters make an argument quoted, and inside quotes " ` $ \ take a backslash. The
  // key is then a string: each backslash is written twice. A % is written %% (no field code).
  const quoted = /[\s"'\\><~|&;$*?#()`]/.test(s) ? `"${s.replace(/(["`$\\])/g, '\\$1')}"` : s;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

const value = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

/**
 * A desktop entry that starts `command` (an array: the program, then its arguments). `actions`
 * become right-click entries of the menu item: [{ id, name, command }]; `extra` more keys.
 */
export function desktopEntry({ command, icon, actions = [], extra = {} }) {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenKaraoke',
    'GenericName=Karaoke',
    `Comment=${value(COMMENT)}`,
    `Exec=${command.map(execArg).join(' ')}`,
    `Icon=${value(icon)}`,
    'Terminal=false',
    'Categories=AudioVideo;Audio;',
    'Keywords=karaoke;party;singing;cdg;mp3+g;',
    'StartupWMClass=openkaraoke',
    ...Object.entries(extra).map(([k, v]) => `${k}=${value(v)}`),
    `${MARK}=user`,
  ];
  if (actions.length) lines.push(`Actions=${actions.map((a) => a.id).join(';')};`);
  for (const a of actions) lines.push('', `[Desktop Action ${a.id}]`, `Name=${value(a.name)}`, `Exec=${a.command.map(execArg).join(' ')}`);
  return `${lines.join('\n')}\n`;
}

/** The menu entry (and desktop shortcut) of the installed copy: start it, or uninstall it. */
export function menuEntry(paths) {
  return desktopEntry({
    command: [paths.appImage],
    icon: paths.icon,
    actions: [{ id: 'uninstall', name: 'Uninstall OpenKaraoke', command: [paths.appImage, '--uninstall'] }],
  });
}

/** The entry in ~/.config/autostart: `command` starts this copy, however it was installed. */
export function autostartEntry(command, icon) {
  return desktopEntry({ command, icon, extra: { 'X-GNOME-Autostart-enabled': 'true' } });
}

/** True when the desktop entry at `file` was written by this file (never touch anyone else's). */
export function ours(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(`\n${MARK}=`);
  } catch {
    return false;
  }
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** True when `file` is the installed copy (also through a link). */
export function isInstalledCopy(file, paths) {
  return !!file && real(file) === real(paths.appImage);
}

/**
 * What this start of the app is for:
 *   'uninstall'  the menu entry's "Uninstall OpenKaraoke" (--uninstall);
 *   'setup'      an AppImage that isn't the installed copy — "Install OpenKaraoke" from the
 *                download — unless the person chose to run that file without installing;
 *   'app'        everything else: the installed copy, the .deb/.rpm, the source code.
 */
export function startMode({ argv = [], env = {}, paths, portable = [] }) {
  if (argv.includes('--uninstall')) return 'uninstall';
  if (!env.APPIMAGE || argv.includes('--no-setup')) return 'app';
  if (isInstalledCopy(env.APPIMAGE, paths)) return 'app';
  if (portable.some((p) => typeof p === 'string' && real(p) === real(env.APPIMAGE))) return 'app';
  return 'setup';
}

/**
 * The environment for starting another copy of the app from inside an AppImage: without the
 * AppImage's own variables, and without its folder in the search paths (that folder goes away
 * when this copy quits; the other copy's AppImage adds its own).
 */
export function launchEnv(env) {
  const out = { ...env };
  const dir = env.APPDIR;
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete out[k];
  if (dir) {
    for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
      if (out[k] == null) continue;
      const kept = String(out[k]).split(':').filter((p) => p && p !== dir && !p.startsWith(`${dir}/`));
      if (kept.length) out[k] = kept.join(':');
      else delete out[k];
    }
  }
  return out;
}

/** The installed copy as install.json describes it (version, options); null when there is none. */
export async function readInstall(paths) {
  if (!fs.existsSync(paths.appImage)) return null;
  let info = {};
  try {
    info = JSON.parse(await fsp.readFile(paths.info, 'utf8')) || {};
  } catch { /* an older or broken note: the copy itself counts */ }
  return {
    version: typeof info.version === 'string' ? info.version : '',
    installedAt: Number.isFinite(info.installedAt) ? info.installedAt : null,
    shortcut: info.shortcut !== false && fs.existsSync(paths.shortcut) && ours(paths.shortcut),
  };
}

/** The OpenKaraoke running on this data folder, from its lock (server/util/datalock.js): { pid, port } or null. */
export function runningServer(dataDir) {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
    return lockHeld(holder) ? { pid: holder.pid, port: holder.port || null } : null;
  } catch {
    return null;
  }
}

async function writeAtomic(file, content, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  await fsp.writeFile(tmp, content, { mode });
  await fsp.chmod(tmp, mode); // writeFile's mode is masked by the umask
  await fsp.rename(tmp, file);
}

async function removeOurs(file) {
  if (ours(file)) await fsp.rm(file, { force: true });
}

/**
 * Installs `from` (the running AppImage) for this person: the program, its icon, the menu entry,
 * a desktop shortcut (or none) and the start at login (or none). Running it again repairs or
 * updates the copy. `run(cmd, args)` runs a helper program (best effort: refreshing the menu,
 * trusting the shortcut); `progress(fraction)` follows the copy.
 */
export async function install({ from, paths, iconFrom, version, shortcut = true, atLogin = false, run = () => {}, progress = () => {}, now = Date.now() }) {
  await fsp.mkdir(paths.dir, { recursive: true });
  if (!isInstalledCopy(from, paths)) {
    // Next to the old copy first, then swapped in at once: a copy that is running keeps going.
    const part = `${paths.appImage}.part`;
    const size = (await fsp.stat(from)).size;
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(from);
      const output = fs.createWriteStream(part, { mode: 0o755 });
      let copied = 0;
      input.on('data', (chunk) => {
        copied += chunk.length;
        progress(size ? Math.min(1, copied / size) : 1);
      });
      input.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      input.pipe(output);
    }).catch(async (e) => {
      await fsp.rm(part, { force: true });
      throw e;
    });
    await fsp.chmod(part, 0o755);
    await fsp.rename(part, paths.appImage);
  }
  progress(1);
  await fsp.copyFile(iconFrom, paths.icon);
  const entry = menuEntry(paths);
  await writeAtomic(paths.menuEntry, entry, 0o644);
  if (shortcut) {
    // Executable and trusted: GNOME's and KDE's desktops start it without asking first.
    await writeAtomic(paths.shortcut, entry, 0o755);
    await run('gio', ['set', paths.shortcut, 'metadata::trusted', 'true']);
  } else {
    await removeOurs(paths.shortcut);
  }
  await setAutostart({ paths, on: atLogin, command: [paths.appImage], icon: paths.icon });
  await writeAtomic(paths.info, `${JSON.stringify({ version, installedAt: now, shortcut: !!shortcut }, null, 2)}\n`, 0o644);
  await run('update-desktop-database', [path.dirname(paths.menuEntry)]);
}

/** Writes or removes the start at login (`command` starts this copy). */
export async function setAutostart({ paths, on, command, icon }) {
  if (on) await writeAtomic(paths.autostart, autostartEntry(command, icon), 0o644);
  else await removeOurs(paths.autostart);
}

/** True when this person's session starts OpenKaraoke (an entry of ours in ~/.config/autostart). */
export function startsAtLogin(paths) {
  return ours(paths.autostart);
}

/**
 * Takes the installed copy away again: its entries (only ours), the icon, the program, its
 * folder; with `removeData` also `userData` (settings, song index, pictures, logs). Songs are
 * never touched (they are wherever the person keeps them).
 */
export async function uninstall({ paths, removeData = false, userData, run = () => {} }) {
  await removeOurs(paths.autostart);
  await removeOurs(paths.shortcut);
  await removeOurs(paths.menuEntry);
  for (const f of [paths.icon, paths.info, `${paths.appImage}.part`, paths.appImage]) await fsp.rm(f, { force: true });
  await fsp.rmdir(paths.dir).catch(() => {}); // only when empty: anything else in it stays
  if (removeData) await removeUserData(userData);
  await run('update-desktop-database', [path.dirname(paths.menuEntry)]);
}

/**
 * True when `userData` can only be the app's own folder of settings, song index and pictures
 * (~/.config/OpenKaraoke) — never something that could be more than that (/, a home folder,
 * ~/.config itself).
 */
export function safeDataDir(userData, home = os.homedir()) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) return false;
  const dir = path.resolve(userData);
  const forbidden = ['/', home, path.join(home, '.config'), path.join(home, '.local'), path.join(home, '.local', 'share')].map((p) => path.resolve(p));
  return !forbidden.includes(dir) && dir.split(path.sep).filter(Boolean).length >= 2;
}

/** Deletes the app's own folder of settings, song index and pictures (see safeDataDir). */
export async function removeUserData(userData, home = os.homedir()) {
  if (!safeDataDir(userData, home)) return false;
  await fsp.rm(path.resolve(userData), { recursive: true, force: true });
  return true;
}

/**
 * The shell command that deletes `userData` once process `pid` has ended (the app's own browser
 * profile lives in it, and is written until the very end): for spawn('sh', …), detached. Null
 * when the folder isn't safe to delete.
 */
export function removeLaterCommand(userData, pid, home = os.homedir()) {
  if (!safeDataDir(userData, home) || !Number.isSafeInteger(pid)) return null;
  return ['sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; rm -rf -- "$2"', 'openkaraoke-cleanup', String(pid), path.resolve(userData)];
}

/**
 * For the installed copy, at every start: the icon, the menu entry (unless someone else's took
 * its place) and the version in install.json, put back or brought up to date — e.g. after an
 * update from inside the app. Resolves to true when something was written.
 */
export async function refresh({ paths, version, iconFrom, run = () => {} }) {
  let changed = false;
  if (!fs.existsSync(paths.icon)) {
    await fsp.copyFile(iconFrom, paths.icon);
    changed = true;
  }
  const entry = menuEntry(paths);
  let current = null;
  try {
    current = await fsp.readFile(paths.menuEntry, 'utf8');
  } catch { /* gone */ }
  if (current !== entry && (current === null || ours(paths.menuEntry))) {
    await writeAtomic(paths.menuEntry, entry, 0o644);
    await run('update-desktop-database', [path.dirname(paths.menuEntry)]);
    changed = true;
  }
  let info = {};
  try {
    info = JSON.parse(await fsp.readFile(paths.info, 'utf8')) || {};
  } catch { /* none yet */ }
  if (info.version !== version) {
    await writeAtomic(paths.info, `${JSON.stringify({ ...info, version }, null, 2)}\n`, 0o644);
    changed = true;
  }
  return changed;
}

/**
 * The file behind a path of the setup page's okapp://app (desktop/setup.mjs): /setup/… from
 * desktop/setup/, /shared/… from shared/, the rest (styles, fonts, scripts, icons) from public/.
 * Null for anything outside those folders.
 */
export function setupFile(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const [root, rel] = p.startsWith('/setup/')
    ? [path.join(HERE, 'setup'), p.slice('/setup/'.length) || 'index.html']
    : p.startsWith('/shared/')
      ? [path.join(ROOT, 'shared'), p.slice('/shared/'.length)]
      : [path.join(ROOT, 'public'), p.slice(1)];
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

/** "Run it without installing" remembers the file (in the app's profile): it starts as the app from then on. */
export function rememberPortable(userData, file) {
  const f = path.join(userData, 'setup.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch { /* first time */ }
  const list = (Array.isArray(saved.portable) ? saved.portable : []).filter((p) => typeof p === 'string' && p !== file);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...saved, portable: [file, ...list].slice(0, 10) }));
}

/** The files remembered by rememberPortable(). */
export function portableFiles(userData) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'setup.json'), 'utf8'));
    return Array.isArray(saved?.portable) ? saved.portable.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
