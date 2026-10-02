// The desktop app's parts that need no Electron: where the TV window goes (desktop/displays.mjs)
// and its updates (desktop/update-logic.mjs, desktop/updater.mjs against a stand-in for GitHub).
// The app itself is tested end to end by desktop/test/app.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { centredBounds, displayFor, nextDisplay, tvDisplay, visibleBounds } from '../desktop/displays.mjs';
import { compareVersions, expectedHash, installCommand, installKind, parseChecksums, parseVersion, pickAsset, releaseInfo } from '../desktop/update-logic.mjs';
import { Updater } from '../desktop/updater.mjs';
import { tmpDir } from './helpers.js';
import { fakeGitHub, serve } from './fake-github.js';

const exists = (file) => fs.access(file).then(() => true, () => false);

// ---- displays -------------------------------------------------------------------------------

const LAPTOP = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 760 } };
const TV = { id: 2, bounds: { x: 1280, y: 0, width: 1920, height: 1080 } };
const PROJECTOR = { id: 3, bounds: { x: 3200, y: 0, width: 1280, height: 720 } };

test('displays: which screen a window is on, where the TV goes, next screen, centring', () => {
  assert.equal(displayFor([LAPTOP, TV], { x: 1500, y: 100, width: 400, height: 300 }).id, 2);
  // Centre off every screen: the one it overlaps most.
  assert.equal(displayFor([LAPTOP, TV], { x: 900, y: 600, width: 500, height: 600 }).id, 1);
  assert.equal(displayFor([], { x: 0, y: 0, width: 10, height: 10 }), null);

  assert.equal(tvDisplay([LAPTOP, TV], 1, { primaryId: 1 }).id, 2);
  assert.equal(tvDisplay([LAPTOP, TV, PROJECTOR], 1, { primaryId: 1, rememberedId: 3 }).id, 3, 'the screen it was on last time');
  assert.equal(tvDisplay([LAPTOP, TV, PROJECTOR], 1, { primaryId: 1, rememberedId: 9 }).id, 2, 'a forgotten screen is ignored');
  assert.equal(tvDisplay([LAPTOP, TV], 2, { primaryId: 2 }).id, 1, 'the host window on the TV: the other screen');
  assert.equal(tvDisplay([LAPTOP], 1, { primaryId: 1 }), null, 'one screen: a normal window');

  assert.equal(nextDisplay([LAPTOP, TV, PROJECTOR], 2).id, 3);
  assert.equal(nextDisplay([LAPTOP, TV, PROJECTOR], 3).id, 1);
  assert.equal(nextDisplay([LAPTOP, TV], 99).id, 1);

  assert.deepEqual(centredBounds(LAPTOP, 1000, 600), { x: 140, y: 80, width: 1000, height: 600 });
  assert.deepEqual(centredBounds(LAPTOP, 4000, 4000), { x: 0, y: 0, width: 1280, height: 760 }, 'shrunk to the work area');
  assert.deepEqual(centredBounds(TV), { x: 1600, y: 180, width: 1280, height: 720 });

  const saved = { x: 100, y: 100, width: 800, height: 600 };
  assert.equal(visibleBounds([LAPTOP], saved), saved);
  assert.equal(visibleBounds([LAPTOP], { x: 1100, y: 100, width: 800, height: 600 }), null, 'mostly on a screen that is gone');
  assert.equal(visibleBounds([LAPTOP], { x: Number.NaN, y: 0, width: 10, height: 10 }), null);
  assert.equal(visibleBounds([LAPTOP], undefined), null);
});

// ---- update logic ---------------------------------------------------------------------------

