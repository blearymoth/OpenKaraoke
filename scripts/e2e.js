#!/usr/bin/env node
// Browser end-to-end check: TV + host + two phone guests against the synthetic demo
// library, in headless Chromium. Needs Playwright (not a project dependency):
//
//   npm i -g playwright && npx playwright install chromium     # once
//   npm run e2e                                                # or: node scripts/e2e.js [--chromium /usr/bin/chromium] [--headed]
//
// Screenshots go to test-results/e2e/. Exits non-zero when a check fails.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { makeDemoLibrary } from './make-demo-library.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const headed = args.includes('--headed');
const out = path.join(root, 'test-results', 'e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch { /* try next */ }
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const require = createRequire(path.join(globalRoot, 'noop.js'));
    for (const name of ['playwright', 'playwright-core']) {
      try { return require(name); } catch { /* try next */ }
    }
  } catch { /* npm missing */ }
  console.error('Playwright not found. Install it with: npm i -g playwright && npx playwright install chromium');
  process.exit(2);
}

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
}

const { chromium } = await loadPlaywright();
await fs.mkdir(out, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'openkaraoke-e2e-'));
const lib = path.join(tmp, 'library');
console.log('Generating the demo library…');
await makeDemoLibrary(lib, { log: () => {} });
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };
const app = await createApp({ dataDir: path.join(tmp, 'data'), args: { library: [lib] }, log: quiet, watchIntervalMs: 0 });
app.library.log = quiet;
await app.listen(0, '127.0.0.1');
await app.start({ scan: false });
await app.library.scan();
app.settings.update({ playback: { countdown: 3 } });
const base = `http://127.0.0.1:${app.port}`;
console.log(`Server on ${base} (${app.library.catalog.songs.size} songs)`);

const launch = { headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] };
if (opt('--chromium')) launch.executablePath = opt('--chromium');
const browser = await chromium.launch(launch);
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
};

try {
  console.log('TV + host');
  const tv = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  watch(tv, 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby .qr-card img');
  await sleep(700);
  check(!(await tv.$('.gate')), 'TV starts without a click when autoplay is allowed');
  await tv.screenshot({ path: path.join(out, '01-tv-lobby.png') });

  const host = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(host, 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.hero');
  await host.fill('.search-box input', 'helo karaoke');
  await host.waitForSelector('.song-row');
  check((await host.textContent('.song-row .t')).includes('Hello Karaoke'), 'typo-tolerant search finds "Hello Karaoke"');
  await host.click('.song-row .btn.primary');
  await host.fill('.add-dialog input.input', 'Alice');
  await host.click('.add-dialog button[type=submit]');
  await tv.waitForSelector('.intro', { timeout: 5000 });
  check(true, 'TV shows the next-singer intro');
  await tv.screenshot({ path: path.join(out, '02-tv-intro.png') });
  await tv.waitForSelector('.stage:not(.off)', { timeout: 8000 });
  await sleep(2500);
  const pos1 = await tv.evaluate(() => window.__player.position);
  await sleep(1500);
  const pos2 = await tv.evaluate(() => window.__player.position);
  check(pos2 - pos1 > 1.2, `audio clock advances (${pos1.toFixed(2)} → ${pos2.toFixed(2)} s)`);
  await tv.screenshot({ path: path.join(out, '03-tv-lyrics.png') });
  await host.click('.knob:first-child button:last-child'); // key +1
  await sleep(500);
  check(await tv.evaluate(() => window.__player.engine.key) === 1, 'key change reaches the TV');
  await host.screenshot({ path: path.join(out, '04-host.png') });

  console.log('Guests');
  const code = app.settings.get('party.roomCode');
  const phone = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    watch(p, name);
    await p.goto(`${base}/j/${code}`);
    await p.waitForSelector('.g-profile input');
    await p.fill('.g-profile input', name);
    await p.click('.g-profile button.primary');
    await p.waitForSelector('.g-tabs');
    return p;
  };
  const request = async (p, q) => {
    await p.click('.g-tabs button:nth-child(2)');
    await p.fill('.g-search input', q);
    await p.waitForSelector('.g-song');
    await sleep(300);
    await p.click('.g-song');
    await p.waitForSelector('.sheet .btn.primary.big');
    await p.click('.sheet .btn.primary.big');
    await p.waitForSelector('.sheet-done');
    const title = await p.textContent('.sheet-done h2');
    await p.click('.sheet-done .btn.primary');
    return title;
  };
  const maya = await phone('Maya');
  await maya.screenshot({ path: path.join(out, '05-guest-home.png') });
  check(/queue/i.test(await request(maya, 'midnight')), 'guest request lands in the queue');
  const leo = await phone('Leo');
  await request(leo, 'duet');
  await request(maya, 'multiplex');
  const hs = app.room.hostView();
  check(JSON.stringify(hs.queue.map((e) => e.singers[0]?.name)) === '["Maya","Leo","Maya"]', `fair rotation: ${hs.queue.map((e) => e.singers[0]?.name).join(', ')}`);
  await leo.click('.g-tabs button:nth-child(3)');
  await leo.screenshot({ path: path.join(out, '06-guest-queue.png') });
  await leo.click('.g-tabs button:nth-child(1)');
  await leo.waitForSelector('.g-reactions button');
  await leo.click('.g-reactions button:nth-child(3)');
  await tv.waitForSelector('.reaction', { timeout: 3000 });
  check(true, 'reactions float on the TV');

  console.log('Song change + notifications');
  await host.click('.transport button:nth-child(3)'); // next singer
  await maya.waitForSelector('.g-card.turn.hot, .g-notice.now', { timeout: 6000 });
  check(true, 'Maya is told it is her turn');
  await maya.screenshot({ path: path.join(out, '07-guest-turn.png') });
  check(app.room.s.tonight.length === 0, 'a skipped song under 45 s does not count as sung');
} catch (e) {
  failures++;
  console.error('E2E error:', e.message);
} finally {
  if (errors.length) {
    failures += errors.length;
    console.log('Browser errors:\n  ' + errors.join('\n  '));
  }
  await browser.close();
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} problem(s) — screenshots in ${out}` : `\nAll good — screenshots in ${out}`);
process.exit(failures ? 1 : 0);
