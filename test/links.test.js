// Songs from a link (server/room/links.js, PLAN §31.12): guests ask when the host allows it; the
// limits; the host decides (with their own lyrics), the maker makes it, it is queued for the guest
// and their phone is told; deny, cancel, a failure and trying again; a ban; a restart; requests
// that follow a signed-in account to another phone; host only where it should be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setupRoom } from './room-harness.js';
import { fakeAutokaraoke } from '../server/maker/fake.js';

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const YT = (id) => `https://youtu.be/${id}`;
const IDS = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', '9bZkp7q19f0', 'OPf0YbXqDm0', 'JGwWNGJdvx8', 'hT_nvWreIhg'];
const notices = (c) => c.inbox.filter((m) => m.t === 'notify' && m.kind === 'link');

async function party(t, opts = {}) {
  const tool = fakeAutokaraoke({ seconds: 0.1, ...opts });
  const r = await setupRoom({}, { makerTool: tool });
  t.after(() => r.app.close());
  await until(() => r.room.maker.checks);
  return { ...r, tool, host: await r.connect('host') };
}

test('links: off until the host allows them; then a guest asks, the host says yes, it is made and queued for them', async (t) => {
  const { app, room, req, guest, host, view, tool, s } = await party(t, { lookupHit: '' });
  const ana = await guest('Ana');
  await assert.rejects(req(ana, 'link.add', { url: YT(IDS[0]) }), /isn’t taking song links/);
  assert.equal(view(ana).rules.links, null, 'the phone shows no link card');
  app.settings.update({ maker: { guestLinks: true } });
  assert.deepEqual(view(ana).rules.links, { maxPerGuest: 2 });

  await assert.rejects(req(ana, 'link.add', { url: 'https://vimeo.com/1234' }), /Only YouTube/);
  const asked = await req(ana, 'link.add', { url: `https://www.youtube.com/watch?v=${IDS[0]}&list=PL1`, lyrics: 'Never gonna give you up\nNever gonna let you down', title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
  assert.equal(asked.state, 'pending');
  assert.equal(asked.owner, undefined, 'a guest’s view has no owner ids');
  assert.equal(room.hostView().linkCounts.pending, 1);
  const forHost = room.hostView().links[0];
  assert.equal(forHost.name, 'Ana');
  assert.equal(forHost.url, `https://www.youtube.com/watch?v=${IDS[0]}`, 'the link reduced to the video');
  assert.equal(forHost.lyricsText, 'Never gonna give you up\nNever gonna let you down');
  assert.deepEqual(view(ana).me.links.map((l) => l.state), ['pending']);

  // Guests can't decide.
  await assert.rejects(req(ana, 'link.approve', { id: asked.id }), /not allowed/);
  // The host corrects the lyrics and says yes.
  await req(host, 'link.approve', { id: asked.id, lyrics: 'Never gonna give you up\nNever gonna let you down\nNever gonna run around' });
  await until(() => room.links.list[0].state === 'done');
  const r = room.links.list[0];
  const run = tool.state.runs.find((x) => x.kind === 'make');
  assert.equal(run.opts.song, `https://www.youtube.com/watch?v=${IDS[0]}`);
  assert.deepEqual(run.opts.lyricsSources, [], 'typed lyrics: no lookup');
  const job = room.maker.jobs.find((j) => j.tag === r.id);
  assert.match(job.lyrics, /run around/, 'the host’s lyrics win over the guest’s');
  assert.ok(r.songId && app.library.catalog.song(r.songId), 'in the library');
  const entry = [...s().queue, s().current].find((e) => e?.songId === r.songId);
  assert.ok(entry, 'queued');
  assert.equal(entry.addedBy, ana.data.deviceId, 'for the guest who asked');
  assert.equal(entry.source, 'link');
  assert.equal(room.singer(entry.singerIds[0]).name, 'Ana');
  const told = notices(ana).at(-1);
  assert.deepEqual([told.state, told.queued], ['done', true]);
  assert.equal(view(ana).me.links[0].state, 'done');

  // The same video again: it's in the library.
  await assert.rejects(req(ana, 'link.add', { url: YT(IDS[0]) }), /in the library already/);
});

test('links: the limits — per guest, duplicates, too many waiting, per phone', async (t) => {
  const { app, room, req, guest } = await party(t);
  app.settings.update({ maker: { guestLinks: true, maxPerGuest: 2 } });
  const ana = await guest('Ana');
  const bo = await guest('Bo');
  await req(ana, 'link.add', { url: YT(IDS[0]) });
  await assert.rejects(req(bo, 'link.add', { url: YT(IDS[0]) }), /already asked for that song/);
  await req(ana, 'link.add', { url: YT(IDS[1]) });
  await assert.rejects(req(ana, 'link.add', { url: YT(IDS[2]) }), /limit is 2/);
  app.settings.update({ maker: { maxPerGuest: 0, maxWaiting: 3 } });
  await req(ana, 'link.add', { url: YT(IDS[2]) });
  await assert.rejects(req(bo, 'link.add', { url: YT(IDS[3]) }), /enough songs to make/);
  app.settings.update({ maker: { maxWaiting: 50 } });
  await assert.rejects(req(ana, 'link.add', { url: YT(IDS[4]) }), /Slow down/, '3 in 10 minutes from one phone');
  assert.equal(room.links.counts().pending, 3);
  app.settings.update({ maker: { maxPerGuest: 99 } });
  assert.equal(app.settings.get('maker.maxPerGuest'), 10, 'clamped');
});

test('links: deny, cancel (own only), a failure tried again, a ban', async (t) => {
  const { app, room, req, guest, host, tool } = await party(t);
  app.settings.update({ maker: { guestLinks: true, maxPerGuest: 0 } });
  const ana = await guest('Ana');
  const bo = await guest('Bo');
  const a = await req(ana, 'link.add', { url: YT(IDS[0]) });
  await req(host, 'link.deny', { id: a.id, reason: 'Not tonight' });
  assert.equal(room.links.find(a.id).state, 'denied');
  assert.deepEqual([notices(ana).at(-1).state, notices(ana).at(-1).reason], ['denied', 'Not tonight']);
  await assert.rejects(req(host, 'link.approve', { id: a.id }), /already decided/);

  const b = await req(ana, 'link.add', { url: YT(IDS[1]) });
  await assert.rejects(req(bo, 'link.cancel', { id: b.id }), /gone/, 'not someone else’s');
  await req(ana, 'link.cancel', { id: b.id });
  assert.equal(room.links.find(b.id).state, 'cancelled');

  tool.state.fail = 'make';
  const c = await req(ana, 'link.add', { url: YT(IDS[2]) });
  await req(host, 'link.approve', { id: c.id });
  await until(() => room.links.find(c.id).state === 'failed');
  assert.match(room.links.find(c.id).error, /alignment failed/);
  assert.equal(notices(ana).at(-1).state, 'failed');
  tool.state.fail = '';
  await req(host, 'link.retry', { id: c.id });
  await until(() => room.links.find(c.id).state === 'done');

  await req(host, 'link.remove', { id: a.id });
  assert.throws(() => room.links.find(a.id), /gone/);
  const d = await req(bo, 'link.add', { url: YT(IDS[3]) });
  await req(host, 'guest.ban', { deviceId: bo.data.deviceId });
  assert.equal(room.links.find(d.id).state, 'cancelled', 'a banned guest’s requests go');
  await req(host, 'link.clear');
  assert.equal(room.links.list.length, 0);
});

test('links: the host asks (approved at once); an approved request is made after a restart', async (t) => {
  const { room, req, host } = await party(t);
  const mine = await req(host, 'link.add', { url: YT(IDS[0]), title: 'Host Pick' });
  assert.ok(['queued', 'working'].includes(mine.state), 'no decision needed');
  await until(() => room.links.find(mine.id).state === 'done');
  // A request approved, then the server stopped before it was made.
  const r = { ...room.links.find(mine.id), id: 'feedbeef0001', videoId: IDS[1], url: `https://www.youtube.com/watch?v=${IDS[1]}`, state: 'working', jobId: 'gone', songId: null, trackId: null };
  room.links.list.unshift(r);
  await room.links.doc.flush();
  const raw = JSON.parse(await fs.readFile(room.links.doc.file, 'utf8'));
  room.links.doc.data = raw;
  await room.links.load();
  assert.equal(room.links.find('feedbeef0001').state, 'queued', 'working → queued on a restart');
  room.links.resume();
  await until(() => room.links.find('feedbeef0001').state === 'done');
});

test('links: a signed-in guest’s requests follow their account to another phone', async (t) => {
  const { app, room, req, guest, connect, view } = await party(t);
  app.settings.update({ maker: { guestLinks: true } });
  const ann = await guest('Ann');
  const acct = await req(ann, 'account.create', { username: 'ann', password: 'secret12' });
  const phone1 = await connect('guest', { token: acct.token });
  await req(phone1, 'link.add', { url: YT(IDS[0]) });
  const phone2 = await connect('guest', {}, { local: false });
  const login = await req(phone2, 'account.login', { username: 'ann', password: 'secret12' });
  const signedIn = await connect('guest', { token: login.token }, { local: false });
  assert.deepEqual(view(signedIn).me.links.map((l) => l.state), ['pending'], 'the same requests on the other phone');
  const stranger = await guest('Cy');
  assert.deepEqual(view(stranger).me.links, []);
  assert.ok(room);
});
