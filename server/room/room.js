// The party: queue, singers, guests, the player state machine and what every client sees
// (PLAN §5.4, §6, §7). All changes go through the actions below, then one coalesced
// broadcast sends each role its own view.
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { JsonDoc } from '../util/jsonfile.js';
import { UserError } from '../util/errors.js';
import { RateLimiter } from '../util/ratelimit.js';
import { wifiPayload } from '../util/qr.js';
import { mediaUrls } from '../http/media.js';
import { insertIndex, etas, leadOf, shuffled } from './rotation.js';
import { CHANNEL_MODES, AVATARS, COLORS, REACTIONS, clampKey, clampTempo } from '../../shared/protocol.js';
import { fold } from '../../shared/text.js';
import { logger } from '../util/log.js';

const log = logger('room');
const SESSION_IDLE_MS = 8 * 3600 * 1000;
const QUIET = new Set(['tv.status', 'reaction', 'history.list']); // no state change → no broadcast
const HOST = 'host';
const TV = 'tv';
const GUEST = 'guest';

const DEFAULT_STATE = {
  session: { id: '', startedAt: 0, lastActivity: 0 },
  singers: [],
  queue: [],
  pending: [],
  current: null,
  player: { state: 'idle', key: 0, tempo: 1, channel: 'stereo', volume: 0.9, pos: 0, dur: 0 },
  profiles: {},
  hostFavorites: [],
  playlists: [],
  songPrefs: {},
  trackPrefs: {},
  stats: { plays: {} },
  tonight: { sung: [], history: [] },
};

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url');
const str = (v, max = 100) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const fail = (message, code) => {
  throw new UserError(message, { code });
};

export class Room {
  constructor(app) {
    this.app = app;
    this.settings = app.settings;
    this.library = app.library;
    this.hub = app.hub;
    this.auth = app.auth;
    this.doc = new JsonDoc(path.join(app.dataDir, 'state.json'), DEFAULT_STATE, { debounceMs: 1000 });
    this.historyFile = path.join(app.dataDir, 'history.jsonl');
    this.flushTimer = null;
    this.introTimer = null;
    this.announceTimer = null;
    this.announcement = null;
    this.lastGuestTime = 0;
    this.notified = new Set();
    this.limits = {
      add: new RateLimiter({ capacity: 10, perMs: 60_000 }),
      reaction: new RateLimiter({ capacity: 4, perMs: 2000 }),
      profile: new RateLimiter({ capacity: 10, perMs: 60_000 }),
    };
    this.handlers = this.buildHandlers();
  }

  get s() {
    return this.doc.data;
  }

  get catalog() {
    return this.library.catalog;
  }

  async load() {
    await this.doc.load();
    const s = this.s;
    // After a restart nothing is playing: keep the current song paused where it was.
    const p = s.player;
    if (s.current) Object.assign(p, { state: 'paused', tvReady: false, displayLost: true });
    else Object.assign(p, { state: 'idle', pos: 0, dur: 0 });
    p.seek = { seq: 0, pos: p.pos || 0 };
    if (!Number.isFinite(p.volume)) p.volume = this.settings.get('playback.volume');
    this.ensureSession();
    this.syncPlays();
    this.save();
  }

  save() {
    this.doc.save();
  }

  async close() {
    clearTimeout(this.introTimer);
    clearTimeout(this.flushTimer);
    clearTimeout(this.announceTimer);
    await this.doc.flush();
  }

  // ---- sessions ("tonight") ---------------------------------------------------------

  ensureSession() {
    const ses = this.s.session;
    if (!ses.id || Date.now() - (ses.lastActivity || 0) > SESSION_IDLE_MS) this.newSession();
  }

  newSession() {
    const now = Date.now();
    this.s.session = { id: newId(), startedAt: now, lastActivity: now };
    this.s.tonight = { sung: [], history: [] };
    for (const singer of this.s.singers) singer.sung = 0;
    this.notified.clear();
    log.info('new party session started');
  }

  touch() {
    this.s.session.lastActivity = Date.now();
  }

  syncPlays() {
    this.catalog.plays = new Map(Object.entries(this.s.stats.plays).map(([k, v]) => [k, Number(v) || 0]));
    this.catalog.metaChanged();
  }

  onLibraryChanged() {
    this.syncPlays();
    this.markDirty();
  }

  // ---- connections ---------------------------------------------------------------------

  async hello(client, msg) {
    const role = msg.role;
    if (role === HOST) {
      if (!this.auth.isHost(client.ip, msg.token)) return { ok: false, reason: this.auth.pin ? 'pin_required' : 'host_only' };
      return { ok: true, role, welcome: { state: this.hostView() } };
    }
    if (role === TV) {
      if (!client.isLocal && !this.auth.verify(msg.token, 'tv')) return { ok: false, reason: 'pairing_required' };
      client.data.display = msg.display === 'mirror' || this.mainDisplay() ? 'mirror' : 'main';
      return { ok: true, role, welcome: { display: client.data.display, state: this.tvView() } };
    }
    if (role === GUEST) {
      if (String(msg.room || '').toUpperCase() !== this.settings.get('party.roomCode')) return { ok: false, reason: 'bad_room' };
      let deviceId = this.auth.verify(msg.token, 'guest')?.id;
      let token;
      if (!deviceId) {
        deviceId = this.auth.newId();
        token = this.auth.sign('guest', deviceId);
      }
      const profile = this.s.profiles[deviceId];
      if (profile?.banned) return { ok: false, reason: 'banned' };
      if (profile) profile.lastSeen = Date.now();
      client.data.deviceId = deviceId;
      return { ok: true, role, welcome: { deviceId, token, state: this.guestView(client) } };
    }
    return { ok: false, reason: 'bad_role' };
  }

