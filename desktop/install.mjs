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
 * The AppImage this process runs from, or ''. $APPIMAGE alone isn't proof: a program started
 * from inside another AppImage inherits it. In a build it counts only when this program lives in
 * that AppImage's folder ($APPDIR); from the source code (the tests) it is taken as it is.
 */
export function ownAppImage({ env = {}, execPath = '', packaged = true }) {
  if (!env.APPIMAGE) return '';
  if (!packaged) return env.APPIMAGE;
  return env.APPDIR && path.resolve(execPath).startsWith(`${path.resolve(env.APPDIR)}/`) ? env.APPIMAGE : '';
}

/** A release's own AppImage file (OpenKaraoke-1.2.3.AppImage): someone running the app straight from it. */
const RELEASE_FILE = /^OpenKaraoke-\d+\.\d+\.\d+([.-][\w.-]*)?\.AppImage$/i;

/**
 * What this start of the app is for:
 *   'uninstall'  the menu entry's "Uninstall OpenKaraoke" (--uninstall);
 *   'setup'      an AppImage that isn't the installed copy — "Install OpenKaraoke" from the
 *                download — unless the person chose to run that file without installing, or it
 *                is a release's own AppImage file (OpenKaraoke-<version>.AppImage: run on purpose,
 *                and how the copies before the installer were kept — the updater keeps the name);
 *   'app'        everything else: the installed copy, the .deb/.rpm, the source code.
 * `appImage` is ownAppImage()'s answer.
 */
export function startMode({ argv = [], appImage = '', paths, portable = [] }) {
  if (argv.includes('--uninstall')) return 'uninstall';
  if (!appImage || argv.includes('--no-setup')) return 'app';
  if (isInstalledCopy(appImage, paths)) return 'app';
  if (RELEASE_FILE.test(path.basename(appImage))) return 'app';
  if (portable.some((p) => typeof p === 'string' && real(p) === real(appImage))) return 'app';
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
  const tmp = `${file}.part-${process.pid}`;
  await fsp.writeFile(tmp, content, { mode });
  await fsp.chmod(tmp, mode); // writeFile's mode is masked by the umask
  await fsp.rename(tmp, file);
}

/** Where someone else's entry goes while ours takes its place (put back when ours goes). */
export const backupOf = (file) => `${file}.before-openkaraoke`;

/**
 * Writes one of our desktop entries. Someone else's file in its place (one made by hand, a menu
 * editor's copy) is kept aside, never overwritten, and comes back when ours is removed.
 */
async function writeOurs(file, content, mode) {
  if (fs.existsSync(file) && !ours(file) && !fs.existsSync(backupOf(file))) await fsp.rename(file, backupOf(file));
  await writeAtomic(file, content, mode);
}

/** Removes one of our desktop entries (only ours), and puts back what it had replaced. */
async function removeOurs(file) {
  if (!ours(file)) return;
  await fsp.rm(file, { force: true });
  if (fs.existsSync(backupOf(file))) await fsp.rename(backupOf(file), file);
}

/** Reads an Exec value back into the program and its arguments (the Desktop Entry Specification). */
export function parseExec(raw) {
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const c = raw[++i];
      s += { s: ' ', n: '\n', t: '\t', r: '\r' }[c] ?? c;
    } else {
      s += raw[i];
    }
  }
  const args = [];
  let cur = null;
  for (let i = 0; i < s.length;) {
    if (s[i] === ' ') {
      if (cur !== null) args.push(cur);
      cur = null;
      i++;
    } else if (s[i] === '"') {
      cur ??= '';
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        cur += s[i];
      }
      i++;
    } else {
      cur = (cur ?? '') + s[i++];
    }
  }
  if (cur !== null) args.push(cur);
  return args.map((a) => a.replace(/%%/g, '%'));
}

