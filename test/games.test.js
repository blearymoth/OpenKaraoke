import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PollGame } from '../server/games/poll.js';
import { WheelGame } from '../server/games/wheel.js';
import { createApp } from '../server/app.js';
import { WebSocket } from '../server/vendor/ws.mjs';
import { tmpDir, writeTree } from './helpers.js';

const songs = ['A', 'B', 'C', 'D'].map((x) => ({ id: x, title: `Song ${x}`, artist: 'X', dur: 180 }));

test('poll: one vote per voter (changeable), close picks the winner, ties at random', () => {
  let changes = 0;
  const p = new PollGame({ songs, seconds: 60, rng: () => 0.99, onChange: () => changes++ });
  p.vote('g1', 2);
  p.vote('g2', 2);
  p.vote('g3', 1);
  p.vote('g3', 0); // changed mind
  assert.deepEqual(p.counts(), [1, 0, 2, 0]);
  assert.equal(p.view('g3').myVote, 0);
  assert.equal(p.view('nobody').myVote, null);
  assert.throws(() => p.vote('g4', 9), /Unknown option/);
  assert.equal(p.close(), 2);
  assert.throws(() => p.vote('g5', 1), /closed/);
  assert.equal(p.winnerSong().id, 'C');
  assert.ok(changes >= 5);

  const tie = new PollGame({ songs, seconds: 60, rng: () => 0.99 });
  tie.vote('a', 1);
  tie.vote('b', 3);
  assert.equal(tie.close(), 3, 'rng picks among the leaders');
  const none = new PollGame({ songs, seconds: 60, rng: () => 0 });
  assert.equal(none.close(), 0, 'no votes: random song');
  for (const g of [p, tie, none]) g.dispose();
});

test('poll closes by itself when time is up', async () => {
  const p = new PollGame({ songs, seconds: 5 });
  p.endsAt = Date.now();
  clearTimeout(p.timer);
  p.timer = setTimeout(() => p.close(), 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(p.phase, 'result');
});

test('wheel: server picks the result, lands after the spin, segments can be removed', async () => {
  const segs = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id }));
  const w = new WheelGame({ kind: 'singers', segments: segs, rng: () => 0.6, spinMs: 20 });
  assert.equal(w.spin(), 2);
  assert.throws(() => w.spin(), /already spinning/);
  assert.equal(w.view().phase, 'spinning');
  assert.equal(w.resultSegment(), null, 'no result before landing');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(w.view().phase, 'landed');
  assert.equal(w.resultSegment().id, 'c');
  w.removeResult();
  assert.deepEqual(w.segments.map((s) => s.id), ['a', 'b', 'd']);
  assert.throws(() => new WheelGame({ segments: [segs[0]] }), /two/);
});

// ---- over WebSockets ----------------------------------------------------------------------------------

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let app;
before(async () => {
  const lib = await tmpDir();
  const files = {};
  for (const n of ['Adele - Hello [SF Karaoke]', 'Queen - Bohemian Rhapsody [SC Karaoke]', 'Blur - Song 2 [SF Karaoke]', 'Abba - Waterloo [SF Karaoke]', 'Toto - Africa [SC Karaoke]']) {
    const artist = n.split(' - ')[0];
    files[`${artist[0]}/${artist}/${n}.cdg`] = 7200 * 200;
    files[`${artist[0]}/${artist}/${n}.mp3`] = 10;
  }
  await writeTree(lib, files);
  app = await createApp({ dataDir: await tmpDir(), args: { library: [lib], noCrawl: true }, log: quiet, watchIntervalMs: 0, fetch: () => Promise.reject(new Error('offline')) });
  app.library.log = quiet;
  app.room.log = quiet;
  app.settings.update({ artwork: { enabled: false }, playback: { autoAdvance: false } });
  await app.listen(0, '127.0.0.1');
  await app.start({ scan: false });
  await app.library.scan();
});
after(async () => { await app.close(); });

async function connect(hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const inbox = [];
  let rid = 0;
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  const waitFor = async (pred, ms = 2000) => {
    const t0 = Date.now();
    for (;;) {
      const m = inbox.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const c = {
    ws,
    waitFor,
    async request(t, p = {}) {
      const id = ++rid;
      ws.send(JSON.stringify({ t, rid: id, ...p }));
      const res = await waitFor((m) => m.t === 'res' && m.rid === id);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    async state() { await new Promise((r) => setTimeout(r, 80)); return [...inbox].reverse().find((m) => m.t === 'state'); },
  };
  ws.send(JSON.stringify({ t: 'hello', ...hello }));
  await waitFor((m) => m.t === 'welcome');
  return c;
}

test('crowd poll end to end: guests vote, host closes and queues the winner', async () => {
  const room = app.settings.get('party.roomCode');
  const host = await connect({ role: 'host', deviceId: 'host-1' });
  const tv = await connect({ role: 'tv', deviceId: 'tv-1' });
  const g1 = await connect({ role: 'guest', room, deviceId: 'guest-poll-1', profile: { name: 'Pia' } });
  const g2 = await connect({ role: 'guest', room, deviceId: 'guest-poll-2', profile: { name: 'Pat' } });
  const view = await host.request('game.start', { type: 'poll', config: { count: 3, seconds: 30 } });
  assert.equal(view.options.length, 3);
  await assert.rejects(g1.request('game.start', { type: 'poll' }), /Not allowed/);
  await g1.request('game.vote', { option: 1 });
  await g2.request('game.vote', { option: 1 });
  const gs = await g1.state();
  assert.equal(gs.game.myVote, 1);
  const ts = await tv.state();
  assert.deepEqual(ts.game.counts, [0, 2, 0]);
  await host.request('game.action', { action: 'close' });
  const singer = (await host.state()).singers.find((s) => s.name === 'Pia');
  const r = await host.request('game.action', { action: 'queue', singerId: singer.id });
  assert.ok(r.entryId);
  const hs = await host.state();
  assert.equal(hs.queue[0].songId, view.options[1].songId);
  assert.equal(hs.queue[0].source, 'game:poll');
  await host.request('game.end');
  assert.equal((await tv.state()).game, null);
  for (const c of [host, tv, g1, g2]) c.ws.close();
});

test('wheel of singers: phones get no spoiler while it spins', async () => {
  const room = app.settings.get('party.roomCode');
  const host = await connect({ role: 'host', deviceId: 'host-2' });
  await host.request('singer.add', { name: 'Wendy' });
  await host.request('singer.add', { name: 'Walt' });
  const g = await connect({ role: 'guest', room, deviceId: 'guest-wheel-1', profile: { name: 'Wes' } });
  const v = await host.request('game.start', { type: 'wheel', config: { kind: 'singers', spinMs: 150 } });
  assert.ok(v.segments.length >= 3);
  await host.request('game.action', { action: 'spin' });
  const spinning = await g.state();
  assert.equal(spinning.game.phase, 'spinning');
  assert.equal(spinning.game.result, null);
  const hs = await host.state();
  assert.equal(typeof hs.game.result, 'number');
  await new Promise((r) => setTimeout(r, 250));
  const landed = await g.state();
  assert.equal(landed.game.phase, 'landed');
  assert.equal(landed.game.result, hs.game.result);
  await assert.rejects(host.request('game.action', { action: 'queue' }), /no song/);
  await host.request('game.start', { type: 'wheel', config: { kind: 'songs', count: 4 } });
  await host.request('game.end');
  host.ws.close();
  g.ws.close();
});
