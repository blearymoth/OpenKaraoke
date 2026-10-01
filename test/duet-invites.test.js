// Duet invitations between guests: what the invited phone sees, when it is asked, and the
// limits that keep one guest's phone from being buzzed over and over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

const duetNotifies = (c) => c.inbox.filter((m) => m.t === 'notify' && m.kind === 'duet');
const singerOf = (s, c) => s().profiles[c.welcome.deviceId].singerId;

test('duet invitations are part of the invitee’s view: rebuilt after a reconnect, one card per invitation', async () => {
  const { connect, leave, req, song, guest, s, view } = await setupRoom();
  await connect('host');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const carl = await guest('Carl');
  const benSinger = singerOf(s, ben);

  // Ben's phone is locked (socket gone) when Ana asks him: he never gets the notify…
  leave(ben);
  await req(ana, 'queue.add', { songId: song('waterloo').id, partners: [benSinger] });
  assert.equal(duetNotifies(ben).length, 0);
  // …but the invitation is in his state when the phone reconnects.
  const ben2 = await connect('guest', { token: ben.welcome.token });
  assert.equal(ben2.welcome.deviceId, ben.welcome.deviceId);
  let invites = view(ben2).me.invites;
  assert.equal(invites.length, 1);
  assert.equal(invites[0].entryId, s().queue[0].id);
  assert.equal(invites[0].title, 'Waterloo');
  assert.equal(invites[0].by.name, 'Ana');
  assert.equal(invites[0].position, 1);
  assert.deepEqual(view(ana).me.invites, [], 'only the invited guest gets the card');

  // A second invitation doesn't hide the first; a mystery song is revealed to the partner only.
  await req(carl, 'queue.add', { songId: song('call me').id, partners: [benSinger], mystery: true });
  assert.equal(duetNotifies(ben2).length, 1, 'an online phone is buzzed');
  invites = view(ben2).me.invites;
  assert.deepEqual(invites.map((i) => i.title), ['Waterloo', 'Call Me']);
  assert.equal(view(ben2).queue.find((e) => e.id === invites[1].entryId).title, 'Surprise!');

  await req(ben2, 'duet.answer', { entryId: invites[0].entryId, accept: false });
  assert.ok(ana.inbox.some((m) => m.t === 'notify' && m.kind === 'duet-no' && m.by === 'Ben'));
  assert.deepEqual(view(ben2).me.invites.map((i) => i.by.name), ['Carl'], 'the answered card goes away, the other stays');
  await req(ben2, 'duet.answer', { entryId: invites[1].entryId, accept: true });
  assert.deepEqual(view(ben2).me.invites, []);
  assert.deepEqual(s().queue[1].singerIds, [singerOf(s, carl), benSinger]);
});

test('with approval on, the partner is only asked once the host accepts the request', async () => {
  const { connect, req, song, guest, s, view } = await setupRoom({ queue: { requireApproval: true } });
  const host = await connect('host');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const carl = await guest('Carl');
  const benSinger = singerOf(s, ben);

  const r = await req(ana, 'queue.add', { songId: song('waterloo').id, partners: [benSinger] });
  assert.equal(r.pending, true);
  assert.deepEqual(s().pending[0].invites, [benSinger], 'kept with the request');
  assert.equal(duetNotifies(ben).length, 0, 'not asked while the host may still say no');
  assert.deepEqual(view(ben).me.invites, []);
  assert.deepEqual(view(ana).me.pending[0].invites.map((x) => x.name), ['Ben'], 'the requester sees who they invited');

  await req(carl, 'queue.add', { songId: song('call me').id, partners: [benSinger] });
  await req(host, 'queue.reject', { entryId: s().pending[1].id });
  await req(host, 'queue.approve', { entryId: s().pending[0].id });
  assert.equal(duetNotifies(ben).length, 1, 'asked once, for the approved request only');
  assert.equal(duetNotifies(ben)[0].title, 'Waterloo');
  assert.deepEqual(view(ben).me.invites.map((i) => i.title), ['Waterloo']);
});