  onJoin(client) {
    if (client.role === TV && client.data.display === 'main') {
      const p = this.s.player;
      if (p.displayLost) p.displayLost = false;
      log.info(`TV display connected (${client.isLocal ? 'this computer' : client.ip})`);
      this.maybeAutoStart();
    }
    this.markDirty();
  }

  onLeave(client) {
    if (client.role === TV && client.data.display === 'main') {
      const next = this.hub.list((c) => c.role === TV && c !== client && c.open)[0];
      if (next) {
        next.data.display = 'main';
        next.send({ t: 'display', display: 'main' });
      } else {
        const p = this.s.player;
        if (this.s.current) {
          if (p.state === 'playing' || p.state === 'intro' || p.state === 'ready') {
            p.state = 'paused';
            this.toastHosts('The TV display disconnected — playback is paused.', 'error');
          }
          p.displayLost = true;
          p.tvReady = false;
          p.seek = { seq: (p.seek?.seq || 0) + 1, pos: p.pos || 0 };
        }
      }
      log.info('TV display disconnected');
    }
    this.markDirty();
  }

  mainDisplay() {
    return this.hub.list((c) => c.role === TV && c.data.display === 'main' && c.open)[0] || null;
  }

  // ---- requests ------------------------------------------------------------------------

  buildHandlers() {
    const H = [HOST];
    const HG = [HOST, GUEST];
    const PLAYER = [HOST, 'tv-local'];
    return {
      'queue.add': [HG, (c, m) => this.queueAdd(c, m)],
      'queue.remove': [HG, (c, m) => this.queueRemove(c, m)],
      'queue.move': [H, (c, m) => this.queueMove(m)],
      'queue.update': [H, (c, m) => this.queueUpdate(m)],
      'queue.approve': [H, (c, m) => this.queueApprove(m)],
      'queue.reject': [H, (c, m) => this.queueReject(m)],
      'queue.clear': [H, () => this.queueClear()],
      'queue.shuffle': [H, () => this.queueShuffle()],
      'player.play': [PLAYER, (c, m) => this.play(m)],
      'player.pause': [PLAYER, () => this.pause()],
      'player.resume': [PLAYER, () => this.resume()],
      'player.toggle': [PLAYER, () => (this.s.player.state === 'playing' ? this.pause() : this.s.current ? this.resume() : this.play({}))],
      'player.next': [PLAYER, () => this.next()],
      'player.restart': [PLAYER, () => this.seek({ pos: 0 })],
      'player.stop': [PLAYER, () => this.stop()],
      'player.seek': [PLAYER, (c, m) => this.seek(m)],
      'player.key': [PLAYER, (c, m) => this.setKey(m)],
      'player.tempo': [PLAYER, (c, m) => this.setTempo(m)],
      'player.channel': [PLAYER, (c, m) => this.setChannel(m)],
      'player.volume': [PLAYER, (c, m) => this.setVolume(m)],
      'singer.add': [H, (c, m) => this.singerAdd(m)],
      'singer.update': [H, (c, m) => this.singerUpdate(m)],
      'singer.remove': [H, (c, m) => this.singerRemove(m)],
      'guest.update': [[GUEST], (c, m) => this.guestUpdate(c, m)],
      'guest.kick': [H, (c, m) => this.guestKick(m, false)],
      'guest.ban': [H, (c, m) => this.guestKick(m, true)],
      'guest.unban': [H, (c, m) => this.guestUnban(m)],
      'favorite.toggle': [HG, (c, m) => this.favoriteToggle(c, m)],
      'settings.update': [H, (c, m) => this.settingsUpdate(m)],
      'library.rescan': [H, () => this.libraryRescan()],
      'library.paths': [H, (c, m) => this.libraryPaths(m)],
      'party.new': [H, () => this.partyNew()],
      'history.list': [H, () => this.historyList()],
      announce: [H, (c, m) => this.announce(m)],
      reaction: [HG, (c, m) => this.reaction(c, m)],
      'tv.status': [[TV], (c, m) => this.tvStatus(c, m)],
      'tv.ready': [[TV], (c, m) => this.tvReady(c, m)],
      'tv.ended': [[TV], (c, m) => this.tvEnded(c, m)],
      'tv.error': [[TV], (c, m) => this.tvError(c, m)],
    };
  }

  async request(client, msg) {
    const h = this.handlers[msg.t];
    if (!h) fail(`Unknown request: ${msg.t}`, 'unknown');
    const [roles, fn] = h;
    const allowed = roles.includes(client.role) || (roles.includes('tv-local') && client.role === TV && client.isLocal);
    if (!allowed) fail('You are not allowed to do that', 'forbidden');
    if (!msg.t.startsWith('tv.')) this.touch();
    const out = await fn(client, msg);
    if (!QUIET.has(msg.t)) this.markDirty();
    return out;
  }

  // ---- queue -----------------------------------------------------------------------------

