// Per-version play counts and votes in the party: version.vote (who may vote on what), the
// default version following the votes, and what each view carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import { createApp } from '../server/app.js';
import { offlineFetch } from './fake-art.js';

async function party(settings = {}) {
  const env = await setupRoom({ playback: { countdown: 0, autoStart: false }, queue: { maxPerGuest: 0, allowRepeats: true }, ...settings });
  const { app, connect, song } = env;
  const cat = app.library.catalog;
  const hello = song('hello');
  const [sf, zm] = ['SF', 'ZM'].map((b) => hello.trackIds.map((id) => cat.track(id)).find((t) => t.p.brand === b));
  const rapture = song('rapture');
  const raptureSF = rapture.trackIds.map((id) => cat.track(id)).find((t) => t.p.brand === 'SF');
  const raptureSC = rapture.trackIds.map((id) => cat.track(id)).find((t) => t.p.brand === 'SC');
  const host = await connect('host');
  const tv = await connect('tv');
  return { ...env, cat, hello, sf, zm, rapture, raptureSF, raptureSC, host, tv };
}

/** Plays `trackId` of the song now (host), the TV ready. */
async function playNow(env, songId, trackId) {
  const { req, host, tv, s } = env;
  await req(host, 'queue.add', { songId, trackId, singerName: 'Host', position: 'now' });
  if (!s().current || s().current.trackId !== trackId) await req(host, 'player.play', { entryId: s().queue.find((e) => e.trackId === trackId)?.id });
  await req(tv, 'tv.ready', { entryId: s().current.id, dur: 200 });
  return s().current;
}

test('version votes: plays are counted for completed songs and kept across restarts and new parties', async (t) => {
  const env = await party();
  const { app, req, host, tv, s, hello, sf, zm, room } = env;
  t.after(() => app.close());
  const cur = await playNow(env, hello.id, sf.id);
  await req(tv, 'tv.ended', { entryId: cur.id });
  assert.equal(room.versions.info(sf.id).plays, 1);
  await playNow(env, hello.id, zm.id);
  await req(host, 'player.next'); // skipped right away
  assert.equal(room.versions.info(zm.id).plays, 0, 'a skip is not a play');
  await req(host, 'party.new');
  assert.equal(room.versions.info(sf.id).plays, 1, 'a new party keeps the counts');
  assert.equal(s().tonight.history.length, 0);
  await room.close({ save: true });
  const again = await createApp({ dataDir: app.dataDir, scan: false, watch: false, crawl: false, fetch: offlineFetch });
  t.after(() => again.close());
  assert.equal(again.room.versions.info(sf.id).plays, 1, 'kept in data/versions.json');
});

test('version votes: who may vote on what', async (t) => {
  const env = await party();
  const { app, req, host, guest, connect, tv, s, hello, sf, zm, room, song } = env;
  t.after(() => app.close());
  const anon = await connect('guest');
  await assert.rejects(req(anon, 'version.vote', { trackId: sf.id, vote: 1 }), (e) => e.code === 'no_profile');
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'version.vote', { trackId: sf.id, vote: 1 }), (e) => e.code === 'not_heard');
  const cur = await playNow(env, hello.id, sf.id);
  const r = await req(ana, 'version.vote', { trackId: sf.id, vote: -1 });
  assert.deepEqual([r.trackId, r.down, r.mine, r.heard, 'host' in r], [sf.id, 1, -1, true, false]);
  // Skipped tonight still counts as heard (a broken version can be voted down).
  await req(host, 'player.next');
  assert.equal(s().tonight.history[0].trackId, sf.id);
  await req(ana, 'version.vote', { trackId: sf.id, vote: 0 });
  // Bad values, unknown tracks, single-version songs.
  for (const vote of [2, '1', null]) await assert.rejects(req(ana, 'version.vote', { trackId: sf.id, vote }), (e) => e.code === 'bad_request');
  await assert.rejects(req(ana, 'version.vote', { trackId: 'zzzz9', vote: 1 }), (e) => e.code === 'not_found');
  const queen = song('bohemian');
  await assert.rejects(req(host, 'version.vote', { trackId: queen.trackIds[0], vote: 1 }), /only one version/);
  // Another device's id in the message changes nothing but the sender's vote.
  const ben = await guest('Ben');
  await req(ben, 'version.vote', { trackId: sf.id, vote: 1, deviceId: ana.data.deviceId, voter: '@host' });
  assert.deepEqual([room.versions.mine(ben.data.deviceId, sf.id), room.versions.mine(ana.data.deviceId, sf.id), room.versions.info(sf.id).host], [1, 0, 0]);
  // A co-host votes as a guest.
  await req(host, 'guest.cohost', { deviceId: ben.data.deviceId, on: true });
  await req(ben, 'version.vote', { trackId: sf.id, vote: -1 });
  assert.deepEqual([room.versions.mine(ben.data.deviceId, sf.id), room.versions.info(sf.id).host], [-1, 0]);
  // Rate limit: 20 a minute.
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    await req(ana, 'version.vote', { trackId: sf.id, vote: i % 2 ? 1 : 0 }).catch((e) => { limited = e; });
  }
  assert.equal(limited?.code, 'rate_limited');
  // The host votes on anything, any time; a new party means not heard tonight for guests.
  const h = await req(host, 'version.vote', { trackId: zm.id, vote: 1 });
  assert.deepEqual([h.host, h.mine, h.status], [1, 1, 'liked']);
  await req(host, 'party.new');
  const cy = await guest('Cy');
  await assert.rejects(req(cy, 'version.vote', { trackId: sf.id, vote: 1 }), (e) => e.code === 'not_heard');
  // The setting off: guests can't, the host still can.
  app.settings.update({ guests: { versionVotes: false } });
  await playNow(env, hello.id, sf.id);
  await assert.rejects(req(cy, 'version.vote', { trackId: sf.id, vote: 1 }), (e) => e.code === 'closed');
  await req(host, 'version.vote', { trackId: sf.id, vote: 1 });
  app.settings.update({ guests: { versionVotes: true } });
  // A ban removes that guest's votes.
  await req(cy, 'version.vote', { trackId: sf.id, vote: -1 });
  assert.equal(room.versions.mine(cy.data.deviceId, sf.id), -1);
  await req(host, 'guest.ban', { deviceId: cy.data.deviceId });
  assert.equal(room.versions.mine(cy.data.deviceId, sf.id), 0);
  void cur;
  void tv;
});

