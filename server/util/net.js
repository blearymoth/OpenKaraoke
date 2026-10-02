import os from 'node:os';
import net from 'node:net';

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

/** "host:port" / "[v6]:port" → lower-case host name without port or brackets. */
export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  const colon = h.lastIndexOf(':');
  return colon > 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

const isIpLiteral = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(':');

/** Names this computer answers to: localhost, its host name(s) and its own IP addresses. */
export function ownNames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  const host = os.hostname().toLowerCase();
  for (const n of [host, `${host}.local`, `${host}.lan`, `${host}.home`, `${host}.localdomain`]) names.add(n);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) names.add(String(a.address).toLowerCase().replace(/%.*$/, ''));
  }
  for (const e of extra) if (e) names.add(String(e).toLowerCase());
  return names;
}

/**
 * Host header check against DNS rebinding: a browser tab on another site that tricks its
 * DNS into pointing at this computer still sends that site's name as Host.
 * Any IP literal is fine (it can't be rebound), names must be ours.
 */
export function isTrustedHostHeader(hostHeader, extra = []) {
  if (!hostHeader) return true; // HTTP/1.0 or non-browser client
  const h = hostnameOf(hostHeader);
  return isIpLiteral(h) || h.endsWith('.localhost') || ownNames(extra).has(h);
}

/**
 * Origin check for WebSocket upgrades and POSTs: requests made by pages of other sites
 * must not act on the party. Non-browser clients send no Origin.
 */
export function isTrustedOrigin(origin, extra = []) {
  if (!origin || origin === 'null') return !origin;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const h = hostnameOf(url.host);
  return h.endsWith('.localhost') || ownNames(extra).has(h);
}

/** Resolves to null when `port` can be listened on at `host`, else the error code (EADDRINUSE, EACCES, …). */
export function probePort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code || 'ERROR'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(null)));
  });
}

/** A port the OS picks as free right now (listening on port 0). */
export function anyFreePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The first port from `from` on (`tries` of them) that can be listened on at `host`, else one
 * the OS picks: when the usual port is taken by another program, the next one up is easy to
 * recognise and usually free.
 */
export async function findFreePort(host, from, tries = 20) {
  for (let port = Math.max(1025, from); port < from + tries && port <= 65535; port++) {
    if (!(await probePort(port, host))) return port;
  }
  return anyFreePort(host);
}

/** The address to reach a server listening on `host` from this computer. */
export function localAddressFor(host) {
  return !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}
