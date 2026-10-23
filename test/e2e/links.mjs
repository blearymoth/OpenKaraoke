#!/usr/bin/env node
// End-to-end checks of songs from a link (PLAN §31.12) with the stand-in autokaraoke: a guest asks
// on their phone's Me tab (a wrong link is caught there), the host's popup asks at once (Later puts
// it off), the Decisions page shows it with the lyrics to correct, Approve → made → queued for the
// guest, who is told; Deny tells them too; an empty search offers it; phones' widths; no errors.
//
//   node test/e2e/links.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { fakeAutokaraoke } from '../../server/maker/fake.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-links');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const tool = fakeAutokaraoke({ seconds: 2, songSeconds: 30 });
const { app, base } = await startParty({ makerTool: tool });
app.settings.update({ maker: { guestLinks: true }, queue: { requireApproval: false } });
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Not tonight' : undefined));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const seen = (page, selector, timeout = 8000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const room = app.room;
const phone = async (name) => watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), name);
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth);

try {
  await until(() => room.maker.checks);
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');

  // ---- the guest asks ----------------------------------------------------------------------------
  const ana = await phone('ana');
  await ana.goto(`${base}/j/${code}`);
  await ana.waitForSelector('.profile-form');
  await ana.fill('.profile-form input', 'Ana');
  await ana.click('.profile-form .btn.primary');
  await ana.waitForSelector('.g-tabs');
  await ana.click('.g-tabs button:has(span:text-is("Me"))');
  check(await seen(ana, '#link-card .link-form'), 'Me tab: “A song that isn’t here?”');
  await ana.fill('input[aria-label="YouTube link"]', 'https://vimeo.com/123456');
  check(await seen(ana, '#link-card .warn-text:has-text("Only YouTube")') && await ana.isDisabled('#link-card button:has-text("Ask the host")'), 'a wrong link is caught on the phone');
  await ana.fill('input[aria-label="YouTube link"]', 'https://youtu.be/dQw4w9WgXcQ?si=xyz');
  await ana.click('#link-card .toggle-row .switch');
  await ana.fill('textarea[aria-label="Lyrics"]', 'Never gonna give you up\nNever gonna let you down');
  await ana.click('#link-card button:has-text("Ask the host")');
  check(await seen(ana, '.my-link.pending:has-text("Waiting for the host")'), 'sent: “Waiting for the host”');
  check(await wide(ana) <= 390, `the Me tab fits the phone (${await wide(ana)} px)`);
  await shot(ana, 'links-guest-asked');

  // ---- the host: the popup, Later, the Decisions page --------------------------------------------------
  check(await seen(host, '.dec-popup:has-text("Ana") :text("asks for a song from YouTube")'), 'the host’s popup asks at once');
  check(await seen(host, '.nav a[href="#/decisions"] .badge:has-text("1")'), 'Decisions in the nav, with a badge');
  await shot(host, 'links-popup');
  await host.click('.dec-popup button:has-text("Later")');
  check(await host.$('.dec-popup') === null, 'Later: the popup goes');
  await host.click('.nav a[href="#/decisions"]');
  check(await seen(host, '.decisions .dec-link.pending:has-text("Ana")'), 'Decisions: the request, with who asked');
  const lyrics = await host.inputValue('.dec-link.pending textarea');
  check(lyrics === 'Never gonna give you up\nNever gonna let you down', 'with the guest’s lyrics to check');
  await host.fill('.dec-link.pending textarea', `${lyrics}\nNever gonna run around`);
  await host.fill('.dec-link.pending .dec-names input >> nth=0', 'Rick Astley');
  await host.fill('.dec-link.pending .dec-names input >> nth=1', 'Never Gonna Give You Up');
  await shot(host, 'links-decisions');
  await host.click('.dec-link.pending button:has-text("Approve")');
  check(await seen(host, '.dec-link.working .mk-bar, .dec-link.queued'), 'approved: being made');
  check(await seen(host, '.dec-link.done:has-text("Never Gonna Give You Up")', 30000), 'made');
  check(await seen(host, '.dec-link.done :text("Queued for Ana")'), '“Queued for Ana.”');
  const job = room.maker.jobs.at(-1);
  check(/run around/.test(job.lyrics), 'the host’s lyrics were used');
  const entry = room.s.queue.find((e) => e.title === 'Never Gonna Give You Up') || (room.s.current?.title === 'Never Gonna Give You Up' ? room.s.current : null);
  check(!!entry && room.singer(entry.singerIds[0])?.name === 'Ana', 'queued for Ana, as her song');

  // ---- the guest is told ------------------------------------------------------------------------------
  check(await seen(ana, '.toast:has-text("is ready — it’s in the queue for you")', 10000), 'the guest is told it’s ready and queued');
  check(await seen(ana, '.my-link.done button:has-text("Sing it")'), 'their list: “Ready”, Sing it');

  // ---- a second request, denied from the popup ------------------------------------------------------------
  await ana.fill('input[aria-label="YouTube link"]', 'https://www.youtube.com/watch?v=kJQP7kiw5Fk');
  await ana.click('#link-card button:has-text("Ask the host")');
  await host.click('.nav a[href="#/"]');
  check(await seen(host, '.dec-popup'), 'the popup again, for the new one');
  await host.click('.dec-popup button:has-text("Deny")');
  check(await seen(ana, '.toast:has-text("The host passed on")', 10000), 'denied: the guest is told');
  check(await seen(ana, '.my-link.denied'), 'their list says so');

  // ---- an empty search offers it --------------------------------------------------------------------------
  await ana.click('.g-tabs button:has(span:text-is("Songs"))');
  await ana.fill('input[type=search], .search-box input', 'zzqx nothing like this');
  check(await seen(ana, '.g-ask-link button:has-text("Ask for it from YouTube")'), 'no songs found: “Ask for it from YouTube”');
  await ana.click('.g-ask-link button');
  check(await seen(ana, '#link-card .link-form'), 'it opens the Me tab’s card');

  // ---- the host on a phone ---------------------------------------------------------------------------------
  const hostPhone = await phone('host-phone');
  await hostPhone.goto(`${base}/host#/decisions`);
  await hostPhone.waitForSelector('.decisions');
  check(await wide(hostPhone) <= 390, `Decisions fits a phone (${await wide(hostPhone)} px)`);
  await shot(hostPhone, 'links-decisions-phone');
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
