#!/usr/bin/env node
// End-to-end check of a whole party in a real browser (not part of `npm test`):
// demo library → server → TV page in Chromium → host queues via WebSocket → intro →
// lyrics → song ends → next song. Screenshots go to the output folder.
//
//   node test/e2e/party.mjs [outDir]
//
// Needs Playwright (npm i -D playwright-core, or a global `playwright`) and Chromium.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, WsClient, check, results, sleep } from './lib.mjs';
import { tmpDir } from '../helpers.js';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e');
await fs.mkdir(out, { recursive: true });

const isMain = path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { chromium } = loadPlaywright();
  const { app, base } = await startParty();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const watch = (page, name) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  };
  try {
    const tv = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    watch(tv, 'tv');
    await tv.goto(`${base}/tv`);
    await tv.waitForSelector('.lobby');
    check(true, 'TV shows the lobby');
    const startVisible = await tv.$('.start');
    check(!startVisible, 'no click-to-start overlay when autoplay is allowed');
    const breakOn = () => tv.$eval('#break-audio', (a) => !a.paused && a.volume > 0.05).catch(() => false);
    let heard = false;
    for (let i = 0; i < 40 && !heard; i++) { heard = await breakOn(); if (!heard) await sleep(150); }
    check(heard, 'break music plays in the lobby');
    check(!!(await tv.$('.break-now')), 'the lobby says which break song is playing');
    await tv.screenshot({ path: path.join(out, 'tv-1-lobby.png') });

    // Skip the break song while other updates reach the TV during its fade-out: the new one plays.
    const breakSrc = () => tv.$eval('#break-audio', (a) => new URL(a.src).pathname).catch(() => '');
    const skippedFrom = await breakSrc();
    app.room.breakMusic.skip();
    app.room.markDirty();
    for (let i = 0; i < 4; i++) {
      await sleep(200);
      app.room.markDirty(); // (rating votes, phones joining…)
    }
    const skippedTo = app.room.breakMusic.track.url;
    let switched = false;
    for (let i = 0; i < 30 && !switched; i++) { switched = (await breakSrc()) === skippedTo && (await breakOn()); if (!switched) await sleep(150); }
    check(switched && skippedTo !== skippedFrom, 'skipping the break song plays the next one, even with updates arriving meanwhile');
    const lobbySrc = await breakSrc();

    const host = new WsClient(`${base.replace('http', 'ws')}/ws`);
    await host.open({ role: 'host' });
    const hello = app.library.catalog.search('neon heart').items[0];
    const call = app.library.catalog.search('high notes').items[0];
    await host.req('queue.add', { songId: hello.id, singerName: 'Ana' });
    await host.req('queue.add', { songId: call.id, singerName: 'Ben' });
    let st = await host.until((s) => s.current?.title === 'Neon Heart');
    check(st.player.state === 'intro', 'first song auto-starts with an intro');
    await tv.waitForSelector('.intro');
    await tv.screenshot({ path: path.join(out, 'tv-2-intro.png') });

    st = await host.until((s) => s.player.state === 'playing', 15000);
    check(true, 'TV reported ready and the song is playing');
    let quiet = false;
    for (let i = 0; i < 40 && !quiet; i++) { quiet = !(await breakOn()); if (!quiet) await sleep(100); }
    check(quiet, 'break music fades out when the song starts');
    const t1 = await host.next((m) => m.t === 'time' && m.pos > 1, 10000);
    await sleep(1500);
    const t2 = await host.next((m) => m.t === 'time' && m.pos > t1.pos + 1, 5000);
    check(t2.pos > t1.pos, `TV position advances (${t1.pos.toFixed(2)} → ${t2.pos.toFixed(2)} s)`);
    await sleep(4000);
    const shown = await tv.$eval('#cdg', (c) => c.classList.contains('show'));
    check(shown, 'lyrics canvas is visible');
    const ink = await tv.$eval('#cdg', (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    check(ink > 1000, `lyrics are drawn (${ink} opaque pixels)`);
    await tv.screenshot({ path: path.join(out, 'tv-3-singing.png') });

    await host.req('player.key', { semitones: 2 });
    await host.req('player.tempo', { rate: 1.2 });
    host.inbox = host.inbox.filter((m) => m.t !== 'time');
    const tk = await host.next((m) => m.t === 'time', 3000);
    await sleep(1000);
    const tk2 = await host.next((m) => m.t === 'time' && m.pos > tk.pos, 3000);
    check(tk2.pos > tk.pos, 'playback continues after key and tempo change');

    await host.req('player.pause');
    await sleep(700);
    const p1 = app.room.s.player.pos;
    await sleep(800);
    check(Math.abs(app.room.s.player.pos - p1) < 0.05, 'pause stops the clock');
    await tv.screenshot({ path: path.join(out, 'tv-4-paused.png') });
    await host.req('player.resume');

    // The TV's connection drops and comes back without a page reload.
    for (const c of app.hub.list((x) => x.role === 'tv')) c.ws.terminate();
    await host.until((s) => s.player.state === 'paused' && s.player.displayLost, 5000);
    await host.until((s) => s.player.hasDisplay && !s.player.displayLost, 15000);
    await sleep(500);
    const resumeAt = app.room.s.player.pos;
    host.inbox = host.inbox.filter((m) => m.t !== 'time'); // only reports from after the reconnect
    await host.req('player.resume');
    await host.until((s) => s.player.state === 'playing', 10000);
    const tr = await host.next((m) => m.t === 'time' && m.playing && m.pos > resumeAt + 0.5, 8000);
    check(tr.pos > resumeAt, `after a dropped TV connection, playback resumes when the host presses play (${resumeAt.toFixed(1)} → ${tr.pos.toFixed(1)} s)`);

    const dur = app.room.s.player.dur;
    await host.req('player.seek', { pos: dur - 3 });
    st = await host.until((s) => s.current?.title === 'High Notes Only', 20000);
    check(true, 'song ended on the TV and the next singer is up');
    check(app.room.s.tonight.history[0]?.title === 'Neon Heart' && !app.room.s.tonight.history[0].skipped, 'history records the finished song');
    await tv.waitForSelector('.intro');
    let introSrc = '';
    for (let i = 0; i < 30 && !introSrc; i++) { if (await breakOn()) introSrc = await breakSrc(); else await sleep(150); }
    check(introSrc && introSrc !== lobbySrc, `the next break plays a fresh track, not the same intro again (${lobbySrc} → ${introSrc})`);
    await tv.screenshot({ path: path.join(out, 'tv-5-next-intro.png') });

    await host.req('player.next');
    await host.until((s) => !s.current && s.player.state === 'idle', 10000);
    await tv.waitForSelector('.lobby');
    check(true, 'skipping the last song returns to the lobby');

    // Break music the TV can't play (here: files it can't decode): it asks for the next one a
    // little later each time and the server rests after a few — no request/broadcast loop.
    const bad = await tmpDir('ok-e2e-bad-music-');
    for (const name of ['One', 'Two', 'Three', 'Four']) await fs.writeFile(path.join(bad, `Noise - ${name}.mp3`), Buffer.alloc(40_000, 0x5a));
    const reports = [];
    const ended = app.room.breakMusic.ended.bind(app.room.breakMusic);
    app.room.breakMusic.ended = (id, opts) => { reports.push({ id, error: !!opts?.error, at: Date.now() }); return ended(id, opts); };
    await host.req('settings.update', { patch: { playback: { breakMusic: { source: 'folder', folder: bad } } } });
    const t0 = Date.now();
    for (let i = 0; i < 100 && !(app.room.breakMusic.restUntil > Date.now()); i++) await sleep(200);
    const resting = app.room.breakMusic.restUntil > Date.now();
    await sleep(3000);
    check(resting && reports.length === 3 && reports.every((r) => r.error), `unplayable break tracks: reported as errors and then a rest (${reports.length} reports in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    check(reports.length < 2 || reports[1].at - reports[0].at > 1000, 'the TV waits before asking for another track');
    check(!(await breakOn()), 'silence while resting');
    await host.req('settings.update', { patch: { playback: { breakMusic: { source: 'library' } } } });

    // A TV opened in a normal browser needs one click before it may play sound.
    await tv.close();
    const plain = await chromium.launch();
    try {
      const tv2 = await plain.newPage({ viewport: { width: 1280, height: 720 } });
      watch(tv2, 'tv2');
      await tv2.goto(`${base}/tv`);
      await tv2.waitForSelector('.start');
      check(true, 'without autoplay permission the TV asks for a click');
      await host.req('queue.add', { songId: call.id, singerName: 'Cy' });
      await host.until((s) => s.current && s.player.displayLocked, 10000);
      check(true, 'the host is told the TV needs a click');
      await tv2.click('.start');
      await host.until((s) => s.player.state === 'playing' && !s.player.displayLocked, 15000);
      check(true, 'one click on the TV starts the song');
    } finally {
      await plain.close();
    }
    host.close();
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
}
