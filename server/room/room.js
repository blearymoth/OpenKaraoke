// The party: singers, queue, player state machine, displays, guests (PLAN §6).
// All state changes go through Room actions; views are broadcast per role.
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { JsonDoc } from '../util/jsonfile.js';
import { logger } from '../util/log.js';
import { fold } from '../../shared/text.js';
import { clampKey, clampTempo, CHANNEL_MODES, REACTIONS, SINGER_COLORS, SINGER_EMOJIS, mediaUrls } from '../../shared/protocol.js';
import { insertIndex, etas, shuffleFair } from './rotation.js';
import { WsError } from '../ws/hub.js';
import { summaryStatus } from '../library/service.js';
import { makeRoomCode } from '../config.js';

const SESSION_IDLE_MS = 8 * 3600 * 1000;
const RELOAD_GRACE_MS = 15000;
const newId = () => crypto.randomBytes(6).toString('base64url');

function defaultState() {
  return {
    session: { id: newId(), startedAt: Date.now(), lastActivity: Date.now() },
    singers: [],
    queue: [],
    pending: [],
    current: null,
    player: { state: 'idle', entryId: null, key: 0, tempo: 1, channel: 'stereo', volume: 0.9, introEndsAt: 0, position: 0, duration: 0, seekSeq: 0, seekPos: 0 },
    profiles: {},
    hostFavorites: [],
    playlists: [],
    songPrefs: {},
    stats: { plays: {} },
    tonight: [],
  };
}

