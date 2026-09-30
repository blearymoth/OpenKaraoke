import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { WebSocket } from '../server/vendor/ws.mjs';
import { tmpDir, writeTree } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let app;
let data;
const open = [];

const SONGS = [
  'Adele - Hello [SF Karaoke]',
  'Adele - Someone Like You [SF Karaoke]',
  'Queen - Bohemian Rhapsody [SC Karaoke]',
  'Queen - Killer Queen [SC Karaoke]',
  'Blur - Song 2 [SF Karaoke]',
  'Rude Words - Censored Song (Explicit) [SF Karaoke]',
];

before(async () => {
  const lib = await tmpDir();
  data = await tmpDir();
  const files = {};
  for (const n of SONGS) {
    const artist = n.split(' - ')[0];
    files[`${artist[0]}/${artist}/${n}.cdg`] = 7200 * 100;
    files[`${artist[0]}/${artist}/${n}.mp3`] = 100;
  }
  await writeTree(lib, files);
  app = await createApp({ dataDir: data, args: { library: [lib] }, log: quiet, watchIntervalMs: 0 });
  app.library.log = quiet;
  app.room.log = quiet;
  await app.listen(0, '127.0.0.1');
  await app.start({ scan: false });
  await app.library.scan();
});

after(async () => {
  for (const c of open) c.close();
  await app.close();
});

beforeEach(() => {
  app.room.newParty();
  app.settings.update({
    playback: { countdown: 0, autoAdvance: true, startPaused: false },
    queue: { mode: 'rotation', newcomersFirst: true, requireApproval: false, maxPerGuest: 3, allowRepeats: false, explicitFilter: false, guestsSeeQueue: true },
  });
});

function songId(q) {
  return app.library.catalog.search(q).items[0].id;
}

