import os from 'node:os';

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|podman|kube|zt|wg|tun|tap)/i;

/** LAN IPv4 addresses, best candidate first. */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(a.address)) score += 30;
      else if (/^10\./.test(a.address)) score += 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 10;
      else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) score -= 5; // CGNAT / tailscale
      if (VIRTUAL_IFACE.test(name)) score -= 50;
      if (/^(wl|wlan|wifi)/i.test(name)) score += 3;
      if (/^(en|eth)/i.test(name)) score += 4;
      out.push({ address: a.address, iface: name, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True when a request comes from this computer (loopback or one of our own addresses). */
export function isLocalAddress(remote) {
  if (!remote) return false;
  if (LOCAL.has(remote)) return true;
  const ip = remote.replace(/^::ffff:/, '');
  if (ip.startsWith('127.')) return true;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.address === ip) return true;
  }
  return false;
}

/**
 * True when a Host header names this machine by IP, "localhost" or its own host name.
 * Requests for any other name (e.g. DNS rebinding) never get "this computer" trust.
 */
export function isDirectHost(hostHeader, extra = []) {
  if (!hostHeader) return true; // HTTP/1.0 clients and tests
  let name = String(hostHeader).trim().toLowerCase();
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']'));
  else name = name.replace(/:\d+$/, '');
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true; // IPv4 / IPv6 literal
  const hn = os.hostname().toLowerCase();
  if (name === hn || name === `${hn}.local` || name === hn.split('.')[0]) return true;
  return extra.map((x) => String(x).toLowerCase()).includes(name);
}

/** True when an Origin header (if any) belongs to the same host the request was sent to. */
export function sameOrigin(originHeader, hostHeader) {
  if (!originHeader) return true;
  try {
    return new URL(originHeader).host.toLowerCase() === String(hostHeader || '').toLowerCase();
  } catch {
    return false;
  }
}
