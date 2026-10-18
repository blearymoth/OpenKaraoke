// Helpers shared by the end-to-end scripts (not part of `npm test`).
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { WebSocket } from '../../server/vendor/ws.mjs';
import { createApp } from '../../server/app.js';
import { makeDemoLibrary } from '../../scripts/make-demo-library.js';
import { fakeArtFetch } from '../fake-art.js';
import { tmpDir } from '../helpers.js';

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const tries = ['playwright-core', 'playwright'];
  try {
    // Under `npm --prefix desktop test` npm hands the prefix down, and "global" would mean desktop/.
    const env = { ...process.env };
    delete env.npm_config_prefix;
    delete env.NPM_CONFIG_PREFIX;
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', env }).trim();
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

/**
 * The desktop app's host window (Playwright's Electron app). Its first window is the one it shows
 * while it starts (desktop/starting.mjs), so firstWindow() isn't the host.
 */
export async function hostWindow(electronApp, timeout = 60_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const w = electronApp.windows().find((x) => /^http:\/\/[^/]+\/host/.test(x.url()));
    if (w) return w;
    if (Date.now() > until) throw new Error('the host window did not open');
    await sleep(100);
  }
}

/**
 * A human double click: two clicks on the same spot, `gap` ms apart. (Playwright's dblclick()
 * sends both at once, before the page re-renders, so it never hits the button the first click
 * brings up in the same place.) Resolves to what the second click landed on, e.g.
 * 'BUTTON "Continue" disabled'.
 */
export async function doubleClick(page, selector, gap = 150) {
  const el = await page.waitForSelector(selector);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await sleep(gap);
  const under = await page.evaluate(([px, py]) => {
    const hit = document.elementFromPoint(px, py);
    const target = hit?.closest('button, a, input, select') || hit;
    return target ? `${target.tagName} "${target.textContent.trim().slice(0, 40)}"${target.disabled ? ' disabled' : ''}` : 'nothing';
  }, [x, y]);
  await page.mouse.click(x, y);
  return under;
}

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

/**
 * Starts a server on the demo library; artwork comes from a fake provider network (never the
 * internet). `hotspot` options go to the party hotspot (a fake NetworkManager: never the real one).
 * `addTracks(dir)`: writes more tracks into the library folder before it is scanned. `artFetch`:
 * another fake network for the artwork providers.
 */
export async function startParty({ crawl = false, hotspot, addTracks, stemRun = null, videoTool = null, artFetch = null } = {}) {
  const lib = await tmpDir('ok-e2e-lib-');
  await makeDemoLibrary(lib, { log: () => {} });
  if (addTracks) await addTracks(lib);
  const dataDir = await tmpDir('ok-e2e-data-');
  const fetch = artFetch || fakeArtFetch({ unknown: new Set(['dj hush']) });
  const app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch, crawl, hotspot, stemRun, videoTool });
  await app.library.scan();
  app.settings.update({ playback: { countdown: 3 } });
  await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/**
 * A camera the page can open with getUserMedia: a steady red frame with a green corner, so a
 * test can tell a shutter grab from a file. `window.__cam.mode` is 'ok', 'blocked', 'missing'
 * or 'strict' (the rear-camera preference is refused, any camera is allowed).
 */
export function installFakeCamera() {
  if (window.__cam) return;
  const cam = { calls: [], tracks: [], mode: 'ok' };
  window.__cam = cam;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.setAttribute('aria-hidden', 'true');
  // The bitmap stays 640×480; the element itself must not widen the phone.
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.fillStyle = 'rgb(220, 30, 40)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgb(30, 200, 70)';
    ctx.fillRect(0, 0, 80, 80);
  };
  draw();
  setInterval(draw, 50);
  const attach = () => {
    const root = document.documentElement;
    if (root && !canvas.isConnected) root.appendChild(canvas);
  };
  attach();
  document.addEventListener('DOMContentLoaded', attach);
  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    cam.calls.push(JSON.parse(JSON.stringify(constraints)));
    if (cam.mode === 'blocked') throw new DOMException('Permission denied', 'NotAllowedError');
    if (cam.mode === 'missing') throw new DOMException('Requested device not found', 'NotFoundError');
    if (cam.mode === 'strict' && constraints?.video?.facingMode) throw new DOMException('facingMode', 'OverconstrainedError');
    const stream = canvas.captureStream(15);
    for (const t of stream.getTracks()) {
      cam.tracks.push(t);
      const stop = t.stop.bind(t);
      t.stop = () => stop();
    }
    return stream;
  };
}
