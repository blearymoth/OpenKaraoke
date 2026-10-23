// The Karaoke maker (server/maker/, PLAN §31): autokaraoke's command lines and output, finding
// it in ~/Projects/autokaraoke, the heavy-job lane, and making songs from Settings with the
// stand-in tool — from a file, an upload or a link, into the library; waiting while someone
// sings on a PC without a graphics card; cancel; a failure; installing; host only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupRoom } from './room-harness.js';
import { tmpDir } from './helpers.js';
import {
  makeArgs, renderArgs, setupArgs, installArgs, splitProgress, readMakeLine, readSetupCheck, gpuNameOf,
  rootFromLauncher, locateAutokaraoke, guessNames, cleanUrl, isSongFile,
} from '../server/maker/autokaraoke.js';
import { fakeAutokaraoke } from '../server/maker/fake.js';
import { Lane } from '../server/util/lane.js';
import { writePcmWav } from '../server/stems/wav.js';
import { readTiming } from '../shared/timing.js';

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('maker: autokaraoke’s command lines — options first, the song after "--", values checked', () => {
  const args = makeArgs({ song: '/music/-odd name.mp3', out: '/home/u/Karaoke', lyricsFile: '/tmp/l.txt', artist: ' Adele\n', title: 'Hello', language: 'en', theme: 'blue' });
  assert.deepEqual(args.slice(0, 3), ['-m', 'autokaraoke', 'make']);
  assert.deepEqual(args.slice(-2), ['--', '/music/-odd name.mp3'], 'the song is never read as an option');
  assert.ok(args.includes('--lyrics') && args.includes('/tmp/l.txt'));
  assert.ok(args.includes('--retime'), 'typed lyrics: never an old timing.json instead');
  assert.ok(!makeArgs({ song: '/a.mp3', out: '/k' }).includes('--retime'));
  const look = makeArgs({ song: '/a.mp3', out: '/k', lyricsSources: ['sidecar', 'lrclib'], keepStems: true });
  assert.equal(look[look.indexOf('--lyrics-sources') + 1], 'sidecar,lrclib');
  assert.ok(look.includes('--keep-stems'));
  assert.ok(!makeArgs({ song: '/a.mp3', out: '/k', lyricsFile: '/l.txt', lyricsSources: ['lrclib'] }).includes('--lyrics-sources'), 'typed lyrics win over a lookup');
  assert.throws(() => makeArgs({ song: '/a.mp3', out: '/k', lyricsSources: ['evil.com'] }), /source/);
  assert.equal(args[args.indexOf('--artist') + 1], 'Adele', 'one line, trimmed');
  assert.equal(args[args.indexOf('--theme') + 1], 'blue');
  assert.deepEqual(makeArgs({ song: 'https://youtu.be/abc', out: '/k' }).slice(-2), ['--', 'https://youtu.be/abc/'.replace(/\/$/, '')]);
  assert.throws(() => makeArgs({ song: 'relative.mp3', out: '/k' }), /file path or a link/);
  assert.throws(() => makeArgs({ song: '/a.mp3', out: 'k' }), /absolute/);
  assert.throws(() => makeArgs({ song: '/a.mp3', out: '/k', theme: 'red' }), /colours/);
  assert.throws(() => makeArgs({ song: '/a.mp3', out: '/k', language: 'en; rm' }), /language/);
  assert.throws(() => makeArgs({ song: '/a.mp3', out: '/k', whisperModel: 'huge' }), /model/);
  assert.deepEqual(renderArgs({ timing: '/k/a.timing.json', audio: '/k/a.mp3', output: '/k/a.cdg' }).slice(-2), ['--', '/k/a.timing.json']);
  assert.throws(() => renderArgs({ timing: 'a.json', audio: '/a', output: '/b' }));
  assert.ok(setupArgs({ check: true }).includes('--check'));
  assert.deepEqual(installArgs('/p/install.sh', { gpu: true, youtube: false }), ['/p/install.sh', '--gpu', '--no-youtube']);
  assert.equal(cleanUrl('javascript:alert(1)'), '');
  assert.equal(cleanUrl('https://www.youtube.com/watch?v=x y'), '');
  assert.ok(cleanUrl('https://www.youtube.com/watch?v=abc'));
  assert.ok(isSongFile('a.FLAC') && !isSongFile('a.exe') && !isSongFile('mp3'));
  assert.deepEqual(guessNames('/m/ABBA - Waterloo.mp3'), { artist: 'ABBA', title: 'Waterloo' });
});

