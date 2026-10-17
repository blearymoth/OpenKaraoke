// Videos the browser can't play (AVI, MPG, WMV…): converted with ffmpeg (server/video/), the TV
// waiting for the conversion, the media route serving it. A stand-in for ffmpeg in most tests;
// the last test runs the real one when it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { needsConversion, pickEncoders, convertArgs, parseDuration, ffmpegTool } from '../server/video/ffmpeg.js';
import { VideoJobs } from '../server/video/jobs.js';
import { setupRoom } from './room-harness.js';
import { tmpDir } from './helpers.js';

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};
const gate = () => {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
};
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 1)]);

/** A stand-in for ffmpeg: writes a small "WebM", each run held until `release()` when `hold`. */
function fakeTool({ missing = '', hold = false, fail = '' } = {}) {
  const runs = [];
  const gates = [];
  return {
    runs,
    release: () => gates.shift()?.open(),
    async detect() {
      return missing ? { missing } : { version: '6.1', encoders: { video: 'libvpx', audio: 'libopus' } };
    },
    async run({ src, out, onProgress }) {
      runs.push(src);
      onProgress(0.5);
      if (hold) {
        const g = gate();
        gates.push(g);
        await g.p;
      }
      if (fail) throw new Error(fail);
      await fs.writeFile(out, WEBM);
    },
  };
}

test('ffmpeg: which files need it, the encoders, the arguments, the duration', () => {
  for (const f of ['a.avi', 'b.MPG', 'c.mpeg', 'd.wmv', 'e.flv', 'f.vob']) assert.equal(needsConversion(f), true, f);
  for (const f of ['a.mp4', 'b.webm', 'c.mkv', 'd.mov', 'e.m4v', 'f.mp3', 'g.cdg', '', null]) assert.equal(needsConversion(f), false, String(f));
  const list = ` V....D libvpx               libvpx VP8 (codec vp8)\n V....D libvpx-vp9           libvpx VP9 (codec vp9)\n A..X.D opus                 Opus\n A....D libopus              libopus Opus (codec opus)\n`;
  assert.deepEqual(pickEncoders(list), { video: 'libvpx', audio: 'libopus' });
  assert.deepEqual(pickEncoders(' V....D libvpx-vp9  VP9\n A....D libvorbis  Vorbis\n'), { video: 'libvpx-vp9', audio: 'libvorbis' });
  assert.equal(pickEncoders(' V....D libx264  H.264\n A....D aac  AAC\n'), null, 'no WebM encoders: none');
  assert.equal(pickEncoders(''), null);
  const src = '/media/u/Karaoke/A/Abba - Waterloo; rm -rf ~ [SF].avi';
  const args = convertArgs({ src, out: '/data/video/x.webm.part' });
  assert.equal(args[args.indexOf('-i') + 1], src, 'the file name is one argument, as it is');
  assert.equal(args.at(-1), '/data/video/x.webm.part');
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'webm']);
  assert.ok(args.includes('libvpx') && args.includes('libopus') && args.includes('-nostdin'));
  assert.ok(convertArgs({ src, out: 'o', video: 'libvpx-vp9', audio: 'libvorbis' }).includes('-row-mt'));
  assert.equal(parseDuration('  Duration: 00:03:45.50, start: 0.000000, bitrate: 1411 kb/s'), 225.5);
  assert.equal(parseDuration('Duration: 01:00:00.00'), 3600);
  assert.equal(parseDuration('no duration here'), 0);
});

