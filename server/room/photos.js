// Guest photos (PLAN §2 Guests, §8): phones upload a (client-side resized) picture, the host
// approves it (unless approval is off), and the TV shows it — briefly over everything, then
// in the photo wall / "photos" background. Files live in data/photos/.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError } from '../util/errors.js';
import { RateLimiter } from '../util/ratelimit.js';
import { logger } from '../util/log.js';

const log = logger('photos');
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_KEPT = 300; // approved + rejected photos kept (the oldest go first)
export const MAX_PENDING = 50; // photos waiting for the host, from everyone…
export const MAX_PENDING_PER_IP = 10; // …from one address (one phone can be many guests)…
export const MAX_PENDING_EACH = 5; // …and from one phone
export const MAX_UPLOADS = 8; // uploads arriving at the same time (each held in memory until complete)
const MAX_UPLOADS_PER_IP = 2;
export const MIN_UPLOAD_RATE = 64 * 1024; // bytes/s: slower than this, an upload makes way for a new one
const HOST_LIST = 120; // approved/rejected photos listed for the host (plus every waiting one)
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const fail = (message, code = 'bad_request', status = 400) => {
  throw new UserError(message, { code, status });
};
const decided = (p) => p.decidedAt || p.createdAt;
const byDecision = (a, b) => decided(a) - decided(b);
const phoneOf = (p) => p.deviceId;
const addressOf = (p) => p.ip || '';
/** The host's decision on a photo (its sender's address was only needed while it waited). */
function decide(p, status) {
  p.status = status;
  p.decidedAt = Date.now();
  delete p.ip;
}
const tooMany = () => fail('The host has lots of photos to look at — try again later.', 'too_many', 429);

/**
 * Of `photos` (in upload order), those of the `key` (phone, address) with the most, if that's
 * more than `than`; between equals, the one whose oldest photo is oldest. Null if none.
 */