test('update logic: versions, the right file of a release, checksums', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { parts: [1, 2, 3], pre: '' });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('latest'), null);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0, 'numbers, not text');
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.2.3-beta', '1.2.3') < 0, 'a pre-release comes before its release');
  assert.ok(compareVersions('1.2.3', '1.2.3-rc.1') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('nonsense', '1.0.0'), 0, 'never "newer" when a version can’t be read');

  const assets = [
    null,
    { name: 5 },
    { name: 'SHA256SUMS' },
    { name: 'OpenKaraoke-0.1.7-arm64.AppImage' },
    { name: 'OpenKaraoke-0.1.7.AppImage' },
    { name: 'openkaraoke_0.1.7_amd64.deb' },
    { name: 'openkaraoke_0.1.7_arm64.deb' },
    { name: 'openkaraoke-0.1.7.x86_64.rpm' },
    { name: 'openkaraoke-0.1.7.aarch64.rpm' },
  ];
  assert.equal(pickAsset(assets, 'appimage', 'x64').name, 'OpenKaraoke-0.1.7.AppImage');
  assert.equal(pickAsset(assets, 'appimage', 'arm64').name, 'OpenKaraoke-0.1.7-arm64.AppImage');
  assert.equal(pickAsset(assets, 'deb', 'x64').name, 'openkaraoke_0.1.7_amd64.deb');
  assert.equal(pickAsset(assets, 'deb', 'arm64').name, 'openkaraoke_0.1.7_arm64.deb');
  assert.equal(pickAsset(assets, 'rpm', 'x64').name, 'openkaraoke-0.1.7.x86_64.rpm');
  assert.equal(pickAsset(assets, 'rpm', 'arm64').name, 'openkaraoke-0.1.7.aarch64.rpm');
  assert.equal(pickAsset(assets, 'deb', 'ia32'), null);
  assert.equal(pickAsset(assets, 'source', 'x64'), null);
  assert.equal(pickAsset(undefined, 'deb'), null);

  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseChecksums(`${a}  OpenKaraoke-0.1.7.AppImage\r\n${b} *openkaraoke_0.1.7_amd64.deb\nnot a line\n`);
  assert.equal(sums.get('OpenKaraoke-0.1.7.AppImage'), a);
  assert.equal(sums.get('openkaraoke_0.1.7_amd64.deb'), 'b'.repeat(64), 'binary marker, lower case');
  assert.equal(sums.size, 2);
  assert.equal(expectedHash({ name: 'OpenKaraoke-0.1.7.AppImage' }, sums), a, 'from SHA256SUMS');
  assert.equal(expectedHash({ name: 'x', digest: `sha256:${'C'.repeat(64)}` }, sums), 'c'.repeat(64), 'from GitHub’s digest');
  assert.equal(expectedHash({ name: 'OpenKaraoke-0.1.7.AppImage', digest: `sha256:${a}` }, sums), a, 'both, the same');
  assert.equal(expectedHash({ name: 'OpenKaraoke-0.1.7.AppImage', digest: `sha256:${'d'.repeat(64)}` }, sums), null, 'both, different: no install');
  assert.equal(expectedHash({ name: 'x', digest: 'md5:abc' }, sums), null);
  assert.equal(expectedHash({ name: 'x' }, null), null);

  const info = releaseInfo({ tag_name: 'v0.1.7', body: 'x'.repeat(30_000), html_url: 'https://github.com/o/r/releases/tag/v0.1.7', published_at: '2026-10-01T10:00:00Z' });
  assert.equal(info.version, '0.1.7');
  assert.equal(info.name, 'OpenKaraoke 0.1.7');
  assert.equal(info.notes.length, 20_000);
  assert.equal(releaseInfo({ tag_name: 'nightly' }), null);
  assert.equal(releaseInfo(null), null);
});

test('update logic: how this copy was installed, and the command that updates it', () => {
  const EXE = '/opt/OpenKaraoke/openkaraoke';
  const runner = (answers) => (cmd) => answers[cmd] || { status: 1, stdout: '' };
  assert.equal(installKind({ env: { APPIMAGE: '/home/me/OpenKaraoke.AppImage' }, packaged: true, execPath: EXE, run: runner({}) }), 'appimage');
  assert.equal(installKind({ env: {}, packaged: false, execPath: EXE, run: runner({}) }), 'source');
  assert.equal(installKind({ env: {}, packaged: true, execPath: EXE, run: runner({ 'dpkg-query': { status: 0, stdout: `openkaraoke: ${EXE}\n` } }) }), 'deb');
  assert.equal(installKind({ env: {}, packaged: true, execPath: EXE, run: runner({ rpm: { status: 0, stdout: 'openkaraoke' } }) }), 'rpm');
  assert.equal(installKind({ env: {}, packaged: true, execPath: EXE, run: runner({ 'dpkg-query': { status: 0, stdout: `something-else: ${EXE}\n` } }) }), 'unknown', 'another package’s file');
  assert.equal(installKind({ env: {}, packaged: true, execPath: EXE, run: () => { throw new Error('ENOENT'); } }), 'unknown');
  assert.equal(installKind({ env: {}, packaged: true, execPath: '', run: runner({ rpm: { status: 0, stdout: 'openkaraoke' } }) }), 'unknown');

  const only = (...cmds) => (c) => cmds.includes(c);
  assert.equal(installCommand('deb', '/d/x.deb', only('apt-get', 'dpkg')), null, 'no pkexec: the software centre instead');
  assert.deepEqual(installCommand('deb', '/d/x.deb', only('pkexec', 'apt-get', 'dpkg')), ['pkexec', 'apt-get', 'install', '-y', '--allow-downgrades', '/d/x.deb']);
  assert.deepEqual(installCommand('deb', '/d/x.deb', only('pkexec', 'dpkg')), ['pkexec', 'dpkg', '-i', '/d/x.deb']);
  assert.deepEqual(installCommand('rpm', '/d/x.rpm', only('pkexec', 'dnf', 'rpm')), ['pkexec', 'dnf', 'install', '-y', '/d/x.rpm']);
  assert.deepEqual(installCommand('rpm', '/d/x.rpm', only('pkexec', 'zypper', 'rpm')), ['pkexec', 'zypper', '--non-interactive', 'install', '--allow-unsigned-rpm', '/d/x.rpm']);
  assert.deepEqual(installCommand('rpm', '/d/x.rpm', only('pkexec', 'rpm')), ['pkexec', 'rpm', '-U', '--replacepkgs', '/d/x.rpm']);
  assert.equal(installCommand('rpm', '/d/x.rpm', only('pkexec')), null);
  assert.equal(installCommand('appimage', '/d/x', only('pkexec', 'dnf')), null);
});

