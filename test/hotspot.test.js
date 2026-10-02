// The party hotspot (PLAN §20): talking to NetworkManager through an injected runner, checked
// against scripts/fake-nmcli.mjs. The real nmcli is never used here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addConnectionArgs, addedUuid, getValues, makePassword, nmError, splitTerse, systemRunner, terseFields, terseRows, validIfname, validPassword, validSsid, CONNECTION_NAME } from '../server/net/nmcli.js';
import { fakeNmcli, runFake, scenarioState } from '../scripts/fake-nmcli.mjs';
import { createApp } from '../server/app.js';
import { tmpDir } from './helpers.js';
import { offlineFetch } from './fake-art.js';

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject);
});

test('nmcli terse output: escaped colons, rows, fields, lists, -g values, errors', () => {
  assert.deepEqual(splitTerse('wlp2s0:wifi:connected:Caf\\:e \\\\ Net'), ['wlp2s0', 'wifi', 'connected', 'Caf:e \\ Net']);
  assert.deepEqual(splitTerse(''), ['']);
  assert.deepEqual(terseRows('a:b\n\nc\\:d:e\n'), [['a', 'b'], ['c:d', 'e']]);
  assert.deepEqual(terseFields('GENERAL.STATE:activated\nIP4.ADDRESS[1]:10.42.0.1/24\nIP4.ADDRESS[2]:10.42.1.1/24\n'),
    { 'GENERAL.STATE': 'activated', 'IP4.ADDRESS': ['10.42.0.1/24', '10.42.1.1/24'] });
  assert.deepEqual(getValues('10.42.0.1/24 | 192.168.5.1/24\n'), ['10.42.0.1/24', '192.168.5.1/24']);
  assert.deepEqual(getValues('\n'), []);
  assert.equal(nmError({ code: 4, stderr: "Error: Connection activation failed: No suitable device.\nHint: use 'journalctl -xe'\n" }), 'Connection activation failed: No suitable device.');
  assert.equal(nmError({ code: 3, stderr: '' }), 'nmcli failed (exit 3)');
  // Two "Error:" lines; warnings (a version mismatch) left out.
  assert.equal(nmError({ code: 7, stderr: "Warning: nmcli (1.46.0) and NetworkManager (1.48.0) versions don't match. Restarting NetworkManager is advised.\nError: Connection deletion failed: Insufficient privileges\nError: not all connections deleted.\n" }),
    'Connection deletion failed: Insufficient privileges not all connections deleted.');
  assert.equal(addedUuid("Connection 'OpenKaraoke hotspot' (5b0c2f6e-8a51-4c47-9d3e-2b1f0a9c7d11) successfully added.\n"), '5b0c2f6e-8a51-4c47-9d3e-2b1f0a9c7d11');
  assert.equal(addedUuid('something else'), '');
  // A 5 GHz hotspot that times out: 2.4 GHz is the fix; on 2.4 GHz it's a plain retry.
  assert.match(fixForUpError('Connection activation failed: 802.1X supplicant took too long to authenticate', 'a'), /choose 2\.4 GHz/);
  assert.doesNotMatch(fixForUpError('Connection activation failed: 802.1X supplicant took too long to authenticate', 'auto'), /2\.4 GHz/);
  assert.match(fixForUpError('Connection activation failed: Not authorized to share connections via wifi.'), /desktop/);
});

