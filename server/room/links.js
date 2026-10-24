// Songs from a link (PLAN §31.12): a guest — when the host allows it — or the host asks for a
// YouTube song that isn't in the library, with lyrics if they have them. Without lyrics, the
// artist and title are guessed from the video's title and the lyrics looked up at once, so the host
// sees them before deciding (the preview). The host says yes (the popup, or the Decisions page) and
// may correct them — what is shown is what is used —; the Karaoke maker makes it into the library;
// it is queued for the guest who asked, and their phone is told. Or no, with a note for the guest
// and, when the library has the song already, that song for them to sing. Requests are kept in
// data/requests.json and survive a restart (an approved one is made again).
//
// States (shared/maker.js): pending → queued (approved) → working → done | failed; pending →
// denied; pending, queued, working → cancelled. A request belongs to the guest's identity
// (client.data.deviceId: their account when signed in, else their phone).
import crypto from 'node:crypto';
import path from 'node:path';
import { JsonDoc } from '../util/jsonfile.js';
import { RateLimiter } from '../util/ratelimit.js';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { parseLink, cleanLyrics, namesFromVideo, OPEN_LINK_STATES } from '../../shared/maker.js';

const log = logger('links');
const KEEP = 200; // finished requests kept (the oldest go)
const MAX_OPEN_PER_IP = 5;
const MAX_NAME = 120;
const MAX_NOTE = 200;

