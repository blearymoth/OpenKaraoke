import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree } from './helpers.js';

const FILES = {};
const SONGS = [
  'Adele - Hello [SF Karaoke]',
  'Adele - Hello [ZM Karaoke]',
  'Queen - Bohemian Rhapsody [SF Karaoke]',
  'Queen - Killer Queen (Explicit) [SF Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
  'ABBA - Waterloo [SF Karaoke]',
];
for (const name of SONGS) {
  const letter = name[0];
  const artist = name.split(' - ')[0];
  FILES[`${letter}/${artist}/${name}.cdg`] = 7200 * 200;
  FILES[`${letter}/${artist}/${name}.mp3`] = 100;
}

async function setup(settings = {}) {
  const lib = await tmpDir('ok-lib-');
  await writeTree(lib, FILES);
  const dataDir = await tmpDir('ok-data-');
  const app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false });
  await app.library.scan();
  app.settings.update({ playback: { countdown: 0 }, ...settings });
  const room = app.room;

  const connect = async (role, hello = {}, { local = true } = {}) => {
    const c = {
      id: crypto.randomBytes(4).toString('hex'), role: null, data: {}, isLocal: local, ip: local ? '127.0.0.1' : '192.168.1.50',
      open: true, inbox: [],
      send(m) { this.inbox.push(m); },
      sendRaw(t) { this.inbox.push(JSON.parse(t)); },
      close() { this.open = false; },
    };
    const r = await room.hello(c, { role, room: app.settings.get('party.roomCode'), ...hello });
    if (!r.ok) return { denied: r.reason };
    c.role = r.role;
    c.welcome = r.welcome;
    app.hub.clients.set(c.id, c);
    room.onJoin(c);
    return c;
  };
  const leave = (c) => {
    app.hub.clients.delete(c.id);
    c.open = false;
    room.onLeave(c);
  };
  const req = (c, t, body = {}) => room.request(c, { t, ...body });
  const song = (q) => app.library.catalog.search(q).items[0];
  const guest = async (name) => {
    const c = await connect('guest');
    await req(c, 'guest.update', { name, emoji: '🦄' });
    return c;
  };
  const flush = () => room.flush();
  return { app, room, connect, leave, req, song, guest, flush, s: () => room.s };
}

test('guest joins, gets a device token and queues a song', async () => {
  const { app, connect, req, song, s } = await setup();
  const c = await connect('guest');
  assert.ok(c.welcome.token && c.welcome.deviceId);
  assert.equal(c.welcome.state.info.roomCode, app.settings.get('party.roomCode'));
  await assert.rejects(req(c, 'queue.add', { songId: song('hello').id }), /name/, 'needs a name first');
  const { profile } = await req(c, 'guest.update', { name: '  Ana  ', emoji: '🦊', color: '#45e2a6' });
  assert.equal(profile.name, 'Ana');
  const res = await req(c, 'queue.add', { songId: song('hello').id });
  assert.equal(res.pending, false);
  assert.equal(s().queue.length, 1);
  assert.equal(s().queue[0].singerIds[0], profile.singerId);
  assert.equal(s().singers[0].name, 'Ana');

  const again = await connect('guest', { token: c.welcome.token });
  assert.equal(again.welcome.deviceId, c.welcome.deviceId, 'token keeps the identity');
  assert.equal(again.welcome.token, undefined);
  assert.equal((await connect('guest', { room: 'ZZZZ' })).denied, 'bad_room');
  assert.equal((await connect('guest', { token: 'guest.fake.sig' })).welcome.deviceId === c.welcome.deviceId, false);
});

test('guest limits: per-guest maximum, repeats, explicit filter, closed requests', async () => {
  const { app, req, song, guest } = await setup({ queue: { maxPerGuest: 2, explicitFilter: true, allowRepeats: false } });
  const a = await guest('Ana');
  const b = await guest('Ben');
  await req(a, 'queue.add', { songId: song('hello').id });
  await assert.rejects(req(b, 'queue.add', { songId: song('hello').id }), /already sang or queued/);
  await assert.rejects(req(a, 'queue.add', { songId: song('killer queen').id }), /Explicit/);
  await req(a, 'queue.add', { songId: song('waterloo').id });
  await assert.rejects(req(a, 'queue.add', { songId: song('call me').id }), /limit is 2/);
  app.settings.update({ party: { guestsEnabled: false } });
  await assert.rejects(req(b, 'queue.add', { songId: song('call me').id }), /closed/);
});

