// Guest accounts (PLAN §28): a username and password that stand for one guest identity — the
// id the profile, favourites, singer, song history and version votes are kept under — so a guest
// can sign in on any phone and be the same singer. Kept in data/accounts.json: the password only
// as a scrypt hash with its own salt. A signed-in phone holds an `account` token naming the
// identity and the account's token version; changing the password (or the host resetting it)
// bumps the version, which signs every phone out.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { JsonDoc } from '../util/jsonfile.js';
import { UserError } from '../util/errors.js';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/i; // 3–24: letters, digits, . _ -
export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 128;
export const MAX_ACCOUNTS = 2000;
const ID_RE = /^[\w-]{4,40}$/;
const TOKEN_RE = /^v(\d{1,6})_([\w-]{4,40})$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const keyOf = (username) => String(username || '').trim().toLowerCase();
const fail = (message, code) => {
  throw new UserError(message, { code });
};

export function checkUsername(username) {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) fail('A username of 3 to 24 letters or digits (and . _ - inside it), please.', 'bad_username');
  if (BAD_KEYS.has(u.toLowerCase())) fail('Please pick another username.', 'bad_username');
  return u;
}

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) fail(`A password of ${MIN_PASSWORD} characters at least, please.`, 'bad_password');
  if (password.length > MAX_PASSWORD) fail(`A password of ${MAX_PASSWORD} characters at most, please.`, 'bad_password');
  return password;
}

async function hashOf(password, salt) {
  return (await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT)).toString('hex');
}

export class Accounts {
  constructor(file, { now = () => Date.now() } = {}) {
    this.doc = new JsonDoc(file, { version: 1, users: {} }, { debounceMs: 500 });
    this.users = Object.create(null); // username (lower case) → { name, id, salt, hash, tv, createdAt, lastLogin }
    this.byId = new Map(); // identity → username key
    this.now = now;
  }

  async load() {
    const raw = await this.doc.load();
    const src = raw.users && typeof raw.users === 'object' ? raw.users : {};
    for (const [key, u] of Object.entries(src)) {
      if (!u || typeof u !== 'object' || BAD_KEYS.has(key) || keyOf(u.name) !== key || !USERNAME_RE.test(u.name)) continue;
      if (!ID_RE.test(u.id || '') || this.byId.has(u.id) || !/^[0-9a-f]{32}$/.test(u.salt || '') || !/^[0-9a-f]{64}$/.test(u.hash || '')) continue;
      this.users[key] = {
        name: u.name, id: u.id, salt: u.salt, hash: u.hash,
        tv: Number.isSafeInteger(u.tv) && u.tv >= 0 && u.tv < 1e6 ? u.tv : 0,
        createdAt: Number(u.createdAt) || 0, lastLogin: Number(u.lastLogin) || 0,
      };
      this.byId.set(u.id, key);
    }
    this.doc.data = { version: 1, users: this.users };
    return this;
  }

  get size() {
    return this.byId.size;
  }

  /** The account a guest identity belongs to, or null. */
  ofId(id) {
    const key = typeof id === 'string' ? this.byId.get(id) : undefined;
    return key ? this.users[key] : null;
  }

  /** Makes `id` (the guest's identity) an account. */
  async create(username, password, id) {
    const name = checkUsername(username);
    checkPassword(password);
    if (!ID_RE.test(id || '')) fail('Unknown guest', 'bad_request');
    if (this.byId.has(id)) fail('You already have an account on this phone.', 'exists');
    const key = keyOf(name);
    if (Object.hasOwn(this.users, key)) fail('That username is taken — try another.', 'taken');
    if (this.size >= MAX_ACCOUNTS) fail('This party can’t take more accounts.', 'full');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashOf(password, salt);
    if (Object.hasOwn(this.users, key) || this.byId.has(id)) fail('That username is taken — try another.', 'taken'); // (meanwhile)
    const now = this.now();
    this.users[key] = { name, id, salt, hash, tv: 0, createdAt: now, lastLogin: now };
    this.byId.set(id, key);
    this.doc.save();
    return this.users[key];
  }

  /**
   * The account for a username and password, or null. An unknown username takes as long as a
   * wrong password (a hash is worked out either way).
   */
  async verify(username, password) {
    const key = keyOf(username);
    const user = USERNAME_RE.test(key) && Object.hasOwn(this.users, key) ? this.users[key] : null;
    if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
    const hash = await hashOf(password, user ? user.salt : '0'.repeat(32));
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) return null;
    user.lastLogin = this.now();
    this.doc.save();
    return user;
  }

  /** A new password; every phone signed in with the old one is signed out. */
  async setPassword(id, password) {
    const user = this.ofId(id);
    if (!user) fail('No such account.', 'not_found');
    checkPassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    user.hash = await hashOf(password, salt);
    user.salt = salt;
    user.tv = (user.tv + 1) % 1e6;
    this.doc.save();
    return user;
  }

  /** Deletes an account (the guest's profile stays, as a guest without one). */
  remove(id) {
    const key = this.byId.get(id);
    if (!key) fail('No such account.', 'not_found');
    delete this.users[key];
    this.byId.delete(id);
    this.doc.save();
  }

  /** What a signed-in phone's `account` token carries. */
  tokenId(user) {
    return `v${user.tv}_${user.id}`;
  }

  /**
   * The guest identity a token stands for: an `account` token while its account and token version
   * hold, a plain guest token unless that identity has become an account (then signing in is
   * needed). Null otherwise.
   */
  identity({ guest, account }) {
    if (account) {
      const m = TOKEN_RE.exec(account);
      const user = m && this.ofId(m[2]);
      return user && user.tv === Number(m[1]) ? user.id : null;
    }
    return guest && !this.byId.has(guest) ? guest : null;
  }

  list() {
    return Object.values(this.users)
      .map((u) => ({ username: u.name, id: u.id, createdAt: u.createdAt, lastLogin: u.lastLogin }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  flush() {
    return this.doc.flush();
  }

  discard() {
    this.doc.discard();
  }
}