  queueAdd(client, m) {
    const song = this.catalog.song(str(m.songId, 40));
    if (!song) fail('That song is not in the library (any more).', 'not_found');
    let track = m.trackId ? this.catalog.track(str(m.trackId, 40)) : null;
    if (track && track.songId !== song.id) track = null;
    const isGuest = client.role === GUEST;
    const deviceId = isGuest ? client.data.deviceId : null;
    const profile = deviceId ? this.s.profiles[deviceId] : null;

    if (isGuest) {
      const rules = this.settings.data.queue;
      if (!this.settings.get('party.guestsEnabled')) fail('The host has closed song requests for now.', 'closed');
      if (!profile?.name) fail('Choose a name first.', 'no_profile');
      if (profile.banned) fail('The host has removed you from this party.', 'banned');
      if (!this.limits.add.take(deviceId)) fail('Slow down — too many requests in a minute.', 'rate_limited');
      const mine = this.s.queue.filter((e) => e.addedBy === deviceId).length + this.s.pending.filter((e) => e.addedBy === deviceId).length;
      if (rules.maxPerGuest > 0 && mine >= rules.maxPerGuest) {
        fail(`You already have ${mine} song${mine === 1 ? '' : 's'} waiting — the limit is ${rules.maxPerGuest}.`, 'limit');
      }
      if (rules.maxDuration > 0 && song.duration > rules.maxDuration) fail('That song is longer than the host allows.', 'too_long');
      if (rules.explicitFilter && this.catalog.isExplicit(song)) fail('Explicit songs are turned off for this party.', 'explicit');
      if (!rules.allowRepeats && (this.s.tonight.sung.includes(song.id) || this.isQueued(song.id))) {
        fail('Someone already sang or queued that song tonight.', 'repeat');
      }
    }

    track ||= this.pickTrack(song);
    if (!track) fail('No playable version of that song was found.', 'not_found');

    let singerIds = [];
    if (isGuest) singerIds = [this.singerForProfile(deviceId).id];
    else if (m.singerId && this.singer(m.singerId)) singerIds = [m.singerId];
    else if (str(m.singerName, 40)) singerIds = [this.findOrCreateSinger(str(m.singerName, 40)).id];
    for (const pid of Array.isArray(m.partners) ? m.partners.slice(0, 3) : []) {
      if (this.singer(pid) && !singerIds.includes(pid)) singerIds.push(pid);
    }

    const prefs = this.prefsFor(song, singerIds[0]);
    const keyAllowed = !isGuest || this.settings.get('queue.guestKeyChange');
    const entry = {
      id: newId(),
      songId: song.id,
      trackId: track.id,
      singerIds,
      addedBy: isGuest ? deviceId : 'host',
      addedAt: Date.now(),
      key: keyAllowed && m.key !== undefined ? clampKey(m.key) : prefs.key,
      tempo: !isGuest && m.tempo !== undefined ? clampTempo(m.tempo) : prefs.tempo,
      artist: song.artist,
      title: song.title,
      dur: Math.round(track.duration || song.duration || 0),
      source: isGuest ? 'guest' : 'host',
    };
    if (m.mystery) entry.mystery = true;
    const note = str(m.note, 80);
    if (note) entry.note = note;

    if (isGuest && this.settings.get('queue.requireApproval')) {
      this.s.pending.push(entry);
      this.toastHosts(`${profile.name} requested ${song.title}`, 'info');
      return { pending: true, entry: this.entryView(entry) };
    }
    const index = this.insertEntry(entry, !isGuest ? m.position : undefined);
    const started = this.maybeAutoStart();
    return { pending: false, index, started, eta: started ? 0 : this.etaList()[index], entry: this.entryView(entry) };
  }

  /** Nothing playing, a TV is on and a song was queued: start it (PLAN: "first song starts the party"). */
  maybeAutoStart() {
    const s = this.s;
    if (s.current || !s.queue.length || !this.settings.get('playback.autoStart') || !this.mainDisplay()) return false;
    this.startEntry(s.queue.shift());
    return true;
  }

  /** Inserts per the rotation rules, or at 'next'/'end' when the host says so. */
  insertEntry(entry, position) {
    const q = this.s.queue;
    let index;
    if (position === 'next') index = 0;
    else if (position === 'end') index = q.length;
    else {
      const current = this.s.current;
      index = insertIndex(q, entry, {
        mode: this.settings.get('queue.mode'),
        newcomersFirst: this.settings.get('queue.newcomersFirst'),
        currentLead: current ? leadOf(current) : null,
        hasSung: (id) => (this.singer(id)?.sung || 0) > 0,
      });
    }
    q.splice(index, 0, entry);
    return index;
  }

  isQueued(songId) {
    return this.s.current?.songId === songId || this.s.queue.some((e) => e.songId === songId) || this.s.pending.some((e) => e.songId === songId);
  }

  pickTrack(song) {
    const prefTrack = this.s.songPrefs[song.key]?.trackId;
    const pref = prefTrack && this.catalog.track(prefTrack);
    if (pref && pref.songId === song.id) return pref;
    return this.catalog.bestTrack(song, this.settings.get('library.brandPriority'));
  }

  prefsFor(song, singerId) {
    const p = this.s.songPrefs[song.key];
    const bySinger = singerId && p?.bySinger?.[singerId];
    return { key: clampKey(bySinger?.key ?? p?.key ?? 0), tempo: clampTempo(bySinger?.tempo ?? p?.tempo ?? 1) };
  }

  findEntry(id, lists = ['queue', 'pending']) {
    for (const list of lists) {
      const i = this.s[list].findIndex((e) => e.id === id);
      if (i >= 0) return { list, index: i, entry: this.s[list][i] };
    }
    return null;
  }

  queueRemove(client, m) {
    const found = this.findEntry(str(m.entryId, 40));
    if (!found) fail('That song is no longer in the queue.', 'not_found');
    if (client.role === GUEST) {
      if (found.entry.addedBy !== client.data.deviceId) fail('You can only remove your own songs.', 'forbidden');
      if (!this.settings.get('queue.guestCanRemoveOwn')) fail('The host has turned off removing songs.', 'forbidden');
    }
    this.s[found.list].splice(found.index, 1);
    return { removed: found.entry.id };
  }

  queueMove(m) {
    const q = this.s.queue;
    const from = q.findIndex((e) => e.id === m.entryId);
    if (from < 0) fail('That song is no longer in the queue.', 'not_found');
    const to = Math.round(num(m.index, 0, q.length - 1, from));
    const [entry] = q.splice(from, 1);
    q.splice(to, 0, entry);
    return { index: to };
  }

