// The party hotspot (PLAN §20): this PC opens its own Wi-Fi through NetworkManager so guests
// don't need the home network. `start()` runs the checks of §20.4 (each one ok / warn / fail
// with the fix), creates the connection and brings it up, then watches it; anything that fails
// leaves the hotspot off with the reason and the fix (§20.5) — the party carries on over the
// home network. Every program runs through the injected runner (server/net/nmcli.js).
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import { addConnectionArgs, addedUuid, getValues, makePassword, nmError, terseRows, validIfname, validPassword, validSsid, BANDS, CONNECTION_NAME } from './nmcli.js';

const POLL_MS = 5000;
// NetworkManager's own D-Bus calls give up after 25 s whatever `--wait` says, so a password
// prompt (polkit) has to be answered within about 20 s.
const UP_WAIT_S = 30;
const DELETE_WAIT_S = 20;
const CLOSE_MS = 4000; // quitting waits this long at most for the hotspot to go down
const ALL_ADDRESSES = new Set(['0.0.0.0', '::']);

/** GET http://…/api/health with a short timeout → the parsed body, or null. */
export function fetchHealth(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 10_000) body += d; });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** The fix for what NetworkManager said when the hotspot wouldn't come up (on band `band`). */
export function fixForUpError(message, band = 'auto') {
  const m = String(message || '');
  if (/IP configuration could not be reserved|dnsmasq/i.test(m)) return 'NetworkManager needs dnsmasq to share a connection: sudo apt install dnsmasq-base (Fedora: sudo dnf install dnsmasq), then Try again.';
  if (/share connections via wi-?fi/i.test(m)) return 'Run OpenKaraoke as the person logged in at this computer’s desktop (not over SSH or as another user’s service).';
  if (/not authori[sz]ed|insufficient privileges|permission/i.test(m)) return 'Allow it when your password is asked (within about 20 seconds), or run OpenKaraoke as the person logged in at this computer.';
  if (/strictly unmanaged/i.test(m)) return 'NetworkManager is set not to manage this Wi-Fi adapter (unmanaged-devices in /etc/NetworkManager/): remove it there and restart NetworkManager.';
  if (/AP mode|Access Point|No suitable device|not available/i.test(m)) return 'This Wi-Fi adapter can’t be a hotspot right now: unplug and plug it in again, or choose another adapter.';
  if (band === 'a' && /supplicant|took too long|timed? ?out|timeout/i.test(m)) return '5 GHz may not be allowed here, or this adapter can’t send on it: choose 2.4 GHz in Settings → Party, then Try again.';
  if (/secrets|psk|password/i.test(m)) return 'Check the hotspot password (8–63 characters) in Settings → Party, then Try again.';
  if (/timed? ?out|timeout|took too long/i.test(m)) return 'Try again (answer the system’s password prompt within about 20 seconds if one appears). If it keeps failing, restart NetworkManager: sudo systemctl restart NetworkManager.';
  return 'Try again. If it keeps failing, the reason is in: journalctl -u NetworkManager.';
}

const CHECK = (id, level, text, fix = '') => ({ id, level, text, fix });