test('approval mode: requests wait for the host', async () => {
  const { connect, req, song, guest, s } = await setup({ queue: { requireApproval: true } });
  const host = await connect('host');
  const a = await guest('Ana');
  const r = await req(a, 'queue.add', { songId: song('hello').id });
  assert.equal(r.pending, true);
  assert.equal(s().pending.length, 1);
  assert.equal(s().queue.length, 0);
  assert.ok(host.inbox.some((m) => m.t === 'toast' && /Ana requested/.test(m.text)));
  await assert.rejects(req(a, 'queue.approve', { entryId: s().pending[0].id }), /not allowed/);
  await req(host, 'queue.approve', { entryId: s().pending[0].id });
  assert.equal(s().queue.length, 1);
  assert.ok(a.inbox.some((m) => m.t === 'notify' && m.kind === 'approved'));
});

test('fair rotation across guests', async () => {
  const { req, song, guest, s } = await setup({ queue: { newcomersFirst: false } });
  const a = await guest('Ana');
  const b = await guest('Ben');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(a, 'queue.add', { songId: song('waterloo').id });
  await req(b, 'queue.add', { songId: song('call me').id });
  const names = s().queue.map((e) => s().singers.find((x) => x.id === e.singerIds[0]).name);
  assert.deepEqual(names, ['Ana', 'Ben', 'Ana']);
});

test('player: intro → playing with the TV → ended → next song', async () => {
  const { app, connect, req, song, guest, flush, s } = await setup();
  const host = await connect('host');
  const a = await guest('Ana');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Bob' });
  const tv = await connect('tv');
  assert.equal(tv.data.display, 'main');
  const tv2 = await connect('tv');
  assert.equal(tv2.data.display, 'mirror', 'second TV mirrors');

  await req(host, 'player.play');
  const entry = s().current;
  assert.equal(entry.title, 'Hello');
  assert.equal(s().player.state, 'intro');
  assert.ok(a.inbox.some((m) => m.t === 'notify' && m.kind === 'now'), 'singer told it is their turn');

  flush();
  const tvState = tv.inbox.filter((m) => m.t === 'state').at(-1).state;
  assert.equal(tvState.current.media.kind, 'cdg');
  assert.match(tvState.current.media.audio, /^\/media\/.+\/audio$/);

  await req(tv2, 'tv.ready', { entryId: entry.id, dur: 200 });
  assert.equal(s().player.tvReady, false, 'mirrors are ignored');
  await req(tv, 'tv.ready', { entryId: entry.id, dur: 200 });
  assert.equal(s().player.state, 'playing');

  await req(tv, 'tv.status', { entryId: entry.id, pos: 12.5, dur: 200, playing: true });
  assert.equal(s().player.pos, 12.5);
  assert.ok(host.inbox.some((m) => m.t === 'time' && m.pos === 12.5));

  await req(host, 'player.key', { semitones: 2 });
  await req(host, 'player.tempo', { rate: 1.1 });
  await req(host, 'player.channel', { mode: 'left' });
  await assert.rejects(req(host, 'player.channel', { mode: 'sideways' }));
  await req(host, 'player.seek', { pos: 50 });
  assert.equal(s().player.seek.pos, 50);
  await req(host, 'player.pause');
  assert.equal(s().player.state, 'paused');
  await req(host, 'player.resume');
  assert.equal(s().player.state, 'playing');

  await req(tv, 'tv.ended', { entryId: entry.id });
  assert.equal(s().tonight.history[0].title, 'Hello');
  assert.equal(s().tonight.history[0].skipped, false);
  assert.equal(s().singers.find((x) => x.name === 'Ana').sung, 1);
  assert.equal(s().stats.plays[entry.songId], 1);
  assert.equal(app.library.catalog.plays.get(entry.songId), 1);
  assert.equal(s().current.title, 'Waterloo', 'auto-advanced to the next song');
  assert.equal(s().player.state, 'intro');
  assert.equal(s().player.key, 0, 'key resets for the next song');
});