test('hotspot values: name, password, adapter; the connection nmcli gets', () => {
  for (const ok of ['OpenKaraoke-ABCD', 'Café 🎤', 'a', 'x'.repeat(32)]) assert.ok(validSsid(ok), ok);
  for (const bad of ['', ' padded', 'x'.repeat(33), 'ä'.repeat(17), '-oops', 'line\nbreak', 'tab\there', null, 5]) assert.ok(!validSsid(bad), String(bad));
  for (const ok of ['12345678', 'x'.repeat(63), 'with spaces ok!']) assert.ok(validPassword(ok), ok);
  for (const bad of ['1234567', 'x'.repeat(64), 'héllo123', 'tab\tinside', undefined]) assert.ok(!validPassword(bad), String(bad));
  for (const ok of ['wlp2s0', 'wlan0', 'wlx00c0ca1234ab', 'wl.0_1']) assert.ok(validIfname(ok), ok);
  for (const bad of ['', '-x', 'a'.repeat(16), 'wl p', 'wl/0', 'wl;rm']) assert.ok(!validIfname(bad), bad);
  const pw = makePassword(() => 3);
  assert.equal(pw, 'dddddddddddd');
  assert.ok(validPassword(makePassword()));

  const args = addConnectionArgs({ ifname: 'wlp2s0', ssid: 'OpenKaraoke-ABCD', password: 'secret-pass', band: 'auto' });
  const kv = (name) => args[args.indexOf(name) + 1];
  assert.deepEqual(args.slice(0, 4), ['connection', 'add', 'type', 'wifi']);
  assert.equal(kv('con-name'), CONNECTION_NAME);
  assert.equal(kv('ifname'), 'wlp2s0');
  assert.equal(kv('ssid'), 'OpenKaraoke-ABCD');
  assert.equal(kv('802-11-wireless.mode'), 'ap');
  assert.equal(kv('ipv4.method'), 'shared');
  assert.equal(kv('ipv4.addresses'), '10.42.0.1/24', 'a fixed address: printed QR cards stay right');
  assert.equal(kv('wifi-sec.key-mgmt'), 'wpa-psk');
  assert.equal(kv('wifi-sec.psk'), 'secret-pass');
  assert.equal(kv('autoconnect'), 'no');
  assert.ok(!args.includes('802-11-wireless.band'), 'automatic band: not set');
  assert.equal(addConnectionArgs({ ifname: 'wlp2s0', ssid: 'X', password: '12345678', band: 'a' }).includes('802-11-wireless.band'), true);
  // Every value is its own argument: nothing a shell (there is none) or nmcli could split.
  const odd = addConnectionArgs({ ifname: 'wlp2s0', ssid: 'a; rm -rf ~ "x"', password: '$(reboot) `id`', band: 'bg' });
  assert.equal(odd[odd.indexOf('ssid') + 1], 'a; rm -rf ~ "x"');
  for (const bad of [{ ifname: '-x' }, { ssid: '' }, { password: 'short' }, { band: 'weird' }]) {
    assert.throws(() => addConnectionArgs({ ifname: 'wlp2s0', ssid: 'X', password: '12345678', band: 'auto', ...bad }));
  }
});

test('the real nmcli is never run under node --test', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test marks its test processes');
  await assert.rejects(systemRunner()('nmcli', ['--version']), /never used in tests/);
  // Outside the tests only nmcli and firewall-cmd may be started, with string arguments.
  const real = systemRunner({ env: { PATH: '/nonexistent' } });
  await assert.rejects(real('sh', ['-c', 'id']), /not allowed/);
  await assert.rejects(real('nmcli', [1]), /bad arguments/);
  assert.deepEqual(await real('nmcli', ['--version']), { code: 127, stdout: '', stderr: 'nmcli: command not found' });
});

test('fake nmcli speaks nmcli: formats, exit codes, a hotspot going up, down and dropping', async () => {
  const nm = fakeNmcli('home-wifi');
  const run = (...args) => nm.run('nmcli', args);
  assert.match((await run('--version')).stdout, /^nmcli tool, version 1\.\d+/);
  assert.equal((await run('-t', '-f', 'RUNNING', 'general')).stdout, 'running\n');
  assert.match((await run('-t', '-f', 'PERMISSION,VALUE', 'general', 'permissions')).stdout, /network-control:yes/);
  assert.equal((await run('-t', '-f', 'WIFI', 'radio')).stdout, 'enabled\n');
  assert.deepEqual(terseRows((await run('-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device')).stdout)[0], ['wlp2s0', 'wifi', 'connected', 'HomeNet']);
  assert.equal((await run('-g', 'WIFI-PROPERTIES.AP', 'device', 'show', 'wlp2s0')).stdout, 'yes\n');
  assert.equal((await run('-g', 'WIFI-PROPERTIES.AP', 'device', 'show', 'nope')).code, 10);
  assert.equal((await run('connection', 'delete', 'id', CONNECTION_NAME)).code, 10, 'nothing to delete yet');
  const added = await run(...addConnectionArgs({ ifname: 'wlp2s0', ssid: 'Party', password: '12345678', band: 'auto' }));
  assert.match(added.stdout, /successfully added/);
  const up = await run('--wait', '30', 'connection', 'up', 'id', CONNECTION_NAME);
  assert.equal(up.code, 0);
  assert.equal((await run('-g', 'GENERAL.STATE', 'connection', 'show', 'id', CONNECTION_NAME)).stdout, 'activated\n');
  assert.deepEqual(getValues((await run('-g', 'IP4.ADDRESS', 'device', 'show', 'wlp2s0')).stdout), ['10.42.0.1/24']);
  assert.ok(!terseRows((await run('-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show', '--active')).stdout).some((r) => r[0] === 'HomeNet'), 'the home Wi-Fi left the adapter');
  assert.match((await run('connection', 'down', 'id', CONNECTION_NAME)).stdout, /successfully deactivated/);
  assert.equal(nm.state.devices[0].connection, 'HomeNet', 'and comes back after');
  assert.equal((await run('connection', 'down', 'id', CONNECTION_NAME)).code, 10);

  // Failures in NetworkManager's words.
  assert.equal((await fakeNmcli('no-nmcli').run('nmcli', ['--version'])).code, 127);
  const stopped = await fakeNmcli('nm-stopped').run('nmcli', ['-t', '-f', 'RUNNING', 'general']);
  assert.deepEqual([stopped.code, stopped.stderr], [8, 'Error: NetworkManager is not running.\n']);
  const st = scenarioState('no-dnsmasq');
  runFake(st, 'nmcli', addConnectionArgs({ ifname: 'wlp2s0', ssid: 'P', password: '12345678', band: 'auto' }));
  const failed = runFake(st, 'nmcli', ['--wait', '30', 'connection', 'up', 'id', CONNECTION_NAME]);
  assert.equal(failed.code, 4);
  assert.match(nmError(failed), /IP configuration could not be reserved/);
  assert.equal(runFake(scenarioState('firewalld'), 'firewall-cmd', ['--state']).stdout, 'running\n');
  assert.equal(runFake(scenarioState('ok'), 'firewall-cmd', ['--state']).code, 252);
  assert.throws(() => scenarioState('nonsense'), /unknown fake-nmcli scenario/);

  // Dropping: the hotspot goes down by itself after a few state polls.
  const drops = fakeNmcli('drops');
  await drops.run('nmcli', addConnectionArgs({ ifname: 'wlp2s0', ssid: 'P', password: '12345678', band: 'auto' }));
  await drops.run('nmcli', ['connection', 'up', 'id', CONNECTION_NAME]);
  const states = [];
  for (let i = 0; i < 3; i++) states.push((await drops.run('nmcli', ['-g', 'GENERAL.STATE', 'connection', 'show', 'id', CONNECTION_NAME])).stdout.trim());
  assert.deepEqual(states, ['activated', '', '']);
});

