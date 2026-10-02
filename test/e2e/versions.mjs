#!/usr/bin/env node
// End-to-end checks of per-version play counts and votes on the demo's "Neon Heart" (two labels):
// guests vote on the version they hear, the host sees the votes and settles them, the default
// version follows, a guest picks a version in the song sheet, plays are counted, the switch to
// turn guest votes off, and phones without sideways scrolling — in both skins.
//
//   node test/e2e/versions.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-versions');
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
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const seen = (page, sel, timeout = 5000) => page.waitForSelector(sel, { timeout }).then(() => true, () => false);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0);
const code = app.settings.get('party.roomCode');
async function guest(name, width = 390, height = 844) {
  const p = watch(await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
  await p.goto(`${base}/j/${code}`);
  await p.waitForSelector('.profile-form');
  await p.fill('.profile-form input', name);
  await p.click('.profile-form .btn.primary');
  await p.waitForSelector('.g-tabs');
  return p;
}
const downCount = (page, scope) => page.textContent(`${scope} .vote-btn.down .num`).then((t) => Number(t));

try {
  const song = app.library.catalog.search('neon heart').items[0];
  const detail = room.decorateVersions(app.library.catalog.songDetail(song.id), { voter: '@host' });
  const A = detail.defaultTrackId;
  const B = detail.versions.find((v) => v.id !== A).id;
  const nameOf = (id) => detail.versions.find((v) => v.id === id).brandName || detail.versions.find((v) => v.id === id).brand;
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const host = watch(await browser.newPage({ viewport: { width: 1280, height: 800 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.admin-panel');
  const ana = await guest('Ana');
  const ben = await guest('Ben');

  // ---- 1. Guests vote on the version they hear ------------------------------------------------
  await hostReq('settings.update', { patch: { playback: { countdown: 60 } } });
  await hostReq('queue.add', { songId: song.id, trackId: A, singerName: 'Host' });
  if (!room.s.current) await hostReq('player.play');
  check(room.s.current?.trackId === A, 'the default version is on');
  for (const g of [ana, ben]) check(await seen(g, '.g-now-version:has-text("Version:")'), 'the guest’s Home shows the version with thumbs');
  await ana.click('.g-now-version .vote-btn.down');
  check(await seen(ana, '.g-now-version .vote-btn.down[aria-pressed="true"]') && await until(async () => (await downCount(ana, '.g-now-version')) === 1), 'Ana votes it down');
  await ben.click('.g-now-version .vote-btn.down');
  check(await until(async () => (await downCount(ana, '.g-now-version')) === 2), 'Ana sees Ben’s vote without a reload');
  await shot(ana, 'guest-home-vote');

  // ---- 2. The host sees it, settles it ------------------------------------------------------------
  await host.click('.admin-panel [role=tab]:has-text("Playback")');
  check(await seen(host, '#pb-version .pill:has-text("Avoided")') && (await downCount(host, '#pb-version')) === 2, 'the Playback tab shows “Avoided” and two downs');
  await host.click('#pb-version button:has-text("All versions")');
  await host.waitForSelector('.dialog table.versions');
  const heads = await host.$$eval('.dialog table.versions th', (l) => l.map((t) => t.textContent.trim()));
  check(heads.includes('Sung') && heads.includes('Votes'), `the Song dialog has Sung and Votes (${heads.join(', ')})`);
  const rowA = `.dialog table.versions tr[data-track="${A}"]`;
  const rowB = `.dialog table.versions tr[data-track="${B}"]`;
  check(await seen(host, `${rowA} .pill:has-text("Avoided")`) && await seen(host, `${rowA} .pill:has-text("Played tonight")`), 'A: avoided, played tonight');
  check(await seen(host, `${rowB} .pill.neon`), 'B is the default now');
  await shot(host, 'host-song-dialog');
  await host.click(`${rowA} .vote-btn.up`);
  check(await seen(host, `${rowA} .pill:has-text("Your pick")`) && await until(async () => !(await host.$(`${rowA} .pill:has-text("Avoided")`))), 'the host’s thumbs up: “Your pick”, not avoided');
  check(await until(() => room.pickTrack(app.library.catalog.song(song.id)).id === A), 'A is the default again');
  await host.click(`${rowA} .vote-btn.up`);
  check(await seen(host, `${rowA} .pill:has-text("Avoided")`), 'pressing again takes the vote back');
  await host.click('.dialog .close');

  // ---- 3. A guest picks a version -------------------------------------------------------------
  await hostReq('player.next'); // skipped (still heard tonight)
  await ana.click('.g-tabs button:has-text("Songs")');
  await ana.fill('.g-search input', 'neon heart');
  await ana.click('.g-songs .song-row:has-text("Neon Heart")');
  await ana.waitForSelector('.sheet .g-versions');
  check((await ana.textContent('.g-versions summary')).includes(`Best — ${nameOf(B)}`), 'the sheet says the best version is B now');
  await ana.click('.g-versions summary');
  const voteA = await ana.$(`.g-version[data-track="${A}"] .vote-btn.up`);
  const voteB = await ana.$(`.g-version[data-track="${B}"] .vote-btn.up`);
  check(voteA && !(await voteA.isDisabled()) && voteB && (await voteB.isDisabled()), 'votes only on what was played tonight');
  await shot(ana, 'guest-sheet-versions');
  await ana.click(`.g-version[data-track="${A}"] input[type=radio]`);
  await ana.click('.sheet .btn.primary');
  await ana.waitForSelector('.sheet-done');
  const anaEntry = [room.s.current, ...room.s.queue].find((e) => e?.addedBy && room.profileOf(e.addedBy)?.name === 'Ana');
  check(anaEntry?.trackId === A, 'the version she picked is queued');
  await ana.click('.sheet-done .btn');

  // ---- 4. Plays are counted -------------------------------------------------------------------
  await hostReq('queue.clear');
  if (room.s.current) await hostReq('player.stop');
  await hostReq('queue.clear');
  await hostReq('queue.add', { songId: song.id, trackId: B, singerName: 'Host', position: 'now' });
  check(await until(() => room.s.current?.trackId === B), 'B is on');
  room.finish('ended');
  check(room.versions.info(B).plays === 1, 'a finished song counts a play for its version');
  await host.goto(`${base}/host#/search?q=neon`);
  await host.fill('.search-box input', 'neon heart');
  await host.waitForSelector('.song-row');
  await host.click('.song-row');
  await host.waitForSelector('.dialog table.versions');
  check(await seen(host, `${rowB} td[data-label="Sung"]:has-text("1×")`), 'the Song dialog: sung 1×');
  await host.click('.dialog .btn.primary:has-text("Add to queue")');
  await host.waitForSelector('.dialog select');
  const opts = await host.$$eval('.dialog select option', (l) => l.map((o) => o.textContent));
  const versionOpts = opts.filter((o) => /Best available|\(\d:\d\d\)/.test(o));
  check(versionOpts[0]?.startsWith('Best available — ') && versionOpts.some((o) => o.includes('sung 1×')), `the Add dialog's versions (${versionOpts.join(' | ')})`);
  await host.click('.dialog .close');

  // ---- 5. The host turns guest votes off -----------------------------------------------------
  await hostReq('queue.add', { songId: song.id, trackId: B, singerName: 'Host', position: 'now' });
  await until(() => room.s.current?.trackId === B);
  await ana.click('.g-tabs button:first-child');
  check(await seen(ana, '.g-now-version'), 'the vote row is there');
  await hostReq('settings.update', { patch: { guests: { versionVotes: false } } });
  check(await until(async () => !(await ana.$('.g-now-version'))), 'off: no vote row on the guest’s Home');
  const anaClient = app.hub.list((c) => c.role === 'guest' && room.profileOf(c.data.deviceId)?.name === 'Ana')[0];
  const refused = await room.request(anaClient, { t: 'version.vote', trackId: B, vote: 1 }).then(() => 'ok', (e) => e.code);
  check(refused === 'closed', `off: a guest's vote is refused (${refused})`);
  await ana.click('.g-tabs button:has-text("Songs")');
  await ana.fill('.g-search input', 'neon heart');
  await ana.click('.g-songs .song-row:has-text("Neon Heart")');
  await ana.waitForSelector('.sheet .g-versions');
  await ana.click('.g-versions summary');
  check(!(await ana.$('.g-version .vote-btn')), 'off: no thumbs in the sheet');
  await ana.click('.sheet-close');
  await hostReq('settings.update', { patch: { guests: { versionVotes: true } } });

  // ---- 6. Small phones, both skins -----------------------------------------------------------------
  for (const skin of ['studio', 'party']) {
    await hostReq('settings.update', { patch: { appearance: { theme: skin } } });
    const small = await guest(`Cy-${skin}`, 320, 640);
    check(await seen(small, '.g-now-version'), `${skin}: the vote row at 320 px`);
    check(await noSideways(small), `${skin}: guest Home fits 320 px`);
    await shot(small, `${skin}-guest-320-home`);
    await small.click('.g-tabs button:has-text("Songs")');
    await small.fill('.g-search input', 'neon heart');
    await small.click('.g-songs .song-row:has-text("Neon Heart")');
    await small.waitForSelector('.sheet .g-versions');
    await small.click('.g-versions summary');
    check(await noSideways(small), `${skin}: the sheet's versions fit 320 px`);
    await shot(small, `${skin}-guest-320-sheet`);
    await small.close();
    const hostPhone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), `host-phone-${skin}`);
    await hostPhone.goto(`${base}/host#/search?q=neon`);
    await hostPhone.fill('.search-box input', 'neon heart');
    await hostPhone.waitForSelector('.song-row');
    await hostPhone.click('.song-row');
    await hostPhone.waitForSelector('.dialog table.versions');
    check(await noSideways(hostPhone), `${skin}: the Song dialog fits a phone`);
    await shot(hostPhone, `${skin}-host-phone-song`);
    await hostPhone.click('.dialog .btn.primary:has-text("Add to queue")');
    await hostPhone.waitForSelector('.dialog select');
    check(await noSideways(hostPhone), `${skin}: the Add dialog fits a phone`);
    await shot(hostPhone, `${skin}-host-phone-add`);
    await hostPhone.close();
  }
  await hostReq('settings.update', { patch: { appearance: { theme: 'studio' } } });
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
