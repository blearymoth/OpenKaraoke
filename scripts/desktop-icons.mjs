#!/usr/bin/env node
// Renders the desktop app's icons (desktop/build/icons/<n>x<n>.png, for the window, the
// installers and the app menu) from public/img/icon-studio.svg — Studio is the default skin.
// Dev tooling (needs Playwright, like the e2e tests); run it again after changing the icon.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../test/e2e/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'desktop/build/icons');
const svg = await fs.readFile(path.join(ROOT, 'public/img/icon-studio.svg'));
const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;

await fs.mkdir(OUT, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const n of [16, 24, 32, 48, 64, 128, 256, 512]) {
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img src="${src}" width="${n}" height="${n}" style="display:block">`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: path.join(OUT, `${n}x${n}.png`), omitBackground: true, clip: { x: 0, y: 0, width: n, height: n } });
}
await browser.close();
console.log(`icons written to ${path.relative(ROOT, OUT)}`);
