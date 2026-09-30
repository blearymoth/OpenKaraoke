// Who may do what: the PC itself is trusted, other devices need the host PIN
// (host) or a pairing approval (TV displays). Tokens are HMACs with a local secret.
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/jsonfile.js';
import { isLocalAddress, isDirectHost, sameOrigin } from '../util/net.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export class Auth {
  constructor({ dataDir, settings }) {
    this.file = path.join(dataDir, 'secret.json');
    this.settings = settings;
    this.secret = null;
    this.pinVersion = 1;
    this.failures = new Map(); // ip -> { n, until }
  }

  async init() {
    const saved = await readJson(this.file, null);
    if (saved?.secret && typeof saved.secret === 'string') {
      this.secret = Buffer.from(saved.secret, 'base64url');
      this.pinVersion = saved.pinVersion || 1;
    } else {
      this.secret = crypto.randomBytes(32);
      await this.persist();
    }
    return this;
  }

  persist() {
    return writeJsonAtomic(this.file, { secret: b64(this.secret), pinVersion: this.pinVersion });
  }

  /** Invalidates all host tokens (e.g. after the PIN changed). */
  async rotate() {
    this.pinVersion++;
    await this.persist();
  }

  _mac(payload) {
    return b64(crypto.createHmac('sha256', this.secret).update(payload).digest()).slice(0, 32);
  }

  sign(role, id) {
    const payload = `${role}.${id}.${role === 'host' ? this.pinVersion : 0}`;
    return `${payload}.${this._mac(payload)}`;
  }

  /** Returns the id inside a valid token for `role`, else null. */
  verify(token, role) {
    if (typeof token !== 'string' || token.length > 300) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== role) return null;
    const payload = parts.slice(0, 3).join('.');
    const expected = this._mac(payload);
    const a = Buffer.from(parts[3]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (role === 'host' && Number(parts[2]) !== this.pinVersion) return null;
    return parts[1];
  }

  /**
   * "This computer" trust: loopback/own address, addressed by IP/localhost/host name
   * (blocks DNS rebinding) and not a cross-site request from another web page.
   */
  trustsLocal(remote, { host, origin } = {}) {
    if (!this.settings.get('party.trustLocalhost') || !isLocalAddress(remote)) return false;
    const publicHost = (() => { try { return new URL(this.settings.get('server.publicUrl')).hostname; } catch { return null; } })();
    if (!isDirectHost(host, publicHost ? [publicHost] : [])) return false;
    return sameOrigin(origin, host);
  }

  pinConfigured() {
    return !!String(this.settings.get('party.adminPin') || '').trim();
  }

  /** Checks a PIN with per-address back-off. Returns { ok, error? }. */
  checkPin(pin, remote = '') {
    const now = Date.now();
    const f = this.failures.get(remote);
    if (f && f.until > now) return { ok: false, error: 'Too many attempts — wait a minute' };
    const want = String(this.settings.get('party.adminPin') || '').trim();
    if (!want) return { ok: false, error: 'No host PIN is set. Set one in Settings on the party computer.' };
    const a = crypto.createHash('sha256').update(String(pin ?? '').trim()).digest();
    const b = crypto.createHash('sha256').update(want).digest();
    if (crypto.timingSafeEqual(a, b)) {
      this.failures.delete(remote);
      return { ok: true };
    }
    const n = (f?.n || 0) + 1;
    this.failures.set(remote, n >= 5 ? { n: 0, until: now + 60000 } : { n, until: 0 });
    return { ok: false, error: 'Wrong PIN' };
  }

  /** Token from `Authorization: Bearer …` (never cookies: they would ride along on cross-site requests). */
  tokenFrom(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  }

  isHostRequest(req) {
    if (this.trustsLocal(req.socket?.remoteAddress, { host: req.headers.host, origin: req.headers.origin })) return true;
    return !!this.verify(this.tokenFrom(req), 'host');
  }
}