test('video jobs: one at a time, the song on stage first; ready files served; no ffmpeg says so', async () => {
  const dataDir = await tmpDir('ok-video-');
  const tool = fakeTool({ hold: true });
  const changes = [];
  const jobs = new VideoJobs({ dataDir, tool, sourceOf: (t) => `/lib/${t.video}`, onChange: (id, v) => changes.push([id, v.status]) });
  const track = (id, video) => ({ id, kind: 'video', video, size: 1000, mtime: 5 });
  const a = track('aaaa1', 'A.avi');
  const b = track('bbbb2', 'B.mpg');
  const c = track('cccc3', 'C.wmv');
  await jobs.ensure(a);
  await jobs.ensure(b);
  await jobs.ensure(c, { urgent: true });
  await jobs.ensure(track('dddd4', 'D.mp4')); // nothing to do
  await until(() => tool.runs.length === 1);
  assert.equal(jobs.view(a).status, 'converting');
  assert.equal(jobs.view(a).progress, 0.5);
  assert.deepEqual([jobs.view(b).status, jobs.view(c).status], ['queued', 'queued']);
  assert.equal(await jobs.readyFile(a), null);
  tool.release();
  await until(() => tool.runs.length === 2);
  assert.equal(tool.runs[1], '/lib/C.wmv', 'the urgent one went before the one queued earlier');
  assert.equal(jobs.view(a).status, 'ready');
  const file = await jobs.readyFile(a);
  assert.ok(file && file.startsWith(path.join(dataDir, 'video')));
  assert.deepEqual(await fs.readFile(file), WEBM);
  tool.release();
  await until(() => tool.runs.length === 3);
  tool.release();
  await until(() => jobs.view(b).status === 'ready');
  assert.equal(jobs.view(track('dddd4', 'D.mp4')).status, 'idle');
  assert.ok(changes.some(([id, st]) => id === 'aaaa1' && st === 'ready'));
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'video'))).filter((n) => n.endsWith('.part')), [], 'no half-written files');

  // The same file changed (another size): converted again.
  const a2 = { ...a, size: 2000 };
  assert.equal(jobs.view(a2).status, 'idle');
  assert.equal(await jobs.readyFile(a2), null);
  jobs.close();

  const none = new VideoJobs({ dataDir, tool: fakeTool({ missing: 'ffmpeg is not installed' }), sourceOf: () => '/x' });
  await none.ensure(a2);
  assert.equal(none.view(a2).status, 'unavailable');
  assert.match(none.view(a2).error, /needs ffmpeg.*dnf install ffmpeg-free/);
  assert.deepEqual(none.status(), { ready: false, missing: 'ffmpeg is not installed', hint: none.status().hint });
  const failing = new VideoJobs({ dataDir: await tmpDir('ok-video-'), tool: fakeTool({ fail: 'Invalid data found when processing input' }), sourceOf: () => '/x' });
  await failing.ensure(a);
  await until(() => failing.view(a).status === 'failed');
  assert.match(failing.view(a).error, /could not be converted \(Invalid data/);
});

test('video jobs: the folder is kept under its size, the least recently played go first', async () => {
  const dataDir = await tmpDir('ok-video-');
  const tool = fakeTool();
  const jobs = new VideoJobs({ dataDir, tool, sourceOf: (t) => `/lib/${t.video}`, maxBytes: WEBM.length * 2 + 10 });
  const ts = ['aaaa1', 'bbbb2', 'cccc3'].map((id, i) => ({ id, kind: 'video', video: `${i}.avi`, size: 1, mtime: 1 }));
  await jobs.ensure(ts[0]);
  await until(() => jobs.view(ts[0]).status === 'ready');
  await jobs.ensure(ts[1]);
  await until(() => jobs.view(ts[1]).status === 'ready');
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(jobs.file(ts[1]), old, old); // played longest ago
  await jobs.readyFile(ts[0]); // just played
  await jobs.ensure(ts[2]);
  await until(() => jobs.view(ts[2]).status === 'ready');
  await until(async () => !(await jobs.readyFile(ts[1])));
  assert.ok(await jobs.readyFile(ts[0]), 'the one played lately stays');
  assert.ok(await jobs.readyFile(ts[2]), 'the new one stays');
  assert.equal(jobs.view(ts[1]).status, 'idle', 'the removed one would be converted again');
});

