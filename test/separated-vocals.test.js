// Separated vocals on any track (PLAN §30): the host asks for a version to be separated (music +
// vocal, autokaraoke — a stand-in here), the room then plays the two stems with the vocals at a
// level; multiplex and video versions don't; guests can't ask; the level is kept per version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupRoom } from './room-harness.js';
import { fakeStemRun } from '../server/stems/fake.js';

const SONGS = [
  'DJ Hush - Quiet Storm [MX Karaoke] (Multiplex)',
  'Adele - Hello [SF Karaoke] (Con Voz)',
  'Adele - Hello [ZM Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
];
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('the host separates a version; the room then plays its stems with the vocals at a level', async (t) => {
  let runs = 0;
  const stemRun = async (args) => {
    runs++;
    if (runs === 1) throw new Error('demucs ran out of memory');
    await fakeStemRun({ ...args, seconds: 0.05 });
  };
  const { app, room, connect, guest, req, song, s } = await setupRoom({ playback: { countdown: 0, autoStart: false } }, { songs: SONGS, stemRun });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  const host = await connect('host');
  const tv = await connect('tv');
  const tracks = (q) => song(q).trackIds.map((id) => room.catalog.track(id));
  const voz = tracks('hello').find((tr) => tr.p.flags.vocals);
  const mpx = tracks('quiet storm')[0];
  const callMe = tracks('call me')[0];

  // Who and what: guests can't; a multiplex version has its own guide level already.
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'stems.separate', { trackId: voz.id }), /not allowed/);
  await assert.rejects(req(host, 'stems.separate', { trackId: mpx.id }), /multiplex/);
  await assert.rejects(req(host, 'stems.separate', { trackId: 'nope' }), /Unknown track/);
  assert.equal((await fetch(`${base}/media/${voz.id}/stem/music`)).status, 404, 'not asked: not served');

  // Asked while it is on: separating → failed → asked again → ready; the TV reloads into the stems.
  await req(host, 'queue.add', { songId: song('hello').id, trackId: voz.id, singerName: 'Ana' });
  await req(host, 'player.play');
  assert.equal(s().current.trackId, voz.id);
  assert.equal(room.playerView().stems, 'idle');
  assert.equal(room.playerView().vox, 100, 'as recorded at first');
  await assert.rejects(req(host, 'player.vox', { level: 0 }), /Separate this version/);
  const first = await req(host, 'stems.separate', { trackId: voz.id });
  assert.ok(['separating', 'failed'].includes(first.status), first.status);
  await until(() => room.stems.view(voz.id).status === 'failed');
  assert.equal(room.playerView().stems, 'failed');
  const reload = s().player.reload || 0;
  await req(host, 'stems.separate', { trackId: voz.id });
  await until(() => room.stems.view(voz.id).status === 'ready');
  assert.equal(runs, 2);
  assert.equal(s().player.reload, reload + 1, 'the TV loads the stems where it is in the song');
  const media = room.currentView({ media: true }).media;
  assert.deepEqual(media.stems, { music: `/media/${voz.id}/stem/music`, vocal: `/media/${voz.id}/stem/vocal` });
  assert.ok(media.audio && media.cdg, 'the file and the lyrics are still there');
  for (const kind of ['music', 'vocal']) {
    const res = await fetch(`${base}/media/${voz.id}/stem/${kind}`);
    assert.equal(res.status, 200, kind);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    await fs.stat(path.join(app.dataDir, 'stems', voz.id, `${kind}.wav`));
  }
  assert.equal((await fetch(`${base}/media/${voz.id}/stem/backing`)).status, 404);

  // The level: host and co-hosts; kept for the version.
  assert.deepEqual(await req(host, 'player.vox', { level: 30 }), { vox: 30 });
  await assert.rejects(req(ana, 'player.vox', { level: 0 }), /not allowed/);
  await req(host, 'guest.cohost', { deviceId: ana.data.deviceId, on: true });
  assert.deepEqual(await req(ana, 'player.vox', { level: 0 }), { vox: 0 });
  await assert.rejects(req(host, 'player.vox', { level: 'loud' }), /Unknown level/);
  assert.deepEqual(await req(host, 'player.vox', { level: 150 }), { vox: 100 });
  await req(host, 'player.vox', { level: 20 });
  await req(tv, 'tv.ended', { entryId: s().current.id });

  // Another song: its own level; the separated one comes back at 20, and still separated.
  await req(host, 'queue.add', { songId: song('call me').id, trackId: callMe.id, singerName: 'Bo' });
  await req(host, 'player.play');
  assert.equal(room.playerView().vox, 100);
  assert.equal(room.currentView({ media: true }).media.stems, undefined);
  await req(tv, 'tv.ended', { entryId: s().current.id });
  await req(host, 'queue.add', { songId: song('hello').id, trackId: voz.id, singerName: 'Ana' });
  await req(host, 'player.play');
  assert.equal(room.playerView().vox, 20);
  assert.ok(room.currentView({ media: true }).media.stems);
  assert.equal(runs, 2, 'not separated again');
});

test('without a separator: the host is told; a video can’t be separated', async (t) => {
  const { app, connect, req, song, room } = await setupRoom({}, {
    songs: SONGS,
    files: { 'V/Video Band - Clip [KV Karaoke].mp4': 100 },
  });
  t.after(() => app.close());
  const host = await connect('host');
  const voz = song('hello').trackIds.map((id) => room.catalog.track(id)).find((tr) => tr.p.flags.vocals);
  await assert.rejects(req(host, 'stems.separate', { trackId: voz.id }), /isn’t set up/);
  const video = [...room.catalog.tracks.values()].find((tr) => tr.kind === 'video');
  await assert.rejects(req(host, 'stems.separate', { trackId: video.id }), /a video plays its own sound/);
});
