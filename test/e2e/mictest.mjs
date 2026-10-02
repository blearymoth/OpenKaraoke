#!/usr/bin/env node
// End-to-end checks of the mic latency test page (/mictest) with Chromium's fake microphone:
// the page loads in the skin with no console errors, the recorder worklet lines a scheduled
// click up with the frame it was scheduled at (a digital loopback measures ~0 ms), a measurement
// runs to the end and shows a result, listening starts and moves the level meter, the effect
// chips and sliders work, the browser facts are filled in, and a phone never scrolls sideways.
// Not part of `npm test`.
//
//   node test/e2e/mictest.mjs [outDir]       (CHROMIUM_PATH=… to use a specific Chromium)
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-mictest');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];
const watch = (name, page) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['microphone'], { origin: base });
  const page = watch('desktop', await context.newPage());
  await page.goto(`${base}/mictest`);
  check(await page.title() === 'Mic test · OpenKaraoke', 'the page is served at /mictest');
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'studio', 'the page carries the skin');
  check(await page.locator('#facts dt').count() >= 8, 'the browser facts are listed before the mic is open');

  // 1. the worklet's frame alignment: a click fed straight into the recorder is found at ~0 ms
  const loop = await page.evaluate(async () => {
    const { makeClick, findArrival, PRE_ROLL_SECONDS } = await import('/shared/latency.js');
    const ctx = new AudioContext();
    await ctx.resume();
    await ctx.audioWorklet.addModule('/js/mictest/recorder-worklet.js');
    const sr = ctx.sampleRate;
    const rec = new AudioWorkletNode(ctx, 'ok-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    rec.connect(mute).connect(ctx.destination);
    const data = makeClick(sr);
    const buf = ctx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    const found = [];
    for (let i = 0; i < 3; i++) {
      const pre = Math.round(PRE_ROLL_SECONDS * sr);
      const at = Math.round((ctx.currentTime + 0.25) * sr) + i * 37; // not on a block boundary
      const got = new Promise((resolve) => { rec.port.onmessage = (e) => resolve(e.data.samples); });
      rec.port.postMessage({ id: i, from: at - pre, frames: pre + Math.round(0.2 * sr) });
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      src.connect(rec);
      src.start(at / sr);
      found.push(findArrival(await got, pre, sr).ms);
    }
    await ctx.close();
    return found;
  });
  // (the onset is found a few samples into the click's 0.25 ms fade-in; a misaligned block would be off by 2.7 ms)
  check(loop.every((v) => v != null && Math.abs(v) < 0.3), `a digital loopback measures ~0 ms (${loop.map((v) => v?.toFixed(3)).join(', ')})`);

  // 2. a full measurement with the fake mic (it hears its own beeps, not our clicks): it ends with a result
  await page.click('#measure-btn');
  check(await page.locator('#measure-btn').isDisabled(), 'the controls are disabled while measuring');
  await page.waitForSelector('#result:not([hidden])', { timeout: 20000 });
  check(await page.locator('#measure-btn').isEnabled(), 'the measurement finishes and the controls come back');
  const shown = await page.locator('#result-ms').textContent();
  const level = await page.locator('#result').getAttribute('data-level');
  check(/^(–|\d+)$/.test(shown) && ['great', 'good', 'fair', 'bad', 'unknown'].includes(level), `a result is shown (${shown} ms, ${level})`);
  check((await page.locator('#result-detail').textContent()).length > 10, 'the result explains the clicks');
  const facts = await page.locator('#facts').innerText();
  check(/Sample rate\s+\d+ Hz/.test(facts), 'the sample rate is reported');
  check(/baseLatency\)\s+[\d.]+ ms/.test(facts), 'the processing buffer is reported');
  check(/Measured round trip\s+(?!not measured)/.test(facts), 'the measurement is in the report');
  check(/Voice processing\s+off/.test(facts), 'echo cancellation, noise suppression and auto gain are off');

  // 3. listening: the meter moves with the fake mic's beeps; effects and sliders
  await page.click('#listen-btn');
  await page.waitForFunction(() => document.getElementById('listen-btn').textContent === 'Stop listening');
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) {
    moved = await page.evaluate(() => parseFloat(document.getElementById('meter').style.width) > 5);
    await sleep(100);
  }
  check(moved, 'the level meter follows the mic');
  await page.click('[data-fx="reverb"]');
  check(await page.locator('[data-fx="reverb"]').getAttribute('aria-checked') === 'true' && await page.locator('[data-fx="dry"]').getAttribute('aria-checked') === 'false', 'an effect can be picked');
  await page.locator('#delay').fill('40');
  check(await page.locator('#delay-out').textContent() === '40 ms', 'the extra delay slider shows its value');
  await page.selectOption('#buffer', '0');
  await page.waitForFunction(() => /Smallest/.test(document.getElementById('facts').innerText));
  await sleep(300);
  check(await page.locator('#listen-btn').textContent() === 'Stop listening', 'changing the buffer keeps listening');
  check(await page.evaluate(() => localStorage.getItem('ok.mictest')?.includes('"buffer":"0"')), 'the buffer choice is remembered');
  await page.screenshot({ path: path.join(out, 'mictest-desktop.png'), fullPage: true });
  await page.click('#listen-btn');
  check(await page.locator('#listen-btn').textContent() === 'Start listening', 'listening stops');
  check(await page.locator('#setup-error').isHidden(), 'no error is shown');
  await context.close();

  // 4. a phone: fits the screen
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = watch('phone', await phoneCtx.newPage());
  await phone.goto(`${base}/mictest`);
  await phone.waitForSelector('#facts dt');
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling on a phone');
  await phone.screenshot({ path: path.join(out, 'mictest-phone.png'), fullPage: true });
  await phoneCtx.close();

  // 5. the landing page links to it
  const home = watch('home', await browser.newPage());
  await home.goto(base);
  check(await home.locator('a[href="/mictest"]').count() === 1, 'the landing page links to the mic test');
  await home.close();

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  await app.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed.length ? 1 : 0);