test('maker: progress from autokaraoke’s own output', () => {
  let r = splitProgress('', 'Separating vocals with htdemucs on cpu...\n 12%|█   | 3/25\r 40%|████ | 10/25\rInstr');
  assert.deepEqual(r.lines, ['Separating vocals with htdemucs on cpu...']);
  assert.equal(r.status, '40%|████ | 10/25');
  r = splitProgress(r.pending, 'umental: /k/A - B.mp3\n');
  assert.deepEqual(r.lines, ['Instrumental: /k/A - B.mp3']);
  const steps = [
    ['[download]  45.3% of 4.12MiB', { stage: 'download', percent: 45.3 }],
    ['Adele - Hello  (296s)', { duration: 296 }],
    ['Separating vocals with htdemucs on cuda...', { stage: 'separate', percent: 0 }],
    ['Using cached stems from /k/x.work', { stage: 'separate', percent: 100 }],
    ['Instrumental: /k/Adele - Hello.mp3', { stage: 'timing', percent: 0, mp3: '/k/Adele - Hello.mp3' }],
    ['Aligning 312 words of lyrics to the vocals...', { stage: 'timing' }],
    ['Timing: /k/Adele - Hello.timing.json', { stage: 'cdg', percent: 0, timing: '/k/Adele - Hello.timing.json' }],
    ['Done: Adele - Hello.mp3 + Adele - Hello.cdg', { stage: 'done', percent: 100, mp3Name: 'Adele - Hello.mp3', cdgName: 'Adele - Hello.cdg' }],
  ];
  for (const [line, want] of steps) assert.deepEqual(readMakeLine(line), want, line);
  assert.deepEqual(readMakeLine(' 63%|██████▎   | 17.4/27.6 [00:20<00:12]', { status: true }), { percent: 63 });
});

test('maker: the setup check, the graphics card, and where autokaraoke is', async () => {
  const check = readSetupCheck(`Models folder: /home/u/Projects/autokaraoke/models
  Demucs  htdemucs              80 MB   ready
  Whisper medium               1.5 GB   ready
  models total               1.6 GB
Software (Python environment /home/u/Projects/autokaraoke/.venv): 5.9 GB
Offline: ready. \`make\` with these models no longer needs the internet (only YouTube URLs do).`);
  assert.deepEqual(check.models, [{ kind: 'demucs', name: 'htdemucs', size: '80 MB', ready: true }, { kind: 'whisper', name: 'medium', size: '1.5 GB', ready: true }]);
  assert.equal(check.total, '1.6 GB');
  assert.equal(check.software, '5.9 GB');
  assert.equal(check.offline, true);
  assert.equal(readSetupCheck('  Whisper large-v3                    MISSING\nOffline: NOT ready.').models[0].ready, false);
  assert.equal(gpuNameOf('GPU 0: NVIDIA GeForce RTX 3080 (UUID: GPU-1234)\n'), 'NVIDIA GeForce RTX 3080');

  const home = await tmpDir('ok-home-');
  let where = await locateAutokaraoke({ env: {}, homedir: home });
  assert.equal(where.root, path.join(home, 'Projects', 'autokaraoke'), 'by default: ~/Projects/autokaraoke');
  assert.equal(where.python, path.join(home, 'Projects', 'autokaraoke', '.venv', 'bin', 'python'));
  assert.equal(where.hasRoot, false);
  await fs.mkdir(path.join(home, 'Projects', 'autokaraoke', 'autokaraoke'), { recursive: true });
  await fs.writeFile(path.join(home, 'Projects', 'autokaraoke', 'autokaraoke', 'cli.py'), '');
  await fs.writeFile(path.join(home, 'Projects', 'autokaraoke', 'install.sh'), '');
  where = await locateAutokaraoke({ env: {}, homedir: home });
  assert.ok(where.hasRoot && where.installer && !where.installed, 'the folder is there, not installed yet');
  // The launcher an install wrote names the folder it runs from.
  const elsewhere = path.join(home, 'src', 'SongGetter');
  await fs.mkdir(path.join(home, '.local', 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, '.local', 'bin', 'autokaraoke'), `#!/bin/sh\nexport AUTOKARAOKE_MODELS="\${AUTOKARAOKE_MODELS:-${elsewhere}/models}"\nexec "${elsewhere}/.venv/bin/autokaraoke" "$@"\n`);
  assert.equal(rootFromLauncher(await fs.readFile(path.join(home, '.local', 'bin', 'autokaraoke'), 'utf8')), elsewhere);
  where = await locateAutokaraoke({ env: {}, homedir: home });
  assert.equal(where.root, elsewhere);
  assert.equal(where.modelsDir, `${elsewhere}/models`);
});

