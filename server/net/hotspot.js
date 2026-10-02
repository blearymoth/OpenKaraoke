// The party hotspot (PLAN §20): this PC opens its own Wi-Fi through NetworkManager so guests
// don't need the home network. `start()` runs the checks of §20.4 (each one ok / warn / fail
// with the fix), creates the connection and brings it up, then watches it; anything that fails
// leaves the hotspot off with the reason and the fix (§20.5) — the party carries on over the
// home network. Every program runs through the injected runner (server/net/nmcli.js).
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { addConnectionArgs, getValues, makePassword, nmError, terseRows, validIfname, validPassword, validSsid, BANDS, CONNECTION_NAME } from './nmcli.js';

const POLL_MS = 5000;
const UP_WAIT_S = 30;
const SAFE_HOSTS = new Set(['0.0.0.0', '::', '']);

/** GET http://…/api/health with a short timeout → the parsed body, or null. */
export function fetchHealth(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
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

/** The fix for what NetworkManager said when the hotspot wouldn't come up. */
export function fixForUpError(message) {
  const m = String(message || '');
  if (/IP configuration could not be reserved|dnsmasq/i.test(m)) return 'NetworkManager needs dnsmasq to share a connection: sudo apt install dnsmasq-base (Fedora: sudo dnf install dnsmasq), then Try again.';
  if (/not authori[sz]ed|insufficient privileges|permission/i.test(m)) return 'Allow it when your password is asked, or run OpenKaraoke as the person logged in at this computer.';
  if (/AP mode|No suitable device|not available/i.test(m)) return 'This Wi-Fi adapter can’t be a hotspot right now: unplug and plug it in again, or choose another adapter.';
  if (/secrets|psk|password/i.test(m)) return 'Check the hotspot password (8–63 characters) in Settings → Party, then Try again.';
  if (/timed? ?out|took too long/i.test(m)) return 'Try again. If it keeps failing, restart NetworkManager: sudo systemctl restart NetworkManager.';
  return 'Try again. If it keeps failing, the reason is in: journalctl -u NetworkManager.';
}

const CHECK = (id, level, text, fix = '') => ({ id, level, text, fix });

export class Hotspot extends EventEmitter {
  /**
   * @param {object} o
   * @param {(cmd: string, args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} o.run
   * @param {import('../config.js').Settings} o.settings party.hotspot lives there
   * @param {() => number} o.port the port this server listens on
   * @param {string} o.instance this process (/api/health)
   * @param {(url: string) => Promise<object|null>} [o.health] reachability check (tests pass a fake)
   * @param {string} [o.platform]
   * @param {(file: string) => Promise<string>} [o.readText] for /etc/ufw/ufw.conf
   */
  constructor({ run, settings, port, instance, health = fetchHealth, platform = process.platform, readText = (f) => fs.readFile(f, 'utf8'), pollMs = POLL_MS, log } = {}) {
    super();
    this.run = run;
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
    this.ownsConnection = false; // brought up by this process: brought down again when it quits
    this.st = { state: 'off', checks: [], reason: '', fix: '', check: '', address: '', ifname: '', devices: [] };
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
    return { ...c, ...this.st, checks: this.st.checks.map((x) => ({ ...x })), devices: [...this.st.devices] };
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

  nmcli(args) {
    return this.run('nmcli', args);
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
    if (this.st.state === 'on') return this.view(); // changed settings: retry()
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

    if (this.platform !== 'linux') return fail(CHECK('linux', 'fail', 'The party hotspot needs Linux with NetworkManager.', 'Use the home Wi-Fi: guests scan the QR code on the TV.'));
    done(CHECK('linux', 'ok', 'Linux'));
    const version = await this.nmcli(['--version']);
    if (version.code === 127) return fail(CHECK('nmcli', 'fail', 'NetworkManager (nmcli) isn’t installed.', 'Install NetworkManager (Ubuntu: sudo apt install network-manager — Fedora: sudo dnf install NetworkManager), or use the home Wi-Fi.'));
    done(CHECK('nmcli', 'ok', (version.stdout.trim().replace(/^nmcli tool, /, 'NetworkManager ') || 'NetworkManager').slice(0, 60)));
    const running = await this.nmcli(['-t', '-f', 'RUNNING', 'general']);
    if (running.code !== 0 || running.stdout.trim() !== 'running') return fail(CHECK('running', 'fail', 'NetworkManager isn’t running.', 'Start it: sudo systemctl start NetworkManager'));
    done(CHECK('running', 'ok', 'NetworkManager is running'));

    const perms = Object.fromEntries(terseRows((await this.nmcli(['-t', '-f', 'PERMISSION,VALUE', 'general', 'permissions'])).stdout));
    const may = ['org.freedesktop.NetworkManager.network-control', 'org.freedesktop.NetworkManager.settings.modify.system'].map((p) => perms[p] || 'no');
    if (may.includes('no')) return fail(CHECK('permission', 'fail', 'This user may not change the network.', 'Run OpenKaraoke as the person logged in at this computer (not over SSH or as another user’s service).'));
    done(may.includes('auth') ? CHECK('permission', 'warn', 'Allowed to change the network after a password prompt.', 'When the system asks for your password, give it.') : CHECK('permission', 'ok', 'Allowed to change the network'));

    const radio = (await this.nmcli(['-t', '-f', 'WIFI', 'radio'])).stdout.trim();
    if (radio !== 'enabled') return fail(CHECK('radio', 'fail', 'Wi-Fi is switched off.', 'Switch Wi-Fi on in the system menu (top right) and turn flight mode off, then Try again.'));
    done(CHECK('radio', 'ok', 'Wi-Fi is on'));

    const devices = terseRows((await this.nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'])).stdout)
      .map(([name, type, state, connection]) => ({ name, type, state, connection: connection || '' }));
    const wifi = devices.filter((d) => d.type === 'wifi');
    this.set({ devices: wifi.map((d) => d.name) });
    const dev = cfg.ifname ? wifi.find((d) => d.name === cfg.ifname) : wifi.find((d) => d.state !== 'unavailable') || wifi[0];
    if (!dev) {
      return fail(cfg.ifname && wifi.length
        ? CHECK('device', 'fail', `The chosen Wi-Fi adapter (${cfg.ifname}) isn’t there.`, 'Choose another adapter in Settings → Party.')
        : CHECK('device', 'fail', 'No Wi-Fi adapter found.', 'Plug in a USB Wi-Fi adapter, or use the home Wi-Fi.'));
    }
    done(CHECK('device', 'ok', `Wi-Fi adapter: ${dev.name}`));
    const ap = getValues((await this.nmcli(['-g', 'WIFI-PROPERTIES.AP', 'device', 'show', dev.name])).stdout)[0];
    if (ap !== 'yes') return fail(CHECK('ap', 'fail', `This Wi-Fi adapter (${dev.name}) can’t be a hotspot.`, 'A USB Wi-Fi adapter that supports hotspot (AP) mode can.'));
    done(CHECK('ap', 'ok', `${dev.name} can be a hotspot`));

    const host = String(this.settings.get('server.host') ?? '0.0.0.0');
    if (!SAFE_HOSTS.has(host)) return fail(CHECK('listen', 'fail', `OpenKaraoke only listens on ${host}, which phones on the hotspot can’t reach.`, 'Start it without --host (or with --host 0.0.0.0).'));
    done(CHECK('listen', 'ok', 'OpenKaraoke listens on every network'));

    // The adapter's own Wi-Fi connection goes away while it is a hotspot (one radio).
    const homeWifi = dev.state === 'connected' && dev.connection && dev.connection !== CONNECTION_NAME ? dev.connection : '';
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
    await this.nmcli(['connection', 'delete', 'id', CONNECTION_NAME]);
    const added = await this.nmcli(addConnectionArgs({ ifname: dev.name, ssid: cfg.ssid, password, band: cfg.band }));
    if (added.code !== 0) {
      const why = nmError(added);
      return fail(CHECK('up', 'fail', `NetworkManager couldn’t create the hotspot: ${why}`, fixForUpError(why)));
    }
    const up = await this.nmcli(['--wait', String(UP_WAIT_S), 'connection', 'up', 'id', CONNECTION_NAME]);
    if (up.code !== 0) {
      const why = nmError(up);
      await this.nmcli(['connection', 'delete', 'id', CONNECTION_NAME]);
      return fail(CHECK('up', 'fail', `NetworkManager couldn’t start the hotspot: ${why}`, fixForUpError(why)));
    }
    this.ownsConnection = true;
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
      return fail(CHECK('reach', 'fail', `The party doesn’t answer at ${url}.`, 'Another program may use this address, or OpenKaraoke listens on one address only: restart OpenKaraoke, then Try again.'));
    }
    done(CHECK('reach', 'ok', `Phones can open the party at ${url}`));

    this.set({ state: 'on', ifname: dev.name, address, reason: '', fix: '', check: '' });
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
    if (this.st.state !== 'on') return;
    const state = getValues((await this.nmcli(['-g', 'GENERAL.STATE', 'connection', 'show', 'id', CONNECTION_NAME])).stdout)[0];
    const address = state === 'activated'
      ? (getValues((await this.nmcli(['-g', 'IP4.ADDRESS', 'device', 'show', this.st.ifname])).stdout)[0] || '').replace(/\/\d+$/, '')
      : '';
    if (state === 'activated' && address === this.st.address) {
      this.misses = 0;
      return;
    }
    if (++this.misses < 2 || this.st.state !== 'on') return;
    this.stopWatching();
    this.ownsConnection = false;
    const radio = (await this.nmcli(['-t', '-f', 'WIFI', 'radio'])).stdout.trim();
    const check = radio !== 'enabled'
      ? CHECK('dropped', 'fail', 'The hotspot stopped: Wi-Fi was switched off.', 'Switch Wi-Fi on again, then Try again. Until then guests use the home Wi-Fi (the QR code on the TV).')
      : state === 'activated'
        ? CHECK('dropped', 'fail', 'The hotspot’s address changed.', 'Try again. Until then guests use the home Wi-Fi (the QR code on the TV).')
        : CHECK('dropped', 'fail', 'The hotspot stopped (NetworkManager took it down).', 'Try again. Until then guests use the home Wi-Fi (the QR code on the TV).');
    this.set({ state: 'failed', check: check.id, reason: check.text, fix: check.fix, address: '', checks: [...this.st.checks.filter((c) => c.id !== 'dropped'), check] });
    this.log?.warn(`party hotspot: ${check.text}`);
  }

  // ---- stop --------------------------------------------------------------------------------

  async down() {
    if (!this.ownsConnection) return;
    this.ownsConnection = false;
    await this.nmcli(['connection', 'down', 'id', CONNECTION_NAME]).catch(() => {});
  }

  async doStop() {
    this.stopWatching();
    if (this.st.state === 'off') return this.view();
    this.set({ state: 'stopping' });
    await this.down();
    this.set({ state: 'off', address: '', reason: '', fix: '', check: '', checks: [] });
    return this.view();
  }

  /** Quitting: the hotspot goes off if this process turned it on (the home Wi-Fi comes back). */
  close() {
    this.stopWatching();
    return this.serial(() => this.down());
  }
}
