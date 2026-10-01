// Every host-only HTTP route refuses phones (and still works for the host), so removing a
// requireHost() check can't go unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import { pngImage } from './fake-art.js';

const HOST_ONLY = [
  ['GET', '/api/artwork'],
  ['GET', '/api/art/candidate/SONG/deezer:1'],
  ['POST', '/api/art/song/SONG/cover', { 'content-type': 'image/png' }, () => pngImage('x')],
  ['POST', '/api/library/scan', { 'content-type': 'application/json' }, () => '{}'],
  ['POST', '/api/library/paths', { 'content-type': 'application/json' }, () => JSON.stringify({ paths: [] })],
  ['GET', '/api/fs/list'],
  ['GET', '/api/export/songbook'],
  ['GET', '/api/export/songbook?format=csv'],
];

test('host-only routes: phones get 403 (401 with a PIN), the host gets through', async () => {
  const r = await setupRoom();
  await r.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${r.app.port}`;
  const song = [...r.app.library.catalog.songs.values()][0].id;
  const call = ([method, path, headers = {}, body]) =>
    fetch(base + path.replace('SONG', song), { method, headers, body: body?.() });
  try {
    const hostStatus = [];
    for (const route of HOST_ONLY) hostStatus.push((await call(route)).status);
    for (const [i, status] of hostStatus.entries()) assert.ok(status !== 401 && status !== 403, `host: ${HOST_ONLY[i][1]} → ${status}`);

    r.app.auth.isHostRequest = () => false; // from now on: a phone on the LAN
    for (const route of HOST_ONLY) assert.equal((await call(route)).status, 403, `phone: ${route[1]}`);
    r.app.settings.update({ party: { adminPin: '4321' } });
    for (const route of HOST_ONLY) assert.equal((await call(route)).status, 401, `phone, PIN set: ${route[1]}`);
  } finally {
    await r.app.close();
  }
});
