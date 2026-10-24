// The Karaoke maker's later additions (PLAN §31.13–§31.15): make's "Times:" line and this PC's
// measured speed ("about N minutes"), re-timing a stretch of the lyrics with Whisper (`retime`,
// the stand-in here) from the lyrics editor, and the timing.json "render" field kept through an edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupRoom } from './room-harness.js';
import { tmpDir } from './helpers.js';
import { readMakeLine, readTimes, retimeArgs } from '../server/maker/autokaraoke.js';
import { Speed, stageKey } from '../server/maker/speed.js';
import { fakeAutokaraoke, fakeTiming, cdgFromTiming } from '../server/maker/fake.js';
import { writePcmWav } from '../server/stems/wav.js';
import { readTiming, timingJson, renderOptions } from '../shared/timing.js';
import { aboutMinutes } from '../shared/maker.js';

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('maker: the Times line, and retime’s command line', () => {
  assert.deepEqual(readTimes('Times: download 12s, separate 95s, mp3 3s, timing 40s, cdg 2s'), { download: 12, separate: 95, mp3: 3, timing: 40, cdg: 2 });
  assert.deepEqual(readTimes('Times: separate cached, mp3 1s, timing cached, cdg 0s'), { separate: null, mp3: 1, timing: null, cdg: 0 });
  assert.equal(readTimes('Timing: /x/a.timing.json'), null);
  assert.deepEqual(readMakeLine('Times: separate 6s, mp3 1s, timing 4s, cdg 1s'), { times: { separate: 6, mp3: 1, timing: 4, cdg: 1 } });
  assert.deepEqual(readMakeLine('Pixel Band - Night Drive  (213s)'), { duration: 213 });

  assert.deepEqual(retimeArgs({ timing: '/d/t.json', vocals: '/d/v.wav', output: '/d/o.json', from: 12.34567, to: 20, language: 'fi', whisperModel: 'turbo' }),
    ['-m', 'autokaraoke', 'retime', '--vocals', '/d/v.wav', '--from', '12.346', '--to', '20', '--whisper-model', 'turbo', '-O', '/d/o.json', '--language', 'fi', '--', '/d/t.json']);
  assert.throws(() => retimeArgs({ timing: 't.json', vocals: '/v', output: '/o', from: 1, to: 2 }), /absolute/);
  assert.throws(() => retimeArgs({ timing: '/t', vocals: '/v', output: '/o', from: 5, to: 2 }), /stretch/);
  assert.throws(() => retimeArgs({ timing: '/t', vocals: '/v', output: '/o', from: 1, to: 2, language: 'x; rm' }), /language/);
  assert.throws(() => retimeArgs({ timing: '/t', vocals: '/v', output: '/o', from: 1, to: 2, whisperModel: 'huge' }), /model/);
});

test('maker: this PC’s speed — learned per stage and model, kept, and "about N minutes"', async () => {
  const file = path.join(await tmpDir('ok-speed-'), 'maker', 'speed.json');
  const speed = new Speed({ file });
  const models = { demucsModel: 'htdemucs', whisperModel: 'medium' };
  assert.equal(speed.estimate({ duration: 240, ...models }), null, 'nothing until a song was made here');
  assert.equal(speed.record({ times: { separate: 120, mp3: 4, timing: 60, cdg: 4 }, duration: 240, ...models }), true);
  assert.equal(speed.estimate({ duration: 240, ...models }), 188, '4 minutes: the same again');
  assert.equal(speed.estimate({ duration: 120, ...models }), 94, 'half the song, half the time');
  assert.equal(speed.estimate({ duration: 240, demucsModel: 'htdemucs', whisperModel: 'large-v3' }), null, 'another lyric timer: not measured yet');
  // A cached stage teaches nothing; a link adds its download once one was timed.
  speed.record({ times: { download: 8, separate: null, mp3: 4, timing: null, cdg: 4 }, duration: 240, ...models });
  assert.deepEqual(speed.rates[stageKey('separate', models)], [30]);
  assert.equal(speed.estimate({ duration: 240, url: true, ...models }), 196);
  assert.equal(speed.record({ times: { separate: 9 }, duration: 3 }), false, 'a few seconds of song: no rate');
  await speed.save();
  const again = await new Speed({ file }).load();
  assert.equal(again.estimate({ duration: 240, ...models }), 188, 'kept in data/maker/speed.json');
  await fs.writeFile(file, '{"rates":{"separate:htdemucs":[1e9, "x", 30],"evil key":[1]}}');
  const odd = await new Speed({ file }).load();
  assert.deepEqual(Object.keys(odd.rates), ['separate:htdemucs']);
  assert.deepEqual(odd.rates['separate:htdemucs'], [30]);
  assert.equal(aboutMinutes(188), 'about 3 minutes');
  assert.equal(aboutMinutes(70), 'about 1 minute');
  assert.equal(aboutMinutes(20), 'under a minute');
});

