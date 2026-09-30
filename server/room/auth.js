// Who may do what (PLAN §7):
//  - host: this computer (when party.trustLocalhost) or a host token obtained with the PIN
//  - tv:   this computer, or a display paired by the host (TV tokens carry a version, so
//          "forget paired screens" logs every remote display out)
//  - guest: anyone with the room code; identified by a signed device token
// Tokens are "<role>.<id>.<hmac>" signed with a per-install secret in data/secret.json.
// Host tokens include a hash of the PIN, so changing the PIN logs out every remote host.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/jsonfile.js';
import { isLocalAddress, isTrustedHostHeader, isTrustedOrigin, hostnameOf } from '../util/net.js';
import { RateLimiter } from '../util/ratelimit.js';
import { UserError } from '../util/errors.js';

const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class Auth {
  constructor({ dataDir, settings }) {
    this.file = path.join(dataDir, 'secret.json');
    this.settings = settings;
    this.secret = null;
    this.tvVersion = 1;
    this.pinLimiter = new RateLimiter({ capacity: 5, perMs: 60_000 });
    this.pinLimiterAll = new RateLimiter({ capacity: 20, perMs: 5 * 60_000 }); // across all addresses
  }

  /** Extra host names we answer to (the public URL set in settings). */
  extraNames() {
    const pub = this.settings.get('server.publicUrl');
    if (!pub) return [];
    try {
      return [hostnameOf(new URL(pub).host)];
    } catch {
      return [];
    }
  }

  trustedHost(hostHeader) {
    return isTrustedHostHeader(hostHeader, this.extraNames());
  }

  trustedOrigin(origin) {
    return isTrustedOrigin(origin, this.extraNames());
  }

  async load() {
    const data = await readJson(this.file, null);
    if (typeof data?.secret === 'string' && data.secret.length >= 32) {
      this.secret = data.secret;
      this.tvVersion = Number.isInteger(data.tvVersion) && data.tvVersion > 0 ? data.tvVersion : 1;
      return;
    }
    this.secret = crypto.randomBytes(32).toString('hex');
    await this.saveSecret();
  }

  async saveSecret() {
    await writeJsonAtomic(this.file, { secret: this.secret, tvVersion: this.tvVersion });
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  /** Invalidates every paired display's token. */
  async forgetDisplays() {
    this.tvVersion++;
    await this.saveSecret();
  }

  get pin() {
    return String(this.settings.get('party.adminPin') || '');
  }

  pinVersion() {
    return this.pin ? hmac(this.secret, `pin:${this.pin}`).slice(0, 10) : 'none';
  }

  sign(role, id) {
    const v = role === 'host' ? this.pinVersion() : role === 'tv' ? `tv${this.tvVersion}` : '1';
    return `${role}.${id}.${hmac(this.secret, `${role}:${v}:${id}`).slice(0, 32)}`;
  }

  /** Returns { role, id } for a valid token of that role, else null. */
  verify(token, role) {
    if (typeof token !== 'string' || token.length > 300) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== role || !/^[\w-]{4,64}$/.test(parts[1])) return null;
    if (role === 'host' && !this.pin) return null;
    const expected = this.sign(role, parts[1]).split('.')[2];
    return safeEqual(parts[2], expected) ? { role, id: parts[1] } : null;
  }

  newId(bytes = 9) {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  /** Host access for a connection from `ip` presenting `token`. */
  isHost(ip, token) {
    if (this.settings.get('party.trustLocalhost') && isLocalAddress(ip)) return true;
    return !!this.verify(token, 'host');
  }

  /**
   * Host access for an HTTP request (Bearer token or ok_host cookie). Requests addressed to a
   * foreign host name (DNS rebinding) or sent by another site's page never get host rights.
   */
  isHostRequest(req) {
    if (!this.trustedHost(req.headers.host) || !this.trustedOrigin(req.headers.origin)) return false;
    return this.isHost(req.socket.remoteAddress, bearerToken(req) || cookie(req, 'ok_host'));
  }

  /** Exchanges the PIN for a host token (rate limited per `key`, usually the IP). */
  loginWithPin(pin, key) {
    if (!this.pin) {
      throw new UserError('Remote host access is off: set a host PIN in Settings on the computer running OpenKaraoke.', { status: 403, code: 'no_pin' });
    }
    if (!this.pinLimiter.take(String(key)) || !this.pinLimiterAll.take('all')) {
      throw new UserError('Too many attempts — wait a minute and try again.', { status: 429, code: 'rate_limited' });
    }
    if (!safeEqual(hmac(this.secret, `try:${pin}`), hmac(this.secret, `try:${this.pin}`))) {
      throw new UserError('Wrong PIN', { status: 401, code: 'bad_pin' });
    }
    return this.sign('host', this.newId());
  }
}

export function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

export function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}
