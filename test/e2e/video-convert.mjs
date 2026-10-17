#!/usr/bin/env node
// An AVI karaoke video on the TV: the real ffmpeg converts it (server/video/), held on a gate so
// the TV is checked while it is still converting ("Getting the video ready…", the song waits),
// then the converted WebM plays. Settings → Library says which ffmpeg does it.
// Needs ffmpeg on this computer (it also makes the AVI); without it the script says so and stops.
//
//   node test/e2e/video-convert.mjs [outDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setLogLevel } from '../../server/util/log.js';
import { ffmpegTool } from '../../server/video/ffmpeg.js';
import { loadPlaywright, startParty, WsClient, check, results, sleep } from './lib.mjs';

setLogLevel(process.env.LOG_LEVEL || 'warn');
const out = path.resolve(process.argv[2] || 'test-results/e2e-video-convert');
await fs.mkdir(out, { recursive: true });
try {
  execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
} catch {
  console.log('ffmpeg is not installed here: nothing to check (install it to run this script).');
  process.exit(0);
}

const { chromium } = loadPlaywright();
const real = ffmpegTool();
let release;
const gate = new Promise((resolve) => { release = resolve; });
const videoTool = { detect: () => real.detect(), run: async (job) => { await gate; return real.run(job); } };
const { app, base } = await startParty({
  videoTool,
  // 8 s of test picture and a tone, as an old karaoke AVI (MPEG-4 video, PCM sound).
  addTracks: async (lib) => {
    const dir = path.join(lib, 'T', 'Toto');
    await fs.mkdir(dir, { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le',
      path.join(dir, 'Toto - Africa [KV Karaoke].avi')]);
  },
});
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return page;
};
const avi = [...app.library.catalog.tracks.values()].find((t) => t.video?.endsWith('.avi'));
let ws = null;

try {
  check(!!avi, 'the AVI is in the library');
  const tv = watch(await browser.newPage({ viewport: { width: 1280, height: 720 } }), 'tv');
  await tv.goto(`${base}/tv`);
  await tv.waitForSelector('.lobby');
  ws = new WsClient(`${base.replace('http', 'ws')}/ws`);
  await ws.open({ role: 'host' });
  const song = app.library.catalog.search('africa').items[0];
  await ws.req('queue.add', { songId: song.id, trackId: avi.id, singerName: 'Ana' });
  await ws.until((s) => s.current?.trackId === avi.id);
  const waiting = await tv.waitForSelector('.intro .status:has-text("Getting the video ready")', { timeout: 15_000 }).then(() => tv.textContent('.intro .status'), () => '');
  check(!!waiting, `while ffmpeg converts, the TV says so ("${waiting.trim()}")`);
  await sleep(1500);
  const st = await ws.until(() => true);
  check(st.player.state === 'intro' && !st.player.error, `the song waits for it (${st.player.state})`);
  await tv.screenshot({ path: path.join(out, 'tv-converting.png') });

  const host = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }), 'host');
  await host.goto(`${base}/host#/settings/library`);
  const said = await host.waitForSelector('.video-conversion', { timeout: 15_000 }).then(() => host.textContent('.video-conversion'), () => '');
  check(/1 video in AVI, MPG or WMV is converted with ffmpeg \S+ when queued/.test(said), `Settings → Library: "${said.replace(/\s+/g, ' ').trim()}"`);
  await host.screenshot({ path: path.join(out, 'host-settings-library.png') });

  release();
  const t0 = Date.now();
  const playing = await ws.until((s) => s.player.state === 'playing', 60_000).then(() => true, () => false);
  check(playing, `once converted (${((Date.now() - t0) / 1000).toFixed(1)} s), the song starts`);
  let pos = 0;
  for (let i = 0; i < 40 && pos < 1; i++) {
    pos = await tv.$eval('video', (v) => (v.hidden || v.paused ? 0 : v.currentTime)).catch(() => 0);
    if (pos < 1) await sleep(100);
  }
  const size = await tv.$eval('video', (v) => [v.videoWidth, v.videoHeight, v.currentSrc]).catch(() => [0, 0, '']);
  check(pos >= 1 && size[0] === 640 && size[1] === 360 && /\/media\/.+\/video$/.test(size[2]), `the TV plays the converted video (${pos.toFixed(1)} s, ${size[0]}×${size[1]})`);
  await tv.screenshot({ path: path.join(out, 'tv-playing.png') });
  const file = await app.room.videos.readyFile(avi);
  check(!!file && file.startsWith(path.join(app.dataDir, 'video')) && file.endsWith('.webm'), 'the WebM is kept in the data folder, not on the drive');
} catch (e) {
  check(false, `unexpected error: ${e.stack || e.message}`);
} finally {
  check(errors.length === 0, `no browser console errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  ws?.close();
  await browser.close();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
