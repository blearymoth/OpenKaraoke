// Guest photos: upload checks, host moderation, who may see which photo, limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { setupRoom } from './room-harness.js';
import { pngImage } from './fake-art.js';
import { imageType, MAX_PHOTO_BYTES, MAX_KEPT, MAX_PENDING, MAX_PENDING_EACH, MAX_UPLOADS } from '../server/room/photos.js';
import { RateLimiter } from '../server/util/ratelimit.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function party(settings = {}) {
  const r = await setupRoom(settings);
  await r.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${r.app.port}`;
  const upload = (token, body = JPEG, type = 'image/jpeg') => fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': type, 'x-guest-token': token || '' }, body });
  return { ...r, base, upload };
}

/**
 * Starts a 4 MB upload but sends only its first `sent` bytes: `response` settles as soon as the
 * server answers (or drops the connection); `finish()` sends the rest.
 */
function slowUpload(base, token, sent = 64 * 1024) {
  const req = http.request(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'content-length': MAX_PHOTO_BYTES, 'x-guest-token': token } });
  const response = new Promise((resolve) => {
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body: body && JSON.parse(body) }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
  req.write(Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(sent - 4, 7)]));
  return { req, response, finish: () => req.end(Buffer.alloc(MAX_PHOTO_BYTES - sent, 7)) };
}

/** The server's answer, or `{ waiting: true }` if there is none after `ms`. */
const answered = (up, ms = 3000) => Promise.race([up.response, sleep(ms).then(() => ({ waiting: true }))]);

/** `n` named guests, each on their own device (lifting the per-address identity limit). */
async function guests(r, n, prefix = 'G') {
  r.room.limits.identity = new RateLimiter({ capacity: 1000, perMs: 60_000 });
  const out = [];
  for (let i = 0; i < n; i++) out.push(await r.guest(`${prefix}${i}`));
  return out;
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

test('photos: refusals come before the body is read (photos off, banned, rate limit, one at a time)', async () => {
  const r = await party();
  const { app, room, guest, connect, req, base } = r;
  const open = [];
  const start = (token) => {
    const up = slowUpload(base, token);
    open.push(up);
    return up;
  };
  try {
    const host = await connect('host');
    const [ann, bo, cy] = await guests(r, 3);
    // Switched off: answered after 64 KB of a 4 MB body (it used to read and buffer it all first).
    app.settings.update({ guests: { photos: false } });
    const off = await answered(start(ann.welcome.token));
    assert.equal(off.status, 403, `refused without waiting for the rest of the photo (${JSON.stringify(off)})`);
    assert.equal(off.body.code, 'closed');
    app.settings.update({ guests: { photos: true } });
    // One upload at a time per phone, two per address: refused straight away too.
    const first = start(ann.welcome.token);
    await sleep(100);
    assert.equal(room.photos.uploads.size, 1);
    const again = await answered(start(ann.welcome.token));
    assert.equal(again.status, 429);
    assert.equal(again.body.code, 'busy');
    const second = start(bo.welcome.token);
    await sleep(100);
    const third = await answered(start(cy.welcome.token));
    assert.equal(third.status, 503, 'two uploads at a time from one address');
    first.finish();
    second.finish();
    assert.equal((await first.response).status, 200);
    assert.equal((await second.response).status, 200);
    assert.equal(room.photos.uploads.size, 0, 'slots are given back');
    // The rate limit is taken before the body: the sixth photo in ten minutes is refused at once.
    for (let i = 0; i < 5; i++) {
      const up = start(cy.welcome.token);
      up.finish();
      assert.equal((await up.response).status, 200);
      await room.photos.approve(room.photos.list.at(-1).id); // (not the waiting-list cap)
    }
    const sixth = await answered(start(cy.welcome.token));
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, 'rate_limited');
    // A banned guest's token still verifies, but the upload is refused before it is read.
    await req(host, 'guest.ban', { deviceId: bo.data.deviceId });
    const banned = await answered(start(bo.welcome.token));
    assert.equal(banned.status, 403);
    assert.equal(banned.body.code, 'banned');
    // A declared size over the limit is refused before anything else (and costs no photo).
    const dan = await guest('Dan');
    const big = await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-guest-token': dan.welcome.token }, body: Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xff) });
    assert.equal(big.status, 413);
    assert.equal(room.photos.limit.buckets.has(dan.data.deviceId), false);
  } finally {
    for (const up of open) up.req.destroy();
    await app.close();
  }
});

test('photos: a stalled upload loses its slot; at most MAX_UPLOADS arrive at once', async () => {
  const r = await party();
  const { app, room, base } = r;
  try {
    const [ann, ...rest] = await guests(r, MAX_UPLOADS + 1);
    room.photos.uploadTimeoutMs = 200;
    const up = slowUpload(base, ann.welcome.token);
    const res = await answered(up);
    assert.ok(res.error || res.status === 408, `the server gives up on a stalled upload (${JSON.stringify(res)})`);
    assert.equal(room.photos.uploads.size, 0);
    // In all (from different addresses): MAX_UPLOADS at once.
    const releases = rest.map((g, i) => room.photos.admit(g.data.deviceId, `192.168.1.${10 + i}`));
    assert.throws(() => room.photos.admit(rest[0].data.deviceId, '192.168.1.99'), /still on its way/);
    assert.throws(() => room.photos.admit(ann.data.deviceId, '192.168.1.99'), (e) => e.status === 503);
    releases[0]();
    room.photos.admit(ann.data.deviceId, '192.168.1.99')();
    for (const release of releases) release();
    assert.equal(room.photos.uploads.size, 0);
  } finally {
    await app.close();
  }
});

test('photos: a flood of waiting photos never pushes out approved ones; the host sees every waiting photo', async () => {
  const r = await party();
  const { app, room, connect, req, view } = r;
  try {
    const host = await connect('host');
    const photos = room.photos;
    const [ann] = await guests(r, 1, 'Ann');
    const { id: keep } = await photos.add(ann.data.deviceId, JPEG);
    await req(host, 'photo.approve', { id: keep });
    const keepFile = photos.file(photos.find(keep));
    // A full party's worth of approved photos (older than Ann's).
    const t0 = Date.now() - 3600_000;
    for (let i = 1; i < MAX_KEPT; i++) photos.list.unshift({ id: `old${i}`, ext: 'jpg', deviceId: 'x', name: 'Old', status: 'approved', createdAt: t0 - i, decidedAt: t0 - i, size: 1 });
    assert.equal(photos.approved(MAX_KEPT + 10).length, MAX_KEPT);
    // Junk from many phones stays in the waiting list, which is capped (per phone and in all).
    const spammers = await guests(r, MAX_PENDING / MAX_PENDING_EACH + 1, 'Spam');
    photos.limit = new RateLimiter({ capacity: 1000, perMs: 60_000 });
    for (let i = 0; i < MAX_PENDING_EACH; i++) await photos.add(spammers[0].data.deviceId, JPEG);
    await assert.rejects(photos.add(spammers[0].data.deviceId, JPEG), (e) => e.status === 429 && e.code === 'too_many');
    for (const g of spammers.slice(1, -1)) for (let i = 0; i < MAX_PENDING_EACH; i++) await photos.add(g.data.deviceId, JPEG);
    await assert.rejects(photos.add(spammers.at(-1).data.deviceId, JPEG), (e) => e.status === 429 && e.code === 'too_many');
    assert.equal(photos.counts().pending, MAX_PENDING);
    assert.equal(photos.approved(MAX_KEPT + 10).length, MAX_KEPT, 'no approved photo was pushed out');
    await fs.stat(keepFile);
    // The host's list has every waiting photo (not just the newest 120 of everything) and the totals.
    const hv = view(host);
    assert.equal(hv.photos.filter((p) => p.status === 'pending').length, MAX_PENDING);
    assert.equal(hv.photos.length, MAX_PENDING + 120);
    assert.deepEqual(hv.photoCounts, { total: MAX_KEPT + MAX_PENDING, pending: MAX_PENDING, approved: MAX_KEPT, rejected: 0 });
    // Approving a waiting photo makes room by dropping the oldest approved one, never the new one.
    const waiting = hv.photos.filter((p) => p.status === 'pending');
    const oldest = waiting.at(-1);
    await req(host, 'photo.approve', { id: oldest.id });
    assert.equal(photos.find(oldest.id).status, 'approved');
    assert.equal(photos.find(`old${MAX_KEPT - 1}`), null, 'the oldest approved photo made room');
    assert.equal(photos.approved(1)[0].id, oldest.id, 'it joins the photo wall as the newest');
    // Rejected photos go before approved ones.
    await req(host, 'photo.reject', { id: waiting[0].id });
    assert.equal(photos.find(waiting[0].id), null, 'the rejected photo went first');
    assert.ok(photos.find(`old${MAX_KEPT - 2}`), 'not an approved one');
    assert.equal(photos.counts().approved, MAX_KEPT);
    await req(host, 'photo.approve', { id: waiting[1].id });
    assert.equal(photos.find(`old${MAX_KEPT - 2}`), null);
    assert.equal(photos.counts().approved, MAX_KEPT);
    // Banning a guest deletes the photos they sent that the host hasn't looked at.
    const banned = spammers[2].data.deviceId;
    const files = photos.list.filter((p) => p.deviceId === banned).map((p) => photos.file(p));
    assert.equal(files.length, MAX_PENDING_EACH);
    await req(host, 'guest.ban', { deviceId: banned });
    assert.equal(photos.list.filter((p) => p.deviceId === banned).length, 0);
    await sleep(50);
    for (const f of files) await assert.rejects(fs.stat(f));
  } finally {
    await app.close();
  }
});
