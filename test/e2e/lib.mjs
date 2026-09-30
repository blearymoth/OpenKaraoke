// Helpers shared by the end-to-end scripts (not part of `npm test`).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { WebSocket } from '../../server/vendor/ws.mjs';
import { createApp } from '../../server/app.js';
import { makeDemoLibrary } from '../../scripts/make-demo-library.js';
import { fakeArtFetch } from '../fake-art.js';

export function loadPlaywright() {
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

export const results = [];
export const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✘'} ${what}`);
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Starts a server on the demo library; artwork comes from a fake provider network (never the internet). */
export async function startParty({ crawl = false } = {}) {
  const lib = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-e2e-lib-'));
  await makeDemoLibrary(lib, { log: () => {} });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-e2e-data-'));
  const app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch: fakeArtFetch({ unknown: new Set(['dj hush']) }), crawl });
  await app.library.scan();
  app.settings.update({ playback: { countdown: 3 } });
  await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.port}` };
}