test('GET /api/health: up, version and this process', async (t) => {
  const dir = await tmpDir('ok-health-');
  const app = await createApp({ dataDir: dir, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const { status, body } = await getJson(`http://127.0.0.1:${app.port}/api/health`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['instance', 'ok', 'version']);
  assert.equal(body.ok, true);
  assert.equal(body.instance, app.instance);
  assert.match(body.instance, /^[0-9a-f]{16}$/);
});

// ---- the Hotspot service (PLAN §20.4, §20.5) ------------------------------------------------

/** Just the settings the hotspot reads and writes. */
function fakeSettings(hotspot = {}, server = {}) {
  const data = { party: { roomCode: 'ABCD', hotspot: { enabled: true, ssid: '', password: '', band: 'auto', ifname: '', ...hotspot } }, server: { host: '0.0.0.0', ...server } };
  const updates = [];
  return {
    data,
    updates,
    get: (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data),
    update(patch) {
      updates.push(patch);
      if (patch.party?.hotspot) Object.assign(data.party.hotspot, patch.party.hotspot);
    },
  };
}

async function makeHotspot(scenario, { settings = fakeSettings(), health, platform = 'linux', readText = async () => '', pollMs = 60_000, listenAddress = () => '0.0.0.0' } = {}) {
  const { Hotspot } = await import('../server/net/hotspot.js');
  const nm = fakeNmcli(scenario);
  const hs = new Hotspot({
    run: nm.run, settings, port: () => 6527, instance: 'me', platform, readText, pollMs, listenAddress,
    health: health || (async (url) => (url === 'http://10.42.0.1:6527/api/health' ? { ok: true, instance: 'me' } : null)),
  });
  const changes = [];
  hs.on('change', (v) => changes.push(v.state));
  return { hs, nm, settings, changes };
}

const byId = (view) => Object.fromEntries(view.checks.map((c) => [c.id, c]));

test('Hotspot: on with every check passed; a name from the room code; a password made up once', async () => {
  const { hs, nm, settings, changes } = await makeHotspot('ok');
  const v = await hs.start();
  assert.equal(v.state, 'on');
  assert.equal(hs.active, true);
  assert.equal(hs.ip, '10.42.0.1');
  assert.equal(v.ssid, 'OpenKaraoke-ABCD');
  assert.ok(validPassword(v.password));
  assert.deepEqual(settings.updates, [{ party: { hotspot: { password: v.password } } }], 'the password is kept for next time');
  assert.deepEqual(v.checks.map((c) => `${c.id}:${c.level}`), ['linux:ok', 'nmcli:ok', 'running:ok', 'permission:ok', 'radio:ok', 'device:ok', 'ap:ok', 'listen:ok', 'uplink:ok', 'up:ok', 'address:ok', 'reach:ok']);
  assert.match(byId(v).uplink.text, /enp3s0/);
  assert.equal(changes[0], 'starting');
  assert.equal(changes.at(-1), 'on');
  const add = nm.calls.find((c) => c[1] === 'connection' && c[2] === 'add');
  assert.equal(add[add.indexOf('ssid') + 1], 'OpenKaraoke-ABCD');
  assert.ok(nm.calls.every((c) => c[0] === 'nmcli' || c[0] === 'firewall-cmd'), 'only nmcli and firewall-cmd');
  // Started again while on: nothing happens (changed settings go through retry()).
  const before = nm.calls.length;
  assert.equal((await hs.start()).state, 'on');
  assert.equal(nm.calls.length, before);
  // Off: brought down, the adapter is free again.
  assert.equal((await hs.stop()).state, 'off');
  assert.equal(nm.state.devices[0].state, 'disconnected');
  assert.equal(hs.ip, '');
});

test('Hotspot: warnings — the home Wi-Fi drops, a password prompt, firewalls', async () => {
  let { hs, nm } = await makeHotspot('home-wifi');
  let v = await hs.start();
  assert.equal(v.state, 'on');
  assert.equal(byId(v).uplink.level, 'warn');
  assert.match(byId(v).uplink.text, /leaves “HomeNet”/);
  await hs.stop();
  assert.equal(nm.state.devices[0].connection, 'HomeNet', 'the home Wi-Fi comes back');

  let auth;
  ({ hs, nm: auth } = await makeHotspot('auth'));
  v = await hs.start();
  assert.equal(v.state, 'on');
  assert.equal(byId(v).permission.level, 'warn');
  assert.match(byId(v).permission.fix, /within about 20 seconds/);
  const up = auth.calls.find((c) => c[3] === 'connection' && c[4] === 'up');
  assert.deepEqual(up, ['nmcli', '--wait', '30', 'connection', 'up', 'uuid', auth.state.connections.at(-1).uuid], 'the profile just made, by its UUID');

  ({ hs, nm } = await makeHotspot('gnome-hotspot'));
  v = await hs.start();
  assert.equal(v.state, 'on');
  assert.equal(byId(v)['other-ap'].level, 'warn');
  assert.match(byId(v)['other-ap'].text, /Another hotspot \(“Hotspot”\)/);
  assert.ok(!byId(v).uplink || byId(v).uplink.level === 'ok', 'GNOME’s hotspot is not the home Wi-Fi');

  ({ hs } = await makeHotspot('firewalld'));
  v = await hs.start();
  assert.equal(byId(v).firewall.level, 'warn');
  assert.match(byId(v).firewall.fix, /--zone=nm-shared --add-port=6527\/tcp/);

  ({ hs } = await makeHotspot('ok', { readText: async (f) => (f === '/etc/ufw/ufw.conf' ? '# comment\nENABLED=yes\nLOGLEVEL=low\n' : '') }));
  v = await hs.start();
  assert.match(byId(v).firewall.fix, /ufw allow in on wlp2s0 to any port 6527 proto tcp/);
});

test('Hotspot: every blocking check fails with its reason and fix, and leaves nothing behind', async () => {
  const cases = [
    ['no-nmcli', 'nmcli', /isn’t installed/, /apt install network-manager/],
    ['nm-stopped', 'running', /isn’t running/, /systemctl start NetworkManager/],
    ['no-permission', 'permission', /may not change the network/, /logged in at this computer/],
    ['no-session', 'permission', /share a Wi-Fi hotspot/, /not over SSH/],
    ['unmanaged', 'device', /doesn’t manage this Wi-Fi adapter \(wlp2s0\)/, /unmanaged-devices/],
    ['delete-fails', 'up', /couldn’t replace the earlier party hotspot: Connection deletion failed: Insufficient privileges not all connections deleted\./, /password/],
    ['wifi-off', 'radio', /Wi-Fi is switched off/, /flight mode/],
    ['no-device', 'device', /No Wi-Fi adapter/, /USB Wi-Fi adapter/],
    ['no-ap', 'ap', /can’t be a hotspot/, /AP\) mode/],
    ['up-fails', 'up', /couldn’t start the hotspot: Connection activation failed: 802\.1X/, /Try again/],
    ['no-dnsmasq', 'up', /IP configuration could not be reserved/, /dnsmasq-base/],
    ['no-address', 'address', /got no address/, /dnsmasq/],
  ];
  for (const [scenario, id, reason, fix] of cases) {
    const { hs, nm } = await makeHotspot(scenario);
    const v = await hs.start();
    assert.equal(v.state, 'failed', scenario);
    assert.equal(v.check, id, scenario);
    assert.match(v.reason, reason, scenario);
    assert.match(v.fix, fix, scenario);
    assert.equal(hs.active, false, scenario);
    assert.equal(byId(v)[id].level, 'fail', scenario);
    assert.ok(!nm.state.connections.some((c) => c.hotspot && c.active), `${scenario}: no hotspot left up`);
  }
  // Not Linux: not even nmcli is asked.
  const mac = await makeHotspot('ok', { platform: 'darwin' });
  assert.equal((await mac.hs.start()).check, 'linux');
  assert.equal(mac.nm.calls.length, 0);
  // Bound to one address: nothing is changed.
  const bound = await makeHotspot('ok', { listenAddress: () => '192.168.1.20' });
  const b = await bound.hs.start();
  assert.equal(b.check, 'listen');
  assert.ok(!bound.nm.calls.some((c) => c[2] === 'add' || c[2] === 'up'));
  // Up, but another program answers on the address (or nothing does): down again.
  const other = await makeHotspot('ok', { health: async () => ({ ok: true, instance: 'someone-else' }) });
  const o = await other.hs.start();
  assert.equal(o.check, 'reach');
  assert.match(o.reason, /doesn’t answer at http:\/\/10\.42\.0\.1:6527/);
  assert.equal(other.nm.state.devices[0].state, 'disconnected');
});

test('Hotspot: dropping during the party falls back with the reason; quitting brings it down', async () => {
  let { hs, nm, changes } = await makeHotspot('ok');
  await hs.start();
  nm.drop();
  await hs.poll();
  assert.equal(hs.state, 'on', 'one miss is not a drop');
  await hs.poll();
  assert.equal(hs.state, 'failed');
  assert.equal(hs.view().check, 'dropped');
  assert.match(hs.view().reason, /NetworkManager took it down/);
  assert.match(hs.view().fix, /home Wi-Fi/);
  assert.equal(hs.ip, '');
  assert.equal(changes.at(-1), 'failed');
  // Try again: on again.
  assert.equal((await hs.retry()).state, 'on');

  ({ hs, nm } = await makeHotspot('ok'));
  await hs.start();
  nm.radioOff();
  await hs.poll();
  await hs.poll();
  assert.match(hs.view().reason, /Wi-Fi was switched off/);

  // The watcher runs by itself.
  ({ hs, nm } = await makeHotspot('drops', { pollMs: 10 }));
  await hs.start();
  for (let i = 0; i < 100 && hs.state === 'on'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(hs.state, 'failed');
  await hs.close();

  // Quitting with the hotspot on: down; started by someone else (never by us): left alone.
  ({ hs, nm } = await makeHotspot('ok'));
  await hs.start();
  await hs.close();
  assert.equal(nm.state.devices[0].state, 'disconnected');
  assert.ok(nm.calls.some((c) => c[1] === 'connection' && c[2] === 'down'));
  ({ hs, nm } = await makeHotspot('ok'));
  await hs.close();
  assert.equal(nm.calls.length, 0);
});

test('Hotspot: one start at a time; bad saved settings fall back to safe values', async () => {
  const { hs, nm } = await makeHotspot('ok');
  const [a, b] = await Promise.all([hs.start(), hs.start()]);
  assert.equal(a.state, 'on');
  assert.equal(b.state, 'on');
  assert.equal(nm.calls.filter((c) => c[2] === 'add').length, 1);
  const odd = await makeHotspot('ok', { settings: fakeSettings({ ssid: '-bad\nname', password: 'short', band: 'x', ifname: 'wl;rm' }) });
  const cfg = odd.hs.config();
  assert.deepEqual([cfg.ssid, cfg.password, cfg.band, cfg.ifname], ['OpenKaraoke-ABCD', '', 'auto', '']);
});

// ---- the app with a hotspot: join address, views, security (PLAN §20.3, §20.6) ----------------

import { WebSocket } from '../server/vendor/ws.mjs';
import { fetchHealth, fixForUpError } from '../server/net/hotspot.js';

const HOTSPOT_IP = '10.42.0.1';

async function hotspotApp(scenario = 'ok', { enabled = false } = {}) {
  const dir = await tmpDir('ok-hotspot-app-');
  if (enabled) {
    await (await import('node:fs/promises')).writeFile(`${dir}/settings.json`, JSON.stringify({ party: { roomCode: 'WXYZ', hotspot: { enabled: true } } }));
  }
  const nm = fakeNmcli(scenario);
  // Phones would reach this server at 10.42.0.1; in the test it is 127.0.0.1.
  const health = (url) => (url.startsWith(`http://${HOTSPOT_IP}:`) ? fetchHealth(url.replace(HOTSPOT_IP, '127.0.0.1')) : Promise.resolve(null));
  // The test server listens on 127.0.0.1 only; a real one on 0.0.0.0 (check 8 is tested apart).
  const app = await createApp({ dataDir: dir, scan: false, watch: false, fetch: offlineFetch, crawl: false, hotspot: { run: nm.run, health, platform: 'linux', readText: async () => '', pollMs: 60_000, listenAddress: () => '0.0.0.0' } });
  await app.listen(0, '127.0.0.1');
  return { app, nm, base: `http://127.0.0.1:${app.port}` };
}

/** Waits for the hotspot's start/stop under way (they run one at a time). */
const settle = (app) => app.hotspot.chain;
const asHost = { role: 'host', data: {}, isLocal: true, ip: '127.0.0.1', send() {} };

function rawGet(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function wsHello(base, headers, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers });
    ws.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.t === 'welcome' || msg.t === 'denied') {
        ws.close();
        resolve(msg);
      }
    });
  });
}