  queueUpdate(m) {
    const found = this.findEntry(str(m.entryId, 40));
    if (!found) fail('That song is no longer in the queue.', 'not_found');
    const e = found.entry;
    const patch = m.patch || {};
    if (patch.key !== undefined) e.key = clampKey(patch.key);
    if (patch.tempo !== undefined) e.tempo = clampTempo(patch.tempo);
    if (patch.trackId !== undefined) {
      const t = this.catalog.track(str(patch.trackId, 40));
      if (!t || t.songId !== e.songId) fail('That version belongs to another song.', 'bad_request');
      e.trackId = t.id;
      e.dur = Math.round(t.duration || e.dur);
    }
    if (Array.isArray(patch.singerIds)) e.singerIds = patch.singerIds.filter((id) => this.singer(id)).slice(0, 4);
    if (patch.singerName !== undefined) {
      const name = str(patch.singerName, 40);
      e.singerIds = name ? [this.findOrCreateSinger(name).id] : [];
    }
    if (patch.mystery !== undefined) e.mystery = !!patch.mystery || undefined;
    if (patch.note !== undefined) e.note = str(patch.note, 80) || undefined;
    return { entry: this.entryView(e) };
  }

  queueApprove(m) {
    const i = this.s.pending.findIndex((e) => e.id === m.entryId);
    if (i < 0) fail('That request is gone.', 'not_found');
    const [entry] = this.s.pending.splice(i, 1);
    const index = this.insertEntry(entry, m.position);
    this.notifyDevices(entry, { t: 'notify', kind: 'approved', entryId: entry.id, title: entry.title });
    this.maybeAutoStart();
    return { index };
  }

  queueReject(m) {
    const i = this.s.pending.findIndex((e) => e.id === m.entryId);
    if (i < 0) fail('That request is gone.', 'not_found');
    const [entry] = this.s.pending.splice(i, 1);
    this.notifyDevices(entry, { t: 'notify', kind: 'rejected', entryId: entry.id, title: entry.title });
    return { rejected: entry.id };
  }

  queueClear() {
    const n = this.s.queue.length;
    this.s.queue = [];
    return { cleared: n };
  }

  queueShuffle() {
    this.s.queue = shuffled(this.s.queue);
    return { ok: true };
  }

  // ---- player ------------------------------------------------------------------------------

  /** Starts `entryId` (or the next queued song). Anything playing is finished as skipped. */
  play(m = {}) {
    const q = this.s.queue;
    let entry = null;
    if (m.entryId) {
      const i = q.findIndex((e) => e.id === m.entryId);
      if (i < 0) {
        if (this.s.current?.id === m.entryId) return this.resume();
        fail('That song is no longer in the queue.', 'not_found');
      }
      [entry] = q.splice(i, 1);
    } else if (this.s.current) {
      return this.resume();
    } else {
      entry = q.shift();
    }
    if (!entry) fail('The queue is empty — add a song first.', 'empty');
    if (this.s.current) this.finish('skipped', { advance: false });
    this.startEntry(entry);
    return { entryId: entry.id };
  }

  startEntry(entry) {
    const s = this.s;
    const track = this.catalog.track(entry.trackId);
    s.current = entry;
    const countdown = Math.max(0, Number(this.settings.get('playback.countdown')) || 0);
    const p = s.player;
    Object.assign(p, {
      state: 'intro',
      entryId: entry.id,
      introEndsAt: Date.now() + countdown * 1000,
      key: clampKey(entry.key),
      tempo: clampTempo(entry.tempo),
      channel: s.trackPrefs[entry.trackId]?.channel || this.settings.get('playback.defaultChannelMode') || 'stereo',
      pos: 0,
      dur: entry.dur || Math.round(track?.duration || 0),
      seek: { seq: (p.seek?.seq || 0) + 1, pos: 0 },
      tvReady: false,
      error: null,
      startedAt: 0,
    });
    if (!CHANNEL_MODES.includes(p.channel)) p.channel = 'stereo';
    clearTimeout(this.introTimer);
    this.introTimer = setTimeout(() => this.maybeBegin(), countdown * 1000 + 20);
    this.notifyDevices(entry, { t: 'notify', kind: 'now', entryId: entry.id, title: entry.title });
    log.info(`next up: ${entry.artist} – ${entry.title}`);
  }

  /** Intro → playing once the countdown is over and the TV has the media ready. */
  maybeBegin() {
    const p = this.s.player;
    if (p.state !== 'intro' || !p.tvReady || Date.now() < p.introEndsAt) return;
    p.state = this.settings.get('playback.startPaused') ? 'ready' : 'playing';
    if (p.state === 'playing') p.startedAt = Date.now();
    this.markDirty();
  }

  pause() {
    const p = this.s.player;
    if (p.state === 'playing') p.state = 'paused';
    return { state: p.state };
  }

  resume() {
    const p = this.s.player;
    if (!this.s.current) return this.play({});
    if (p.state === 'intro') {
      p.introEndsAt = Date.now(); // skip the countdown
      this.maybeBegin();
    } else if (p.state === 'paused' || p.state === 'ready') {
      if (p.displayLost && !this.mainDisplay()) fail('No TV display is connected — open the TV page first.', 'no_display');
      p.state = p.tvReady ? 'playing' : 'intro';
      if (p.state === 'intro') p.introEndsAt = Date.now();
      p.error = null;
      if (!p.startedAt) p.startedAt = Date.now();
    }
    return { state: p.state };
  }

  next() {
    if (!this.s.current && !this.s.queue.length) fail('Nothing to skip to.', 'empty');
    if (this.s.current) this.finish('skipped', { advance: true, force: true });
    else this.startEntry(this.s.queue.shift());
    return { ok: true };
  }

  /** Stops the current song and puts it back at the top of the queue. */
  stop() {
    const s = this.s;
    if (!s.current) return { ok: true };
    const entry = s.current;
    s.current = null;
    s.queue.unshift(entry);
    this.resetPlayer();
    return { ok: true };
  }

