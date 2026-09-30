// Playlists, co-hosts and duet partners (M7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

test('playlists: save the queue, add/remove songs, queue a playlist, limits and validation', async () => {
  const { req, connect, song, s, view } = await setupRoom();
  const host = await connect('host');
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Ann' });
  await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Bo' });
  const { id } = await req(host, 'playlist.save', { name: '  Warm-up  ', fromQueue: true });
  let pl = view(host).playlists.find((p) => p.id === id);
  assert.equal(pl.name, 'Warm-up');
  assert.equal(pl.songIds.length, 2);
  await req(host, 'playlist.add', { id, songId: song('call me').id });
  await req(host, 'playlist.add', { id, songId: song('call me').id }); // no duplicates
  await assert.rejects(req(host, 'playlist.add', { id, songId: 'nope' }), /Song not found/);
  await assert.rejects(req(host, 'playlist.add', { id: 'nope', songId: song('call me').id }), /Playlist not found/);
  pl = view(host).playlists.find((p) => p.id === id);
  assert.equal(pl.songIds.length, 3);
  await req(host, 'playlist.remove', { id, songId: song('hello').id });
  await req(host, 'playlist.save', { id, name: 'Openers' });
  pl = view(host).playlists.find((p) => p.id === id);
  assert.equal(pl.name, 'Openers');
  assert.deepEqual(pl.songIds, [song('waterloo').id, song('call me').id]);
  await assert.rejects(req(host, 'playlist.save', { name: '' }), /name/);
  const junk = await req(host, 'playlist.save', { name: 'Junk', songIds: ['x', song('hello').id, 42, song('hello').id] });
  assert.deepEqual(view(host).playlists.find((p) => p.id === junk.id).songIds, [song('hello').id]);

  s().queue.length = 0;
  const r = await req(host, 'playlist.queue', { id, singerName: 'Everyone' });
  assert.deepEqual(r, { added: 2, skipped: 0 });
  assert.deepEqual(s().queue.map((e) => e.songId), [song('waterloo').id, song('call me').id]);
  await req(host, 'playlist.delete', { id });
  assert.equal(view(host).playlists.some((p) => p.id === id), false);
  const ana = await connect('guest');
  await assert.rejects(req(ana, 'playlist.save', { name: 'x' }), /not allowed/);
});

test('co-hosts: the host trusts a guest with the player and requests — nothing more', async () => {
  const { req, connect, guest, song, s, view } = await setupRoom({ queue: { requireApproval: true } });
  const host = await connect('host');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  await req(ben, 'queue.add', { songId: song('hello').id });
  await assert.rejects(req(ana, 'queue.approve', { entryId: s().pending[0].id }), /not allowed/);
  await req(host, 'guest.cohost', { deviceId: ana.welcome.deviceId, on: true });
  assert.equal(view(ana).me.profile.coHost, true);
  assert.ok(ana.inbox.some((m) => m.t === 'notify' && m.kind === 'cohost'));
  assert.equal(view(host).guests.find((g) => g.name === 'Ana').coHost, true);
  await req(ana, 'queue.approve', { entryId: s().pending[0].id });
  assert.equal(s().queue.length, 1);
  await req(ana, 'player.play');
  assert.ok(s().current);
  await req(ana, 'player.pause');
  await req(ana, 'player.key', { semitones: 2 });
  assert.equal(s().player.key, 2);
  await req(ana, 'announce', { text: 'Cake time!' });
  for (const t of ['settings.update', 'guest.ban', 'game.start', 'library.rescan', 'queue.clear', 'party.new', 'playlist.save']) {
    await assert.rejects(req(ana, t, { patch: {}, deviceId: ben.welcome.deviceId, type: 'poll', name: 'x' }), /not allowed/, t);
  }
  await req(host, 'guest.cohost', { deviceId: ana.welcome.deviceId, on: false });
  await assert.rejects(req(ana, 'player.next'), /not allowed/);
  await assert.rejects(req(host, 'guest.cohost', { deviceId: '__proto__', on: true }), /not found/);
});

test('duets from the host: partner by id or by name; queue shows both singers', async () => {
  const { req, connect, song, s, view } = await setupRoom();
  const host = await connect('host');
  await req(host, 'queue.add', { songId: song('hello').id, singerName: 'Ann', partnerName: 'Bo' });
  const e = s().queue[0];
  assert.equal(e.singerIds.length, 2);
  assert.deepEqual(view(host).queue[0].singers.map((x) => x.name), ['Ann', 'Bo']);
  const bo = e.singerIds[1];
  await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Cy', partners: [bo, 'unknown', bo] });
  assert.deepEqual(s().queue[1].singerIds.slice(1), [bo]);
});