test('maker: one heavy job at a time, the song on now first', async () => {
  const lane = new Lane();
  const order = [];
  const first = await lane.acquire('maker');
  const a = lane.acquire('maker').then((rel) => { order.push('maker 2'); rel(); });
  const b = lane.acquire('stems', { urgent: true }).then((rel) => { order.push('stems'); rel(); });
  assert.equal(lane.holder, 'maker');
  first();
  first(); // (twice is once)
  await Promise.all([a, b]);
  assert.deepEqual(order, ['stems', 'maker 2']);
  assert.equal(lane.busy, false);
});

test('maker: a song from a file becomes a song in the library; links; waiting while someone sings; cancel; a failure', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.2, songSeconds: 20 });
  const { app, room, connect, guest, req, song } = await setupRoom({}, { makerTool: tool });
  t.after(() => app.close());
  const host = await connect('host');
  const ana = await guest('Ana');
  await until(() => room.maker.checks);
  const view = room.hostView().maker;
  assert.ok(view.enabled && view.where.installed && view.checks.setup.offline);
  assert.equal(view.waitsDuringSongs, true, 'no graphics card: jobs wait while someone sings');

  const out = path.join(app.library.paths[0], 'OpenKaraoke Maker');
  assert.equal(view.out, out, 'by default: a folder inside the (first) library folder');
  const src = path.join(await tmpDir('ok-src-'), 'Pixel Band - Night Drive.mp3');
  await writePcmWav(src, { hz: 220, seconds: 2 });
  app.settings.update({ maker: { out: await tmpDir('ok-elsewhere-') } });
  assert.match(room.hostView().maker.outProblem, /inside one of your karaoke folders/);
  await assert.rejects(req(host, 'maker.make', { song: { path: src } }), /inside one of your karaoke folders/, 'never outside the library');
  app.settings.update({ maker: { out: '' } });
  await assert.rejects(req(ana, 'maker.make', { song: { path: src } }), /not allowed/);
  await assert.rejects(req(host, 'maker.make', { song: { path: 'relative.mp3' } }), /song file/);
  await assert.rejects(req(host, 'maker.make', { song: { url: 'ftp://x' } }), /YouTube link/);
  await assert.rejects(req(host, 'maker.make', { song: { url: 'https://vimeo.com/123456' } }), /Only YouTube/);
  await assert.rejects(req(host, 'maker.make', { song: { url: 'https://youtu.be/abc' } }), /video link/);

  const job = await req(host, 'maker.make', { song: { path: src }, lyrics: 'Driving through the night\nNeon on the road' });
  assert.equal(job.artist, 'Pixel Band', 'artist and title from the file name');
  assert.equal(job.title, 'Night Drive');
  await until(() => room.maker.jobs[0].result?.trackId);
  const done = room.hostView().maker.jobs[0];
  assert.equal(done.status, 'done');
  assert.equal(done.stage, 'done');
  assert.ok(done.lines.some((l) => /^Aligning 8 words/.test(l)), 'the lyrics went to autokaraoke');
  assert.deepEqual(app.library.paths.length, 1, 'no new library folder: the song is inside the library');
  await fs.stat(path.join(out, 'Pixel Band - Night Drive.cdg'));
  const made = song('night drive');
  assert.equal(made?.id, done.result.songId);
  assert.ok(made.trackIds.includes(done.result.trackId));
  const timing = readTiming(JSON.parse(await fs.readFile(done.result.timing, 'utf8')));
  assert.deepEqual(timing.lines.map((l) => l.words.map((w) => w.text).join(' ')), ['Driving through the night', 'Neon on the road']);
  await req(host, 'queue.add', { songId: made.id, singerName: 'Bo' });
  assert.equal(room.s.queue.at(-1)?.songId ?? room.s.current?.songId, made.id, 'it can be queued');

  // While someone sings, on a PC without a graphics card: it waits; "Start now" starts it.
  await req(host, 'player.stop').catch(() => {});
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Cy' });
  await req(host, 'player.play');
  const tv = await connect('tv');
  await req(tv, 'tv.status', { entryId: room.s.current.id, state: 'playing', pos: 1 }).catch(() => {});
  room.s.player.state = 'playing';
  const linkJob = await req(host, 'maker.make', { song: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=4' }, artist: 'Web', title: 'Tune' });
  await until(() => room.maker.jobs.find((j) => j.id === linkJob.id).status === 'waiting');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(room.maker.jobs.find((j) => j.id === linkJob.id).status, 'waiting', 'still waiting');
  await req(host, 'maker.now', { id: linkJob.id });
  await until(() => room.maker.jobs.find((j) => j.id === linkJob.id).finishedAt);
  const linked = room.hostView().maker.jobs.find((j) => j.id === linkJob.id);
  assert.equal(linked.status, 'done');
  assert.ok(linked.lines.some((l) => l.startsWith('[download]')), 'a link is downloaded first');
  assert.equal(tool.state.runs.find((r) => r.opts.song?.startsWith('https:')).opts.song, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'the link reduced to the video');

  // With "make songs while someone sings" on, nothing waits.
  app.settings.update({ maker: { duringSongs: true } });
  tool.state.seconds = 3;
  const slow = await req(host, 'maker.make', { song: { path: src }, title: 'Slow One' });
  await until(() => room.maker.jobs.find((j) => j.id === slow.id).status === 'running');
  await req(host, 'maker.cancel', { id: slow.id });
  await until(() => room.maker.jobs.find((j) => j.id === slow.id).finishedAt);
  assert.equal(room.maker.jobs.find((j) => j.id === slow.id).status, 'cancelled');
  await assert.rejects(req(host, 'maker.dismiss', { id: room.maker.jobs.find((j) => !j.finishedAt)?.id || 'nope' }), /gone|Cancel/);
  await req(host, 'maker.dismiss', { id: slow.id });
  assert.ok(!room.maker.jobs.some((j) => j.id === slow.id));

  tool.state.seconds = 0.2;
  tool.state.fail = 'make';
  const bad = await req(host, 'maker.make', { song: { path: src }, title: 'Broken' });
  await until(() => room.maker.jobs.find((j) => j.id === bad.id).finishedAt);
  const failed = room.hostView().maker.jobs.find((j) => j.id === bad.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /alignment failed/, 'the reason autokaraoke gave');
});

