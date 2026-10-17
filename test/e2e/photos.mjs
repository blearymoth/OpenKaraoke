#!/usr/bin/env node
// Guest photos: on a secure page (https or localhost) Add a Photo opens an in-page camera; the
// shutter's frame is what gets uploaded and a blocked or missing camera is said on the phone.
// On plain http (a phone on the party Wi-Fi) the phone's camera app takes the picture instead.
//
//   node test/e2e/photos.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { loadPlaywright, startParty, check, results, installFakeCamera } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-photos');
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

/** The centre is the red field; (8, 8) is the green corner painted by the fake camera. */
async function jpegPixels(page, buf) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    return { w: c.width, h: c.height, center: at(c.width >> 1, c.height >> 1), corner: at(8, 8) };
  }, buf.toString('base64'));
}

try {
  const code = app.settings.get('party.roomCode');
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'phone');
  let fileChooser = false;
  phone.on('filechooser', () => { fileChooser = true; });
  await phone.addInitScript(installFakeCamera);
  await phone.goto(`${base}/j/${code}`);
  await phone.waitForSelector('.profile-form');
  await phone.fill('.profile-form input', 'Ann');
  await phone.click('.profile-form .btn.primary');
  await phone.waitForSelector('.g-tabs');
  await phone.click('.g-tabs button:has(span:text-is("Me"))');
  await phone.waitForSelector('.photo-card button:has-text("Add a Photo")');
  check((await phone.$$('input[type=file]')).length === 0, 'the Me tab has no file input');

  const photosBefore = app.room.photos.list.length;
  const refuse = async (mode, pattern, what) => {
    await phone.evaluate((m) => { window.__cam.mode = m; window.__cam.calls.length = 0; }, mode);
    await phone.click('.photo-card button:has-text("Add a Photo")');
    const msg = await phone.waitForSelector('.cam-msg[role="alert"]', { timeout: 5000 }).then((el) => el.textContent(), () => '');
    check(pattern.test(msg), `${what} (${msg})`);
    check(!(await phone.$('.cam-shutter')), `${what}: no shutter and no gallery`);
    check((await phone.$$('input[type=file]')).length === 0, `${what}: still no file chooser`);
    await phone.click('.cam-capture button[aria-label="Close"]');
    await phone.waitForSelector('.cam-capture', { state: 'detached' });
  };
  await refuse('blocked', /camera is blocked/, 'a blocked camera is said on the phone');
  await refuse('missing', /No camera was found/, 'a missing camera is said on the phone');
  check(app.room.photos.list.length === photosBefore && !fileChooser, 'nothing is uploaded when the camera cannot be used');

  // Open, then close without a picture: the stream stops.
  await phone.evaluate(() => { window.__cam.mode = 'ok'; window.__cam.calls.length = 0; });
  const tracksBefore = await phone.evaluate(() => window.__cam.tracks.length);
  await phone.click('.photo-card button:has-text("Add a Photo")');
  await phone.waitForSelector('.cam-shutter:not([disabled])', { timeout: 8000 });
  const asked = await phone.evaluate(() => window.__cam.calls.map((c) => c.video?.facingMode?.ideal || (c.video === true ? 'any' : typeof c.video)));
  check(asked.length === 1 && asked[0] === 'environment' && (await phone.evaluate(() => window.__cam.calls.every((c) => c.audio == null))), `the phone asks for the rear camera (${asked.join(', ')})`);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(wide <= 0, 'the capture screen fits the phone (no sideways scrolling)');
  await phone.screenshot({ path: path.join(out, 'camera-open.png') });
  await phone.click('.cam-capture button[aria-label="Close"]');
  await phone.waitForSelector('.cam-capture', { state: 'detached' });
  const stopped = await phone.evaluate((n) => {
    const opened = window.__cam.tracks.slice(n);
    return opened.length > 0 && opened.every((t) => t.readyState === 'ended');
  }, tracksBefore);
  check(stopped, 'closing the capture screen stops the camera');

  // A phone that rejects the rear-camera preference still gets a camera, and that frame is the upload.
  await phone.evaluate(() => { window.__cam.mode = 'strict'; window.__cam.calls.length = 0; });
  const tracksAtShot = await phone.evaluate(() => window.__cam.tracks.length);
  await phone.click('.photo-card button:has-text("Add a Photo")');
  await phone.waitForSelector('.cam-shutter:not([disabled])', { timeout: 8000 });
  const fallback = await phone.evaluate(() => window.__cam.calls.map((c) => c.video?.facingMode?.ideal || (c.video === true ? 'any' : typeof c.video)));
  check(fallback[0] === 'environment' && fallback[1] === 'any', `only a front camera: the phone still opens one (${fallback.join(', ')})`);
  await phone.waitForFunction(() => {
    const v = document.querySelector('.cam-capture video');
    if (!v?.videoWidth) return false;
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, 4, 4);
    const px = g.getImageData(2, 2, 1, 1).data;
    return px[0] > 150 && px[1] < 120;
  }, null, { timeout: 8000 });
  await phone.click('.cam-shutter');
  check(await phone.waitForSelector('.toast:has-text("host will put it on the TV")', { timeout: 8000 }).then(() => true, () => false), 'the shutter sends the frame');
  await phone.waitForSelector('.cam-capture', { state: 'detached' });
  const shotStopped = await phone.evaluate((n) => {
    const opened = window.__cam.tracks.slice(n);
    return opened.length > 0 && opened.every((t) => t.readyState === 'ended');
  }, tracksAtShot);
  check(shotStopped, 'taking the picture stops the camera');
  const photo = app.room.photos.list.at(-1);
  const buf = await fs.readFile(app.room.photos.file(photo));
  check(photo?.status === 'pending' && buf[0] === 0xff && buf[1] === 0xd8, 'the upload is the pending JPEG, waiting for the host');
  const px = await jpegPixels(phone, buf);
  const red = px.center[0] > 180 && px.center[1] < 80 && px.center[2] < 80;
  const green = px.corner[1] > 150 && px.corner[0] < 90 && px.corner[2] < 120;
  check(px.w === 640 && px.h === 480 && red && green, `the uploaded picture is the camera frame (${px.w}×${px.h}, centre ${px.center.slice(0, 3)}, corner ${px.corner.slice(0, 3)})`);
  check(!fileChooser && (await phone.$$('input[type=file]')).length === 0, 'a file chooser never opened');
  check(await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'the Me tab still fits the phone');

  // A guest on the party Wi-Fi opens plain http: no getUserMedia there. The phone's camera app
  // takes the picture instead (file input with capture), and that picture is uploaded.
  const lan = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'lan phone');
  await lan.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { get: () => false });
    Object.defineProperty(navigator, 'mediaDevices', { get: () => undefined });
  });
  await lan.goto(`${base}/j/${code}`);
  await lan.waitForSelector('.profile-form');
  await lan.fill('.profile-form input', 'Bob');
  await lan.click('.profile-form .btn.primary');
  await lan.waitForSelector('.g-tabs');
  await lan.click('.g-tabs button:has(span:text-is("Me"))');
  await lan.waitForSelector('.photo-card button:has-text("Add a Photo")');
  const input = await lan.$('.photo-card input[type=file]');
  const attrs = input ? await input.evaluate((el) => ({ accept: el.accept, capture: el.getAttribute('capture') })) : {};
  check(attrs.accept === 'image/*' && attrs.capture === 'environment', `plain http: a camera input (accept ${attrs.accept}, capture ${attrs.capture})`);
  const lanBefore = app.room.photos.list.length;
  const [chooser] = await Promise.all([
    lan.waitForEvent('filechooser', { timeout: 5000 }),
    lan.click('.photo-card button:has-text("Add a Photo")'),
  ]);
  check(!(await lan.$('.cam-capture')), 'plain http: the in-page camera does not open');
  const jpeg = await lan.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(30, 60, 220)';
    g.fillRect(0, 0, 800, 600);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  await chooser.setFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) });
  check(await lan.waitForSelector('.toast:has-text("host will put it on the TV")', { timeout: 8000 }).then(() => true, () => false), 'plain http: the camera app’s picture is sent');
  const lanPhoto = app.room.photos.list.at(-1);
  const lanBuf = lanPhoto && app.room.photos.list.length === lanBefore + 1 ? await fs.readFile(app.room.photos.file(lanPhoto)) : null;
  const lanPx = lanBuf ? await jpegPixels(lan, lanBuf) : null;
  check(!!lanPx && lanPx.center[2] > 180 && lanPx.center[0] < 80, `plain http: the upload is that picture (${lanPx?.w}×${lanPx?.h}, centre ${lanPx?.center.slice(0, 3)})`);
  check(await lan.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'plain http: the Me tab fits the phone');
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
