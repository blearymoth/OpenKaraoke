// Multiplex vocal stem: who may have one, the autokaraoke script, the data-folder cache,
// and the headphone preview's choice. Demucs is never started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mixMatrix } from '../shared/vocals.js';
import { vocalStemAllowed, wantsVocalPreview, vocalPreviewTarget } from '../shared/stems.js';
import { SEPARATE_PY, pythonFromLauncher, modelsDirFromLauncher, resolveAutokaraoke, separateArgs, stemModel } from '../server/stems/separate.js';
import { StemJobs, stemTrackDir } from '../server/stems/jobs.js';
import { writePcmWav } from '../server/stems/wav.js';
import { fakeStemRun } from '../server/stems/fake.js';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree, makeZip } from './helpers.js';
import { offlineFetch } from './fake-art.js';
import { setupRoom } from './room-harness.js';

const LAUNCHER = [
  'export AUTOKARAOKE_MODELS="${AUTOKARAOKE_MODELS:-/home/ruutu/Projects/autokaraoke/models}"',
  'exec "/home/ruutu/Projects/autokaraoke/.venv/bin/autokaraoke" "$@"',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(15);
  }
  throw new Error('timed out');
}

test('only a multiplex track gets a vocal stem, and the room mix stays the channel matrix', () => {
  const vocals = { adjustable: true, side: 'L', a: 1, source: 'file' };
  assert.deepEqual(mixMatrix({ vocals, lead: 50 }), [0.25, 0.75, 0.25, 0.75]);
  assert.deepEqual(mixMatrix({ vocals, lead: 0 }), [0, 1, 0, 1]);
  assert.deepEqual(mixMatrix({ channel: 'stereo' }), [1, 0, 0, 1]);
  assert.equal(vocalStemAllowed({ flags: { mpx: true }, vocals }), true);
  assert.equal(vocalStemAllowed({ flags: { mpx: true }, override: 'stereo', vocals }), false, 'the host’s ordinary-stereo correction wins');
  assert.equal(vocalStemAllowed({ override: 'mpxL' }), true);
  assert.equal(vocalStemAllowed({ override: 'mpxR' }), true);
  assert.equal(vocalStemAllowed({ vocals: { ask: true, source: 'file' } }), true);
  assert.equal(vocalStemAllowed({ vocals: { source: 'file' } }), true);
  assert.equal(vocalStemAllowed({ flags: {}, vocals: null }), false);
  assert.equal(vocalStemAllowed({ vocals: { suggest: 'L' } }), false, 'a guess from the sound alone is not separated');
  assert.equal(vocalStemAllowed({ flags: { vocals: true }, vocals: { mixed: true } }), false, 'a Con Voz mix is not separated');
  assert.equal(wantsVocalPreview({ flags: { mpx: true } }), true);
  assert.equal(wantsVocalPreview({ vocals: { lead: 'adjustable' } }), true);
  assert.equal(wantsVocalPreview({ vocals: { lead: 'multiplex' } }), true);
  assert.equal(wantsVocalPreview({ vocals: { lead: 'mixed' }, flags: {} }), false);
  assert.equal(wantsVocalPreview({}), false);
  const id = 'track1';
  assert.equal(vocalPreviewTarget(id, { status: 'ready', url: `/media/${id}/stem/vocal` }).src, `/media/${id}/stem/vocal`);
  assert.match(vocalPreviewTarget(id, { status: 'separating' }).error, /press Vocal again/);
  assert.equal(vocalPreviewTarget(id, { status: 'separating' }).src, '');
  assert.match(vocalPreviewTarget(id, { status: 'failed' }).error, /Could not separate/);
  assert.equal(vocalPreviewTarget(id, { status: 'off' }).src, `/media/${id}/audio`);
  assert.equal(vocalPreviewTarget(id, { status: 'skip' }).src, `/media/${id}/audio`);
  assert.equal(vocalPreviewTarget(id, null).src, '');
});