test('maker: uploads (host only, song files only), then a song from the upload', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.2 });
  const { app, room, connect, req } = await setupRoom({}, { makerTool: tool });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  const host = await connect('host');
  await until(() => room.maker.where);
  const send = (name, body, headers = {}) => fetch(`${base}/api/maker/upload`, { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', ...headers } });
  assert.equal((await send('virus.exe', 'MZ')).status, 400);
  assert.equal((await send('a.mp3', 'x', { origin: 'http://evil.example' })).status, 403, 'not from other web sites');
  const wav = path.join(await tmpDir('ok-up-'), 'x.wav');
  await writePcmWav(wav, { seconds: 1 });
  const res = await send('Tiny Band - Small Song.wav', await fs.readFile(wav));
  assert.equal(res.status, 200);
  const { upload } = await res.json();
  assert.deepEqual([upload.artist, upload.title], ['Tiny Band', 'Small Song']);
  const job = await req(host, 'maker.make', { song: { upload: upload.id } });
  assert.equal(job.kind, 'upload');
  await until(() => room.maker.jobs[0].finishedAt);
  assert.equal(room.maker.jobs[0].status, 'done');
  assert.equal(room.maker.uploads.size, 0, 'the upload is deleted once the song is made');
  await assert.rejects(req(host, 'maker.make', { song: { upload: upload.id } }), /Choose a song/, 'used up');
});

