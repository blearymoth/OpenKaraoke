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
const MAX_PHOTOS = 300;
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const fail = (message, code = 'bad_request', status = 400) => {
  throw new UserError(message, { code, status });
};

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
  }

  get list() {
    return (this.room.s.photos ||= []);
  }

  find(id) {
    return this.list.find((p) => p.id === id) || null;
  }

  /** Stores an upload from `deviceId`; returns its public view. */
  async add(deviceId, buf) {
    const room = this.room;
    if (!room.settings.get('guests.photos')) fail('The host has turned photos off.', 'closed', 403);
    const profile = room.profileOf(deviceId);
    if (!profile?.name) fail('Choose a name first.', 'no_profile', 403);
    if (profile.banned) fail('The host has removed you from this party.', 'banned', 403);
    if (!this.limit.take(deviceId)) fail('That’s a lot of photos — wait a few minutes.', 'rate_limited', 429);
    const ext = imageType(buf);
    if (!ext) fail('Send a JPEG, PNG or WebP picture.', 'bad_type', 415);
    await fsp.mkdir(this.dir, { recursive: true });
    const id = crypto.randomBytes(9).toString('base64url');
    const file = path.join(this.dir, `${id}.${ext}`);
    await fsp.writeFile(file, buf);
    const approve = !room.settings.get('guests.photoApproval');
    const photo = { id, ext, deviceId, name: profile.name, status: approve ? 'approved' : 'pending', createdAt: Date.now(), size: buf.length };
    this.list.push(photo);
    await this.prune();
    if (approve) this.show(photo);
    else room.toastHosts(`${profile.name} sent a photo — approve it on the Photos page.`);
    room.markDirty();
    log.info(`photo from ${profile.name} (${Math.round(buf.length / 1024)} KB, ${photo.status})`);
    return this.guestView(photo);
  }

  /** Keeps at most MAX_PHOTOS (oldest rejected/approved go first). */
  async prune() {
    const list = this.list;
    while (list.length > MAX_PHOTOS) {
      const i = list.findIndex((p) => p.status !== 'pending');
      const [gone] = list.splice(i >= 0 ? i : 0, 1);
      await fsp.unlink(this.file(gone)).catch(() => {});
    }
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

  approve(id) {
    const p = this.find(id);
    if (!p) fail('Photo not found.', 'not_found', 404);
    if (p.status !== 'approved') {
      p.status = 'approved';
      this.show(p);
      this.room.notifyDevice(p.deviceId, { t: 'notify', kind: 'photo', status: 'approved' });
    }
    return { ok: true };
  }

  reject(id) {
    const p = this.find(id);
    if (!p) fail('Photo not found.', 'not_found', 404);
    p.status = 'rejected';
    if (this.flash?.id === id) this.flash = null;
    return { ok: true };
  }

  async remove(id) {
    const i = this.list.findIndex((p) => p.id === id);
    if (i < 0) fail('Photo not found.', 'not_found', 404);
    const [p] = this.list.splice(i, 1);
    if (this.flash?.id === id) this.flash = null;
    await fsp.unlink(this.file(p)).catch(() => {});
    return { ok: true };
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

  approved(n = 40) {
    return this.list.filter((p) => p.status === 'approved').slice(-n).map((p) => ({ id: p.id, name: p.name }));
  }

  guestView(p) {
    return { id: p.id, status: p.status, createdAt: p.createdAt };
  }

  hostView() {
    return this.list.slice(-120).reverse().map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt, size: p.size }));
  }

  mine(deviceId) {
    return this.list.filter((p) => p.deviceId === deviceId).slice(-12).reverse().map((p) => this.guestView(p));
  }

  close() {
    clearTimeout(this.flashTimer);
  }
}