test('remembered key per song and singer; guests cannot change the player', async () => {
  const { connect, req, song, guest, s } = await setup();
  const host = await connect('host');
  const a = await guest('Ana');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(host, 'player.play');
  await req(host, 'player.key', { semitones: -3 });
  await assert.rejects(req(a, 'player.next'), /not allowed/);
  await req(host, 'player.next');
  await req(a, 'queue.add', { songId: song('hello').id });
  assert.equal(s().queue[0].key, -3, 'Ana gets her key back for Hello');
});

test('TV loss pauses; a new TV takes over; stop returns the song to the queue', async () => {
  const { connect, leave, req, song, guest, s } = await setup();
  const host = await connect('host');
  const a = await guest('Ana');
  await req(a, 'queue.add', { songId: song('hello').id });
  const tv = await connect('tv');
  await req(host, 'player.play');
  await req(tv, 'tv.ready', { entryId: s().current.id, dur: 200 });
  await req(tv, 'tv.status', { entryId: s().current.id, pos: 42, playing: true });
  leave(tv);
  assert.equal(s().player.state, 'paused');
  assert.equal(s().player.displayLost, true);
  assert.ok(host.inbox.some((m) => m.t === 'toast' && /disconnected/.test(m.text)));
  const tv2 = await connect('tv');
  assert.equal(tv2.data.display, 'main');
  await req(tv2, 'tv.ready', { entryId: s().current.id, dur: 200 });
  await req(host, 'player.resume');
  assert.equal(s().player.state, 'playing');
  const id = s().current.id;
  await req(host, 'player.stop');
  assert.equal(s().current, null);
  assert.equal(s().queue[0].id, id);
  assert.equal(s().player.state, 'idle');
});

test('guests can remove only their own songs; host can move and edit', async () => {
  const { connect, req, song, guest, s } = await setup();
  const host = await connect('host');
  const a = await guest('Ana');
  const b = await guest('Ben');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(b, 'queue.add', { songId: song('call me').id });
  const [ea, eb] = s().queue;
  await assert.rejects(req(a, 'queue.remove', { entryId: eb.id }), /own songs/);
  await req(host, 'queue.move', { entryId: eb.id, index: 0 });
  assert.equal(s().queue[0].id, eb.id);
  await req(host, 'queue.update', { entryId: ea.id, patch: { key: 9, singerName: 'Zed' } });
  assert.equal(s().queue[1].key, 6, 'key is clamped to ±6');
  assert.equal(s().singers.find((x) => x.id === s().queue[1].singerIds[0]).name, 'Zed');
  await req(a, 'queue.remove', { entryId: ea.id });
  assert.equal(s().queue.length, 1);
});

test('views: host sees masked PIN and guests; guests see their own entries and ETA', async () => {
  const { app, connect, req, song, guest, flush } = await setup({ party: { adminPin: '1234' } });
  const host = await connect('host');
  const a = await guest('Ana');
  const b = await guest('Ben');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(b, 'queue.add', { songId: song('call me').id, mystery: true });
  flush();
  const hv = host.inbox.filter((m) => m.t === 'state').at(-1).state;
  assert.equal(hv.settings.party.adminPin, '••••');
  assert.equal(hv.hasPin, true);
  assert.deepEqual(hv.guests.map((g) => g.name).sort(), ['Ana', 'Ben']);
  assert.equal(hv.queue[1].title, 'Call Me', 'host sees mystery songs');
  const gv = a.inbox.filter((m) => m.t === 'state').at(-1).state;
  assert.equal(gv.queue.length, 2);
  assert.equal(gv.queue[0].mine, true);
  assert.equal(gv.queue[1].mine, false);
  assert.equal(gv.queue[1].title, 'Surprise!', 'mystery masked for guests');
  assert.equal(gv.queue[1].eta > gv.queue[0].eta, true);
  assert.equal(gv.me.profile.name, 'Ana');
  assert.equal(gv.me.left, 2);
  assert.equal(gv._by, undefined);
  assert.ok(!JSON.stringify(gv).includes('_by'));
  app.settings.update({ queue: { guestsSeeQueue: false } });
  flush();
  const hidden = a.inbox.filter((m) => m.t === 'state').at(-1).state;
  assert.deepEqual(hidden.queue.map((e) => e.mine), [true]);
});