test('the separator script is autokaraoke’s: configure before separate, then the music and the vocal', async () => {
  const configure = SEPARATE_PY.indexOf('models.configure');
  const imported = SEPARATE_PY.indexOf('from autokaraoke.separate import separate');
  const called = SEPARATE_PY.indexOf('separate(');
  const saved = SEPARATE_PY.indexOf('audio.save_wav');
  assert.ok(configure !== -1 && configure < imported && imported < called && called < saved);
  assert.equal(SEPARATE_PY.split('audio.save_wav').length - 1, 1);
  assert.equal(SEPARATE_PY.includes('backing'), false);
  assert.match(SEPARATE_PY, /STEMS_OK/);
  assert.ok(SEPARATE_PY.indexOf('(inst, music_path), (vocals, vocal_path)') > called, 'the vocal last: it marks the pair done');
  const spec = separateArgs({ python: '/venv/bin/python', src: '/music/a.mp3', vocal: '/data/stems/abcd/vocal.wav', music: '/data/stems/abcd/music.wav' });
  assert.equal(spec.cmd, '/venv/bin/python');
  assert.deepEqual(spec.args, ['-', '/music/a.mp3', '/data/stems/abcd/vocal.wav', '/data/stems/abcd/music.wav', 'htdemucs', 'auto', '1', '-']);
  assert.equal(stemModel({}), 'htdemucs');
  assert.equal(stemModel({ OPENKARAOKE_STEM_MODEL: 'UVR_MDXNET_KARA' }), 'UVR_MDXNET_KARA');
  assert.equal(stemModel({ OPENKARAOKE_STEM_MODEL: 'bad; rm -rf' }), 'htdemucs', 'only a plain name');
  assert.equal(pythonFromLauncher(LAUNCHER), '/home/ruutu/Projects/autokaraoke/.venv/bin/python');
  assert.equal(modelsDirFromLauncher(LAUNCHER), '/home/ruutu/Projects/autokaraoke/models');
  const fromEnv = await resolveAutokaraoke({
    env: { OPENKARAOKE_AUTOKARAOKE_PYTHON: '/custom/python', AUTOKARAOKE_MODELS: '/custom/models' },
    readFile: async () => { throw new Error('should not read the launcher'); },
  });
  assert.deepEqual(fromEnv, { python: '/custom/python', modelsDir: '/custom/models' });
});

test('the cache stays in the data folder and skips a track that is not multiplex', async () => {
  const data = await tmpDir('ok-stems-');
  assert.equal(stemTrackDir(data, '../abcd'), null);
  assert.equal(stemTrackDir(data, 'ab/cd'), null);
  assert.equal(stemTrackDir(data, '..'), null);
  assert.equal(stemTrackDir(data, '....'), null);
  const dir = stemTrackDir(data, 'mpx1');
  assert.equal(dir, path.join(path.resolve(data), 'stems', 'mpx1'));

  let calls = 0;
  const jobs = new StemJobs({
    dataDir: data,
    run: async ({ vocal }) => {
      calls += 1;
      if (calls === 1) throw new Error('demucs failed');
      await writePcmWav(vocal, { seconds: 0.05, hz: 440 });
    },
    allowed: (id) => id === 'mpx1',
    sourceOf: async () => '/library/song.mp3',
  });
  await jobs.ensure('plain');
  assert.equal(jobs.view('plain').status, 'skipped');
  assert.equal(calls, 0);
  await jobs.ensure('mpx1');
  await until(() => jobs.view('mpx1').status === 'failed');
  assert.equal(calls, 1);
  await jobs.ensure('mpx1');
  assert.equal(calls, 1, 'a failure does not run again by itself');
  await jobs.retry('mpx1');
  await until(() => jobs.view('mpx1').status === 'ready');
  assert.equal(calls, 2);
  const st = await fs.stat(jobs.file('mpx1'));
  assert.ok(st.size >= 45);
  assert.equal(jobs.file('nope/../mpx1'), null);
  const moved = jobs.rekey([{ from: 'mpx1', to: 'mpx2' }]);
  assert.equal(moved, 1);
  assert.equal(jobs.view('mpx2').status, 'ready');
  await fs.stat(path.join(data, 'stems', 'mpx2', 'vocal.wav'));
  jobs.close();
});

