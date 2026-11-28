#!/usr/bin/env node
// End-to-end checks of Edit details (Song details → a version → Edit): the demo's "Neon Heart"
// (two labels) — the editor opens on the chosen version, another version is picked in it, a
// label and the year are saved, a new title moves the version to a song of its own, "Back to the
// file name" undoes it, and a phone has no sideways scrolling.
//
//   node test/e2e/track-edit.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-track-edit');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const browser = await chromium.launch();
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const seen = (page, sel, timeout = 5000) => page.waitForSelector(sel, { timeout }).then(() => true, () => false);
const cat = () => app.library.catalog;

async function openSong(page, q) {
  await page.goto(`${base}/host#/search?q=${encodeURIComponent(q)}`);
  await page.waitForSelector('.song-row');
  await page.click('.song-row');
  await page.waitForSelector('.dialog table.versions');
}

try {
  const song = cat().search('neon heart').items[0];
  const [A, B] = song.trackIds;
  const host = watch(await browser.newPage({ viewport: { width: 1280, height: 860 } }), 'host');
  await openSong(host, 'neon heart');
  check(await host.locator('.dialog table.versions button:has-text("Edit")').count() === 2, 'every version has an Edit button');

  // ---- 1. The editor opens on the version clicked; another can be picked in it --------------------
  await host.click(`.dialog tr[data-track="${A}"] button:has-text("Edit")`);
  await host.waitForSelector('.dialog h2:has-text("Edit details"), .dialog :text("Edit details")');
  check(await host.inputValue('.dialog select') === A, 'it opens on that version');
  const labelA = cat().track(A).p.brand;
  check(await host.inputValue('.dialog label.field:has-text("Label") input') === labelA, 'the label field shows the file name’s label');
  await host.selectOption('.dialog select', B);
  check(await until(async () => (await host.inputValue('.dialog label.field:has-text("Label") input')) === cat().track(B).p.brand), 'picking the other version shows its details');
  await shot(host, 'editor');

  // ---- 2. A label and a year: saved, back on Song details ---------------------------------------------
  await host.fill('.dialog label.field:has-text("Label") input', 'My Label');
  await host.fill('.dialog label.field:has-text("Year") input', '1984');
  await host.click('.dialog button:has-text("Save")');
  check(await seen(host, `.dialog tr[data-track="${B}"] td.lead:has-text("My Label")`), 'Song details shows the new label');
  check(await seen(host, '.dialog .chips a:has-text("1984")'), 'and the year');
  check(app.trackEdits.get(B)?.brand === 'My Label' && app.songMeta.get(song.key)?.year === 1984, 'kept on the server');
  check(await seen(host, `.dialog tr[data-track="${B}"] button.on:has-text("Edit")`), 'the edited version’s Edit button is marked');

  // ---- 3. A new title moves the version to a song of its own ------------------------------------------
  await host.click(`.dialog tr[data-track="${B}"] button:has-text("Edit")`);
  await host.waitForSelector('.dialog label.field:has-text("Title") input');
  check(await seen(host, '.dialog label.field:has-text("Label") button:has-text("use the file name")'), 'an edited field offers the file name’s value');
  await host.fill('.dialog label.field:has-text("Title") input', 'Neon Heart (Club Mix)');
  await host.click('.dialog button:has-text("Save")');
  check(await seen(host, '.dialog .song-detail h3:has-text("Neon Heart (Club Mix)")'), 'Song details now shows the version’s new song');
  check(await host.locator('.dialog table.versions tbody tr').count() === 1, 'with only that version');
  check(cat().song(song.id)?.trackIds.length === 1, 'the old song keeps the other version');
  await shot(host, 'moved');

  // ---- 4. Back to the file name ---------------------------------------------------------------------------
  await host.click(`.dialog tr[data-track="${B}"] button:has-text("Edit")`);
  await host.click('.dialog button:has-text("Back to the file name")');
  check(await until(async () => (await host.locator('.dialog table.versions tbody tr').count()) === 2), 'the version is back with the other one');
  check(app.trackEdits.size === 0, 'no edit kept');

  // ---- 5. A phone: no sideways scrolling --------------------------------------------------------------------
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), 'phone');
  await openSong(phone, 'neon heart');
  await phone.click(`.dialog tr[data-track="${A}"] button:has-text("Edit")`);
  await phone.waitForSelector('.dialog label.field:has-text("Title") input');
  check(await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0), 'the editor fits the phone');
  await sleep(600); // (the dialog's entrance)
  await shot(phone, 'phone');
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