test('room: an AVI on stage waits on the TV until it is converted, then the TV loads it', async (t) => {
  const tool = fakeTool({ hold: true });
  const { app, connect, req, flush, s } = await setupRoom({}, {
    songs: ['Adele - Hello [SF Karaoke]'],
    videoTool: tool,
    files: { 'T/Toto/Toto - Africa [KV Karaoke].avi': 5000, 'B/Blur/Blur - Song 2 [KV Karaoke].mp4': 5000 },
  });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const host = await connect('host');
  const tv = await connect('tv');
  const africa = app.library.catalog.search('africa').items[0];
  const avi = [...app.library.catalog.tracks.values()].find((x) => x.video?.endsWith('.avi'));
  await req(host, 'queue.add', { songId: africa.id, singerName: 'Ana' });
  flush();
  await until(() => tool.runs.length === 1); // queued: converted ahead
  const hostView = host.inbox.filter((m) => m.t === 'state').at(-1).state;
  assert.deepEqual([hostView.video.ready, hostView.video.version, hostView.video.tracks], [true, '6.1', 1]);
  const base = `http://127.0.0.1:${app.port}`;
  const early = await fetch(`${base}/media/${avi.id}/video`);
  assert.equal(early.status, 409, 'not converted yet');

  await req(host, 'player.play');
  flush();
  const tvState = () => tv.inbox.filter((m) => m.t === 'state').at(-1).state;
  const waiting = tvState();
  assert.equal(waiting.current.media.video, null);
  assert.equal(waiting.current.media.converting.status, 'converting');
  assert.equal(waiting.current.media.converting.progress, 0.5);
  const reload = waiting.player.reload;
  assert.equal(s().player.state, 'intro', 'the song waits (no tv.ready without a file)');

  tool.release();
  await until(() => app.room.videos.view(avi).status === 'ready');
  flush();
  const ready = tvState();
  assert.equal(ready.current.media.video, `/media/${avi.id}/video`);
  assert.ok(ready.player.reload > reload, 'the TV is told to load it');
  const res = await fetch(`${base}/media/${avi.id}/video`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/webm');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), WEBM);
  const part = await fetch(`${base}/media/${avi.id}/video`, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206, 'byte ranges: the TV can seek');
  await req(tv, 'tv.ready', { entryId: s().current.id, dur: 200 });
  assert.equal(s().player.state, 'playing');

  // An MP4 needs nothing: its URL straight away, the file itself.
  const mp4 = [...app.library.catalog.tracks.values()].find((x) => x.video?.endsWith('.mp4'));
  assert.deepEqual(app.room.mediaFor(mp4), { kind: 'video', video: `/media/${mp4.id}/video` });
});

test('room: without ffmpeg an AVI on stage fails on the TV with what to install', async (t) => {
  const { app, connect, req, flush } = await setupRoom({}, {
    songs: ['Adele - Hello [SF Karaoke]'],
    videoTool: fakeTool({ missing: 'ffmpeg is not installed' }),
    files: { 'T/Toto/Toto - Africa [KV Karaoke].avi': 5000 },
  });
  t.after(() => app.close());
  const host = await connect('host');
  const tv = await connect('tv');
  await req(host, 'queue.add', { songId: app.library.catalog.search('africa').items[0].id, singerName: 'Ana' });
  await req(host, 'player.play');
  const avi = [...app.library.catalog.tracks.values()].find((x) => x.video?.endsWith('.avi'));
  await until(() => app.room.videos.view(avi).status === 'unavailable');
  flush();
  const media = tv.inbox.filter((m) => m.t === 'state').at(-1).state.current.media;
  assert.equal(media.converting.status, 'unavailable');
  assert.match(media.converting.error, /needs ffmpeg/);
  const hv = host.inbox.filter((m) => m.t === 'state').at(-1).state.video;
  assert.equal(hv.ready, false);
  assert.match(hv.hint, /dnf install ffmpeg-free/);
});

let ffmpegHere = false;
try {
  execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
  ffmpegHere = true;
} catch { /* not installed: the test below says so */ }

test('the real ffmpeg converts an AVI to WebM, with progress', { skip: !ffmpegHere && 'ffmpeg is not installed here' }, async () => {
  const dir = await tmpDir('ok-ffmpeg-');
  const src = path.join(dir, 'Toto - Africa [KV Karaoke].avi');
  // 2 s of test picture and a tone, in an AVI (MPEG-4 + MP3/PCM: what old karaoke videos look like).
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', src]);
  const tool = ffmpegTool();
  const info = await tool.detect();
  assert.ok(info.version && info.encoders, JSON.stringify(info));
  const out = path.join(dir, 'out.webm.part');
  const seen = [];
  await tool.run({ src, out, onProgress: (f) => seen.push(f) });
  const head = (await fs.readFile(out)).subarray(0, 4);
  assert.deepEqual([...head], [0x1a, 0x45, 0xdf, 0xa3], 'a Matroska/WebM file');
  assert.ok(seen.length > 0 && seen.every((f) => f > 0 && f < 1), `progress ${seen.join(', ')}`);
  await assert.rejects(tool.run({ src: path.join(dir, 'missing.avi'), out: path.join(dir, 'x.webm') }), /No such file|missing\.avi/);
});