test('app: the hotspot moves every join link to its address, and back when it drops', async (t) => {
  const { app, nm } = await hotspotApp('ok');
  t.after(() => app.close());
  const room = app.room;
  assert.equal(app.info().mode, 'lan');
  assert.equal(room.tvView().hotspot, null);

  await room.request(asHost, { t: 'hotspot.set', on: true });
  await settle(app);
  assert.equal(app.hotspot.state, 'on');
  const info = app.info();
  assert.equal(info.mode, 'hotspot');
  assert.equal(info.joinUrl, `http://${HOTSPOT_IP}:${app.port}/j/${info.roomCode}`);
  assert.equal(room.publicInfo().joinUrl, info.joinUrl, 'the TV, boards and guests get it too');
  const tv = room.tvView().hotspot;
  assert.equal(tv.ssid, `OpenKaraoke-${info.roomCode}`);
  assert.match(tv.qr, new RegExp(`^WIFI:T:WPA;S:OpenKaraoke-${info.roomCode};P:${tv.password};;$`));
  assert.equal(room.tvView().wifi, null, 'no home-Wi-Fi QR while the hotspot is step 1');
  const hv = room.hostView();
  assert.equal(hv.hotspot.state, 'on');
  assert.equal(hv.hotspot.password, tv.password, 'the host sees the password');
  assert.equal(hv.settings.party.hotspot.password, '••••••', 'masked in the settings view');
  assert.ok(!JSON.stringify(room.guestBase()).includes(tv.password), 'guests never get the password');
  assert.ok(!('hotspot' in room.guestBase()));

  // Settings can't switch it around the checks.
  assert.equal(app.settings.get('party.hotspot.ssid'), `OpenKaraoke-${info.roomCode}`, 'the name is fixed when switched on');
  assert.equal(app.settings.get('party.hotspot.password'), tv.password);
  await room.request(asHost, { t: 'settings.update', patch: { party: { roomCode: 'QQQQ', hotspot: { enabled: false, ssid: 'sneaky' } } } });
  assert.equal(app.settings.get('party.hotspot.enabled'), true);
  assert.equal(app.settings.get('party.hotspot.ssid'), `OpenKaraoke-${info.roomCode}`, 'a new room code doesn’t rename the Wi-Fi');
  const publicInfo = await (await fetch(`http://127.0.0.1:${app.port}/api/info`)).text();
  assert.ok(!publicInfo.includes(tv.password) && !publicInfo.includes('WIFI:'), '/api/info (anyone may read it) has no password');

  // It drops: the join link is the home network's again, at once.
  nm.drop();
  await app.hotspot.poll();
  await app.hotspot.poll();
  assert.equal(app.hotspot.state, 'failed');
  assert.equal(app.info().mode, 'lan');
  assert.notEqual(app.info().joinUrl, info.joinUrl);
  assert.equal(room.tvView().hotspot, null);
  assert.match(room.hostView().hotspot.reason, /stopped/);

  // Try again; then off.
  await room.request(asHost, { t: 'hotspot.retry' });
  await settle(app);
  assert.equal(app.hotspot.state, 'on');
  await room.request(asHost, { t: 'hotspot.set', on: false });
  await settle(app);
  assert.equal(app.hotspot.state, 'off');
  assert.equal(app.settings.get('party.hotspot.enabled'), false);
  assert.equal(app.info().mode, 'lan');
});