function crowded(photos, key, than) {
  const groups = new Map();
  for (const p of photos) {
    const k = key(p);
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  let out = null;
  for (const g of groups.values()) {
    if (g.length > (out ? out.length : than) || (out && g.length === out.length && g[0].createdAt < out[0].createdAt)) out = g;
  }
  return out;
}
// (Not 408: browsers quietly send a request again when that comes back on a reused connection.)
const tooSlow = () => new UserError('Your photo took too long to arrive — try again.', { code: 'timeout', status: 400 });

/** Image type from the first bytes (never trust the declared content type). */
export function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export class Photos {
  constructor(room) {
    this.room = room;
    this.dir = path.join(room.app.dataDir, 'photos');
    this.limit = new RateLimiter({ capacity: 5, perMs: 10 * 60_000 });
    this.flash = null; // { id, name, until } — shown big on the TV for a few seconds
    this.flashTimer = null;
    this.uploads = new Set(); // the uploads arriving right now (see admit())
    // A phone sends its resized picture (a few hundred KB) in a second or two, so an upload that
    // stops sending or crawls along doesn't get to sit on a slot for long (see admit()/receive()).
    this.uploadTimeoutMs = 20_000; // for the whole picture
    this.uploadIdleMs = 5_000; // without a single byte arriving
    // When every slot is taken, a new upload can cut off one that…
    this.uploadGraceMs = 2_000; // …has had this long and still crawls below MIN_UPLOAD_RATE, or
    this.uploadTurnMs = 8_000; // …is still arriving after this long, however fast.
  }

  get list() {
    return (this.room.s.photos ||= []);
  }

  find(id) {
    return this.list.find((p) => p.id === id) || null;
  }

  /**
   * What every upload needs: photos on, a named guest who isn't banned and, while the host
   * approves photos, a place in the waiting list (see waitingSpot()). Checked before the bytes
   * arrive and again after. Returns the guest's profile and the waiting photo the new one
   * replaces (`drop`, or null).
   */
  check(deviceId, ip = '') {
    const room = this.room;
    if (!room.settings.get('guests.photos')) fail('The host has turned photos off.', 'closed', 403);
    const profile = room.profileOf(deviceId);
    if (!profile?.name) fail('Choose a name first.', 'no_profile', 403);
    if (profile.banned) fail('The host has removed you from this party.', 'banned', 403);
    const drop = room.settings.get('guests.photoApproval') ? this.waitingSpot(deviceId, ip) : null;
    return { profile, drop };
  }

  /**
   * The waiting list holds MAX_PENDING photos: at most MAX_PENDING_EACH from one phone and
   * MAX_PENDING_PER_IP from one address. To the server one guest can be many phones (each new
   * name is one) on a few addresses, so when the list, or the address's share of it, is full,
   * the new photo takes the place of the oldest one from whoever has the most waiting: the
   * busiest address if it has more than the sender's (and the busiest phone there), else the
   * busiest phone at the sender's address if it has more than the sender. So a phone with
   * nothing waiting always gets a place, and whoever floods the list loses their own photos
   * first. Returns the waiting photo to drop for the new one (null: there's room) or refuses.
   */
  waitingSpot(deviceId, ip) {
    const waiting = this.list.filter((p) => p.status === 'pending');
    const mine = (photos) => photos.filter((p) => p.deviceId === deviceId).length;
    if (mine(waiting) >= MAX_PENDING_EACH) fail('The host hasn’t looked at your last photos yet — send more once they have.', 'too_many', 429);
    const here = waiting.filter((p) => addressOf(p) === ip);
    const shareFull = here.length >= MAX_PENDING_PER_IP;
    if (!shareFull && waiting.length < MAX_PENDING) return null;
    const from = (!shareFull && crowded(waiting, addressOf, here.length)) || crowded(here, phoneOf, mine(here));
    if (!from) tooMany();
    return crowded(from, phoneOf, 0)[0];
  }

  /**
   * Lets an upload in before its body is read, so a refused (or flooding) phone can't make
   * the server buffer megabytes: the checks above, one upload at a time per phone (a few per
   * address and in all) and the rate limit. When every slot is taken, the newcomer replaces the
   * slowest upload that has overstayed (see slowest()), so uploads that stall or trickle can't
   * keep everyone else out: to hold every slot, a sender would have to start a new upload (and
   * spend a photo token) every few seconds per slot. Returns the upload: feed its body to
   * receive() and call `release()` when done.
   */
  admit(deviceId, ip = '') {
    ip = String(ip || '');
    this.check(deviceId, ip);
    let fromIp = 0;
    for (const u of this.uploads) {
      if (u.deviceId === deviceId) fail('Your last photo is still on its way.', 'busy', 429);
      if (u.ip === ip) fromIp++;
    }
    const busy = () => fail('Lots of photos are arriving right now — try again in a moment.', 'busy', 429);
    if (fromIp >= MAX_UPLOADS_PER_IP) busy();
    const full = this.uploads.size >= MAX_UPLOADS;
    const slow = full ? this.slowest() : null;
    if (full && !slow) busy();
    if (!this.limit.take(deviceId)) fail('That’s a lot of photos — wait a few minutes.', 'rate_limited', 429);
    if (slow) {
      this.uploads.delete(slow);
      log.info('cut off a photo upload that was arriving too slowly');
      slow.abort(tooSlow());
    }
    // `bytes` so far and `abort(err)` (while its body is being read) are kept up by receive().
    const upload = { deviceId, ip, at: Date.now(), bytes: 0, abort: null, release: () => this.uploads.delete(upload) };
    this.uploads.add(upload);
    return upload;
  }

  /**
   * The upload to cut off for a new one: of those still being read that crawl below
   * MIN_UPLOAD_RATE after uploadGraceMs or are still arriving after uploadTurnMs, the slowest.
   * A phone sends its resized picture in a second or two, so only an upload that stalls or
   * trickles is ever cut off.
   */
  slowest(now = Date.now()) {
    let out = null;
    let rate = Infinity;
    for (const u of this.uploads) {
      const ms = now - u.at;
      if (!u.abort || ms < this.uploadGraceMs) continue;
      const r = (u.bytes * 1000) / ms;
      if ((r < MIN_UPLOAD_RATE || ms >= this.uploadTurnMs) && r < rate) {
        out = u;
        rate = r;
      }
    }
    return out;
  }

  /**
   * Reads an admitted upload's body (at most MAX_PHOTO_BYTES). Gives up ('timeout') when
   * nothing arrives for uploadIdleMs, the whole picture takes over uploadTimeoutMs, or admit()
   * cuts it off for a new upload.
   */
  receive(upload, stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let idle = null;
      const total = setTimeout(() => done(tooSlow()), this.uploadTimeoutMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => done(tooSlow()), this.uploadIdleMs);
      };
      const onData = (chunk) => {
        upload.bytes += chunk.length;
        if (upload.bytes > MAX_PHOTO_BYTES) return done(new UserError(`That photo is too big (max ${MAX_PHOTO_BYTES >> 20} MB)`, { code: 'too_large', status: 413 }));
        chunks.push(chunk);
        kick();
      };
      const onEnd = () => done(null);
      const onClose = () => done(new UserError('The photo didn’t arrive.', { code: 'aborted', status: 400 }));
      function done(err) {
        if (!upload.abort) return;
        upload.abort = null;
        clearTimeout(total);
        clearTimeout(idle);
        stream.off('data', onData).off('end', onEnd).off('error', onClose).off('close', onClose);
        if (!err) return resolve(Buffer.concat(chunks));
        stream.resume(); // whatever else comes is thrown away
        reject(err);
      }
      upload.abort = done;
      stream.on('data', onData).on('end', onEnd).on('error', onClose).on('close', onClose);
      kick();
    });
  }

  /**
   * Stores an admitted upload from `deviceId` (sent from address `ip`); returns its public view.
   * The address is kept while the photo waits for the host (see waitingSpot()).
   */
  async store(deviceId, buf, ip = '') {
    const room = this.room;
    ip = String(ip || '');
    this.check(deviceId, ip); // the host may have changed something meanwhile
    const ext = imageType(buf);
    if (!ext) fail('Send a JPEG, PNG or WebP picture.', 'bad_type', 415);
    await fsp.mkdir(this.dir, { recursive: true });
    const id = crypto.randomBytes(9).toString('base64url');
    const file = path.join(this.dir, `${id}.${ext}`);
    await fsp.writeFile(file, buf);
    // Once more with nothing awaited before the list changes: the photo to make way for must
    // still be waiting (not approved meanwhile, nor taken by another upload).
    let checked;
    try {
      checked = this.check(deviceId, ip);
    } catch (e) {
      await fsp.unlink(file).catch(() => {});
      throw e;
    }
    const { profile, drop } = checked;
    const approve = !room.settings.get('guests.photoApproval');
    const now = Date.now();
    const photo = { id, ext, deviceId, name: profile.name, status: approve ? 'approved' : 'pending', createdAt: now, size: buf.length };
    if (approve) photo.decidedAt = now;
    else photo.ip = ip;
    if (drop) {
      this.list.splice(this.list.indexOf(drop), 1);
      fsp.unlink(this.file(drop)).catch(() => {});
      log.info(`the waiting list is full: dropped the oldest photo from ${drop.name}`);
    }
    this.list.push(photo);
    await this.prune();
    if (approve) this.show(photo);
    else room.toastHosts(`${profile.name} sent a photo — approve it on the Photos page.`);
    room.markDirty();
    log.info(`photo from ${profile.name} (${Math.round(buf.length / 1024)} KB, ${photo.status})`);
    return this.guestView(photo);
  }

  /** admit() + store() for bytes already in hand. */
  async add(deviceId, buf, ip = '') {
    const upload = this.admit(deviceId, ip);
    try {
      return await this.store(deviceId, buf, ip);
    } finally {
      upload.release();
    }
  }

  /**
   * Keeps at most MAX_KEPT approved/rejected photos: the oldest rejected go first, then the
   * oldest approved (by when the host decided). Waiting photos are capped on upload instead,
   * so guests' uploads never push out photos the host already put on the TV.
   */
  async prune() {
    const list = this.list;
    const oldest = (status) => {
      let at = -1;
      for (let i = 0; i < list.length; i++) {
        if (list[i].status === status && (at < 0 || decided(list[i]) < decided(list[at]))) at = i;
      }
      return at;
    };
    const gone = [];
    for (let kept = list.filter((p) => p.status !== 'pending').length; kept > MAX_KEPT; kept--) {
      let i = oldest('rejected');
      if (i < 0) i = oldest('approved');
      const [p] = list.splice(i, 1);
      if (this.flash?.id === p.id) this.flash = null;
      gone.push(p);
    }
    for (const p of gone) await fsp.unlink(this.file(p)).catch(() => {});
  }

  file(p) {
    return path.join(this.dir, `${p.id}.${p.ext}`);
  }

  /** The file for GET /api/photos/:id — approved photos for everyone, others for the host (and the sender). */
  fileFor(id, { host = false, deviceId = null } = {}) {
    const p = typeof id === 'string' ? this.find(id) : null;
    if (!p) return null;
    if (p.status !== 'approved' && !host && p.deviceId !== deviceId) return null;
    if (p.status === 'rejected' && !host) return null;
    return { abs: this.file(p), type: TYPES[p.ext] };
  }

  async approve(id) {
    const p = this.find(id);
    if (!p) fail('Photo not found.', 'not_found', 404);
    if (p.status !== 'approved') {
      decide(p, 'approved');
      this.show(p);
      this.room.notifyDevice(p.deviceId, { t: 'notify', kind: 'photo', status: 'approved' });
      await this.prune();
    }
    return { ok: true };
  }

  async reject(id) {
    const p = this.find(id);
    if (!p) fail('Photo not found.', 'not_found', 404);
    if (p.status !== 'rejected') {
      decide(p, 'rejected');
      if (this.flash?.id === id) this.flash = null;
      await this.prune();
    }
    return { ok: true };
  }

  /** "Don't show" for every photo waiting for the host (they stay under "Not shown"). */
  async rejectWaiting() {
    let n = 0;
    for (const p of this.list) {
      if (p.status !== 'pending') continue;
      decide(p, 'rejected');
      n++;
    }
    if (n) await this.prune();
    return { ok: true, count: n };
  }

  async remove(id) {
    const i = this.list.findIndex((p) => p.id === id);
    if (i < 0) fail('Photo not found.', 'not_found', 404);
    const [p] = this.list.splice(i, 1);
    if (this.flash?.id === id) this.flash = null;
    await fsp.unlink(this.file(p)).catch(() => {});
    return { ok: true };
  }

  /**
   * When the host bans `deviceId`: deletes the photos they sent that the host hasn't looked at
   * yet, and cuts off the one on its way.
   */
  dropPending(deviceId) {
    for (const u of this.uploads) {
      if (u.deviceId !== deviceId || !u.abort) continue;
      this.uploads.delete(u);
      u.abort(new UserError('The host has removed you from this party.', { code: 'banned', status: 403 }));
    }
    const gone = [];
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].deviceId === deviceId && this.list[i].status === 'pending') gone.push(...this.list.splice(i, 1));
    }
    for (const p of gone) fsp.unlink(this.file(p)).catch(() => {});
    return gone.length;
  }

  async removeAll() {
    for (const p of this.list.splice(0)) await fsp.unlink(this.file(p)).catch(() => {});
    this.flash = null;
    return { ok: true };
  }

  /** Shows a newly approved photo big on the TV for 7 seconds. */
  show(p) {
    this.flash = { id: p.id, name: p.name, until: Date.now() + 7000 };
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.room.markDirty();
    }, 7000);
    this.flashTimer.unref?.();
  }

  /** The newest `n` approved photos for the TV's photo wall (in the order the host approved them). */
  approved(n = 40) {
    return this.list.filter((p) => p.status === 'approved').sort(byDecision).slice(-n).map((p) => ({ id: p.id, name: p.name }));
  }

  guestView(p) {
    return { id: p.id, status: p.status, createdAt: p.createdAt };
  }

  /**
   * For the host: every photo waiting for them (newest first), then the HOST_LIST others the
   * host decided on last (latest first), so a photo they just put on the TV is always listed.
   */
  hostView() {
    const pending = this.list.filter((p) => p.status === 'pending').reverse();
    const recent = this.list.filter((p) => p.status !== 'pending').sort(byDecision).slice(-HOST_LIST).reverse();
    return [...pending, ...recent].map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt, size: p.size }));
  }

  /** How many photos are kept, by status (the host's list may not show them all). */
  counts() {
    const out = { total: this.list.length, pending: 0, approved: 0, rejected: 0 };
    for (const p of this.list) if (Object.hasOwn(out, p.status)) out[p.status]++;
    return out;
  }

  mine(deviceId) {
    return this.list.filter((p) => p.deviceId === deviceId).slice(-12).reverse().map((p) => this.guestView(p));
  }

  close() {
    clearTimeout(this.flashTimer);
  }
}