const err = (msg) => new WsError(msg);
const str = (v, max = 60) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export class Room {
  /** @param {object} app from createApp() */
  constructor(app, { log = logger('room') } = {}) {
    this.app = app;
    this.settings = app.settings;
    this.library = app.library;
    this.auth = app.auth;
    this.hub = app.hub;
    this.log = log;
    this.doc = new JsonDoc(path.join(app.dataDir, 'state.json'), defaultState(), { debounceMs: 800 });
    this.historyFile = path.join(app.dataDir, 'history.jsonl');
    this.mainDisplay = null; // clientId
    this.pairing = new Map(); // code -> clientId
    this.announce = null;
    this.notified = new Set();
    this.limits = new Map(); // deviceId -> { adds: [ts], reactions: [ts] }
    this.displayLost = null;
    this._flushTimer = null;
    this._introTimer = null;
    this._lastGuestTime = 0;
  }

  get s() { return this.doc.data; }
  get catalog() { return this.library.catalog; }

  async init() {
    await this.doc.load();
    const s = this.s;
    if (Date.now() - (s.session?.lastActivity || 0) > SESSION_IDLE_MS) this.newParty({ silent: true });
    // a song that was on stage when the server stopped goes back to the top of the queue
    if (s.current) {
      s.queue.unshift({ ...s.current });
      s.current = null;
    }
    Object.assign(s.player, { state: 'idle', entryId: null, position: 0, introEndsAt: 0 });
    if (!Number.isFinite(s.player.volume)) s.player.volume = this.settings.get('playback.volume');
    this.syncPlays();
    this.registerHandlers();
    this.library.on('status', () => this.touch());
    this.library.on('changed', () => { this.syncPlays(); this.touch(); });
    this.hub.on('join', (c) => this.onJoin(c));
    this.hub.on('rejoin', (c) => this.onJoin(c));
    this.hub.on('leave', (c) => this.onLeave(c));
    this.save();
    return this;
  }

  syncPlays() {
    this.catalog.plays = new Map(Object.entries(this.s.stats.plays || {}));
    this.catalog.metaChanged();
  }

  save() {
    this.s.session.lastActivity = Date.now();
    this.doc.save();
  }

  /** Marks state as changed: persist + broadcast (coalesced). */
  touch() {
    this.save();
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.broadcastState();
    }, 30);
  }

  async close() {
    clearTimeout(this._flushTimer);
    clearTimeout(this._introTimer);
    await this.doc.flush();
  }

  // ---- identities -----------------------------------------------------------

  /** Validates a hello and returns the welcome payload (throws WsError to deny). */
  hello(client, msg) {
    const local = this.auth.trustsLocal(client.ip, { host: client.host, origin: client.origin });
    client.local = local;
    const role = msg.role;
    if (role === 'host') {
      if (!local && !this.auth.verify(msg.token, 'host')) {
        throw new WsError(this.auth.pinConfigured() ? 'Enter the host PIN' : 'Host controls are only available on the party computer (set a PIN in Settings to allow other devices)', 'pin');
      }
      client.deviceId = str(msg.deviceId, 40) || client.id;
      return { role: 'host', local, token: this.auth.sign('host', client.deviceId) };
    }
    if (role === 'tv') {
      client.deviceId = str(msg.deviceId, 40) || client.id;
      client.meta.display = msg.display === 'mirror' ? 'mirror' : 'main';
      client.meta.name = str(msg.name, 40);
      if (local || this.auth.verify(msg.token, 'tv')) return { role: 'tv', local };
      // remote display: needs approval from the host
      let code = [...this.pairing].find(([, id]) => id === client.id)?.[0];
      if (!code) {
        do { code = String(crypto.randomInt(1000, 10000)); } while (this.pairing.has(code));
        this.pairing.set(code, client.id);
      }
      setTimeout(() => this.touch(), 0);
      return { role: 'tvpending', pairCode: code };
    }
    if (role === 'guest') {
      if (String(msg.room || '').toUpperCase() !== this.settings.get('party.roomCode')) {
        throw new WsError('This party code is not valid any more. Scan the QR code on the TV again.', 'room');
      }
      if (!this.settings.get('party.guestsEnabled')) throw new WsError('Guest requests are switched off right now', 'closed');
      const deviceId = str(msg.deviceId, 40);
      if (!deviceId || deviceId.length < 8) throw new WsError('Missing device id', 'device');
      const prof = this.s.profiles[deviceId];
      if (prof?.banned) throw new WsError('You have been removed from this party', 'banned');
      client.deviceId = deviceId;
      if (msg.profile?.name) this.setProfile(deviceId, msg.profile);
      else if (prof) prof.lastSeen = Date.now();
      return { role: 'guest', deviceId, profile: this.publicProfile(deviceId) };
    }
    throw new WsError('Unknown role');
  }

  onJoin(client) {
    if (client.role === 'tv') {
      const main = this.mainClient();
      if (!main && client.meta.display !== 'mirror') this.mainDisplay = client.id;
      // the main display came back after a reload: continue where it stopped
      if (this.mainDisplay === client.id && this.displayLost && client.deviceId === this.displayLost.deviceId
        && Date.now() - this.displayLost.at < RELOAD_GRACE_MS && this.s.player.state === 'paused'
        && this.s.current?.id === this.displayLost.entryId) {
        this.s.player.state = 'playing';
      }
      if (this.mainDisplay === client.id) this.displayLost = null;
    }
    this.touch();
    this.sendState(client);
  }

  onLeave(client) {
    for (const [code, id] of this.pairing) if (id === client.id) this.pairing.delete(code);
    if (client.role === 'tv' && client.id === this.mainDisplay) {
      this.mainDisplay = null;
      const next = this.hub.byRole('tv').find((c) => c.meta.display !== 'mirror') || null;
      if (next) this.mainDisplay = next.id;
      const p = this.s.player;
      if (p.state === 'playing' || p.state === 'intro') {
        this.displayLost = { at: Date.now(), deviceId: client.deviceId, entryId: this.s.current?.id };
        if (p.state === 'playing') p.state = 'paused';
        this.toastHosts('The TV display disconnected — playback paused', 'error');
      }
    }
    this.touch();
  }

  mainClient() {
    return this.mainDisplay ? this.hub.clients.get(this.mainDisplay) || null : null;
  }

  setProfile(deviceId, { name, emoji, color } = {}) {
    const s = this.s;
    const clean = str(name, 24);
    if (!clean) throw err('Please enter your name');
    let prof = s.profiles[deviceId];
    if (!prof) {
      prof = { name: clean, emoji: '🎤', color: SINGER_COLORS[Object.keys(s.profiles).length % SINGER_COLORS.length], favorites: [], createdAt: Date.now(), singerId: null };
      s.profiles[deviceId] = prof;
    }
    prof.name = clean;
    if (SINGER_EMOJIS.includes(emoji) || (typeof emoji === 'string' && /^\p{Extended_Pictographic}/u.test(emoji) && emoji.length <= 8)) prof.emoji = emoji;
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) prof.color = color;
    prof.lastSeen = Date.now();
    // link to a singer: own one, or claim a host-created singer with the same name
    let singer = prof.singerId && s.singers.find((x) => x.id === prof.singerId);
    if (!singer) {
      singer = s.singers.find((x) => !x.deviceId && fold(x.name) === fold(clean));
      if (singer) singer.deviceId = deviceId;
    }
    if (!singer) singer = this.createSinger({ name: clean, emoji: prof.emoji, color: prof.color, deviceId });
    Object.assign(singer, { name: clean, emoji: prof.emoji, color: prof.color });
    prof.singerId = singer.id;
    this.touch();
    return prof;
  }

  publicProfile(deviceId) {
    const p = this.s.profiles[deviceId];
    if (!p) return null;
    return { name: p.name, emoji: p.emoji, color: p.color, singerId: p.singerId, favorites: p.favorites || [] };
  }

  createSinger({ name, emoji, color, deviceId = null }) {
    const s = this.s;
    const singer = {
      id: newId(),
      name: str(name, 24) || 'Singer',
      emoji: emoji || SINGER_EMOJIS[s.singers.length % SINGER_EMOJIS.length],
      color: color || SINGER_COLORS[s.singers.length % SINGER_COLORS.length],
      deviceId,
      createdAt: Date.now(),
      lastSangAt: 0,
      sung: 0,
      totalSung: 0,
    };
    s.singers.push(singer);
    return singer;
  }

  singer(id) { return this.s.singers.find((x) => x.id === id) || null; }

  hasSungTonight(singerId) {
    return (this.singer(singerId)?.sung || 0) > 0;
  }

  // ---- queue ----------------------------------------------------------------

  findEntry(entryId) {
    const q = this.s.queue.findIndex((e) => e.id === entryId);
    if (q >= 0) return { list: this.s.queue, index: q, entry: this.s.queue[q], where: 'queue' };
    const p = this.s.pending.findIndex((e) => e.id === entryId);
    if (p >= 0) return { list: this.s.pending, index: p, entry: this.s.pending[p], where: 'pending' };
    return null;
  }

  rateLimit(deviceId, kind, max, windowMs) {
    let l = this.limits.get(deviceId);
    if (!l) this.limits.set(deviceId, (l = {}));
    const now = Date.now();
    const list = (l[kind] || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { l[kind] = list; return false; }
    list.push(now);
    l[kind] = list;
    return true;
  }

  /** queue.add — from the host (any singer) or a guest (themselves). */
  addEntry(client, msg) {
    const s = this.s;
    const cat = this.catalog;
    const song = cat.song(msg.songId);
    if (!song) throw err('That song is not in the library');
    const isGuest = client.role === 'guest';
    let singerIds = [];
    if (isGuest) {
      const prof = s.profiles[client.deviceId];
      if (!prof?.singerId) throw err('Please enter your name first');
      if (prof.banned) throw err('You have been removed from this party');
      if (!this.settings.get('party.guestsEnabled')) throw err('Guest requests are switched off right now');
      singerIds = [prof.singerId];
      if (!this.rateLimit(client.deviceId, 'adds', 10, 60000)) throw err('Too many requests — try again in a minute');
      const q = this.settings.data.queue;
      if (q.explicitFilter && cat.isExplicit(song)) throw err('Explicit songs are not allowed tonight');
      if (q.maxDuration > 0 && song.duration > q.maxDuration) throw err(`Songs longer than ${Math.round(q.maxDuration / 60)} min are not allowed`);
      const mine = [...s.queue, ...s.pending].filter((e) => e.addedBy === client.deviceId).length;
      if (q.maxPerGuest > 0 && mine >= q.maxPerGuest) throw err(`You can have ${q.maxPerGuest} song${q.maxPerGuest > 1 ? 's' : ''} in the queue at a time`);
      if (!q.allowRepeats) {
        if (s.tonight.some((h) => h.songId === song.id) || s.current?.songId === song.id) throw err('This song has already been sung tonight');
        if ([...s.queue, ...s.pending].some((e) => e.songId === song.id)) throw err('This song is already in the queue');
      }
    } else {
      if (msg.singerId) {
        if (!this.singer(msg.singerId)) throw err('Unknown singer');
        singerIds = [msg.singerId];
      } else if (str(msg.singerName)) {
        const name = str(msg.singerName, 24);
        const existing = s.singers.find((x) => fold(x.name) === fold(name));
        singerIds = [(existing || this.createSinger({ name })).id];
      }
      for (const p of Array.isArray(msg.partners) ? msg.partners.slice(0, 3) : []) {
        if (this.singer(p) && !singerIds.includes(p)) singerIds.push(p);
      }
    }
    const track = (msg.trackId && song.trackIds.includes(msg.trackId) && cat.track(msg.trackId))
      || cat.track(s.songPrefs[song.key]?.trackId) || cat.bestTrack(song, this.settings.get('library.brandPriority') || []);
    if (!track) throw err('No playable version of this song');
    const pref = s.songPrefs[song.key]?.bySinger?.[singerIds[0]];
    const keyAllowed = !isGuest || this.settings.get('queue.guestKeyChange');
    const entry = {
      id: newId(),
      songId: song.id,
      trackId: track.id,
      title: song.title,
      artist: song.artist,
      dur: Math.round(track.duration || song.duration || 0),
      kind: track.kind === 'video' || (track.kind === 'zip' && track.entries?.video) ? 'video' : 'cdg',
      brand: track.p.brand || '',
      singerIds,
      addedBy: isGuest ? client.deviceId : 'host',
      addedAt: Date.now(),
      key: keyAllowed && msg.key !== undefined ? clampKey(msg.key) : clampKey(pref?.key || 0),
      tempo: !isGuest && msg.tempo !== undefined ? clampTempo(msg.tempo) : clampTempo(pref?.tempo || 1),
      source: isGuest ? 'guest' : 'host',
    };
    if (isGuest && this.settings.get('queue.requireApproval')) {
      entry.status = 'pending';
      s.pending.push(entry);
      this.toastHosts(`New request: ${song.title} — ${this.singerNames(entry)}`);
      this.touch();
      return { entryId: entry.id, pending: true };
    }
    const index = this.insert(entry, !isGuest ? msg.position : undefined);
    if (s.player.state === 'idle' && !s.current && this.settings.get('playback.autoAdvance') && msg.autostart !== false && s.queue.length === 1) {
      this.start(s.queue.shift());
      this.touch();
      return { entryId: entry.id, index: 0, started: true };
    }
    this.touch();
    return { entryId: entry.id, index, eta: this.etaOf(entry.id) };
  }

  insert(entry, position) {
    const s = this.s;
    entry.status = 'queued';
    let i;
    if (position === 'next') i = 0;
    else if (position === 'end') i = s.queue.length;
    else {
      i = insertIndex(s.queue, entry, {
        mode: this.settings.get('queue.mode'),
        newcomersFirst: this.settings.get('queue.newcomersFirst'),
        currentSingerId: s.current?.singerIds?.[0] || null,
        hasSung: (id) => this.hasSungTonight(id),
        minIndex: s.current && s.queue.length && this.notified.has(s.queue[0].id) ? 1 : 0,
      });
    }
    s.queue.splice(i, 0, entry);
    return i;
  }

  removeEntry(client, entryId) {
    const f = this.findEntry(entryId);
    if (!f) throw err('That song is no longer in the queue');
    if (client.role === 'guest') {
      if (f.entry.addedBy !== client.deviceId) throw err('You can only remove your own songs');
      if (!this.settings.get('queue.guestCanRemoveOwn')) throw err('Ask the host to remove it');
    }
    f.list.splice(f.index, 1);
    this.touch();
    return true;
  }

  moveEntry(entryId, index) {
    const f = this.findEntry(entryId);
    if (!f || f.where !== 'queue') throw err('Not in the queue');
    const q = this.s.queue;
    q.splice(f.index, 1);
    const i = Math.max(0, Math.min(q.length, Math.floor(Number(index) || 0)));
    q.splice(i, 0, f.entry);
    this.touch();
    return i;
  }

  updateEntry(entryId, patch = {}) {
    const f = this.findEntry(entryId);
    const entry = f?.entry || (this.s.current?.id === entryId ? this.s.current : null);
    if (!entry) throw err('Not in the queue');
    if (patch.key !== undefined) entry.key = clampKey(patch.key);
    if (patch.tempo !== undefined) entry.tempo = clampTempo(patch.tempo);
    if (Array.isArray(patch.singerIds)) entry.singerIds = patch.singerIds.filter((id) => this.singer(id)).slice(0, 4);
    if (patch.trackId && entry !== this.s.current) {
      const song = this.catalog.song(entry.songId);
      const t = song?.trackIds.includes(patch.trackId) && this.catalog.track(patch.trackId);
      if (t) Object.assign(entry, { trackId: t.id, brand: t.p.brand || '', dur: Math.round(t.duration || entry.dur) });
    }
    if (entry === this.s.current) {
      if (patch.key !== undefined) this.s.player.key = entry.key;
      if (patch.tempo !== undefined) this.s.player.tempo = entry.tempo;
    }
    this.touch();
    return true;
  }

  approve(entryId) {
    const i = this.s.pending.findIndex((e) => e.id === entryId);
    if (i < 0) throw err('Request not found');
    const [entry] = this.s.pending.splice(i, 1);
    this.insert(entry);
    if (this.s.player.state === 'idle' && !this.s.current && this.settings.get('playback.autoAdvance') && this.s.queue.length === 1) {
      this.start(this.s.queue.shift());
    }
    this.notifyDevice(entry.addedBy, { kind: 'approved', text: `✅ "${entry.title}" was added to the queue` });
    this.touch();
  }

  reject(entryId) {
    const i = this.s.pending.findIndex((e) => e.id === entryId);
    if (i < 0) throw err('Request not found');
    const [entry] = this.s.pending.splice(i, 1);
    this.notifyDevice(entry.addedBy, { kind: 'rejected', text: `"${entry.title}" was not accepted this time` });
    this.touch();
  }

  // ---- player state machine ------------------------------------------------

  start(entry) {
    const s = this.s;
    clearTimeout(this._introTimer);
    s.current = entry;
    entry.status = 'current';
    const countdown = Math.max(0, Number(this.settings.get('playback.countdown')) || 0);
    Object.assign(s.player, {
      entryId: entry.id,
      key: entry.key || 0,
      tempo: entry.tempo || 1,
      channel: CHANNEL_MODES.includes(this.settings.get('playback.defaultChannelMode')) ? this.settings.get('playback.defaultChannelMode') : 'stereo',
      position: 0,
      duration: entry.dur || 0,
      introEndsAt: Date.now() + countdown * 1000,
      state: 'intro',
      startedAt: 0,
    });
    this.displayLost = null;
    this._introTimer = setTimeout(() => this.endIntro(entry.id), countdown * 1000);
    this.notifySingers(entry, { kind: 'now', text: "🎤 It's your turn — grab the mic!" });
    this.touch();
  }

  endIntro(entryId) {
    const p = this.s.player;
    if (p.state !== 'intro' || p.entryId !== entryId) return;
    p.state = this.settings.get('playback.startPaused') ? 'paused' : 'playing';
    p.startedAt = Date.now();
    this.touch();
  }

  /** Ends the song on stage (history, stats) without starting the next one. */
  finish(reason = 'ended') {
    const s = this.s;
    const cur = s.current;
    if (!cur) return null;
    clearTimeout(this._introTimer);
    const p = s.player;
    const playedSec = Math.round(reason === 'ended' ? (p.duration || cur.dur) : p.position);
    const counted = reason === 'ended' || playedSec >= 45;
    const singers = cur.singerIds.map((id) => this.singer(id)).filter(Boolean);
    if (counted) {
      for (const sg of singers) {
        sg.sung = (sg.sung || 0) + 1;
        sg.totalSung = (sg.totalSung || 0) + 1;
        sg.lastSangAt = Date.now();
      }
      s.stats.plays[cur.songId] = (s.stats.plays[cur.songId] || 0) + 1;
      this.catalog.plays.set(cur.songId, s.stats.plays[cur.songId]);
      this.catalog.metaChanged();
      s.tonight.push({ entryId: cur.id, songId: cur.songId, title: cur.title, artist: cur.artist, singerIds: cur.singerIds, at: Date.now(), key: cur.key, tempo: cur.tempo });
      if (s.tonight.length > 500) s.tonight.splice(0, s.tonight.length - 500);
      const song = this.catalog.song(cur.songId);
      if (song && singers[0] && (cur.key || cur.tempo !== 1)) {
        const pref = s.songPrefs[song.key] || (s.songPrefs[song.key] = { bySinger: {} });
        pref.bySinger[singers[0].id] = { key: cur.key, tempo: cur.tempo };
      }
    }
    const line = {
      at: Date.now(), sessionId: s.session.id, songId: cur.songId, trackId: cur.trackId, artist: cur.artist, title: cur.title,
      singers: singers.map((x) => x.name), key: cur.key, tempo: cur.tempo, playedSec, skipped: reason !== 'ended', reason,
    };
    fsp.appendFile(this.historyFile, `${JSON.stringify(line)}\n`).catch((e) => this.log.warn('history write failed', e.message));
    s.current = null;
    this.notified.delete(cur.id);
    Object.assign(p, { state: 'idle', entryId: null, position: 0, duration: 0, introEndsAt: 0 });
    this.touch();
    return cur;
  }

  /** Starts the next queued song, or goes idle. */
  advance() {
    const s = this.s;
    if (s.queue.length) this.start(s.queue.shift());
    else this.touch();
  }

  playEntry(entryId) {
    const s = this.s;
    if (!entryId) {
      if (s.current) return this.resume();
      if (!s.queue.length) throw err('The queue is empty');
      this.start(s.queue.shift());
      return true;
    }
    const f = this.findEntry(entryId);
    if (!f) throw err('Not in the queue');
    f.list.splice(f.index, 1);
    if (s.current) this.finish('skipped');
    this.start(f.entry);
    return true;
  }

  pause() {
    const p = this.s.player;
    if (p.state === 'playing' || p.state === 'intro') {
      clearTimeout(this._introTimer);
      p.state = 'paused';
      this.touch();
    }
  }

  resume() {
    const p = this.s.player;
    if (!this.s.current) throw err('Nothing is playing');
    if (p.state === 'paused' || p.state === 'intro') {
      clearTimeout(this._introTimer);
      p.state = 'playing';
      if (!p.startedAt) p.startedAt = Date.now();
      this.displayLost = null;
      this.touch();
    }
  }

  next() {
    if (this.s.current) this.finish('skipped');
    this.advance();
  }

  stop() {
    this.finish('stopped');
  }

  seek(pos) {
    const p = this.s.player;
    if (!this.s.current) throw err('Nothing is playing');
    const max = p.duration || this.s.current.dur || 0;
    p.seekPos = Math.max(0, Math.min(Number(pos) || 0, Math.max(0, max - 1)));
    p.seekSeq = (p.seekSeq || 0) + 1;
    p.position = p.seekPos;
    this.touch();
  }

  setKey(msg) {
    const p = this.s.player;
    const k = clampKey(msg.delta !== undefined ? (p.key || 0) + Number(msg.delta) : msg.semitones);
    p.key = k;
    if (this.s.current) this.s.current.key = k;
    this.touch();
    return k;
  }

  setTempo(msg) {
    const p = this.s.player;
    const t = clampTempo(msg.delta !== undefined ? (p.tempo || 1) + Number(msg.delta) : msg.rate);
    p.tempo = t;
    if (this.s.current) this.s.current.tempo = t;
    this.touch();
    return t;
  }

  // ---- display reports -----------------------------------------------------

  tvStatus(client, msg) {
    if (client.id !== this.mainDisplay) return;
    const p = this.s.player;
    if (!this.s.current || msg.entryId !== this.s.current.id) return;
    p.position = Math.max(0, Number(msg.pos) || 0);
    if (msg.dur > 0) p.duration = Number(msg.dur);
    const now = Date.now();
    const time = { t: 'time', entryId: msg.entryId, pos: p.position, dur: p.duration, playing: !!msg.playing, at: now };
    this.hub.broadcast(time, (c) => c.role === 'host' || (c.role === 'tv' && c.id !== client.id));
    if (now - this._lastGuestTime > 1000) {
      this._lastGuestTime = now;
      this.hub.broadcast(time, (c) => c.role === 'guest');
    }
    this.maybeNotifyNext();
  }

  tvEnded(client, msg) {
    if (client.id !== this.mainDisplay || msg.entryId !== this.s.current?.id) return;
    this.finish('ended');
    if (this.settings.get('playback.autoAdvance')) this.advance();
  }

  tvError(client, msg) {
    if (client.id !== this.mainDisplay || msg.entryId !== this.s.current?.id) return;
    const cur = this.s.current;
    this.toastHosts(`Could not play "${cur.title}": ${str(msg.error, 160) || 'unknown error'}`, 'error');
    this.finish('error');
    if (this.settings.get('playback.autoAdvance')) this.advance();
  }

  maybeNotifyNext() {
    const s = this.s;
    const next = s.queue[0];
    if (!next || !s.current || this.notified.has(next.id)) return;
    const p = s.player;
    const remaining = (p.duration || s.current.dur || 0) - (p.position || 0);
    if (p.state === 'playing' && remaining > 75) return;
    this.notified.add(next.id);
    this.notifySingers(next, { kind: 'next', text: "⏭️ You're up next — get ready!" });
  }

  // ---- notifications -------------------------------------------------------

  notifyDevice(deviceId, payload) {
    if (!deviceId || deviceId === 'host') return;
    this.hub.broadcast({ t: 'notify', ...payload }, (c) => c.role === 'guest' && c.deviceId === deviceId);
  }

  notifySingers(entry, payload) {
    const devices = new Set(entry.singerIds.map((id) => this.singer(id)?.deviceId).filter(Boolean));
    for (const d of devices) this.notifyDevice(d, { ...payload, entryId: entry.id, title: entry.title });
  }

  toastHosts(text, level = 'info') {
    this.hub.broadcast({ t: 'toast', text, level }, (c) => c.role === 'host');
  }

  // ---- misc actions -------------------------------------------------------

  reaction(client, msg) {
    if (!this.settings.get('guests.reactions') && client.role === 'guest') return false;
    const emoji = REACTIONS.includes(msg.emoji) ? msg.emoji : null;
    if (!emoji) return false;
    if (!this.rateLimit(client.deviceId || client.id, 'reactions', 4, 2000)) return false;
    const prof = client.role === 'guest' ? this.s.profiles[client.deviceId] : null;
    this.hub.broadcast({ t: 'reaction', emoji, name: prof?.name || 'Host', color: prof?.color || '#ffffff' }, (c) => c.role === 'tv' || c.role === 'host');
    return true;
  }

  setAnnouncement(text, seconds = 10) {
    const t = str(text, 200);
    this.announce = t ? { text: t, until: Date.now() + Math.max(2, Math.min(120, Number(seconds) || 10)) * 1000 } : null;
    this.touch();
  }

  newParty({ silent = false } = {}) {
    const s = this.s;
    clearTimeout(this._introTimer);
    s.session = { id: newId(), startedAt: Date.now(), lastActivity: Date.now() };
    s.queue = [];
    s.pending = [];
    s.current = null;
    s.tonight = [];
    s.singers = s.singers.filter((x) => x.deviceId);
    for (const x of s.singers) x.sung = 0;
    Object.assign(s.player, { state: 'idle', entryId: null, position: 0, introEndsAt: 0 });
    this.notified.clear();
    if (!silent) this.touch();
  }

  async updateSettings(patch) {
    const before = { pin: this.settings.get('party.adminPin'), paths: JSON.stringify(this.library.paths) };
    const p = patch && typeof patch === 'object' ? structuredClone(patch) : {};
    if (p.party && 'roomCode' in p.party) {
      const c = String(p.party.roomCode || '').toUpperCase();
      if (/^[A-Z]{4}$/.test(c)) p.party.roomCode = c;
      else delete p.party.roomCode;
    }
    const paths = p.library?.paths;
    if (p.library) delete p.library.paths;
    const applied = this.settings.update(p);
    if (Array.isArray(paths) && JSON.stringify(paths) !== before.paths) {
      await this.library.setPaths(paths);
      applied.library = { ...(applied.library || {}), paths: this.library.paths };
    }
    if (this.settings.get('party.adminPin') !== before.pin) await this.auth.rotate();
    this.touch();
    return applied;
  }

  newRoomCode() {
    this.settings.update({ party: { roomCode: makeRoomCode() } });
    this.touch();
    return this.settings.get('party.roomCode');
  }

  approveDisplay(code) {
    const clientId = this.pairing.get(String(code));
    const client = clientId && this.hub.clients.get(clientId);
    if (!client) throw err('No display is waiting with that code');
    this.pairing.delete(String(code));
    client.send({ t: 'paired', token: this.auth.sign('tv', client.deviceId) });
    this.touch();
  }

  makeMain(clientId) {
    const c = this.hub.clients.get(clientId);
    if (!c || c.role !== 'tv') throw err('Display not found');
    if (this.mainDisplay === clientId) return;
    const wasPlaying = this.s.player.state === 'playing';
    if (wasPlaying) this.s.player.state = 'paused';
    this.mainDisplay = clientId;
    c.meta.display = 'main';
    this.touch();
  }

  kick(deviceId, { ban = false } = {}) {
    const prof = this.s.profiles[deviceId];
    if (!prof) throw err('Guest not found');
    if (ban) {
      prof.banned = true;
      this.s.queue = this.s.queue.filter((e) => e.addedBy !== deviceId);
      this.s.pending = this.s.pending.filter((e) => e.addedBy !== deviceId);
    }
    for (const c of this.hub.byRole('guest')) {
      if (c.deviceId !== deviceId) continue;
      c.send({ t: 'denied', reason: ban ? 'You have been removed from this party' : 'The host disconnected you', code: ban ? 'banned' : 'kicked' });
      setTimeout(() => c.ws.close(4003, 'kicked'), 100);
    }
    this.touch();
  }

  unban(deviceId) {
    const prof = this.s.profiles[deviceId];
    if (prof) prof.banned = false;
    this.touch();
  }

  toggleFavorite(client, songId) {
    if (!this.catalog.song(songId)) throw err('Unknown song');
    let list = this.s.hostFavorites;
    if (client.role === 'guest') {
      const prof = this.s.profiles[client.deviceId];
      if (!prof) throw err('Please enter your name first');
      list = prof.favorites || (prof.favorites = []);
    }
    const i = list.indexOf(songId);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(songId);
    if (list.length > 500) list.length = 500;
    this.touch();
    return i < 0;
  }

  // ---- views ---------------------------------------------------------------

  singerNames(entry) {
    return entry.singerIds.map((id) => this.singer(id)?.name).filter(Boolean).join(' & ') || '—';
  }

  singerView(id) {
    const x = this.singer(id);
    return x ? { id: x.id, name: x.name, emoji: x.emoji, color: x.color } : null;
  }

  entryView(e, eta) {
    if (!e) return null;
    const v = {
      id: e.id, songId: e.songId, trackId: e.trackId, title: e.title, artist: e.artist, dur: e.dur, kind: e.kind,
      brand: e.brand, key: e.key, tempo: e.tempo, addedAt: e.addedAt, source: e.source, status: e.status,
      singers: e.singerIds.map((id) => this.singerView(id)).filter(Boolean),
      singerIds: e.singerIds,
    };
    if (eta !== undefined) v.eta = eta;
    return v;
  }

  currentRemaining() {
    const s = this.s;
    const p = s.player;
    if (!s.current) return 0;
    const intro = p.state === 'intro' ? Math.max(0, (p.introEndsAt - Date.now()) / 1000) : 0;
    const dur = p.duration || s.current.dur || 0;
    return intro + Math.max(0, dur - (p.position || 0)) / (p.tempo || 1);
  }

  etaList() {
    return etas(this.s.queue, { currentRemaining: this.currentRemaining(), countdown: this.settings.get('playback.countdown'), gap: 5 });
  }

  etaOf(entryId) {
    const i = this.s.queue.findIndex((e) => e.id === entryId);
    return i < 0 ? null : this.etaList()[i];
  }

  playerView() {
    const p = this.s.player;
    return { ...p, now: Date.now(), displayLost: !!this.displayLost };
  }

  mediaFor(entry) {
    if (!entry) return null;
    const t = this.catalog.track(entry.trackId);
    const kind = t ? (t.kind === 'video' || (t.kind === 'zip' && t.entries?.video) ? 'video' : 'cdg') : entry.kind;
    return { kind, ...mediaUrls(entry.trackId, kind) };
  }

  onlineDevices() {
    const set = new Set();
    for (const c of this.hub.clients.values()) if (c.role === 'guest') set.add(c.deviceId);
    return set;
  }

  hostView() {
    const s = this.s;
    const info = this.app.info();
    const online = this.onlineDevices();
    const eta = this.etaList();
    const queuedBySinger = new Map();
    for (const e of s.queue) for (const id of e.singerIds) queuedBySinger.set(id, (queuedBySinger.get(id) || 0) + 1);
    const guests = Object.entries(s.profiles)
      .map(([deviceId, p]) => ({ deviceId, name: p.name, emoji: p.emoji, color: p.color, online: online.has(deviceId), banned: !!p.banned, lastSeen: p.lastSeen || 0, singerId: p.singerId }))
      .sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen))
      .slice(0, 300);
    const deviceOf = new Map(Object.entries(s.profiles).map(([d, p]) => [p.singerId, d]));
    return {
      t: 'state',
      role: 'host',
      party: { name: this.settings.get('party.name'), roomCode: info.roomCode, joinUrl: info.joinUrl, lanUrls: info.lanUrls, localUrl: info.localUrl, pinSet: info.pinSet, sessionStartedAt: s.session.startedAt },
      player: this.playerView(),
      current: this.entryView(s.current),
      queue: s.queue.map((e, i) => ({ ...this.entryView(e, eta[i]), addedByName: e.addedBy === 'host' ? 'Host' : s.profiles[e.addedBy]?.name || 'Guest' })),
      pending: s.pending.map((e) => ({ ...this.entryView(e), addedByName: s.profiles[e.addedBy]?.name || 'Guest' })),
      singers: s.singers.map((x) => ({
        id: x.id, name: x.name, emoji: x.emoji, color: x.color, sung: x.sung, totalSung: x.totalSung, lastSangAt: x.lastSangAt,
        guest: !!x.deviceId, online: !!x.deviceId && online.has(x.deviceId), queued: queuedBySinger.get(x.id) || 0,
        deviceId: x.deviceId || deviceOf.get(x.id) || null,
      })),
      guests,
      displays: this.hub.byRole('tv').map((c) => ({ clientId: c.id, deviceId: c.deviceId, main: c.id === this.mainDisplay, local: !!c.local, name: c.meta.name || '', mirror: c.meta.display === 'mirror' })),
      pendingDisplays: [...this.pairing.keys()].map((code) => ({ code })),
      library: summaryStatus(this.library.status()),
      settings: this.settings.data,
      tonight: s.tonight.slice(-100).reverse().map((h) => ({ ...h, singers: h.singerIds.map((id) => this.singerView(id)).filter(Boolean) })),
      favorites: s.hostFavorites,
      announce: this.announce && this.announce.until > Date.now() ? this.announce : null,
    };
  }

  tvView(client) {
    const s = this.s;
    const info = this.app.info();
    const eta = this.etaList();
    return {
      t: 'state',
      role: 'tv',
      main: client?.id === this.mainDisplay,
      party: { name: this.settings.get('party.name'), roomCode: info.roomCode, joinUrl: info.joinUrl },
      display: this.settings.get('display'),
      playback: {
        countdown: this.settings.get('playback.countdown'),
        lyricOffsetMs: this.settings.get('playback.lyricOffsetMs'),
        normalize: this.settings.get('playback.normalize'),
        fadeSeconds: this.settings.get('playback.fadeSeconds'),
      },
      wifi: this.settings.get('party.wifi.show') ? this.settings.get('party.wifi') : null,
      player: this.playerView(),
      current: s.current ? { ...this.entryView(s.current), media: this.mediaFor(s.current) } : null,
      next: s.queue.slice(0, 10).map((e, i) => ({ ...this.entryView(e, eta[i]), media: i === 0 ? this.mediaFor(e) : undefined })),
      queueLength: s.queue.length,
      library: { state: this.library.status().state, songs: this.catalog.songs.size },
      guests: this.onlineDevices().size,
      announce: this.announce && this.announce.until > Date.now() ? this.announce : null,
    };
  }

  guestShared() {
    const s = this.s;
    const q = this.settings.data.queue;
    const eta = this.etaList();
    const cur = s.current;
    return {
      party: { name: this.settings.get('party.name'), roomCode: this.settings.get('party.roomCode') },
      rules: {
        maxPerGuest: q.maxPerGuest, maxDuration: q.maxDuration, requireApproval: q.requireApproval,
        guestCanRemoveOwn: q.guestCanRemoveOwn, guestsSeeQueue: q.guestsSeeQueue, guestKeyChange: q.guestKeyChange,
        explicitFilter: q.explicitFilter, allowRepeats: q.allowRepeats, reactions: this.settings.get('guests.reactions'),
      },
      player: { state: s.player.state, entryId: s.player.entryId, key: s.player.key, tempo: s.player.tempo, position: s.player.position, duration: s.player.duration, introEndsAt: s.player.introEndsAt, now: Date.now() },
      current: cur ? { id: cur.id, songId: cur.songId, title: cur.title, artist: cur.artist, dur: cur.dur, singers: cur.singerIds.map((id) => this.singerView(id)).filter(Boolean), singerIds: cur.singerIds } : null,
      queue: s.queue.map((e, i) => ({
        id: e.id, songId: e.songId, title: e.title, artist: e.artist, dur: e.dur, eta: eta[i], key: e.key,
        singers: e.singerIds.map((id) => this.singerView(id)).filter(Boolean), singerIds: e.singerIds, by: e.addedBy,
      })),
      library: { state: this.library.status().state, songs: this.catalog.songs.size },
      tonight: s.tonight.slice(-30).reverse().map((h) => ({ songId: h.songId, title: h.title, artist: h.artist, singers: h.singerIds.map((id) => this.singerView(id)).filter(Boolean), at: h.at })),
    };
  }

  guestView(client, shared = this.guestShared()) {
    const s = this.s;
    const deviceId = client.deviceId;
    const prof = this.publicProfile(deviceId);
    const q = shared.queue;
    const mine = q.filter((e) => e.by === deviceId || (prof?.singerId && e.singerIds.includes(prof.singerId)));
    const pending = s.pending.filter((e) => e.addedBy === deviceId).map((e) => ({ id: e.id, songId: e.songId, title: e.title, artist: e.artist, status: 'pending' }));
    const visibleQueue = shared.rules.guestsSeeQueue ? q : mine;
    return {
      t: 'state',
      role: 'guest',
      ...shared,
      queue: visibleQueue.map((e) => ({ ...e, by: undefined, mine: e.by === deviceId || (!!prof?.singerId && e.singerIds.includes(prof.singerId)), canRemove: e.by === deviceId && shared.rules.guestCanRemoveOwn })),
      me: {
        deviceId,
        profile: prof,
        entries: [...mine.map((e) => ({ id: e.id, songId: e.songId, title: e.title, artist: e.artist, eta: e.eta, position: q.indexOf(e) + 1, status: 'queued' })), ...pending],
        onStage: !!(s.current && prof?.singerId && s.current.singerIds.includes(prof.singerId)),
        upNext: !!(q[0] && prof?.singerId && q[0].singerIds.includes(prof.singerId)),
        sung: this.singer(prof?.singerId)?.sung || 0,
      },
    };
  }

  sendState(client) {
    if (client.role === 'host') client.send(this.hostView());
    else if (client.role === 'tv') client.send(this.tvView(client));
    else if (client.role === 'guest') client.send(this.guestView(client));
    else if (client.role === 'tvpending') {
      const code = [...this.pairing].find(([, id]) => id === client.id)?.[0];
      client.send({ t: 'state', role: 'tvpending', pairCode: code, party: { name: this.settings.get('party.name') } });
    }
  }

  broadcastState() {
    let host = null;
    let shared = null;
    for (const c of this.hub.clients.values()) {
      if (!c.role) continue;
      if (c.role === 'host') c.send(host || (host = JSON.stringify(this.hostView())));
      else if (c.role === 'guest') c.send(this.guestView(c, shared || (shared = this.guestShared())));
      else this.sendState(c);
    }
    this.maybeNotifyNext();
  }

  /** Extra per-song fields for API results. */
  decorate(song) {
    const s = this.s;
    const out = {};
    if (s.tonight.some((h) => h.songId === song.id)) out.sung = 1;
    if (s.queue.some((e) => e.songId === song.id) || s.current?.songId === song.id) out.q = 1;
    return Object.keys(out).length ? out : undefined;
  }

  // ---- message handlers ----------------------------------------------------

  registerHandlers() {
    const hub = this.hub;
    const H = ['host'];
    const HG = ['host', 'guest'];
    const hostOrLocalTv = (fn) => (client, msg) => {
      if (client.role === 'tv' && !client.local) throw err('Not allowed');
      return fn(client, msg);
    };
    const HT = ['host', 'tv'];

    hub.handle('queue.add', (c, m) => this.addEntry(c, m), { roles: HG });
    hub.handle('queue.remove', (c, m) => this.removeEntry(c, m.entryId), { roles: HG });
    hub.handle('queue.move', (c, m) => this.moveEntry(m.entryId, m.index), { roles: H });
    hub.handle('queue.update', (c, m) => this.updateEntry(m.entryId, m.patch), { roles: H });
    hub.handle('queue.approve', (c, m) => this.approve(m.entryId), { roles: H });
    hub.handle('queue.reject', (c, m) => this.reject(m.entryId), { roles: H });
    hub.handle('queue.clear', () => { this.s.queue = []; this.touch(); }, { roles: H });
    hub.handle('queue.shuffle', () => {
      this.s.queue = shuffleFair(this.s.queue, this.s.current?.singerIds?.[0] || null);
      this.touch();
    }, { roles: H });

    hub.handle('player.play', hostOrLocalTv((c, m) => this.playEntry(m.entryId)), { roles: HT });
    hub.handle('player.pause', hostOrLocalTv(() => this.pause()), { roles: HT });
    hub.handle('player.resume', hostOrLocalTv(() => this.resume()), { roles: HT });
    hub.handle('player.toggle', hostOrLocalTv(() => {
      const st = this.s.player.state;
      if (st === 'playing' || st === 'intro') this.pause();
      else if (this.s.current) this.resume();
      else this.playEntry();
    }), { roles: HT });
    hub.handle('player.next', hostOrLocalTv(() => this.next()), { roles: HT });
    hub.handle('player.stop', hostOrLocalTv(() => this.stop()), { roles: HT });
    hub.handle('player.restart', hostOrLocalTv(() => this.seek(0)), { roles: HT });
    hub.handle('player.seek', hostOrLocalTv((c, m) => this.seek(m.pos)), { roles: HT });
    hub.handle('player.key', hostOrLocalTv((c, m) => this.setKey(m)), { roles: HT });
    hub.handle('player.tempo', hostOrLocalTv((c, m) => this.setTempo(m)), { roles: HT });
    hub.handle('player.channel', (c, m) => {
      if (!CHANNEL_MODES.includes(m.mode)) throw err('Unknown channel mode');
      this.s.player.channel = m.mode;
      this.touch();
    }, { roles: H });
    hub.handle('player.volume', hostOrLocalTv((c, m) => {
      const v = Math.max(0, Math.min(1, m.delta !== undefined ? this.s.player.volume + Number(m.delta) : Number(m.v)));
      if (!Number.isFinite(v)) throw err('Bad volume');
      this.s.player.volume = Math.round(v * 100) / 100;
      this.touch();
      return this.s.player.volume;
    }), { roles: HT });
    hub.handle('player.skipIntro', () => this.endIntro(this.s.player.entryId), { roles: H });

    hub.handle('singer.add', (c, m) => {
      const name = str(m.name, 24);
      if (!name) throw err('Enter a name');
      if (this.s.singers.some((x) => fold(x.name) === fold(name))) throw err('There is already a singer with that name');
      const sg = this.createSinger({ name, emoji: m.emoji, color: m.color });
      this.touch();
      return { singerId: sg.id };
    }, { roles: H });
    hub.handle('singer.update', (c, m) => {
      const sg = this.singer(m.singerId);
      if (!sg) throw err('Unknown singer');
      const p = m.patch || {};
      if (p.name !== undefined && str(p.name, 24)) sg.name = str(p.name, 24);
      if (typeof p.emoji === 'string' && p.emoji.length <= 8) sg.emoji = p.emoji;
      if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) sg.color = p.color;
      this.touch();
    }, { roles: H });
    hub.handle('singer.remove', (c, m) => {
      const s = this.s;
      const i = s.singers.findIndex((x) => x.id === m.singerId);
      if (i < 0) throw err('Unknown singer');
      s.queue = s.queue.filter((e) => e.singerIds[0] !== m.singerId);
      for (const e of s.queue) e.singerIds = e.singerIds.filter((id) => id !== m.singerId);
      const [sg] = s.singers.splice(i, 1);
      if (sg.deviceId && s.profiles[sg.deviceId]) s.profiles[sg.deviceId].singerId = null;
      this.touch();
    }, { roles: H });

    hub.handle('guest.update', (c, m) => {
      this.setProfile(c.deviceId, m.profile || m);
      return this.publicProfile(c.deviceId);
    }, { roles: ['guest'] });
    hub.handle('guest.kick', (c, m) => this.kick(m.deviceId), { roles: H });
    hub.handle('guest.ban', (c, m) => (m.banned === false ? this.unban(m.deviceId) : this.kick(m.deviceId, { ban: true })), { roles: H });

    hub.handle('favorite.toggle', (c, m) => this.toggleFavorite(c, m.songId), { roles: HG });
    hub.handle('reaction', (c, m) => this.reaction(c, m), { roles: HG });
    hub.handle('announce', (c, m) => this.setAnnouncement(m.text, m.seconds), { roles: H });
    hub.handle('party.new', () => this.newParty(), { roles: H });
    hub.handle('party.newCode', () => this.newRoomCode(), { roles: H });
    hub.handle('settings.update', (c, m) => this.updateSettings(m.patch), { roles: H });
    hub.handle('library.rescan', () => { this.library.scan({ reason: 'host' }).catch(() => {}); return true; }, { roles: H });
    hub.handle('display.approve', (c, m) => this.approveDisplay(m.code), { roles: H });
    hub.handle('display.makeMain', (c, m) => this.makeMain(m.clientId), { roles: H });

    hub.handle('tv.status', (c, m) => this.tvStatus(c, m), { roles: ['tv'] });
    hub.handle('tv.ended', (c, m) => this.tvEnded(c, m), { roles: ['tv'] });
    hub.handle('tv.error', (c, m) => this.tvError(c, m), { roles: ['tv'] });
    hub.handle('history.list', async (c, m) => this.readHistory(Number(m.limit) || 200), { roles: H });
  }

  async readHistory(limit = 200) {
    try {
      const text = await fsp.readFile(this.historyFile, 'utf8');
      return text.trim().split('\n').slice(-Math.min(2000, limit)).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }
}