const ROOM_SONGS = [
  'DJ Hush - Quiet Storm [MX Karaoke] (Multiplex)',
  'Adele - Hello [SF Karaoke] (Con Voz)',
  'Adele - Hello [ZM Karaoke]',
];

test('the host can prepare a multiplex vocal; guests cannot; the TV mix is not a stem', async (t) => {
  const { app, room, connect, guest, req, song } = await setupRoom({}, { songs: ROOM_SONGS, stemRun: fakeStemRun });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  const host = await connect('host');
  await connect('tv');
  const mpxSong = song('quiet storm');
  const mpx = mpxSong.trackIds.map((id) => room.catalog.track(id)).find((tr) => tr.p.flags.mpx);
  const hello = song('hello');
  const voz = hello.trackIds.map((id) => room.catalog.track(id)).find((tr) => tr.p.flags.vocals);
  const plain = hello.trackIds.map((id) => room.catalog.track(id)).find((tr) => !tr.p.flags.vocals && !tr.p.flags.mpx);
  assert.ok(mpx && voz && plain);
  assert.equal(room.stemOk(mpx.id), true);
  assert.equal(room.stemOk(voz.id), false);
  assert.equal(room.stemOk(plain.id), false);

  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'vocal.prepare', { trackId: mpx.id }), /not allowed/);
  assert.deepEqual(await req(host, 'vocal.prepare', { trackId: plain.id }), { status: 'skip' });
  assert.deepEqual(await req(host, 'vocal.prepare', { trackId: voz.id }), { status: 'skip' });
  assert.equal((await fetch(`${base}/media/${plain.id}/stem/vocal`)).status, 404);
  assert.equal((await fetch(`${base}/media/${mpx.id}/stem/backing`)).status, 404);
  assert.equal((await fetch(`${base}/media/${mpx.id}/stem/vocal`)).status, 404, 'not ready yet');

  const first = await req(host, 'vocal.prepare', { trackId: mpx.id });
  assert.ok(first.status === 'separating' || first.status === 'ready', first.status);
  await until(() => room.stems.view(mpx.id).status === 'ready');
  const ready = await req(host, 'vocal.prepare', { trackId: mpx.id });
  assert.deepEqual(ready, { status: 'ready', url: `/media/${mpx.id}/stem/vocal` });
  const wav = await fetch(`${base}${ready.url}`);
  assert.equal(wav.status, 200);
  assert.equal(wav.headers.get('content-type'), 'audio/wav');
  assert.match(wav.headers.get('cache-control'), /no-cache/);
  const body = Buffer.from(await wav.arrayBuffer());
  assert.equal(body.subarray(0, 4).toString(), 'RIFF');
  const vocalPath = room.stems.file(mpx.id);
  assert.ok(vocalPath.startsWith(path.resolve(app.dataDir)));
  assert.equal(path.basename(vocalPath), 'vocal.wav');

  await req(host, 'queue.add', { songId: mpxSong.id, trackId: mpx.id, singerName: 'Ana' });
  assert.equal(room.s.current.trackId, mpx.id);
  const view = room.currentView({ media: true });
  assert.equal(view.media.stems, undefined);
  assert.ok(view.media.audio.endsWith('/audio'));
  assert.equal(room.playerView().stems, null, 'a multiplex track: no separated stems for the room');
  assert.equal(room.playerView().lead, 0, 'the guide level on the TV is unchanged');

  await req(host, 'player.layout', { layout: 'stereo', trackId: mpx.id });
  assert.equal(room.stemOk(mpx.id), false);
  assert.deepEqual(await req(host, 'vocal.prepare', { trackId: mpx.id }), { status: 'skip' });
  assert.equal((await fetch(`${base}/media/${mpx.id}/stem/vocal`)).status, 404, 'a corrected ordinary track is not served');

  const from = mpx.id;
  const to = 'stemmoved01';
  assert.equal(room.migrateTrackIds([{ from, to }]) >= 1, true);
  await fs.stat(path.join(app.dataDir, 'stems', to, 'vocal.wav'));
});

