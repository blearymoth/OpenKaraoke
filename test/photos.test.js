// Guest photos: upload checks, host moderation, who may see which photo, limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setupRoom } from './room-harness.js';
import { pngImage } from './fake-art.js';
import { imageType } from '../server/room/photos.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

async function party(settings = {}) {
  const r = await setupRoom(settings);
  await r.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${r.app.port}`;
  const upload = (token, body = JPEG, type = 'image/jpeg') => fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': type, 'x-guest-token': token || '' }, body });
  return { ...r, base, upload };
}

test('photos: upload rules — guest token, name, real image bytes, size, rate limit, switched off', async () => {
  const { app, guest, connect, upload, base } = await party();
  try {
    assert.equal(imageType(JPEG), 'jpg');
    assert.equal(imageType(pngImage('x')), 'png');
    assert.equal(imageType(Buffer.from('<svg/>')), null);
    const ann = await guest('Ann');
    const token = ann.welcome.token;
    assert.equal((await upload('')).status, 401);
    assert.equal((await upload('guest.fake.sig')).status, 401);
    const nameless = await connect('guest');
    assert.equal((await upload(nameless.welcome.token)).status, 403, 'needs a name');
    assert.equal((await upload(token, JPEG, 'image/gif')).status, 415);
    assert.equal((await upload(token, Buffer.from('<html>not an image</html>'))).status, 415, 'bytes are checked, not the header');
    assert.equal((await upload(token, Buffer.alloc(4 * 1024 * 1024 + 10, 0xff))).status, 413);
    const ok = await upload(token);
    assert.equal(ok.status, 200);
    const { photo } = await ok.json();
    assert.equal(photo.status, 'pending');
    for (let i = 0; i < 3; i++) assert.equal((await upload(token, pngImage(`p${i}`), 'image/png')).status, 200);
    assert.equal((await upload(token)).status, 429, 'five photos per ten minutes');
    app.settings.update({ guests: { photos: false } });
    const bo = await guest('Bo');
    assert.equal((await upload(bo.welcome.token)).status, 403);
    // A page on another site can't post photos (origin check for every POST).
    const cross = await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/jpeg', origin: 'http://evil.example', 'x-guest-token': token }, body: JPEG });
    assert.equal(cross.status, 403);
  } finally {
    await app.close();
  }
});

test('photos: the host approves; the TV shows it; phones only ever see approved photos', async () => {
  const { app, guest, connect, req, view, upload, base, room } = await party();
  try {
    const host = await connect('host');
    const tv = await connect('tv');
    const ann = await guest('Ann');
    const { photo } = await (await upload(ann.welcome.token)).json();
    assert.equal(view(host).photos[0].status, 'pending');
    assert.ok(host.inbox.some((m) => m.t === 'toast' && /sent a photo/.test(m.text)));
    assert.deepEqual(view(ann).me.photos.map((p) => p.status), ['pending']);
    assert.deepEqual(view(tv).photos.list, []);
    assert.equal((await fetch(`${base}/api/photos/${photo.id}`)).status, 200, 'the host can look at it');
    app.auth.isHostRequest = () => false; // from now on: a phone
    assert.equal((await fetch(`${base}/api/photos/${photo.id}`)).status, 404, 'not public before approval');
    await assert.rejects(req(ann, 'photo.approve', { id: photo.id }), /not allowed/);
    await req(host, 'photo.approve', { id: photo.id });
    assert.deepEqual(view(tv).photos.list, [{ id: photo.id, name: 'Ann' }]);
    assert.equal(view(tv).photos.flash.id, photo.id);
    assert.ok(ann.inbox.some((m) => m.t === 'notify' && m.kind === 'photo'));
    const img = await fetch(`${base}/api/photos/${photo.id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    await req(host, 'photo.reject', { id: photo.id });
    assert.equal((await fetch(`${base}/api/photos/${photo.id}`)).status, 404);
    assert.equal(view(tv).photos.flash, null);
    const file = room.photos.file(room.photos.find(photo.id));
    await req(host, 'photo.remove', { id: photo.id });
    await assert.rejects(fs.stat(file));
    await assert.rejects(req(host, 'photo.remove', { id: photo.id }), /not found/);
  } finally {
    await app.close();
  }
});

test('photos: without approval they go straight to the TV', async () => {
  const { app, guest, connect, view, upload } = await party({ guests: { photoApproval: false } });
  try {
    const tv = await connect('tv');
    const ann = await guest('Ann');
    const { photo } = await (await upload(ann.welcome.token)).json();
    assert.equal(photo.status, 'approved');
    assert.equal(view(tv).photos.flash.name, 'Ann');
  } finally {
    await app.close();
  }
});
