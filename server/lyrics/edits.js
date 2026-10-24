// The lyrics editor's files (PLAN §31.5): a song autokaraoke made has `NAME.timing.json` beside its
// CDG. An edit is kept in the data folder — data/lyrics/<trackId>/timing.json, and the CDG
// autokaraoke draws from it (`autokaraoke render`, a second or so; no ML) as lyrics.cdg — and the
// TV is served that CDG instead of the disc's. The library's files are not changed unless the host
// asks to write the edit back into the song's folder (the originals are kept once, as .orig).
// A disc that wasn't made here can have words too (PLAN §31.16, ./words.js): autokaraoke times
// them against the disc's vocal into data/lyrics/<trackId>/words.json, which stands in for the
// timing.json beside the pair. Its edits are never drawn (the disc keeps its own CDG): the TV
// writes them as text (§9.7). Their kind is 'words'; a song made here is 'made'.
import fs from 'node:fs/promises';
import path from 'node:path';
import { renameSync } from 'node:fs';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { Lru } from '../util/lru.js';
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
   * @param {(trackId: string) => Promise<string|null>} [o.vocalFileOf]  the kept vocal's file, if any
   * @param {(trackId: string) => void} [o.onText]  a track's words changed, or it was found to have some
   */
  constructor({ dataDir, library, maker, onChange = () => {}, vocalOf = async () => null, vocalFileOf = async () => null, onText = () => {} }) {
    this.vocalFileOf = vocalFileOf; // the vocal file, for re-timing with Whisper
    this.root = path.join(dataDir, 'lyrics');
    this.vocalOf = vocalOf; // the song's separated vocal (a URL), for a guide while editing
    this.library = library;
    this.maker = maker;
    this.onChange = onChange;
    this.drawn = new Map(); // trackId → generation (the edited CDG the TV is served)
    this.busy = new Set();
    this.onText = onText;
    this.texts = new Map(); // trackId → generation of its words (the TV's timing URL, PLAN §9.7)
    this.timed = new Lru({ max: 4000, sizeOf: () => 0 }); // trackId → has a timing.json (looked up once)
    this.looking = new Set();
  }

  /**
   * Has the track words the TV can draw as text (a timing.json beside its CDG, or an edit)? Known at
   * once after the first look; until then false, and `onText` is called if it turns out to have some.
   */
  hasText(track) {
    if (!track || track.kind !== 'cdg') return false;
    const known = this.timed.get(track.id);
    if (known !== undefined) return known;
    if (!this.looking.has(track.id) && this.looking.size < 64) {
      this.looking.add(track.id);
      this.timingFile(track).then((file) => {
        this.timed.set(track.id, !!file);
        if (file) this.onText(track.id);
      }, () => {}).finally(() => this.looking.delete(track.id));
    }
    return false;
  }

  /** Forget what was looked up (the library was rescanned: files came and went). */
  forgetText() {
    this.timed = new Lru({ max: 4000, sizeOf: () => 0 });
  }

  /** Changes each time the track's words change (the TV's timing URL). */
  textGen(trackId) {
    return this.texts.get(trackId) || 0;
  }

  textChanged(trackId) {
    this.texts.set(trackId, this.textGen(trackId) + 1);
    this.timed.set(trackId, true);
    this.onText(trackId);
  }

  /**
   * Where a track's own words are: autokaraoke's timing.json beside a song made here (kind 'made'),
   * else the words found for the disc in the data folder (kind 'words'); or null.
   */
  async source(track) {
    const dir = this.dir(track?.id);
    const f = this.files(track);
    if (!dir || !f) return null;
    if (await exists(f.timing)) return { file: f.timing, kind: 'made' };
    const words = path.join(dir, 'words.json');
    return (await exists(words)) ? { file: words, kind: 'words' } : null;
  }

  /** The timing.json the TV draws for a track: the edit if there is one, else its own words; or null. */
  async timingFile(track) {
    const src = await this.source(track);
    if (!src) return null;
    const draft = path.join(this.dir(track.id), 'timing.json');
    return (await exists(draft)) ? { file: draft, kind: src.kind } : src;
  }

  /** The words and times the TV draws (/media/<id>/timing), cleaned, with `source` (its kind); null: none. */
  async textFor(trackId) {
    const track = this.library.catalog.track(trackId);
    const at = await this.timingFile(track);
    if (!at) return null;
    try {
      if ((await fs.stat(at.file)).size > MAX_TIMING) return null;
      return { ...timingJson(readTiming(JSON.parse(await fs.readFile(at.file, 'utf8')))), source: at.kind };
    } catch {
      return null; // (gone, or unreadable: the disc's own lyrics then)
    }
  }

  /** New words found for a disc (./words.js): `file` becomes words.json; an edit of the old ones goes. */
  async setWords(trackId, file) {
    const dir = this.dir(trackId);
    await fs.rm(path.join(dir, 'timing.json'), { force: true });
    await fs.rename(file, path.join(dir, 'words.json'));
    this.textChanged(trackId);
  }

  /** Forget a disc's words (and any edit of them): the TV draws the disc's own lyrics again. */
  async removeWords(trackId) {
    const { track } = this.track(trackId);
    if ((await this.source(track))?.kind !== 'words') throw new UserError('This version has no words found for it.');
    await fs.rm(this.dir(trackId), { recursive: true, force: true });
    this.drawn.delete(trackId);
    this.texts.set(trackId, this.textGen(trackId) + 1);
    this.timed.set(trackId, false);
    this.onText(trackId);
    return { removed: true };
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

  /** The kind of words the editor can edit for a track ('made' | 'words'), or '' (none). */
  async editable(track) {
    return (await this.source(track))?.kind || '';
  }

  /** Has the track's words an edit (the editor's draft)? */
  async edited(trackId) {
    const dir = this.dir(trackId);
    return !!dir && (await exists(path.join(dir, 'timing.json')));
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

  /** What the editor opens: the edit if there is one, else the track's own words. */
  async open(trackId) {
    const { track, f } = this.track(trackId);
    const dir = this.dir(trackId);
    const draft = path.join(dir, 'timing.json');
    const src = await this.source(track);
    const edited = !!src && (await exists(draft));
    let text;
    try {
      if (!src) throw new Error('none');
      text = await fs.readFile(edited ? draft : src.file, 'utf8');
    } catch {
      throw new UserError('This version has no timed lyrics to edit: songs made with autokaraoke have them, and a disc with a vocal can get them (Song details → Find the words).');
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
      kind: src.kind, // 'made': redrawn and written back; 'words': a disc's, never drawn (the TV writes them)
      file: src.kind === 'made' ? f.timing : '',
      renderer: src.kind === 'made' && !!this.maker?.where?.installed,
      retime: !!this.maker?.where?.installed && !!(await this.vocalFile(trackId, f)),
    };
  }

  /** Saves an edit and has autokaraoke draw it. → the editor's state. */
  async save(trackId, raw) {
    const { track, f } = this.track(trackId);
    const src = await this.source(track);
    if (!src) throw new UserError('This version has no timed lyrics to edit.');
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
      this.textChanged(trackId); // (the TV's words follow at once, drawn or not)
      if (src.kind === 'words') return { ...(await this.open(trackId)), drawnNow: false }; // (a disc keeps its CDG)
      const where = this.maker?.where;
      if (!this.maker?.tool || !where?.installed) {
        return { ...(await this.open(trackId)), drawnNow: false, error: 'Saved. autokaraoke is needed to draw the lyrics: install it in Settings → Karaoke maker.' };
      }
      // The timing's own render options (autokaraoke uses them); an older timing.json has none, so
      // the disc's colours come from its CDG.
      let theme = '';
      if (!song.render?.theme) {
        try { theme = cdgTheme(await fs.readFile(f.cdg)); } catch { /* gone */ }
      }
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

  /** The song's vocal for re-timing: the kept one (data/stems), else NAME.work/vocals.wav. */
  async vocalFile(trackId, f) {
    const kept = await this.vocalFileOf(trackId);
    if (kept && (await exists(kept))) return kept;
    const work = f.timing.replace(/\.timing\.json$/, '.work');
    const beside = path.join(work, 'vocals.wav');
    return (await exists(beside)) ? beside : null;
  }

  /**
   * Re-times the words that start inside [from, to] with Whisper (`autokaraoke retime`, in the
   * heavy-job lane): `raw` is the editor's song now. Nothing is saved: the editor gets the new
   * timing back as one more change, to keep (Save) or undo. → { timing, retimed }
   */
  async retime(trackId, raw, { from, to } = {}) {
    const { f } = this.track(trackId);
    const where = this.maker?.where;
    if (!this.maker?.tool || !where?.installed) throw new UserError('Re-timing needs the Karaoke maker: install it in Settings → Karaoke maker.');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 120) throw new UserError('Pick up to two minutes of the song to re-time.');
    let song;
    try {
      song = readTiming(raw);
    } catch (e) {
      throw new UserError(`Those lyrics can’t be re-timed: ${e.message}`);
    }
    const vocals = await this.vocalFile(trackId, f);
    if (!vocals) throw new UserError('Re-timing needs the song’s vocal: separate it first (Song details → Separated vocals).');
    if (this.busy.has(trackId)) throw new UserError('Still working on this song — a moment.');
    this.busy.add(trackId);
    const dir = this.dir(trackId);
    const input = path.join(dir, 'retime-in.json');
    const output = path.join(dir, 'retime-out.json');
    const release = this.maker.lane ? await this.maker.lane.acquire('retime') : () => {};
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(input, `${JSON.stringify(timingJson(song), null, 1)}\n`);
      const lines = [];
      const run = this.maker.tool.start(where, 'retime', {
        timing: input, vocals, output, from, to, language: song.language || '', whisperModel: this.maker.whisperModel(),
        onLine: (l) => lines.push(l),
      });
      const { code } = await run.done;
      const done = lines.map((l) => /^Retimed (\d+) words/.exec(l)).find(Boolean);
      if (code !== 0 || !done) {
        const why = [...lines].reverse().find((l) => /error/i.test(l)) || lines.at(-1) || `autokaraoke stopped (${code})`;
        log.info(`re-timing ${trackId} failed: ${why}`);
        throw new UserError(`Whisper could not re-time it: ${why.replace(/^error:\s*/i, '').slice(0, 200)}`);
      }
      const timing = timingJson(readTiming(JSON.parse(await fs.readFile(output, 'utf8'))));
      return { timing, retimed: Number(done[1]) };
    } finally {
      release();
      this.busy.delete(trackId);
      await Promise.all([input, output].map((p) => fs.rm(p, { force: true })));
    }
  }

  /** Back to the track's own words (autokaraoke's timing, or the words found) and the disc's CDG. */
  async revert(trackId) {
    const { track } = this.track(trackId);
    const dir = this.dir(trackId);
    const had = this.drawn.has(trackId);
    if ((await this.source(track))?.kind === 'words') await fs.rm(path.join(dir, 'timing.json'), { force: true });
    else await fs.rm(dir, { recursive: true, force: true });
    this.drawn.delete(trackId);
    if (had) this.onChange(trackId);
    this.textChanged(trackId);
    return this.open(trackId);
  }

  /**
   * The edit into the song's own folder, as autokaraoke would have it: NAME.timing.json, NAME.cdg
   * and NAME.lrc (each original kept once as NAME.….orig). Then the edit in the data folder goes.
   */
  async writeBack(trackId) {
    const { track, f } = this.track(trackId);
    if ((await this.source(track))?.kind !== 'made') throw new UserError('A disc’s words stay in OpenKaraoke: its own files are never changed.');
    const dir = this.dir(trackId);
    const draft = path.join(dir, 'timing.json');
    const cdg = path.join(dir, 'lyrics.cdg');
    if (!(await exists(draft)) || !this.drawn.has(trackId) || !(await exists(cdg))) throw new UserError('Save the lyrics first (they are drawn when saved).');
    const song = readTiming(JSON.parse(await fs.readFile(draft, 'utf8')));
    try {
      for (const file of [f.timing, f.cdg, f.lrc]) {
        if ((await exists(file)) && !(await exists(`${file}.orig`))) await fs.copyFile(file, `${file}.orig`);
      }
      // Each file whole or not at all (written beside it, then renamed): a reader never sees half.
      await fs.copyFile(draft, `${f.timing}.part`);
      await fs.rename(`${f.timing}.part`, f.timing);
      await fs.copyFile(cdg, `${f.cdg}.part`);
      await fs.rename(`${f.cdg}.part`, f.cdg);
      await fs.writeFile(`${f.lrc}.part`, timingToLrc(song));
      await fs.rename(`${f.lrc}.part`, f.lrc);
    } catch (e) {
      throw new UserError(e.code === 'EACCES' || e.code === 'EROFS' ? 'That folder can’t be written to (a read-only drive?). The edit stays in OpenKaraoke.' : `Could not write the files: ${e.message}`);
    }
    await fs.rm(dir, { recursive: true, force: true });
    this.drawn.delete(trackId);
    this.onChange(trackId);
    this.textChanged(trackId);
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
      if (this.texts.has(m.from)) {
        this.texts.set(m.to, this.texts.get(m.from));
        this.texts.delete(m.from);
      }
      n++;
    }
    return n;
  }
}