const newId = () => crypto.randomBytes(6).toString('hex');
const open = (r) => OPEN_LINK_STATES.includes(r.state);
const clean = (v, max = MAX_NAME) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class Links {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object} o.room  the Room (profiles, settings, the maker, queueing, notifying)
   * @param {typeof fetch} [o.fetch]  the video's title from YouTube's oEmbed (none: no title)
   */
  constructor({ dataDir, room, fetch = null }) {
    this.doc = new JsonDoc(path.join(dataDir, 'requests.json'), { requests: [] });
    this.room = room;
    this.fetch = fetch;
    this.perPhone = new RateLimiter({ capacity: 3, perMs: 10 * 60_000 });
    this.looking = new Map(); // request id → its lyrics lookup running (in memory: not saved)
  }

  get list() {
    return this.doc.data.requests;
  }

  get settings() {
    return this.room.settings;
  }

  async load() {
    await this.doc.load();
    if (!Array.isArray(this.doc.data.requests)) this.doc.data.requests = [];
    for (const r of this.list) if (r.state === 'working') r.state = 'queued'; // (the job died with the server)
    for (const r of this.list) if (r.preview?.state === 'looking') r.preview = null; // (the lookup died with it too)
  }

  /** After the maker knows where autokaraoke is: the approved requests are made (again). */
  resume() {
    for (const r of this.list.filter((x) => x.state === 'queued' && !this.room.maker.jobs.some((j) => j.tag === x.id && !j.finishedAt))) this.startJob(r);
  }

  find(id) {
    const r = typeof id === 'string' ? this.list.find((x) => x.id === id) : null;
    if (!r) throw new UserError('That request is gone.', { status: 404, code: 'not_found' });
    return r;
  }

  changed() {
    this.doc.save();
    this.room.markDirty();
  }

  /** Guests may ask (the host allows it, and the maker can make songs). */
  guestsMay() {
    const m = this.room.maker;
    return !!this.settings.get('maker.guestLinks') && m.enabled && !!m.where?.installed && !m.outInfo().problem;
  }

  // ---- asking ------------------------------------------------------------------------------------

  /** `{ url, lyrics, artist, title }` from a guest (checked, limited) or the host (approved at once). */
  async add(client, m) {
    const isHost = client.role === 'host';
    const link = parseLink(m.url);
    if (link.error) throw new UserError(link.error);
    const lyrics = cleanLyrics(m.lyrics);
    const deviceId = isHost ? null : client.data.deviceId;
    const profile = deviceId ? this.room.profileOf(deviceId) : null;
    if (!isHost) {
      if (!this.guestsMay()) throw new UserError('The host isn’t taking song links right now.', { code: 'closed' });
      if (!profile?.name) throw new UserError('Choose a name first.', { code: 'no_profile' });
      if (profile.banned) throw new UserError('The host has removed you from this party.', { code: 'banned' });
      const mine = this.list.filter((r) => r.owner === deviceId && open(r)).length;
      const max = this.settings.get('maker.maxPerGuest');
      if (max > 0 && mine >= max) throw new UserError(`You already have ${mine} song${mine === 1 ? '' : 's'} on the way — the limit is ${max}.`, { code: 'limit' });
      const waiting = this.list.filter(open).length;
      if (waiting >= this.settings.get('maker.maxWaiting')) throw new UserError('The host has enough songs to make for now — try later.', { code: 'full' });
      const ip = String(client.ip || '');
      if (this.list.filter((r) => r.ip === ip && open(r)).length >= MAX_OPEN_PER_IP) throw new UserError('Too many songs asked for from this network — wait for some to be made.', { code: 'limit' });
      if (!this.perPhone.take(deviceId)) throw new UserError('Slow down — wait a few minutes before asking for another song.', { code: 'rate_limited' });
    }
    const same = this.list.find((r) => r.videoId === link.id && open(r));
    if (same) throw new UserError('Someone already asked for that song — it’s on its way.', { code: 'duplicate' });
    const made = this.list.find((r) => r.videoId === link.id && r.state === 'done' && r.songId && this.room.catalog.song(r.songId));
    if (made) throw new UserError(`That song is in the library already: ${made.title || 'search for it'}.`, { code: 'in_library', extra: { songId: made.songId } });
    const r = {
      id: newId(),
      url: link.url,
      videoId: link.id,
      owner: deviceId,
      name: isHost ? 'Host' : profile.name,
      ip: isHost ? '' : String(client.ip || ''),
      artist: clean(m.artist),
      title: clean(m.title),
      video: '', // YouTube's title (oEmbed), when it answers
      lyrics,
      state: 'pending',
      createdAt: Date.now(),
      decidedAt: 0,
      jobId: '',
      songId: null,
      trackId: null,
      error: '',
    };
    this.list.unshift(r);
    this.trim();
    void this.lookUpTitle(r);
    if (isHost) this.approve(r.id, {});
    else this.room.toastHosts(`${r.name} asked for a song from YouTube — see Decisions`, 'info');
    this.changed();
    return this.view(r, { forHost: isHost });
  }

  /** The video's title, from YouTube's oEmbed (no key; a failure just leaves it out). */
  async lookUpTitle(r) {
    if (!this.fetch) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await this.fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(r.url)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const d = await res.json();
      r.video = clean([d?.title, d?.author_name].filter((x) => typeof x === 'string' && x).join(' — '), 200);
      if (r.video) this.changed();
      // The song it probably is, for the host to correct: then its lyrics, unless the guest typed them.
      if (!r.artist && !r.title && typeof d?.title === 'string') {
        const guess = namesFromVideo(d.title, d.author_name);
        r.artist = clean(guess.artist);
        r.title = clean(guess.title);
        r.guessed = !!r.title;
      }
    } catch { /* offline, or YouTube didn't answer */ }
    if (r.state === 'pending' && !r.lyrics && r.title) void this.preview(r).catch(() => {});
  }

  /**
   * The lyrics the lyrics services have for the request's song (the maker's `previewLyrics`), kept
   * on it for the host: { state: 'looking' | 'found' | 'none' | 'failed', label, lines, match, text,
   * artist, title }. Shown with the request; Approve uses them unless the host changed them.
   */
  async preview(r) {
    if (this.looking.has(r.id)) return this.looking.get(r.id);
    const run = (async () => {
      r.preview = { state: 'looking', artist: r.artist, title: r.title };
      this.changed();
      try {
        const hit = await this.room.maker.previewLyrics({ artist: r.artist, title: r.title });
        r.preview = hit.found
          ? { state: 'found', label: hit.label, lines: hit.lines, match: hit.match, text: hit.text, artist: r.artist, title: r.title }
          : { state: 'none', artist: r.artist, title: r.title };
      } catch (e) {
        r.preview = { state: 'failed', error: e instanceof UserError ? e.message : 'The lyrics couldn’t be looked up just now.', artist: r.artist, title: r.title };
        if (!(e instanceof UserError)) log.info(`lyrics lookup for ${r.id} failed: ${e.message}`);
      } finally {
        this.looking.delete(r.id);
      }
      this.changed();
      return r.preview;
    })();
    this.looking.set(r.id, run);
    return run;
  }

  /** Host: look the lyrics up (again), with the artist and title they filled in. → the request's view. */
  async lookUpLyrics(id, m = {}) {
    const r = this.find(id);
    if (r.state !== 'pending') throw new UserError('That request was already decided.');
    if (typeof m.artist === 'string') r.artist = clean(m.artist);
    if (typeof m.title === 'string') r.title = clean(m.title);
    if (!r.title) throw new UserError('Fill in the title (and the artist) to look the lyrics up.');
    r.guessed = false;
    await this.preview(r);
    return this.view(r, { forHost: true });
  }

  trim() {
    const finished = this.list.filter((r) => !open(r));
    for (const r of finished.slice(KEEP)) this.list.splice(this.list.indexOf(r), 1);
  }

  // ---- the host's decisions ---------------------------------------------------------------------

  /** Yes: the maker makes it, with the host's lyrics if they changed them (`lyrics`), else the guest's. */
  approve(id, m = {}) {
    const r = this.find(id);
    if (r.state !== 'pending' && r.state !== 'failed') throw new UserError('That request was already decided.');
    const problem = this.room.maker.readyProblem();
    if (problem) throw new UserError(problem);
    if (typeof m.lyrics === 'string') r.lyrics = cleanLyrics(m.lyrics);
    else if (!r.lyrics && r.preview?.state === 'found') r.lyrics = r.preview.text; // (what the host saw)
    if (typeof m.artist === 'string') r.artist = clean(m.artist);
    if (typeof m.title === 'string') r.title = clean(m.title);
    r.state = 'queued';
    r.decidedAt = Date.now();
    r.error = '';
    this.settle(r);
    this.startJob(r, { strict: true });
    this.changed();
    return this.view(r, { forHost: true });
  }

  startJob(r, { strict = false } = {}) {
    try {
      const job = this.room.maker.make({ song: { url: r.url }, artist: r.artist, title: r.title, lyrics: r.lyrics }, { tag: r.id });
      return job.then((j) => {
        r.jobId = j.id;
        this.changed();
      }, (e) => this.jobFailed(r, e, strict));
    } catch (e) {
      return this.jobFailed(r, e, strict);
    }
  }

  jobFailed(r, e, strict) {
    r.state = 'failed';
    r.error = e instanceof UserError ? e.message : 'The Karaoke maker couldn’t start.';
    this.changed();
    if (strict) log.info(`request ${r.id}: ${r.error}`);
  }

  /**
   * No: `reason`, a note for the guest, and `songId`, a song the library has already (the version
   * they can sing instead) — both optional. Their phone is told, with that song to open.
   */
  deny(id, m = {}) {
    const r = this.find(id);
    if (r.state !== 'pending') throw new UserError('That request was already decided.');
    let alt = null;
    if (m.songId !== undefined && m.songId !== null && m.songId !== '') {
      const song = typeof m.songId === 'string' ? this.room.catalog.song(m.songId) : null;
      if (!song) throw new UserError('That song isn’t in the library (it may have been rescanned).');
      alt = { songId: song.id, title: song.title, artist: song.artist };
    }
    r.state = 'denied';
    r.decidedAt = Date.now();
    r.error = clean(m.reason, MAX_NOTE);
    r.alt = alt;
    this.settle(r);
    if (r.owner) this.room.notifyDevice(r.owner, { t: 'notify', kind: 'link', state: 'denied', title: this.titleOf(r), reason: r.error, alt });
    this.changed();
    return this.view(r, { forHost: true });
  }

  /** Decided: the preview's text isn't needed any more (the file stays small). */
  settle(r) {
    if (r.preview?.text) r.preview = { ...r.preview, text: '' };
  }

  /** Cancel: a guest their own (not yet being made… or being made), the host any open one. */
  cancel(client, id) {
    const r = this.find(id);
    if (client.role !== 'host' && r.owner !== client.data.deviceId) throw new UserError('That request is gone.', { status: 404, code: 'not_found' });
    if (!open(r)) return this.view(r, { forHost: client.role === 'host' });
    if (r.jobId) {
      try { this.room.maker.cancel(r.jobId); } catch { /* already gone */ }
    }
    r.state = 'cancelled';
    r.decidedAt ||= Date.now();
    this.changed();
    return this.view(r, { forHost: client.role === 'host' });
  }

  retry(id) {
    const r = this.find(id);
    if (r.state !== 'failed') throw new UserError('Only a request that didn’t work can be tried again.');
    return this.approve(id, {});
  }

  remove(id) {
    const r = this.find(id);
    if (open(r)) throw new UserError('Cancel it first.');
    this.list.splice(this.list.indexOf(r), 1);
    this.changed();
    return { ok: true };
  }

  clear() {
    this.doc.data.requests = this.list.filter(open);
    this.changed();
    return { ok: true };
  }

  /** A banned guest's requests that weren't approved yet go. */
  dropPending(deviceId) {
    let n = 0;
    for (const r of this.list) {
      if (r.owner === deviceId && r.state === 'pending') {
        r.state = 'cancelled';
        n++;
      }
    }
    if (n) this.changed();
  }

  // ---- the maker's side -------------------------------------------------------------------------

  /** The maker's job for a request moved on (Maker → onJob). */
  onJob(job) {
    const r = this.list.find((x) => x.id === job.tag);
    if (!r || !open(r)) return;
    r.jobId = job.id;
    if (job.status === 'running' || job.status === 'waiting') r.state = 'working';
    if (job.artist && !r.artist) r.artist = job.artist;
    if (job.title && !r.title) r.title = job.title;
    if (job.status === 'failed') {
      r.state = 'failed';
      r.error = job.error || 'autokaraoke stopped.';
      if (r.owner) this.room.notifyDevice(r.owner, { t: 'notify', kind: 'link', state: 'failed', title: this.titleOf(r) });
    } else if (job.status === 'cancelled') {
      r.state = 'cancelled';
    } else if (job.status === 'done' && job.result && !job.result.scanning) {
      r.state = 'done';
      r.songId = job.result.songId || null;
      r.trackId = job.result.trackId || null;
      const song = r.songId && this.room.catalog.song(r.songId);
      if (song) {
        r.title = song.title;
        r.artist = song.artist;
      }
      let queued = false;
      if (r.owner && song && this.settings.get('maker.queueWhenDone')) {
        try {
          queued = this.room.queueForGuest(r.owner, r.songId, r.trackId);
        } catch (e) {
          log.info(`could not queue request ${r.id}: ${e.message}`);
        }
      }
      r.queued = queued;
      if (r.owner) this.room.notifyDevice(r.owner, { t: 'notify', kind: 'link', state: 'done', title: this.titleOf(r), queued, songId: r.songId });
      if (!song) r.error = 'Made, but not found in the library — rescan it.';
    }
    this.changed();
  }

  titleOf(r) {
    return r.title ? `${r.artist ? `${r.artist} – ` : ''}${r.title}` : r.video || 'your song';
  }

  // ---- views --------------------------------------------------------------------------------------

  view(r, { forHost = false } = {}) {
    const job = r.jobId ? this.room.maker.jobs.find((j) => j.id === r.jobId) : null;
    const base = {
      id: r.id, url: r.url, state: r.state, title: this.titleOf(r), video: r.video, createdAt: r.createdAt,
      error: r.error, songId: r.songId, queued: !!r.queued, lyrics: !!r.lyrics, alt: r.state === 'denied' ? r.alt || null : null,
      stage: job && r.state === 'working' ? job.stage : '', percent: job && r.state === 'working' ? Math.round(job.percent || 0) : 0,
    };
    if (!forHost) return base;
    return {
      ...base, name: r.name, owner: r.owner, artist: r.artist, plainTitle: r.title, lyricsText: r.lyrics, trackId: r.trackId, jobId: r.jobId, decidedAt: r.decidedAt, waiting: job?.status === 'waiting',
      guessed: !!r.guessed, preview: r.state === 'pending' ? r.preview || null : null,
    };
  }

  /** The host: open requests first (oldest first), then the last 30 finished. */
  hostView() {
    const openOnes = this.list.filter(open).sort((a, b) => a.createdAt - b.createdAt);
    const done = this.list.filter((r) => !open(r)).slice(0, 30);
    return [...openOnes, ...done].map((r) => this.view(r, { forHost: true }));
  }

  counts() {
    return { pending: this.list.filter((r) => r.state === 'pending').length, open: this.list.filter(open).length };
  }

  /** A guest's own requests (their identity). */
  mine(deviceId) {
    return this.list.filter((r) => r.owner === deviceId).slice(0, 10).map((r) => this.view(r));
  }
}