// ---- the updater against a stand-in for GitHub ----------------------------------------------

const NEW = {
  'OpenKaraoke-9.9.9.AppImage': Buffer.from('#!/bin/sh\necho the new OpenKaraoke\n'),
  'openkaraoke_9.9.9_amd64.deb': Buffer.from('a new .deb'),
  'openkaraoke-9.9.9.x86_64.rpm': Buffer.from('a new .rpm'),
};
const TOKEN = `github_pat_${'A1b2'.repeat(10)}`;

async function makeUpdater(api, options = {}) {
  const dir = await tmpDir('ok-updates-');
  const updater = new Updater({
    repo: 'o/r',
    version: '1.0.0',
    packaged: true,
    configFile: path.join(dir, 'profile', 'updates.json'),
    downloadDir: path.join(dir, 'Downloads'),
    fetch: globalThis.fetch,
    api,
    env: {},
    arch: 'x64',
    ...options,
  });
  return { updater, dir };
}

test('Updater: an AppImage is swapped for the checked download; a restart finishes it', async (t) => {
  const gh = await fakeGitHub();
  t.after(() => gh.close());
  const dir = await tmpDir('ok-appimage-');
  const appImage = path.join(dir, 'OpenKaraoke-1.0.0.AppImage');
  await fs.writeFile(appImage, 'the old OpenKaraoke', { mode: 0o755 });
  const { updater } = await makeUpdater(gh.api, { env: { APPIMAGE: appImage } });
  assert.equal(updater.kind, 'appimage');
  const states = [];
  updater.on('state', (s) => states.push(s.status));

  let s = await updater.check();
  assert.equal(s.status, 'unavailable', 'no release yet');
  assert.match(s.error, /private|none yet/);

  gh.publish('1.0.0', NEW);
  s = await updater.check();
  assert.equal(s.status, 'current');
  assert.equal(s.latest.version, '1.0.0');

  gh.publish('9.9.9', NEW);
  s = await updater.check();
  assert.equal(s.status, 'available');
  assert.equal(s.latest.version, '9.9.9');
  assert.equal(s.latest.url, 'https://github.com/o/r/releases/tag/v9.9.9');
  assert.match(s.latest.notes, /Faster search/);

  s = await updater.install();
  assert.equal(s.status, 'ready', s.error);
  assert.equal(await fs.readFile(appImage, 'utf8'), NEW['OpenKaraoke-9.9.9.AppImage'].toString());
  assert.ok(((await fs.stat(appImage)).mode & 0o111) === 0o111, 'still executable');
  assert.deepEqual(await fs.readdir(dir), ['OpenKaraoke-1.0.0.AppImage'], 'nothing left next to it');
  assert.deepEqual(states.slice(-2), ['downloading', 'ready']);

  // Waiting for the restart: no more checks, no second install.
  const asked = gh.seen.length;
  assert.equal((await updater.check()).status, 'ready');
  assert.equal((await updater.install()).status, 'ready');
  assert.equal(gh.seen.length, asked);
});

