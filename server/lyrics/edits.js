// The lyrics editor's files (PLAN §31.5): a song autokaraoke made has `NAME.timing.json` beside its
// CDG. An edit is kept in the data folder — data/lyrics/<trackId>/timing.json, and the CDG
// autokaraoke draws from it (`autokaraoke render`, a second or so; no ML) as lyrics.cdg — and the
// TV is served that CDG instead of the disc's. The library's files are not changed unless the host
// asks to write the edit back into the song's folder (the originals are kept once, as .orig).
import fs from 'node:fs/promises';
import path from 'node:path';
import { renameSync } from 'node:fs';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { readTiming, timingJson, timingToLrc } from '../../shared/timing.js';
import { CDG_INSTR } from '../../shared/cdg.js';

const log = logger('lyrics');
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_TIMING = 2 * 1024 * 1024;

/** autokaraoke's colour themes, by the colour a sung word turns (palette entry 2, 4-bit RGB). */
const SUNG = { classic: [15, 11, 0], blue: [2, 11, 15], green: [5, 15, 6] };

/** Which autokaraoke theme drew a CDG (from its first colour table), or '' (another maker's disc). */
export function cdgTheme(buf) {
  for (let off = 0; off + 24 <= Math.min(buf.length, 24 * 600); off += 24) {
    if ((buf[off] & 0x3f) !== 9 || (buf[off + 1] & 0x3f) !== CDG_INSTR.LOAD_COLORS_LOW) continue;
    const hi = buf[off + 4 + 4] & 0x3f;
    const lo = buf[off + 4 + 5] & 0x3f;
    const rgb = [(hi >> 2) & 15, ((hi & 3) << 2) | ((lo >> 4) & 3), lo & 15];
    for (const [name, c] of Object.entries(SUNG)) if (c.every((v, i) => v === rgb[i])) return name;
    return '';
  }
  return '';
}

const exists = (p) => fs.stat(p).then((s) => s.isFile(), () => false);

export class LyricEdits {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {import('../library/service.js').LibraryService} o.library
   * @param {import('../maker/jobs.js').Maker} o.maker  autokaraoke (its `render`)
   * @param {(trackId: string) => void} [o.onChange]  an edit was drawn or reverted
   * @param {(trackId: string) => Promise<string|null>} [o.vocalOf]  the separated vocal's URL, if any
   */
  constructor({ dataDir, library, maker, onChange = () => {}, vocalOf = async () => null }) {
    this.root = path.join(dataDir, 'lyrics');
    this.vocalOf = vocalOf; // the song's separated vocal (a URL), for a guide while editing
    this.library = library;
    this.maker = maker;
    this.onChange = onChange;
    this.drawn = new Map(); // trackId → generation (the edited CDG the TV is served)
    this.busy = new Set();
  }

  /** The edits on disk (after a restart). */
  async load() {
    let names = [];
    try { names = await fs.readdir(this.root); } catch { return; }
    for (const id of names) {
      if (ID.test(id) && (await exists(path.join(this.root, id, 'lyrics.cdg')))) this.drawn.set(id, 1);
    }
  }

  dir(trackId) {
    if (typeof trackId !== 'string' || !ID.test(trackId)) return null;
    return path.join(this.root, trackId);
  }

  /** A CDG track's files: the CDG, the MP3 and autokaraoke's timing.json beside them (it may not exist). */
  files(track) {
    if (!track || track.kind !== 'cdg') return null;
    const cdg = this.library.absPath(track, 'cdg');
    const audio = this.library.absPath(track, 'audio');
    if (!cdg || !audio) return null;
    return { cdg, audio, timing: cdg.replace(/\.cdg$/i, '.timing.json'), lrc: cdg.replace(/\.cdg$/i, '.lrc') };
  }

  /** The track has lyrics the editor can edit (autokaraoke's timing.json beside it). */
  async editable(track) {
    const f = this.files(track);
    return !!f && (await exists(f.timing));
  }

  /** The edited CDG to serve for a track, or null (the disc's own). */
  cdgFor(trackId) {
    return this.drawn.has(trackId) ? path.join(this.dir(trackId), 'lyrics.cdg') : null;
  }

  /** Changes each time the edited CDG changes (the TV's cache key). */
  gen(trackId) {
    return this.drawn.get(trackId) || 0;
  }

  track(trackId) {
    const track = this.library.catalog.track(trackId);
    if (!track) throw new UserError('That version is not in the library (it may have been rescanned).', { status: 404 });
    const f = this.files(track);
    if (!f) throw new UserError('Only CD+G tracks have lyrics to edit.');
    return { track, f };
  }

  /** What the editor opens: the edit if there is one, else autokaraoke's own timing. */
  async open(trackId) {
    const { track, f } = this.track(trackId);
    const dir = this.dir(trackId);
    const draft = path.join(dir, 'timing.json');
    const edited = await exists(draft);
    let text;
    try {
      text = await fs.readFile(edited ? draft : f.timing, 'utf8');
    } catch {
      throw new UserError('This song has no timed lyrics to edit: only songs made with autokaraoke have them.');
    }
    if (text.length > MAX_TIMING) throw new UserError('That timing file is too big.');
    let timing;
    try {
      timing = timingJson(readTiming(JSON.parse(text)));
    } catch (e) {
      throw new UserError(`The timing file can’t be read: ${e.message}`);
    }
    const song = this.library.catalog.song(track.songId);
    return {
      trackId,
      songId: track.songId,
      title: song?.title || timing.title,
      artist: song?.artist || timing.artist,
      label: track.p?.brand || '',
      timing,
      edited,
      drawn: this.drawn.has(trackId),
      audio: `/media/${trackId}/audio`,
      vocal: await this.vocalOf(trackId).catch(() => null),
      file: f.timing,
      renderer: !!this.maker?.where?.installed,
    };
  }

