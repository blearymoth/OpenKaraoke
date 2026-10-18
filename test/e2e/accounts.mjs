#!/usr/bin/env node
// End-to-end checks of guest accounts: a guest makes one from the Me tab, another phone signs in
// and is the same singer (name, favourites, songs), a wrong password, a new password signs the
// other phone out, the host gives a new password from the Singers page, signing out, phones fit,
// no console errors.
//
//   node test/e2e/accounts.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-accounts');
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
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const room = app.room;
const seen = (page, selector, timeout = 6000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
const code = app.settings.get('party.roomCode');
// Each phone its own browser profile (its own saved token), as two real phones.
const phone = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = watch(await ctx.newPage(), name);
  await page.goto(`${base}/j/${code}`);
  return page;
};
const tab = (page, label) => page.click(`.g-tabs button:has(span:text-is("${label}"))`);
const fill = async (page, label, value) => page.fill(`.account-form label:has-text("${label}") input`, value);

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');

  // ---- phone A: a guest, a favourite, a song sung ----------------------------------------------
  const a = await phone('phoneA');
  await a.waitForSelector('.profile-form');
  check(await a.isVisible('button:has-text("I have an account")'), 'the join screen offers to sign in');
  await a.fill('.profile-form input', 'Ann');
  await a.click('.profile-form .btn.primary');
  await a.waitForSelector('.g-tabs');
  await tab(a, 'Songs');
  await a.fill('.g-search input', 'neon heart');
  await a.click('.g-songs .song-row:has-text("Neon Heart")');
  await a.waitForSelector('.sheet .big-star');
  await a.click('.sheet .big-star');
  check(await until(() => a.isVisible('.sheet .big-star.active')), 'Ann stars Neon Heart');
  await a.click('.sheet .btn.primary');
  await a.waitForSelector('.sheet-done');
  await a.click('.sheet-done .btn');
  check(await until(() => room.s.current?.title === 'Neon Heart', 20000), 'her song is on');
  room.finish('ended'); // (the song ends: it is hers now)
  await tab(a, 'Me');
  check(await seen(a, '.your-songs li:has-text("Neon Heart")'), 'Me: Your songs has Neon Heart');

  // ---- she makes an account --------------------------------------------------------------------
  check(await seen(a, '.account-card:has-text("Keep Ann for next time")'), 'Me: the account card');
  await a.click('.account-card button:has-text("Create an account")');
  await fill(a, 'Username', 'ann.k');
  await fill(a, 'Password', 'shortpw'.slice(0, 5));
  check(await a.isDisabled('.account-form .btn.primary'), 'a password under 6 characters: the button is off');
  await fill(a, 'Password', 'karaoke-night');
  await a.click('.account-form .btn.primary');
  check(await seen(a, '.account-card:has-text("Signed in as ann.k")'), 'Ann has an account (signed in as ann.k)');
  const annId = room.s.profiles && Object.keys(room.s.profiles).find((id) => room.s.profiles[id].name === 'Ann');
  check(app.accounts.ofId(annId)?.name === 'ann.k', 'her guest identity is the account');
  check(await noSideways(a), 'phone A fits (no sideways scrolling)');
  await shot(a, 'phoneA-account');

  // ---- phone B signs in: the same singer ------------------------------------------------------
  const b = await phone('phoneB');
  await b.waitForSelector('.profile-form');
  await b.click('button:has-text("I have an account")');
  await fill(b, 'Username', 'ann.k');
  await fill(b, 'Password', 'wrong password');
  await b.click('.account-form .btn.primary');
  check(await seen(b, '.toast:has-text("Wrong username or password")'), 'a wrong password is refused');
  await fill(b, 'Password', 'karaoke-night');
  await b.click('.account-form .btn.primary');
  check(await seen(b, '.g-tabs'), 'phone B is signed in');
  await tab(b, 'Me');
  check(await seen(b, '.g-profile h1:has-text("Ann")'), 'phone B is Ann (her name)');
  check(await seen(b, '.g-songs .song-row:has-text("Neon Heart")'), 'her favourites came along');
  check(await seen(b, '.your-songs li:has-text("Neon Heart")'), 'and her songs');
  check(await noSideways(b), 'phone B fits');
  await shot(b, 'phoneB-signed-in');

  // ---- a new password on phone B signs phone A out --------------------------------------------
  await b.click('.account-card button:has-text("Change password")');
  await fill(b, 'Current password', 'karaoke-night');
  await fill(b, 'New password', 'even-better-1');
  await b.click('.account-form .btn.primary');
  check(await seen(b, '.toast:has-text("other phones are signed out")'), 'phone B: password changed');
  check(await seen(a, '.profile-form', 10000), 'phone A is signed out (a new guest: the join screen)');
  check(await seen(a, '.toast:has-text("signed out")'), 'phone A says why');
  check(await seen(b, '.account-card:has-text("Signed in as ann.k")'), 'phone B stays signed in');

  // ---- the host gives her a new password -------------------------------------------------------
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/singers`);
  check(await seen(host, '.accounts tr:has-text("ann.k")'), 'host: Singers → Guests’ accounts lists ann.k');
  await host.click('.accounts tr:has-text("ann.k") button:has-text("New password")');
  await host.fill('.accounts input[placeholder="New password"]', 'from-the-host');
  await host.click('.accounts button:has-text("Save")');
  check(await seen(host, '.toast:has-text("has a new password")'), 'host: new password saved');
  check(await seen(b, '.profile-form', 10000), 'phone B is signed out by the reset');
  await shot(host, 'host-accounts');

  // Phone A signs in with the host's password; then signs out.
  await a.click('button:has-text("I have an account")');
  await fill(a, 'Username', 'ANN.K');
  await fill(a, 'Password', 'from-the-host');
  await a.click('.account-form .btn.primary');
  await a.waitForSelector('.g-tabs');
  await tab(a, 'Me');
  check(await seen(a, '.g-profile h1:has-text("Ann")'), 'phone A: signed in again with the host’s password (username in any case)');
  await a.click('.account-card button:has-text("Sign out")');
  check(await seen(a, '.profile-form', 10000), 'Sign out: phone A is a new guest');
  check(!!app.accounts.ofId(annId) && !!room.s.profiles[annId], 'the account and Ann’s profile are kept');
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
