#!/usr/bin/env node
// End-to-end checks of the M7 polish features in the host app: preview on this computer,
// "In queue" / "Sung tonight" marks, "Most sung here", printable songbook.
//
//   node test/e2e/polish.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-polish');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

try {
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/search?q=neon`);
  await host.fill('.search-box input', 'neon heart');
  await host.waitForSelector('.song-row');

  // Preview a version on the host computer.
  await host.click('.song-row');
  await host.waitForSelector('.versions .btn:has-text("Preview")');
  await host.click('.versions .btn:has-text("Preview") >> nth=0');
  check(await host.waitForSelector('.versions .btn:has-text("Stop")', { timeout: 8000 }).then(() => true, () => false), 'preview plays on the host computer');
  await shot(host, 'host-preview');
  await host.click('.versions .btn:has-text("Stop")');
  check(await host.waitForSelector('.versions .btn:has-text("Stop")', { state: 'detached', timeout: 5000 }).then(() => true, () => false), 'preview stops');
  await host.keyboard.press('Escape');

  // Queue it: search shows "In queue"; after it is sung: "Sung tonight" + "Most sung here".
  const song = app.library.catalog.search('neon heart').items[0];
  await app.room.request({ role: 'host', data: {}, isLocal: true, send() {} }, { t: 'queue.add', songId: song.id, singerName: 'Pat' });
  await host.fill('.search-box input', 'neon hear');
  await host.fill('.search-box input', 'neon heart');
  check(await host.waitForSelector('.song-row .tag-mark.queued', { timeout: 5000 }).then(() => true, () => false), 'search marks songs waiting in the queue');
  const room = app.room;
  const e = room.s.queue.shift();
  room.startEntry(e);
  room.s.player.pos = e.dur;
  room.finish('ended', { advance: false });
  await host.fill('.search-box input', 'neon hea');
  await host.fill('.search-box input', 'neon heart');
  check(await host.waitForSelector('.song-row .tag-mark:has-text("Sung tonight")', { timeout: 5000 }).then(() => true, () => false), 'search marks songs sung tonight');
  await host.goto(`${base}/host#/`);
  await host.reload();
  check(await host.waitForSelector('h2:has-text("Most sung here")', { timeout: 8000 }).then(() => true, () => false), 'home shows “Most sung here”');

  // Printable songbook from Settings → Library.
  await host.goto(`${base}/host#/settings/library`);
  await host.waitForSelector('a:has-text("Open songbook")');
  const [book] = await Promise.all([host.context().waitForEvent('page'), host.click('a:has-text("Open songbook")')]);
  await book.waitForSelector('main .a, main .t');
  const titles = await book.$$eval('main li, main .t', (l) => l.length);
  check(titles === app.library.catalog.songList.length, `songbook lists every song (${titles})`);
  check(!!(await book.$('header .qr svg')), 'songbook has the join QR code');
  await book.emulateMedia({ media: 'print' });
  await shot(book, 'songbook-print');
  const pdf = await book.pdf({ format: 'A4' }).catch(() => null);
  check(!!pdf && pdf.length > 1000, 'songbook prints to PDF');
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