test('maker: a make teaches the speed; the next job says "about N minutes"', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.2, songSeconds: 120 });
  const { app, room, connect, req } = await setupRoom({}, { makerTool: tool });
  t.after(() => app.close());
  const host = await connect('host');
  await until(() => room.maker.checks);
  assert.equal(room.hostView().maker.typical, null, 'not measured yet');
  const src = path.join(await tmpDir('ok-src-'), 'Pixel Band - Night Drive.mp3');
  await writePcmWav(src, { hz: 220, seconds: 2 });
  const first = await req(host, 'maker.make', { song: { path: src }, lyrics: 'Driving through the night' });
  assert.equal(first.estimate, null);
  await until(() => room.maker.jobs[0].status === 'done');
  const done = room.hostView().maker.jobs[0];
  assert.deepEqual(done.times, { separate: 6, mp3: 1, timing: 4, cdg: 1 });
  assert.equal(done.duration, 120);
  // (the speed file is written just after the job is done)
  const speedFile = async (key) => {
    let d = null;
    await until(async () => (d = JSON.parse(await fs.readFile(path.join(app.dataDir, 'maker', 'speed.json'), 'utf8').catch(() => '{}'))).rates?.[key]);
    return d;
  };
  const saved = await speedFile('separate:htdemucs');
  assert.deepEqual(saved.rates['separate:htdemucs'], [3], '6 s for 2 minutes of song: 3 s a minute');
  // Phonon-2 first (0.4.0, an English song): it timed this one, so the speed is kept as Phonon-2's.
  assert.equal(tool.state.runs[0].opts.lyricTimer, 'phonon');
  assert.equal(done.timer, 'Phonon-2');
  assert.deepEqual(saved.rates['timing:phonon-2'], [2], 'Phonon-2’s own speed, apart from Whisper’s');
  assert.equal(saved.rates[`timing:${room.maker.whisperModel()}`], undefined);
  app.settings.update({ maker: { lyricTimer: 'evil' } });
  assert.equal(app.settings.get('maker.lyricTimer'), 'phonon', 'an unknown timer is ignored');
  assert.equal(room.hostView().maker.typical, 24, 'a 4-minute song: (3 + 2 + 0.5 + 0.5) × 4');
  const src2 = path.join(path.dirname(src), 'Pixel Band - Neon Road.mp3');
  await writePcmWav(src2, { hz: 220, seconds: 2 });
  const second = await req(host, 'maker.make', { song: { path: src2 }, lyrics: 'Neon on the road' });
  await until(() => room.hostView().maker.jobs.find((j) => j.id === second.id).estimate !== null || room.maker.jobs.find((j) => j.id === second.id).finishedAt);
  const seen = room.hostView().maker.jobs.find((j) => j.id === second.id);
  if (!seen.finishedAt) assert.equal(seen.estimate, 12, 'its length is known once autokaraoke says it');
  await until(() => room.maker.jobs.find((j) => j.id === second.id).status === 'done');
  assert.equal(room.hostView().maker.jobs.find((j) => j.id === second.id).estimate, null, 'finished: no estimate');
  // Whisper only, by choice: passed on, and its speed kept under the Whisper model.
  app.settings.update({ maker: { lyricTimer: 'whisper' } });
  assert.equal(room.hostView().maker.lyricTimer, 'whisper');
  const src3 = path.join(path.dirname(src), 'Pixel Band - Third.mp3');
  await writePcmWav(src3, { hz: 220, seconds: 2 });
  const third = await req(host, 'maker.make', { song: { path: src3 }, lyrics: 'Third' });
  await until(() => room.maker.jobs.find((j) => j.id === third.id).status === 'done');
  assert.equal(tool.state.runs.at(-1).opts.lyricTimer, 'whisper');
  assert.equal(room.hostView().maker.jobs.find((j) => j.id === third.id).timer, 'Whisper');
  const after = await speedFile(`timing:${room.maker.whisperModel()}`);
  assert.deepEqual(after.rates[`timing:${room.maker.whisperModel()}`], [2], 'under the Whisper model the hardware check picked');
});

