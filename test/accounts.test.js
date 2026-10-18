// Guest accounts: the store (usernames, scrypt hashes, token versions) and the room — signing up
// from a guest, signing in on another phone as the same singer, signing out everywhere on a new
// password, the host's reset and delete, the limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Accounts, MIN_PASSWORD } from '../server/room/accounts.js';
import { tmpDir } from './helpers.js';
import { setupRoom } from './room-harness.js';

test('the store: usernames, hashed passwords, token versions, the file', async () => {
  const dir = await tmpDir('ok-accounts-');
  const file = path.join(dir, 'accounts.json');
  const acc = await new Accounts(file).load();
  await assert.rejects(acc.create('ab', 'secret1', 'device-1'), /3 to 24/);
  await assert.rejects(acc.create('bad name', 'secret1', 'device-1'), /3 to 24/);
  await assert.rejects(acc.create('__proto__', 'secret1', 'device-1'), /3 to 24/);
  await assert.rejects(acc.create('Constructor', 'secret1', 'device-1'), /another username/);
  await assert.rejects(acc.create('ann', 'short', 'device-1'), new RegExp(`${MIN_PASSWORD} characters`));
  await assert.rejects(acc.create('ann', 'x'.repeat(129), 'device-1'), /128 characters/);
  const ann = await acc.create('Ann.K', 'correct horse', 'device-1');
  assert.equal(ann.name, 'Ann.K');
  await assert.rejects(acc.create('ann.k', 'another one', 'device-2'), /taken/, 'usernames are case-insensitive');
  await assert.rejects(acc.create('bea', 'another one', 'device-1'), /already have an account/);

  assert.equal((await acc.verify('ANN.K', 'correct horse'))?.id, 'device-1');
  assert.equal(await acc.verify('ann.k', 'Correct horse'), null);
  assert.equal(await acc.verify('nobody', 'correct horse'), null);
  assert.equal(await acc.verify('ann.k', 42), null);

  // Tokens: an account token holds while its version does; a plain guest token of an account's
  // identity doesn't (signing in is needed).
  const t0 = acc.tokenId(ann);
  assert.equal(acc.identity({ account: t0 }), 'device-1');
  assert.equal(acc.identity({ guest: 'device-1' }), null);
  assert.equal(acc.identity({ guest: 'device-9' }), 'device-9');
  assert.equal(acc.identity({ account: 'v0_nobody' }), null);
  assert.equal(acc.identity({ account: 'nonsense' }), null);
  await acc.setPassword('device-1', 'new password');
  assert.equal(acc.identity({ account: t0 }), null, 'a new password signs every phone out');
  assert.equal(acc.identity({ account: acc.tokenId(ann) }), 'device-1');
  assert.equal(await acc.verify('ann.k', 'correct horse'), null);
  assert.ok(await acc.verify('ann.k', 'new password'));
  await acc.create('bea', 'bea password', 'device-2');
  acc.remove('device-2');
  assert.equal(acc.ofId('device-2'), null);
  assert.throws(() => acc.remove('device-2'), /No such account/);
  await acc.flush();

  // The file holds no password, and a hand-edited one is cleaned.
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('new password') && !text.includes('correct horse'));
  const raw = JSON.parse(text);
  raw.users.zed = { name: 'zed', id: 'device-1', salt: 'x', hash: 'y' }; // same identity, bad hash
  raw.users.mismatch = { ...raw.users['ann.k'], name: 'other' };
  await fs.writeFile(file, JSON.stringify(raw));
  const again = await new Accounts(file).load();
  assert.deepEqual(again.list().map((a) => a.username), ['Ann.K']);
  assert.ok(await again.verify('ann.k', 'new password'));
});

