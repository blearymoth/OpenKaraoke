// The party hotspot and who may do what (PLAN §20.6), over real HTTP and WebSocket connections:
// the client's address is forged on the server's own sockets, and this computer's network
// interfaces are a fixed table (the hotspot adds wlp2s0 = 10.42.0.1 while it is on). The real
// nmcli is never used (scripts/fake-nmcli.mjs).
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { WebSocket } from '../server/vendor/ws.mjs';
import { createApp } from '../server/app.js';
import { fetchHealth } from '../server/net/hotspot.js';
import { isLocalAddress, isTrustedOrigin } from '../server/util/net.js';
import { fakeNmcli } from '../scripts/fake-nmcli.mjs';
import { tmpDir } from './helpers.js';
import { offlineFetch } from './fake-art.js';

const HOME = { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.20/24' };
const HOTSPOT = { address: '10.42.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:02', internal: false, cidr: '10.42.0.1/24' };
const LO = { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' };
let wifiUp = false;
mock.method(os, 'networkInterfaces', () => structuredClone({ lo: [LO], enp3s0: [HOME], ...(wifiUp ? { wlp2s0: [HOTSPOT] } : {}) }));

let app;
let nm;
let base;
let port;
let code;
let peer = ''; // the address the server sees for the next connections ('' = the real one)

before(async () => {
  const dir = await tmpDir('ok-hotspot-sec-');
  nm = fakeNmcli('ok');
  const health = (url) => (url.startsWith('http://10.42.0.1:') ? fetchHealth(url.replace('10.42.0.1', '127.0.0.1')) : Promise.resolve(null));
  app = await createApp({ dataDir: dir, scan: false, watch: false, fetch: offlineFetch, crawl: false, hotspot: { run: nm.run, health, platform: 'linux', readText: async () => '', pollMs: 60_000, listenAddress: () => '0.0.0.0' } });
  await app.listen(0, '127.0.0.1');
  app.server.prependListener('connection', (s) => {
    if (peer) Object.defineProperty(s, 'remoteAddress', { value: peer, configurable: true });
  });
  port = app.port;
  base = `http://127.0.0.1:${port}`;
  code = app.info().roomCode;
  const asHost = { role: 'host', data: {}, isLocal: true, ip: '127.0.0.1', send() {} };
  wifiUp = true; // NetworkManager gives the adapter its address as the hotspot comes up
  await app.room.request(asHost, { t: 'hotspot.set', on: true });
  await app.hotspot.chain;
  assert.equal(app.info().mode, 'hotspot');
});

after(() => app.close());

/** One HTTP request on a fresh connection (so the forged peer applies). */
function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

/** A fresh WebSocket that says hello; resolves to { msg, ws } or rejects with "HTTP <status>". */
function hello(headers, msg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const inbox = [];
    ws.next = () => new Promise((r) => {
      if (inbox.length) r(inbox.shift());
      else ws.once('json', r);
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (ws.listenerCount('json')) ws.emit('json', m);
      else inbox.push(m);
    });
    ws.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', async () => {
      ws.send(JSON.stringify(msg));
      for (;;) {
        const m = await ws.next();
        if (m.t === 'welcome' || m.t === 'denied') return resolve({ msg: m, ws });
      }
    });
  });
}

const hotspotHeaders = () => ({ host: `10.42.0.1:${port}`, origin: `http://10.42.0.1:${port}` });

test('this computer\'s addresses: the hotspot address is ours, its phones are not', () => {
  assert.equal(isLocalAddress('10.42.0.1'), true);
  assert.equal(isLocalAddress('::ffff:10.42.0.1'), true);
  assert.equal(isLocalAddress('10.42.0.23'), false);
  assert.equal(isLocalAddress('::ffff:10.42.0.23'), false);
  assert.equal(isTrustedOrigin(`http://10.42.0.1:${port}`), true);
  assert.equal(isTrustedOrigin('http://10.42.0.23:8000'), false);
});

test('guests on the hotspot (Host 10.42.0.1:<port>) join, and never see the hotspot password', async () => {
  const password = app.hotspot.config().password;
  for (const ip of ['10.42.0.23', '::ffff:10.42.0.23']) {
    peer = ip;
    try {
      const { msg, ws } = await hello(hotspotHeaders(), { t: 'hello', role: 'guest', room: code });
      ws.close();
      assert.equal(msg.t, 'welcome', ip);
      assert.ok(msg.token, `${ip}: a device token`);
      assert.equal(msg.state.info.joinUrl, `http://10.42.0.1:${port}/j/${code}`);
      assert.ok(!JSON.stringify(msg).includes(password), `${ip}: no password in the guest's welcome`);
      assert.equal((await request('GET', `/j/${code}`, { host: `10.42.0.1:${port}` })).status, 200);
      const info = await request('GET', '/api/info', { host: `10.42.0.1:${port}` });
      assert.ok(!info.text.includes(password) && !info.text.includes('WIFI:'), `${ip}: no password in /api/info`);
      // A POST from the hotspot page isn't cross-site (wrong PIN → the PIN's own answer).
      app.settings.update({ party: { adminPin: '4321' } });
      const pin = await request('POST', '/api/auth/pin', { ...hotspotHeaders(), 'content-type': 'application/json' }, '{"pin":"0000"}');
      assert.equal(pin.status, 401, ip);
      app.settings.update({ party: { adminPin: '' } });
    } finally {
      peer = '';
    }
  }
});

