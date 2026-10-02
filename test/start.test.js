// Starting the server (server/start.js): one server per data folder, the port asked for or
// the next free one, kept for next time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { acquireDataLock, lockHeld } from '../server/util/datalock.js';
import { findFreePort, probePort } from '../server/util/net.js';
import { listenAddress, migrateSettings, DEFAULT_PORT, DEFAULT_SETTINGS } from '../server/config.js';
import { startServer, StartError } from '../server/start.js';
import { tmpDir } from './helpers.js';
import { offlineFetch } from './fake-art.js';
import { fakeNmcli } from '../scripts/fake-nmcli.mjs';

// A pretend NetworkManager: startServer would otherwise give the real nmcli (run on its own,
// outside `node --test`, nothing else stops it).
const APP = { scan: false, watch: false, fetch: offlineFetch, crawl: false, hotspot: { run: fakeNmcli('ok').run } };
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = (file) => fs.access(file).then(() => true, () => false);

async function hold(port, host = '0.0.0.0') {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen({ port, host, exclusive: true }, resolve);
  });
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

/** Two free ports in a row: `port` and `port + 1`, both free right now. */
async function freePair() {
  for (let i = 0; i < 50; i++) {
    const a = await hold(0);
    await a.close();
    if (a.port < 65535 && !(await probePort(a.port + 1, '0.0.0.0'))) return a.port;
  }
  throw new Error('no two free ports in a row');
}

const settingsWithPort = (port) => ({ get: (k) => (k === 'server.port' ? port : k === 'server.host' ? '0.0.0.0' : undefined) });

test('listenAddress: --port and $PORT are fixed; otherwise the saved port, else the default', () => {
  assert.deepEqual(listenAddress({ port: 9000 }, settingsWithPort(7000), {}), { port: 9000, host: '0.0.0.0', fixed: true });
  assert.deepEqual(listenAddress({}, settingsWithPort(7000), { PORT: '9100' }), { port: 9100, host: '0.0.0.0', fixed: true });
  assert.deepEqual(listenAddress({}, settingsWithPort(7000), { PORT: '' }), { port: 7000, host: '0.0.0.0', fixed: false });
  assert.deepEqual(listenAddress({}, settingsWithPort(undefined), {}), { port: DEFAULT_PORT, host: '0.0.0.0', fixed: false });
  assert.equal(listenAddress({}, settingsWithPort(99999), {}).port, DEFAULT_PORT, 'not a port: the default');
  assert.equal(listenAddress({ host: '127.0.0.1' }, settingsWithPort(7000), {}).host, '127.0.0.1');
  assert.equal(DEFAULT_SETTINGS.server.port, DEFAULT_PORT);
  assert.notEqual(DEFAULT_PORT, 8080);
});

test('settings saved with the old default port (8080) move to the new default; another port stays', () => {
  const old = { server: { port: 8080, host: '0.0.0.0' }, appearance: { theme: 'studio', accent: '' } };
  assert.equal(migrateSettings(old), true);
  assert.equal(old.server.port, DEFAULT_PORT);
  const chosen = { server: { port: 9000 }, appearance: { theme: 'studio', accent: '' } };
  assert.equal(migrateSettings(chosen), false);
  assert.equal(chosen.server.port, 9000);
});

test('findFreePort: the next free port up when one is taken', async () => {
  const port = await freePair();
  const taken = await hold(port);
  try {
    assert.equal(await findFreePort('0.0.0.0', port), port + 1);
  } finally {
    await taken.close();
  }
  assert.equal(await findFreePort('0.0.0.0', port), port, 'free again');
});

