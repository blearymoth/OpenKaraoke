// A disc's words (PLAN §31.16, server/lyrics/words.js): a multiplex disc's singer is separated and
// the words timed against it (autokaraoke's stand-in); a plain disc needs Separate vocals first;
// song details, the TV's timing URL and the lyrics editor then treat them like a made song's —
// except that they are never drawn or written into the library (the disc keeps its CDG). Remove,
// cancel, an older autokaraoke, a song made here, host only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupRoom } from './room-harness.js';
import { fakeStemRun } from '../server/stems/fake.js';
import { fakeAutokaraoke, fakeTiming, cdgFromTiming } from '../server/maker/fake.js';
import { readTiming } from '../shared/timing.js';
import { wordsArgs } from '../server/maker/autokaraoke.js';

const SONGS = [
  'DJ Hush - Quiet Storm [MX Karaoke] (Multiplex)',
  'Blondie - Call Me [SC Karaoke]',
  'Adele - Hello [SF Karaoke]',
];
const made = 'P/Pixel Band/Pixel Band - Night Drive';
const timing = fakeTiming('Driving through the night', { title: 'Night Drive', artist: 'Pixel Band', duration: 20 });
const FILES = {
  [`${made}.mp3`]: 100,
  [`${made}.cdg`]: cdgFromTiming(readTiming(timing), 20),
  [`${made}.timing.json`]: JSON.stringify(timing),
};
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('words: the command line', () => {
  assert.deepEqual(wordsArgs({ vocals: '/d/v.wav', output: '/d/w.json', lyricsFile: '/d/l.txt', artist: 'A', title: 'T', duration: 201.26, language: 'fi', whisperModel: 'small' }),
    ['-m', 'autokaraoke', 'words', '--vocals', '/d/v.wav', '-O', '/d/w.json', '--whisper-model', 'small', '--lyrics', '/d/l.txt', '--artist', 'A', '--title', 'T', '--duration', '201.3', '--language', 'fi']);
  assert.deepEqual(wordsArgs({ vocals: '/d/v.wav', output: '/d/w.json', lyricsSources: ['lrclib', 'netease'] }).slice(-2), ['--lyrics-sources', 'lrclib,netease']);
  assert.throws(() => wordsArgs({ vocals: 'v.wav', output: '/d/w.json' }), /absolute/);
  assert.throws(() => wordsArgs({ vocals: '/v.wav', output: '/w.json', lyricsSources: ['evil'] }), /source/);
  assert.throws(() => wordsArgs({ vocals: '/v.wav', output: '/w.json', language: '--rm' }), /language/);
  assert.deepEqual(wordsArgs({ vocals: '/v.wav', output: '/w.json', lyricTimer: 'whisper' }).slice(-2), ['--lyric-timer', 'whisper']);
  assert.ok(!wordsArgs({ vocals: '/v.wav', output: '/w.json' }).includes('--lyric-timer'), 'not passed to an older autokaraoke');
  assert.throws(() => wordsArgs({ vocals: '/v.wav', output: '/w.json', lyricTimer: 'evil' }), /lyric timer/);
});

