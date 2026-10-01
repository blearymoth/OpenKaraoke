// Starting as a service: bin/install-service.sh (with a stand-in systemctl that runs the
// unit's ExecStart) and the server's own start-up checks (server/index.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree } from './helpers.js';
import { offlineFetch } from './fake-art.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'bin/install-service.sh');
const linuxOnly = { skip: process.platform !== 'linux' && 'bash + systemd scripts' };

// Logs each call; start/restart run the unit's ExecStart in the background (no restart policy).
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
set -u
dir="$FAKE_SYSTEMD"
echo "$*" >> "$dir/calls"
unit="$XDG_CONFIG_HOME/systemd/user/openkaraoke.service"
stop() {
  [ -f "$dir/pid" ] || return 0
  pid="$(cat "$dir/pid")"; rm -f "$dir/pid"
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
}
case " $* " in
  *" is-active "*) [ -f "$dir/pid" ] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; exit ;;
  *" stop "*) stop ;;
  *" restart "*|*" start "*)
    stop
    line="$(grep '^ExecStart=' "$unit")"
    eval "set -- \${line#ExecStart=}"
    "$@" >> "$dir/server.log" 2>&1 &
    echo $! > "$dir/pid"
    ;;
esac
exit 0
`;

const SONG = (name) => ({ [`${name[0]}/${name}.cdg`]: 7200 * 20, [`${name[0]}/${name}.mp3`]: 100 });

function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function hold(port) {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(port, r));
  return srv;
}

const exists = (file) => fs.access(file).then(() => true, () => false);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cleanups = [];
after(async () => { for (const fn of cleanups) await fn(); });

test('install-service.sh keeps --library/--pin in the settings, not in the unit, and restarts the service', linuxOnly, async () => {
  const home = await tmpDir('ok-home-');
  const fake = await tmpDir('ok-systemd-');
  const bin = path.join(fake, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  const lib = await tmpDir('ok-lib-');
  const lib2 = await tmpDir('ok-lib2-');
  await writeTree(lib, SONG('ABBA - Waterloo [SF Karaoke]'));
  await writeTree(lib2, { ...SONG('Blondie - Call Me [SC Karaoke]'), ...SONG('Toto - Africa [SF Karaoke]') });
  const data = await tmpDir('ok-data-');
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ artwork: { enabled: false } }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMD: fake, LOG_LEVEL: 'warn' };
  delete env.OPENKARAOKE_DATA;
  delete env.PORT;
  const systemctl = (...args) => run(path.join(bin, 'systemctl'), ['--user', ...args, 'openkaraoke.service'], env);
  cleanups.push(() => systemctl('stop'));
  const port = await freePort();
  const unitFile = path.join(home, '.config/systemd/user/openkaraoke.service');
  const songs = async (n) => (await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()).library.songs === n;

  // First install.
  let r = await run('bash', [INSTALLER, '--library', lib, '--pin', '1234', '--port', String(port), '--data', data], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`running as a user service[\\s\\S]*http://localhost:${port}/host`));
  const unit = await fs.readFile(unitFile, 'utf8');
  const execStart = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  assert.ok(execStart.includes(`"--port" "${port}"`) && execStart.includes(`"--data" "${data}"`), execStart);
  assert.ok(!/--library|--pin|1234/.test(unit), 'neither the folder nor the PIN is in the unit');
  assert.match(unit, /RestartPreventExitStatus=78/);
  assert.match(unit, /StartLimitBurst=/);
  let settings = await readJson(path.join(data, 'settings.json'));
  assert.deepEqual(settings.library.paths, [lib]);
  assert.equal(settings.party.adminPin, '1234');
  assert.equal(settings.artwork.enabled, false, 'other settings are kept');
  assert.ok(await waitFor(() => songs(1)), 'the service runs with the saved folder');
  let calls = await fs.readFile(path.join(fake, 'calls'), 'utf8');
  assert.match(calls, /^--user restart openkaraoke\.service$/m);
  assert.doesNotMatch(calls, /--now/);

  // The owner adds a second drive and changes the PIN in Settings; the service restarts
  // (a re-install that only changes nothing else): the Settings changes stay.
  await systemctl('stop');
  settings.library.paths = [lib, lib2];
  settings.party.adminPin = '5678';
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
  await systemctl('start');
  assert.ok(await waitFor(() => songs(3)), 'both folders after a restart');
  r = await run('bash', [INSTALLER, '--port', String(port), '--data', data], env);
  assert.equal(r.code, 0, r.stderr);
  settings = await readJson(path.join(data, 'settings.json'));
  assert.deepEqual(settings.library.paths, [lib, lib2], 'a re-install without --library keeps the folders');
  assert.equal(settings.party.adminPin, '5678', 'and the PIN');
  assert.ok(await waitFor(() => songs(3)), 'the re-installed service answers with both folders');

  // Re-running with new options really restarts the running service.
  const pid = await fs.readFile(path.join(fake, 'pid'), 'utf8');
  const port2 = await freePort();
  r = await run('bash', [INSTALLER, '--port', String(port2), '--data', data], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`http://localhost:${port2}/host`));
  assert.notEqual(await fs.readFile(path.join(fake, 'pid'), 'utf8'), pid, 'a new server process');
  assert.ok((await fetch(`http://127.0.0.1:${port2}/api/info`)).ok, 'it listens on the new port');

  // Another copy (bin/openkaraoke.sh) holds the port: nothing is installed or saved.
  await systemctl('stop');
  const other = await hold(port);
  try {
    await fs.writeFile(path.join(fake, 'calls'), '');
    r = await run('bash', [INSTALLER, '--pin', '9999', '--port', String(port), '--data', data], env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /already in use/);
    assert.equal((await readJson(path.join(data, 'settings.json'))).party.adminPin, '5678', 'the PIN was not saved');
    calls = await fs.readFile(path.join(fake, 'calls'), 'utf8');
    assert.doesNotMatch(calls, /restart|enable/, calls);
    assert.match(await fs.readFile(unitFile, 'utf8'), new RegExp(`"--port" "${port2}"`), 'the unit is unchanged');
  } finally {
    await new Promise((res) => other.close(res));
  }
});

