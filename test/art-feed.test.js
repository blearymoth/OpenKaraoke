// Artwork on the clients: `art` events with a sequence number, replays for pages that were
// offline, and mystery songs kept secret from guests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtFeed } from '../server/artwork/feed.js';
import { setupRoom } from './room-harness.js';

const nothingSecret = () => ({ songs: new Set(), artists: new Set(), openSongs: new Set(), openArtists: new Set() });

function fakeHub() {
  const clients = { host: { role: 'host', inbox: [] }, tv: { role: 'tv', inbox: [] }, guest: { role: 'guest', inbox: [] } };
  return {
    clients,
    broadcast(msg, filter) {
      for (const c of Object.values(clients)) if (!filter || filter(c)) c.inbox.push(structuredClone(msg));
    },
  };
}

test('feed: every event has a growing seq; replays send what a page missed, or "all" when too old', () => {
  let t = 1_000_000;
  const hub = fakeHub();
  const feed = new ArtFeed({ hub, secrets: nothingSecret, now: () => t });
  const start = feed.seq;
  assert.deepEqual(feed.replay('host', undefined), { seq: start }, 'first connect: just the current seq');
  feed.publish({ songs: ['s1'], artists: ['a1'] });
  feed.publish({ songs: ['s2', 's1'], artists: [] });
  const [e1, e2] = hub.clients.host.inbox;
  assert.ok(e1.seq > start && e2.seq > e1.seq);
  assert.deepEqual(hub.clients.tv.inbox.map((m) => m.songs), [['s1'], ['s2', 's1']]);
  assert.deepEqual(hub.clients.guest.inbox.map((m) => m.songs), [['s1'], ['s2', 's1']]);
  // A page that saw e1 missed e2; one that saw everything gets nothing.
  assert.deepEqual(feed.replay('guest', e1.seq), { seq: e2.seq, songs: ['s2', 's1'], artists: [] });
  assert.deepEqual(feed.replay('guest', e2.seq), { seq: e2.seq });
  assert.deepEqual(feed.replay('guest', start), { seq: e2.seq, songs: ['s2', 's1'], artists: ['a1'] });
  // From before this server started (a restart), or from the future: everything may have changed.
  assert.equal(feed.replay('guest', start - 5).all, true);
  assert.equal(feed.replay('guest', e2.seq + 100).all, true);
  assert.deepEqual(feed.replay('guest', 'junk'), { seq: e2.seq });
  // The seq follows the clock (so it keeps growing across restarts) and never goes back.
  t += 60_000;
  feed.publish({ songs: ['s3'] });
  assert.equal(hub.clients.host.inbox.at(-1).seq, t);
  t -= 120_000;
  feed.publish({ songs: ['s4'] });
  assert.equal(hub.clients.host.inbox.at(-1).seq, t + 120_000 + 1);
});

test('feed: huge batches become "all"; the replay log is bounded', () => {
  const hub = fakeHub();
  const feed = new ArtFeed({ hub, secrets: nothingSecret });
  const start = feed.seq;
  const many = Array.from({ length: 700 }, (_, i) => `s${i}`);
  feed.publish({ songs: many });
  const m = hub.clients.guest.inbox.at(-1);
  assert.equal(m.all, true);
  assert.deepEqual(m.songs, []);
  assert.equal(feed.replay('guest', start).all, true, 'too many to replay one by one');
  for (let i = 0; i < 100; i++) feed.publish({ songs: Array.from({ length: 300 }, (_, j) => `x${i}-${j}`) });
  assert.ok(feed.logIds <= 20_000);
  assert.equal(feed.replay('host', start).all, true, 'older than the log');
  const last = hub.clients.host.inbox.at(-2).seq;
  assert.equal(feed.replay('host', last).songs.length, 300);
});