test('duet invitation limits: one open invitation per pair, a few per guest, no re-invite loops', async () => {
  const { connect, req, song, guest, s, view } = await setupRoom({ queue: { allowRepeats: true, maxPerGuest: 0 } });
  await connect('host');
  const g = {};
  for (const name of ['Ana', 'Ben', 'Carl', 'Dave', 'Eve', 'Fay']) g[name] = await guest(name);
  const benSinger = singerOf(s, g.Ben);
  const invite = (c, q = 'waterloo') => req(c, 'queue.add', { songId: song(q).id, partners: [benSinger] });
  const mine = (c) => s().queue.find((e) => e.addedBy === c.welcome.deviceId);

  await invite(g.Ana);
  await assert.rejects(invite(g.Ana, 'call me'), /already invited Ben/);
  assert.equal(s().queue.length, 1, 'nothing queued when the invitation is refused');

  // The remove + add again loop: a few invitations get through, then Ana has to wait.
  let sent = 1;
  let error = null;
  for (let i = 0; i < 6 && !error; i++) {
    await req(g.Ana, 'queue.remove', { entryId: mine(g.Ana).id });
    try {
      await invite(g.Ana);
      sent++;
    } catch (e) {
      error = e;
    }
  }
  assert.match(error?.message || '', /asked Ben a lot/);
  assert.equal(sent, 3);
  assert.equal(duetNotifies(g.Ben).length, 3, 'Ben’s phone was buzzed 3 times, not 10');

  // Other guests: at most 3 invitations wait for Ben at a time…
  await invite(g.Carl, 'hello');
  await invite(g.Dave, 'hello');
  await invite(g.Eve, 'hello');
  await assert.rejects(invite(g.Fay, 'hello'), /enough duet invitations waiting/);
  // …and only a handful per 10 minutes whoever asks (several identities don't multiply it).
  await req(g.Ben, 'duet.answer', { entryId: mine(g.Carl).id, accept: false });
  await assert.rejects(invite(g.Fay, 'hello'), /lots of invitations/);
  assert.equal(duetNotifies(g.Ben).length, 6);

  // A "no" sticks for that song.
  await req(g.Carl, 'queue.remove', { entryId: mine(g.Carl).id });
  await assert.rejects(invite(g.Carl, 'hello'), /said no to this one/);
  await req(g.Carl, 'queue.add', { songId: song('hello').id });
  assert.deepEqual(view(g.Ben).me.invites.map((i) => i.by.name), ['Dave', 'Eve']);
});

test('guests can turn duet invitations off; start, ban and singer removal withdraw open ones', async () => {
  const { connect, req, song, guest, s, view } = await setupRoom({ queue: { allowRepeats: true } });
  const host = await connect('host');
  const ana = await guest('Ana');
  const ben = await guest('Ben');
  const carl = await guest('Carl');
  const benSinger = singerOf(s, ben);

  await req(ana, 'queue.add', { songId: song('waterloo').id, partners: [benSinger] });
  await req(carl, 'queue.add', { songId: song('call me').id, partners: [benSinger] });
  assert.ok(view(ana).partners.some((x) => x.id === benSinger));
  assert.equal(view(ben).me.profile.invites, true);

  const r = await req(ben, 'duet.invites', { allow: false });
  assert.deepEqual(r, { allow: false });
  assert.equal(view(ben).me.profile.invites, false);
  assert.deepEqual(view(ben).me.invites, [], 'open invitations are declined');
  assert.ok(s().queue.every((e) => !e.invites));
  for (const c of [ana, carl]) assert.ok(c.inbox.some((m) => m.t === 'notify' && m.kind === 'duet-no'), 'inviters are told');
  assert.equal(view(ana).partners.some((x) => x.id === benSinger), false, 'no longer offered as a partner');
  await assert.rejects(req(ana, 'queue.add', { songId: song('hello').id, partners: [benSinger] }), /isn’t taking duet invitations/);
  await req(ben, 'duet.invites', { allow: true });
  assert.ok(view(ana).partners.some((x) => x.id === benSinger));

  // The song starts before Ben answers: the invitation is over.
  await req(ana, 'queue.add', { songId: song('hello').id, partners: [benSinger] });
  const helloEntry = s().queue.at(-1);
  await req(host, 'player.play', { entryId: helloEntry.id });
  assert.equal(s().current.id, helloEntry.id);
  assert.equal(s().current.invites, undefined);
  assert.deepEqual(view(ben).me.invites, []);

  // A banned guest's invitations disappear from everyone's songs.
  await req(carl, 'queue.add', { songId: song('rapture').id, partners: [benSinger] });
  assert.ok(s().queue.some((e) => e.invites?.includes(benSinger)));
  await req(host, 'guest.ban', { deviceId: ben.welcome.deviceId });
  assert.ok(s().queue.every((e) => !e.invites), 'no "invited Ben" left behind');

  // So do invitations to a singer the host removes.
  const anaSinger = singerOf(s, ana);
  await req(carl, 'queue.add', { songId: song('bohemian').id, partners: [anaSinger] });
  assert.ok(s().queue.some((e) => e.invites?.includes(anaSinger)));
  await req(host, 'singer.remove', { singerId: anaSinger });
  assert.ok(s().queue.every((e) => !e.invites));

  const nobody = await connect('guest');
  await assert.rejects(req(nobody, 'duet.invites', { allow: false }), /Choose a name/);
  await assert.rejects(req(host, 'duet.invites', { allow: false }), /not allowed/);
});