test('Updater: a download that doesn’t match its checksum changes nothing', async (t) => {
  const gh = await fakeGitHub();
  t.after(() => gh.close());
  const dir = await tmpDir('ok-appimage-');
  const appImage = path.join(dir, 'OpenKaraoke.AppImage');
  await fs.writeFile(appImage, 'the old OpenKaraoke', { mode: 0o755 });
  const { updater } = await makeUpdater(gh.api, { env: { APPIMAGE: appImage } });

  gh.publish('9.9.9', NEW, { wrongSum: 'OpenKaraoke-9.9.9.AppImage' });
  await updater.check();
  let s = await updater.install();
  assert.equal(s.status, 'available');
  assert.match(s.error, /checksum/);
  assert.equal(await fs.readFile(appImage, 'utf8'), 'the old OpenKaraoke');
  assert.deepEqual(await fs.readdir(dir), ['OpenKaraoke.AppImage']);

  // No checksum at all: not installed either.
  gh.publish('9.9.10', NEW, { sums: false });
  await updater.check();
  s = await updater.install();
  assert.match(s.error, /no checksum/);
  assert.equal(await fs.readFile(appImage, 'utf8'), 'the old OpenKaraoke');

  // GitHub's own digests are enough without SHA256SUMS.
  gh.publish('9.9.11', NEW, { sums: false, digests: true });
  await updater.check();
  s = await updater.install();
  assert.equal(s.status, 'ready', s.error);
  assert.equal(await fs.readFile(appImage, 'utf8'), NEW['OpenKaraoke-9.9.9.AppImage'].toString());
});

test('Updater: a private repository needs a token, which goes to GitHub’s API only', async (t) => {
  const gh = await fakeGitHub({ token: TOKEN });
  t.after(() => gh.close());
  gh.publish('9.9.9', NEW);
  const dir = await tmpDir('ok-appimage-');
  const appImage = path.join(dir, 'OpenKaraoke.AppImage');
  await fs.writeFile(appImage, 'old', { mode: 0o755 });
  const { updater } = await makeUpdater(gh.api, { env: { APPIMAGE: appImage } });

  let s = await updater.check();
  assert.equal(s.status, 'unavailable');
  assert.equal(s.needsToken, true);
  assert.match(s.error, /private/);

  await assert.rejects(updater.setToken('not a token!'), /doesn’t look like a GitHub token/);
  s = await updater.setToken(` ${TOKEN} `);
  assert.equal(s.status, 'available');
  assert.equal(s.hasToken, true);
  assert.equal(s.needsToken, false);
  assert.ok(!JSON.stringify(s).includes(TOKEN), 'the page never sees the token');
  const stat = await fs.stat(updater.configFile);
  assert.equal(stat.mode & 0o777, 0o600, 'updates.json is readable by this user only');
  assert.equal(JSON.parse(await fs.readFile(updater.configFile, 'utf8')).token, TOKEN);

  s = await updater.install();
  assert.equal(s.status, 'ready', s.error);
  assert.equal(await fs.readFile(appImage, 'utf8'), NEW['OpenKaraoke-9.9.9.AppImage'].toString());
  const api = gh.seen.filter((r) => r.at === 'api' && r.auth);
  const storage = gh.seen.filter((r) => r.at === 'storage');
  assert.ok(api.some((r) => r.url.includes('/releases/assets/')), 'files come through the API with the token');
  assert.ok(storage.length >= 2 && storage.every((r) => r.auth === null), 'the file storage never gets the token');

  // Kept for next time; removed on request.
  const again = new Updater({ repo: 'o/r', version: '1.0.0', packaged: true, configFile: updater.configFile, downloadDir: dir, fetch: globalThis.fetch, api: gh.api, env: {} });
  assert.equal(again.publicState().hasToken, true);
  assert.equal(again.publicState().autoCheck, true);
  await again.setAutoCheck(false);
  s = await again.setToken('');
  assert.equal(s.hasToken, false);
  assert.equal(s.needsToken, true);
  assert.deepEqual(JSON.parse(await fs.readFile(updater.configFile, 'utf8')), { autoCheck: false, token: '' });
});

/** The package manager, pretended: it records the command and answers `result`. */
class PretendInstall extends Updater {
  constructor(options, result) {
    super(options);
    this.result = result;
    this.ran = [];
  }

  async runInstaller(cmd) {
    this.ran.push(cmd);
    return this.result;
  }
}