test('feed: guests are not told about secret songs until they are out in the open', () => {
  const hub = fakeHub();
  const v = { songs: new Set(['mystery']), artists: new Set(['blondie']), openSongs: new Set(['open']), openArtists: new Set(['adele']) };
  const feed = new ArtFeed({ hub, secrets: () => v });
  const start = feed.seq;
  feed.publish({ songs: ['open', 'mystery'], artists: ['adele', 'blondie'] });
  assert.deepEqual(hub.clients.host.inbox[0].songs, ['open', 'mystery']);
  assert.deepEqual(hub.clients.tv.inbox[0].artists, ['adele', 'blondie']);
  assert.deepEqual(hub.clients.guest.inbox.map((m) => [m.songs, m.artists]), [[['open'], ['adele']]]);
  feed.publish({ songs: ['mystery'] });
  assert.equal(hub.clients.guest.inbox.length, 1, 'nothing at all for guests');
  assert.deepEqual(feed.replay('guest', start), { seq: feed.seq, songs: ['open'], artists: ['adele'] });
  assert.deepEqual(feed.replay('host', start).songs.sort(), ['mystery', 'open']);
  feed.release();
  assert.equal(hub.clients.guest.inbox.length, 1, 'still a secret');
  // The song starts: it's out in the open now.
  v.songs.clear();
  v.artists.clear();
  v.openSongs.add('mystery');
  v.openArtists.add('blondie');
  feed.release();
  const released = hub.clients.guest.inbox.at(-1);
  assert.deepEqual([released.songs, released.artists], [['mystery'], ['blondie']]);
  assert.equal(hub.clients.host.inbox.length, 2, 'hosts had it already');
  feed.release();
  assert.equal(hub.clients.guest.inbox.length, 2, 'released once');
  assert.deepEqual(feed.replay('guest', start).songs.sort(), ['mystery', 'open']);
});

test('feed: a mystery entry that leaves the queue unplayed keeps its secret', () => {
  const hub = fakeHub();
  const v = { songs: new Set(['mystery']), artists: new Set(['blondie']), openSongs: new Set(), openArtists: new Set() };
  const feed = new ArtFeed({ hub, secrets: () => v });
  const start = feed.seq;
  feed.publish({ songs: ['mystery'], artists: ['blondie'] });
  // Removed (by its guest, the host, or a cleared queue): no secret any more, but not out in the open either.
  v.songs.clear();
  v.artists.clear();
  feed.release();
  const told = () => JSON.stringify(hub.clients.guest.inbox);
  assert.equal(hub.clients.guest.inbox.length, 0, 'removing it gives nothing away');
  assert.deepEqual(feed.replay('guest', start), { seq: feed.seq, songs: [], artists: [] }, 'nor does a replay');
  // Another lookup right after the removal would give it away just the same.
  feed.publish({ songs: ['mystery', 'other'], artists: ['blondie'] });
  assert.ok(!told().includes('mystery') && !told().includes('blondie') && told().includes('other'));
  assert.deepEqual(feed.replay('guest', start).songs, ['other']);
  assert.deepEqual(feed.replay('host', start).songs.sort(), ['mystery', 'other']);
  // Queued again as a mystery: still nothing. Then someone queues it openly: now guests may know.
  v.songs.add('mystery');
  v.artists.add('blondie');
  feed.release();
  assert.ok(!told().includes('mystery'));
  v.songs.clear();
  v.artists.delete('blondie');
  v.openSongs.add('mystery');
  feed.release();
  assert.deepEqual([hub.clients.guest.inbox.at(-1).songs, hub.clients.guest.inbox.at(-1).artists], [['mystery'], []], 'the artist waits until it is open too');
  v.openArtists.add('blondie');
  feed.publish({ artists: ['blondie'] });
  assert.deepEqual(hub.clients.guest.inbox.at(-1).artists, ['blondie'], 'an open one is told directly');
  assert.equal(feed.withheld.songs.size + feed.withheld.artists.size, 0);
});

