// The host's Devices tab: what each connected screen, host device and guest phone is (a short
// device name from its User-Agent, where it is, since when), "Identify", and that none of it
// ever reaches guests or the TV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const LG_TV = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36';

/** Every key anywhere in a view (to prove what it never carries). */
function keys(x, out = new Set()) {
  if (Array.isArray(x)) x.forEach((v) => keys(v, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keys(v, out); }
  return out;
}

test('devices: displays, host devices and guest phones, named for the host only', async (t) => {
  const { app, connect, req, view, room } = await setupRoom();
  t.after(() => app.close());
  const host = await connect('host', {}, { ua: FIREFOX_LINUX });
  assert.equal(host.data.device, 'Firefox · Linux');
  app.settings.update({ party: { adminPin: '4321' } });
  const phoneHost = await connect('host', { token: app.auth.loginWithPin('4321', 'x') }, { local: false, ua: SAFARI_IPHONE });
  const tv = await connect('tv', {}, { ua: FIREFOX_LINUX });
  const token = app.auth.sign('tv', app.auth.newId()); // a paired screen
  const mirror = await connect('tv', { display: 'mirror', token }, { local: false, ua: LG_TV });
  const board = await connect('tv', { display: 'board' });
  const mirror2 = await connect('tv', { display: 'mirror' });
  const preview = await connect('tv', { display: 'preview' });
  // Connected in this order (connectedAt).
  [host, phoneHost, tv, mirror, board, mirror2, preview].forEach((c, i) => { c.connectedAt = 1000 + i; });
  await req(tv, 'tv.audio', { unlocked: false });
  const v = view(host);
  assert.deepEqual(v.displays.map((d) => d.name), ['Main TV', 'Mirror 1', 'Queue board 1', 'Mirror 2']);
  const [main, m1] = v.displays;
  assert.deepEqual([main.local, main.device, main.audioBlocked, main.paired, main.since], [true, 'Firefox · Linux', true, false, 1002]);
  assert.deepEqual([m1.local, m1.ip, m1.device, m1.audioBlocked, m1.paired], [false, '192.168.1.50', 'LG TV', false, true]);
  assert.ok(!v.displays.some((d) => d.id === preview.id), 'the host’s own preview is not a display');
  assert.deepEqual(v.hostClients.map((h) => [h.local, h.ip, h.device]), [[true, '', 'Firefox · Linux'], [false, '192.168.1.50', 'Safari · iPhone']]);
  assert.equal(v.hosts, 2);

  // Guests: the device of their newest connection; phones still joining (no name yet) counted once.
  const ana = await connect('guest', {}, { ua: CHROME_ANDROID });
  await req(ana, 'guest.update', { name: 'Ana', emoji: '🦄' });
  const joining = await connect('guest', {}, { ua: CHROME_ANDROID });
  const joining2 = await connect('guest', { token: joining.welcome.token }, { ua: CHROME_ANDROID }); // a second tab
  assert.equal(joining2.data.deviceId, joining.data.deviceId);
  const g = view(host);
  assert.equal(g.guests.find((x) => x.name === 'Ana').device, 'Chrome · Android');
  assert.equal(g.guestsJoining, 1);
  assert.equal(g.gameBlocks, false);

  // Nothing about devices for guests or the TV.
  const banned = ['ip', 'device', 'hostClients', 'userAgent', 'guestsJoining'];
  for (const c of [ana, tv]) {
    const k = keys(JSON.parse(JSON.stringify(view(c))));
    for (const b of banned) assert.ok(!k.has(b), `${c.role} view has no ${b}`);
  }

  // An exclusive game blocks songs: the host view says so.
  await req(host, 'game.start', { type: 'poll', config: { seconds: 10 } });
  assert.equal(view(host).gameBlocks, true);
  room.game.end();
  assert.equal(view(host).gameBlocks, false);
});

test('devices: Identify shows a display’s name on that screen only', async (t) => {
  const { app, connect, req, guest } = await setupRoom();
  t.after(() => app.close());
  const host = await connect('host');
  const tv = await connect('tv');
  const mirror = await connect('tv', { display: 'mirror', token: app.auth.sign('tv', app.auth.newId()) }, { local: false });
  const preview = await connect('tv', { display: 'preview' });
  mirror.inbox.length = 0;
  tv.inbox.length = 0;
  const r = await req(host, 'display.identify', { id: mirror.id });
  assert.equal(r.name, 'Mirror 1');
  assert.deepEqual(mirror.inbox.filter((m) => m.t === 'identify'), [{ t: 'identify', name: 'Mirror 1', where: '192.168.1.50', seconds: 6 }]);
  assert.equal(tv.inbox.filter((m) => m.t === 'identify').length, 0);
  await req(host, 'display.identify', { id: tv.id });
  assert.deepEqual(tv.inbox.find((m) => m.t === 'identify'), { t: 'identify', name: 'Main TV', where: 'This computer', seconds: 6 });
  await assert.rejects(req(host, 'display.identify', { id: preview.id }), /not connected any more/);
  await assert.rejects(req(host, 'display.identify', { id: 'nope' }), /not connected any more/);
  const g = await guest('Gus');
  await assert.rejects(req(g, 'display.identify', { id: tv.id }), /not allowed/);
});