  resetPlayer() {
    const p = this.s.player;
    clearTimeout(this.introTimer);
    Object.assign(p, { state: 'idle', entryId: null, pos: 0, dur: 0, tvReady: false, error: null, displayLost: false, startedAt: 0, seek: { seq: (p.seek?.seq || 0) + 1, pos: 0 } });
  }

  seek(m) {
    const p = this.s.player;
    if (!this.s.current) fail('Nothing is playing.', 'idle');
    const pos = num(m.pos, 0, Math.max(0, (p.dur || 0) - 0.5), 0);
    p.seek = { seq: (p.seek?.seq || 0) + 1, pos };
    p.pos = pos;
    return { pos };
  }

  setKey(m) {
    const p = this.s.player;
    const key = clampKey(m.semitones ?? m.key);
    p.key = key;
    if (this.s.current) {
      this.s.current.key = key;
      this.rememberPrefs(this.s.current, { key });
    }
    return { key };
  }

  setTempo(m) {
    const p = this.s.player;
    const tempo = clampTempo(m.rate ?? m.tempo);
    p.tempo = tempo;
    if (this.s.current) {
      this.s.current.tempo = tempo;
      this.rememberPrefs(this.s.current, { tempo });
    }
    return { tempo };
  }

  setChannel(m) {
    if (!CHANNEL_MODES.includes(m.mode)) fail('Unknown channel mode', 'bad_request');
    this.s.player.channel = m.mode;
    if (this.s.current) this.s.trackPrefs[this.s.current.trackId] = { ...(this.s.trackPrefs[this.s.current.trackId] || {}), channel: m.mode };
    return { channel: m.mode };
  }

  setVolume(m) {
    this.s.player.volume = Math.round(num(m.v ?? m.volume, 0, 1, 0.9) * 100) / 100;
    return { volume: this.s.player.volume };
  }

  rememberPrefs(entry, patch) {
    const song = this.catalog.song(entry.songId);
    if (!song) return;
    const p = (this.s.songPrefs[song.key] ||= {});
    Object.assign(p, patch, { trackId: entry.trackId });
    const lead = entry.singerIds[0];
    if (lead) {
      p.bySinger ||= {};
      p.bySinger[lead] = { ...(p.bySinger[lead] || {}), ...patch };
    }
  }

  /** Ends the current song: history, stats, then the next song (or the lobby). */
  finish(reason, { advance = this.settings.get('playback.autoAdvance'), force = false } = {}) {
    const s = this.s;
    const entry = s.current;
    if (!entry) return;
    const p = s.player;
    const playedSec = Math.round(p.pos || 0);
    const completed = reason === 'ended' || playedSec >= Math.max(30, (p.dur || 0) * 0.6);
    const singers = entry.singerIds.map((id) => this.singer(id)).filter(Boolean);
    const record = {
      at: Date.now(), sessionId: s.session.id, songId: entry.songId, trackId: entry.trackId,
      artist: entry.artist, title: entry.title, singers: singers.map((x) => x.name),
      key: p.key, tempo: p.tempo, playedSec, skipped: !completed,
    };
    this.appendHistory(record);
    s.tonight.history.unshift({ ...record, entryId: entry.id, singerIds: entry.singerIds });
    s.tonight.history.length = Math.min(s.tonight.history.length, 200);
    if (completed) {
      for (const singer of singers) {
        singer.sung = (singer.sung || 0) + 1;
        singer.totalSung = (singer.totalSung || 0) + 1;
        singer.lastSangAt = Date.now();
      }
      if (!s.tonight.sung.includes(entry.songId)) s.tonight.sung.push(entry.songId);
      s.stats.plays[entry.songId] = (s.stats.plays[entry.songId] || 0) + 1;
      this.catalog.plays.set(entry.songId, s.stats.plays[entry.songId]);
      this.catalog.metaChanged();
    }
    s.current = null;
    this.resetPlayer();
    if ((advance || force) && s.queue.length) this.startEntry(s.queue.shift());
    this.markDirty();
  }

  async appendHistory(record) {
    try {
      await fs.appendFile(this.historyFile, `${JSON.stringify(record)}\n`);
    } catch (e) {
      log.warn('could not write history', e.message);
    }
  }

  historyList() {
    return { items: this.s.tonight.history.slice(0, 100) };
  }

  // ---- TV display reports ------------------------------------------------------------------

  isMainTv(client, entryId) {
    return client.data.display === 'main' && this.s.current && entryId === this.s.current.id;
  }

  tvStatus(client, m) {
    if (!this.isMainTv(client, m.entryId)) return;
    const p = this.s.player;
    p.pos = num(m.pos, 0, 36000, p.pos);
    if (m.dur) p.dur = num(m.dur, 0, 36000, p.dur);
    const now = Date.now();
    const time = { t: 'time', entryId: m.entryId, pos: p.pos, dur: p.dur, playing: !!m.playing, at: now };
    this.hub.broadcast(time, (c) => c.role === HOST || (c.role === TV && c.data.display === 'mirror'));
    if (now - this.lastGuestTime >= 1000) {
      this.lastGuestTime = now;
      this.hub.broadcast(time, (c) => c.role === GUEST);
    }
  }

  tvReady(client, m) {
    if (!this.isMainTv(client, m.entryId)) return;
    const p = this.s.player;
    p.tvReady = true;
    p.displayLost = false;
    if (m.dur) p.dur = num(m.dur, 0, 36000, p.dur);
    this.maybeBegin();
  }

  tvEnded(client, m) {
    if (!this.isMainTv(client, m.entryId)) return;
    this.s.player.pos = this.s.player.dur;
    this.finish('ended');
  }

  tvError(client, m) {
    if (!this.isMainTv(client, m.entryId)) return;
    const p = this.s.player;
    p.state = 'paused';
    p.error = str(m.error, 200) || 'The TV could not play this song.';
    this.toastHosts(`Can't play “${this.s.current.title}”: ${p.error}`, 'error');
  }

