// Break music (PLAN §2 "Between songs"): while nobody sings, the main TV plays quiet
// background music — backing tracks from the karaoke library (matching the next song's
// genre/decade when that's known) or songs from a music folder — with fades around each song.
// Also "autoplay": when the queue stays empty, a popular sing-along for everyone is queued.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { shortId } from '../../shared/text.js';
import { AUDIO_EXTS } from '../library/parse.js';
import { logger } from '../util/log.js';

const log = logger('break');
const FOLDER_RESCAN_MS = 10 * 60_000;
const MAX_FOLDER_FILES = 5000;

export class BreakMusic {
  constructor(room) {
    this.room = room;
    this.track = null; // { id, url, title, artist, source }
    this.recent = []; // ids played lately (not repeated soon)
    this.folder = { dir: '', at: 0, files: [], scanning: null };
    this.idleSince = Date.now();
    this.autoplayTimer = null;
  }

  get settings() {
    return this.room.settings;
  }

  cfg() {
    return this.settings.get('playback.breakMusic') || {};
  }

  /** Should the TV play break music right now? */
  wanted() {
    const room = this.room;
    const p = room.s.player;
    if (!this.cfg().enabled || room.gameBlocks()) return false;
    if (room.game && !room.game.ended && room.game.constructor.exclusive) return false;
    return !room.s.current || p.state === 'intro' || p.state === 'ready' || p.state === 'idle';
  }

  /** What the TV gets: the track to play (or null = fade out and stop). */
  view() {
    if (!this.wanted()) return null;
    if (!this.track) this.pick();
    if (!this.track) return null;
    const volume = Math.max(0, Math.min(1, Number(this.cfg().volume) || 0.35));
    return { id: this.track.id, url: this.track.url, title: this.track.title, artist: this.track.artist, volume };
  }

  /** Picks the next track (library or folder); keeps the last few from repeating. */
  pick() {
    const cfg = this.cfg();
    const next = cfg.source === 'folder' ? this.pickFolder(cfg.folder) : this.pickLibrary(cfg.matchNext !== false);
    this.track = next;
    if (next) {
      this.recent.push(next.id);
      if (this.recent.length > 30) this.recent.shift();
    }
    return next;
  }

  pickLibrary(matchNext) {
    const catalog = this.room.catalog;
    const exclude = new Set(this.recent.map((id) => id.replace(/^lib:/, '')));
    for (const e of this.room.s.queue.slice(0, 10)) exclude.add(e.songId);
    const filter = { exclude, minDuration: 20, maxDuration: 480, noExplicit: true };
    // Match the mood of the next song when its genre/decade is known.
    const nextSong = matchNext && this.room.s.queue[0] ? catalog.song(this.room.s.queue[0].songId) : null;
    const meta = nextSong && catalog.metaFor(nextSong.key);
    const tries = [];
    if (meta?.genre && meta?.year) tries.push({ ...filter, genre: meta.genre, decade: Math.floor(meta.year / 10) * 10 });
    if (meta?.genre) tries.push({ ...filter, genre: meta.genre });
    tries.push(filter);
    for (const f of tries) {
      const [song] = catalog.random(1, f, { popularBias: 0.8 });
      if (!song) continue;
      const track = this.room.pickTrack(song, { noExplicit: true });
      if (!track || track.kind === 'video') continue;
      return { id: `lib:${song.id}`, url: `/media/${track.id}/audio`, title: song.title, artist: song.artist, source: 'library' };
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
    return { id: f.id, url: `/media/break/${f.id}`, title: f.title, artist: f.artist, source: 'folder' };
  }

  /** Scans the music folder in the background (at most every 10 minutes). */
  refreshFolder(dir) {
    const abs = path.resolve(dir);
    const f = this.folder;
    if (f.scanning || (f.dir === abs && Date.now() - f.at < FOLDER_RESCAN_MS)) return f.scanning;
    f.scanning = scanAudioFolder(abs)
      .then((files) => {
        Object.assign(f, { dir: abs, at: Date.now(), files });
        log.info(`${files.length} break music files in ${abs}`);
        if (!this.track) this.room.markDirty();
      })
      .catch((e) => {
        Object.assign(f, { dir: abs, at: Date.now(), files: [] });
        log.warn(`cannot read the break music folder ${abs}: ${e.message}`);
      })
      .finally(() => { f.scanning = null; });
    return f.scanning;
  }

  /** Absolute path of a folder track by id (only files found by the scan are served). */
  folderFile(id) {
    return this.folder.files.find((x) => x.id === id)?.abs || null;
  }

  /** The TV finished (or couldn't play) `id`: next one. */
  ended(id) {
    if (this.track && this.track.id === id) this.pick();
  }

  skip() {
    this.pick();
    return { track: this.track ? { title: this.track.title, artist: this.track.artist } : null };
  }

  settingsChanged() {
    this.track = null;
    this.folder.at = 0;
  }

  /**
   * "When the queue is empty: autoplay": after `playback.autoplayAfter` idle seconds with an
   * empty queue and a TV on, queue a popular song for everyone to sing along.
   */
  checkAutoplay() {
    const room = this.room;
    const idle = !room.s.current && !room.s.queue.length && !room.game && room.mainDisplay() && !room.s.player.hold;
    if (!idle || room.settings.get('playback.whenQueueEmpty') !== 'autoplay') {
      clearTimeout(this.autoplayTimer);
      this.autoplayTimer = null;
      return;
    }
    if (this.autoplayTimer) return;
    const wait = Math.max(5, Number(room.settings.get('playback.autoplayAfter')) || 45) * 1000;
    this.autoplayTimer = setTimeout(() => {
      this.autoplayTimer = null;
      if (room.s.current || room.s.queue.length || room.game || room.settings.get('playback.whenQueueEmpty') !== 'autoplay') return;
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
  }
}

/** Audio files under `dir` (recursive, hidden folders skipped), at most 5000. */
export async function scanAudioFolder(dir) {
  const out = [];
  const walk = async (d, depth) => {
    if (depth > 8 || out.length >= MAX_FOLDER_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (depth === 0) throw e;
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || out.length >= MAX_FOLDER_FILES) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).slice(1).toLowerCase())) {
        const base = path.basename(e.name, path.extname(e.name));
        const sep = base.indexOf(' - ');
        out.push({ id: shortId(abs), abs, title: sep > 0 ? base.slice(sep + 3) : base, artist: sep > 0 ? base.slice(0, sep) : '' });
      }
    }
  };
  await walk(dir, 0);
  return out;
}