test('a guest becomes an account and signs in on another phone as the same singer', async () => {
  const { app, room, connect, guest, req, song, s, view, leave } = await setupRoom({ playback: { countdown: 0, autoStart: false } });
  const host = await connect('host');
  const tv = await connect('tv');
  const ann = await guest('Ann');
  const annId = ann.data.deviceId;
  await req(ann, 'favorite.toggle', { songId: song('waterloo').id });
  await req(ann, 'queue.add', { songId: song('waterloo').id });
  await req(host, 'player.next');
  await req(tv, 'tv.ready', { entryId: s().current.id, dur: 200 });
  await req(tv, 'tv.ended', { entryId: s().current.id });
  assert.deepEqual(view(ann).me.songs.map((x) => [x.title, x.n]), [['Waterloo', 1]], 'Your songs');
  assert.equal(view(ann).me.account, null);

  // Sign-up: a name first; then the account is this very guest.
  const nobody = await connect('guest');
  await assert.rejects(req(nobody, 'account.create', { username: 'nobody', password: 'secret12' }), /Choose a name/);
  const made = await req(ann, 'account.create', { username: 'Ann', password: 'secret12' });
  assert.equal(made.username, 'Ann');
  assert.equal(app.auth.verify(made.token, 'account').id, `v0_${annId}`);
  assert.equal(view(ann).me.account, 'Ann');
  await assert.rejects(req(ann, 'account.create', { username: 'Ann2', password: 'secret12' }), /already have an account/);
  await assert.rejects(req(nobody, 'guest.update', { name: 'Bea' }).then(() => req(nobody, 'account.create', { username: 'ann', password: 'secret12' })), /taken/);

  // Her old plain token no longer is her (signing in is needed); the account token is.
  const oldTokenPhone = await connect('guest', { token: ann.welcome.token });
  assert.notEqual(oldTokenPhone.data.deviceId, annId);
  assert.equal(oldTokenPhone.welcome.signedOut, true);
  const again = await connect('guest', { token: made.token });
  assert.equal(again.data.deviceId, annId);

  // Another phone signs in: the same identity — name, favourites, songs.
  const phone2 = await connect('guest', {}, { local: false });
  await assert.rejects(req(phone2, 'account.login', { username: 'ann', password: 'wrong one' }), /Wrong username or password/);
  await assert.rejects(req(phone2, 'account.login', { username: 'nobody', password: 'secret12' }), /Wrong username or password/);
  const login = await req(phone2, 'account.login', { username: 'ANN', password: 'secret12' });
  const signedIn = await connect('guest', { token: login.token }, { local: false });
  assert.equal(signedIn.data.deviceId, annId);
  const v = view(signedIn);
  assert.deepEqual([v.me.profile.name, v.me.profile.favorites, v.me.songs.length, v.me.account], ['Ann', [song('waterloo').id], 1, 'Ann']);

  // A new password: this phone stays, every other one is told and disconnected.
  await assert.rejects(req(signedIn, 'account.password', { old: 'nope', password: 'brand new 1' }), /current password/);
  const changed = await req(signedIn, 'account.password', { old: 'secret12', password: 'brand new 1' });
  assert.ok(again.inbox.some((m) => m.t === 'signedOut') && again.open === false, 'the other phone is signed out');
  assert.ok(signedIn.open, 'this one stays');
  assert.equal((await connect('guest', { token: made.token })).welcome.signedOut, true, 'the old token is no good');
  assert.equal((await connect('guest', { token: changed.token })).data.deviceId, annId);

  // The host: the list, a reset (her phones signed out), a delete. Guests can't.
  await assert.rejects(req(phone2, 'account.list'), /not allowed/);
  const list = await req(host, 'account.list');
  assert.deepEqual(list.items.map((a) => [a.username, a.name, a.online]), [['Ann', 'Ann', true]]);
  await req(host, 'account.reset', { id: annId, password: 'from the host' });
  assert.ok(signedIn.inbox.some((m) => m.t === 'signedOut'));
  await assert.rejects(req(host, 'account.reset', { id: annId, password: '123' }), /6 characters/);
  const byHost = await req(phone2, 'account.login', { username: 'ann', password: 'from the host' });
  assert.ok(byHost.token);
  // Banned: can't sign in.
  await req(host, 'guest.ban', { deviceId: annId });
  await assert.rejects(req(nobody, 'account.login', { username: 'ann', password: 'from the host' }), /removed you/);
  await req(host, 'account.delete', { id: annId });
  assert.equal(app.accounts.ofId(annId), null);
  await assert.rejects(req(host, 'account.delete', { id: annId }), /No such account/);

  // The setting turns sign-up off (signing in still works for those who have one).
  const cy = await guest('Cy');
  app.settings.update({ guests: { accounts: false } });
  await assert.rejects(req(cy, 'account.create', { username: 'cyrus', password: 'secret12' }), /turned accounts off/);
  assert.equal(view(cy).rules.accounts, false);
  leave(cy);
  void room;
});

test('sign-in and sign-up are rate-limited; an account’s profile is never pruned', async () => {
  const { app, room, connect, guest, req } = await setupRoom();
  const ann = await guest('Ann');
  await req(ann, 'account.create', { username: 'annie', password: 'secret12' });
  const phone = await connect('guest', {}, { local: false });
  for (let i = 0; i < 6; i++) await assert.rejects(req(phone, 'account.login', { username: 'annie', password: `wrong ${i}x` }), /Wrong/);
  await assert.rejects(req(phone, 'account.login', { username: 'annie', password: 'secret12' }), /Too many tries/, 'per username');
  const other = await connect('guest', {}, { local: false });
  for (let i = 0; i < 4; i++) await assert.rejects(req(other, 'account.login', { username: `user${i}x`, password: 'whatever1' }), /Wrong|Too many/);
  await assert.rejects(req(other, 'account.login', { username: 'zzz', password: 'whatever1' }), /Too many tries/, 'per address (10 in 5 minutes)');
  // New accounts: 5 per address in 10 minutes.
  for (let i = 0; i < 4; i++) {
    const g = await guest(`G${i}`);
    await req(g, 'account.create', { username: `guest${i}`, password: 'secret12' });
  }
  const sixth = await guest('G9');
  await assert.rejects(req(sixth, 'account.create', { username: 'guest9', password: 'secret12' }), /Too many new accounts/);

  // Pruning old profiles (1000+) leaves accounts' profiles alone.
  const annId = ann.data.deviceId;
  room.s.profiles[annId].lastSeen = 1;
  for (let i = 0; i < 1005; i++) room.s.profiles[`old-guest-${i}`] = { name: `Old ${i}`, lastSeen: 2 + i, favorites: [] };
  room.pruneProfiles();
  assert.ok(room.s.profiles[annId], 'the account’s profile stays');
  assert.ok(Object.keys(room.s.profiles).length < 1005);
  void app;
});