test('words: a multiplex disc’s words, timed against its singer; then the TV and the editor', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.1 });
  const stemRun = (args) => fakeStemRun({ ...args, seconds: 0.05 });
  const { app, room, connect, guest, req, song } = await setupRoom({}, { songs: SONGS, stemRun, makerTool: tool, files: FILES });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  await until(() => room.maker.checks);
  const host = await connect('host');
  const mpx = song('quiet storm').trackIds[0];
  const callMe = song('call me').trackIds[0];
  const nd = song('night drive').trackIds[0];
  const details = async (q) => (await (await fetch(`${base}/api/songs/${song(q).id}`)).json()).versions[0];

  // What can get words: a multiplex disc (its singer), not a plain one until it is separated, not a made song.
  assert.deepEqual((await details('quiet storm')).words, { problem: '' });
  assert.match((await details('call me')).words.problem, /separate this version’s vocals first/);
  assert.deepEqual((await details('night drive')).lyrics, { kind: 'made', edited: false });
  await assert.rejects(req(host, 'words.find', { trackId: callMe }), /separate this version’s vocals first/);
  await assert.rejects(req(host, 'words.find', { trackId: nd }), /made here/);
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'words.find', { trackId: mpx }), /not allowed/);

  // Pasted lyrics: the singer is separated first, then the words are timed against it.
  const started = await req(host, 'words.find', { trackId: mpx, lyrics: 'Quiet storm is coming\r\nHold on tight\n' });
  assert.equal(started.state, 'vocal');
  assert.equal(room.hostView().words[0].trackId, mpx);
  await assert.rejects(req(host, 'words.find', { trackId: mpx }), /already being found/);
  await until(() => room.words.jobs.get(mpx)?.state === 'done');
  const run = tool.state.runs.find((r) => r.kind === 'words');
  assert.equal(run.opts.vocals, room.stems.file(mpx, 'vocal.wav'), 'against the disc’s own singer');
  assert.ok(run.opts.output.startsWith(path.join(app.dataDir, 'lyrics', mpx)), 'into the data folder, never the library');
  assert.deepEqual(run.opts.lyricsSources, [], 'pasted lyrics: nothing looked up');
  const qs = room.catalog.song(song('quiet storm').id);
  assert.equal(run.opts.title, qs.title, 'the song’s names, for a lookup');
  assert.deepEqual(room.words.view()[0], { trackId: mpx, state: 'done', label: 'Ready', error: '', at: room.words.jobs.get(mpx).at, lines: 2, lyricsFrom: 'typed', timer: 'Phonon-2', title: qs.title, artist: qs.artist });
  assert.equal(run.opts.lyricTimer, 'phonon', 'Phonon-2 first (an English song), Whisper second');
  await assert.rejects(fs.stat(path.join(app.dataDir, 'lyrics', mpx, 'words-lyrics.txt')), 'the lyrics file is gone');
  assert.deepEqual((await details('quiet storm')).lyrics, { kind: 'words', edited: false });

  // The TV: its words, as a disc's; the CDG is still the disc's own.
  await req(host, 'queue.add', { songId: song('quiet storm').id, singerName: 'Bo' });
  await req(host, 'player.play');
  await until(() => room.currentView({ media: true }).media?.timing);
  const tv = await (await fetch(`${base}${room.currentView({ media: true }).media.timing}`)).json();
  assert.equal(tv.source, 'words');
  assert.deepEqual(tv.lines.map((l) => l.words.map((w) => w.text).join(' ')), ['Quiet storm is coming', 'Hold on tight']);
  assert.doesNotMatch(room.currentView({ media: true }).media.cdg, /edit=/, 'the disc’s CDG');

  // The editor: an edit is saved, never drawn; the TV gets it; Revert keeps the words; no write-back.
  const opened = await (await fetch(`${base}/api/lyrics/${mpx}`)).json();
  assert.equal(opened.kind, 'words');
  assert.equal(opened.renderer, false);
  assert.equal(opened.vocal, `/media/${mpx}/stem/vocal`, 'its singer as the guide vocal');
  const edit = structuredClone(opened.timing);
  edit.lines[1].words[0].text = 'Hang';
  const post = (url, body = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await (await post(`${base}/api/lyrics/${mpx}`, { timing: edit })).json();
  assert.equal(saved.drawnNow, false);
  assert.equal(saved.error, undefined, 'not drawn, and that’s not an error');
  assert.equal(saved.edited, true);
  assert.equal(tool.state.runs.filter((r) => r.kind === 'render').length, 0, 'nothing drawn');
  assert.equal(room.lyrics.cdgFor(mpx), null);
  const tv2 = await (await fetch(`${base}${room.currentView({ media: true }).media.timing}`)).json();
  assert.equal(tv2.lines[1].words[0].text, 'Hang');
  const wb = await post(`${base}/api/lyrics/${mpx}/write`);
  assert.equal(wb.status, 400);
  assert.match((await wb.json()).error, /never changed/);
  const reverted = await (await post(`${base}/api/lyrics/${mpx}/revert`)).json();
  assert.equal(reverted.edited, false);
  assert.equal(reverted.timing.lines[1].words[0].text, 'Hold', 'back to the words found');

  // Found again: looked up this time (none pasted). No graphics card and a song on: it waits for the
  // song to end (the room's sound first); then removed.
  await req(host, 'words.find', { trackId: mpx });
  await until(() => room.words.jobs.get(mpx)?.state === 'waiting');
  await req(host, 'player.stop');
  await until(() => room.words.jobs.get(mpx)?.state === 'done');
  assert.deepEqual(tool.state.runs.filter((r) => r.kind === 'words').at(-1).opts.lyricsSources, ['lrclib']);
  assert.equal(room.words.jobs.get(mpx).lyricsFrom, 'LRCLIB');
  assert.equal((await (await fetch(`${base}/api/lyrics/${mpx}`)).json()).timing.lines[0].words[0].text, 'Found');
  await req(host, 'words.remove', { trackId: mpx });
  assert.equal(room.mediaFor(room.catalog.track(mpx)).timing, undefined, 'the TV draws the disc’s own lyrics again');
  assert.ok((await details('quiet storm')).words, 'it can get them again');
  await assert.rejects(req(host, 'words.remove', { trackId: mpx }), /no words/);

  // A plain disc, once the host separated it.
  await req(host, 'stems.separate', { trackId: callMe });
  await until(() => room.stems.view(callMe).status === 'ready');
  assert.deepEqual((await details('call me')).words, { problem: '' });
  tool.state.fail = 'words';
  await req(host, 'words.find', { trackId: callMe, lyrics: 'Call me' });
  await until(() => room.words.jobs.get(callMe)?.state === 'failed');
  assert.match(room.words.jobs.get(callMe).error, /alignment failed/);
  assert.equal((await details('call me')).lyrics, undefined, 'nothing kept');
  await req(host, 'words.dismiss', { trackId: callMe });
  assert.equal(room.words.jobs.has(callMe), false);
});

test('words: cancelled while it works; an older autokaraoke can’t', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 2 });
  const stemRun = (args) => fakeStemRun({ ...args, seconds: 0.05 });
  const { app, room, connect, req, song } = await setupRoom({}, { songs: SONGS, stemRun, makerTool: tool });
  t.after(() => app.close());
  await until(() => room.maker.checks);
  const host = await connect('host');
  const mpx = song('quiet storm').trackIds[0];
  await req(host, 'words.find', { trackId: mpx, lyrics: 'Words' });
  await until(() => room.words.jobs.get(mpx)?.state === 'working');
  assert.equal(await req(host, 'words.cancel', { trackId: mpx }), true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(room.words.jobs.get(mpx).state, 'cancelled');
  assert.equal(await room.lyrics.editable(room.catalog.track(mpx)), '', 'nothing kept');

  tool.state.version = '0.3.0'; // (before Phonon-2: no --lyric-timer for it)
  await room.maker.check();
  assert.equal(room.maker.lyricTimer(), '');
  tool.state.version = '0.2.0';
  await room.maker.check();
  assert.match(room.wordsProblem(mpx), /Update the Karaoke maker/);
  await assert.rejects(req(host, 'words.find', { trackId: mpx }), /Update the Karaoke maker/);
});