  // ---- singers & guests ----------------------------------------------------------------------

  singer(id) {
    return this.s.singers.find((x) => x.id === id) || null;
  }

  createSinger({ name, emoji, color, deviceId }) {
    const used = new Set(this.s.singers.map((x) => x.color));
    const singer = {
      id: newId(),
      name: name || 'Singer',
      emoji: emoji || AVATARS[Math.floor(Math.random() * AVATARS.length)],
      color: color || COLORS.find((c) => !used.has(c)) || COLORS[this.s.singers.length % COLORS.length],
      createdAt: Date.now(),
      sung: 0,
      totalSung: 0,
    };
    if (deviceId) singer.deviceId = deviceId;
    this.s.singers.push(singer);
    return singer;
  }

  findOrCreateSinger(name) {
    const f = fold(name);
    return this.s.singers.find((x) => fold(x.name) === f) || this.createSinger({ name });
  }

  singerForProfile(deviceId) {
    const profile = this.s.profiles[deviceId];
    let singer = profile.singerId && this.singer(profile.singerId);
    if (!singer) {
      singer = this.createSinger({ name: profile.name, emoji: profile.emoji, color: profile.color, deviceId });
      profile.singerId = singer.id;
    }
    return singer;
  }

  singerAdd(m) {
    const name = str(m.name, 40);
    if (!name) fail('Give the singer a name.', 'bad_request');
    const existing = this.s.singers.find((x) => fold(x.name) === fold(name));
    if (existing) return { singer: existing };
    return { singer: this.createSinger({ name, emoji: str(m.emoji, 16) || undefined, color: validColor(m.color) }) };
  }

  singerUpdate(m) {
    const singer = this.singer(m.singerId);
    if (!singer) fail('Singer not found.', 'not_found');
    const name = str(m.name, 40);
    if (name) singer.name = name;
    if (m.emoji) singer.emoji = str(m.emoji, 16);
    if (validColor(m.color)) singer.color = validColor(m.color);
    return { singer };
  }

  singerRemove(m) {
    const i = this.s.singers.findIndex((x) => x.id === m.singerId);
    if (i < 0) fail('Singer not found.', 'not_found');
    const [singer] = this.s.singers.splice(i, 1);
    for (const e of [...this.s.queue, ...this.s.pending]) e.singerIds = e.singerIds.filter((id) => id !== singer.id);
    for (const prof of Object.values(this.s.profiles)) if (prof.singerId === singer.id) delete prof.singerId;
    return { removed: singer.id };
  }

  guestUpdate(client, m) {
    const deviceId = client.data.deviceId;
    if (!this.limits.profile.take(deviceId)) fail('Too many changes — try again in a minute.', 'rate_limited');
    const name = str(m.name, 24);
    if (!name) fail('Please enter a name.', 'bad_request');
    const now = Date.now();
    const profile = (this.s.profiles[deviceId] ||= { createdAt: now, favorites: [] });
    profile.name = name;
    profile.emoji = str(m.emoji, 16) || profile.emoji || AVATARS[Math.floor(Math.random() * AVATARS.length)];
    profile.color = validColor(m.color) || profile.color || COLORS[Object.keys(this.s.profiles).length % COLORS.length];
    profile.lastSeen = now;
    const singer = this.singerForProfile(deviceId);
    Object.assign(singer, { name: profile.name, emoji: profile.emoji, color: profile.color });
    return { profile: this.profileView(deviceId) };
  }

  guestKick(m, ban) {
    const profile = this.s.profiles[m.deviceId];
    if (!profile) fail('Guest not found.', 'not_found');
    if (ban) {
      profile.banned = true;
      this.s.queue = this.s.queue.filter((e) => e.addedBy !== m.deviceId);
      this.s.pending = this.s.pending.filter((e) => e.addedBy !== m.deviceId);
    }
    for (const c of this.hub.list((x) => x.role === GUEST && x.data.deviceId === m.deviceId)) {
      c.send({ t: 'denied', reason: ban ? 'banned' : 'kicked' });
      c.close(4002, ban ? 'banned' : 'kicked');
    }
    return { ok: true };
  }

  guestUnban(m) {
    const profile = this.s.profiles[m.deviceId];
    if (profile) delete profile.banned;
    return { ok: true };
  }

  favoriteToggle(client, m) {
    const songId = str(m.songId, 40);
    if (!this.catalog.song(songId)) fail('Song not found.', 'not_found');
    let list;
    if (client.role === GUEST) {
      const profile = this.s.profiles[client.data.deviceId];
      if (!profile) fail('Choose a name first.', 'no_profile');
      list = profile.favorites ||= [];
    } else {
      list = this.s.hostFavorites;
    }
    const i = list.indexOf(songId);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(songId);
    if (list.length > 500) list.length = 500;
    return { favorite: i < 0 };
  }

  // ---- settings, library, party ---------------------------------------------------------------

  async settingsUpdate(m) {
    const patch = m.patch && typeof m.patch === 'object' ? structuredClone(m.patch) : {};
    if (patch.party?.roomCode !== undefined) {
      const code = String(patch.party.roomCode).toUpperCase().replace(/[^A-Z]/g, '');
      if (code.length !== 4) fail('The room code must be 4 letters.', 'bad_request');
      patch.party.roomCode = code;
    }
    if (patch.party?.adminPin !== undefined && !/^\d{0,8}$/.test(String(patch.party.adminPin))) fail('The PIN must be up to 8 digits.', 'bad_request');
    let paths = null;
    if (patch.library?.paths) {
      paths = patch.library.paths;
      delete patch.library.paths;
    }
    const clean = this.settings.update(patch);
    if (paths) await this.libraryPaths({ paths });
    return { settings: clean };
  }

