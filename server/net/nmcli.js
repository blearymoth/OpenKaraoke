// Talking to NetworkManager for the party hotspot (PLAN §20.3). Programs are only ever started
// through child_process.execFile — never a shell — with every value as its own argument, after
// validation. The runner is injected: tests use scripts/fake-nmcli.mjs; only the app's default
// runner starts the real programs, and it refuses to run under `node --test`.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

export const CONNECTION_NAME = 'OpenKaraoke hotspot';
/** The hotspot's own address, fixed so that printed QR cards stay right (NetworkManager's default). */
export const HOTSPOT_ADDRESS = '10.42.0.1/24';
export const BANDS = ['auto', 'bg', 'a'];
const RUN_TIMEOUT_MS = 40_000; // `connection up --wait 30` plus margin

/**
 * The real runner: `run(cmd, args)` → { code, stdout, stderr }; code 127 when the program is
 * missing, 124 when it timed out. Only `nmcli` and `firewall-cmd` may be started.
 * OPENKARAOKE_NMCLI=<program> runs another nmcli (e.g. scripts/fake-nmcli.mjs, with
 * FAKE_NMCLI_SCENARIO and FAKE_NMCLI_STATE) for trying the hotspot without Wi-Fi.
 */
export function systemRunner({ env = process.env } = {}) {
  if (env.NODE_TEST_CONTEXT && !env.OPENKARAOKE_NMCLI) {
    return async () => {
      throw new Error('The real nmcli is never used in tests: inject a runner (scripts/fake-nmcli.mjs).');
    };
  }
  return (cmd, args, { timeout = RUN_TIMEOUT_MS } = {}) => {
    if (cmd !== 'nmcli' && cmd !== 'firewall-cmd') return Promise.reject(new Error(`not allowed: ${cmd}`));
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return Promise.reject(new Error('bad arguments'));
    let file = cmd;
    let argv = args;
    const other = env.OPENKARAOKE_NMCLI;
    const childEnv = { ...env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
    if (other) {
      childEnv.FAKE_NMCLI_COMMAND = cmd;
      [file, argv] = /\.m?js$/.test(other) ? [process.execPath, [other, ...args]] : [other, args];
    }
    return new Promise((resolve) => {
      execFile(file, argv, { timeout, maxBuffer: 1 << 20, windowsHide: true, env: childEnv }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return resolve({ code: 127, stdout: '', stderr: `${cmd}: command not found` });
        if (err?.killed) return resolve({ code: 124, stdout: String(stdout || ''), stderr: `${cmd} took too long` });
        resolve({ code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  };
}

// ---- terse output ---------------------------------------------------------------------------

/** One line of `nmcli -t` output: fields split on ':' (a field's own ':' and '\' are escaped). */
export function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** `nmcli -t -f A,B,…` rows → arrays of fields. */
export function terseRows(stdout) {
  return String(stdout || '').split('\n').filter((l) => l.length).map(splitTerse);
}

/**
 * `nmcli -t -f FIELD device show …` ("FIELD:value" lines, lists as "IP4.ADDRESS[1]:…") → a map
 * of field → value, lists → arrays (field name without "[n]").
 */
export function terseFields(stdout) {
  const map = {};
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = splitTerse(line.slice(at + 1)).join(':');
    const list = /^(.+)\[\d+\]$/.exec(key);
    if (list) (map[list[1]] ||= []).push(value);
    else map[key] = value;
  }
  return map;
}

/** `nmcli -g FIELD …` (values only; several values of one field separated by " | "). */
export function getValues(stdout) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .flatMap((l) => l.split(' | ')).map((v) => splitTerse(v).join(':'));
}

/** NetworkManager's own words from a failed nmcli run ("Error: …" without the "Hint: …" lines). */
export function nmError(res) {
  const lines = String(res?.stderr || res?.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Hint:/i.test(l));
  return (lines.join(' ').replace(/^Error:\s*/i, '').trim() || `nmcli failed (exit ${res?.code})`).slice(0, 300);
}

// ---- values ---------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** A Wi-Fi name nmcli and phones accept: 1–32 bytes, no control characters, not starting with "-". */
export function validSsid(ssid) {
  return typeof ssid === 'string' && ssid.trim() === ssid && ssid.length > 0 && encoder.encode(ssid).length <= 32 &&
    !/[\u0000-\u001f\u007f]/.test(ssid) && !ssid.startsWith('-');
}

/** A WPA2 passphrase: 8–63 printable ASCII characters. */
export function validPassword(pw) {
  return typeof pw === 'string' && /^[\x20-\x7e]{8,63}$/.test(pw);
}

/** A network interface name (Linux: up to 15 characters). */
export function validIfname(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,15}$/.test(name) && !name.startsWith('-');
}

/** A password that is easy to read off a TV and type on a phone: 12 letters/digits, no look-alikes. */
export function makePassword(randomInt = crypto.randomInt) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 12; i++) pw += chars[randomInt(chars.length)];
  return pw;
}

// ---- commands -------------------------------------------------------------------------------

/**
 * Arguments of `nmcli connection add` for the hotspot connection: a Wi-Fi access point with
 * WPA2 (CCMP only, no PMF: what GNOME's own hotspot uses, the most compatible with phones and
 * drivers), `ipv4.method shared` (NetworkManager hands out addresses and shares this PC's
 * internet when it has some) and client isolation (every guest knows the password: phones can't
 * reach each other, only this PC — NetworkManager ≥ 1.28; `isolation: false` for older ones).
 */
export function addConnectionArgs({ ifname, ssid, password, band = 'auto', isolation = true }) {
  if (!validIfname(ifname) || !validSsid(ssid) || !validPassword(password) || !BANDS.includes(band)) throw new Error('bad hotspot settings');
  return [
    'connection', 'add', 'type', 'wifi', 'ifname', ifname, 'con-name', CONNECTION_NAME, 'autoconnect', 'no',
    'ssid', ssid,
    '802-11-wireless.mode', 'ap',
    ...(band === 'auto' ? [] : ['802-11-wireless.band', band]),
    ...(isolation ? ['802-11-wireless.ap-isolation', 'yes'] : []),
    'ipv4.method', 'shared',
    'ipv4.addresses', HOTSPOT_ADDRESS,
    'ipv6.method', 'disabled',
    'wifi-sec.key-mgmt', 'wpa-psk',
    'wifi-sec.proto', 'rsn',
    'wifi-sec.pairwise', 'ccmp',
    'wifi-sec.group', 'ccmp',
    'wifi-sec.pmf', 'disable',
    'wifi-sec.psk', password,
  ];
}
