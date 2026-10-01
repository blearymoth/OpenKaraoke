// Break music (PLAN §2 "Between songs"): while nobody sings, the main TV plays quiet
// background music — backing tracks from the karaoke library (matching the next song's
// genre/decade when that's known) or songs from a music folder — with fades around each song.
// Also "autoplay": when the queue stays empty, a popular sing-along for everyone is queued.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { shortId } from '../../shared/text.js';
import { AUDIO_EXTS } from '../library/parse.js';
import { mediaSource } from '../http/media.js';
import { logger } from '../util/log.js';

const log = logger('break');
const FOLDER_RESCAN_MS = 10 * 60_000;
const MAX_FOLDER_FILES = 5000; // kept per scan (a random sample of a bigger folder: each rescan draws anew)
const MAX_FOLDER_SEEN = 200_000; // audio files looked at, at most
const MAX_FOLDER_DIRS = 20_000; // folders read, at most
const RECENT = 30; // tracks not repeated soon
const CANDIDATES = 6; // songs drawn per try: some may have no audio on a connected drive
const RETRY_MS = 60_000; // nothing playable: look again after this (sooner when the library or settings change)
const QUICK_END_MS = 3000; // a track "over" this soon after it was picked did not play (older TV pages don't say)
const FAIL_WINDOW_MS = 2 * 60_000;
const MAX_FAILS = 3; // this many unplayable tracks within FAIL_WINDOW_MS…
const REST_MS = 60_000; // …and break music rests this long (no request/broadcast loop through a dead drive)

export class BreakMusic {
  constructor(room) {
    this.room = room;
    this.track = null; // { id, url, title, artist, source, songId? (library), abs? (folder), at, with }
    this.recent = []; // ids played lately (not repeated soon)
    this.folder = { dir: '', at: 0, files: [], scanning: null };
    this.nothing = null; // { key, until }: the last pick found nothing playable (not searched again on every broadcast)
    this.fails = []; // when the TV reported tracks it couldn't play
    this.restUntil = 0; // after several unplayable tracks: silence until then
    this.restTimer = null;
    this.autoplayTimer = null;
  }

  get settings() {
    return this.room.settings;
  }

  cfg() {
    return this.settings.get('playback.breakMusic') || {};
  }

  /** Break music volume, 0–1 (0 is silence, not the default). */
  volume() {
    const v = Number(this.cfg().volume);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.35;
  }

  /** The settings a pick depends on: a new volume only fades the track that is on. */
  pickSettings() {
    const c = this.cfg();
    return c.source === 'folder' ? `folder:${c.folder || ''}` : `library:${c.matchNext !== false}`;
  }

  /** Should the TV play break music right now? */
  wanted() {
    const room = this.room;
    const p = room.s.player;
    if (!this.cfg().enabled || this.volume() <= 0 || room.gameBlocks()) return false;
    return !room.s.current || p.state === 'intro' || p.state === 'ready' || p.state === 'idle';
  }

  /** What the TV gets: the track to play (or null = fade out and stop). */
  view() {
    if (!this.wanted() || this.restUntil > Date.now()) {
      // The music stops (someone sings, a game takes the TV…): the next break gets a fresh
      // track that suits the song coming up, instead of the same intro all night.
      this.track = null;
      return null;
    }
    // A new pick: none yet, the settings it was picked with changed, or a guest asked for the
    // backing track that was playing (not as music to its own countdown).
    const t = this.track;
    if (!t || t.with !== this.pickSettings() || (t.songId && t.songId === this.room.s.current?.songId)) this.pick();
    if (!this.track) return null;
    return { id: this.track.id, url: this.track.url, title: this.track.title, artist: this.track.artist, volume: this.volume() };
  }

  /** Picks the next track (library or folder); keeps the last few from repeating. */
  pick() {
    const cfg = this.cfg();
    const key = this.pickKey();
    if (this.nothing?.key === key && Date.now() < this.nothing.until) return (this.track = null);
    const next = cfg.source === 'folder' ? this.pickFolder(cfg.folder) : this.pickLibrary(cfg.matchNext !== false);
    this.track = next && { ...next, at: Date.now(), with: this.pickSettings() };
    this.nothing = next ? null : { key, until: Date.now() + RETRY_MS };
    if (next) {
      this.recent.push(next.id);
      if (this.recent.length > RECENT) this.recent.shift();
    }
    return this.track;
  }

