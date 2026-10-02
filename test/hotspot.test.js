// The party hotspot (PLAN §20): talking to NetworkManager through an injected runner, checked
// against scripts/fake-nmcli.mjs. The real nmcli is never used here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addConnectionArgs, getValues, makePassword, nmError, splitTerse, systemRunner, terseFields, terseRows, validIfname, validPassword, validSsid, CONNECTION_NAME } from '../server/net/nmcli.js';
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
});

test('hotspot values: name, password, adapter; the connection nmcli gets', () => {
  for (const ok of ['OpenKaraoke-ABCD', 'Café 🎤', 'a', 'x'.repeat(32)]) assert.ok(validSsid(ok), ok);
  for (const bad of ['', ' padded', 'x'.repeat(33), 'ä'.repeat(17), '-oops', 'line\nbreak', 'tab\there', null, 5]) assert.ok(!validSsid(bad), String(bad));
  for (const ok of ['12345678', 'x'.repeat(63), 'with spaces ok!']) assert.ok(validPassword(ok), ok);
  for (const bad of ['1234567', 'x'.repeat(64), 'héllo123', 'tab\tinside', undefined]) assert.ok(!validPassword(bad), String(bad));
  for (const ok of ['wlp2s0', 'wlan0', 'wlx00c0ca1234ab', 'wl.0_1']) assert.ok(validIfname(ok), ok);
  for (const bad of ['', '-x', 'a'.repeat(16), 'wl p', 'wl/0', 'wl;rm']) assert.ok(!validIfname(bad), bad);
  const pw = makePassword(() => 0.5);
  assert.match(pw, /^[a-z2-9]{12}$/);
  assert.ok(validPassword(makePassword()));

  const args = addConnectionArgs({ ifname: 'wlp2s0', ssid: 'OpenKaraoke-ABCD', password: 'secret-pass', band: 'auto' });
  const kv = (name) => args[args.indexOf(name) + 1];
  assert.deepEqual(args.slice(0, 4), ['connection', 'add', 'type', 'wifi']);
  assert.equal(kv('con-name'), CONNECTION_NAME);
  assert.equal(kv('ifname'), 'wlp2s0');
  assert.equal(kv('ssid'), 'OpenKaraoke-ABCD');
  assert.equal(kv('802-11-wireless.mode'), 'ap');
  assert.equal(kv('ipv4.method'), 'shared');
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