test('up-next notification, reactions and announcements', async () => {
  const { connect, req, song, guest, flush, room } = await setup();
  const host = await connect('host');
  const tv = await connect('tv');
  const a = await guest('Ana');
  const b = await guest('Ben');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(b, 'queue.add', { songId: song('call me').id });
  await req(host, 'player.play');
  flush();
  assert.ok(b.inbox.some((m) => m.t === 'notify' && m.kind === 'next'));
  assert.ok(!a.inbox.some((m) => m.t === 'notify' && m.kind === 'next'));

  await req(a, 'reaction', { emoji: '🔥' });
  assert.ok(tv.inbox.some((m) => m.t === 'reaction' && m.emoji === '🔥' && m.name === 'Ana'));
  await assert.rejects(req(a, 'reaction', { emoji: '💩' }));
  await req(host, 'announce', { text: 'Pizza is here!', seconds: 5 });
  flush();
  assert.equal(tv.inbox.filter((m) => m.t === 'state').at(-1).state.announcement.text, 'Pizza is here!');
  await req(host, 'announce', { text: '' });
  assert.equal(room.announcement, null);
});

test('state survives a restart (current song comes back paused)', async () => {
  const { app, connect, req, song, guest, s } = await setup();
  const host = await connect('host');
  const a = await guest('Ana');
  await req(a, 'queue.add', { songId: song('hello').id });
  await req(a, 'queue.add', { songId: song('waterloo').id });
  await req(host, 'player.play');
  s().player.pos = 33;
  const dataDir = app.dataDir;
  const libPaths = app.settings.get('library.paths');
  await app.close();

  const app2 = await createApp({ dataDir, args: { library: libPaths }, scan: false, watch: false });
  const st = app2.room.s;
  assert.equal(st.current.title, 'Hello');
  assert.equal(st.player.state, 'paused');
  assert.equal(st.player.pos, 33);
  assert.equal(st.queue.length, 1);
  assert.equal(Object.values(st.profiles)[0].name, 'Ana');
  await app2.close();
});

test('settings updates validate the room code and PIN', async () => {
  const { app, connect, req } = await setup();
  const host = await connect('host');
  await assert.rejects(req(host, 'settings.update', { patch: { party: { roomCode: 'AB1' } } }), /4 letters/);
  await assert.rejects(req(host, 'settings.update', { patch: { party: { adminPin: 'abc' } } }), /PIN/);
  await req(host, 'settings.update', { patch: { party: { roomCode: 'wxyz', name: 'Friday' } } });
  assert.equal(app.settings.get('party.roomCode'), 'WXYZ');
  assert.equal(app.settings.get('party.name'), 'Friday');
  const guest = await connect('guest', { room: 'wxyz' });
  assert.ok(guest.welcome);
  const remote = await connect('host', {}, { local: false });
  assert.equal(remote.denied, 'host_only');
});

test('auto-start: the first queued song starts when a TV is on (and only then)', async () => {
  const { app, connect, req, song, guest, s } = await setup();
  const a = await guest('Ana');
  const r1 = await req(a, 'queue.add', { songId: song('hello').id });
  assert.equal(r1.started, false, 'no TV yet');
  assert.equal(s().current, null);
  await connect('tv');
  assert.equal(s().current?.title, 'Hello', 'starts when the TV connects');
  const r2 = await req(a, 'queue.add', { songId: song('waterloo').id });
  assert.equal(r2.started, false, 'something is already on');
  app.settings.update({ playback: { autoStart: false } });
  await req(await connect('host'), 'player.stop');
  await req(a, 'queue.add', { songId: song('call me').id });
  assert.equal(s().current, null, 'auto-start can be turned off');
});