  libraryRescan() {
    this.library.scan({ reason: 'host' }).catch((e) => log.error('scan failed', e));
    return { status: this.library.status() };
  }

  async libraryPaths(m) {
    if (!Array.isArray(m.paths) || m.paths.length > 20) fail('Choose up to 20 folders.', 'bad_request');
    if (m.paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) fail('Folders must be absolute paths.', 'bad_request');
    await this.library.setPaths(m.paths);
    this.library.scan({ reason: 'folders changed' }).catch((e) => log.error('scan failed', e));
    return { status: this.library.status() };
  }

  partyNew() {
    this.newSession();
    return { ok: true };
  }

  announce(m) {
    const text = str(m.text, 140);
    clearTimeout(this.announceTimer);
    if (!text) {
      this.announcement = null;
      return { ok: true };
    }
    const seconds = num(m.seconds, 3, 120, 10);
    this.announcement = { id: newId(4), text, until: Date.now() + seconds * 1000 };
    this.announceTimer = setTimeout(() => {
      this.announcement = null;
      this.markDirty();
    }, seconds * 1000);
    return { ok: true };
  }

  reaction(client, m) {
    if (!REACTIONS.includes(m.emoji)) fail('Unknown reaction', 'bad_request');
    if (client.role === GUEST && !this.settings.get('guests.reactions')) return { ok: false };
    const key = client.data.deviceId || client.id;
    if (!this.limits.reaction.take(key)) return { ok: false };
    const profile = client.data.deviceId ? this.s.profiles[client.data.deviceId] : null;
    this.hub.broadcast({ t: 'reaction', emoji: m.emoji, name: profile?.name || '', color: profile?.color || '' }, (c) => c.role === TV || c.role === HOST);
    return { ok: true };
  }

  // ---- notifications ---------------------------------------------------------------------------

  devicesOf(entry) {
    const ids = new Set();
    for (const sid of entry.singerIds) {
      const singer = this.singer(sid);
      if (singer?.deviceId) ids.add(singer.deviceId);
    }
    if (entry.addedBy && entry.addedBy !== 'host') ids.add(entry.addedBy);
    return ids;
  }

  notifyDevices(entry, msg) {
    const ids = this.devicesOf(entry);
    if (!ids.size) return;
    this.hub.broadcast(msg, (c) => c.role === GUEST && ids.has(c.data.deviceId));
  }

  /** "You're up next!" for whoever is first in the queue while a song is on. */
  checkUpNext() {
    const head = this.s.queue[0];
    if (!head || !this.s.current) return;
    const key = `next:${head.id}`;
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.notifyDevices(head, { t: 'notify', kind: 'next', entryId: head.id, title: head.title });
  }

  toastHosts(text, level = 'info') {
    this.hub.broadcast({ t: 'toast', level, text }, (c) => c.role === HOST);
  }

  // ---- views -------------------------------------------------------------------------------------

  singerView(id) {
    const x = this.singer(id);
    return x ? { id: x.id, name: x.name, emoji: x.emoji, color: x.color } : null;
  }

  profileView(deviceId) {
    const p = this.s.profiles[deviceId];
    if (!p) return null;
    return { name: p.name, emoji: p.emoji, color: p.color, singerId: p.singerId || null, favorites: p.favorites || [] };
  }

  entryView(e, { mask = false } = {}) {
    const song = this.catalog.song(e.songId);
    const out = {
      id: e.id,
      songId: e.songId,
      trackId: e.trackId,
      artist: song?.artist ?? e.artist,
      title: song?.title ?? e.title,
      dur: e.dur,
      key: e.key,
      tempo: e.tempo,
      singers: e.singerIds.map((id) => this.singerView(id)).filter(Boolean),
      addedAt: e.addedAt,
    };
    if (e.note) out.note = e.note;
    if (e.mystery) {
      out.mystery = true;
      if (mask) Object.assign(out, { artist: 'Mystery song', title: 'Surprise!', songId: null, trackId: null });
    }
    return out;
  }

  playerView() {
    const p = this.s.player;
    return {
      state: p.state,
      entryId: this.s.current?.id || null,
      introEndsAt: p.introEndsAt || 0,
      key: p.key,
      tempo: p.tempo,
      channel: p.channel,
      volume: p.volume,
      pos: p.pos || 0,
      dur: p.dur || 0,
      seek: p.seek || { seq: 0, pos: 0 },
      tvReady: !!p.tvReady,
      displayLost: !!p.displayLost,
      hasDisplay: !!this.mainDisplay(),
      error: p.error || null,
    };
  }

  etaList() {
    const p = this.s.player;
    const hasCurrent = !!this.s.current;
    const remaining = hasCurrent ? Math.max(0, (p.dur || this.s.current.dur || 0) - (p.pos || 0)) / (p.tempo || 1) : 0;
    return etas(this.s.queue, { remaining, hasCurrent, countdown: Number(this.settings.get('playback.countdown')) || 0, gap: 5 });
  }

  currentView({ media = false } = {}) {
    const e = this.s.current;
    if (!e) return null;
    const out = this.entryView(e);
    const track = this.catalog.track(e.trackId);
    if (track) {
      out.brand = track.p?.brand || '';
      out.flags = track.p?.flags || {};
    }
    if (media) out.media = mediaUrls(track);
    return out;
  }

  publicInfo() {
    const info = this.app.info();
    return { name: info.name, roomCode: info.roomCode, joinUrl: info.joinUrl };
  }

