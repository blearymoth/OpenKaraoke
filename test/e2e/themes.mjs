#!/usr/bin/env node
// End-to-end checks of the app-wide skins (settings.appearance): Studio is the default on every
// app; switching skin or accent in Settings → Appearance changes the already-open host, TV and
// guest pages live; a reload keeps the skin with no flash; screenshots of the key screens in both
// skins; no console errors; phones never scroll sideways. Not part of `npm test`.
//
//   node test/e2e/themes.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { PUBLIC_DIR } from '../../server/config.js';
import { THEMES } from '../../shared/themes.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-themes');
await fs.mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const { app, base } = await startParty();
app.settings.update({ playback: { startPaused: true } }); // the intro waits for "play": a stable screen
// Headless Chromium draws in software: the TV would take lighter effects (still backgrounds) by
// itself, and the drifting aurora checked below would stand still.
app.settings.update({ display: { lighterEffects: 'off' } });
const code = app.settings.get('party.roomCode');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const pages = [];
const hostClient = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => app.room.request(hostClient, { t, ...m });
const room = () => app.room.s;

/** A page that records the skin its <html> had when the parser created it (a flash shows here). */
async function open(name, opts) {
  const page = await browser.newPage(opts);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.addInitScript(() => {
    const obs = new MutationObserver(() => {
      if (document.documentElement && !window.__firstTheme) {
        window.__firstTheme = document.documentElement.getAttribute('data-theme') || 'none';
        obs.disconnect();
      }
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  pages.push({ name, page });
  return page;
}
// Studio's own values, from shared/themes.js and base.css (a palette tweak does not touch this test)
const STUDIO = THEMES.studio;
const css = await fs.readFile(path.join(PUBLIC_DIR, 'css', 'base.css'), 'utf8');
const studioBlock = css.slice(css.indexOf(':root, [data-theme="studio"] {'), css.indexOf('[data-theme="party"] {'));
const studioToken = (name) => new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(studioBlock)[1].trim();
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

const desktop = (name) => open(name, { viewport: { width: 1440, height: 900 } });
const phone = (name) => open(name, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const tvSize = (name) => open(name, { viewport: { width: 1280, height: 720 } });

const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const firstTheme = (page) => page.evaluate(() => window.__firstTheme);
const tokenOf = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const waitTheme = (page, theme) => page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, { timeout: 5000 }).then(() => true, () => false);
const waitToken = (page, name, value) => page.waitForFunction(([n, v]) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() === v, [name, value], { timeout: 5000 }).then(() => true, () => false);
/** Which app icon an <img src="/img/icon.svg"> shows: 'party' (the original) or 'studio' (swapped by --app-icon). */
const iconOf = (page, sel) => page.$eval(sel, (img) => {
  const c = getComputedStyle(img).content;
  return c === 'normal' ? 'party' : c.includes('/img/icon-studio.svg') ? 'studio' : c;
});
const favicon = (page) => page.$eval('link[rel="icon"]', (l) => l.getAttribute('href'));
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
/** Visible text drawn in the given colour (Studio keeps TV text at ink-2 or brighter, to read across a room); SVG text by its fill. */
const textIn = (page, color) => page.evaluate((c) => [...document.querySelectorAll('body *')]
  .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getBoundingClientRect().width > 0
    && (el instanceof SVGElement ? getComputedStyle(el).fill : getComputedStyle(el).color) === c)
  .map((el) => `${(el.className?.baseVal ?? el.className) || el.tagName}: ${el.textContent.trim().slice(0, 24)}`), color);
/** WCAG contrast of two computed rgb() colours. */
const contrastOf = (a, b) => {
  const lum = (rgb) => {
    const [r, g, bl] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Studio: every label on the TV's wheel reads at 7:1 on its segment, drawn as is (no fading, no lightening). */
const wheelLabels = async (page, what) => {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !(a instanceof CSSTransition)), null, { timeout: 3000 }).catch(() => {});
  const segs = await page.$$eval('.wheel-tv .wheel-seg', (gs) => gs.map((g) => {
    const p = getComputedStyle(g.querySelector('path'));
    const t = getComputedStyle(g.querySelector('text'));
    return { text: g.textContent.trim(), seg: p.fill, ink: t.fill, plain: p.filter === 'none' && p.opacity === '1' && t.opacity === '1' };
  }));
  const low = segs.filter((s) => !s.plain || contrastOf(s.ink, s.seg) < 7).map((s) => `${s.text} ${s.ink} on ${s.seg} ${contrastOf(s.ink, s.seg).toFixed(2)}${s.plain ? '' : ' (filtered)'}`);
  check(segs.length > 0 && low.length === 0, `studio: ${what}: every wheel label at 7:1 or more${low.length ? `: ${low.join(' | ')}` : ''}`);
};
const faintTvText = async (page, what) => {
  const faint = await textIn(page, rgbOf(studioToken('--ink-3')));
  check(faint.length === 0, `studio: ${what} has no text in the faintest ink${faint.length ? `: ${faint.join(' | ')}` : ''}`);
};
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/**
 * Studio: every line of text on the TV reads at 7:1 or more against what is really behind it: the
 * text's colour against the brightest pixels (95th percentile) under it in a screenshot with all
 * text hidden. Emoji, avatars, QR codes and the clock are left out. With `sweep`, the aurora's blobs
 * are stepped through their drift and the brightest moment counts.
 */
async function tvTextOver(page, what, { sweep = false } = {}) {
  const runs = await page.evaluate(() => {
    const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u200d\ufe0f]/u;
    const list = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent.trim() || el.closest('svg, canvas, .corner-qr, .marquee, .photo-flash, .clock, .avatar, .avatar-big')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      let op = 1;
      for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      if (op < 0.05) continue;
      // what is visible of it: inside the screen and every ancestor that clips its overflow
      let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        if (getComputedStyle(e).overflow === 'visible') continue;
        const b = e.getBoundingClientRect();
        clip = { left: Math.max(clip.left, b.left), top: Math.max(clip.top, b.top), right: Math.min(clip.right, b.right), bottom: Math.min(clip.bottom, b.bottom) };
      }
      const t = n.textContent;
      let start = null;
      const flush = (end) => {
        if (start !== null && /[\p{L}\p{N}]/u.test(t.slice(start, end))) {
          const range = document.createRange();
          range.setStart(n, start);
          range.setEnd(n, end);
          for (const box of range.getClientRects()) {
            const r = { x: Math.max(box.left, clip.left), y: Math.max(box.top, clip.top) };
            r.width = Math.min(box.right, clip.right) - r.x;
            r.height = Math.min(box.bottom, clip.bottom) - r.y;
            if (r.width < 2 || r.height < box.height / 2) continue; // (mostly cut off)
            list.push({ x: r.x, y: r.y, w: r.width, h: r.height, color: cs.color, op, text: t.slice(start, end).trim().slice(0, 24) });
          }
        }
        start = null;
      };
      for (const s of new Intl.Segmenter().segment(t)) {
        if (EMOJI.test(s.segment)) flush(s.index);
        else if (start === null) start = s.index;
      }
      flush(t.length);
    }
    return list;
  });
  const hide = await page.addStyleTag({ content: '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; }' });
  await nextFrames(page);
  const blobs = sweep ? await page.evaluate(() => document.getAnimations().filter((a) => /^drift/.test(a.animationName || '')).length) : 0;
  const shots = [];
  for (const t of blobs ? Array.from({ length: 12 }, (_, k) => k * 8000) : [null]) {
    if (t !== null) {
      await page.evaluate((at) => { for (const a of document.getAnimations()) if (/^drift/.test(a.animationName || '')) { a.pause(); a.currentTime = at; } }, t);
      await nextFrames(page);
    }
    shots.push((await page.screenshot()).toString('base64'));
  }
  if (blobs) await page.evaluate(() => { for (const a of document.getAnimations()) if (/^drift/.test(a.animationName || '')) a.play(); });
  await hide.evaluate((el) => el.remove());
  const low = await page.evaluate(async ([shots, runs]) => {
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const images = [];
    for (const png of shots) {
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = `data:image/png;base64,${png}`; });
      const c = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0);
      images.push(c);
    }
    const out = [];
    for (const run of runs) {
      const [r, g, b, a = 1] = run.color.match(/[\d.]+/g).map(Number);
      let worst = Infinity;
      let on = '';
      for (const c of images) {
        const x = Math.max(0, Math.ceil(run.x));
        const y = Math.max(0, Math.ceil(run.y));
        const d = c.getImageData(x, y, Math.max(1, Math.min(c.canvas.width - x, Math.floor(run.w))), Math.max(1, Math.min(c.canvas.height - y, Math.floor(run.h)))).data;
        const px = [];
        for (let o = 0; o < d.length; o += 4) px.push([L(d[o], d[o + 1], d[o + 2]), d[o], d[o + 1], d[o + 2]]);
        px.sort((p, q) => p[0] - q[0]);
        const mid = px[Math.floor(px.length / 2)];
        const alpha = a * run.op;
        const fg = [r, g, b].map((v, k) => v * alpha + mid[k + 1] * (1 - alpha));
        const light = L(...fg) > mid[0];
        const bg = px[Math.floor((px.length - 1) * (light ? 0.95 : 0.05))];
        const ratio = (Math.max(L(...fg), bg[0]) + 0.05) / (Math.min(L(...fg), bg[0]) + 0.05);
        if (ratio < worst) { worst = ratio; on = `rgb(${bg.slice(1).join(', ')})`; }
      }
      if (worst < 7) out.push(`"${run.text}" ${run.color} on ${on}: ${worst.toFixed(2)}`);
    }
    return out;
  }, [shots, runs]);
  check(runs.length > 0 && low.length === 0, `studio: ${what}: every text on the TV at 7:1 or more over what is behind it (${runs.length} lines${blobs ? ', aurora swept' : ''})${low.length ? `: ${low.join(' | ')}` : ''}`);
}
/** Host → Queue → Tonight: the time each song was sung has a column of its own, clear of the singer's name. */
async function historyTimes(page, what) {
  await page.click('.admin-panel .segmented button:has-text("Tonight")');
  await page.waitForSelector('.admin-panel .q-item .q-singer');
  const rows = await page.$$eval('.admin-panel .q-item', (items) => items.map((li) => {
    const box = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    const el = li.querySelector('.q-text').previousElementSibling; // the time, before the singer and the song
    const time = box(el);
    const name = box(li.querySelector('.q-singer'));
    const song = box(li.querySelector('.q-song'));
    return { time: el.textContent.trim(), clear: time.right <= Math.min(name.left, song.left) && time.width > 0, inside: time.left >= li.getBoundingClientRect().left };
  }));
  check(rows.length > 0 && rows.every((r) => r.clear && r.inside), `${what}: History times clear of the singer’s name and the song (${rows.map((r) => `${r.time}${r.clear && r.inside ? '' : ' overlaps'}`).join(', ')})`);
}

