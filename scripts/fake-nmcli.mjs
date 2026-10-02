#!/usr/bin/env node
// A pretend NetworkManager for the party hotspot's tests (PLAN §20.7): answers the nmcli and
// firewall-cmd commands the app uses, with nmcli's output formats, exit codes and messages,
// from a scenario. Real nmcli is never used in tests.
//
//   In-process (tests, OPENKARAOKE_FAKE_NMCLI=<scenario> for trying the UI by hand):
//     const nm = fakeNmcli('home-wifi'); createApp({ hotspot: { run: nm.run } }); nm.calls; nm.drop();
//   As a program:  FAKE_NMCLI_SCENARIO=ok FAKE_NMCLI_STATE=/tmp/nm.json node scripts/fake-nmcli.mjs -t -f WIFI radio
//
// Scenarios: ok, home-wifi, gnome-hotspot, auth (a password prompt), no-session (over SSH or as
// a service: may not share Wi-Fi), no-nmcli, nm-stopped, no-permission, wifi-off, no-device,
// unmanaged, no-ap, up-fails, no-dnsmasq, no-address, drops, firewalld, old-nm (no client
// isolation), leftover (a party hotspot still up from an earlier run), delete-fails (an old
// party hotspot profile that can't be removed).
//
// Outputs, exit codes and messages follow NetworkManager 1.46 (checked against a real nmcli and
// the 1.46/1.48 sources; the 1.22 property list for old-nm).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// `nmcli general permissions` lists these 17, in this order.
const PERMISSIONS = [
  'checkpoint-rollback', 'enable-disable-connectivity-check', 'enable-disable-network', 'enable-disable-statistics',
  'enable-disable-wifi', 'enable-disable-wimax', 'enable-disable-wwan', 'network-control', 'reload',
  'settings.modify.global-dns', 'settings.modify.hostname', 'settings.modify.own', 'settings.modify.system',
  'sleep-wake', 'wifi.scan', 'wifi.share.open', 'wifi.share.protected',
];
const perm = (st, p) => st.perms[p] || 'yes';
const OLD_WIFI_PROPERTIES = 'ssid, mode, band, channel, bssid, rate, tx-power, mac-address, cloned-mac-address, generate-mac-address-mask, mac-address-blacklist, mac-address-randomization, mtu, seen-bssids, hidden, powersave, wake-on-wlan';

