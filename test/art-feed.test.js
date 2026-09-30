// Artwork on the clients: `art` events with a sequence number, replays for pages that were
// offline, and mystery songs kept secret from guests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtFeed } from '../server/artwork/feed.js';
import { setupRoom } from './room-harness.js';

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
  const feed = new ArtFeed({ hub, secrets: () => ({ songs: new Set(), artists: new Set() }), now: () => t });
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
  const feed = new ArtFeed({ hub, secrets: () => ({ songs: new Set(), artists: new Set() }) });
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

test('feed: guests are not told about secret songs until they are no secret any more', () => {
  const hub = fakeHub();
  const secrets = { songs: new Set(['mystery']), artists: new Set(['blondie']) };
  const feed = new ArtFeed({ hub, secrets: () => secrets });
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
  secrets.songs.clear();
  secrets.artists.clear();
  feed.release();
  const released = hub.clients.guest.inbox.at(-1);
  assert.deepEqual([released.songs, released.artists], [['mystery'], ['blondie']]);
  assert.equal(hub.clients.host.inbox.length, 2, 'hosts had it already');
  feed.release();
  assert.equal(hub.clients.guest.inbox.length, 2, 'released once');
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
