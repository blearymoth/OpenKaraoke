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
    await tv.screenshot({ path: path.join(out, 'tv-1-lobby.png') });

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

    const dur = app.room.s.player.dur;
    await host.req('player.seek', { pos: dur - 3 });
    st = await host.until((s) => s.current?.title === 'High Notes Only', 20000);
    check(true, 'song ended on the TV and the next singer is up');
    check(app.room.s.tonight.history[0]?.title === 'Neon Heart' && !app.room.s.tonight.history[0].skipped, 'history records the finished song');
    await tv.waitForSelector('.intro');
    await tv.screenshot({ path: path.join(out, 'tv-5-next-intro.png') });

    await host.req('player.next');
    await host.until((s) => !s.current && s.player.state === 'idle', 10000);
    await tv.waitForSelector('.lobby');
    check(true, 'skipping the last song returns to the lobby');
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