const uuid = (n) => `6f1c2a3e-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The pretend computer of each scenario. */
export function scenarioState(name = 'ok') {
  const st = {
    scenario: name,
    installed: true,
    running: true,
    version: '1.46.0',
    perms: {}, // permission → yes | no | auth (missing: yes)
    radio: 'enabled',
    devices: [
      { name: 'wlp2s0', type: 'wifi', state: 'disconnected', connection: '', ap: 'yes', address: '' },
      { name: 'enp3s0', type: 'ethernet', state: 'connected', connection: 'Wired connection 1', address: '192.168.1.20/24' },
      { name: 'lo', type: 'loopback', state: 'connected (externally)', connection: 'lo', address: '127.0.0.1/8' },
    ],
    connections: [
      { name: 'Wired connection 1', uuid: uuid(1), type: '802-3-ethernet', device: 'enp3s0', active: true },
      { name: 'HomeNet', uuid: uuid(2), type: '802-11-wireless', device: '', active: false, autoconnect: true, mode: 'infrastructure' },
      { name: 'lo', uuid: uuid(3), type: 'loopback', device: 'lo', active: true },
    ],
    hotspotAddress: '10.42.0.1/24',
    upError: '',
    dropAfterPolls: 0,
    polls: 0,
    firewalld: false,
    nextId: 10,
  };
  const wifi = st.devices[0];
  switch (name) {
    case 'ok': break;
    case 'home-wifi': // Wi-Fi only: the hotspot takes the adapter from the home network
      Object.assign(wifi, { state: 'connected', connection: 'HomeNet', address: '192.168.1.31/24' });
      Object.assign(st.connections[1], { device: 'wlp2s0', active: true });
      Object.assign(st.devices[1], { state: 'unavailable', connection: '', address: '' });
      st.connections[0].active = false;
      st.connections[0].device = '';
      break;
    case 'gnome-hotspot': // GNOME's own "Hotspot" already runs on the adapter
      st.connections.push({ name: 'Hotspot', uuid: uuid(4), type: '802-11-wireless', device: 'wlp2s0', active: true, mode: 'ap' });
      Object.assign(wifi, { state: 'connected', connection: 'Hotspot', address: '10.42.0.1/24' });
      break;
    // At the desktop, not an administrator: changing system connections asks for a password.
    case 'auth': st.perms = { 'settings.modify.system': 'auth' }; break;
    // Over SSH or as a service of another user: prompts, and sharing Wi-Fi is never allowed.
    case 'no-session': st.perms = { 'network-control': 'auth', 'settings.modify.system': 'auth', 'wifi.share.protected': 'no', 'wifi.share.open': 'no' }; break;
    case 'no-nmcli': st.installed = false; break;
    case 'nm-stopped': st.running = false; break;
    case 'no-permission': st.perms = { 'network-control': 'no', 'settings.modify.system': 'no', 'wifi.share.protected': 'no', 'wifi.share.open': 'no' }; break;
    case 'wifi-off': st.radio = 'disabled'; wifi.state = 'unavailable'; break;
    case 'no-device': st.devices.splice(0, 1); break;
    case 'unmanaged': wifi.state = 'unmanaged'; break;
    case 'no-ap': wifi.ap = 'no'; break;
    case 'up-fails': st.upError = 'Connection activation failed: 802.1X supplicant took too long to authenticate'; break;
    case 'no-dnsmasq': st.upError = 'Connection activation failed: IP configuration could not be reserved (no available address, timeout, etc.)'; break;
    case 'no-address': st.hotspotAddress = ''; break;
    case 'drops': st.dropAfterPolls = 2; break;
    case 'firewalld': st.firewalld = true; break;
    case 'old-nm': st.version = '1.22.10'; st.noIsolation = true; break;
    case 'leftover':
      st.connections.push({ name: 'OpenKaraoke hotspot', uuid: uuid(5), type: '802-11-wireless', device: 'wlp2s0', active: true, hotspot: true, mode: 'ap' });
      Object.assign(wifi, { state: 'connected', connection: 'OpenKaraoke hotspot', address: '10.42.0.1/24' });
      break;
    case 'delete-fails':
      st.connections.push({ name: 'OpenKaraoke hotspot', uuid: uuid(6), type: '802-11-wireless', device: 'wlp2s0', active: false, hotspot: true, mode: 'ap', locked: true });
      break;
    default: throw new Error(`unknown fake-nmcli scenario: ${name}`);
  }
  return st;
}

/** nmcli -t escaping: ':' and '\' inside a field. */
const esc = (v) => String(v ?? '').replace(/([\\:])/g, '\\$1');
const out = (stdout, code = 0, stderr = '') => ({ code, stdout: stdout ? `${stdout}\n` : '', stderr: stderr ? `${stderr}\n` : '' });
const err = (code, message) => out('', code, `Error: ${message}`);

/** Runs one command against `st` (mutating it, like the real thing). */
export function runFake(st, cmd, args) {
  if (cmd === 'firewall-cmd') {
    if (args.join(' ') !== '--state') return out('', 2, 'usage: see firewall-cmd man page');
    return st.firewalld ? out('running') : out('', 252, 'not running');
  }
  if (cmd !== 'nmcli') return out('', 127, `${cmd}: command not found`);
  if (!st.installed) return out('', 127, 'nmcli: command not found');
  let a = [...args];
  if (a[0] === '--version') return out(`nmcli tool, version ${st.version}`);
  if (a[0] === '--wait') a = a.slice(2);
  // Options before the object: -t, -f FIELDS, -g FIELDS.
  let fields = null;
  let getValues = false;
  for (;;) {
    if (a[0] === '-t' || a[0] === '--terse') a = a.slice(1);
    else if (a[0] === '-f' || a[0] === '--fields') { fields = a[1]; a = a.slice(2); }
    else if (a[0] === '-g' || a[0] === '--get-values') { fields = a[1]; getValues = true; a = a.slice(2); }
    else break;
  }
  if (!st.running) return err(8, 'NetworkManager is not running.');
  const [object, verb, ...rest] = a;
  const wifiDev = (name) => st.devices.find((d) => d.name === name);
  // The profile named by `[id|uuid] <x>`: the first one, like nmcli (names can repeat).
  const [selector, ref] = rest[0] === 'id' || rest[0] === 'uuid' ? rest : ['id', rest[0]];
  const matches = () => st.connections.filter((c) => (selector === 'uuid' ? c.uuid === ref : c.name === ref));
  const hotspot = () => matches()[0];

  if (object === 'general' && !verb && fields === 'RUNNING') return out('running');
  if (object === 'general' && verb === 'permissions' && fields === 'PERMISSION,VALUE') {
    return out(PERMISSIONS.map((p) => `${esc(`org.freedesktop.NetworkManager.${p}`)}:${perm(st, p)}`).join('\n'));
  }
  if (object === 'radio' && fields === 'WIFI') return out(st.radio);
  if (object === 'device' && !verb && fields === 'DEVICE,TYPE,STATE,CONNECTION') {
    return out(st.devices.map((d) => [d.name, d.type, d.state, d.connection].map(esc).join(':')).join('\n'));
  }
  if (object === 'device' && verb === 'show') {
    const dev = wifiDev(rest[0]);
    if (!dev) return err(10, `Device '${rest[0]}' not found.`);
    if (fields === 'WIFI-PROPERTIES.AP' && getValues) return dev.type === 'wifi' ? out(dev.ap) : out('');
    if (fields === 'IP4.ADDRESS' && getValues) return out(esc(dev.address).replace(/\\:/g, ':'));
    return err(2, `invalid field '${fields}'.`);
  }
  if (object === 'connection' && (verb === 'show' || !verb) && fields === 'NAME,UUID,TYPE,DEVICE') {
    const active = rest.includes('--active');
    return out(st.connections.filter((c) => !active || c.active).map((c) => [c.name, c.uuid, c.type, c.active ? c.device : ''].map(esc).join(':')).join('\n'));
  }
  if (object === 'connection' && verb === 'show' && fields === '802-11-wireless.mode' && getValues) {
    const c = hotspot();
    if (!c) return err(10, `${ref} - no such connection profile.`);
    return out(c.type === '802-11-wireless' ? c.mode || (c.hotspot ? 'ap' : 'infrastructure') : '');
  }
  if (object === 'connection' && verb === 'show' && fields === 'GENERAL.STATE' && getValues) {
    const c = hotspot();
    if (!c) return err(10, `${ref} - no such connection profile.`);
    if (c.active && c.hotspot && st.dropAfterPolls && ++st.polls >= st.dropAfterPolls) drop(st);
    return out(c.active ? 'activated' : '');
  }
  if (object === 'connection' && verb === 'delete') {
    const all = matches(); // every profile of that name
    if (!all.length) return err(10, `unknown connection '${ref}'.\nError: cannot delete unknown connection(s): ${selector} '${ref}'.`);
    if (perm(st, 'settings.modify.system') === 'no' || all.some((c) => c.locked)) return err(7, 'Connection deletion failed: Insufficient privileges\nError: not all connections deleted.');
    for (const c of all) if (c.active) deactivate(st, c);
    st.connections = st.connections.filter((x) => !all.includes(x));
    return out(all.map((c) => `Connection '${c.name}' (${c.uuid}) successfully deleted.`).join('\n'));
  }
  if (object === 'connection' && verb === 'add') {
    const kv = {};
    for (let i = 0; i < rest.length; i += 2) kv[rest[i]] = rest[i + 1];
    if (kv.type !== 'wifi' || !kv['con-name'] || !kv.ssid) return err(2, 'invalid connection settings.');
    if (st.noIsolation && '802-11-wireless.ap-isolation' in kv) return err(2, `invalid property 'ap-isolation': 'ap-isolation' not among [${OLD_WIFI_PROPERTIES}].`); // NetworkManager < 1.28
    if (perm(st, 'settings.modify.system') === 'no') return err(4, `Failed to add '${kv['con-name']}' connection: Insufficient privileges`);
    // An unknown ifname is accepted here (the profile fails at `up`); a repeated name too.
    const twin = st.connections.find((x) => x.name === kv['con-name']);
    const c = { name: kv['con-name'], uuid: uuid(st.nextId++), type: '802-11-wireless', device: kv.ifname, active: false, hotspot: kv['802-11-wireless.mode'] === 'ap', settings: kv };
    st.connections.push(c);
    return out(`Connection '${c.name}' (${c.uuid}) successfully added.`, 0, twin ? `Warning: There is another connection with the name '${c.name}'. Reference the connection by its uuid '${c.uuid}'` : '');
  }
  if (object === 'connection' && verb === 'up') {
    const c = hotspot();
    if (!c) return err(10, `unknown connection '${ref}'.`);
    const dev = wifiDev(c.device);
    if (perm(st, 'network-control') === 'no') return err(4, 'Connection activation failed: Not authorized to control networking.');
    if (c.hotspot && perm(st, 'wifi.share.protected') === 'no') return err(4, 'Connection activation failed: Not authorized to share connections via wifi.');
    if (!dev || dev.state === 'unavailable') return err(4, `Connection activation failed: No suitable device found for this connection (device ${c.device} not available because device is not available).`);
    if (dev.state === 'unmanaged') return err(4, `Connection activation failed: No suitable device found for this connection (device ${c.device} not available because device is strictly unmanaged).`);
    if (dev.ap !== 'yes' && c.hotspot) return err(4, `Connection activation failed: No suitable device found for this connection (device ${c.device} not available because profile is not compatible with device (the device does not support Access Point mode)).`);
    if (st.upError) return out('', 4, `Error: ${st.upError}\nHint: use 'journalctl -xe NM_CONNECTION=${c.uuid} + NM_DEVICE=${dev.name}' to get more details.`);
    const before = st.connections.find((x) => x.active && x.device === dev.name);
    if (before) before.active = false;
    Object.assign(dev, { state: 'connected', connection: c.name, address: st.hotspotAddress });
    c.active = true;
    st.polls = 0;
    return out(`Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/${st.nextId++})`);
  }
  if (object === 'connection' && verb === 'down') {
    const c = hotspot();
    if (!c) return err(10, `'${rest[rest.length - 1]}' is not an active connection.\nError: no active connection provided.`);
    if (!c.active) return err(10, `'${c.name}' is not an active connection.\nError: no active connection provided.`);
    deactivate(st, c);
    return out(`Connection '${c.name}' successfully deactivated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/${st.nextId++})`);
  }
  return err(2, `the fake doesn't know 'nmcli ${args.join(' ')}'.`);
}