test('version votes: the explicit filter hides explicit versions from guests', async (t) => {
  const env = await party({ queue: { explicitFilter: true, maxPerGuest: 0, allowRepeats: true } });
  const { app, req, host, guest, rapture, raptureSF, raptureSC, s } = env;
  t.after(() => app.close());
  const ana = await guest('Ana');
  await playNow(env, rapture.id, raptureSF.id);
  await assert.rejects(req(ana, 'version.vote', { trackId: raptureSF.id, vote: 1 }), (e) => e.code === 'not_found');
  await req(host, 'version.vote', { trackId: raptureSF.id, vote: 1 });
  await req(host, 'player.stop');
  await req(host, 'queue.clear');
  assert.equal((await req(ana, 'queue.add', { songId: rapture.id })).entry.trackId, raptureSC.id, 'a guest gets the clean version');
  assert.equal((await req(host, 'queue.add', { songId: rapture.id, singerName: 'H' })).entry.trackId, raptureSF.id, 'the host gets the liked one');
  void s;
});

test('version votes: the default version follows the votes; explicit picks and queued songs stay', async (t) => {
  const env = await party();
  const { app, req, host, guest, hello, sf, zm, s, room } = env;
  t.after(() => app.close());
  const def = room.pickTrack(hello);
  const other = def.id === sf.id ? zm : sf;
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  await playNow(env, hello.id, def.id);
  await req(ana, 'version.vote', { trackId: def.id, vote: -1 });
  assert.equal(room.pickTrack(hello).id, def.id, 'one vote changes nothing');
  await req(ben, 'version.vote', { trackId: def.id, vote: -1 });
  assert.equal(room.pickTrack(hello).id, other.id, 'two down: the other version');
  await req(host, 'player.stop');
  await req(host, 'queue.clear');
  assert.equal((await req(ana, 'queue.add', { songId: hello.id })).entry.trackId, other.id);
  assert.equal((await req(host, 'queue.add', { songId: hello.id, singerName: 'H' })).entry.trackId, other.id);
  const queued = s().queue.map((e) => e.trackId);
  await req(host, 'version.vote', { trackId: def.id, vote: 1 });
  assert.equal(room.pickTrack(hello).id, def.id, 'the host’s vote settles it');
  assert.deepEqual(s().queue.map((e) => e.trackId), queued, 'queued songs keep their version');
  assert.equal((await req(host, 'queue.add', { songId: hello.id, singerName: 'H', trackId: other.id })).entry.trackId, other.id, 'an explicit pick is honoured');
  // A guest-liked version beats the preferred label; the host's thumbs down undoes it.
  await req(host, 'version.vote', { trackId: def.id, vote: 0 });
  await req(ana, 'version.vote', { trackId: def.id, vote: 0 });
  await req(ben, 'version.vote', { trackId: def.id, vote: 0 });
  app.settings.update({ library: { brandPriority: ['SF'] } });
  assert.equal(room.pickTrack(hello).id, sf.id);
  room.versions.vote(zm.id, ana.data.deviceId, 1);
  room.versions.vote(zm.id, ben.data.deviceId, 1);
  assert.equal(room.pickTrack(hello).id, zm.id, 'guests’ favourite over the label');
  await req(host, 'version.vote', { trackId: zm.id, vote: -1 });
  assert.equal(room.pickTrack(hello).id, sf.id);
});

test('version votes: what the views carry', async (t) => {
  const env = await party();
  const { app, req, host, guest, view, hello, sf, tv, room } = env;
  t.after(() => app.close());
  const ana = await guest('Ana');
  await playNow(env, hello.id, sf.id);
  await req(host, 'version.vote', { trackId: sf.id, vote: 1 });
  await req(ana, 'version.vote', { trackId: sf.id, vote: -1 });
  const hv = view(host).current.version;
  assert.deepEqual(hv, { label: 'Sunfly', count: 2, plays: 0, up: 1, down: 1, mine: 1, host: 1, status: 'liked' });
  const g = view(ana);
  assert.deepEqual(g.current.version, { label: 'Sunfly', count: 2, plays: 0, up: 1, down: 1 });
  assert.equal(g.me.versionVote, -1);
  assert.equal(g.rules.versionVotes, true);
  assert.equal(view(tv).current.version, undefined);
  // A vote on the current track updates everyone; one on another track sends nothing.
  room.flush();
  await req(host, 'version.vote', { trackId: sf.id, vote: 0 });
  assert.ok(room.flushTimer, 'a broadcast is on its way');
  room.flush();
  await req(host, 'version.vote', { trackId: hello.trackIds.find((id) => id !== sf.id), vote: 1 });
  assert.equal(room.flushTimer, null, 'nothing to send');
  app.settings.update({ guests: { versionVotes: false } });
  assert.equal(view(ana).me.versionVote, null);
  assert.equal(view(ana).rules.versionVotes, false);
});
