// Remote TV displays: pairing codes approved by the host, forgetting paired screens,
// and the host's live preview (a muted mirror that is never the main display).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

test('pairing: a remote screen shows a code, the host approves it, the token works until forgotten', async () => {
  const { app, room, connect, req, view } = await setupRoom();
  const host = await connect('host');
  assert.equal((await connect('tv', {}, { local: false })).denied, 'pairing_required');
  const { id, code } = room.pairRequest('192.168.1.60');
  assert.match(code, /^\d{4}$/);
  assert.equal(view(host).pairings[0].code, code);
  assert.equal(view(host).pairings[0].ip, '192.168.1.60');
  assert.ok(host.inbox.some((m) => m.t === 'toast' && m.text.includes(code)));
  assert.deepEqual(room.pairStatus(id), { status: 'waiting' });
  assert.deepEqual(room.pairStatus('nope'), { status: 'expired' });
  const guest = await connect('guest');
  await req(guest, 'guest.update', { name: 'Eve' });
  await assert.rejects(req(guest, 'display.approve', { id }), /not allowed/);
  await req(host, 'display.approve', { code });
  const r = room.pairStatus(id);
  assert.equal(r.status, 'approved');
  assert.match(r.token, /^tv\./);
  assert.deepEqual(room.pairStatus(id), { status: 'expired' }, 'the token is handed out once');
  assert.equal(view(host).pairings.length, 0);
  const tv = await connect('tv', { token: r.token }, { local: false });
  assert.equal(tv.denied, undefined);
  assert.equal(tv.welcome.display, 'main');
  assert.equal(view(host).displays[0].ip, '192.168.1.50');
  await req(host, 'display.forget');
  assert.ok(tv.inbox.some((m) => m.t === 'denied' && m.reason === 'pairing_required'));
  assert.equal((await connect('tv', { token: r.token }, { local: false })).denied, 'pairing_required', 'forgotten');
  assert.equal(app.auth.tvVersion, 2);
});

test('pairing: deny, unknown codes, rate limit per address', async () => {
  const { room, connect, req } = await setupRoom();
  const host = await connect('host');
  const { id } = room.pairRequest('10.0.0.9');
  await req(host, 'display.deny', { id });
  assert.deepEqual(room.pairStatus(id), { status: 'denied' });
  await assert.rejects(req(host, 'display.approve', { id }), /no longer waiting/);
  await assert.rejects(req(host, 'display.approve', { code: '0000' }), /no longer waiting/);
  for (let i = 0; i < 4; i++) room.pairRequest('10.0.0.9');
  assert.throws(() => room.pairRequest('10.0.0.9'), /Too many pairing attempts/);
  assert.doesNotThrow(() => room.pairRequest('10.0.0.10'));
});

test('host preview: a muted mirror that never counts as (or becomes) the main display', async () => {
  const { connect, view, leave, app } = await setupRoom();
  const host = await connect('host');
  const preview = await connect('tv', { display: 'preview' });
  assert.equal(preview.welcome.display, 'mirror');
  assert.deepEqual(view(host).displays, []);
  const tv = await connect('tv');
  assert.equal(tv.welcome.display, 'main', 'the real TV is still the main display');
  leave(tv);
  assert.equal(preview.data.display, 'mirror', 'the preview never takes over the sound');
  // A remote host with a PIN token may watch the preview; a random phone may not.
  app.settings.update({ party: { adminPin: '4321' } });
  const token = app.auth.loginWithPin('4321', 'x');
  assert.equal((await connect('tv', { display: 'preview', hostToken: token }, { local: false })).denied, undefined);
  assert.equal((await connect('tv', { display: 'preview', hostToken: 'host.x.y' }, { local: false })).denied, 'pairing_required');
});
