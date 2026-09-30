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
import os from 'node:os';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { WebSocket } from '../../server/vendor/ws.mjs';
import { createApp } from '../../server/app.js';
import { makeDemoLibrary } from '../../scripts/make-demo-library.js';
import { setLogLevel } from '../../server/util/log.js';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e');
await fs.mkdir(out, { recursive: true });

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const tries = ['playwright-core', 'playwright'];
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    tries.push(path.join(globalRoot, 'playwright'), path.join(globalRoot, 'playwright-core'));
  } catch { /* no npm */ }
  for (const t of tries) {
    try {
      return require(t);
    } catch { /* next */ }
  }
  throw new Error('Playwright not found: npm i -D playwright-core');
}

const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✘'} ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WsClient {
  constructor(url) {
    this.url = url;
    this.inbox = [];
    this.waiters = [];
    this.rid = 0;
    this.state = null;
  }

  open(hello) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === 'state' || m.t === 'welcome') this.state = m.state ?? this.state;
        const i = this.waiters.findIndex((w) => w.pred(m));
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
        else this.inbox.push(m);
        if (m.t === 'welcome') resolve(m);
        if (m.t === 'denied') reject(new Error(m.reason));
      });
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', ...hello })));
      this.ws.on('error', reject);
    });
  }

  next(pred, timeout = 15000) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const k = this.waiters.indexOf(w);
        if (k >= 0) {
          this.waiters.splice(k, 1);
          reject(new Error('timeout waiting for message'));
        }
      }, timeout);
    });
  }

  /** Waits until the latest state satisfies `pred`. */
  async until(pred, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.state && pred(this.state)) return this.state;
      await sleep(50);
    }
    throw new Error('timeout waiting for state');
  }

  async req(t, body = {}) {
    const rid = ++this.rid;
    this.ws.send(JSON.stringify({ t, rid, ...body }));
    const res = await this.next((m) => m.t === 'res' && m.rid === rid);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  close() {
    this.ws?.close();
  }
}

export async function startParty() {
  const lib = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-e2e-lib-'));
  await makeDemoLibrary(lib, { log: () => {} });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-e2e-data-'));
  const app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false });
  await app.library.scan();
  app.settings.update({ playback: { countdown: 3 } });
  await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.port}` };
}

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