  /** Saves an edit and has autokaraoke draw it. → the editor's state. */
  async save(trackId, raw) {
    const { f } = this.track(trackId);
    if (!(await exists(f.timing))) throw new UserError('This song has no timed lyrics to edit.');
    let song;
    try {
      song = readTiming(raw);
    } catch (e) {
      throw new UserError(`Those lyrics can’t be saved: ${e.message}`);
    }
    if (!song.lines.length) throw new UserError('There are no words left.');
    if (this.busy.has(trackId)) throw new UserError('Still drawing the last save — a moment.');
    this.busy.add(trackId);
    const dir = this.dir(trackId);
    try {
      await fs.mkdir(dir, { recursive: true });
      const timingFile = path.join(dir, 'timing.json');
      await fs.writeFile(`${timingFile}.part`, `${JSON.stringify(timingJson(song), null, 1)}\n`);
      await fs.rename(`${timingFile}.part`, timingFile);
      const where = this.maker?.where;
      if (!this.maker?.tool || !where?.installed) {
        return { ...(await this.open(trackId)), drawnNow: false, error: 'Saved. autokaraoke is needed to draw the lyrics: install it in Settings → Karaoke maker.' };
      }
      // The disc's colours, if autokaraoke drew it (its timing.json doesn't say).
      let theme = '';
      try { theme = cdgTheme(await fs.readFile(f.cdg)); } catch { /* gone */ }
      const out = path.join(dir, 'lyrics.cdg.part.cdg');
      const lines = [];
      const run = this.maker.tool.start(where, 'render', { timing: timingFile, audio: f.audio, output: out, theme, onLine: (l) => lines.push(l) });
      const { code } = await run.done;
      if (code !== 0 || !(await exists(out))) {
        await fs.rm(out, { force: true });
        const why = [...lines].reverse().find((l) => /error|not found/i.test(l)) || lines.at(-1) || `autokaraoke stopped (${code})`;
        log.info(`render of ${trackId} failed: ${why}`);
        return { ...(await this.open(trackId)), drawnNow: false, error: `Saved, but the lyrics could not be drawn: ${why.slice(0, 200)}` };
      }
      await fs.rename(out, path.join(dir, 'lyrics.cdg'));
      await fs.rm(path.join(dir, 'timing.lrc'), { force: true }); // (render's LRC beside the draft: not needed here)
      this.drawn.set(trackId, (this.drawn.get(trackId) || 0) + 1);
      this.onChange(trackId);
      return { ...(await this.open(trackId)), drawnNow: true };
    } finally {
      this.busy.delete(trackId);
    }
  }

  /** Back to autokaraoke's own timing and the disc's CDG. */
  async revert(trackId) {
    this.track(trackId);
    const dir = this.dir(trackId);
    const had = this.drawn.has(trackId);
    await fs.rm(dir, { recursive: true, force: true });
    this.drawn.delete(trackId);
    if (had) this.onChange(trackId);
    return this.open(trackId);
  }

  /**
   * The edit into the song's own folder, as autokaraoke would have it: NAME.timing.json, NAME.cdg
   * and NAME.lrc (each original kept once as NAME.….orig). Then the edit in the data folder goes.
   */
  async writeBack(trackId) {
    const { f } = this.track(trackId);
    const dir = this.dir(trackId);
    const draft = path.join(dir, 'timing.json');
    const cdg = path.join(dir, 'lyrics.cdg');
    if (!(await exists(draft)) || !this.drawn.has(trackId) || !(await exists(cdg))) throw new UserError('Save the lyrics first (they are drawn when saved).');
    const song = readTiming(JSON.parse(await fs.readFile(draft, 'utf8')));
    try {
      for (const file of [f.timing, f.cdg, f.lrc]) {
        if ((await exists(file)) && !(await exists(`${file}.orig`))) await fs.copyFile(file, `${file}.orig`);
      }
      await fs.copyFile(draft, f.timing);
      await fs.copyFile(cdg, `${f.cdg}.part`);
      await fs.rename(`${f.cdg}.part`, f.cdg);
      await fs.writeFile(f.lrc, timingToLrc(song));
    } catch (e) {
      throw new UserError(e.code === 'EACCES' || e.code === 'EROFS' ? 'That folder can’t be written to (a read-only drive?). The edit stays in OpenKaraoke.' : `Could not write the files: ${e.message}`);
    }
    await fs.rm(dir, { recursive: true, force: true });
    this.drawn.delete(trackId);
    this.onChange(trackId);
    return this.open(trackId);
  }

  /** The same file got a new track id (a library folder was split or folded): the edit moves with it. */
  rekey(moves) {
    let n = 0;
    for (const m of Array.isArray(moves) ? moves : []) {
      if (!m || m.from === m.to) continue;
      const from = this.dir(m.from);
      const to = this.dir(m.to);
      if (!from || !to) continue;
      try {
        renameSync(from, to);
      } catch (e) {
        if (e.code !== 'ENOENT') log.info(`could not move the lyrics edit ${m.from} → ${m.to}: ${e.message}`);
        continue;
      }
      if (this.drawn.has(m.from)) {
        this.drawn.set(m.to, this.drawn.get(m.from) + 1);
        this.drawn.delete(m.from);
      }
      n++;
    }
    return n;
  }
}