test('timing.json: the "render" field is kept through an edit; unknown fields are not', () => {
  const d = { ...fakeTiming('One two\nThree', { duration: 10 }), render: { theme: 'green', lines_on_screen: 3, lead: 2.5, font_size: 1.5, outline: true, page_gap: -1, colour: 'red' }, extra: 1 };
  const song = readTiming(d);
  assert.deepEqual(song.render, { theme: 'green', lines_on_screen: 3, lead: 2.5 });
  const out = timingJson(song);
  assert.equal(out.version, 1);
  assert.deepEqual(out.render, { theme: 'green', lines_on_screen: 3, lead: 2.5 });
  assert.ok(!('extra' in out));
  assert.ok(!('render' in timingJson(readTiming(fakeTiming('A b', { duration: 5 })))), 'an older file stays without one');
  assert.equal(renderOptions({ theme: 'x; rm -rf' }), null);
  assert.equal(renderOptions([1]), null);
});

const made = 'P/Pixel Band/Pixel Band - Night Drive';
const lyricsTiming = { ...fakeTiming('Driving through the night\nNeon on the road\nAll the way home', { title: 'Night Drive', artist: 'Pixel Band', duration: 30 }), render: { theme: 'green', lines_on_screen: 3 } };

test('lyrics editor: Whisper re-times one line (not saved until Save); the render field decides the colours', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.1 });
  const files = {
    [`${made}.mp3`]: 100,
    [`${made}.cdg`]: cdgFromTiming(readTiming(lyricsTiming), 30),
    [`${made}.timing.json`]: JSON.stringify(lyricsTiming),
  };
  const { app, room, song } = await setupRoom({}, { makerTool: tool, files });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  await until(() => room.maker.where?.installed);
  const trackId = song('night drive').trackIds[0];
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  let opened = await (await fetch(`${base}/api/lyrics/${trackId}`)).json();
  assert.equal(opened.retime, false, 'no vocal yet: nothing to re-time against');
  assert.deepEqual(opened.timing.render, { theme: 'green', lines_on_screen: 3 }, 'the editor gets the render field');
  let r = await post(`${base}/api/lyrics/${trackId}/retime`, { timing: opened.timing, from: 0, to: 10 });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /needs the song’s vocal/);

  // The vocal autokaraoke kept beside the pair (--keep-stems).
  const lib = app.library.paths[0];
  await fs.mkdir(path.join(lib, `${made}.work`), { recursive: true });
  await writePcmWav(path.join(lib, `${made}.work`, 'vocals.wav'), { hz: 440, seconds: 2 });
  opened = await (await fetch(`${base}/api/lyrics/${trackId}`)).json();
  assert.equal(opened.retime, true);

  const line2 = opened.timing.lines[1].words;
  const from = line2[0].start - 0.2;
  const to = line2.at(-1).start + 0.2;
  r = await post(`${base}/api/lyrics/${trackId}/retime`, { timing: opened.timing, from, to });
  assert.equal(r.status, 200);
  const got = await r.json();
  assert.equal(got.retimed, line2.length);
  const run = tool.state.runs.find((x) => x.kind === 'retime');
  assert.equal(run.opts.vocals, path.join(lib, `${made}.work`, 'vocals.wav'));
  assert.equal(run.opts.from, from);
  assert.equal(run.opts.whisperModel, room.maker.whisperModel());
  assert.deepEqual(got.timing.lines[0], opened.timing.lines[0], 'the line before is untouched');
  assert.deepEqual(got.timing.lines[2], opened.timing.lines[2], 'the line after is untouched');
  assert.deepEqual(got.timing.lines[1].words.map((w) => w.start), line2.map((w) => Math.round((w.start + 0.1) * 1000) / 1000));
  assert.deepEqual(got.timing.render, { theme: 'green', lines_on_screen: 3 });
  assert.equal((await (await fetch(`${base}/api/lyrics/${trackId}`)).json()).edited, false, 'not saved: the editor decides');
  await assert.rejects(fs.stat(path.join(app.dataDir, 'lyrics', trackId, 'retime-out.json')), 'no files left behind');

  // Whisper failing says why.
  tool.state.fail = 'retime';
  r = await post(`${base}/api/lyrics/${trackId}/retime`, { timing: opened.timing, from, to });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /The lyric timer could not re-time it: no words start/);
  tool.state.fail = '';
  r = await post(`${base}/api/lyrics/${trackId}/retime`, { timing: opened.timing, from: 5, to: 2 });
  assert.equal(r.status, 400);

  // Saving: the timing's own render options are used, so no colour is forced on the command line.
  const saved = await (await post(`${base}/api/lyrics/${trackId}`, { timing: got.timing })).json();
  assert.equal(saved.drawnNow, true);
  const render = tool.state.runs.filter((x) => x.kind === 'render').at(-1);
  assert.equal(render.opts.theme, '', 'the stored theme, not the one guessed from the CDG');
  const draft = JSON.parse(await fs.readFile(path.join(app.dataDir, 'lyrics', trackId, 'timing.json'), 'utf8'));
  assert.deepEqual(draft.render, { theme: 'green', lines_on_screen: 3 });
});