async function setSkin(theme, open) {
  await hostReq('settings.update', { patch: { appearance: { theme } } });
  const ok = await Promise.all(open.map((p) => waitTheme(p, theme)));
  await sleep(250); // fonts, images in the new colours
  return ok.every(Boolean);
}

async function joinAs(page, name) {
  await page.goto(`${base}/j/${code}`);
  await page.waitForSelector('.profile-form');
  await page.fill('.profile-form input', name);
  await page.click('.profile-form .btn.primary');
  await page.waitForSelector('.g-tabs');
}

try {
  // ---- Studio is the default, already in the first HTML ------------------------------------------
  for (const p of ['/', '/host', '/tv', `/j/${code}`]) {
    const res = await fetch(`${base}${p}`);
    const text = await res.text();
    check(/<html lang="en" data-theme="studio">/.test(text) && text.includes(`<meta name="theme-color" content="${STUDIO.themeColor}">`), `${p} is served in the Studio skin`);
  }
  const host = await desktop('host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('.player');
  const tv = await tvSize('tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const guest = await phone('guest');
  await joinAs(guest, 'Gia');
  const hostPhone = await phone('host-phone');
  await hostPhone.goto(`${base}/host#/`);
  await hostPhone.waitForSelector('.player');
  const live = [host, tv, guest, hostPhone];
  const scrollChecks = [];
  for (const { name, page } of pages) {
    check(await themeOf(page) === 'studio' && await firstTheme(page) === 'studio', `${name}: Studio from the first paint`);
  }
  check(await tokenOf(tv, '--neon') === STUDIO.accent && await tokenOf(guest, '--night') === STUDIO.themeColor, 'Studio tokens apply');
  check(!(await tv.evaluate(() => [...document.fonts].some((f) => f.family.includes('Bricolage') && f.status === 'loaded'))), 'Studio does not load the Party display font');
  check(await iconOf(host, '.brand img') === 'studio' && await iconOf(tv, '.lobby-top img') === 'studio' && await favicon(host) === '/img/icon-studio.svg', 'Studio shows its own app icon (header, TV lobby, favicon)');

  // ---- switch to Party in Settings → Appearance: every open page follows, live --------------------
  await host.goto(`${base}/host#/settings/appearance`);
  await host.waitForSelector('.skin-card');
  check(await host.$eval('.settings-nav a.on', (a) => a.textContent.trim()) === 'Appearance', 'Settings has an Appearance section');
  check((await host.$$('.skin-card')).length === 2 && await host.$eval('.skin-card.on', (b) => b.dataset.skin) === 'studio', 'two skins to pick from, Studio in use');
  await shot(host, 'studio-host-settings-appearance');
  const tvQrBefore = await tv.$eval('.marquee img', (i) => i.getAttribute('src'));
  await host.click('.skin-card[data-skin="party"]');
  const followed = await Promise.all(live.map((p) => waitTheme(p, 'party')));
  check(followed.every(Boolean), 'host, TV, guest and host phone switch to Party live (no reload)');
  check(await host.$eval('.skin-card.on', (b) => b.dataset.skin) === 'party', 'the Party card is now in use');
  check(await tokenOf(tv, '--night') === '#150f26' && await tokenOf(guest, '--neon') === '#ff3d8b', 'Party tokens apply on the TV and the phone');
  await tv.waitForFunction((before) => document.querySelector('.marquee img')?.getAttribute('src') !== before, tvQrBefore, { timeout: 5000 }).catch(() => {});
  check(/dark=%231b1230&light=%23fff8e6/.test(await tv.$eval('.marquee img', (i) => i.getAttribute('src'))), 'the TV redraws its QR code in the Party colours');
  check(await guest.$eval('meta[name="theme-color"]', (m) => m.content) === '#150f26', 'the phone’s theme-color follows the skin');
  check(await iconOf(host, '.brand img') === 'party' && await iconOf(tv, '.lobby-top img') === 'party' && await favicon(tv) === '/img/icon.svg', 'Party shows the original app icon again (header, TV lobby, favicon)');
  check(app.settings.get('appearance.theme') === 'party', 'the choice is saved');
  await sleep(300);
  await shot(host, 'party-host-settings-appearance');

  // ---- accent override: applies everywhere, readable text on it, and resets ----------------------
  await host.fill('.accent-form input[type="color"]', '#00c2ff');
  const accented = await Promise.all(live.map((p) => waitToken(p, '--neon', '#00c2ff')));
  check(accented.every(Boolean), 'accent override applies on every open page');
  check(await host.$eval('.accent-form .btn', (b) => !b.disabled), '“Use the skin’s colour” is offered');
  const playInk = () => host.evaluate(() => getComputedStyle(document.querySelector('.play-btn')).color);
  check(await tokenOf(guest, '--neon-ink') === '#111' && await playInk() === 'rgb(17, 17, 17)', 'dark text on a mid-light accent (higher contrast than white)');
  await hostReq('settings.update', { patch: { appearance: { accent: '#1368ce' } } });
  await waitToken(host, '--neon', '#1368ce');
  check(await playInk() === 'rgb(255, 255, 255)' && await tokenOf(guest, '--neon-ink') === '#fff', 'white text on a dark accent');
  await hostReq('settings.update', { patch: { appearance: { accent: '#ffe066' } } });
  await waitToken(host, '--neon', '#ffe066');
  check(await playInk() === 'rgb(17, 17, 17)', 'dark text on a light accent');
  const res = await fetch(`${base}/tv`);
  check((await res.text()).includes('style="--neon: #ffe066; --neon-ink: #111;"'), 'the served page already has the accent (no flash)');
  await sleep(300); // the skin cards' border transition
  await shot(host, 'party-host-accent');
  await host.click('.accent-form .btn');
  const reset = await Promise.all(live.map((p) => waitToken(p, '--neon', '#ff3d8b')));
  check(reset.every(Boolean) && app.settings.get('appearance.accent') === '', 'accent resets to the skin’s own colour');
  check(await host.evaluate(() => !document.documentElement.style.getPropertyValue('--neon')), 'no inline accent left');

  // ---- a reload keeps the skin, with no flash of the default one ---------------------------------
  for (const { name, page } of pages) {
    const r = await page.reload();
    const html = await r.text();
    await page.waitForLoadState('load');
    check(html.includes('data-theme="party"') && await firstTheme(page) === 'party' && await themeOf(page) === 'party', `${name}: reload keeps Party from the first paint`);
  }
  await host.waitForSelector('.player');
  await tv.waitForSelector('.lobby');
  await guest.waitForSelector('.g-tabs');

  // ---- screens without a live connection follow a switch too (they check every few seconds) -----
  const idle = await desktop('landing-idle');
  await idle.goto(`${base}/`);
  await idle.waitForSelector('#qr[src]');
  const pinHost = await desktop('host-pin'); // another device, before its PIN: the server refuses it
  await pinHost.routeWebSocket(/\/ws$/, (ws) => ws.onMessage((m) => {
    if (JSON.parse(String(m)).t === 'hello') ws.send(JSON.stringify({ t: 'denied', reason: 'pin_required' }));
  }));
  await pinHost.goto(`${base}/host`);
  await pinHost.waitForSelector('.pin-input');
  const lost = await phone('guest-wrong-code');
  await lost.goto(`${base}/j/ZZZZ`);
  await lost.waitForSelector('.code-box');
  const gates = [idle, pinHost, lost];
  check((await Promise.all(gates.map(themeOf))).every((t) => t === 'party'), 'landing page, PIN screen and wrong-code screen are served in Party');
  check(await setSkin('studio', gates), 'landing page, PIN screen and wrong-code screen follow a switch without a reload');
  await shot(pinHost, 'studio-host-pin');
  await shot(lost, 'studio-guest-wrong-code');
  check(await setSkin('party', gates), '… and back to Party');
  await shot(pinHost, 'party-host-pin');
  await shot(lost, 'party-guest-wrong-code');
  scrollChecks.push(['guest wrong-code screen', await noSideways(lost)]);
  await Promise.all(gates.map((p) => p.close()));

  // ---- screenshots of the key screens in both skins ----------------------------------------------
  const songs = app.library.catalog.songList;
  await hostReq('queue.add', { songId: songs[1].id, singerName: 'Dora' });
  await hostReq('player.stop').catch(() => {});
  const landing = await desktop('landing');
  const landingPhone = await phone('landing-phone');
  const all = () => live;

  async function screens(skin) {
    check(await setSkin(skin, all()), `${skin}: every page shows the skin`);
    await landing.goto(`${base}/`);
    await landing.waitForSelector('#qr[src]');
    await sleep(600);
    await shot(landing, `${skin}-landing`);
    await landingPhone.goto(`${base}/`);
    await sleep(300);
    await shot(landingPhone, `${skin}-landing-phone`);
    await host.goto(`${base}/host#/`);
    await host.waitForSelector('.page-head, .hero-card');
    await sleep(400);
    await shot(host, `${skin}-host-home`);
    await host.fill('.search-box input', 'neon');
    await host.waitForSelector('.song-row');
    await sleep(400);
    await shot(host, `${skin}-host-search`);
    await hostPhone.goto(`${base}/host#/panel/queue`);
    await hostPhone.waitForSelector('.q-item');
    await shot(hostPhone, `${skin}-host-phone-queue`);
    for (const tab of ['playback', 'devices']) {
      await hostPhone.goto(`${base}/host#/panel/${tab}`);
      await hostPhone.waitForSelector(tab === 'playback' ? '#pb-sound' : '.dev-summary');
      await sleep(300);
      await shot(hostPhone, `${skin}-host-phone-${tab}`);
      scrollChecks.push([`${skin}: host phone ${tab}`, await noSideways(hostPhone)]);
    }
    for (const tab of ['Playback', 'Devices']) {
      await host.click(`.admin-panel [role=tab]:has-text("${tab}")`);
      await sleep(400);
      await shot(host, `${skin}-host-${tab.toLowerCase()}`);
    }
    await host.click('.admin-panel [role=tab]:has-text("Queue")');
    await hostPhone.goto(`${base}/host#/settings/appearance`);
    await hostPhone.waitForSelector('.skin-card');
    await shot(hostPhone, `${skin}-host-phone-appearance`);
    scrollChecks.push([`${skin}: host phone`, await noSideways(hostPhone)]);
    // the phone tab bar (six tabs, the other pages on "More"), from 390 down to 320px: every tab keeps
    // its whole label and the current tab's pill (Studio) fits; the More page in this skin
    const tabsAt = async (hash) => {
      await hostPhone.evaluate((h) => { location.hash = h; }, hash);
      await sleep(250);
      return hostPhone.evaluate(() => [...document.querySelectorAll('.nav a')].filter((a) => getComputedStyle(a).display !== 'none')
        .map((a) => `${a.querySelector('span:not(.badge)').textContent}${a.classList.contains('on') ? '*' : ''}`).join(' '));
    };
    for (const width of [390, 375, 360, 320]) {
      await hostPhone.setViewportSize({ width, height: 760 });
      await sleep(200);
      const cut = await hostPhone.evaluate(() => [...document.querySelectorAll('.nav a')].filter((a) => getComputedStyle(a).display !== 'none').flatMap((a) => {
        const label = a.querySelector('span:not(.badge)');
        const tab = a.getBoundingClientRect().width;
        return [(label.scrollWidth > label.clientWidth || label.getBoundingClientRect().width > tab) && label.textContent, a.querySelector('.icon').getBoundingClientRect().width > tab && `${label.textContent} pill`].filter(Boolean);
      }));
      check(cut.length === 0, `${skin}: host phone at ${width}px: whole tab labels${cut.length ? ` (cut: ${cut.join(', ')})` : ''}`);
      scrollChecks.push([`${skin}: host phone at ${width}px`, await noSideways(hostPhone)]);
      const home = await tabsAt('#/');
      check(home === 'Home* Search Artists Games Control More', `${skin}: host phone at ${width}px: six tabs, Home current on Home (${home})`);
      const appearance = await tabsAt('#/settings/appearance');
      check(appearance.endsWith('More*') && appearance.split('*').length === 2, `${skin}: host phone at ${width}px: Settings → Appearance marks More as current (${appearance})`);
    }
    await hostPhone.setViewportSize({ width: 390, height: 844 });
    await hostPhone.click('.nav a[href="#/more"]');
    await hostPhone.waitForSelector('.more-list');
    await sleep(200);
    check((await hostPhone.$$eval('.more-list a', (l) => l.map((a) => a.textContent.trim()))).some((t) => t.startsWith('Settings')), `${skin}: the More page leads to Settings`);
    await shot(hostPhone, `${skin}-host-phone-more`);
    scrollChecks.push([`${skin}: host phone More page`, await noSideways(hostPhone)]);
    await guest.click('.g-tabs button:has-text("Home")');
    await sleep(300);
    await shot(guest, `${skin}-guest-home`);
    scrollChecks.push([`${skin}: guest home`, await noSideways(guest)]);
    await guest.click('.g-tabs button:has-text("Songs")');
    await guest.fill('.g-search input', 'neon');
    await guest.waitForSelector('.g-songs .song-row');
    await sleep(300);
    await shot(guest, `${skin}-guest-songs`);
    await guest.click('.g-songs .song-row');
    await guest.waitForSelector('.sheet .btn.primary');
    await sleep(400);
    await shot(guest, `${skin}-guest-song-sheet`);
    scrollChecks.push([`${skin}: guest song sheet`, await noSideways(guest)]);
    await guest.click('.sheet-close');
    scrollChecks.push([`${skin}: landing`, await noSideways(landingPhone)]);
    await tv.waitForSelector('.lobby .upnext-item');
    await sleep(500);
    await shot(tv, `${skin}-tv-lobby`);
    if (skin === 'studio') await faintTvText(tv, 'TV lobby');
  }
  await screens('party');
  await screens('studio');

  // Intro (waits for "play"), then singing.
  await hostReq('player.play');
  await tv.waitForSelector('.intro');
  await host.goto(`${base}/host#/`);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    await tv.waitForFunction(() => /Ready when you are/.test(document.querySelector('.intro .status')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    await shot(tv, `${skin}-tv-intro`);
    // the song's year (shown when the artwork lookup knows it; a stand-in, so the check never depends on the song)
    await tv.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="intro year-probe" style="position: fixed; left: -100vw; top: 0"><span class="year">(1999)</span></div>'));
    if (skin === 'studio') await faintTvText(tv, 'TV intro');
    else check(await tv.$eval('.year-probe .year', (e) => getComputedStyle(e).color) === 'rgb(129, 116, 168)', 'party: the intro’s year keeps Party’s faint ink');
    await tv.evaluate(() => document.querySelector('.year-probe').remove());
    // guests' photos as the TV background: dimmed like covers in Studio (7:1 for the lobby and intro text), as before in Party
    const photoFilter = await tv.evaluate(() => {
      const el = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'photo-bg' }));
      el.style.cssText = 'animation: none; visibility: hidden';
      const f = getComputedStyle(el).filter;
      el.remove();
      return f;
    });
    check(photoFilter === (skin === 'party' ? 'brightness(0.6)' : studioToken('--photo-filter')), `${skin}: guests’ photos behind the TV text dimmed by the skin (${photoFilter})`);
  }
  await hostReq('player.play').catch(() => hostReq('player.resume'));
  await tv.waitForSelector('#cdg.show', { timeout: 15000 });
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    await sleep(700);
    await shot(tv, `${skin}-tv-singing`);
    await shot(host, `${skin}-host-playing`);
    await shot(guest, `${skin}-guest-playing`);
    // the title strip (the song's first seconds) is one line in the band above the lyrics, never
    // over them: in Studio its band is opaque under the singer's name, the title and the artist
    if (skin === 'studio') {
      check(await tv.$('.titlecard') !== null, 'studio: the title strip is up while the song starts');
      const hold = (on) => tv.evaluate((p) => { for (const a of document.getAnimations()) if (a.animationName === 'card-out') p ? a.pause() : a.play(); }, on);
      await hold(true);
      const strip = await tv.evaluate(() => {
        const card = document.querySelector('.titlecard');
        const a = card.getBoundingClientRect();
        const b = document.getElementById('lyrics').getBoundingClientRect();
        const texts = [...card.querySelectorAll('b, .tc-song')];
        const oneLine = texts.length === 2 && texts.every((e) => e.getClientRects().length === 1 && e.getBoundingClientRect().bottom <= a.bottom + 1 && e.getBoundingClientRect().top >= a.top - 1);
        return { gap: Math.round(b.top - a.bottom), apart: a.bottom <= b.top + 1 || a.top >= b.bottom - 1 || a.right <= b.left + 1 || a.left >= b.right - 1, oneLine };
      });
      check(strip.apart && strip.oneLine, `studio: the title strip is one line above the lyrics, clear of them (${strip.gap} px)`);
      await tvTextOver(tv, 'TV singing: the title strip');
      await hold(false);
      // a mirror screen: "Mirror display (muted)" sits on a navy chip in the bottom-right corner, and
      // the ticker leaves room for it, so the host's message never runs under it
      await hostReq('settings.update', { patch: { display: { tickerMessage: 'Drinks at the bar after the next song — the kitchen closes at eleven' } } });
      const mirror = await tvSize('mirror');
      await mirror.goto(`${base}/tv?display=mirror`);
      await mirror.waitForSelector('.mirror-badge');
      await mirror.waitForSelector('.ticker .message');
      const badge = await mirror.evaluate(() => {
        const a = document.querySelector('.mirror-badge').getBoundingClientRect();
        const b = document.querySelector('.ticker .message').getBoundingClientRect();
        return { meet: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom, gap: Math.round(a.left - b.right), fill: getComputedStyle(document.querySelector('.mirror-badge')).backgroundColor };
      });
      check(!badge.meet && badge.fill !== 'rgba(0, 0, 0, 0)', `studio: a mirror screen’s badge is on a chip of its own (${badge.fill}), clear of the ticker’s message (${badge.gap} px)`);
      await shot(mirror, 'studio-tv-mirror-singing');
      // a portrait (9:16) mirror: the message gives way instead of running under the badge
      await mirror.setViewportSize({ width: 720, height: 1280 });
      await sleep(300);
      const tall = await mirror.evaluate(() => {
        const a = document.querySelector('.mirror-badge').getBoundingClientRect();
        const b = document.querySelector('.ticker .message').getBoundingClientRect();
        return { meet: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom, gap: Math.round(a.left - b.right) };
      });
      check(!tall.meet, `studio: on a portrait mirror the ticker's message stays clear of the badge (${tall.gap} px)`);
      await shot(mirror, 'studio-tv-mirror-portrait');
      await mirror.close();
      await hostReq('settings.update', { patch: { display: { tickerMessage: '' } } });
    }
  }
  await hostReq('player.next'); // skipped: into tonight's history
  await tv.waitForSelector('.lobby');

  // Host → Queue → History (the song just skipped is there): the time it was sung has a column of its
  // own, clear of the singer's name, on a desktop and on a 360 px phone, in both skins.
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    await historyTimes(host, `${skin}: host`);
    await shot(host, `${skin}-host-history`);
    await host.click('.admin-panel .segmented button:has-text("Up next")');
    await hostPhone.setViewportSize({ width: 360, height: 760 });
    await hostPhone.goto(`${base}/host#/panel/queue`);
    await hostPhone.waitForSelector('.admin-panel .tabs');
    await historyTimes(hostPhone, `${skin}: host phone at 360px`);
    await shot(hostPhone, `${skin}-host-phone-history`);
    scrollChecks.push([`${skin}: host phone History at 360px`, await noSideways(hostPhone)]);
  }
  await hostPhone.setViewportSize({ width: 390, height: 844 });
  await hostReq('queue.add', { songId: songs[1].id, singerName: 'Dora' }); // (for the queue board below)
  await hostReq('player.stop'); // (it started on its own: back to the queue, held)
  await tv.waitForSelector('.lobby');

  // A game: the roulette wheel (answer colours and confetti come from the skin too).
  await hostReq('game.start', { type: 'wheel', config: { kind: 'songs', count: 8 } });
  await tv.waitForSelector('.wheel-tv .wheel-svg');
  await guest.waitForSelector('.wheel-guest .wheel-svg');
  const segFill = () => tv.$eval('.wheel-seg path', (p) => getComputedStyle(p).fill);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    check(await segFill() === (skin === 'party' ? 'rgb(255, 61, 139)' : rgbOf(studioToken('--wheel-1'))), `${skin}: wheel segments use the skin’s palette`);
    if (skin === 'studio') {
      await wheelLabels(tv, 'TV wheel');
      await faintTvText(tv, 'TV wheel');
    }
    await shot(tv, `${skin}-tv-wheel`);
    await shot(guest, `${skin}-guest-wheel`);
    scrollChecks.push([`${skin}: guest wheel`, await noSideways(guest)]);
  }
  await hostReq('game.action', { action: 'spin' });
  await tv.waitForSelector('.wheel-reveal', { timeout: 15000 });
  const winFilter = () => tv.$eval('.wheel-tv .wheel-seg.win path', (p) => getComputedStyle(p).filter);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    if (skin === 'studio') {
      await wheelLabels(tv, 'TV wheel result (winner and the navy segments)');
      await faintTvText(tv, 'TV wheel result');
    } else {
      await tv.waitForFunction(() => getComputedStyle(document.querySelector('.wheel-tv .wheel-seg.win path')).filter === 'brightness(1.12)', null, { timeout: 3000 }).catch(() => {});
      check(await winFilter() === 'brightness(1.12)', 'party: the winning segment lights up as before');
    }
    await shot(tv, `${skin}-tv-wheel-result`);
  }
  await hostReq('game.end');
  await hostReq('game.close');

  // The "What's next?" poll: answer colours per skin, on the TV and the phone.
  await hostReq('game.start', { type: 'poll', config: {} });
  await tv.waitForSelector('.g-tv .g-answer');
  await guest.waitForSelector('button.g-answer');
  const answerBg = () => guest.$eval('button.g-answer', (b) => getComputedStyle(b).backgroundColor);
  for (const skin of ['studio', 'party']) {
    await setSkin(skin, all());
    check(await answerBg() === (skin === 'party' ? 'rgb(226, 27, 60)' : rgbOf(studioToken('--answer-1'))), `${skin}: answer colours come from the skin`);
    await shot(tv, `${skin}-tv-poll`);
    // the artist line on the TV's answers: full strength in Studio (7:1), Party's 85% as before
    check(await tv.$eval('.g-tv .g-answer .text small', (e) => getComputedStyle(e).opacity).catch(() => '') === (skin === 'party' ? '0.85' : '1'), `${skin}: TV answers' artist line at ${skin === 'party' ? '85 %' : 'full strength'}`);
    if (skin === 'studio') await faintTvText(tv, 'TV poll');
    await shot(guest, `${skin}-guest-poll`);
    scrollChecks.push([`${skin}: guest poll`, await noSideways(guest)]);
  }
  await hostReq('game.end');
  await hostReq('game.close');

  // The queue board for a second screen follows the skin too.
  await setSkin('studio', all());
  const board = await tvSize('board');
  await board.goto(`${base}/tv?layout=board`);
  await board.waitForSelector('.board');
  check(await themeOf(board) === 'studio' && await firstTheme(board) === 'studio', 'board: Studio from the first paint');
  await shot(board, 'studio-tv-board');
  check(await board.$$eval('.board-list .pos', (els) => els.length) > 0, 'board: the queue is listed');
  await faintTvText(board, 'queue board');

  // Studio: the TV's text over a white guest photo (the background "photos", dimmed by the skin) and
  // over the skin's own aurora (the background "visualizer"): the lobby with its up-next chips, the
  // intro and the queue board, panels and rows included, every line at 7:1 or more.
  for (const [i, singerName] of ['Ann', 'Bo', 'Cy', 'Di'].entries()) await hostReq('queue.add', { songId: songs[(i + 2) % songs.length].id, singerName });
  await hostReq('settings.update', { patch: { display: { background: 'photos' }, guests: { photoApproval: false } } });
  const uploaded = await guest.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    const body = await new Promise((r) => c.toBlob(r, 'image/png'));
    return (await fetch('/api/photos', { method: 'POST', headers: { 'content-type': 'image/png', 'x-guest-token': localStorage.getItem('ok.guestToken') || '' }, body })).ok;
  });
  check(uploaded, 'a guest sends a white photo (shown without approval)');
  for (const p of [tv, board]) {
    await p.addStyleTag({ content: '.photo-flash { display: none !important; }' }); // (the new photo's flash would cover the text)
    await p.waitForSelector('#bg .photo-bg');
  }
  await tv.waitForSelector('.lobby .upnext-item');
  await sleep(1800); // the photo fades in
  await tvTextOver(tv, 'TV lobby over a white guest photo');
  await tvTextOver(board, 'queue board over a white guest photo');
  // The first song's intro: it waits for "play", then counts down — long enough here that the
  // song can't start (and the title card slide in) while the checks below measure the intro.
  await hostReq('settings.update', { patch: { playback: { countdown: 120 } } });
  await hostReq('player.play');
  await tv.waitForSelector('.intro');
  await board.waitForSelector('.board-now b');
  await sleep(1800);
  await tvTextOver(tv, 'TV intro over a white guest photo');
  await tvTextOver(board, 'queue board (a song getting ready) over a white guest photo');
  await hostReq('settings.update', { patch: { display: { background: 'visualizer' } } });
  await tv.waitForSelector('#bg .aurora');
  await board.waitForSelector('#bg .aurora');
  await tvTextOver(tv, 'TV intro over the aurora', { sweep: true });
  await tvTextOver(board, 'queue board over the aurora', { sweep: true });
  check(app.room.s.player.state === 'intro', `the intro stayed on screen for its checks (${app.room.s.player.state})`);
  await hostReq('player.stop');
  await hostReq('settings.update', { patch: { playback: { countdown: 3 } } });
  await tv.waitForSelector('.lobby .upnext-item');
  await sleep(600);
  await tvTextOver(tv, 'TV lobby over the aurora', { sweep: true });
  await hostReq('settings.update', { patch: { display: { background: 'art' } } });

  check(await setSkin('party', [...all(), board]), 'board: switches to Party live');
  await shot(board, 'party-tv-board');

  for (const [what, ok] of scrollChecks) check(ok, `${what}: no sideways scrolling`);
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await app.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed.length ? 1 : 0);