/** The command a desktop entry starts ([program, …args]), or null. */
export function entryCommand(file) {
  try {
    const main = fs.readFileSync(file, 'utf8').split(/\n(?=\[)/)[0];
    const m = /^Exec=(.*)$/m.exec(main);
    return m ? parseExec(m[1]) : null;
  } catch {
    return null;
  }
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
    // (A file of this process's own: two setups started at once don't write into each other's.)
    const part = `${paths.appImage}.part-${process.pid}`;
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
  await writeOurs(paths.menuEntry, entry, 0o644);
  if (shortcut) {
    // Executable and trusted: GNOME's and KDE's desktops start it without asking first.
    await writeOurs(paths.shortcut, entry, 0o755);
    await run('gio', ['set', paths.shortcut, 'metadata::trusted', 'true']);
  } else {
    await removeOurs(paths.shortcut);
  }
  await setAutostart({ paths, on: atLogin, command: [paths.appImage], icon: paths.icon });
  await writeAtomic(paths.info, `${JSON.stringify({ version, installedAt: now, shortcut: !!shortcut }, null, 2)}\n`, 0o644);
  await run('update-desktop-database', [path.dirname(paths.menuEntry)]);
}

/**
 * Writes or removes the start at login (`command` starts this copy). Removing with `onlyFor`
 * (a program) leaves an entry that starts another copy alone.
 */
export async function setAutostart({ paths, on, command, icon, onlyFor }) {
  if (on) await writeOurs(paths.autostart, autostartEntry(command, icon), 0o644);
  else if (!onlyFor || entryCommand(paths.autostart)?.[0] === onlyFor) await removeOurs(paths.autostart);
}

/** True when this person's session starts OpenKaraoke (an entry of ours in ~/.config/autostart). */
export function startsAtLogin(paths) {
  return ours(paths.autostart);
}

/**
 * Takes the installed copy away again: its entries (only ours; someone else's they had replaced
 * come back), the icon, the program, its folder; with `removeData` also `userData` (see
 * removeUserData; `trash(dir)` moves a folder to the Trash, resolving to true when it did).
 * Songs are never touched (they are wherever the person keeps them).
 */
export async function uninstall({ paths, removeData = false, userData, run = () => {}, trash }) {
  await setAutostart({ paths, on: false, onlyFor: paths.appImage });
  await removeOurs(paths.shortcut);
  await removeOurs(paths.menuEntry);
  let left = [];
  try {
    left = await fsp.readdir(paths.dir);
  } catch { /* no folder */ }
  // The program, its icon and note, and what a copy or an update left half done.
  const program = path.basename(paths.appImage);
  const ourFiles = left.filter((f) => f === program || f.startsWith(`${program}.part`) || f.startsWith(`.${program}.update`));
  for (const f of [paths.icon, paths.info, ...ourFiles.map((f) => path.join(paths.dir, f))]) await fsp.rm(f, { force: true });
  await fsp.rmdir(paths.dir).catch(() => {}); // only when empty: anything else in it stays
  if (removeData) await removeUserData(userData, { trash });
  await run('update-desktop-database', [path.dirname(paths.menuEntry)]);
}

/**
 * True when `userData` can only be the app's own folder of settings, playlists, history, song
 * index and pictures (~/.config/OpenKaraoke): named OpenKaraoke, and never something that could
 * be more than that (/, a home folder, ~/.config itself).
 */
export function safeDataDir(userData, home = os.homedir()) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) return false;
  const dir = path.resolve(userData);
  const forbidden = ['/', home, path.join(home, '.config'), path.join(home, '.local'), path.join(home, '.local', 'share')].map((p) => path.resolve(p));
  return path.basename(dir) === 'OpenKaraoke' && !forbidden.includes(dir) && dir.split(path.sep).filter(Boolean).length >= 2;
}

/**
 * Takes away the app's own folder of settings, playlists, history, song index and pictures (see
 * safeDataDir): to the Trash when `trash(dir)` can (it can be got back), else deleted.
 */
export async function removeUserData(userData, { home = os.homedir(), trash } = {}) {
  if (!safeDataDir(userData, home)) return false;
  const dir = path.resolve(userData);
  if (!fs.existsSync(dir)) return true;
  if (trash && (await trash(dir).catch(() => false)) && !fs.existsSync(dir)) return true;
  await fsp.rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * The shell command that takes `userData` away once process `pid` has ended (the app's own
 * browser profile lives in it, and is written until the very end): to the Trash (`gio trash`)
 * when it can, else deleted. For spawn('sh', …), detached. Null when the folder isn't safe to
 * remove.
 */
export function removeLaterCommand(userData, pid, home = os.homedir()) {
  if (!safeDataDir(userData, home) || !Number.isSafeInteger(pid)) return null;
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; gio trash -- "$2" 2>/dev/null || rm -rf -- "$2"';
  return ['sh', '-c', script, 'openkaraoke-cleanup', String(pid), path.resolve(userData)];
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