test('maker: not installed — install it from the page, then download the models', async (t) => {
  const tool = fakeAutokaraoke({ installed: false, models: false, seconds: 0.2, gpu: 'NVIDIA GeForce RTX 3060' });
  const { app, room, connect, req, guest } = await setupRoom({}, { makerTool: tool });
  t.after(() => app.close());
  const host = await connect('host');
  await until(() => room.maker.checks);
  assert.equal(room.hostView().maker.where.installed, false);
  assert.equal(room.hostView().maker.waitsDuringSongs, false, 'a graphics card: jobs run any time');
  await assert.rejects(req(host, 'maker.make', { song: { url: 'https://x.test/a' }, title: 'A' }), /Install autokaraoke first/);
  await assert.rejects(req(host, 'maker.setup', {}), /Install autokaraoke first/);
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'maker.install', { gpu: true }), /not allowed/);
  await req(host, 'maker.install', { gpu: true, youtube: false });
  await assert.rejects(req(host, 'maker.install', {}), /Wait for the install/);
  await until(() => room.maker.task?.status === 'done' && room.maker.checks?.version);
  assert.deepEqual(tool.state.runs.find((r) => r.kind === 'install').opts, { gpu: true, youtube: false });
  const v = room.hostView().maker;
  assert.ok(v.where.installed && v.checks.setup.offline, 'installed, models there');
  assert.ok(v.task.lines.some((l) => /Installing PyTorch/.test(l)));
});

test('maker: the lyrics’ authority (typed, else a lyrics service, else Whisper) and the vocals kept for §30', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.1 });
  const { app, room, connect, req } = await setupRoom({}, { makerTool: tool });
  t.after(() => app.close());
  const host = await connect('host');
  await until(() => room.maker.checks?.features);
  assert.equal(room.hostView().maker.lookup, true, 'this autokaraoke can look lyrics up');
  const src = path.join(await tmpDir('ok-src-'), 'Pixel Band - Night Drive.mp3');
  await writePcmWav(src, { hz: 220, seconds: 2 });
  const make = async (input) => {
    const job = await req(host, 'maker.make', { song: { path: src }, ...input });
    await until(() => room.maker.jobs.find((j) => j.id === job.id).result?.scanning === false);
    return { view: room.hostView().maker.jobs.find((j) => j.id === job.id), run: tool.state.runs.filter((r) => r.kind === 'make').at(-1) };
  };

  // Nothing typed: looked up (LRCLIB, the default source).
  let { view, run } = await make({ title: 'Looked Up' });
  assert.deepEqual(run.opts.lyricsSources, ['lrclib']);
  assert.equal(view.lyricsFrom, 'LRCLIB');
  // The vocals are the track's stems now: Separated vocals is ready, nothing left in the library.
  const id = view.result.trackId;
  assert.equal(view.result.vocals, true);
  await until(() => room.stems.view(id).status === 'ready');
  assert.ok(room.stemAsked(id) && room.stemsFor(id), 'Separated vocals (§30) at once');
  await fs.stat(room.stems.file(id, 'vocal.wav'));
  await fs.stat(room.stems.file(id, 'music.wav'));
  assert.equal(await fs.stat(view.result.mp3.replace(/\.mp3$/, '.work')).then(() => true, () => false), false, 'no .work folder left in the library');
  assert.equal((await room.lyrics.open(id)).vocal, `/media/${id}/stem/vocal`, 'the lyrics editor’s guide vocal');

  // Typed: those, retimed, no lookup.
  ({ view, run } = await make({ title: 'Typed', lyrics: 'My own words here' }));
  assert.deepEqual(run.opts.lyricsSources, []);
  assert.equal(view.lyricsFrom, 'typed');
  // Nothing found: Whisper.
  tool.state.lookupHit = '';
  ({ view } = await make({ title: 'Not Found' }));
  assert.equal(view.lyricsFrom, 'whisper');
  // Lookup off, or an autokaraoke without it: straight to Whisper.
  app.settings.update({ maker: { lookupLyrics: false } });
  ({ run } = await make({ title: 'Off' }));
  assert.deepEqual(run.opts.lyricsSources, []);
  app.settings.update({ maker: { lookupLyrics: true, lyricsSources: ['netease', 'evil', 'lrclib'] } });
  assert.deepEqual(app.settings.get('maker.lyricsSources'), ['netease', 'lrclib'], 'only sources autokaraoke knows');
  tool.state.lookup = false;
  await room.maker.check();
  assert.equal(room.hostView().maker.lookup, false);
  ({ run } = await make({ title: 'Old Copy' }));
  assert.deepEqual(run.opts.lyricsSources, [], 'never a flag this copy doesn’t know');
});