test('a zip’s audio is copied into the data folder, and the music drive is not written', async (t) => {
  const lib = await tmpDir('ok-stem-lib-');
  const cdg = Buffer.alloc(2400);
  const mp3 = Buffer.from('not-a-real-mp3-but-bytes-the-separator-would-read');
  const nasty = Buffer.from('zip-audio-bytes');
  await writeTree(lib, {
    'D/DJ Hush/DJ Hush - Quiet Storm [MX Karaoke] (Multiplex).cdg': cdg,
    'D/DJ Hush/DJ Hush - Quiet Storm [MX Karaoke] (Multiplex).mp3': mp3,
    'C/Cher/Cher - Believe (Multiplex) [SF Karaoke].zip': makeZip([
      { name: 'song.cdg', data: cdg },
      { name: '../../not-on-the-drive.mp3', data: nasty },
    ]),
  });
  const zipFile = path.join(lib, 'C/Cher/Cher - Believe (Multiplex) [SF Karaoke].zip');
  const before = (await fs.stat(zipFile)).mtimeMs;
  const seen = [];
  const dataDir = await tmpDir('ok-stem-data-');
  const app = await createApp({
    dataDir,
    args: { library: [lib] },
    scan: false,
    watch: false,
    fetch: offlineFetch,
    crawl: false,
    stemRun: async ({ src, vocal }) => {
      seen.push(src);
      await writePcmWav(vocal, { seconds: 0.05 });
    },
  });
  t.after(() => app.close());
  await app.library.scan();
  const room = app.room;
  const zip = [...room.catalog.tracks.values()].find((tr) => tr.kind === 'zip');
  const cdgTrack = [...room.catalog.tracks.values()].find((tr) => tr.kind === 'cdg');
  assert.equal(room.stemOk(zip.id), true);
  assert.equal(room.stemOk(cdgTrack.id), true);
  const host = { role: 'host', data: {}, isLocal: true, send() {} };
  await room.request(host, { t: 'queue.add', songId: room.catalog.track(zip.id).songId, trackId: zip.id, singerName: 'Ana' });
  await until(() => room.stems.view(zip.id).status === 'ready');
  await room.request(host, { t: 'queue.add', songId: room.catalog.track(cdgTrack.id).songId, trackId: cdgTrack.id });
  await until(() => room.stems.view(cdgTrack.id).status === 'ready');
  const zipSrc = seen.find((s) => s.includes(`${path.sep}stems${path.sep}`));
  const cdgSrc = seen.find((s) => s.endsWith('.mp3') && !s.includes(`${path.sep}stems${path.sep}`));
  assert.ok(zipSrc, seen.join(' | '));
  assert.equal(path.basename(zipSrc), 'source.mp3');
  assert.ok(path.resolve(zipSrc).startsWith(path.resolve(dataDir, 'stems')));
  assert.equal(zipSrc.includes('not-on-the-drive'), false);
  const left = await fs.readdir(path.dirname(room.stems.file(zip.id)));
  assert.deepEqual(left.filter((n) => n.startsWith('source.')), [], 'the zip copy is removed once the vocal is ready');
  assert.equal((await fs.stat(zipFile)).mtimeMs, before);
  assert.ok(cdgSrc.startsWith(path.resolve(lib)));
  const beside = await fs.readdir(path.dirname(cdgSrc));
  assert.equal(beside.some((n) => n.endsWith('.wav')), false);
});