test('data folder lock: one holder at a time; left-over locks are taken over', async () => {
  const dir = await tmpDir('ok-lock-');
  const file = path.join(dir, 'server.json');
  const mine = await acquireDataLock(dir);
  assert.equal(mine.ok, true);
  await mine.update({ port: 1234, host: '0.0.0.0' });
  assert.equal((await readJson(file)).port, 1234);
  // Another (running) process can't have it: here the parent of this test process.
  const other = await acquireDataLock(dir, { pid: process.ppid });
  assert.equal(other.ok, false);
  assert.equal(other.holder.pid, process.pid);
  assert.equal(other.holder.port, 1234, 'it can tell where the running one is');
  await mine.release();
  assert.equal(await exists(file), false);

  // Another running process holds it (here: this test's parent).
  await fs.writeFile(file, JSON.stringify({ pid: process.ppid, port: 4321 }));
  const blocked = await acquireDataLock(dir);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.holder.port, 4321);
  await fs.rm(file);
  // A process that is gone (crash, power cut): taken over.
  await fs.writeFile(file, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 1 }));
  const after = await acquireDataLock(dir);
  assert.equal(after.ok, true);
  await after.release();
  // A lock from before a reboot: its process id means nothing now.
  assert.equal(lockHeld({ pid: process.ppid, boot: 'another-boot' }, { boot: 'this-boot' }), false);
  assert.equal(lockHeld({ pid: process.ppid, boot: 'this-boot' }, { boot: 'this-boot' }), true);
  // Releasing never removes a lock someone else took over meanwhile.
  const first = await acquireDataLock(dir);
  await fs.writeFile(file, JSON.stringify({ pid: process.ppid }));
  await first.release();
  assert.equal(await exists(file), true);
});

test('startServer: when the saved port is taken, the next free one is used and kept for next time', async () => {
  const port = await freePair();
  const dataDir = await tmpDir('ok-data-');
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ server: { port } }));
  const taken = await hold(port);
  const warnings = [];
  let s;
  try {
    s = await startServer({ dataDir, env: {}, appOptions: APP, log: { warn: (m) => warnings.push(m) } });
    assert.equal(s.port, port + 1);
    assert.equal(s.moved, true);
    assert.match(warnings.join('\n'), new RegExp(`Port ${port} is used by another program.*${port + 1}`));
    assert.equal((await readJson(path.join(dataDir, 'settings.json'))).server.port, port + 1, 'kept in the settings');
    assert.equal((await readJson(path.join(dataDir, 'server.json'))).port, port + 1, 'the lock says where it runs');
    assert.ok((await fetch(`http://127.0.0.1:${port + 1}/api/info`)).ok);

    // A second server on the same data folder stops before loading anything.
    await assert.rejects(startServer({ dataDir, env: {}, appOptions: APP }), (e) => e instanceof StartError && e.code === 'RUNNING' && e.exitCode === 78 && e.message.includes(`localhost:${port + 1}`));
  } finally {
    await s?.close();
    await taken.close();
  }
  assert.equal(await exists(path.join(dataDir, 'server.json')), false, 'the lock is gone after closing');
  // Next time: the same port again, even though the first one is free now.
  const again = await startServer({ dataDir, env: {}, appOptions: APP });
  try {
    assert.equal(again.port, port + 1);
    assert.equal(again.moved, false);
  } finally {
    await again.close();
  }
});

test('startServer: a port asked for with --port is the only one; taken → StartError (exit 78), nothing written', async () => {
  const dataDir = await tmpDir('ok-data-');
  const taken = await hold(0);
  try {
    await assert.rejects(startServer({ dataDir, args: { port: taken.port }, env: {}, appOptions: APP }),
      (e) => e instanceof StartError && e.code === 'EADDRINUSE' && e.exitCode === 78 && /already in use/.test(e.message));
  } finally {
    await taken.close();
  }
  await new Promise((r) => setTimeout(r, 500)); // longer than the debounced settings save
  assert.deepEqual(await fs.readdir(dataDir), [], 'no settings, state, index or lock left behind');
});

test('startServer --setup: picks the port (a free one when the saved one is taken), saves it with --library/--pin, starts nothing', async () => {
  const port = await freePair();
  const dataDir = await tmpDir('ok-data-');
  const lib = await tmpDir('ok-lib-');
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ server: { port } }));
  const taken = await hold(port);
  try {
    const r = await startServer({ dataDir, args: { setup: true, library: [lib], pin: '4321' }, env: {}, appOptions: APP });
    assert.deepEqual(r, { setup: true, port: port + 1, host: '0.0.0.0' });
  } finally {
    await taken.close();
  }
  const saved = await readJson(path.join(dataDir, 'settings.json'));
  assert.equal(saved.server.port, port + 1);
  assert.deepEqual(saved.library.paths, [lib]);
  assert.equal(saved.party.adminPin, '4321');
  assert.deepEqual(await fs.readdir(dataDir), ['settings.json'], 'no lock left behind');
});