test('app: hotspot settings are validated; switched on last time it starts again; quitting brings it down', async (t) => {
  let { app, nm } = await hotspotApp('ok');
  t.after(() => app.close());
  const room = app.room;
  for (const bad of [{ ssid: 'x'.repeat(33) }, { ssid: '-x' }, { password: 'short' }, { band: '6ghz' }, { ifname: 'wl;rm' }]) {
    await assert.rejects(room.request(asHost, { t: 'hotspot.config', ...bad }), undefined, JSON.stringify(bad));
  }
  await room.request(asHost, { t: 'hotspot.config', ssid: 'Karaoke Night', password: '', band: 'bg', ifname: 'wlp2s0' });
  const saved = app.settings.get('party.hotspot');
  assert.equal(saved.ssid, 'Karaoke Night');
  assert.ok(validPassword(saved.password), 'an empty password makes a new one');
  await room.request(asHost, { t: 'hotspot.config', password: '••••••' });
  assert.equal(app.settings.get('party.hotspot.password'), saved.password, 'the masked password is not saved');
  assert.deepEqual(nm.calls, [['nmcli', '-g', 'GENERAL.STATE', 'connection', 'show', 'id', CONNECTION_NAME]], 'with the switch off only the look for a left-over hotspot reached nmcli');
  await app.close();

  ({ app, nm } = await hotspotApp('ok', { enabled: true }));
  await settle(app);
  assert.equal(app.hotspot.state, 'on', 'on again after a restart');
  await app.close();
  assert.ok(nm.calls.some((c) => c[1] === 'connection' && c[2] === 'down'), 'quitting brings it down');
  assert.equal(nm.state.devices[0].state, 'disconnected');

  // A failing hotspot at start-up: the party starts anyway, on the home network.
  ({ app } = await hotspotApp('wifi-off', { enabled: true }));
  await settle(app);
  assert.equal(app.hotspot.state, 'failed');
  assert.equal(app.info().mode, 'lan');
  assert.match(app.room.hostView().hotspot.fix, /Switch Wi-Fi on/);
});