  /** What a pick that found nothing depends on: settings, catalog, which library drives are connected, the folder scan. */
  pickKey() {
    return `${this.pickSettings()}|${this.room.catalog.version}|${this.room.library.rootsOnline.join()}|${this.folder.at}`;
  }

  pickLibrary(matchNext) {
    const { catalog, library, s } = this.room;
    if (!library.rootsOnline.some(Boolean)) return null; // the karaoke drive isn't connected
    // The song coming up: the one in its intro (break music plays during the countdown), else
    // the head of the queue. Neither it nor the songs queued after it are played as break music.
    const upNext = s.current || s.queue[0];
    const exclude = new Set(this.recent.map((id) => id.replace(/^lib:/, '')));
    if (s.current) exclude.add(s.current.songId);
    for (const e of s.queue.slice(0, 10)) exclude.add(e.songId);
    const filter = { exclude, minDuration: 20, maxDuration: 480, noExplicit: true };
    // Match the mood of the next song when its genre/decade is known.
    const nextSong = matchNext && upNext ? catalog.song(upNext.songId) : null;
    const meta = nextSong && catalog.metaFor(nextSong.key);
    const tries = [];
    if (meta?.genre && meta?.year) tries.push({ ...filter, genre: meta.genre, decade: Math.floor(meta.year / 10) * 10 });
    if (meta?.genre) tries.push({ ...filter, genre: meta.genre });
    tries.push(filter);
    for (const f of tries) {
      for (const song of catalog.random(CANDIDATES, f, { popularBias: 0.8 })) {
        const track = this.room.pickTrack(song, { noExplicit: true });
        // An audio file (not a video) on a drive that is connected: the TV can play it.
        if (!track || !mediaSource(track, 'audio') || !library.isTrackOnline(track)) continue;
        return { id: `lib:${song.id}`, url: `/media/${track.id}/audio`, title: song.title, artist: song.artist, source: 'library', songId: song.id };
      }
    }
    return null;
  }

  pickFolder(dir) {
    if (!dir) return null;
    this.refreshFolder(dir);
    const files = this.folder.files.filter((f) => !this.recent.includes(f.id));
    const pool = files.length ? files : this.folder.files;
    if (!pool.length) return null;
    const f = pool[Math.floor(Math.random() * pool.length)];
    return { id: f.id, url: `/media/break/${f.id}`, title: f.title, artist: f.artist, source: 'folder', abs: f.abs };
  }

  /** Scans the music folder in the background (at most every 10 minutes). */
  refreshFolder(dir) {
    const abs = path.resolve(dir);
    const f = this.folder;
    if (f.scanning || (f.dir === abs && Date.now() - f.at < FOLDER_RESCAN_MS)) return f.scanning;
    f.scanning = scanAudioFolder(abs)
      .then((files) => {
        Object.assign(f, { dir: abs, at: Date.now(), files });
        if (files.length) log.info(`${files.length} break music files in ${abs}`);
        else log.warn(`no audio files in the break music folder ${abs}`);
        if (!this.track) this.room.markDirty();
      })
      .catch((e) => {
        Object.assign(f, { dir: abs, at: Date.now(), files: [] });
        log.warn(`cannot read the break music folder ${abs}: ${e.message}`);
      })
      .finally(() => { f.scanning = null; });
    return f.scanning;
  }

  /**
   * Absolute path of a folder track by id: only files found by the scan are served (and the one
   * playing, which a rescan's new sample may have left out while the TV still streams it).
   */
  folderFile(id) {
    if (this.track?.source === 'folder' && this.track.id === id) return this.track.abs;
    return this.folder.files.find((x) => x.id === id)?.abs || null;
  }

  /**
   * The TV finished `id`, or couldn't play it (`error`: unplugged drive, unknown format…): the
   * next one. Several unplayable tracks in a short while and break music rests for a minute.
   */
  ended(id, { error = false } = {}) {
    const t = this.track;
    if (!t || t.id !== id) return;
    const now = Date.now();
    if (error || now - t.at < QUICK_END_MS) {
      this.fails = this.fails.filter((at) => now - at < FAIL_WINDOW_MS);
      this.fails.push(now);
      if (this.fails.length >= MAX_FAILS) return this.rest();
    }
    this.pick();
  }