export class Hotspot extends EventEmitter {
  /**
   * @param {object} o
   * @param {(cmd: string, args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} o.run
   * @param {import('../config.js').Settings} o.settings party.hotspot lives there
   * @param {() => number} o.port the port this server listens on
   * @param {() => string} [o.listenAddress] the address it listens on ('0.0.0.0' = every one)
   * @param {string} o.instance this process (/api/health)
   * @param {(url: string) => Promise<object|null>} [o.health] reachability check (tests pass a fake)
   * @param {string} [o.platform]
   * @param {(file: string) => Promise<string>} [o.readText] for /etc/ufw/ufw.conf
   * @param {string} [o.ownedFile] where the UUID of the profile this server made is kept (the
   *   data folder: one server per folder), so a crashed run's hotspot is found again — and
   *   another OpenKaraoke's hotspot is never touched
   */
  constructor({ run, settings, port, listenAddress = () => '0.0.0.0', instance, health = fetchHealth, platform = process.platform, readText = (f) => fs.readFile(f, 'utf8'), pollMs = POLL_MS, ownedFile = '', closeMs = CLOSE_MS, log } = {}) {
    super();
    this.runner = run;
    this.listenAddress = listenAddress;
    this.settings = settings;
    this.port = port;
    this.instance = instance;
    this.health = health;
    this.platform = platform;
    this.readText = readText;
    this.pollMs = pollMs;
    this.log = log;
    this.timer = null;
    this.misses = 0;
    this.chain = Promise.resolve();
    this.ownedFile = ownedFile;
    this.closeMs = closeMs;
    this.uuid = this.readOwned(); // the profile this server made (and removes again), '' = none
    this.closing = false;
    this.polling = false;
    // device: the adapter in use (the saved choice is config().ifname)
    this.st = { state: 'off', checks: [], reason: '', fix: '', check: '', address: '', device: '', devices: [] };
  }

  readOwned() {
    if (!this.ownedFile) return '';
    try {
      const uuid = JSON.parse(fsSync.readFileSync(this.ownedFile, 'utf8'))?.uuid;
      return typeof uuid === 'string' && /^[0-9a-f-]{36}$/i.test(uuid) ? uuid : '';
    } catch {
      return '';
    }
  }

  /** Remembers (or forgets, '') the profile this server made. */
  own(uuid) {
    this.uuid = uuid;
    if (!this.ownedFile) return;
    try {
      if (uuid) fsSync.writeFileSync(this.ownedFile, JSON.stringify({ uuid }));
      else fsSync.rmSync(this.ownedFile, { force: true });
    } catch (e) {
      this.log?.warn(`party hotspot: couldn’t note its profile: ${e.message}`);
    }
  }

  /** The hotspot's settings, completed (a name from the room code, a password made up once). */
  config() {
    const h = this.settings.get('party.hotspot') || {};
    return {
      enabled: !!h.enabled,
      ssid: validSsid(h.ssid) ? h.ssid : `OpenKaraoke-${this.settings.get('party.roomCode') || 'PARTY'}`,
      password: validPassword(h.password) ? h.password : '',
      band: BANDS.includes(h.band) ? h.band : 'auto',
      ifname: validIfname(h.ifname) ? h.ifname : '',
    };
  }

  get state() {
    return this.st.state;
  }

  /** On, with an address phones can use. */
  get active() {
    return this.st.state === 'on' && !!this.st.address;
  }

  /** The hotspot's IPv4 address ("10.42.0.1"), or '' when it isn't on. */
  get ip() {
    return this.active ? this.st.address : '';
  }

  /** Everything the host page shows (the password too: the host shares it). */
  view() {
    const c = this.config();
    return { ...this.st, ...c, checks: this.st.checks.map((x) => ({ ...x })), devices: [...this.st.devices] };
  }

  set(patch) {
    Object.assign(this.st, patch);
    this.emit('change', this.view());
  }

