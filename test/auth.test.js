import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth } from '../server/room/auth.js';
import { Settings } from '../server/config.js';
import { tmpDir } from './helpers.js';

async function make(pin = '') {
  const dir = await tmpDir();
  const settings = new Settings(dir);
  await settings.load();
  settings.update({ party: { adminPin: pin } });
  const auth = await new Auth({ dataDir: dir, settings }).init();
  return { dir, settings, auth };
}

test('tokens verify, are role bound and survive a restart', async () => {
  const { dir, settings, auth } = await make('1234');
  const t = auth.sign('host', 'dev1');
  assert.equal(auth.verify(t, 'host'), 'dev1');
  assert.equal(auth.verify(t, 'tv'), null);
  assert.equal(auth.verify(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), 'host'), null);
  assert.equal(auth.verify('garbage', 'host'), null);
  const again = await new Auth({ dataDir: dir, settings }).init();
  assert.equal(again.verify(t, 'host'), 'dev1');
  await auth.rotate();
  assert.equal(auth.verify(t, 'host'), null, 'rotating invalidates host tokens');
  const tv = auth.sign('tv', 'screen');
  await auth.rotate();
  assert.equal(auth.verify(tv, 'tv'), 'screen', 'display tokens survive PIN changes');
});

test('PIN checks back off after repeated failures', async () => {
  const { auth } = await make('4321');
  assert.equal(auth.checkPin('4321', '10.0.0.2').ok, true);
  for (let i = 0; i < 5; i++) assert.equal(auth.checkPin('0000', '10.0.0.3').ok, false);
  const r = auth.checkPin('4321', '10.0.0.3');
  assert.equal(r.ok, false);
  assert.match(r.error, /wait/i);
  assert.equal(auth.checkPin('4321', '10.0.0.4').ok, true, 'other devices unaffected');
});

test('no PIN means no remote host access', async () => {
  const { auth } = await make('');
  assert.equal(auth.pinConfigured(), false);
  assert.match(auth.checkPin('', '10.0.0.2').error, /No host PIN/);
  assert.equal(auth.trustsLocal('127.0.0.1'), true);
  assert.equal(auth.trustsLocal('203.0.113.5'), false);
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.5' } };
  assert.equal(auth.isHostRequest(req), false);
  req.headers.authorization = `Bearer ${auth.sign('host', 'x')}`;
  assert.equal(auth.isHostRequest(req), true);
});
