#!/usr/bin/env node
// A library over 5,000 tracks inside the desktop app: the cache is loaded at start, and a rescan
// rebuilds the catalog, through worker threads (server/library/catalog-worker.js) in Electron's
// main process too, not through the fallback on the server's thread — while the app answers.
// `npm --prefix desktop test` runs it after app.mjs; APP=<packaged executable> tests a build.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, check, results, sleep, WsClient, hostWindow } from '../../test/e2e/lib.mjs';
import { makeDemoLibrary } from '../../scripts/make-demo-library.js';
import { Catalog } from '../../server/library/catalog.js';
import { manyTracks } from '../../test/helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const executable = process.env.APP ? path.resolve(process.env.INIT_CWD || process.cwd(), process.env.APP) : createRequire(import.meta.url)(path.join(DESKTOP, 'node_modules/electron'));
const appArgs = process.env.APP ? [] : [DESKTOP];
const N = 20000;

let xvfb = null;
if (!process.env.DISPLAY) {
  const display = `:${90 + Math.floor(Math.random() * 20)}`;
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  process.env.DISPLAY = display;
  await sleep(800);
}

// Two library folders: a big one known only from the cache (never scanned here) and the demo
// library, which the rescan adds — so the rescan rebuilds a catalog of N + a few tracks.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-desktop-big-'));
const userData = path.join(tmp, 'profile');
const data = path.join(userData, 'data');
const big = path.join(tmp, 'Big');
const small = path.join(tmp, 'Karaoke');
await fs.mkdir(data, { recursive: true });
await fs.mkdir(big, { recursive: true });
await fs.writeFile(path.join(big, 'readme.txt'), 'not karaoke');
await makeDemoLibrary(small, { log: () => {} });
const cache = new Catalog().load(manyTracks(N), [big, small]);
await fs.writeFile(path.join(data, 'library.json'), (await cache.toCacheText({ lastScan: { at: Date.now() } })).join(''));
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ library: { paths: [big, small], rescanOnStart: false }, artwork: { enabled: false } }));
const logFile = path.join(userData, 'logs', 'openkaraoke.log');
const logText = () => fs.readFile(logFile, 'utf8').catch(() => '');

const env = { ...process.env, OPENKARAOKE_USER_DATA: userData, OPENKARAOKE_FAKE_NMCLI: 'ok' };
delete env.XDG_SESSION_TYPE;
delete env.APPIMAGE;

const { _electron: electron } = loadPlaywright();
let app = null;
let ws = null;
let failed = false;
const get = async (base, url) => {
  const t0 = performance.now();
  const res = await fetch(`${base}${url}`);
  const body = await res.json();
  return { status: res.status, body, ms: performance.now() - t0 };
};
try {
  const t0 = Date.now();
  app = await electron.launch({ executablePath: executable, args: ['--no-sandbox', '--no-setup', ...appArgs], env, timeout: 60_000 });
  const host = await hostWindow(app, 30_000);
  await host.waitForURL(/\/host/, { timeout: 30_000 });
  const base = new URL(host.url()).origin;
  const health = await get(base, '/api/health');
  check(health.status === 200, `the host window opens and the server answers ${Date.now() - t0} ms after the start`);

  // The cache: loaded in the background, through worker threads.
  const found = await get(base, '/api/search?q=karo');
  check(found.body.items?.length > 0, `a search waits for the catalog and finds songs (${found.body.total} results)`);
  const info = (await get(base, '/api/info')).body;
  check(info.library.songs > 1000, `the ${N.toLocaleString()} cached tracks are in (${info.library.songs.toLocaleString()} songs)`);
  const loaded = /loaded (\d+) tracks .* from cache in \d+ ms \(worker threads\)/.exec(await logText());
  check(!!loaded && Number(loaded[1]) === N, `the cache was read and built in worker threads (log: "${loaded?.[0] || 'no such line'}")`);

  // A rescan of the demo folder rebuilds the whole catalog: in the worker, while searches are answered.
  ws = new WsClient(base.replace('http', 'ws') + '/ws');
  await ws.open({ role: 'host' });
  const before = info.library.songs;
  await ws.req('library.rescan', { path: small });
  const waits = [];
  let songs = before;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const s = await get(base, '/api/search?q=karo');
    waits.push(s.ms);
    songs = (await get(base, '/api/info')).body.library.songs;
    if (songs > before && /catalog rebuilt in a worker thread/.test(await logText())) break;
  }
  const log = await logText();
  const rebuilt = /catalog rebuilt in a worker thread in (\d+) ms/.exec(log);
  check(songs > before, `the rescan adds the demo songs (${before.toLocaleString()} → ${songs.toLocaleString()})`);
  check(!!rebuilt, `the catalog of ${N.toLocaleString()}+ tracks was rebuilt in a worker thread (log: "${rebuilt?.[0] || 'no such line'}")`);
  check(!/could not (rebuild|read) the (catalog|library cache)/.test(log), 'no fallback to the server’s own thread');
  const slowest = Math.max(...waits);
  check(waits.length >= 3 && slowest < 500, `searches were answered during the rescan (${waits.length}, the slowest in ${Math.round(slowest)} ms)`);
} catch (e) {
  failed = true;
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  ws?.close();
  if (app) await app.close().catch(() => app.process()?.kill('SIGKILL'));
  xvfb?.kill();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed.`);
process.exit(bad.length || failed ? 1 : 0);