test('the host role is refused from a hotspot address, whatever Host and Origin say', async () => {
  const forged = [hotspotHeaders(), { host: `localhost:${port}`, origin: `http://localhost:${port}` }, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }];
  for (const ip of ['10.42.0.23', '::ffff:10.42.0.23']) {
    peer = ip;
    try {
      for (const headers of forged) {
        const host = await hello(headers, { t: 'hello', role: 'host' });
        host.ws.close();
        assert.deepEqual([host.msg.t, host.msg.reason], ['denied', 'host_only'], `${ip} ${headers.host}`);
        assert.equal((await request('GET', '/api/fs/list', headers)).status, 403, `${ip} ${headers.host}: no host HTTP`);
        const tv = await hello(headers, { t: 'hello', role: 'tv' });
        tv.ws.close();
        assert.equal(tv.msg.reason, 'pairing_required', `${ip}: a TV on the hotspot still needs pairing`);
      }
      // With a PIN: asked for it, and a guest can't switch the hotspot.
      app.settings.update({ party: { adminPin: '4321' } });
      const pinned = await hello(hotspotHeaders(), { t: 'hello', role: 'host' });
      pinned.ws.close();
      assert.equal(pinned.msg.reason, 'pin_required');
      app.settings.update({ party: { adminPin: '' } });
      const guest = await hello(hotspotHeaders(), { t: 'hello', role: 'guest', room: code });
      guest.ws.send(JSON.stringify({ t: 'hotspot.set', rid: 7, on: false }));
      let res;
      do res = await guest.ws.next(); while (res.t !== 'res');
      guest.ws.close();
      assert.equal(res.ok, false);
      assert.equal(app.hotspot.state, 'on');
    } finally {
      peer = '';
    }
  }
  // Positive control: this computer reaching itself through the hotspot address is local.
  peer = '10.42.0.1';
  try {
    const own = await hello(hotspotHeaders(), { t: 'hello', role: 'host' });
    own.ws.close();
    assert.equal(own.msg.t, 'welcome');
  } finally {
    peer = '';
  }
});

test('foreign Origins are refused, from this computer and from the hotspot', async () => {
  const foreign = [`http://10.42.0.23:8000`, `http://10.42.0.1.evil.example:${port}`, 'http://evil.example', 'null', `http://[::ffff:10.42.0.1]:${port}`];
  for (const ip of ['', '10.42.0.23']) {
    peer = ip;
    try {
      for (const origin of foreign) {
        await assert.rejects(hello({ host: `10.42.0.1:${port}`, origin }, { t: 'hello', role: 'guest', room: code }), /HTTP 403/, `${ip || 'local'} ${origin}`);
        const post = await request('POST', '/api/auth/pin', { host: `10.42.0.1:${port}`, origin, 'content-type': 'application/json' }, '{"pin":"0000"}');
        assert.equal(post.status, 403, `${ip || 'local'} ${origin}`);
        assert.match(post.text, /other web sites/);
      }
    } finally {
      peer = '';
    }
  }
});

test('after the hotspot drops: its address is no longer trusted, the join link is the home one, its phones are let go', async () => {
  peer = '10.42.0.23';
  const guest = await hello(hotspotHeaders(), { t: 'hello', role: 'guest', room: code });
  peer = '';
  const closed = new Promise((resolve) => guest.ws.on('close', (c) => resolve(c)));
  nm.drop();
  wifiUp = false;
  await app.hotspot.poll();
  await app.hotspot.poll();
  assert.equal(app.hotspot.state, 'failed');
  assert.equal(await closed, 1001, 'the phone on the hotspot is let go at once');
  assert.equal(app.info().joinUrl, `http://192.168.1.20:${port}/j/${code}`);
  await assert.rejects(hello(hotspotHeaders(), { t: 'hello', role: 'guest', room: code }), /HTTP 403/);
  peer = '10.42.0.1';
  try {
    const was = await hello({ host: `127.0.0.1:${port}` }, { t: 'hello', role: 'host' });
    was.ws.close();
    assert.equal(was.msg.reason, 'host_only', 'the old hotspot address is not this computer any more');
  } finally {
    peer = '';
  }
});