/** The hotspot connection goes down; the home Wi-Fi comes back if it had one (autoconnect). */
function deactivate(st, c) {
  c.active = false;
  const dev = st.devices.find((d) => d.name === c.device);
  if (!dev) return;
  const home = st.scenario === 'home-wifi' && st.connections.find((x) => x.name === 'HomeNet');
  if (home && dev.type === 'wifi') {
    Object.assign(dev, { state: 'connected', connection: 'HomeNet', address: '192.168.1.31/24' });
    Object.assign(home, { active: true, device: dev.name });
  } else {
    Object.assign(dev, { state: 'disconnected', connection: '', address: '' });
  }
}

/** Something outside the app takes the hotspot down (another program, a driver hiccup). */
function drop(st) {
  const c = st.connections.find((x) => x.hotspot && x.active);
  if (c) deactivate(st, c);
}

/** A fake NetworkManager: `run(cmd, args)` like the app's runner, plus what it was asked. */
export function fakeNmcli(scenario = 'ok', { delayMs = 0 } = {}) {
  const st = scenarioState(scenario);
  const calls = [];
  return {
    state: st,
    calls,
    async run(cmd, args) {
      calls.push([cmd, ...args]);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return runFake(st, cmd, args);
    },
    /** Takes the hotspot down from outside the app. */
    drop: () => drop(st),
    /** Switches Wi-Fi off (flight mode). */
    radioOff() {
      st.radio = 'disabled';
      for (const c of st.connections) if (c.active && c.hotspot) deactivate(st, c);
      for (const d of st.devices) if (d.type === 'wifi') Object.assign(d, { state: 'unavailable', connection: '', address: '' });
    },
  };
}

// ---- as a program ------------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.env.FAKE_NMCLI_STATE;
  let st = null;
  try {
    st = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch { /* first run */ }
  st ||= scenarioState(process.env.FAKE_NMCLI_SCENARIO || 'ok');
  const cmd = process.env.FAKE_NMCLI_COMMAND || 'nmcli';
  const res = runFake(st, cmd, process.argv.slice(2));
  if (file) fs.writeFileSync(file, JSON.stringify(st));
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  process.exitCode = res.code;
}