test('security: guests on the hotspot address are welcome; the host role and foreign origins are not', async (t) => {
  const { app, nm, base } = await hotspotApp('ok');
  t.after(() => app.close());
  await app.room.request(asHost, { t: 'hotspot.set', on: true });
  await settle(app);
  const port = app.port;
  const code = app.info().roomCode;
  const hotspotHost = `${HOTSPOT_IP}:${port}`;
  const hotspotOrigin = `http://${hotspotHost}`;

  // Guests: the join page and the WebSocket with the IP-literal Host and its Origin.
  assert.equal(await rawGet(base, `/j/${code}`, { host: hotspotHost }), 200);
  // An IP-literal Host can't be rebound: this computer keeps its host rights through it; a
  // foreign name never gets them.
  assert.equal(await rawGet(base, '/api/fs/list', { host: hotspotHost }), 200);
  assert.equal(await rawGet(base, '/api/fs/list', { host: `evil.example:${port}` }), 403);
  const welcome = await wsHello(base, { host: hotspotHost, origin: hotspotOrigin }, { t: 'hello', role: 'guest', room: code });
  assert.equal(welcome.t, 'welcome');
  assert.equal(welcome.role, 'guest');
  assert.equal(welcome.state.info.joinUrl, `${hotspotOrigin}/j/${code}`);
  const pin = await fetch(`${base}/api/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hotspotOrigin }, body: '{"pin":"1234"}' });
  assert.ok(!/other web sites/.test(await pin.text()), 'a POST from the hotspot page is not cross-site');

  // Foreign origins: another site, another phone's address on the hotspot.
  for (const origin of ['http://evil.example', `http://10.42.0.99:${port}`, `http://${HOTSPOT_IP}.evil.example:${port}`]) {
    await assert.rejects(wsHello(base, { host: hotspotHost, origin }, { t: 'hello', role: 'guest', room: code }), /403/, origin);
    const res = await fetch(`${base}/api/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{"pin":"1234"}' });
    assert.equal(res.status, 403, origin);
    assert.match(await res.text(), /other web sites/, origin);
  }

  // The host role from a phone on the hotspot: never without the PIN, whatever the headers say.
  const auth = app.auth;
  for (const ip of ['10.42.0.23', '::ffff:10.42.0.23']) {
    assert.equal(auth.isHost(ip, null), false, ip);
    assert.equal(auth.isHostRequest({ headers: { host: hotspotHost, origin: hotspotOrigin }, socket: { remoteAddress: ip } }), false, ip);
    const denied = await app.room.hello({ role: 'host', ip, isLocal: false, data: {}, send() {} }, { role: 'host' });
    assert.deepEqual(denied, { ok: false, reason: 'host_only' }, ip);
  }
  // With a PIN set, only its token opens the host role.
  app.settings.update({ party: { adminPin: '4321' } });
  assert.equal((await app.room.hello({ role: 'host', ip: '10.42.0.23', isLocal: false, data: {}, send() {} }, { role: 'host' })).reason, 'pin_required');
  const token = auth.loginWithPin('4321', '10.42.0.23');
  assert.equal(auth.isHost('10.42.0.23', token), true);
  // A TV on the hotspot still needs pairing.
  assert.equal((await app.room.hello({ role: 'tv', ip: '10.42.0.23', isLocal: false, data: {}, send() {} }, { role: 'tv' })).reason, 'pairing_required');

  // Once the hotspot is gone, its address is no longer one of our names.
  nm.drop();
  await app.hotspot.poll();
  await app.hotspot.poll();
  assert.ok(!auth.extraNames().includes(HOTSPOT_IP));
  await assert.rejects(wsHello(base, { host: hotspotHost, origin: hotspotOrigin }, { t: 'hello', role: 'guest', room: code }), /403/);
});

test('app: without a runner NetworkManager is never asked; bound to one address the hotspot refuses', async (t) => {
  const dir = await tmpDir('ok-hotspot-norun-');
  const app = await createApp({ dataDir: dir, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  await app.room.request(asHost, { t: 'hotspot.set', on: true });
  await settle(app);
  assert.equal(app.hotspot.state, 'failed');
  assert.equal(app.hotspot.view().check, process.platform === 'linux' ? 'nmcli' : 'linux');

  const nm = fakeNmcli('ok');
  const dir2 = await tmpDir('ok-hotspot-bound-');
  const bound = await createApp({ dataDir: dir2, scan: false, watch: false, fetch: offlineFetch, crawl: false, hotspot: { run: nm.run, platform: 'linux' } });
  await bound.listen(0, '127.0.0.1');
  t.after(() => bound.close());
  await bound.room.request(asHost, { t: 'hotspot.set', on: true });
  await settle(bound);
  assert.equal(bound.hotspot.view().check, 'listen');
  assert.match(bound.hotspot.view().reason, /only listens on 127\.0\.0\.1/);
  assert.ok(!nm.calls.some((c) => c[2] === 'add'));
});

test('fake nmcli as a program (OPENKARAOKE_NMCLI): the real runner starts it, its state lasts between calls', async () => {
  const dir = await tmpDir('ok-fake-prog-');
  const env = { ...process.env, OPENKARAOKE_NMCLI: new URL('../scripts/fake-nmcli.mjs', import.meta.url).pathname, FAKE_NMCLI_SCENARIO: 'home-wifi', FAKE_NMCLI_STATE: `${dir}/nm.json` };
  const run = systemRunner({ env });
  assert.match((await run('nmcli', ['--version'])).stdout, /nmcli tool, version/);
  assert.equal((await run('nmcli', ['-t', '-f', 'WIFI', 'radio'])).stdout, 'enabled\n');
  assert.equal((await run('nmcli', addConnectionArgs({ ifname: 'wlp2s0', ssid: 'P', password: '12345678', band: 'auto' }))).code, 0);
  assert.equal((await run('nmcli', ['connection', 'up', 'id', CONNECTION_NAME])).code, 0);
  assert.equal((await run('nmcli', ['-g', 'GENERAL.STATE', 'connection', 'show', 'id', CONNECTION_NAME])).stdout, 'activated\n', 'remembered between runs');
  assert.equal((await run('firewall-cmd', ['--state'])).code, 252);
});

test('Hotspot: an older NetworkManager without client isolation; a hotspot left up by a crash', async () => {
  let { hs, nm } = await makeHotspot('old-nm');
  let v = await hs.start();
  assert.equal(v.state, 'on');
  assert.equal(byId(v).isolation.level, 'warn');
  const adds = nm.calls.filter((c) => c[2] === 'add');
  assert.equal(adds.length, 2);
  assert.ok(adds[0].includes('802-11-wireless.ap-isolation') && !adds[1].includes('802-11-wireless.ap-isolation'));
  ({ hs, nm } = await makeHotspot('ok'));
  v = await hs.start();
  assert.ok(!v.checks.some((c) => c.id === 'isolation'));
  assert.ok(nm.calls.find((c) => c[2] === 'add').includes('802-11-wireless.ap-isolation'), 'phones kept apart');

  // Switch off at start-up: the left-over party hotspot goes down; on: it is replaced.
  ({ hs, nm } = await makeHotspot('leftover'));
  await hs.cleanup();
  assert.equal(nm.state.devices[0].state, 'disconnected');
  ({ hs, nm } = await makeHotspot('leftover'));
  assert.equal((await hs.start()).state, 'on');
  assert.equal(nm.state.connections.filter((c) => c.name === CONNECTION_NAME).length, 1);
});

test('app: hosts follow the checks; when the hotspot goes, its phones and screens are let go at once', async (t) => {
  const { app, nm } = await hotspotApp('ok');
  t.after(() => app.close());
  const sent = [];
  const fakeClient = (role, ip, isLocal = false) => ({ role, ip, isLocal, data: {}, closed: null, send(m) { sent.push([role, m.t]); }, close(code) { this.closed = code; } });
  const phone = fakeClient('guest', '10.42.0.23');
  const v6phone = fakeClient('guest', '::ffff:10.42.0.24');
  const home = fakeClient('guest', '192.168.1.40');
  const local = fakeClient('tv', '10.42.0.1', true);
  const host = fakeClient('host', '127.0.0.1', true);
  const realList = app.hub.list.bind(app.hub);
  app.hub.list = (pred = () => true) => [...realList(pred), ...[phone, v6phone, home, local, host].filter(pred)];
  const realBroadcast = app.hub.broadcast.bind(app.hub);
  app.hub.broadcast = (msg, pred = () => true) => {
    for (const c of [phone, v6phone, home, local, host]) if (pred(c)) c.send(msg);
    return realBroadcast(msg, pred);
  };
  await app.room.request(asHost, { t: 'hotspot.set', on: true });
  await settle(app);
  const progress = sent.filter(([, t]) => t === 'hotspot');
  assert.ok(progress.length >= 10 && progress.every(([role]) => role === 'host'), 'every check step, to hosts only');
  nm.drop();
  await app.hotspot.poll();
  await app.hotspot.poll();
  assert.deepEqual([phone.closed, v6phone.closed, home.closed, local.closed, host.closed], [1001, 1001, null, null, null]);
});