test('a server whose port is taken stops at once, without loading or writing anything (exit 78)', linuxOnly, async () => {
  const port = await freePort();
  const other = await hold(port);
  try {
    const data = await tmpDir('ok-data-');
    const lib = await tmpDir('ok-lib-');
    const started = Date.now();
    const r = await run(process.execPath, [path.join(ROOT, 'server/index.js'), '--port', String(port), '--data', data, '--library', lib, '--pin', '1234'], { ...process.env, LOG_LEVEL: 'warn' });
    assert.equal(r.code, 78, r.stderr);
    assert.match(r.stderr, /already in use/);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(await fs.readdir(data), [], 'no settings, state or library index written');
  } finally {
    await new Promise((res) => other.close(res));
  }
});

test('--setup saves --library/--pin, prints the port and address, and starts nothing', linuxOnly, async () => {
  const data = await tmpDir('ok-data-');
  const lib = await tmpDir('ok-lib-');
  const port = await freePort();
  const r = await run(process.execPath, [path.join(ROOT, 'server/index.js'), '--setup', '--port', String(port), '--host', '0.0.0.0', '--data', data, '--library', lib, '--pin', '4321'], { ...process.env, LOG_LEVEL: 'warn' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${port} 127.0.0.1`);
  const settings = await readJson(path.join(data, 'settings.json'));
  assert.deepEqual(settings.library.paths, [lib]);
  assert.equal(settings.party.adminPin, '4321');
  assert.deepEqual(await fs.readdir(data), ['settings.json'], 'only the settings');
});

test('a server that could not listen closes without overwriting state.json and settings.json', async () => {
  const data = await tmpDir('ok-data-');
  const lib = await tmpDir('ok-lib-');
  await writeTree(lib, SONG('ABBA - Waterloo [SF Karaoke]'));
  const port = await freePort();
  const other = await hold(port);
  try {
    // Another server on this data folder wrote these files.
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ party: { name: 'Renamed', roomCode: 'ABCD' }, library: { paths: [lib] } }));
    await fs.writeFile(path.join(data, 'state.json'), JSON.stringify({ playlists: [{ id: 'abcd1', name: 'Kept', songIds: [], createdAt: 1 }] }));
    const before = [await fs.readFile(path.join(data, 'settings.json'), 'utf8'), await fs.readFile(path.join(data, 'state.json'), 'utf8')];
    const app = await createApp({ dataDir: data, scan: false, watch: false, fetch: offlineFetch, crawl: false });
    await assert.rejects(app.listen(port, '127.0.0.1'), { code: 'EADDRINUSE' });
    await app.close({ save: false });
    await new Promise((r) => setTimeout(r, 1200)); // longer than the debounced saves
    const afterwards = [await fs.readFile(path.join(data, 'settings.json'), 'utf8'), await fs.readFile(path.join(data, 'state.json'), 'utf8')];
    assert.deepEqual(afterwards, before);
  } finally {
    await new Promise((res) => other.close(res));
  }
});