  hostView() {
    const s = this.s;
    const settings = structuredClone(this.settings.data);
    const hasPin = !!settings.party.adminPin;
    settings.party.adminPin = hasPin ? '••••' : '';
    const eta = this.etaList();
    const online = new Set(this.hub.list((c) => c.role === GUEST).map((c) => c.data.deviceId));
    const queuedBy = new Map();
    for (const e of [...s.queue, ...s.pending]) queuedBy.set(e.addedBy, (queuedBy.get(e.addedBy) || 0) + 1);
    const byName = (e) => (e.addedBy === 'host' ? 'Host' : s.profiles[e.addedBy]?.name || 'Guest');
    return {
      info: this.app.info(),
      settings,
      hasPin,
      library: this.library.status(),
      current: this.currentView(),
      player: this.playerView(),
      queue: s.queue.map((e, i) => ({ ...this.entryView(e), eta: eta[i], addedByName: byName(e) })),
      pending: s.pending.map((e) => ({ ...this.entryView(e), addedByName: byName(e) })),
      singers: s.singers.map((x) => ({
        id: x.id, name: x.name, emoji: x.emoji, color: x.color, sung: x.sung || 0, totalSung: x.totalSung || 0,
        deviceId: x.deviceId || null, online: x.deviceId ? online.has(x.deviceId) : null,
        queued: s.queue.filter((e) => e.singerIds.includes(x.id)).length,
      })),
      guests: Object.entries(s.profiles)
        .filter(([, p]) => p.name)
        .map(([deviceId, p]) => ({ deviceId, name: p.name, emoji: p.emoji, color: p.color, online: online.has(deviceId), banned: !!p.banned, queued: queuedBy.get(deviceId) || 0, lastSeen: p.lastSeen || 0 }))
        .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen)
        .slice(0, 300),
      displays: this.hub.list((c) => c.role === TV).map((c) => ({ id: c.id, display: c.data.display, local: c.isLocal })),
      hosts: this.hub.list((c) => c.role === HOST).length,
      announcement: this.announcement,
      favorites: s.hostFavorites,
      playlists: s.playlists,
      session: s.session,
      tonight: { songs: s.tonight.history.filter((h) => !h.skipped).length, history: s.tonight.history.slice(0, 30) },
    };
  }

  tvView() {
    const s = this.s;
    const party = this.settings.data.party;
    const eta = this.etaList();
    return {
      info: this.publicInfo(),
      display: this.settings.data.display,
      playback: {
        countdown: this.settings.get('playback.countdown'),
        lyricOffsetMs: this.settings.get('playback.lyricOffsetMs'),
        fadeSeconds: this.settings.get('playback.fadeSeconds'),
        normalize: this.settings.get('playback.normalize'),
        startPaused: this.settings.get('playback.startPaused'),
      },
      wifi: party.wifi?.show && party.wifi.ssid ? { ssid: party.wifi.ssid, qr: wifiPayload(party.wifi) } : null,
      guestsEnabled: party.guestsEnabled,
      current: this.currentView({ media: true }),
      next: s.queue[0] ? { entryId: s.queue[0].id, trackId: s.queue[0].trackId, media: mediaUrls(this.catalog.track(s.queue[0].trackId)) } : null,
      player: this.playerView(),
      queue: s.queue.slice(0, 10).map((e, i) => ({ ...this.entryView(e, { mask: true }), eta: eta[i] })),
      queueLength: s.queue.length,
      announcement: this.announcement,
      library: { songs: this.catalog.songs.size, offline: this.library.status().offline },
    };
  }

  guestBase() {
    const s = this.s;
    const q = this.settings.data.queue;
    const eta = this.etaList();
    return {
      info: this.publicInfo(),
      rules: {
        guestsEnabled: this.settings.get('party.guestsEnabled'),
        requireApproval: q.requireApproval,
        maxPerGuest: q.maxPerGuest,
        maxDuration: q.maxDuration,
        allowRepeats: q.allowRepeats,
        explicitFilter: q.explicitFilter,
        guestCanRemoveOwn: q.guestCanRemoveOwn,
        guestsSeeQueue: q.guestsSeeQueue,
        guestKeyChange: q.guestKeyChange,
        reactions: this.settings.get('guests.reactions'),
      },
      current: this.currentView(),
      player: (({ state, pos, dur, entryId, introEndsAt }) => ({ state, pos, dur, entryId, introEndsAt }))(this.playerView()),
      queue: s.queue.map((e, i) => ({ ...this.entryView(e, { mask: true }), eta: eta[i], _by: e.addedBy })),
      library: { songs: this.catalog.songs.size, offline: this.library.status().offline },
    };
  }

  guestView(client, base = this.guestBase()) {
    const deviceId = client.data.deviceId;
    const seeAll = base.rules.guestsSeeQueue;
    const queue = [];
    base.queue.forEach((e, i) => {
      const mine = e._by === deviceId;
      if (!seeAll && !mine) return;
      const { _by, ...rest } = e;
      queue.push({ ...rest, mine, position: i + 1 });
    });
    const pending = this.s.pending.filter((e) => e.addedBy === deviceId).map((e) => this.entryView(e));
    const queued = queue.filter((e) => e.mine).length + pending.length;
    const max = base.rules.maxPerGuest;
    return {
      ...base,
      queue,
      queueLength: base.queue.length,
      me: {
        deviceId,
        profile: this.profileView(deviceId),
        pending,
        queued,
        left: max > 0 ? Math.max(0, max - queued) : null,
      },
    };
  }

  // ---- broadcasting ----------------------------------------------------------------------------

  markDirty() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 40);
  }

  flush() {
    this.flushTimer = null;
    const clients = this.hub.list();
    if (clients.some((c) => c.role === HOST)) this.hub.broadcast({ t: 'state', state: this.hostView() }, (c) => c.role === HOST);
    if (clients.some((c) => c.role === TV)) this.hub.broadcast({ t: 'state', state: this.tvView() }, (c) => c.role === TV);
    const guests = clients.filter((c) => c.role === GUEST);
    if (guests.length) {
      const base = this.guestBase();
      for (const c of guests) c.send({ t: 'state', state: this.guestView(c, base) });
    }
    this.checkUpNext();
    this.save();
  }
}

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
}
