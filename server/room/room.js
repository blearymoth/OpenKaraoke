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
import { CHANNEL_MODES, AVATARS, COLORS, REACTIONS, RATING_SECONDS, clampKey, clampTempo } from '../../shared/protocol.js';
import { createGame } from '../games/index.js';
import { BreakMusic } from './breakmusic.js';
import { Photos } from './photos.js';
import { fold } from '../../shared/text.js';
import { logger } from '../util/log.js';

const log = logger('room');
const SESSION_IDLE_MS = 8 * 3600 * 1000;
// No party state change → no broadcast.
const QUIET = new Set(['tv.status', 'reaction', 'history.list', 'artwork.status', 'artwork.candidates', 'artwork.choose', 'artwork.none', 'artwork.refresh', 'artwork.retry', 'artwork.crawl']);
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
  tonight: { sung: [], history: [], games: [] },
  photos: [],
};

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url');
/** What a co-host's phone may do (never settings, bans, games or the library). */
const COHOST_ACTIONS = new Set([
  'player.play', 'player.pause', 'player.resume', 'player.toggle', 'player.next', 'player.restart', 'player.seek',
  'player.key', 'player.tempo', 'player.volume', 'queue.move', 'queue.approve', 'queue.reject', 'announce',
]);
const MAX_PLAYLISTS = 100;
const MAX_PLAYLIST_SONGS = 500;
const MASK = '••••••';
const MAX_PROFILES = 1000;
const validId = (id) => typeof id === 'string' && /^[\w-]{4,64}$/.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
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
    this.game = null; // the running party game (not persisted: a restart ends it)
    this.pairings = new Map(); // remote displays waiting for the host: id → { id, code, ip, at, status, token }
    this.rating = null; // guests rating the performance that just ended
    this.ratingTimer = null;
    this.lastGuestTime = 0;
    this.notified = new Set();
    this.limits = {
      add: new RateLimiter({ capacity: 10, perMs: 60_000 }),
      reaction: new RateLimiter({ capacity: 4, perMs: 2000 }),
      profile: new RateLimiter({ capacity: 10, perMs: 60_000 }),
      identity: new RateLimiter({ capacity: 12, perMs: 10 * 60_000 }), // new guest identities per IP
      guest: new RateLimiter({ capacity: 40, perMs: 20_000 }), // any guest request
      favorite: new RateLimiter({ capacity: 30, perMs: 60_000 }),
      game: new RateLimiter({ capacity: 20, perMs: 10_000 }), // answers/votes per guest
      pair: new RateLimiter({ capacity: 5, perMs: 10 * 60_000 }), // pairing codes per address
    };
    this.handlers = this.buildHandlers();
    this.breakMusic = new BreakMusic(this);
    this.photos = new Photos(this);
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
    clearTimeout(this.ratingTimer);
    this.closeRating();
    this.game?.dispose();
    this.breakMusic.close();
    this.photos.close();
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
    this.s.tonight = { sung: [], history: [], games: [] };
    for (const singer of this.s.singers) {
      singer.sung = 0;
      delete singer.stars;
    }
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
    this.ensureSession();
    const role = msg.role;
    if (role === HOST) {
      if (!this.auth.isHost(client.ip, msg.token)) return { ok: false, reason: this.auth.pin ? 'pin_required' : 'host_only' };
      return { ok: true, role, welcome: { state: this.hostView() } };
    }
    if (role === TV) {
      // A remote host (PIN) may watch the preview; other remote screens need pairing.
      const previewByHost = msg.display === 'preview' && this.auth.isHost(client.ip, msg.hostToken);
      if (!client.isLocal && !previewByHost && !this.auth.verify(msg.token, 'tv')) return { ok: false, reason: 'pairing_required' };
      // 'preview' = the host's small live preview: a muted mirror that doesn't count as a TV.
      client.data.preview = msg.display === 'preview';
      client.data.display = msg.display === 'mirror' || client.data.preview || this.mainDisplay() ? 'mirror' : 'main';
      return { ok: true, role, welcome: { display: client.data.display, state: this.tvView() } };
    }
    if (role === GUEST) {
      if (String(msg.room || '').toUpperCase() !== this.settings.get('party.roomCode')) return { ok: false, reason: 'bad_room' };
      let deviceId = this.auth.verify(msg.token, 'guest')?.id;
      let token;
      if (!deviceId) {
        // Each new identity costs a token so one device can't flood the party with fake guests.
        if (!this.limits.identity.take(String(client.ip))) return { ok: false, reason: 'rate_limited' };
        deviceId = this.auth.newId();
        token = this.auth.sign('guest', deviceId);
      }
      const profile = this.profileOf(deviceId);
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
      const next = this.hub.list((c) => c.role === TV && c !== client && c.open && !c.data.preview)[0];
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
      'playlist.save': [H, (c, m) => this.playlistSave(m)],
      'playlist.delete': [H, (c, m) => this.playlistDelete(m)],
      'playlist.add': [H, (c, m) => this.playlistAdd(m)],
      'playlist.remove': [H, (c, m) => this.playlistRemove(m)],
      'playlist.queue': [H, (c, m) => this.playlistQueue(m)],
      'guest.cohost': [H, (c, m) => this.guestCohost(m)],
      'display.approve': [H, (c, m) => this.displayApprove(m)],
      'display.deny': [H, (c, m) => this.displayDeny(m)],
      'display.forget': [H, () => this.displayForget()],
      'duet.answer': [[GUEST], (c, m) => this.duetAnswer(c, m)],
      'settings.update': [H, (c, m) => this.settingsUpdate(m)],
      'library.rescan': [H, () => this.libraryRescan()],
      'library.paths': [H, (c, m) => this.libraryPaths(m)],
      'party.new': [H, () => this.partyNew()],
      'history.list': [H, () => this.historyList()],
      'artwork.status': [H, () => this.artworkCall((a) => a.status())],
      'artwork.crawl': [H, (c, m) => this.artworkCrawl(m)],
      'artwork.candidates': [H, (c, m) => this.artworkCall((a) => a.candidates(this.songFor(m)))],
      'artwork.choose': [H, (c, m) => this.artworkCall((a) => a.choose(this.songFor(m), str(m.candidateId, 120)))],
      'artwork.none': [H, (c, m) => this.artworkCall((a) => a.setNone(this.songFor(m)))],
      'artwork.refresh': [H, (c, m) => this.artworkCall((a) => a.refresh(this.songFor(m)))],
      'artwork.retry': [H, () => this.artworkCall((a) => a.retryMisses())],
      announce: [H, (c, m) => this.announce(m)],
      reaction: [HG, (c, m) => this.reaction(c, m)],
      'tv.status': [[TV], (c, m) => this.tvStatus(c, m)],
      'tv.ready': [[TV], (c, m) => this.tvReady(c, m)],
      'tv.ended': [[TV], (c, m) => this.tvEnded(c, m)],
      'tv.error': [[TV], (c, m) => this.tvError(c, m)],
      'tv.audio': [[TV], (c, m) => { c.data.audioUnlocked = !!m.unlocked; }],
      'tv.game': [[TV], (c, m) => this.gameTv(c, m)],
      'tv.break': [[TV], (c, m) => { if (c.data.display === 'main') this.breakMusic.ended(str(m.id, 40)); }],
      'break.skip': [PLAYER, () => this.breakMusic.skip()],
      'photo.approve': [H, (c, m) => this.photos.approve(str(m.id, 40))],
      'photo.reject': [H, (c, m) => this.photos.reject(str(m.id, 40))],
      'photo.remove': [H, (c, m) => this.photos.remove(str(m.id, 40))],
      'photo.clear': [H, () => this.photos.removeAll()],
      'game.start': [H, (c, m) => this.gameStart(m)],
      'game.action': [H, (c, m) => this.activeGame().action(c, m)],
      'game.input': [[GUEST], (c, m) => this.gameInput(c, m)],
      'game.end': [H, () => this.gameEnd()],
      'game.close': [H, () => this.gameClose()],
      rate: [[GUEST], (c, m) => this.rate(c, m)],
    };
  }

  async request(client, msg) {
    const h = Object.hasOwn(this.handlers, msg.t) ? this.handlers[msg.t] : null;
    if (!h) fail(`Unknown request: ${String(msg.t).slice(0, 40)}`, 'unknown');
    const [roles, fn] = h;
    let actor = client;
    let allowed = roles.includes(client.role) || (roles.includes('tv-local') && client.role === TV && client.isLocal);
    // A co-host (a guest the host trusts) may run the player and the queue from their phone.
    if (!allowed && client.role === GUEST && COHOST_ACTIONS.has(msg.t) && this.profileOf(client.data.deviceId)?.coHost) {
      allowed = true;
      actor = { ...client, role: HOST, send: client.send?.bind(client), data: client.data, coHost: true };
    }
    if (!allowed) fail('You are not allowed to do that', 'forbidden');
    if (client.role === GUEST && !this.limits.guest.take(client.data.deviceId)) fail('Slow down a little — too many taps.', 'rate_limited');
    if (!msg.t.startsWith('tv.')) {
      this.ensureSession();
      this.touch();
    }
    const out = await fn(actor, msg);
    if (msg.t === 'favorite.toggle' && client.role === GUEST) {
      client.send({ t: 'state', state: this.guestView(client) }); // only this guest's view changed
    } else if (!QUIET.has(msg.t)) {
      this.markDirty();
    }
    return out;
  }

  /** A guest profile by device id (never an inherited object property). */
  profileOf(deviceId) {
    return validId(deviceId) && Object.hasOwn(this.s.profiles, deviceId) ? this.s.profiles[deviceId] : null;
  }

  // ---- queue -----------------------------------------------------------------------------

  queueAdd(client, m) {
    const song = this.catalog.song(str(m.songId, 40));
    if (!song) fail('That song is not in the library (any more).', 'not_found');
    let track = m.trackId ? this.catalog.track(str(m.trackId, 40)) : null;
    if (track && track.songId !== song.id) track = null;
    const isGuest = client.role === GUEST;
    const deviceId = isGuest ? client.data.deviceId : null;
    const profile = deviceId ? this.profileOf(deviceId) : null;
    const noExplicit = isGuest && this.settings.get('queue.explicitFilter');

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

    if (track && noExplicit && track.p?.flags?.explicit) track = null; // guests get a clean version
    track ||= this.pickTrack(song, { noExplicit });
    if (!track) fail(noExplicit ? 'Explicit songs are turned off for this party.' : 'No playable version of that song was found.', 'not_found');
    const maxDuration = this.settings.get('queue.maxDuration');
    if (isGuest && maxDuration > 0 && track.duration > maxDuration) fail('That song is longer than the host allows.', 'too_long');

    let singerIds = [];
    if (isGuest) singerIds = [this.singerForProfile(deviceId).id];
    else if (m.singerId && this.singer(m.singerId)) singerIds = [m.singerId];
    else if (str(m.singerName, 40)) singerIds = [this.findOrCreateSinger(str(m.singerName, 40)).id];
    // Duets: the host adds up to 3 partners (ids or a name). A guest can only *invite* one
    // other guest, who joins by accepting on their own phone (duet.answer).
    const partners = Array.isArray(m.partners) ? m.partners.slice(0, isGuest ? 1 : 3) : [];
    const invites = [];
    for (const pid of partners) {
      const partner = typeof pid === 'string' ? this.singer(pid) : null;
      if (!partner || singerIds.includes(pid)) continue;
      if (!isGuest) singerIds.push(pid);
      else if (partner.deviceId && !this.profileOf(partner.deviceId)?.banned) invites.push(pid);
    }
    if (!isGuest && str(m.partnerName, 40)) {
      const partner = this.findOrCreateSinger(str(m.partnerName, 40));
      if (!singerIds.includes(partner.id)) singerIds.push(partner.id);
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
      source: isGuest ? 'guest' : typeof m.source === 'string' && /^game:[a-z]{2,12}$/.test(m.source) ? m.source : 'host',
    };
    if (m.mystery) entry.mystery = true;
    const note = str(m.note, 80);
    if (note) entry.note = note;
    if (invites.length) entry.invites = invites;
    for (const pid of invites) {
      this.notifyDevice(this.singer(pid).deviceId, { t: 'notify', kind: 'duet', entryId: entry.id, title: song.title, by: this.singer(singerIds[0])?.name || '' });
    }

    if (isGuest && this.settings.get('queue.requireApproval')) {
      this.s.pending.push(entry);
      this.toastHosts(`${profile.name} requested ${song.title}`, 'info');
      return { pending: true, entry: this.entryView(entry) };
    }
    if (!isGuest && m.position === 'now') {
      this.s.queue.unshift(entry);
      this.play({ entryId: entry.id });
      return { pending: false, index: 0, started: true, eta: 0, entry: this.entryView(entry) };
    }
    const wasEmpty = !this.s.queue.length;
    const index = this.insertEntry(entry, !isGuest ? m.position : undefined);
    if (wasEmpty) this.maybeAutoStart();
    const started = this.s.current?.id === entry.id;
    return { pending: false, index, started, eta: started ? 0 : this.etaList()[this.s.queue.indexOf(entry)], entry: this.entryView(entry) };
  }

  /**
   * Nothing playing and a TV is on: start the queue ("the first song you pick starts the
   * party"). Not after the host pressed Stop, until they press Play again.
   */
  maybeAutoStart() {
    const s = this.s;
    if (s.current || !s.queue.length || s.player.hold || this.gameBlocks() || !this.settings.get('playback.autoStart') || !this.mainDisplay()) return false;
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

  pickTrack(song, { noExplicit = false } = {}) {
    const ok = (t) => !!t && t.songId === song.id && !(noExplicit && t.p?.flags?.explicit);
    const prefTrack = this.s.songPrefs[song.key]?.trackId;
    const pref = prefTrack && this.catalog.track(prefTrack);
    if (ok(pref)) return pref;
    const brands = this.settings.get('library.brandPriority');
    if (!noExplicit) return this.catalog.bestTrack(song, brands);
    const clean = { ...song, trackIds: song.trackIds.filter((id) => ok(this.catalog.track(id))) };
    return clean.trackIds.length ? this.catalog.bestTrack(clean, brands) : null;
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
    const wasEmpty = !this.s.queue.length;
    const index = this.insertEntry(entry, m.position);
    this.notifyDevices(entry, { t: 'notify', kind: 'approved', entryId: entry.id, title: entry.title });
    if (wasEmpty) this.maybeAutoStart();
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
    this.s.player.hold = false; // a fresh start: the next song queued starts the party again
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
    if (this.gameBlocks() && !this.s.current) fail('A game is using the TV — end it first.', 'busy');
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
      hold: false,
    });
    if (!CHANNEL_MODES.includes(p.channel)) p.channel = 'stereo';
    if (entry.clipEnd > 0) p.dur = Math.min(p.dur || entry.clipEnd, entry.clipEnd);
    clearTimeout(this.introTimer);
    this.introTimer = setTimeout(() => this.maybeBegin(), countdown * 1000 + 20);
    this.notifyDevices(entry, { t: 'notify', kind: 'now', entryId: entry.id, title: entry.title });
    log.info(`next up: ${entry.artist} – ${entry.title}`);
    this.gameHook('onSongStart', entry);
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
      if (p.error) {
        // Try again: the TV reloads the song (the drive may be back).
        p.reload = (p.reload || 0) + 1;
        p.tvReady = false;
        p.error = null;
      }
      p.state = p.tvReady ? 'playing' : 'intro';
      if (p.state === 'intro') p.introEndsAt = Date.now();
      if (!p.startedAt) p.startedAt = Date.now();
    }
    return { state: p.state };
  }

  next() {
    if (!this.s.current && !this.s.queue.length) fail('Nothing to skip to.', 'empty');
    if (!this.s.current && this.gameBlocks()) fail('A game is using the TV — end it first.', 'busy');
    if (this.s.current) this.finish('skipped', { advance: true, force: true });
    else this.startEntry(this.s.queue.shift());
    return { ok: true };
  }

  /** Stops the current song and puts it back at the top of the queue (nothing auto-starts until Play). */
  stop() {
    const s = this.s;
    if (!s.current) return { ok: true };
    const entry = s.current;
    s.current = null;
    s.queue.unshift(entry);
    this.resetPlayer();
    s.player.hold = true;
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
    if (entry.reactions) record.reactions = entry.reactions;
    if (entry.source?.startsWith('game:')) record.game = entry.source.slice(5);
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
    // A game that plays songs itself (battle) decides what comes next.
    const handled = this.gameHook('onSongEnd', entry, { completed, playedSec, reason }) === true;
    if (completed && !entry.game && entry.singerIds.length && this.settings.get('playback.ratingAfterSong')) this.openRating(entry);
    if (handled || this.gameBlocks()) { /* the game carries on */ }
    else if ((advance || force) && s.queue.length) this.startEntry(s.queue.shift());
    else if (s.queue.length) s.player.hold = true; // auto-advance is off: wait for the host
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
    const clipEnd = this.s.current.clipEnd || 0;
    p.pos = num(m.pos, 0, 36000, p.pos);
    if (m.dur) p.dur = Math.min(num(m.dur, 0, 36000, p.dur), clipEnd || Infinity);
    // A song snippet (battle rounds): the TV fades out at clipEnd; this is the safety net.
    if (clipEnd && p.pos >= clipEnd + 3) {
      this.finish('ended');
      return;
    }
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
    if (m.dur) p.dur = Math.min(num(m.dur, 0, 36000, p.dur), this.s.current.clipEnd || Infinity);
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
    const profile = this.profileOf(deviceId);
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
    if (!validId(deviceId)) fail('Unknown device', 'bad_request');
    if (!this.limits.profile.take(deviceId)) fail('Too many changes — try again in a minute.', 'rate_limited');
    const name = str(m.name, 24);
    if (!name) fail('Please enter a name.', 'bad_request');
    const now = Date.now();
    let profile = this.profileOf(deviceId);
    if (!profile) {
      this.pruneProfiles();
      profile = this.s.profiles[deviceId] = { createdAt: now, favorites: [] };
    }
    profile.name = name;
    profile.emoji = str(m.emoji, 16) || profile.emoji || AVATARS[Math.floor(Math.random() * AVATARS.length)];
    profile.color = validColor(m.color) || profile.color || COLORS[Object.keys(this.s.profiles).length % COLORS.length];
    profile.lastSeen = now;
    const singer = this.singerForProfile(deviceId);
    Object.assign(singer, { name: profile.name, emoji: profile.emoji, color: profile.color });
    return { profile: this.profileView(deviceId) };
  }

  /** Keeps the guest list bounded: forgets the longest-unseen guests with nothing waiting. */
  pruneProfiles() {
    const ids = Object.keys(this.s.profiles);
    if (ids.length < MAX_PROFILES) return;
    const busy = new Set([...this.s.queue, ...this.s.pending, ...(this.s.current ? [this.s.current] : [])].map((e) => e.addedBy));
    const online = new Set(this.hub.list((c) => c.role === GUEST).map((c) => c.data.deviceId));
    const removable = ids
      .filter((id) => !busy.has(id) && !online.has(id) && !this.s.profiles[id].banned)
      .sort((a, b) => (this.s.profiles[a].lastSeen || 0) - (this.s.profiles[b].lastSeen || 0))
      .slice(0, Math.max(1, ids.length - MAX_PROFILES + 100));
    for (const id of removable) {
      const singerId = this.s.profiles[id].singerId;
      delete this.s.profiles[id];
      const singer = singerId && this.singer(singerId);
      if (singer && !singer.sung) this.s.singers = this.s.singers.filter((x) => x.id !== singerId);
    }
  }

  guestKick(m, ban) {
    const profile = this.profileOf(m.deviceId);
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
    const profile = this.profileOf(m.deviceId);
    if (profile) delete profile.banned;
    return { ok: true };
  }

  favoriteToggle(client, m) {
    const songId = str(m.songId, 40);
    if (!this.catalog.song(songId)) fail('Song not found.', 'not_found');
    let list;
    if (client.role === GUEST) {
      const profile = this.profileOf(client.data.deviceId);
      if (!profile) fail('Choose a name first.', 'no_profile');
      if (!this.limits.favorite.take(client.data.deviceId)) fail('Too many changes — try again in a minute.', 'rate_limited');
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

  // ---- playlists (host) --------------------------------------------------------------------------

  playlist(id) {
    const p = this.s.playlists.find((x) => x.id === id);
    if (!p) fail('Playlist not found.', 'not_found');
    return p;
  }

  cleanSongIds(ids) {
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === 'string' && this.catalog.song(id) && !out.includes(id)) out.push(id);
      if (out.length >= MAX_PLAYLIST_SONGS) break;
    }
    return out;
  }

  /** Creates (or with `id`, renames/replaces) a playlist; `fromQueue` takes the queued songs. */
  playlistSave(m) {
    const name = str(m.name, 60);
    const songIds = m.fromQueue ? this.cleanSongIds(this.s.queue.map((e) => e.songId)) : m.songIds !== undefined ? this.cleanSongIds(m.songIds) : null;
    if (m.id) {
      const p = this.playlist(str(m.id, 40));
      if (name) p.name = name;
      if (songIds) p.songIds = songIds;
      return { id: p.id };
    }
    if (!name) fail('Give the playlist a name.', 'bad_request');
    if (this.s.playlists.length >= MAX_PLAYLISTS) fail(`You can keep up to ${MAX_PLAYLISTS} playlists.`, 'limit');
    const p = { id: newId(), name, songIds: songIds || [], createdAt: Date.now() };
    this.s.playlists.push(p);
    return { id: p.id };
  }

  playlistDelete(m) {
    const i = this.s.playlists.findIndex((x) => x.id === m.id);
    if (i < 0) fail('Playlist not found.', 'not_found');
    this.s.playlists.splice(i, 1);
    return { ok: true };
  }

  playlistAdd(m) {
    const p = this.playlist(str(m.id, 40));
    const song = this.catalog.song(str(m.songId, 40));
    if (!song) fail('Song not found.', 'not_found');
    if (!p.songIds.includes(song.id)) {
      if (p.songIds.length >= MAX_PLAYLIST_SONGS) fail(`A playlist holds up to ${MAX_PLAYLIST_SONGS} songs.`, 'limit');
      p.songIds.push(song.id);
    }
    return { count: p.songIds.length };
  }

  playlistRemove(m) {
    const p = this.playlist(str(m.id, 40));
    p.songIds = p.songIds.filter((x) => x !== m.songId);
    return { count: p.songIds.length };
  }

  /** Queues every song of a playlist (at the end) for one singer or nobody yet. */
  playlistQueue(m) {
    const p = this.playlist(str(m.id, 40));
    let ids = p.songIds.filter((id) => this.catalog.song(id));
    if (m.shuffle) ids = shuffled(ids);
    let added = 0;
    const errors = [];
    for (const songId of ids.slice(0, 100)) {
      try {
        this.queueAdd({ role: HOST, data: {} }, { songId, singerName: str(m.singerName, 40), position: 'end' });
        added++;
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { added, skipped: ids.length - added };
  }

  /** A guest accepts or declines a duet invitation (from another guest). */
  duetAnswer(client, m) {
    const found = this.findEntry(str(m.entryId, 40));
    const me = this.profileOf(client.data.deviceId)?.singerId;
    const e = found?.entry;
    if (!e || !me || !e.invites?.includes(me)) fail('That invitation is no longer open.', 'not_found');
    e.invites = e.invites.filter((x) => x !== me);
    if (!e.invites.length) delete e.invites;
    if (m.accept && !e.singerIds.includes(me)) e.singerIds.push(me);
    const inviter = this.singer(e.singerIds[0]);
    const name = this.singer(me)?.name || 'Your partner';
    if (inviter?.deviceId) this.notifyDevice(inviter.deviceId, { t: 'notify', kind: m.accept ? 'duet-yes' : 'duet-no', entryId: e.id, title: e.title, by: name });
    return { accepted: !!m.accept };
  }

  // ---- remote displays (pairing) --------------------------------------------------------------------

  /** A screen on another computer asks to become a TV display: it shows `code`, the host approves. */
  pairRequest(ip) {
    this.prunePairings();
    if (!this.limits.pair.take(String(ip))) fail('Too many pairing attempts — wait a few minutes.', 'rate_limited');
    if (this.pairings.size >= 20) fail('Too many screens are waiting to be paired.', 'busy');
    let code;
    do code = String(crypto.randomInt(1000, 10000)); while ([...this.pairings.values()].some((p) => p.code === code));
    const p = { id: newId(12), code, ip: String(ip || ''), at: Date.now(), status: 'waiting', token: null };
    this.pairings.set(p.id, p);
    this.toastHosts(`A screen at ${p.ip.replace(/^::ffff:/, '')} wants to be a TV display (code ${code}). Approve it in Settings → Displays.`);
    this.markDirty();
    return { id: p.id, code };
  }

  /** The waiting screen polls this; the token is handed out once. */
  pairStatus(id) {
    this.prunePairings();
    const p = typeof id === 'string' && this.pairings.get(id);
    if (!p) return { status: 'expired' };
    if (p.status === 'approved') {
      this.pairings.delete(id);
      this.markDirty();
      return { status: 'approved', token: p.token };
    }
    return { status: p.status };
  }

  prunePairings() {
    const now = Date.now();
    for (const [id, p] of this.pairings) if (now - p.at > 10 * 60_000) this.pairings.delete(id);
  }

  findPairing(m) {
    const p = [...this.pairings.values()].find((x) => x.id === m.id || (m.code && x.code === String(m.code)));
    if (!p || p.status !== 'waiting') fail('That screen is no longer waiting — ask it to show a new code.', 'not_found');
    return p;
  }

  displayApprove(m) {
    const p = this.findPairing(m);
    p.status = 'approved';
    p.token = this.auth.sign('tv', this.auth.newId());
    log.info(`paired a display at ${p.ip}`);
    return { ok: true };
  }

  displayDeny(m) {
    const p = this.findPairing(m);
    p.status = 'denied';
    return { ok: true };
  }

  /** Logs every paired (remote) display out; screens on this computer are not affected. */
  async displayForget() {
    await this.auth.forgetDisplays();
    for (const c of this.hub.list((x) => x.role === TV && !x.isLocal)) {
      c.send({ t: 'denied', reason: 'pairing_required' });
      c.close(4003, 'unpaired');
    }
    return { ok: true };
  }

  // ---- co-hosts ------------------------------------------------------------------------------------

  guestCohost(m) {
    const profile = this.profileOf(m.deviceId);
    if (!profile) fail('Guest not found.', 'not_found');
    if (m.on) profile.coHost = true;
    else delete profile.coHost;
    this.notifyDevice(m.deviceId, { t: 'notify', kind: m.on ? 'cohost' : 'cohost-off' });
    return { coHost: !!profile.coHost };
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
    if (patch.party?.adminPin === '••••') delete patch.party.adminPin;
    if (patch.party?.wifi?.password === MASK) delete patch.party.wifi.password;
    let paths = null;
    if (patch.library?.paths) {
      paths = patch.library.paths;
      delete patch.library.paths;
    }
    const clean = this.settings.update(patch);
    if (paths) await this.libraryPaths({ paths });
    if (clean.artwork) this.app.artwork?.settingsChanged();
    if (clean.playback?.breakMusic) this.breakMusic.settingsChanged();
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
    const profile = client.data.deviceId ? this.profileOf(client.data.deviceId) : null;
    if (this.s.current && ['playing', 'paused'].includes(this.s.player.state)) this.s.current.reactions = (this.s.current.reactions || 0) + 1;
    this.hub.broadcast({ t: 'reaction', emoji: m.emoji, name: profile?.name || '', color: profile?.color || '' }, (c) => c.role === TV || c.role === HOST);
    return { ok: true };
  }

  // ---- games (PLAN §13) -------------------------------------------------------------------------

  /** An exclusive game is on the TV: songs don't start by themselves (the game may start its own). */
  gameBlocks() {
    return !!(this.game && !this.game.ended && this.game.constructor.exclusive);
  }

  gameStart(m) {
    if (this.game && !this.game.ended) fail('A game is already running — end it first.', 'busy');
    const game = createGame(m.type, this, m.config && typeof m.config === 'object' ? m.config : {});
    if (game.constructor.exclusive && this.s.current) fail('Finish or stop the current song first — the game needs the TV.', 'busy');
    this.game?.dispose();
    this.game = game;
    try {
      game.start();
    } catch (e) {
      game.dispose();
      this.game = null;
      throw e;
    }
    log.info(`game started: ${game.type}`);
    return { id: game.id };
  }

  activeGame() {
    if (!this.game || this.game.ended) fail('No game is running.', 'no_game');
    return this.game;
  }

  gameInput(client, m) {
    const game = this.activeGame();
    if (!this.settings.get('guests.games')) fail('The host has turned off games on phones.', 'closed');
    if (!this.limits.game.take(client.data.deviceId)) fail('Slow down a little!', 'rate_limited');
    return game.input(client, m);
  }

  gameTv(client, m) {
    if (client.data.display !== 'main' || !this.game || this.game.ended) return { ok: false };
    return this.game.tv(client, m) ?? { ok: true };
  }

  gameEnd() {
    if (this.game && !this.game.ended) this.game.end();
    return { ok: true };
  }

  gameClose() {
    if (this.game && !this.game.ended) this.game.end();
    this.game?.dispose();
    this.game = null;
    this.maybeAutoStart();
    return { ok: true };
  }

  /** Called by Game.end(): remember the result for the recap, let the party carry on. */
  onGameEnded(game) {
    const summary = game.summary?.();
    if (summary) {
      const games = (this.s.tonight.games ||= []);
      games.push({ type: game.type, at: Date.now(), ...summary });
      if (games.length > 50) games.shift();
    }
    this.maybeAutoStart();
    this.markDirty();
  }

  gameHook(name, ...args) {
    const game = this.game;
    if (!game || game.ended || typeof game[name] !== 'function') return undefined;
    try {
      return game[name](...args);
    } catch (e) {
      log.warn(`game ${game.type} ${name} failed:`, e.message);
      return undefined;
    }
  }

  /**
   * Queues a song for a game (poll winner, wheel result, autoplay…): host rules, no guest limits —
   * but with the explicit filter on, only a clean version (like gameSing; none → an error).
   */
  gameQueue(song, { singerName = '', singerIds, position = 'next', source = 'game:x' } = {}) {
    let trackId;
    if (this.settings.get('queue.explicitFilter')) {
      const clean = this.pickTrack(song, { noExplicit: true });
      if (!clean) fail('Explicit songs are turned off for this party.', 'explicit');
      trackId = clean.id;
    }
    return this.queueAdd({ role: HOST, data: {} }, { songId: song.id, trackId, singerName, singerId: singerIds?.[0], partners: singerIds?.slice(1), position, source });
  }

  /**
   * Starts a song right away for a game (battle rounds). `clipEnd` (s) fades it out early.
   * The game's onSongEnd hook decides what happens after it.
   */
  gameSing(song, { singerIds = [], clipEnd = 0, gameId = '', source = 'game:x' } = {}) {
    const track = this.pickTrack(song, { noExplicit: !!this.settings.get('queue.explicitFilter') });
    if (!track) fail('No playable version of that song was found.', 'not_found');
    const ids = singerIds.filter((id) => this.singer(id)).slice(0, 4);
    const prefs = this.prefsFor(song, ids[0]);
    const entry = {
      id: newId(), songId: song.id, trackId: track.id, singerIds: ids, addedBy: 'host', addedAt: Date.now(),
      key: prefs.key, tempo: prefs.tempo, artist: song.artist, title: song.title,
      dur: Math.round(track.duration || song.duration || 0), source, game: gameId || source,
    };
    if (clipEnd > 0) entry.clipEnd = Math.max(15, Math.round(clipEnd));
    if (this.s.current) this.finish('skipped', { advance: false });
    this.s.player.hold = false;
    this.startEntry(entry);
    this.markDirty();
    return entry;
  }

  /** Sends a message to one guest's phones (device id from their signed token). */
  notifyDevice(deviceId, msg) {
    if (!deviceId) return;
    this.hub.broadcast(msg, (c) => c.role === GUEST && c.data.deviceId === deviceId);
  }

  // ---- performance ratings (PLAN §13.7) ----------------------------------------------------------------

  openRating(entry) {
    this.closeRating();
    this.rating = {
      entryId: entry.id,
      songId: entry.songId,
      title: entry.title,
      artist: entry.artist,
      singerIds: [...entry.singerIds],
      endsAt: Date.now() + RATING_SECONDS * 1000,
      votes: new Map(), // deviceId → stars
    };
    clearTimeout(this.ratingTimer);
    this.ratingTimer = setTimeout(() => {
      this.closeRating();
      this.markDirty();
    }, RATING_SECONDS * 1000);
    this.ratingTimer.unref?.();
  }

  rate(client, m) {
    const r = this.rating;
    if (!r || r.entryId !== m.entryId || Date.now() > r.endsAt) fail('Rating for this song has closed.', 'closed');
    const deviceId = client.data.deviceId;
    const profile = this.profileOf(deviceId);
    if (!profile?.name) fail('Choose a name first.', 'no_profile');
    if (profile.singerId && r.singerIds.includes(profile.singerId)) fail('You can’t rate your own performance 😉', 'own');
    const stars = Math.round(num(m.stars, 1, 5, 0));
    if (!stars) fail('Give 1 to 5 stars.', 'bad_request');
    r.votes.set(deviceId, stars);
    return { stars };
  }

  /** Ends the rating window: the average goes to tonight's history and the singers' stats. */
  closeRating() {
    const r = this.rating;
    if (!r) return;
    this.rating = null;
    clearTimeout(this.ratingTimer);
    if (!r.votes.size) return;
    const values = [...r.votes.values()];
    const avg = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    const h = this.s.tonight.history.find((x) => x.entryId === r.entryId);
    if (h) h.rating = { avg, n: values.length };
    for (const id of r.singerIds) {
      const singer = this.singer(id);
      if (!singer) continue;
      singer.stars = { sum: (singer.stars?.sum || 0) + avg, n: (singer.stars?.n || 0) + 1 };
    }
    this.appendHistory({ at: Date.now(), sessionId: this.s.session.id, type: 'rating', entryId: r.entryId, songId: r.songId, rating: avg, votes: values.length });
  }

  ratingView(role, deviceId) {
    const r = this.rating;
    if (!r || Date.now() > r.endsAt) return null;
    const values = [...r.votes.values()];
    const out = {
      entryId: r.entryId,
      title: r.title,
      artist: r.artist,
      singers: r.singerIds.map((id) => this.singerView(id)).filter(Boolean),
      endsAt: r.endsAt,
      votes: values.length,
      avg: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0,
    };
    if (role === GUEST) {
      out.mine = r.votes.get(deviceId) || 0;
      const singerId = this.profileOf(deviceId)?.singerId;
      out.own = !!singerId && r.singerIds.includes(singerId);
    }
    return out;
  }

  // ---- artwork --------------------------------------------------------------------------------

  songFor(m) {
    const song = this.catalog.song(str(m.songId, 40));
    if (!song) fail('Song not found.', 'not_found');
    return song;
  }

  async artworkCall(fn) {
    if (!this.app.artwork) fail('Artwork is not available.', 'unavailable');
    return fn(this.app.artwork);
  }

  artworkCrawl(m) {
    this.settings.update({ artwork: { crawl: !!m.on } });
    this.app.artwork?.settingsChanged();
    return { crawl: !!m.on };
  }

  /** New art for the song (or artist) on the TV: rebuild the TV view (fanart, logo). */
  onArt({ songs = [], artists = [] }) {
    const cur = this.s.current && this.catalog.song(this.s.current.songId);
    const next = this.s.queue[0]?.songId;
    if (!cur && !next) return;
    if ((cur && songs.includes(cur.id)) || (next && songs.includes(next)) || (cur && cur.artistKeys.some((k) => artists.includes(k)))) this.markDirty();
  }

  /** Current and upcoming songs are looked up first (and their big images prefetched). */
  focusArtwork() {
    const ids = [this.s.current?.songId, ...this.s.queue.slice(0, 3).map((e) => e.songId)];
    this.app.artwork?.focus(ids.map((id) => id && this.catalog.song(id)).filter(Boolean));
  }

  /** Popular songs with covers for the TV lobby mosaic (refreshed at most once a minute). */
  mosaic() {
    const now = Date.now();
    const v = `${this.catalog.version}:${this.catalog.metaVersion}`;
    if (this.mosaicCache && (this.mosaicCache.v === v || now - this.mosaicCache.at < 60_000)) return this.mosaicCache.ids;
    const ids = this.catalog.popular({ limit: 36, filter: { hasArt: true, noExplicit: !!this.settings.get('queue.explicitFilter') } }).items.map((s) => s.id);
    this.mosaicCache = { v, at: now, ids };
    return ids;
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
    const p = this.profileOf(deviceId);
    if (!p) return null;
    return { name: p.name, emoji: p.emoji, color: p.color, singerId: p.singerId || null, favorites: p.favorites || [], coHost: !!p.coHost };
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
    if (e.invites?.length) out.invites = e.invites.map((id) => this.singerView(id)).filter(Boolean);
    if (e.clipEnd) out.clipEnd = e.clipEnd;
    if (e.game) out.game = e.game;
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
      displayLocked: this.mainDisplay()?.data.audioUnlocked === false,
      error: p.error || null,
      reload: p.reload || 0,
      hold: !!p.hold,
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
    const song = this.catalog.song(e.songId);
    const meta = song && this.catalog.metaFor(song.key);
    if (meta?.year) out.year = meta.year;
    if (song) out.artistKeys = song.artistKeys;
    if (media) {
      out.media = mediaUrls(track);
      out.art = this.app.artwork?.artFor(song) || null;
    }
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
    if (settings.party.wifi?.password) settings.party.wifi.password = MASK;
    const eta = this.etaList();
    const online = new Set(this.hub.list((c) => c.role === GUEST).map((c) => c.data.deviceId));
    const queuedBy = new Map();
    for (const e of [...s.queue, ...s.pending]) queuedBy.set(e.addedBy, (queuedBy.get(e.addedBy) || 0) + 1);
    const byName = (e) => (e.addedBy === 'host' ? 'Host' : this.profileOf(e.addedBy)?.name || 'Guest');
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
        stars: x.stars?.n ? Math.round((x.stars.sum / x.stars.n) * 10) / 10 : null,
      })),
      guests: Object.entries(s.profiles)
        .filter(([, p]) => p.name)
        .map(([deviceId, p]) => ({ deviceId, name: p.name, emoji: p.emoji, color: p.color, online: online.has(deviceId), banned: !!p.banned, coHost: !!p.coHost, queued: queuedBy.get(deviceId) || 0, lastSeen: p.lastSeen || 0 }))
        .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen)
        .slice(0, 300),
      displays: this.hub.list((c) => c.role === TV && !c.data.preview).map((c) => ({ id: c.id, display: c.data.display, local: c.isLocal, ip: c.isLocal ? '' : String(c.ip || '').replace(/^::ffff:/, '') })),
      pairings: [...this.pairings.values()].filter((p) => p.status === 'waiting' && Date.now() - p.at < 10 * 60_000).map((p) => ({ id: p.id, code: p.code, ip: p.ip.replace(/^::ffff:/, ''), at: p.at })),
      hosts: this.hub.list((c) => c.role === HOST).length,
      announcement: this.announcement,
      favorites: s.hostFavorites,
      playlists: s.playlists,
      session: s.session,
      tonight: { songs: s.tonight.history.filter((h) => !h.skipped).length, history: s.tonight.history.slice(0, 30) },
      game: this.game?.view({ role: HOST }) || null,
      rating: this.ratingView(HOST),
      sungTonight: s.tonight.sung.slice(-500),
      breakMusic: (({ title, artist } = {}) => (title ? { title, artist } : null))(this.breakMusic.view() || {}),
      photos: this.photos.hostView(),
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
      mosaic: this.s.current ? [] : this.mosaic(),
      breakMusic: this.breakMusic.view(),
      photos: { list: this.photos.approved(40), flash: this.photos.flash },
      game: this.game?.view({ role: TV }) || null,
      rating: this.ratingView(TV),
    };
  }

  guestBase() {
    const s = this.s;
    const q = this.settings.data.queue;
    const eta = this.etaList();
    return {
      info: this.publicInfo(),
      accent: this.settings.get('display.accent'),
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
        games: this.settings.get('guests.games'),
        photos: this.settings.get('guests.photos'),
        photoApproval: this.settings.get('guests.photoApproval'),
      },
      current: this.currentView(),
      player: (({ state, pos, dur, entryId, introEndsAt }) => ({ state, pos, dur, entryId, introEndsAt }))(this.playerView()),
      queue: s.queue.map((e, i) => ({ ...this.entryView(e, { mask: true }), eta: eta[i], _by: e.addedBy })),
      library: { songs: this.catalog.songs.size, offline: this.library.status().offline },
      sungTonight: s.tonight.sung.slice(-500),
      partners: this.duetPartners(),
    };
  }

  /** Guests at the party (with a phone) that another guest can invite to a duet. */
  duetPartners() {
    const online = new Set(this.hub.list((c) => c.role === GUEST).map((c) => c.data.deviceId));
    return this.s.singers
      .filter((x) => x.deviceId && online.has(x.deviceId) && !this.profileOf(x.deviceId)?.banned)
      .slice(0, 60)
      .map((x) => ({ id: x.id, name: x.name, emoji: x.emoji, color: x.color }));
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
    const profile = this.profileOf(deviceId);
    return {
      ...base,
      queue,
      queueLength: base.queue.length,
      partners: base.partners.filter((x) => x.id !== profile?.singerId),
      cohost: profile?.coHost ? { pending: this.s.pending.map((e) => this.entryView(e)), player: this.playerView() } : null,
      game: this.game?.view({ role: GUEST, deviceId }) || null,
      rating: this.ratingView(GUEST, deviceId),
      me: {
        deviceId,
        profile: this.profileView(deviceId),
        photos: this.photos.mine(deviceId),
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
    this.focusArtwork();
    this.breakMusic.checkAutoplay();
    this.save();
  }
}

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
}
