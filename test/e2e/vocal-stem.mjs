#!/usr/bin/env node
// The multiplex vocal stem on the headphone preview (not on the TV): Quiet Storm's button
// says Vocal and plays the cached stem; an ordinary song still previews the whole file.
// The separator here is the fake one — Demucs is not started — held on a gate, so the page is
// checked while the server is really still separating (the fake one alone takes ≈15 ms).
//
//   node test/e2e/vocal-stem.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fakeStemRun } from '../../server/stems/fake.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-vocal-stem');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
let release;
const gate = new Promise((resolve) => { release = resolve; });
const { app, base } = await startParty({ stemRun: async (job) => { await gate; return fakeStemRun(job); } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
const mpx = [...app.library.catalog.tracks.values()].find((t) => t.p?.flags?.mpx);

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  const media = [];
  host.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.includes('/media/')) media.push(u.pathname);
  });
  await host.goto(`${base}/host#/search?q=quiet`);
  await host.fill('.search-box input', 'quiet storm');
  await host.waitForSelector('.song-row');
  await host.click('.song-row');
  await host.waitForSelector('.versions .btn:has-text("Vocal")');
  check(!(await host.$('.versions .btn:has-text("Preview")')), 'a multiplex version’s button is Vocal, not Preview');
  check(!(await host.$('input[aria-label="Backing"], .btn:has-text("Backing")')), 'no backing-level control');
  await host.click('.versions .btn:has-text("Vocal")');
  const stem = () => app.room.stems.view(mpx.id).status;
  check(await until(() => stem() === 'separating'), 'Vocal asks the server to separate the guide vocal');
  const warned = await host.waitForSelector('.preview-output .warn-text:has-text("Separating")', { timeout: 8000 }).then(() => true, () => false);
  check(warned && stem() === 'separating' && !(await host.$('.versions .btn:has-text("Stop")')) && !media.some((p) => p.endsWith('/audio')),
    'while it separates, the preview says so and does not play the full mix');
  release();
  check(await until(() => stem() === 'ready'), 'the separation finishes');
  await host.click('.versions .btn:has-text("Vocal")');
  check(await until(() => media.some((p) => p.endsWith('/stem/vocal'))), `the headphone preview loads the vocal stem (${media.filter((p) => p.includes('/media/')).join(', ')})`);
  check(!media.some((p) => p.includes('/stem/backing') || p.includes('/stem/lead')), 'no backing stem is requested');
  await host.screenshot({ path: path.join(out, 'host-vocal.png') });
  await host.click('.versions .btn:has-text("Stop")');
  await host.click('.dialog .close');
  await host.waitForSelector('.dialog', { state: 'detached' });

  media.length = 0;
  await host.fill('.search-box input', 'neon heart');
  await host.waitForSelector('.song-row:has-text("Neon Heart")');
  await host.click('.song-row:has-text("Neon Heart")');
  await host.waitForSelector('.versions .btn:has-text("Preview")');
  check(!(await host.$('.versions .btn:has-text("Vocal")')), 'an ordinary version still says Preview');
  await host.click('.versions .btn:has-text("Preview")');
  check(await until(() => media.some((p) => p.endsWith('/audio'))), 'an ordinary preview still plays the whole file');
  check(!media.some((p) => p.includes('/stem/')), 'an ordinary preview does not ask for a stem');
  await host.click('.versions .btn:has-text("Stop")');

  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'phone');
  await phone.goto(`${base}/host#/search?q=quiet`);
  await phone.fill('.search-box input', 'quiet storm');
  await phone.waitForSelector('.song-row');
  await phone.click('.song-row');
  await phone.waitForSelector('.versions .btn:has-text("Vocal")');
  check(await noSideways(phone), 'the song dialog fits a phone');

  const code = app.settings.get('party.roomCode');
  const guest = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'guest');
  await guest.goto(`${base}/j/${code}`);
  await guest.waitForSelector('.profile-form');
  await guest.fill('.profile-form input', 'Ann');
  await guest.click('.profile-form .btn.primary');
  await guest.waitForSelector('.g-tabs');
  await guest.click('.g-tabs button:has-text("Songs")');
  await guest.fill('.g-search input', 'quiet storm');
  await guest.click('.g-songs .song-row:has-text("Quiet Storm")');
  await guest.waitForSelector('.sheet');
  check(!(await guest.$('.sheet input[aria-label="Backing"], .sheet .btn:has-text("Backing")')), 'the singer’s phone has no backing slider');
  check(await noSideways(guest), 'the song sheet fits a phone');
  await guest.screenshot({ path: path.join(out, 'guest-sheet.png') });
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await browser.close();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