test('room: a queued mystery song and its artist never reach guests in `art` events until it plays', async () => {
  const { app, connect, guest, req, song, flush } = await setupRoom();
  const host = await connect('host');
  const tv = await connect('tv');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const hello = song('hello');
  const callMe = song('call me');
  const blondie = callMe.artistKeys[0];
  await req(host, 'queue.add', { songId: hello.id, singerName: 'Zed' });
  await req(ben, 'queue.add', { songId: callMe.id, mystery: true });
  flush();
  const before = app.artFeed.seq;
  // The lookups of the queued songs (and their artists) find art.
  app.artwork.emit('art', { songs: [hello.id, callMe.id], artists: [hello.artistKeys[0], blondie] });
  const artOf = (c) => c.inbox.filter((m) => m.t === 'art');
  assert.deepEqual(artOf(host).at(-1).songs, [hello.id, callMe.id]);
  assert.deepEqual(artOf(tv).at(-1).artists, [hello.artistKeys[0], blondie]);
  for (const g of [ana, ben]) {
    const text = JSON.stringify(artOf(g));
    assert.ok(text.includes(hello.id));
    assert.ok(!text.includes(callMe.id) && !text.includes(`"${blondie}"`), 'the surprise stays a surprise');
  }
  const replay = app.artFeed.replay('guest', before);
  assert.deepEqual([replay.songs, replay.artists], [[hello.id], [hello.artistKeys[0]]], 'a reconnecting guest gets no hint either');
  // The mystery song starts: now everyone may know, and guests get the cover.
  const entry = app.room.s.queue.find((e) => e.mystery);
  await req(host, 'player.play', { entryId: entry.id });
  flush();
  const last = artOf(ana).at(-1);
  assert.deepEqual([last.songs, last.artists], [[callMe.id], [blondie]]);
  assert.ok(app.artFeed.replay('guest', before).songs.includes(callMe.id));
});

test('room: a mystery entry removed unplayed (by its guest, the host, a cleared queue) gives nothing away', async () => {
  const { app, connect, guest, req, song, flush } = await setupRoom({ queue: { guestCanRemoveOwn: true } });
  const host = await connect('host');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const hello = song('hello');
  const callMe = song('call me');
  const blondie = callMe.artistKeys[0];
  const before = app.artFeed.seq;
  const leaked = () => [ana, ben].some((g) => {
    const text = JSON.stringify(g.inbox.filter((m) => m.t === 'art'));
    return text.includes(callMe.id) || text.includes(`"${blondie}"`);
  });
  const replayLeaks = () => {
    const r = app.artFeed.replay('guest', before);
    return r.songs.includes(callMe.id) || r.artists.includes(blondie);
  };
  const mysteryEntry = () => app.room.s.queue.find((e) => e.mystery);
  await req(host, 'queue.add', { songId: hello.id, singerName: 'Zed' });
  await req(ben, 'queue.add', { songId: callMe.id, mystery: true });
  flush();
  app.artwork.emit('art', { songs: [callMe.id], artists: [blondie] });
  assert.ok(!leaked());

  await req(ben, 'queue.remove', { entryId: mysteryEntry().id });
  flush();
  assert.ok(!leaked(), 'Ben took it back');
  assert.ok(!replayLeaks(), 'nor in a reconnecting guest\'s replay');
  // A lookup that finishes after the removal must not tell either.
  app.artwork.emit('art', { songs: [callMe.id], artists: [blondie] });
  flush();
  assert.ok(!leaked() && !replayLeaks());

  // Queued again as a surprise: still a surprise, and the host removing it doesn't tell.
  await req(ben, 'queue.add', { songId: callMe.id, mystery: true });
  flush();
  const shown = ana.inbox.filter((m) => m.t === 'state').at(-1).state.queue.map((e) => [e.title, e.songId]);
  assert.deepEqual(shown, [[hello.title, hello.id], ['Surprise!', null]]);
  assert.ok(!leaked());
  await req(host, 'queue.remove', { entryId: mysteryEntry().id });
  flush();
  assert.ok(!leaked() && !replayLeaks(), 'the host removed it');
  await req(ben, 'queue.add', { songId: callMe.id, mystery: true });
  flush();
  await req(host, 'queue.clear', {});
  flush();
  assert.ok(!leaked() && !replayLeaks(), 'the queue was cleared');

  // Once it's sung, guests may know (and need the new cover).
  await req(ben, 'queue.add', { songId: callMe.id, mystery: true });
  flush();
  await req(host, 'player.play', { entryId: mysteryEntry().id });
  flush();
  const last = ana.inbox.filter((m) => m.t === 'art').at(-1);
  assert.deepEqual([last.songs, last.artists], [[callMe.id], [blondie]]);
  assert.ok(replayLeaks(), 'no secret any more');
});