  rest() {
    log.warn(`${this.fails.length} break music tracks could not be played: trying again in ${REST_MS / 1000} s`);
    this.track = null;
    this.fails = [];
    this.restUntil = Date.now() + REST_MS;
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      this.restUntil = 0;
      this.room.markDirty();
    }, REST_MS);
    this.restTimer.unref?.();
  }

  skip() {
    this.pick();
    return { track: this.track ? { title: this.track.title, artist: this.track.artist } : null };
  }

  /** The host changed break-music settings (`changed`: the ones they sent). */
  settingsChanged(changed = {}) {
    if (Object.hasOwn(changed, 'source') || Object.hasOwn(changed, 'folder')) this.folder.at = 0; // (scan it again)
    this.nothing = null; // (the host may just have fixed what was wrong: try again straight away)
    this.fails = [];
    this.restUntil = 0;
    clearTimeout(this.restTimer);
    this.restTimer = null;
  }

  /**
   * "When the queue is empty: autoplay": after `playback.autoplayAfter` idle seconds with an
   * empty queue and a TV on, queue a popular song for everyone to sing along. A game that
   * takes over the TV (running, or its results still up) holds it back; one that runs
   * alongside the karaoke (pass the mic) doesn't.
   */
  checkAutoplay() {
    const room = this.room;
    const gameOnTv = () => !!room.game?.constructor.exclusive;
    const idle = !room.s.current && !room.s.queue.length && !gameOnTv() && room.mainDisplay() && !room.s.player.hold;
    if (!idle || room.settings.get('playback.whenQueueEmpty') !== 'autoplay') {
      clearTimeout(this.autoplayTimer);
      this.autoplayTimer = null;
      return;
    }
    if (this.autoplayTimer) return;
    const wait = Math.max(5, Number(room.settings.get('playback.autoplayAfter')) || 45) * 1000;
    this.autoplayTimer = setTimeout(() => {
      this.autoplayTimer = null;
      if (room.s.current || room.s.queue.length || gameOnTv() || room.settings.get('playback.whenQueueEmpty') !== 'autoplay') return;
      const exclude = new Set(room.s.tonight.sung);
      const [song] = room.catalog.random(1, { exclude, minDuration: 90, maxDuration: 360, noExplicit: !!room.settings.get('queue.explicitFilter') }, { popularBias: 0.9 });
      if (!song) return;
      try {
        room.gameQueue(song, { singerName: 'Everyone', position: 'end', source: 'game:autoplay' });
        room.maybeAutoStart();
        room.markDirty();
        log.info(`autoplay: ${song.artist} – ${song.title}`);
      } catch (e) {
        log.warn('autoplay failed:', e.message);
      }
    }, wait);
    this.autoplayTimer.unref?.();
  }

  close() {
    clearTimeout(this.autoplayTimer);
    clearTimeout(this.restTimer);
  }
}

/**
 * Audio files under `dir`: recursive, hidden folders skipped, symbolic links followed (each
 * folder is read once, so a link back up the tree can't loop). A folder with more than `max`
 * files gives a random sample of all of them (not just the first folders on the disk).
 */
export async function scanAudioFolder(dir, { max = MAX_FOLDER_FILES, random = Math.random } = {}) {
  const out = [];
  const read = new Set(); // dev:ino of the folders read
  let seen = 0;
  const add = (abs, name) => {
    seen++;
    const slot = out.length < max ? out.length : Math.floor(random() * seen); // (reservoir sampling)
    if (slot >= max) return;
    const base = path.basename(name, path.extname(name));
    const sep = base.indexOf(' - ');
    out[slot] = { id: shortId(abs), abs, title: sep > 0 ? base.slice(sep + 3) : base, artist: sep > 0 ? base.slice(0, sep) : '' };
  };
  const walk = async (d, depth) => {
    if (depth > 8 || read.size >= MAX_FOLDER_DIRS || seen >= MAX_FOLDER_SEEN) return;
    let st;
    let entries;
    try {
      st = await fsp.stat(d);
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (depth === 0) throw e;
      return;
    }
    const key = `${st.dev}:${st.ino}`;
    if (read.has(key)) return;
    read.add(key);
    for (const e of entries) {
      if (e.name.startsWith('.') || seen >= MAX_FOLDER_SEEN) continue;
      const abs = path.join(d, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const target = await fsp.stat(abs);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // a broken link
        }
      }
      if (isDir) await walk(abs, depth + 1);
      else if (isFile && AUDIO_EXTS.has(path.extname(e.name).slice(1).toLowerCase())) add(abs, e.name);
    }
  };
  await walk(dir, 0);
  return out;
}
