#!/usr/bin/env node
// End-to-end checks of the readable lyrics on the TV (docs/PLAN.md §9, "Readable lyrics"): no
// filter on anything that moves; no overlay over the lyric box at the usual screen sizes; a
// light disc's words at 7:1 or more on the dark panel; the demo scroller glides (the canvas moves
// by a transform) without the decoder replaying the song; a disc's scroll-preset fill and border
// strips are keyed out; the disc look is opaque in a frame of the disc's border colour; lighter
// effects follow the setting; a mirror and the host's preview show the lyrics; the host's settings
// fit a phone. The library is the demo (its smooth scroller) plus two discs written here with
// CdgWriter: a cream, dark-on-light pager and a scroller whose SCROLL_PRESET fill and border
// presets uncover strips of other colours.
//
//   node test/e2e/lyrics.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { setLogLevel } from '../../server/util/log.js';
import { CdgWriter, drawText, centeredX, textWidth } from '../../scripts/lib/cdg-writer.js';
import { wavBuffer } from '../../scripts/make-demo-library.js';
import { loadPlaywright, startParty, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-lyrics');
await fs.mkdir(out, { recursive: true });

// ---- the test discs ------------------------------------------------------------------------

const W = 300;
const pal = (entries) => Array.from({ length: 16 }, (_, i) => entries[i] || [0, 0, 0]);
const LINES = [
  'Paper lanterns in the rain', 'Every window lit again', 'Hold the tune and hold it high',
  'Sing it softly, say goodbye', 'Morning comes and still we sing', 'One more chorus, everything',
];
for (const l of LINES) if (textWidth(l) > 276) throw new Error(`too wide: ${l}`);

/** A light disc, as some brands make them: navy words on cream, sung in red, three lines a page. */
function lightDisc() {
  const [CREAM, NAVY, RED] = [0, 1, 2];
  const w = new CdgWriter();
  w.loadColors(pal([[15, 15, 13], [0, 0, 9], [13, 0, 0]]));
  w.memoryPreset(CREAM, 2);
  w.borderPreset(CREAM);
  const frame = w.screen.slice();
  drawText(frame, 'Paper Lantern', centeredX('Paper Lantern'), 70, NAVY);
  drawText(frame, 'Daylight Choir', centeredX('Daylight Choir'), 110, RED);
  w.drawFrame(frame);
  w.padTo(2);
  for (let page = 0; page < 2; page++) {
    const lines = LINES.slice(page * 3, page * 3 + 3);
    const draw = (active, progress) => {
      frame.fill(CREAM);
      lines.forEach((l, i) => {
        const x = centeredX(l);
        const hx = i < active ? 999 : i === active ? x + Math.round(progress * textWidth(l)) : -1;
        drawText(frame, l, x, 40 + i * 48, NAVY, { highlightX: hx, highlightColor: RED });
      });
      w.drawFrame(frame);
    };
    draw(-1, 0);
    for (let i = 0; i < 3; i++) {
      for (let s = 0; s <= 20; s++) {
        w.padTo(w.time + 0.1);
        draw(i, s / 20);
      }
    }
  }
  w.padTo(w.time + 2);
  return w.toBuffer();
}

/**
 * A scroller that uncovers strips in other colours: every other glide starts with a BORDER_PRESET
 * (magenta), so the vertical offsets uncover the border rows below the window; every glide ends
 * with a SCROLL_PRESET 12-row move that fills the uncovered rows with dark red, which the next
 * glide uncovers. (Half way through a border glide the hidden tile row is repainted, so the
 * border colour itself never moves into the window.) A new line pops in at the bottom after every
 * second glide.
 */
function stripDisc() {
  const [BG, TEXT, BORDER, FILL] = [0, 1, 4, 5];
  const w = new CdgWriter();
  w.loadColors(pal([[0, 0, 2], [15, 15, 15], [15, 13, 0], [0, 0, 0], [13, 0, 13], [9, 0, 2]]));
  w.memoryPreset(BG, 2);
  w.borderPreset(BORDER);
  const frame = w.screen.slice();
  LINES.forEach((l, i) => drawText(frame, l, centeredX(l), 60 + i * 24, TEXT));
  w.drawFrame(frame);
  w.padTo(2);
  for (let cycle = 0; cycle < 16; cycle++) {
    const border = cycle % 2 === 0;
    if (border) w.borderPreset(BORDER);
    for (let s = 1; s <= 12; s++) {
      const from = w.count;
      if (border && s === 7) {
        const t = w.screen.slice();
        t.fill(BG, 204 * W, 216 * W);
        w.drawFrame(t);
      }
      const off = s % 12;
      w.scroll(false, FILL, 0, 0, off ? 0 : 2, off);
      w.padPackets(from + 8 - w.count);
    }
    w.padTo(w.time + 0.4);
    if (!border) {
      const t = w.screen.slice();
      t.fill(BG, 180 * W, 204 * W);
      const l = LINES[(cycle >> 1) % LINES.length];
      drawText(t, l, centeredX(l), 180, TEXT);
      w.drawFrame(t);
    }
    w.padTo(w.time + 0.4);
  }
  w.padTo(w.time + 2);
  return w.toBuffer();
}

/** Writes a track (CD+G + a quiet tone as long as it) into the library folder. */
async function writeTrack(lib, artist, title, cdg) {
  const dir = path.join(lib, artist[0].toUpperCase(), artist);
  await fs.mkdir(dir, { recursive: true });
  const n = Math.round((cdg.length / 7200) * 44100);
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / 44100);
  const name = `${artist} - ${title} [LT Karaoke]`;
  await fs.writeFile(path.join(dir, `${name}.cdg`), cdg);
  await fs.writeFile(path.join(dir, `${name}.wav`), wavBuffer(tone, tone));
}

