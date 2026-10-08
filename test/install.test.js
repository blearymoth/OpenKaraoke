// The one-download installer (desktop/install.mjs, desktop/pack-setup.cjs): where things go,
// the menu entries, what a start is for, installing / repairing / uninstalling for one person,
// and the zip that keeps "Install OpenKaraoke" executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.js';
import {
  backupOf, desktopEntry, entryCommand, execArg, install, installPaths, isInstalledCopy, launchEnv, menuEntry, ours, ownAppImage, parseExec,
  portableFiles, readInstall, refresh, rememberPortable, removeLaterCommand, removeUserData, runningServer, safeDataDir, setAutostart, setupFile,
  startMode, startsAtLogin, uninstall,
} from '../desktop/install.mjs';
import { removeCommand } from '../desktop/update-logic.mjs';

const require = createRequire(import.meta.url);
const { crc32, makeSetupZip, writeZip, SETUP_NAME, ZIP_NAME } = require('../desktop/pack-setup.cjs');
const ROOT = path.resolve(import.meta.dirname, '..');

const execOf = (entry, section = 'Desktop Entry') => {
  const block = entry.split(/\n(?=\[)/).find((b) => b.startsWith(`[${section}]`));
  return parseExec(/^Exec=(.*)$/m.exec(block)[1]);
};

test('install: where things go (XDG folders, the desktop folder)', () => {
  const p = installPaths({ env: {}, home: '/home/jim', desktopDir: '/home/jim/Schreibtisch' });
  assert.equal(p.dir, '/home/jim/.local/share/OpenKaraoke');
  assert.equal(p.appImage, '/home/jim/.local/share/OpenKaraoke/OpenKaraoke.AppImage');
  assert.equal(p.menuEntry, '/home/jim/.local/share/applications/openkaraoke.desktop', 'named after the window’s app id');
  assert.equal(p.shortcut, '/home/jim/Schreibtisch/OpenKaraoke.desktop');
  assert.equal(p.autostart, '/home/jim/.config/autostart/openkaraoke.desktop');
  const x = installPaths({ env: { XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/conf' }, home: '/home/jim' });
  assert.equal(x.dir, '/data/OpenKaraoke');
  assert.equal(x.autostart, '/conf/autostart/openkaraoke.desktop');
  assert.equal(x.shortcut, '/home/jim/Desktop/OpenKaraoke.desktop', 'no desktop folder given: ~/Desktop');
  const rel = installPaths({ env: { XDG_DATA_HOME: 'relative', XDG_CONFIG_HOME: '' }, home: '/h', desktopDir: 'also-relative' });
  assert.equal(rel.dir, '/h/.local/share/OpenKaraoke', 'a relative XDG path is ignored');
  assert.equal(rel.shortcut, '/h/Desktop/OpenKaraoke.desktop');
});

test('install: desktop entries — the program, quoted and escaped; the Uninstall action', () => {
  for (const p of ['/home/jim/.local/share/OpenKaraoke/OpenKaraoke.AppImage', '/home/Mary Ann/Apps/Open "Karaoke"$HOME`x`\\%u.AppImage', '/tmp/a;b&c|d']) {
    assert.deepEqual(parseExec(execArg(p)), [p], p);
  }
  assert.equal(execArg('/opt/OpenKaraoke/openkaraoke'), '/opt/OpenKaraoke/openkaraoke', 'nothing to quote');
  assert.throws(() => execArg('/tmp/a\nb'), /control characters/);
  const paths = installPaths({ env: {}, home: '/home/Mary Ann' });
  const entry = menuEntry(paths);
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=OpenKaraoke\n/);
  assert.deepEqual(execOf(entry), [paths.appImage]);
  assert.deepEqual(execOf(entry, 'Desktop Action uninstall'), [paths.appImage, '--uninstall']);
  assert.match(entry, /^Actions=uninstall;$/m);
  assert.match(entry, /^StartupWMClass=openkaraoke$/m);
  assert.match(entry, /^Icon=\/home\/Mary Ann\/\.local\/share\/OpenKaraoke\/openkaraoke\.png$/m);
  assert.match(entry, /^X-OpenKaraoke-Install=user$/m, 'marked as ours');
  const auto = desktopEntry({ command: ['/opt/OpenKaraoke/openkaraoke'], icon: 'x', extra: { 'X-GNOME-Autostart-enabled': 'true' } });
  assert.match(auto, /^X-GNOME-Autostart-enabled=true$/m);
  assert.doesNotMatch(auto, /Actions=/);
});

test('install: what a start is for — the setup, the Uninstall action, or the app', async () => {
  const dir = await tmpDir();
  const paths = installPaths({ env: {}, home: dir });
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.appImage, 'x');
  const download = path.join(dir, 'Downloads', 'Install OpenKaraoke');
  assert.equal(startMode({ argv: ['openkaraoke'], appImage: download, paths }), 'setup', 'the download');
  assert.equal(startMode({ argv: ['openkaraoke'], appImage: paths.appImage, paths }), 'app', 'the installed copy');
  await fs.symlink(paths.appImage, path.join(dir, 'link.AppImage'));
  assert.equal(startMode({ argv: [], appImage: path.join(dir, 'link.AppImage'), paths }), 'app', 'through a link');
  assert.equal(startMode({ argv: [], appImage: '', paths }), 'app', 'a .deb/.rpm or the source code');
  assert.equal(startMode({ argv: ['x', '--no-setup'], appImage: download, paths }), 'app');
  assert.equal(startMode({ argv: [], appImage: download, paths, portable: [download] }), 'app', '“Run it without installing” was chosen for this file');
  assert.equal(startMode({ argv: ['x', '--uninstall'], appImage: paths.appImage, paths }), 'uninstall');
  // A release's own AppImage (the "other downloads", and every copy from before the installer —
  // the updater keeps its name) starts as the app: Settings → About offers to install it.
  for (const name of ['OpenKaraoke-0.1.12.AppImage', 'OpenKaraoke-0.2.30.AppImage', 'openkaraoke-1.0.0-arm64.AppImage']) {
    assert.equal(startMode({ argv: [], appImage: path.join(dir, 'Apps', name), paths }), 'app', name);
  }
  assert.equal(startMode({ argv: [], appImage: path.join(dir, 'Downloads', 'Install OpenKaraoke (1)'), paths }), 'setup');
  // $APPIMAGE counts only for the program inside that AppImage (a build), or from the source code.
  assert.equal(ownAppImage({ env: { APPIMAGE: '/a/X.AppImage', APPDIR: '/tmp/.mount_X1' }, execPath: '/tmp/.mount_X1/openkaraoke', packaged: true }), '/a/X.AppImage');
  assert.equal(ownAppImage({ env: { APPIMAGE: '/a/Other.AppImage', APPDIR: '/tmp/.mount_Ot2' }, execPath: '/opt/OpenKaraoke/openkaraoke', packaged: true }), '', 'inherited from another AppImage');
  assert.equal(ownAppImage({ env: { APPIMAGE: '/a/X.AppImage' }, execPath: '/opt/OpenKaraoke/openkaraoke', packaged: true }), '', 'no APPDIR');
  assert.equal(ownAppImage({ env: { APPIMAGE: '/a/X.AppImage', APPDIR: '/tmp/.mount_X1' }, execPath: '/tmp/.mount_X10/openkaraoke', packaged: true }), '', 'a folder whose name only starts the same');
  assert.equal(ownAppImage({ env: { APPIMAGE: '/a/X.AppImage' }, execPath: '/x/electron', packaged: false }), '/a/X.AppImage', 'from the source code: as it is');
  assert.equal(ownAppImage({ env: {}, execPath: '/x', packaged: true }), '');
  assert.ok(isInstalledCopy(paths.appImage, paths));
  assert.ok(!isInstalledCopy('', paths));
  // Remembered per file, newest first, ten at most.
  const userData = path.join(dir, 'profile');
  assert.deepEqual(portableFiles(userData), []);
  for (let i = 0; i < 12; i++) rememberPortable(userData, `/x/${i}`);
  rememberPortable(userData, '/x/5');
  assert.deepEqual(portableFiles(userData).slice(0, 3), ['/x/5', '/x/11', '/x/10']);
  assert.equal(portableFiles(userData).length, 10);
});

test('install: the environment for starting the installed copy leaves the AppImage’s own behind', () => {
  const env = {
    APPIMAGE: '/home/j/Install OpenKaraoke', APPDIR: '/tmp/.mount_InstaAbc', ARGV0: './Install', OWD: '/home/j',
    PATH: '/tmp/.mount_InstaAbc:/tmp/.mount_InstaAbc/usr/sbin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_InstaAbc/usr/lib',
    XDG_DATA_DIRS: '/tmp/.mount_InstaAbc/usr/share/:/usr/share/gnome:/usr/share/',
    HOME: '/home/j', DISPLAY: ':0',
  };
  const out = launchEnv(env);
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH']) assert.equal(out[k], undefined, k);
  assert.equal(out.PATH, '/usr/bin:/bin');
  assert.equal(out.XDG_DATA_DIRS, '/usr/share/gnome:/usr/share/');
  assert.equal(out.HOME, '/home/j');
  assert.equal(out.DISPLAY, ':0');
  assert.deepEqual(launchEnv({ PATH: '/usr/bin' }), { PATH: '/usr/bin' }, 'not from an AppImage: unchanged');
});

test('install: installing, repairing and uninstalling for one person — only our files', async () => {
  const home = await tmpDir();
  const paths = installPaths({ env: {}, home, desktopDir: path.join(home, 'Desktop') });
  const download = path.join(home, 'Downloads', 'Install OpenKaraoke');
  await fs.mkdir(path.dirname(download), { recursive: true });
  await fs.writeFile(download, '#!/bin/sh\necho hello\n'.repeat(5000), { mode: 0o755 });
  const icon = path.join(ROOT, 'desktop', 'build', 'icons', '512x512.png');
  const ran = [];
  const run = (cmd, args) => { ran.push([cmd, ...args]); };
  const progress = [];
  await install({ from: download, paths, iconFrom: icon, version: '0.2.5', shortcut: true, atLogin: false, run, progress: (f) => progress.push(f), now: 1000 });

  assert.deepEqual(await fs.readFile(paths.appImage), await fs.readFile(download), 'the program is a copy of the download');
  const mode = async (f) => (await fs.stat(f)).mode & 0o777;
  assert.equal(await mode(paths.appImage), 0o755);
  assert.equal(await mode(paths.menuEntry), 0o644);
  assert.equal(await mode(paths.shortcut), 0o755, 'the desktop shortcut is executable (the desktop starts it without asking)');
  assert.equal(await fs.readFile(paths.menuEntry, 'utf8'), menuEntry(paths));
  assert.equal(await fs.readFile(paths.shortcut, 'utf8'), menuEntry(paths));
  assert.deepEqual(await fs.readFile(paths.icon), await fs.readFile(icon));
  assert.ok(!fsSync.existsSync(paths.autostart));
  assert.ok(progress.at(-1) === 1 && progress.length >= 2, 'progress reported');
  assert.deepEqual(ran, [['gio', 'set', paths.shortcut, 'metadata::trusted', 'true'], ['update-desktop-database', path.dirname(paths.menuEntry)]]);
  assert.deepEqual(await readInstall(paths), { version: '0.2.5', installedAt: 1000, shortcut: true });
  assert.equal(startMode({ argv: [], appImage: download, paths }), 'setup');
  assert.equal(startMode({ argv: [], appImage: paths.appImage, paths }), 'app');
  for (const f of await fs.readdir(paths.dir)) assert.ok(!f.endsWith('.part'), `no leftover ${f}`);

  // Someone else's entries in our places are kept aside, never overwritten, and come back at uninstall.
  const mine = '[Desktop Entry]\nName=Mine\nExec=/home/x/OpenKaraoke.AppImage --no-sandbox\n';
  await fs.rm(paths.shortcut);
  await fs.writeFile(paths.shortcut, mine);
  await fs.writeFile(paths.menuEntry, mine);
  await install({ from: download, paths, iconFrom: icon, version: '0.2.5', shortcut: true, run });
  assert.ok(ours(paths.shortcut) && ours(paths.menuEntry), 'ours in place');
  assert.equal(await fs.readFile(backupOf(paths.shortcut), 'utf8'), mine, 'theirs kept aside');
  assert.equal(await fs.readFile(backupOf(paths.menuEntry), 'utf8'), mine);
  await install({ from: download, paths, iconFrom: icon, version: '0.2.5', shortcut: true, run });
  assert.equal(await fs.readFile(backupOf(paths.menuEntry), 'utf8'), mine, 'a second install doesn’t replace the backup with ours');
  await uninstall({ paths, run });
  assert.equal(await fs.readFile(paths.shortcut, 'utf8'), mine, 'theirs back after uninstalling');
  assert.equal(await fs.readFile(paths.menuEntry, 'utf8'), mine);
  assert.ok(!fsSync.existsSync(backupOf(paths.menuEntry)));
  await fs.rm(paths.menuEntry);
  await install({ from: download, paths, iconFrom: icon, version: '0.2.5', shortcut: false, run });

  // Again: no shortcut, start at login; someone else's shortcut of the same name stays.
  await fs.rm(paths.shortcut, { force: true });
  await fs.writeFile(paths.shortcut, '[Desktop Entry]\nName=Mine\nExec=/usr/bin/true\n');
  await install({ from: download, paths, iconFrom: icon, version: '0.2.6', shortcut: false, atLogin: true, run });
  assert.equal(await fs.readFile(paths.shortcut, 'utf8'), '[Desktop Entry]\nName=Mine\nExec=/usr/bin/true\n', 'not ours: kept');
  assert.ok(startsAtLogin(paths));
  assert.deepEqual(execOf(await fs.readFile(paths.autostart, 'utf8')), [paths.appImage]);
  assert.equal((await readInstall(paths)).version, '0.2.6');
  assert.equal((await readInstall(paths)).shortcut, false);
  await fs.rm(paths.shortcut);
  await install({ from: download, paths, iconFrom: icon, version: '0.2.6', shortcut: true, atLogin: false, run });
  assert.ok(ours(paths.shortcut) && !fsSync.existsSync(paths.autostart));
  await setAutostart({ paths, on: true, command: ['/opt/OpenKaraoke/openkaraoke'], icon: 'x' });
  assert.deepEqual(execOf(await fs.readFile(paths.autostart, 'utf8')), ['/opt/OpenKaraoke/openkaraoke']);
  assert.deepEqual(entryCommand(paths.autostart), ['/opt/OpenKaraoke/openkaraoke']);
  await setAutostart({ paths, on: false, onlyFor: paths.appImage });
  assert.ok(startsAtLogin(paths), 'the start at login of another copy (the .deb) is left alone');
  await setAutostart({ paths, on: false });
  assert.ok(!startsAtLogin(paths));

  // Installing from the installed copy itself (Settings → About on a repaired copy) copies nothing.
  await install({ from: paths.appImage, paths, iconFrom: icon, version: '0.2.6', shortcut: true, run });
  assert.deepEqual(await fs.readFile(paths.appImage), await fs.readFile(download));

  // At every start the installed copy puts back what is missing and notes its version.
  await fs.rm(paths.menuEntry);
  await fs.rm(paths.icon);
  assert.equal(await refresh({ paths, version: '0.2.9', iconFrom: icon, run }), true);
  assert.equal(await fs.readFile(paths.menuEntry, 'utf8'), menuEntry(paths));
  assert.ok(fsSync.existsSync(paths.icon));
  assert.equal((await readInstall(paths)).version, '0.2.9');
  assert.equal(await refresh({ paths, version: '0.2.9', iconFrom: icon, run }), false, 'nothing to do');
  await fs.writeFile(paths.menuEntry, '[Desktop Entry]\nName=Somebody else’s\n');
  assert.equal(await refresh({ paths, version: '0.2.9', iconFrom: icon, run }), false, 'someone else’s entry is left alone');
  await fs.writeFile(paths.menuEntry, menuEntry(paths));

  // Uninstall: ours goes, the settings stay unless asked, other things stay.
  const userData = path.join(home, '.config', 'OpenKaraoke');
  await fs.mkdir(path.join(userData, 'data'), { recursive: true });
  await fs.writeFile(path.join(userData, 'data', 'settings.json'), '{}');
  await fs.writeFile(path.join(path.dirname(paths.menuEntry), 'other.desktop'), '[Desktop Entry]\n');
  await setAutostart({ paths, on: true, command: [paths.appImage], icon: paths.icon });
  await uninstall({ paths, removeData: false, userData, run });
  for (const f of [paths.appImage, paths.icon, paths.info, paths.menuEntry, paths.shortcut, paths.autostart, paths.dir]) assert.ok(!fsSync.existsSync(f), `${f} removed`);
  assert.ok(fsSync.existsSync(path.join(userData, 'data', 'settings.json')), 'settings kept');
  assert.ok(fsSync.existsSync(path.join(path.dirname(paths.menuEntry), 'other.desktop')), 'other menu entries kept');
  assert.equal(await readInstall(paths), null);
  await uninstall({ paths, removeData: false, userData, run }); // again: nothing to do, no error

  await install({ from: download, paths, iconFrom: icon, version: '0.2.9', run });
  await fs.writeFile(path.join(paths.dir, 'something-of-yours.txt'), 'x');
  // What a copy or an update left half done goes too.
  for (const f of ['OpenKaraoke.AppImage.part-123', '.OpenKaraoke.AppImage.update', '.OpenKaraoke.AppImage.update.part']) await fs.writeFile(path.join(paths.dir, f), 'x');
  await uninstall({ paths, removeData: true, userData, run });
  assert.deepEqual(await fs.readdir(paths.dir), ['something-of-yours.txt'], 'only the stranger’s file is left');
  assert.ok(!fsSync.existsSync(userData), 'settings, song index and pictures removed when asked');
  assert.ok(fsSync.existsSync(path.join(paths.dir, 'something-of-yours.txt')), 'a folder with other files in it stays');
});

test('install: deleting the settings only ever deletes the app’s own folder', async () => {
  const home = '/home/jim';
  assert.ok(safeDataDir('/home/jim/.config/OpenKaraoke', home));
  for (const bad of ['/', '/home', home, '/home/jim/', '/home/jim/.config', '/home/jim/.local/share', 'relative/OpenKaraoke', '', null, '/home/jim/Documents', '/srv/data']) {
    assert.ok(!safeDataDir(bad, home), String(bad));
  }
  assert.equal(await removeUserData('/home/jim/.config', { home }), false);
  // To the Trash when it can be (it can be got back), else deleted.
  const tdir = await tmpDir();
  const profile = path.join(tdir, 'cfg', 'OpenKaraoke');
  await fs.mkdir(path.join(profile, 'data'), { recursive: true });
  const trashed = [];
  assert.equal(await removeUserData(profile, { home: '/nonexistent-home', trash: async (d) => { trashed.push(d); await fs.rename(d, path.join(tdir, 'Trash')); return true; } }), true);
  assert.deepEqual(trashed, [profile]);
  assert.ok(fsSync.existsSync(path.join(tdir, 'Trash', 'data')) && !fsSync.existsSync(profile));
  await fs.mkdir(profile, { recursive: true });
  assert.equal(await removeUserData(profile, { home: '/nonexistent-home', trash: async () => false }), true, 'no Trash: deleted');
  assert.ok(!fsSync.existsSync(profile));
  const cmd = removeLaterCommand('/home/jim/.config/OpenKaraoke', 4242, home);
  assert.deepEqual(cmd.slice(0, 2), ['sh', '-c']);
  assert.deepEqual(cmd.slice(-2), ['4242', '/home/jim/.config/OpenKaraoke'], 'the folder is an argument, never part of the script');
  assert.equal(removeLaterCommand(home, 4242, home), null);
  assert.equal(removeLaterCommand('/home/jim/.config/OpenKaraoke', 'x', home), null);
  // It waits for the process, then removes the folder.
  const dir = await tmpDir();
  const data = path.join(dir, 'Profile', 'OpenKaraoke');
  await fs.mkdir(path.join(data, 'data'), { recursive: true });
  const { spawn } = await import('node:child_process');
  // A PATH with sleep and rm but no gio: deleted.
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  for (const tool of ['sleep', 'rm']) {
    const where = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((f) => fsSync.existsSync(f));
    await fs.symlink(where, path.join(bin, tool));
  }
  const sleeper = spawn('sleep', ['0.6']); // (reaped by this process's event loop, like the desktop reaps the app)
  const c = removeLaterCommand(data, sleeper.pid, '/nonexistent-home');
  const t0 = Date.now();
  const code = await new Promise((resolve) => spawn('/bin/sh', c.slice(1), { stdio: 'ignore', env: { PATH: bin } }).on('close', resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 >= 300, 'waited for the process to end');
  assert.ok(!fsSync.existsSync(data));
  // With gio: "gio trash -- <folder>" (a stand-in that only writes down how it was called).
  await fs.mkdir(data, { recursive: true });
  const called = path.join(dir, 'gio-called.txt');
  await fs.writeFile(path.join(bin, 'gio'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${called}'\nexit 0\n`, { mode: 0o755 });
  const c2 = removeLaterCommand(data, 2 ** 22 + 4321, '/nonexistent-home');
  await new Promise((resolve) => spawn('/bin/sh', c2.slice(1), { stdio: 'ignore', env: { PATH: bin } }).on('close', resolve));
  assert.equal(await fs.readFile(called, 'utf8'), `trash\n--\n${data}\n`);
});

test('install: whether OpenKaraoke runs on a data folder (its lock)', async () => {
  const dir = await tmpDir();
  assert.equal(runningServer(dir), null);
  await fs.writeFile(path.join(dir, 'server.json'), JSON.stringify({ pid: 1, port: 6527 })); // pid 1 runs (another user's, or init)
  assert.deepEqual(runningServer(dir), { pid: 1, port: 6527 });
  await fs.writeFile(path.join(dir, 'server.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.equal(runningServer(dir), null, 'a process that is gone');
  await fs.writeFile(path.join(dir, 'server.json'), 'broken');
  assert.equal(runningServer(dir), null);
});

test('install: the setup page serves only its own files, the styles and the scripts', () => {
  assert.equal(setupFile('/setup/index.html'), path.join(ROOT, 'desktop', 'setup', 'index.html'));
  assert.equal(setupFile('/setup/'), path.join(ROOT, 'desktop', 'setup', 'index.html'));
  assert.equal(setupFile('/css/base.css'), path.join(ROOT, 'public', 'css', 'base.css'));
  assert.equal(setupFile('/shared/themes.js'), path.join(ROOT, 'shared', 'themes.js'));
  for (const bad of ['/setup/../main.mjs', '/setup/%2e%2e/main.mjs', '/../server/config.js', '/shared/../desktop/main.mjs', '/%E0%A4%A', '/']) {
    assert.equal(setupFile(bad), null, bad);
  }
  for (const f of ['index.html', 'setup.js', 'setup.css', 'preload.cjs']) assert.ok(fsSync.existsSync(path.join(ROOT, 'desktop', 'setup', f)), f);
});

test('update logic: removing the .deb or .rpm with the password prompt', () => {
  const has = (...cmds) => (cmd) => cmds.includes(cmd);
  assert.deepEqual(removeCommand('deb', has('pkexec', 'apt-get', 'dpkg')), ['pkexec', 'apt-get', 'remove', '-y', 'openkaraoke']);
  assert.deepEqual(removeCommand('deb', has('pkexec', 'dpkg')), ['pkexec', 'dpkg', '--remove', 'openkaraoke']);
  assert.deepEqual(removeCommand('rpm', has('pkexec', 'dnf', 'rpm')), ['pkexec', 'dnf', 'remove', '-y', 'openkaraoke']);
  assert.deepEqual(removeCommand('rpm', has('pkexec', 'zypper')), ['pkexec', 'zypper', '--non-interactive', 'remove', 'openkaraoke']);
  assert.deepEqual(removeCommand('rpm', has('pkexec', 'rpm')), ['pkexec', 'rpm', '-e', 'openkaraoke']);
  assert.equal(removeCommand('deb', has('apt-get')), null, 'no password prompt');
  assert.equal(removeCommand('appimage', has('pkexec', 'apt-get')), null);
});

test('packaging: OpenKaraoke-Setup.zip keeps "Install OpenKaraoke" executable', async () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 check value');
  const dir = await tmpDir();
  const app = path.join(dir, 'OpenKaraoke-1.2.3.AppImage');
  const content = Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(70_000, 7), Buffer.from('end')]);
  await fs.writeFile(app, content, { mode: 0o755 });
  const zip = makeSetupZip(app);
  assert.equal(path.basename(zip), ZIP_NAME);
  assert.equal(ZIP_NAME, 'OpenKaraoke-Setup.zip', 'no version: the README links to the latest one by name');
  // Read it back: one entry, stored, made by Unix with mode 0755, the AppImage's bytes.
  const buf = await fs.readFile(zip);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(buf.readUInt16LE(end + 10), 1, 'one entry');
  const cd = buf.readUInt32LE(end + 16);
  assert.equal(buf.readUInt32LE(cd), 0x02014b50);
  assert.equal(buf.readUInt16LE(cd + 4) >> 8, 3, 'made by Unix');
  assert.equal(buf.readUInt32LE(cd + 38) >>> 16, 0o100755, 'a regular file, rwxr-xr-x');
  const nameLen = buf.readUInt16LE(cd + 28);
  assert.equal(buf.toString('utf8', cd + 46, cd + 46 + nameLen), SETUP_NAME);
  const local = buf.readUInt32LE(cd + 42);
  const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  assert.equal(buf.readUInt16LE(local + 8), 0, 'stored');
  assert.deepEqual(buf.subarray(dataAt, dataAt + content.length), content);
  assert.equal(buf.readUInt32LE(cd + 16), crc32(content));
  // What unzip (Info-ZIP) makes of it, when it is here.
  if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0) {
    const out = path.join(dir, 'out');
    assert.equal(spawnSync('unzip', ['-q', zip, '-d', out]).status, 0);
    const st = await fs.stat(path.join(out, SETUP_NAME));
    assert.equal(st.mode & 0o777, 0o755, 'unpacked executable');
    assert.deepEqual(await fs.readFile(path.join(out, SETUP_NAME)), content);
  }
  // Several entries and a name with UTF-8.
  writeZip(path.join(dir, 'two.zip'), [{ name: 'a.txt', data: Buffer.from('a'), mode: 0o644 }, { name: 'Ünïcode', data: Buffer.from('b'), mode: 0o600 }]);
  const two = await fs.readFile(path.join(dir, 'two.zip'));
  assert.equal(two.readUInt16LE(two.length - 22 + 10), 2);
});