  /** Runs `fn` after whatever start/stop is under way (one at a time). */
  serial(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Runs a program; a runner that can't (none given, not allowed) counts as "not installed". */
  async run(cmd, args, opts) {
    try {
      return await this.runner(cmd, args, opts);
    } catch (e) {
      return { code: 127, stdout: '', stderr: String(e?.message || e) };
    }
  }

  nmcli(args, opts) {
    return this.run('nmcli', args, opts);
  }

  // ---- start -------------------------------------------------------------------------------

  start() {
    return this.serial(() => this.doStart());
  }

  stop() {
    return this.serial(() => this.doStop());
  }

  /** Off and on again (Try again). */
  retry() {
    return this.serial(async () => {
      await this.doStop();
      return this.doStart();
    });
  }

  async doStart() {
    if (this.st.state === 'on' || this.closing) return this.view(); // changed settings: retry()
    this.stopWatching();
    const checks = [];
    const done = (check) => {
      checks.push(check);
      this.set({ checks: [...checks] });
      return check.level !== 'fail';
    };
    const fail = (check) => {
      done(check);
      this.set({ state: 'failed', check: check.id, reason: check.text, fix: check.fix, address: '' });
      this.log?.warn(`party hotspot: ${check.text}`);
      return this.view();
    };
    this.set({ state: 'starting', checks: [], reason: '', fix: '', check: '', address: '' });
    const cfg = this.config();
    const port = this.port();
    // The name brought up is the one kept: a new room code later doesn't rename it on the TV.
    if (!validSsid(this.settings.get('party.hotspot')?.ssid)) this.settings.update({ party: { hotspot: { ssid: cfg.ssid } } });

    if (this.platform !== 'linux') return fail(CHECK('linux', 'fail', 'The party hotspot needs Linux with NetworkManager.', 'Use the home Wi-Fi: guests scan the QR code on the TV.'));
    done(CHECK('linux', 'ok', 'Linux'));
    const version = await this.nmcli(['--version']);
    if (version.code === 127) return fail(CHECK('nmcli', 'fail', 'NetworkManager (nmcli) isn’t installed.', 'Install NetworkManager (Ubuntu: sudo apt install network-manager — Fedora: sudo dnf install NetworkManager), or use the home Wi-Fi.'));
    done(CHECK('nmcli', 'ok', (version.stdout.trim().replace(/^nmcli tool, /, 'NetworkManager ') || 'NetworkManager').slice(0, 60)));
    const running = await this.nmcli(['-t', '-f', 'RUNNING', 'general']);
    if (running.code !== 0 || running.stdout.trim() !== 'running') return fail(CHECK('running', 'fail', 'NetworkManager isn’t running.', 'Start it: sudo systemctl start NetworkManager'));
    done(CHECK('running', 'ok', 'NetworkManager is running'));

    // Bringing up a WPA hotspot also needs wifi.share.protected, which the system gives only
    // to the person at the desktop (never after a password prompt).
    const perms = Object.fromEntries(terseRows((await this.nmcli(['-t', '-f', 'PERMISSION,VALUE', 'general', 'permissions'])).stdout));
    const may = ['network-control', 'settings.modify.system', 'wifi.share.protected'].map((p) => perms[`org.freedesktop.NetworkManager.${p}`] || 'no');
    if (may.includes('no')) return fail(CHECK('permission', 'fail', 'This user may not change the network or share a Wi-Fi hotspot.', 'Run OpenKaraoke as the person logged in at this computer’s desktop (not over SSH or as another user’s service).'));
    done(may.includes('auth') ? CHECK('permission', 'warn', 'Allowed to change the network after a password prompt.', 'When the system asks for your password, give it within about 20 seconds.') : CHECK('permission', 'ok', 'Allowed to change the network'));

    const radio = (await this.nmcli(['-t', '-f', 'WIFI', 'radio'])).stdout.trim();
    if (radio !== 'enabled') return fail(CHECK('radio', 'fail', 'Wi-Fi is switched off.', 'Switch Wi-Fi on in the system menu (top right) and turn flight mode off, then Try again.'));
    done(CHECK('radio', 'ok', 'Wi-Fi is on'));

    const devices = terseRows((await this.nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'])).stdout)
      .map(([name, type, state, connection]) => ({ name, type, state, connection: connection || '' }));
    const wifi = devices.filter((d) => d.type === 'wifi');
    this.set({ devices: wifi.map((d) => d.name) });
    const usable = (d) => d.state !== 'unavailable' && d.state !== 'unmanaged';
    const dev = cfg.ifname ? wifi.find((d) => d.name === cfg.ifname) : wifi.find(usable) || wifi[0];
    if (!dev) {
      return fail(cfg.ifname && wifi.length
        ? CHECK('device', 'fail', `The chosen Wi-Fi adapter (${cfg.ifname}) isn’t there.`, 'Choose another adapter in Settings → Party.')
        : CHECK('device', 'fail', 'No Wi-Fi adapter found.', 'Plug in a USB Wi-Fi adapter, or use the home Wi-Fi.'));
    }
    if (dev.state === 'unmanaged') return fail(CHECK('device', 'fail', `NetworkManager doesn’t manage this Wi-Fi adapter (${dev.name}).`, fixForUpError('strictly unmanaged')));
    done(CHECK('device', 'ok', `Wi-Fi adapter: ${dev.name}`));
    const ap = getValues((await this.nmcli(['-g', 'WIFI-PROPERTIES.AP', 'device', 'show', dev.name])).stdout)[0];
    if (ap !== 'yes') return fail(CHECK('ap', 'fail', `This Wi-Fi adapter (${dev.name}) can’t be a hotspot.`, 'A USB Wi-Fi adapter that supports hotspot (AP) mode can.'));
    done(CHECK('ap', 'ok', `${dev.name} can be a hotspot`));

    const host = String(this.listenAddress() || '');
    if (!ALL_ADDRESSES.has(host)) return fail(CHECK('listen', 'fail', `OpenKaraoke only listens on ${host || 'one address'}, which phones on the hotspot can’t reach.`, 'Start it without --host (or with --host 0.0.0.0).'));
    done(CHECK('listen', 'ok', 'OpenKaraoke listens on every network'));

    // What the adapter does now: another hotspot (GNOME's own), or the home Wi-Fi, which goes
    // away while it is a hotspot (one radio).
    const current = dev.state === 'connected' && dev.connection && dev.connection !== CONNECTION_NAME ? dev.connection : '';
    const currentMode = current ? getValues((await this.nmcli(['-g', '802-11-wireless.mode', 'connection', 'show', 'id', current])).stdout)[0] : '';
    if (currentMode === 'ap') done(CHECK('other-ap', 'warn', `Another hotspot (“${current}”) is on this adapter: the party hotspot takes its place.`, 'Phones on that hotspot have to join the party’s Wi-Fi.'));
    const homeWifi = current && currentMode !== 'ap' ? current : '';
    const otherUplink = devices.find((d) => d !== dev && d.state === 'connected' && d.type !== 'loopback' && d.type !== 'wifi-p2p' && !/^(lo|docker|virbr|veth|br-)/.test(d.name));
    if (homeWifi && !otherUplink) done(CHECK('uplink', 'warn', `This PC leaves “${homeWifi}” while the hotspot is on.`, 'No internet for new song covers and updates until the hotspot is off — a network cable keeps both.'));
    else if (otherUplink) done(CHECK('uplink', 'ok', `Internet stays on (${otherUplink.name}) and is shared with the phones`));

    // Firewalls that may block the phones (a warning: they may well be set up already).
    const fw = await this.run('firewall-cmd', ['--state']).catch(() => ({ code: 127 }));
    if (fw.code === 0 && /running/.test(fw.stdout || '')) {
      done(CHECK('firewall', 'warn', 'A firewall is on (firewalld).', `If phones can’t open the party: sudo firewall-cmd --zone=nm-shared --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`));
    } else {
      const ufw = await this.readText('/etc/ufw/ufw.conf').catch(() => '');
      if (/^\s*ENABLED\s*=\s*yes\b/m.test(ufw)) done(CHECK('firewall', 'warn', 'A firewall is on (ufw).', `If phones can’t open the party: sudo ufw allow in on ${dev.name} to any port ${port} proto tcp`));
    }

    // Create the connection afresh (settings may have changed) and bring it up.
    let password = cfg.password;
    if (!password) {
      password = makePassword();
      this.settings.update({ party: { hotspot: { password } } });
    }
    if (this.closing) return this.view(); // quitting: nothing new is brought up
    // The earlier profile goes: the one this server made, and party hotspots nobody uses (older
    // runs). One that is up and not ours belongs to another OpenKaraoke: it is left alone.
    const old = terseRows((await this.nmcli(['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show'])).stdout)
      .filter(([name, uuid, , device]) => name === CONNECTION_NAME && (uuid === this.uuid || !device))
      .map(([, uuid]) => uuid);
    for (const uuid of new Set([...old, ...(this.uuid ? [this.uuid] : [])])) {
      const del = await this.nmcli(['--wait', String(DELETE_WAIT_S), 'connection', 'delete', 'uuid', uuid]);
      if (del.code !== 0 && del.code !== 10) {
        const why = nmError(del);
        return fail(CHECK('up', 'fail', `NetworkManager couldn’t replace the earlier party hotspot: ${why}`, fixForUpError(why, cfg.band)));
      }
    }
    this.own('');
    const conn = { ifname: dev.name, ssid: cfg.ssid, password, band: cfg.band };
    let added = await this.nmcli(addConnectionArgs(conn));
    if (added.code !== 0 && /ap-isolation/i.test(nmError(added))) {
      // NetworkManager older than 1.28: no client isolation.
      added = await this.nmcli(addConnectionArgs({ ...conn, isolation: false }));
      if (added.code === 0) done(CHECK('isolation', 'warn', 'This NetworkManager can’t keep the phones apart: guests on the hotspot can reach each other.', 'Use the PC (not a phone with the PIN) for the host controls while the hotspot is on.'));
    }
    if (added.code !== 0) {
      const why = nmError(added);
      return fail(CHECK('up', 'fail', `NetworkManager couldn’t create the hotspot: ${why}`, fixForUpError(why, cfg.band)));
    }
    const uuid = addedUuid(added.stdout);
    if (!uuid) {
      await this.nmcli(['--wait', String(DELETE_WAIT_S), 'connection', 'delete', 'id', CONNECTION_NAME]);
      return fail(CHECK('up', 'fail', 'NetworkManager didn’t say which hotspot it created.', fixForUpError('', cfg.band)));
    }
    this.own(uuid); // from here on ours: quitting (even now) removes it
    const up = await this.nmcli(['--wait', String(UP_WAIT_S), 'connection', 'up', 'uuid', uuid], { timeout: (UP_WAIT_S + 10) * 1000 });
    if (this.closing) {
      await this.down();
      return this.view();
    }
    if (up.code !== 0) {
      const why = nmError(up);
      await this.down();
      return fail(CHECK('up', 'fail', `NetworkManager couldn’t start the hotspot: ${why}`, fixForUpError(why, cfg.band)));
    }
    done(CHECK('up', 'ok', `Hotspot “${cfg.ssid}” is on`));

    const address = (getValues((await this.nmcli(['-g', 'IP4.ADDRESS', 'device', 'show', dev.name])).stdout)[0] || '').replace(/\/\d+$/, '');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
      await this.down();
      return fail(CHECK('address', 'fail', 'The hotspot got no address.', 'NetworkManager needs dnsmasq to share a connection: sudo apt install dnsmasq-base (Fedora: sudo dnf install dnsmasq), then Try again.'));
    }
    done(CHECK('address', 'ok', `Hotspot address ${address}`));
    const url = `http://${address}:${port}`;
    const health = await this.health(`${url}/api/health`);
    if (health?.instance !== this.instance) {
      await this.down();
      return fail(CHECK('reach', 'fail', `The party doesn’t answer at ${url}.`, 'Another program may use this address: restart OpenKaraoke, then Try again.'));
    }
    done(CHECK('reach', 'ok', `This server answers on the hotspot: ${url}`));

    if (this.closing) {
      await this.down();
      return this.view();
    }
    this.set({ state: 'on', device: dev.name, address, reason: '', fix: '', check: '' });
    this.log?.info(`party hotspot on: ${cfg.ssid} at ${url}`);
    this.watch();
    return this.view();
  }

  // ---- watching ----------------------------------------------------------------------------

  watch() {
    this.stopWatching();
    this.misses = 0;
    this.timer = setInterval(() => { this.poll().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
  }

  stopWatching() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Still up, still with its address? Two misses in a row: it dropped (§20.5). */
  async poll() {
    if (this.st.state !== 'on' || this.polling) return;
    this.polling = true;
    try {
      await this.checkUp();
    } finally {
      this.polling = false;
    }
  }

  async checkUp() {
    const shown = await this.nmcli(['-g', 'GENERAL.STATE', 'connection', 'show', 'uuid', this.uuid]);
    const state = getValues(shown.stdout)[0];
    const address = state === 'activated'
      ? (getValues((await this.nmcli(['-g', 'IP4.ADDRESS', 'device', 'show', this.st.device])).stdout)[0] || '').replace(/\/\d+$/, '')
      : '';
    if (state === 'activated' && address === this.st.address) {
      this.misses = 0;
      return;
    }
    if (++this.misses < 2 || this.st.state !== 'on') return;
    this.stopWatching();
    const radio = (await this.nmcli(['-t', '-f', 'WIFI', 'radio'])).stdout.trim();
    if (this.st.state !== 'on') return; // stopped or restarted meanwhile
    // Whatever is left of it goes (still up with another address, or nmcli not answering):
    // "failed" means off, and Turn off / quitting have nothing left behind.
    await this.down();
    if (this.st.state !== 'on') return;
    const check = radio !== 'enabled'
      ? CHECK('dropped', 'fail', 'The hotspot stopped: Wi-Fi was switched off.', 'Switch Wi-Fi on again (system menu, top right), then Try again.')
      : state === 'activated'
        ? CHECK('dropped', 'fail', 'The hotspot’s address changed.', 'Try again.')
        : CHECK('dropped', 'fail', 'The hotspot stopped (NetworkManager took it down).', 'Try again. If it keeps stopping, the reason is in: journalctl -u NetworkManager.');
    this.set({ state: 'failed', check: check.id, reason: check.text, fix: check.fix, address: '', checks: [...this.st.checks.filter((c) => c.id !== 'dropped'), check] });
    this.log?.warn(`party hotspot: ${check.text}`);
  }

  // ---- stop --------------------------------------------------------------------------------

  /** Removes the profile this server made (deleting an active connection takes it down too). */
  async down() {
    const uuid = this.uuid;
    if (!uuid) return;
    const res = await this.nmcli(['--wait', String(DELETE_WAIT_S), 'connection', 'delete', 'uuid', uuid]).catch(() => null);
    if (res && res.code !== 0 && res.code !== 10) {
      this.log?.warn(`party hotspot: couldn’t switch it off: ${nmError(res)}`);
      return; // kept: the next start or clean-up tries again
    }
    if (this.uuid === uuid) this.own('');
  }

  async doStop() {
    this.stopWatching();
    if (this.st.state === 'off') return this.view();
    this.set({ state: 'stopping' });
    await this.down();
    this.set({ state: 'off', address: '', reason: '', fix: '', check: '', checks: [] });
    return this.view();
  }

  /**
   * At start-up with the switch off: the hotspot an earlier run of this server left (it crashed
   * or was killed while it was on) — known by the UUID kept in the data folder — is removed, so
   * the home Wi-Fi comes back. A party hotspot of another OpenKaraoke is never touched.
   */
  cleanup() {
    return this.serial(async () => {
      if (this.st.state !== 'off' || !this.uuid) return;
      this.log?.info('party hotspot left by an earlier run: removing it');
      await this.down();
    });
  }

  /** Quitting: the hotspot this server made goes (also one still starting); the home Wi-Fi comes back. */
  async close() {
    this.closing = true;
    this.stopWatching();
    const done = this.serial(() => this.down()).then(() => false);
    const late = await Promise.race([done, new Promise((r) => setTimeout(() => r(true), this.closeMs).unref?.())]);
    // A start still under way (a password prompt, NetworkManager slow to bring it up): its
    // profile is removed right away, which also cancels the activation.
    if (late && this.uuid) {
      await Promise.race([this.nmcli(['--wait', '3', 'connection', 'delete', 'uuid', this.uuid], { timeout: 4000 }), new Promise((r) => setTimeout(r, 4000).unref?.())]);
    }
  }
}