// ---- the party ----------------------------------------------------------------------------

const { chromium } = loadPlaywright();
const { app, base } = await startParty({
  addTracks: async (lib) => {
    await writeTrack(lib, 'Daylight Choir', 'Paper Lantern (Light)', lightDisc());
    await writeTrack(lib, 'Border Patrol', 'Fill The Gap (Preset)', stripDisc());
  },
});
app.settings.update({ playback: { countdown: 1 }, display: { tickerMessage: 'Happy birthday Sam, drinks at the bar after the next song' } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const room = app.room;
const asHost = { role: 'host', data: {}, isLocal: true, send() {} };
const hostReq = (t, m = {}) => room.request(asHost, { t, ...m });
const setDisplay = (patch) => hostReq('settings.update', { patch: { display: patch } });
const song = (q) => app.library.catalog.search(q).items[0];
/** Test only: expose the TV page's controller (its lyrics renderer and clock). */
const exposeController = (page) => page.route('**/js/tv/main.js', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await res.text()}\nwindow.__tvController = controller;\n` });
});
const pos = (page) => page.evaluate(() => window.__tvController.position());
/** Seeks and waits until the TV is there (and the decoder has caught up). */
const seekTo = async (page, t) => {
  await hostReq('player.seek', { pos: t });
  await until(async () => Math.abs((await pos(page)) - t) < 0.4, 5000);
  await sleep(250);
};
/** Waits until `title` is the song on the TV with its lyrics loaded and showing. */
const onTv = (page, title) => until(async () => room.s.current?.title.startsWith(title) && room.s.player.state === 'playing'
  && page.evaluate(() => window.__tvController.lyrics.loaded && window.__tvController.engine.playing && document.getElementById('lyrics').classList.contains('show')), 30000);

/** In the page: canvas pixels drawn (alpha > 0) and how they read against the plate (composited over mid-grey, the worst backdrop the skins leave). */
const canvasInk = (target) => target.evaluate(() => {
  const c = document.getElementById('cdg');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const [pr, pg, pb, pa = 1] = getComputedStyle(document.querySelector('.lyr-plate')).backgroundColor.match(/[\d.]+/g).map(Number);
  const back = lum([pr, pg, pb].map((v) => v * pa + 128 * (1 - pa)));
  const ratios = new Map();
  let ink = 0;
  let partial = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    ink++;
    if (d[i + 3] !== 255) partial++;
    const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
    if (!ratios.has(key)) {
      const l = lum([d[i], d[i + 1], d[i + 2]]);
      ratios.set(key, (Math.max(l, back) + 0.05) / (Math.min(l, back) + 0.05));
    }
  }
  const min = Math.min(99, ...ratios.values());
  return { ink, partial, min, colours: [...ratios].map(([k, v]) => `${k} ${v.toFixed(2)}`) };
});

/** Overlays shown with the lyrics, against the lyric box (±1 px). */
const OVERLAYS = ['.titlecard', '.corner-qr', '.upnext-banner', '.paused-pill', '.reaction', '.progress', '.ticker'];
const overlays = (page) => page.evaluate((sels) => {
  const box = document.getElementById('lyrics').getBoundingClientRect();
  const found = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const a = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!a.width || !a.height || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const meets = a.left < box.right - 1 && box.left + 1 < a.right && a.top < box.bottom - 1 && box.top + 1 < a.bottom;
      found.push({ sel, meets, rect: [a.left, a.top, a.right, a.bottom].map(Math.round) });
    }
  }
  return { box: [box.left, box.top, box.right, box.bottom].map(Math.round), found };
}, OVERLAYS);
const SIZES = [[1920, 1080], [1280, 720], [1366, 768], [1024, 768], [1280, 1024], [2560, 1080]];
/** Measures the overlays at every §7 size on the TV and on the portrait mirror; `want`: the ones that must be up. */
async function overlaysClear(tv, mirror, what, want) {
  const bad = [];
  const seen = new Set();
  const measure = async (page, size) => {
    const r = await overlays(page);
    for (const f of r.found) {
      seen.add(f.sel);
      if (f.meets) bad.push(`${size} ${f.sel} [${f.rect}] meets the box [${r.box}]`);
    }
  };
  for (const [w, h] of SIZES) {
    await tv.setViewportSize({ width: w, height: h });
    await tv.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await measure(tv, `${w}x${h}`);
  }
  await measure(mirror, '720x1280 mirror');
  const missing = want.filter((s) => !seen.has(s));
  check(!bad.length && !missing.length, `${what}: ${[...seen].join(' ')} clear of the lyric box at ${SIZES.length} sizes and the portrait mirror${bad.length ? `: ${bad.join(' | ')}` : ''}${missing.length ? ` (not shown: ${missing.join(' ')})` : ''}`);
  await tv.setViewportSize({ width: 1280, height: 720 });
}

try {
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await exposeController(tv);
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  const mirror = watch(await browser.newPage({ viewport: { width: 720, height: 1280 } }), 'mirror');
  await mirror.goto(`${base}/tv?display=mirror`);
  await mirror.waitForSelector('.lobby');

  const glide = song('gliding home');
  const light = song('paper lantern');
  const strips = song('fill the gap');
  check(!!(glide && light && strips), 'the demo scroller and the two test discs are in the library');
  await hostReq('queue.add', { songId: glide.id, singerName: 'Alexandra the Magnificent' });
  await hostReq('queue.add', { songId: light.id, singerName: 'Ben' });
  await hostReq('queue.add', { songId: strips.id, singerName: 'Cleo' });
  if (!room.s.current) await hostReq('player.play');
  check(await onTv(tv, 'Gliding Home'), 'the demo scroller plays with its lyrics on the TV');

  // ---- 1. nothing that moves has a filter; the background shade has no backdrop blur -----------
  const fx = await tv.evaluate(() => {
    const f = (sel) => getComputedStyle(document.querySelector(sel)).filter;
    const shade = document.querySelector('.art-shade');
    return { lyrics: f('#lyrics'), win: f('.lyr-window'), cdg: f('#cdg'), shade: shade && getComputedStyle(shade).backdropFilter, scrim: !!document.querySelector('#bg .scrim') };
  });
  check(fx.lyrics === 'none' && fx.win === 'none' && fx.cdg === 'none', `no filter on the lyric box, its window or the canvas (${fx.lyrics} / ${fx.win} / ${fx.cdg})`);
  check(fx.shade === 'none' && !fx.scrim, `the background shade (.art-shade) has no backdrop blur (${fx.shade})`);

  // ---- 7a. lighter effects by themselves: headless Chromium draws in software ----------------
  const lite = (page) => page.evaluate(() => ({ on: document.documentElement.classList.contains('lite-auto'), reason: document.documentElement.dataset.liteReason || '' }));
  const autoLite = await lite(tv);
  check(autoLite.on && /software/.test(autoLite.reason), `'auto': the TV takes lighter effects in software drawing (${autoLite.reason})`);

  // ---- 2. no overlay on the lyrics -------------------------------------------------------------
  await seekTo(tv, 0.5);
  await overlaysClear(tv, mirror, 'title strip', ['.titlecard', '.corner-qr', '.progress', '.ticker']);
  await shot(tv, 'tv-title-strip');
  app.hub.broadcast({ t: 'reaction', emoji: '🎉', name: 'Bartholomew Longname' }, (c) => c.role === 'tv');
  await sleep(900);
  await overlaysClear(tv, mirror, 'a reaction', ['.reaction']);
  await hostReq('player.pause');
  await tv.waitForSelector('.paused-pill');
  await overlaysClear(tv, mirror, 'paused', ['.paused-pill']);
  await hostReq('player.resume');
  const dur = room.s.player.dur || room.s.current.dur;
  await seekTo(tv, dur - 15);
  await tv.waitForSelector('.upnext-banner');
  await overlaysClear(tv, mirror, 'up next', ['.upnext-banner']);
  await shot(tv, 'tv-up-next');

  // ---- 4. the demo scroller glides: the canvas moves, the decoder never replays -----------------
  // Its second line glides up at 13.82 s (24 px in 0.4 s); two seconds from 13.3 s.
  await seekTo(tv, 13.3);
  const g = await tv.evaluate(async () => {
    const { CdgDecoder } = await import('/shared/cdg.js'); // (the module the renderer uses)
    const c = window.__tvController;
    const reset = CdgDecoder.prototype.reset;
    let resets = 0;
    CdgDecoder.prototype.reset = function () {
      resets++;
      return reset.call(this);
    };
    const tfs = new Set();
    let frames = 0;
    let stopped = 0;
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        frames++;
        tfs.add(c.lyrics.canvas.style.transform);
        if (!c.engine.playing) stopped++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    CdgDecoder.prototype.reset = reset;
    return { resets, distinct: tfs.size, frames, stopped, timeline: c.lyrics.timeline && c.lyrics.timeline.w, insets: c.lyrics.insets };
  });
  check(g.timeline > 0, `the scroller has a scroll timeline (box ${g.timeline} packets, insets ${g.insets.top}/${g.insets.bottom})`);
  check(g.distinct >= 10, `the glide moves the canvas through ${g.distinct} transforms in 2 s (${g.frames} frames)`);
  check(g.resets === 0 && g.stopped === 0, `the decoder never replays while playing (${g.resets} resets, ${g.stopped} frames not playing)`);

  // ---- 7b. lighter effects: off never, on always -------------------------------------------------
  await setDisplay({ lighterEffects: 'off' });
  check(await until(async () => !(await lite(tv)).on, 3000), "'off': the TV drops lighter effects");
  let offSeen = false;
  for (let i = 0; i < 12; i++) {
    offSeen ||= (await lite(tv)).on || (await lite(mirror)).on;
    await sleep(200);
  }
  check(!offSeen, "'off': never lighter effects while the lyrics play (TV and mirror)");
  await setDisplay({ lighterEffects: 'on' });
  check(await until(async () => (await lite(tv)).on && (await lite(mirror)).on, 3000), "'on': the TV and the mirror have lighter effects");

  // ---- 8. the mirror and the host's preview show the lyrics ----------------------------------
  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host`);
  await host.click('.admin-panel [role=tab]:has-text("Playback")');
  const frame = await (await host.waitForSelector('.preview-frame iframe')).contentFrame();
  check(await frame.waitForSelector('#lyrics.show', { timeout: 15000 }).then(() => true, () => false), 'the host’s preview shows the lyric box');
  check(await until(async () => (await canvasInk(frame)).ink > 500), 'the host’s preview draws the lyrics');
  check((await lite(frame)).on, "'on': the preview has lighter effects too");
  check(await mirror.waitForSelector('#lyrics.show', { timeout: 5000 }).then(() => true, () => false) && (await canvasInk(mirror)).ink > 500, 'the portrait mirror shows the lyrics');
  await setDisplay({ lighterEffects: 'auto' });
  check(await until(async () => (await lite(tv)).on && !(await lite(frame)).on, 3000), "'auto': the TV decides by itself, the preview doesn't");
  await shot(mirror, 'mirror-portrait');
  await shot(host, 'host-playback');
  // The Playback tab's "Lyrics look" (under "On the TV") switches the TV while a song is on.
  await host.click('#pb-quick summary');
  await host.selectOption('.admin-panel select[aria-label="Lyrics look"]', 'clear');
  check(await until(async () => (await tv.$eval('#lyrics', (e) => e.dataset.look)) === 'clear'), 'Playback tab → Lyrics look “With an outline”: the TV follows');
  await shot(tv, 'tv-glide-clear');
  await host.selectOption('.admin-panel select[aria-label="Lyrics look"]', 'panel');
  check(await until(async () => (await tv.$eval('#lyrics', (e) => e.dataset.look)) === 'panel'), 'and back to the panel');
  await host.close();

  // ---- 3. a light disc on the panel: every drawn pixel at 7:1 or more ---------------------------
  await hostReq('player.next');
  check(await onTv(tv, 'Paper Lantern'), 'the light disc plays');
  await tv.waitForFunction(() => !!window.__tvController.lyrics.roles, null, { timeout: 10000 }).catch(() => {});
  for (const t of [1, 3.2, 5.5, 9.4]) {
    await seekTo(tv, t);
    const ink = await canvasInk(tv);
    check(ink.ink > 2000 && ink.partial === 0 && ink.min >= 7, `light disc at ${t} s: ${ink.ink} px drawn, all at 7:1 or more on the plate (min ${ink.min.toFixed(2)}: ${ink.colours.join(' · ')})`);
  }
  await shot(tv, 'tv-light-panel');

  // ---- 5. the strip disc on the panel: its fill and border strips are never drawn --------------
  await hostReq('player.next');
  check(await onTv(tv, 'Fill The Gap'), 'the strip disc plays');
  await seekTo(tv, 2.2);
  /** In the page, every frame for `ms`: window pixels in the fill or border colour, and those drawn. */
  const strips5 = (opaqueWant) => tv.evaluate(async ({ ms, opaque }) => {
    const c = window.__tvController;
    const r = c.lyrics;
    const res = { frames: 0, fill: 0, border: 0, drawn: 0, clear: 0, bad: 0 };
    const probe = () => {
      const d = r.decoder;
      if (!d) return;
      res.frames++;
      const cv = r.canvas;
      const idx = r.smoothing ? r.big : r.idx;
      const cr = cv.getBoundingClientRect();
      const wr = r.win.getBoundingClientRect();
      const sx = cr.width / cv.width;
      const sy = cr.height / cv.height;
      // canvas pixels whose centre is inside the window
      const x0 = Math.max(0, Math.ceil((wr.left - cr.left) / sx - 0.5));
      const x1 = Math.min(cv.width, Math.ceil((wr.right - cr.left) / sx - 0.5));
      const y0 = Math.max(0, Math.ceil((wr.top - cr.top) / sy - 0.5));
      const y1 = Math.min(cv.height, Math.ceil((wr.bottom - cr.top) / sy - 0.5));
      const data = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = idx[y * cv.width + x];
          const a = data[((y - y0) * (x1 - x0) + x - x0) * 4 + 3];
          if (opaque) {
            if (a === 255) res.drawn++;
            else res.clear++;
            continue;
          }
          const isFill = i === d.scrollFill;
          const isBorder = i === d.borderColor && i !== d.bgColor;
          if (!isFill && !isBorder) continue;
          if (isFill) res.fill++;
          else res.border++;
          if (a) res.bad++;
        }
      }
    };
    const frame = c.frame;
    c.frame = (ts) => {
      frame.call(c, ts);
      probe();
    };
    await new Promise((done) => setTimeout(done, ms));
    c.frame = frame;
    // the plate: its colour, the disc's border colour, and how far it reaches out round the box
    res.plateCss = getComputedStyle(document.querySelector('.lyr-plate')).backgroundColor;
    const b = r.decoder.borderColor * 3;
    res.borderRgb = `rgb(${r.decoder.palette[b]}, ${r.decoder.palette[b + 1]}, ${r.decoder.palette[b + 2]})`;
    const plate = document.querySelector('.lyr-plate').getBoundingClientRect();
    const box = document.getElementById('lyrics').getBoundingClientRect();
    res.frame = Math.min(box.left - plate.left, box.top - plate.top, plate.right - box.right, plate.bottom - box.bottom);
    return res;
  }, { ms: 4500, opaque: opaqueWant });
  const s5 = await strips5(false);
  check(s5.frames > 10 && s5.fill > 1000 && s5.border > 1000, `the strip disc uncovers its fill and border colours in the window (${s5.fill} and ${s5.border} px over ${s5.frames} frames)`);
  check(s5.bad === 0, `panel look: none of them drawn (${s5.bad} opaque)`);
  await shot(tv, 'tv-strips-panel');

  // ---- 6. the disc look: opaque, in a frame of the disc's border colour ------------------------
  await setDisplay({ lyricsLook: 'disc' });
  check(await until(async () => (await tv.$eval('#lyrics', (e) => e.dataset.look)) === 'disc'), 'the disc look is on');
  await sleep(300);
  const s6 = await strips5(true);
  check(s6.frames > 10 && s6.clear === 0 && s6.drawn > 100000, `disc look: the canvas is opaque in the window (${s6.drawn} px, ${s6.clear} see-through)`);
  check(s6.plateCss === s6.borderRgb && s6.frame > 5, `disc look: a frame (${s6.frame.toFixed(1)} px) in the disc's border colour (${s6.plateCss}; palette ${s6.borderRgb})`);
  await shot(tv, 'tv-strips-disc');
  await setDisplay({ lyricsLook: 'panel' });

  // ---- 9. the host's TV display settings on a phone -------------------------------------------
  const phone = watch(await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), 'host-phone');
  await phone.goto(`${base}/host#/settings/display`);
  await phone.waitForSelector('.setting');
  const rows = await phone.$$eval('.setting-text b', (l) => l.map((b) => b.textContent.trim()));
  const at = (label) => rows.indexOf(label);
  check(at('Lyrics') >= 0 && at('Lyrics') < at('Scrolling lyrics') && at('Scrolling lyrics') < at('Smooth lyrics text') && at('Smooth lyrics text') < at('Lighter effects on the TV'),
    `Settings → TV display: Lyrics, Scrolling lyrics, Smooth lyrics text, Lighter effects on the TV (${rows.filter((r) => /yric|ighter/.test(r)).join(', ')})`);
  check(!rows.some((r) => /background behind the lyrics/i.test(r)), 'the old “Show the background behind the lyrics” switch is gone');
  const lyricsSelect = '.setting:has(.setting-text b:text-is("Lyrics")) select';
  await phone.selectOption(lyricsSelect, 'clear');
  check(await until(async () => (await tv.$eval('#lyrics', (e) => e.dataset.look)) === 'clear'), 'Lyrics “Over the background, with an outline”: the TV follows');
  await phone.selectOption(lyricsSelect, 'panel');
  await phone.evaluate(() => document.querySelector('.setting:has(select)')?.scrollIntoView({ block: 'center' }));
  check(await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0), 'the TV display settings fit a phone (no sideways scrolling)');
  await shot(phone, 'host-settings-phone');
  await phone.close();
  await hostReq('player.stop');
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