/** Connects a WebSocket client and completes the hello. */
async function connect(hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const inbox = [];
  const waiters = [];
  let rid = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    ws,
    inbox,
    waitFor(pred, ms = 2000) {
      const found = inbox.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting (${pred})`)), ms);
      });
    },
    next(pred, ms = 2000) {
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('timeout')), ms);
      });
    },
    send(t, p = {}) { ws.send(JSON.stringify({ t, ...p })); },
    async request(t, p = {}) {
      const id = ++rid;
      ws.send(JSON.stringify({ t, rid: id, ...p }));
      const res = await c.waitFor((m) => m.t === 'res' && m.rid === id);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    state() { return [...inbox].reverse().find((m) => m.t === 'state'); },
    async settle() { await new Promise((r) => setTimeout(r, 80)); return c.state(); },
    close() { ws.close(); },
  };
  open.push(c);
  c.send('hello', hello);
  c.welcome = await c.waitFor((m) => m.t === 'welcome' || m.t === 'denied');
  return c;
}

const host = () => connect({ role: 'host', deviceId: 'host-device' });
const guest = (id, name) => connect({ role: 'guest', room: app.settings.get('party.roomCode'), deviceId: id, profile: name ? { name } : undefined });

test('guest joins, sets a name and requests a song', async () => {
  const g = await guest('guest-aaaa-1');
  assert.equal(g.welcome.t, 'welcome');
  assert.equal(g.welcome.profile, null);
  await assert.rejects(g.request('queue.add', { songId: songId('hello') }), /name/);
  const prof = await g.request('guest.update', { name: 'Anna', emoji: '🦄' });
  assert.equal(prof.name, 'Anna');
  assert.equal(prof.emoji, '🦄');
  const r = await g.request('queue.add', { songId: songId('hello') });
  assert.ok(r.entryId);
  const st = await g.settle();
  const mine = st.queue.concat(st.current ? [] : []).find((e) => e.id === r.entryId) || (st.current?.id === r.entryId ? st.current : null);
  assert.ok(mine || st.me.onStage, 'entry visible');
  g.close();
});

test('rotation orders the queue fairly; host can reorder', async () => {
  const h = await host();
  app.settings.update({ playback: { autoAdvance: false } });
  const a = await h.request('queue.add', { songId: songId('hello'), singerName: 'Alice' });
  await h.request('queue.add', { songId: songId('someone like you'), singerName: 'Alice' });
  await h.request('queue.add', { songId: songId('bohemian'), singerName: 'Bob' });
  let st = await h.settle();
  assert.deepEqual(st.queue.map((e) => e.singers[0].name), ['Alice', 'Bob', 'Alice']);
  assert.ok(st.queue[1].eta > st.queue[0].eta);
  await h.request('queue.move', { entryId: st.queue[2].id, index: 0 });
  st = await h.settle();
  assert.equal(st.queue[0].title, 'Someone Like You');
  await h.request('queue.remove', { entryId: a.entryId });
  st = await h.settle();
  assert.equal(st.queue.length, 2);
  h.close();
});

test('player flow: intro → playing → tv reports → ended → next song + history', async () => {
  const h = await host();
  const tv = await connect({ role: 'tv', deviceId: 'tv-device-1' });
  assert.equal(tv.welcome.role, 'tv');
  const g = await guest('guest-bbbb-1', 'Ben');
  await g.request('queue.add', { songId: songId('killer queen') });
  const now = await g.waitFor((m) => m.t === 'notify' && m.kind === 'now');
  assert.match(now.text, /turn/);
  await h.request('queue.add', { songId: songId('song 2'), singerName: 'Cara' });
  let tvState = await tv.settle();
  assert.equal(tvState.main, true);
  assert.equal(tvState.player.state, 'playing');
  assert.equal(tvState.current.title, 'Killer Queen');
  assert.match(tvState.current.media.audio, /^\/media\/.+\/audio$/);
  assert.equal(tvState.next[0].title, 'Song 2');

  tv.send('tv.status', { entryId: tvState.current.id, pos: 42, dur: 100, playing: true });
  const time = await h.waitFor((m) => m.t === 'time' && m.pos === 42);
  assert.equal(time.dur, 100);

  await h.request('player.key', { delta: 2 });
  await h.request('player.tempo', { rate: 1.1 });
  tvState = await tv.settle();
  assert.equal(tvState.player.key, 2);
  assert.equal(tvState.player.tempo, 1.1);
  await h.request('player.seek', { pos: 30 });
  tvState = await tv.settle();
  assert.equal(tvState.player.seekPos, 30);

  tv.send('tv.ended', { entryId: tvState.current.id });
  tvState = await tv.settle();
  assert.equal(tvState.current.title, 'Song 2');
  const hs = h.state();
  assert.equal(hs.tonight[0].title, 'Killer Queen');
  assert.equal(hs.singers.find((s) => s.name === 'Ben').sung, 1);
  const history = await fs.readFile(path.join(data, 'history.jsonl'), 'utf8');
  assert.match(history, /Killer Queen/);

  // guests can't sing the same song twice tonight
  await assert.rejects(g.request('queue.add', { songId: songId('killer queen') }), /already/);
  await h.request('player.stop');
  for (const c of [h, tv, g]) c.close();
});

test('guest limits, explicit filter and approvals', async () => {
  app.settings.update({ queue: { maxPerGuest: 1, explicitFilter: true }, playback: { autoAdvance: false } });
  const h = await host();
  const g = await guest('guest-cccc-1', 'Cleo');
  await assert.rejects(g.request('queue.add', { songId: songId('censored') }), /Explicit/);
  await g.request('queue.add', { songId: songId('hello') });
  await assert.rejects(g.request('queue.add', { songId: songId('bohemian') }), /1 song/);
  await assert.rejects(g.request('queue.move', { entryId: 'x', index: 0 }), /Not allowed/);

  app.settings.update({ queue: { maxPerGuest: 0, requireApproval: true } });
  const r = await g.request('queue.add', { songId: songId('bohemian') });
  assert.equal(r.pending, true);
  let hs = await h.settle();
  assert.equal(hs.pending.length, 1);
  await h.request('queue.approve', { entryId: r.entryId });
  const note = await g.waitFor((m) => m.t === 'notify' && m.kind === 'approved');
  assert.match(note.text, /Bohemian/);
  hs = await h.settle();
  assert.equal(hs.pending.length, 0);
  assert.equal(hs.queue.length, 2);
  const gs = await g.settle();
  assert.equal(gs.me.entries.length, 2);
  h.close();
  g.close();
});

test('TV reload during a song pauses and resumes; banned guests are refused', async () => {
  const h = await host();
  let tv = await connect({ role: 'tv', deviceId: 'tv-device-2' });
  await h.request('queue.add', { songId: songId('hello'), singerName: 'Dora' });
  let st = await h.settle();
  assert.equal(st.player.state, 'playing');
  tv.close();
  await new Promise((r) => setTimeout(r, 100));
  st = await h.settle();
  assert.equal(st.player.state, 'paused');
  assert.equal(st.player.displayLost, true);
  tv = await connect({ role: 'tv', deviceId: 'tv-device-2' });
  st = await h.settle();
  assert.equal(st.player.state, 'playing');
  assert.equal(st.player.displayLost, false);

  const g = await guest('guest-dddd-1', 'Eve');
  await h.request('guest.ban', { deviceId: 'guest-dddd-1' });
  const bye = await g.waitFor((m) => m.t === 'denied');
  assert.equal(bye.code, 'banned');
  const again = await guest('guest-dddd-1');
  assert.equal(again.welcome.t, 'denied');
  await h.request('guest.ban', { deviceId: 'guest-dddd-1', banned: false });
  const ok = await guest('guest-dddd-1');
  assert.equal(ok.welcome.t, 'welcome');
  await h.request('player.stop');
  for (const c of [h, tv, ok]) c.close();
});

test('settings over WebSocket; PIN change invalidates host tokens', async () => {
  const h = await host();
  const token = h.welcome.token;
  assert.ok(app.auth.verify(token, 'host'));
  await h.request('settings.update', { patch: { party: { name: 'Friday Night', adminPin: '2468' } } });
  assert.equal(app.settings.get('party.name'), 'Friday Night');
  assert.equal(app.auth.verify(token, 'host'), null);
  const st = await h.settle();
  assert.equal(st.party.name, 'Friday Night');
  await h.request('settings.update', { patch: { party: { adminPin: '' } } });
  h.close();
});

test('guests cannot use host commands; reactions reach the TV', async () => {
  const tv = await connect({ role: 'tv', deviceId: 'tv-device-3' });
  const g = await guest('guest-eeee-1', 'Finn');
  await assert.rejects(g.request('player.next'), /Not allowed/);
  await assert.rejects(g.request('settings.update', { patch: {} }), /Not allowed/);
  g.send('reaction', { emoji: '🔥' });
  const r = await tv.waitFor((m) => m.t === 'reaction');
  assert.equal(r.emoji, '🔥');
  assert.equal(r.name, 'Finn');
  tv.close();
  g.close();
});

test('remote host access needs the PIN (token via /api/auth/pin)', async () => {
  app.settings.update({ party: { trustLocalhost: false, adminPin: '' } });
  try {
    const noPin = await host();
    assert.equal(noPin.welcome.t, 'denied');
    assert.equal(noPin.welcome.code, 'pin');
    app.settings.update({ party: { adminPin: '1357' } });
    const post = (pin) => fetch(`http://127.0.0.1:${app.port}/api/auth/pin`, { method: 'POST', body: JSON.stringify({ pin }) });
    assert.equal((await post('0000')).status, 403);
    const ok = await post('1357');
    assert.equal(ok.status, 200);
    const { token } = await ok.json();
    const settingsRes = await fetch(`http://127.0.0.1:${app.port}/api/settings`);
    assert.equal(settingsRes.status, 403, 'no token -> no settings');
    const withToken = await fetch(`http://127.0.0.1:${app.port}/api/settings`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(withToken.status, 200);
    const h = await connect({ role: 'host', deviceId: 'remote-host', token });
    assert.equal(h.welcome.t, 'welcome');
    h.close();
  } finally {
    app.settings.update({ party: { trustLocalhost: true, adminPin: '' } });
  }
});