test('Updater: a .deb or .rpm is installed with the password prompt, or opened in the software centre', async (t) => {
  const gh = await fakeGitHub();
  t.after(() => gh.close());
  gh.publish('9.9.9', NEW);
  const opened = [];
  const base = async (kind, result, has = () => true) => {
    const dir = await tmpDir('ok-pkg-');
    const u = new PretendInstall({
      repo: 'o/r', version: '1.0.0', packaged: true, kind, has, arch: 'x64', env: {},
      configFile: path.join(dir, 'updates.json'), downloadDir: path.join(dir, 'Downloads'),
      fetch: globalThis.fetch, api: gh.api, openPath: async (file) => opened.push(file),
    }, result);
    await u.check();
    return { u, dir, s: await u.install() };
  };

  let { u, dir, s } = await base('deb', { code: 0, stderr: '' });
  const deb = path.join(dir, 'Downloads', 'openkaraoke_9.9.9_amd64.deb');
  assert.equal(s.status, 'ready', s.error);
  assert.deepEqual(u.ran, [['pkexec', 'apt-get', 'install', '-y', '--allow-downgrades', deb]]);
  assert.equal(await exists(deb), false, 'the package is removed once installed');

  ({ u, dir, s } = await base('rpm', { code: 0, stderr: '' }));
  assert.deepEqual(u.ran, [['pkexec', 'dnf', 'install', '-y', path.join(dir, 'Downloads', 'openkaraoke-9.9.9.x86_64.rpm')]]);
  assert.equal(s.status, 'ready');

  ({ s } = await base('deb', { code: 126, stderr: '' }));
  assert.equal(s.status, 'available');
  assert.match(s.error, /cancelled/);

  ({ u, dir, s } = await base('deb', { code: 100, stderr: 'Reading package lists...\nE: Could not get lock /var/lib/dpkg/lock-frontend\n' }));
  assert.equal(s.status, 'available');
  assert.match(s.error, /installation failed: .*Could not get lock/);

  // No password prompt on this desktop, or no pkexec at all: the software centre takes over.
  ({ u, dir, s } = await base('deb', { code: 127, stderr: 'Error executing command as another user: No authentication agent found.' }));
  assert.equal(s.status, 'available');
  assert.equal(opened.at(-1), path.join(dir, 'Downloads', 'openkaraoke_9.9.9_amd64.deb'));
  assert.equal(await exists(opened.at(-1)), true);
  assert.match(s.error, /software centre/);

  ({ u, dir, s } = await base('rpm', null, (cmd) => cmd !== 'pkexec'));
  assert.deepEqual(u.ran, []);
  assert.equal(opened.at(-1), path.join(dir, 'Downloads', 'openkaraoke-9.9.9.x86_64.rpm'));
  assert.match(s.error, /software centre/);

  // Run from the source code, or an unpacked copy: never replaced.
  ({ u, s } = await base('source', { code: 0, stderr: '' }));
  assert.equal(s.status, 'available');
  assert.match(s.error, /git pull/);
  assert.deepEqual(u.ran, []);
  ({ s } = await base('unknown', { code: 0, stderr: '' }));
  assert.match(s.error, /release page/);
});

test('Updater: offline, refusals, unsafe redirects', async () => {
  const closed = await serve(() => {});
  await closed.close();
  let { updater } = await makeUpdater(closed.url);
  let s = await updater.check();
  assert.equal(s.status, 'unavailable');
  assert.match(s.error, /can’t be reached/);
  assert.ok(s.checkedAt > 0);

  // GitHub (pretended) sends the request on to plain http, or around in circles: stopped.
  const calls = [];
  const redirecting = (location) => async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization || null, redirect: init.redirect });
    return new Response(null, { status: 302, headers: { Location: location(url) } });
  };
  ({ updater } = await makeUpdater('https://api.github.test', { fetch: redirecting(() => 'http://elsewhere.test/latest') }));
  s = await updater.check();
  assert.match(s.error, /unsafe/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual', 'redirects are followed by the updater itself');

  calls.length = 0;
  ({ updater } = await makeUpdater('https://api.github.test', { fetch: redirecting((url) => `${url}x`) }));
  s = await updater.check();
  assert.match(s.error, /in circles/);
  assert.equal(calls.length, 6);

  // Rate limited, a refused token, nonsense: said plainly, and checked again later.
  for (const [status, body, error] of [[403, '{}', /wait a little/], [401, '{}', /refused the token/], [200, 'not json', /couldn’t be read/], [200, '{"tag_name":"tip"}', /no version number/], [500, '{}', /answered 500/]]) {
    ({ updater } = await makeUpdater('https://api.github.test', { fetch: async () => new Response(body, { status }) }));
    s = await updater.check();
    assert.equal(s.status, 'unavailable');
    assert.match(s.error, error);
  }
});
