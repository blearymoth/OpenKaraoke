// The Karaoke maker (PLAN §31): songs made with autokaraoke from the host's Settings page, one
// at a time in the heavy-job lane it shares with vocal separation (util/lane.js). A song comes
// from a file on this computer, a file the host uploads (data/maker/uploads/), or a link. The
// finished pair goes to the save folder, which becomes a library folder of its own (rescanned by
// itself), and the job says which song it is. On a PC without a graphics card a job waits while
// someone sings (settings.maker.duringSongs), unless the host says "Start now". Also: installing
// autokaraoke (its install.sh), downloading the models, and the check of this computer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { parseLink, cleanLyrics } from '../../shared/maker.js';
import { assess } from '../system/specs.js';
import {
  readMakeLine, readLyricsLookup, makeArgs, cleanName, guessNames, isSongFile, THEMES, WHISPER_MODELS, DEMUCS_MODELS, LYRICS_SOURCES,
} from './autokaraoke.js';
import { Speed } from './speed.js';

const log = logger('maker');
const KEEP_JOBS = 20;
const LOOKUP_MS = 45000; // a lyrics lookup that takes longer is given up
const MAX_LOOKUPS = 2; // lyrics lookups at once
const PHONON_MODEL = 'phonon-2'; // (the speed file's key for songs Phonon-2 timed)
const KEEP_LINES = 200;
const MAX_LYRICS = 50 * 1024;
export const MAX_UPLOAD = 500 * 1024 * 1024;
const UPLOAD_MAX_AGE = 24 * 3600 * 1000;
const WAIT_CHECK_MS = 2000;
const ID = /^[a-z0-9]{12}$/;

const newId = () => crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
const inside = (dir, root) => {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The default save folder's name, inside the first library folder. */
export const MAKER_FOLDER = 'OpenKaraoke Maker';

export class Maker {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object|null} o.tool autokaraokeTool() or fakeAutokaraoke() — null: the maker is off
   * @param {import('../util/lane.js').Lane} o.lane
   * @param {import('../config.js').Settings} o.settings
   * @param {import('../library/service.js').LibraryService} o.library
   * @param {() => boolean} o.songPlaying someone is singing now
   * @param {() => void} o.onChange
   */
  constructor({ dataDir, tool, lane, settings, library, songPlaying = () => false, onChange = () => {}, vocals = null, onJob = () => {} }) {
    this.dir = path.join(dataDir, 'maker');
    this.speed = new Speed({ file: path.join(this.dir, 'speed.json') }); // this PC's measured speed (PLAN §31.2)
    this.onJob = onJob; // a job moved on (running, waiting, finished, in the library): song links follow it
    this.vocals = vocals; // { file(trackId, name), kept(trackId) }: the stems' cache (PLAN §30)
    this.tool = tool || null;
    this.lane = lane;
    this.settings = settings;
    this.library = library;
    this.songPlaying = songPlaying;
    this.onChange = onChange;
    this.where = null;
    this.checks = null;
    this.lookups = 0; // lyrics lookups running (previewLyrics), and those waiting their turn
    this.lookupWaiters = [];
    this.checking = false;
    this.task = null; // installing or downloading the models: { kind, status, lines, code }
    this.taskRun = null;
    this.jobs = [];
    this.uploads = new Map(); // id → { file, name, size, at }
    this.running = null; // { job, run, release }
    this.pumping = false;
    this.waitTimer = null;
    this.closed = false;
  }

  get enabled() {
    return !!this.tool;
  }

  async init() {
    if (!this.tool) return;
    await fsp.rm(path.join(this.dir, 'uploads'), { recursive: true, force: true }).catch(() => {}); // (a restart forgets them)
    try { // the last check's verdict, until this start's check is done
      const saved = JSON.parse(await fsp.readFile(path.join(this.dir, 'specs.json'), 'utf8'));
      if (saved?.specs && saved?.verdict) Object.assign(this, { specs: saved.specs, verdict: saved.verdict, specsAt: saved.at || 0 });
    } catch { /* none yet */ }
    await this.speed.load();
    this.where = await this.tool.locate().catch(() => null);
    this.onChange();
  }

  /** Seconds a job is likely to take on this PC, once its length is known; else null. */
  estimate(job) {
    if (!job.duration) return null;
    return this.speed.estimate({ duration: job.duration, url: job.kind === 'url', demucsModel: job.opts.demucsModel, whisperModel: this.timingModel(job.opts) });
  }

  /**
   * Who times the lyrics (`--lyric-timer`): the host's choice, Phonon-2 first by default; '' when
   * this autokaraoke is older than 0.4.0 (Whisper only, and the option unknown to it).
   */
  lyricTimer() {
    if (!this.checks?.features?.phonon) return '';
    return this.settings.get('maker.lyricTimer') === 'whisper' ? 'whisper' : 'phonon';
  }

  /** The lyric timer a song's speed is kept under: Phonon-2's own (English), else the Whisper model. */
  timingModel({ lyricTimer = '', language = 'en', whisperModel = 'medium' } = {}) {
    return lyricTimer === 'phonon' && /^en/.test(language || 'en') ? PHONON_MODEL : whisperModel;
  }

  /**
   * Where made songs go: the host's folder, else <first library folder>/OpenKaraoke Maker. It must
   * be inside a library folder whose drive is connected. → { folder, root, problem }
   */
  outInfo() {
    const roots = this.library.paths;
    const saved = this.settings.get('maker.out');
    const folder = typeof saved === 'string' && path.isAbsolute(saved) ? path.resolve(saved) : roots[0] ? path.join(roots[0], MAKER_FOLDER) : '';
    const root = roots.find((r) => inside(folder, r)) || '';
    const online = !!root && this.library.status().roots.some((r) => r.path === root && r.online);
    const problem = !roots.length ? 'Add a karaoke folder first (Settings → Library): new songs are saved inside it.'
      : !root ? 'The save folder must be inside one of your karaoke folders.'
        : !online ? 'The drive with that karaoke folder isn’t connected.' : '';
    return { folder, root, problem };
  }

  out() {
    return this.outInfo().folder;
  }

  /**
   * The lyrics the lyrics services have for a song, before anything is made (the host's preview of a
   * song from a link, PLAN §31.12): `autokaraoke lyrics`, quick and outside the heavy-job lane.
   * → { found, source, label, lines, match, text } (the first source in the host's order that has
   * them), or { found: false }.
   */
  async previewLyrics({ artist = '', title = '', duration = 0 } = {}) {
    if (!this.tool || !this.where?.installed) throw new UserError('Install the Karaoke maker first (Settings → Karaoke maker).');
    if (!this.checks?.features?.lookup) throw new UserError('This Karaoke maker can’t look lyrics up: update it (Settings → Karaoke maker).');
    if (!cleanName(title)) throw new UserError('Fill in the title (and the artist) to look the lyrics up.');
    const sources = (this.settings.get('maker.lyricsSources') || []).filter((x) => LYRICS_SOURCES.includes(x) && x !== 'sidecar');
    if (!sources.length) throw new UserError('No lyrics service is chosen (Settings → Karaoke maker → Where to look).');
    // A few at a time: each is a Python process on the party PC (ten guests' links in a minute).
    while (this.lookups >= MAX_LOOKUPS) await new Promise((r) => this.lookupWaiters.push(r));
    this.lookups += 1;
    const lines = [];
    let code;
    try {
      // What it prints (stdout) is read; a library's warnings (stderr) never become lyrics.
      const run = this.tool.start(this.where, 'lyrics', { artist, title, duration, sources, onLine: (l, stream) => { if (stream !== 'err') lines.push(l); } });
      const timer = setTimeout(() => run.cancel(), LOOKUP_MS);
      try {
        ({ code } = await run.done);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.lookups -= 1;
      this.lookupWaiters.shift()?.();
    }
    // Stopped part way (given up, or failed): what it had printed may be half a song.
    if (code !== 0) throw new UserError('The lyrics couldn’t be looked up just now — try again.');
    const hit = readLyricsLookup(lines.join('\n')).find((r) => r.found && r.text);
    const text = hit && cleanLyrics(hit.text.slice(0, MAX_LYRICS));
    return text ? { found: true, source: hit.source, label: hit.label, lines: text.split('\n').length, match: hit.match, text } : { found: false };
  }

  /** The lyric timer model: the host's, or ("auto") the one the hardware check picked. */
  whisperModel() {
    const set = this.settings.get('maker.whisperModel');
    return WHISPER_MODELS.includes(set) ? set : this.verdict?.model || 'medium';
  }

  /** The graphics card does the work (the verdict is fast or fast enough). */
  onGpu() {
    return this.verdict ? ['fast', 'good'].includes(this.verdict.verdict) : !!this.checks?.gpu;
  }

  /** Looks at this computer and the install again (the page's "Check again", and after a task). */
  async check() {
    if (!this.tool || this.checking) return this.view();
    this.checking = true;
    this.onChange();
    try {
      this.where = await this.tool.locate();
      this.checks = await this.tool.check(this.where, { whisperModel: this.whisperModel(), demucsModel: this.settings.get('maker.demucsModel') });
      if (this.checks?.specs) {
        this.specs = this.checks.specs;
        this.verdict = assess(this.specs);
        this.specsAt = Date.now();
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.writeFile(path.join(this.dir, 'specs.json'), JSON.stringify({ at: this.specsAt, specs: this.specs, verdict: this.verdict }));
        if (this.settings.get('maker.whisperModel') === 'auto') { // (the models check was for the old guess)
          this.checks = await this.tool.check(this.where, { whisperModel: this.whisperModel(), demucsModel: this.settings.get('maker.demucsModel') });
        }
      }
    } catch (e) {
      log.info(`check failed: ${e.message}`);
    } finally {
      this.checking = false;
      this.onChange();
    }
    return this.view();
  }

  // ---- uploads ---------------------------------------------------------------------------------

  /** Streams an uploaded song into data/maker/uploads/<id>/ (cut off past MAX_UPLOAD). */
  async receiveUpload(req, name) {
    if (!this.tool) throw new UserError('The Karaoke maker is not available.');
    const safe = path.basename(String(name || '')).replace(/[\u0000-\u001f/\\]+/g, '_').slice(0, 160) || 'song';
    if (!isSongFile(safe)) throw new UserError('Send a song file (MP3, M4A, FLAC, WAV, OGG, Opus…).');
    const length = Number(req.headers['content-length']);
    if (length > MAX_UPLOAD) throw new UserError(`That file is too big (max ${MAX_UPLOAD >> 20} MB).`);
    this.pruneUploads();
    const id = newId();
    const dir = path.join(this.dir, 'uploads', id);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, safe);
    let size = 0;
    const counter = async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new UserError(`That file is too big (max ${MAX_UPLOAD >> 20} MB).`);
        yield chunk;
      }
    };
    try {
      await pipeline(req, counter, fs.createWriteStream(file));
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw e instanceof UserError ? e : new UserError('The upload did not finish.');
    }
    this.uploads.set(id, { file, name: safe, size, at: Date.now() });
    return { id, name: safe, size, ...guessNames(safe) };
  }

  pruneUploads() {
    const now = Date.now();
    for (const [id, u] of this.uploads) {
      if (now - u.at > UPLOAD_MAX_AGE && !this.jobs.some((j) => j.upload === id && !j.finishedAt)) this.dropUpload(id);
    }
  }

  dropUpload(id) {
    const u = this.uploads.get(id);
    if (!u) return;
    this.uploads.delete(id);
    fsp.rm(path.dirname(u.file), { recursive: true, force: true }).catch(() => {});
  }

  // ---- making a song -----------------------------------------------------------------------------

  /**
   * A new job: `{ song: { upload } | { path } | { url }, artist, title, language, theme, lyrics }`
   * (models from the settings). → the job's view.
   */
  /** Why no song can be made right now ('' = it can). */
  readyProblem() {
    if (!this.tool) return 'The Karaoke maker is not available.';
    if (!this.where?.installed) return 'Install the Karaoke maker first (Settings → Karaoke maker).';
    return this.outInfo().problem;
  }

  async make(input, { tag = '' } = {}) {
    if (!this.tool) throw new UserError('The Karaoke maker is not available.');
    if (!this.where?.installed) throw new UserError('Install the Karaoke maker first (Settings → Karaoke maker).');
    const s = input?.song || {};
    let song;
    let label;
    let upload = null;
    if (typeof s.upload === 'string' && ID.test(s.upload) && this.uploads.has(s.upload)) {
      upload = s.upload;
      song = this.uploads.get(upload).file;
      label = this.uploads.get(upload).name;
    } else if (typeof s.url === 'string' && s.url) {
      const link = parseLink(s.url);
      if (link.error) throw new UserError(link.error);
      song = link.url;
      label = song;
    } else if (typeof s.path === 'string' && s.path) {
      if (!path.isAbsolute(s.path) || !isSongFile(s.path)) throw new UserError('Choose a song file (MP3, M4A, FLAC, WAV, OGG, Opus…).');
      const st = await fsp.stat(s.path).catch(() => null);
      if (!st?.isFile()) throw new UserError('That song file was not found.');
      song = path.resolve(s.path);
      label = path.basename(song);
    } else throw new UserError('Choose a song file, upload one, or paste a link.');
    if (typeof input.lyrics === 'string' && input.lyrics.length > MAX_LYRICS) throw new UserError('Those lyrics are too long.');
    const lyrics = cleanLyrics(input.lyrics);
    const guess = upload || s.path ? guessNames(label) : { artist: '', title: '' };
    const artist = cleanName(input.artist) || guess.artist;
    const title = cleanName(input.title) || guess.title;
    const opts = {
      language: typeof input.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(input.language) ? input.language : this.settings.get('maker.language') || 'en',
      theme: THEMES.includes(input.theme) ? input.theme : this.settings.get('maker.theme'),
      whisperModel: this.whisperModel(),
      lyricTimer: this.lyricTimer(),
      demucsModel: this.settings.get('maker.demucsModel'),
      keepStems: true, // (its separated vocals: the song's Separated vocals and the editor's guide)
      // The lyrics' authority: typed lyrics, else a lyrics service (if this autokaraoke can), else Whisper.
      lyricsSources: !lyrics && this.settings.get('maker.lookupLyrics') && this.checks?.features?.lookup
        ? (this.settings.get('maker.lyricsSources') || []).filter((x) => LYRICS_SOURCES.includes(x)) : [],
    };
    const { folder: out, problem } = this.outInfo();
    if (problem) throw new UserError(problem);
    makeArgs({ song, out, artist, title, ...opts }); // (throws on anything it won't run)
    const job = {
      id: newId(), status: 'queued', stage: '', percent: 0, bar: '', lines: [], song, label, upload,
      kind: upload ? 'upload' : s.url ? 'url' : 'path', artist, title, lyrics, out, opts, now: false,
      createdAt: Date.now(), startedAt: 0, finishedAt: 0, error: '', result: null, tag: typeof tag === 'string' ? tag : '',
    };
    this.jobs.push(job);
    this.trim();
    this.onChange();
    void this.pump();
    return this.jobView(job);
  }

  trim() {
    while (this.jobs.length > KEEP_JOBS) {
      const i = this.jobs.findIndex((j) => j.finishedAt);
      if (i < 0) break;
      this.jobs.splice(i, 1);
    }
  }

  job(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new UserError('That job is gone.');
    return job;
  }

  cancel(id) {
    const job = this.job(id);
    if (job.finishedAt) return this.jobView(job);
    if (this.running?.job === job) {
      job.cancelled = true;
      this.running.run?.cancel();
    } else {
      this.finish(job, 'cancelled');
    }
    this.onChange();
    return this.jobView(job);
  }

  /** Start a waiting job now (while someone sings on a PC without a graphics card). */
  now(id) {
    const job = this.job(id);
    job.now = true;
    this.onChange();
    void this.pump();
    return this.jobView(job);
  }

  dismiss(id) {
    const job = this.job(id);
    if (!job.finishedAt) throw new UserError('Cancel it first.');
    this.jobs = this.jobs.filter((j) => j !== job);
    this.onChange();
    return { ok: true };
  }

  /** A job should wait: no graphics card, someone is singing, and the host wants the room's sound first. */
  mustWait(job) {
    return !job.now && !this.settings.get('maker.duringSongs') && !this.onGpu() && this.songPlaying();
  }

  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.status === 'queued' || j.status === 'waiting');
        if (!job || this.closed) break;
        if (this.mustWait(job)) {
          if (job.status !== 'waiting') {
            job.status = 'waiting';
            this.onChange();
            this.tell(job);
          }
          clearTimeout(this.waitTimer);
          this.waitTimer = setTimeout(() => void this.pump(), WAIT_CHECK_MS);
          this.waitTimer.unref?.();
          break;
        }
        await this.runJob(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  async runJob(job) {
    job.status = 'running';
    job.stage = job.kind === 'url' ? 'download' : 'separate';
    job.bar = '';
    this.onChange();
    this.tell(job);
    const release = await this.lane.acquire('maker');
    this.running = { job, run: null, release };
    let lyricsFile = '';
    try {
      if (job.cancelled || this.closed) return this.finish(job, 'cancelled');
      job.startedAt = Date.now();
      if (job.lyrics.trim()) {
        const dir = path.join(this.dir, 'jobs', job.id);
        await fsp.mkdir(dir, { recursive: true });
        lyricsFile = path.join(dir, 'lyrics.txt');
        await fsp.writeFile(lyricsFile, job.lyrics);
      }
      await fsp.mkdir(job.out, { recursive: true });
      let last = 0;
      const changed = () => {
        const t = Date.now();
        if (t - last > 400) {
          last = t;
          this.onChange();
        }
      };
      const apply = (r) => {
        if (r.stage && r.stage !== job.stage) {
          job.stage = r.stage;
          job.percent = 0;
          job.bar = '';
        }
        if (r.percent !== undefined) job.percent = r.percent;
        if (r.mp3) job.mp3 = r.mp3;
        if (r.timing) job.timing = r.timing;
        if (r.mp3Name) job.names = { mp3: r.mp3Name, cdg: r.cdgName };
        if (r.lyricsFrom) job.lyricsFrom = r.lyricsFrom;
        if (r.timer) job.timer = r.timer;
        if (r.duration && !job.duration) job.duration = r.duration;
        if (r.times) job.times = r.times;
      };
      const run = this.tool.start(this.where, 'make', {
        song: job.song, out: job.out, lyricsFile, artist: job.artist, title: job.title, ...job.opts,
        onLine: (line) => {
          job.lines.push(line.slice(0, 500));
          if (job.lines.length > KEEP_LINES) job.lines.splice(0, job.lines.length - KEEP_LINES);
          apply(readMakeLine(line));
          changed();
        },
        onStatus: (text) => {
          job.bar = text.slice(0, 200);
          apply(readMakeLine(text, { status: true }));
          changed();
        },
      });
      this.running.run = run;
      const { code } = await run.done;
      if (job.cancelled || this.closed) return this.finish(job, 'cancelled');
      if (code !== 0) {
        const tail = [...job.lines].reverse().find((l) => /error|failed|not found|no lyrics/i.test(l)) || job.lines.at(-1) || '';
        return this.finish(job, 'failed', tail ? tail.slice(0, 300) : `autokaraoke stopped (${code})`);
      }
      job.stage = 'done';
      job.percent = 100;
      // (kept under what actually timed it: Phonon-2 alone, else the Whisper model)
      const timedBy = job.timer === 'Phonon-2' ? PHONON_MODEL : job.opts.whisperModel;
      if (this.speed.record({ times: job.times, duration: job.duration, demucsModel: job.opts.demucsModel, whisperModel: timedBy })) {
        this.speed.save().catch((e) => log.info(`could not keep this PC's speed: ${e.message}`));
      }
      this.finish(job, 'done');
      try {
        await this.addToLibrary(job);
        await this.keepVocals(job);
      } finally {
        if (job.result) job.result.scanning = false; // (in the library, with its vocals kept: then it shows)
        this.onChange();
      }
      this.tell(job);
    } catch (e) {
      log.info(`making ${job.label} failed: ${e.message}`);
      this.finish(job, 'failed', e instanceof UserError ? e.message : 'Could not start autokaraoke.');
    } finally {
      release();
      this.running = null;
      if (lyricsFile) fsp.rm(path.dirname(lyricsFile), { recursive: true, force: true }).catch(() => {});
    }
    return undefined;
  }

  finish(job, status, error = '') {
    job.status = status;
    job.error = error;
    job.finishedAt = Date.now();
    if (job.upload && status === 'done') this.dropUpload(job.upload);
    this.onChange();
    if (status !== 'done') this.tell(job); // (done: once it is in the library)
  }

  tell(job) {
    if (!job.tag) return;
    try {
      this.onJob({ ...this.jobView(job), tag: job.tag });
    } catch (e) {
      log.info(`a job's follower failed: ${e.message}`);
    }
  }

  /** The library folder the song was saved in, rescanned; then which song the pair is. */
  async addToLibrary(job) {
    const mp3 = job.mp3 || (job.names ? path.join(job.out, job.names.mp3) : '');
    if (!mp3) return;
    const cdg = mp3.replace(/\.mp3$/i, '.cdg');
    job.result = { mp3, cdg, timing: job.timing || mp3.replace(/\.mp3$/i, '.timing.json'), trackId: null, songId: null, scanning: true };
    this.onChange();
    try {
      const out = path.resolve(job.out);
      // The innermost library folder it is in (a folder inside another is scanned as its own).
      const roots = this.library.paths.filter((r) => inside(out, r)).sort((a, b) => b.length - a.length).slice(0, 1);
      if (roots.length) await this.library.scan({ reason: 'made with autokaraoke', roots });
      let track = this.findTrack(cdg);
      if (!track && this.library.scanning) { // (another scan was running: ours follows it)
        await Promise.resolve(this.library.scanning).catch(() => {});
        track = this.findTrack(cdg);
      }
      if (track) Object.assign(job.result, { trackId: track.id, songId: track.songId });
    } catch (e) {
      log.info(`could not add ${mp3} to the library: ${e.message}`);
    }
  }

  /**
   * autokaraoke's separated vocals and instrumental (`--keep-stems`: NAME.work/) become the new
   * track's stems (data/stems/<trackId>/vocal.wav, music.wav): the song has Separated vocals at
   * once (§30), and the lyrics editor a guide vocal. Not left beside the song in the library.
   */
  async keepVocals(job) {
    const r = job.result;
    if (!r?.mp3) return;
    const work = r.mp3.replace(/\.mp3$/i, '.work');
    const move = async (from, to) => {
      try {
        await fsp.rename(from, to);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fsp.copyFile(from, `${to}.part`); // (another drive)
        await fsp.rename(`${to}.part`, to);
        await fsp.rm(from, { force: true });
      }
    };
    try {
      const vocal = path.join(work, 'vocals.wav');
      const inst = path.join(work, 'instrumental.wav');
      const dest = r.trackId && this.vocals?.file(r.trackId, 'vocal.wav');
      if (dest && (await fsp.stat(vocal).catch(() => null)) && (await fsp.stat(inst).catch(() => null))) {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await move(inst, this.vocals.file(r.trackId, 'music.wav'));
        await move(vocal, dest); // (the vocal last: it marks the pair done)
        r.vocals = true;
        this.vocals.kept(r.trackId);
      }
    } catch (e) {
      log.info(`could not keep the vocals of ${r.mp3}: ${e.message}`);
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      this.onChange();
    }
  }

  /** The library's track for a CDG file (by its path). */
  findTrack(cdg) {
    const want = path.resolve(cdg);
    for (const t of this.library.catalog.tracks.values()) {
      if (t.kind === 'cdg' && this.library.absPath(t, 'cdg') === want) return t;
    }
    return null;
  }

  // ---- installing, models ----------------------------------------------------------------------

  /** install.sh (`gpu`: the graphics card's build) or `autokaraoke setup` (the models), one at a time. */
  startTask(kind, opts = {}) {
    if (!this.tool) throw new UserError('The Karaoke maker is not available.');
    if (this.task?.status === 'running') throw new UserError('Wait for the install to finish.');
    if (this.running) throw new UserError('Wait for the song being made to finish.');
    if (kind === 'install' && !this.where?.installer) throw new UserError('The Karaoke maker’s installer (maker/install.sh) is missing from this copy of OpenKaraoke.');
    if (kind === 'setup' && !this.where?.installed) throw new UserError('Install the Karaoke maker first.');
    const task = { kind, status: 'running', lines: [], bar: '', code: null, startedAt: Date.now() };
    this.task = task;
    const args = kind === 'install'
      ? { gpu: !!opts.gpu, youtube: opts.youtube !== false, codeOnly: !!opts.codeOnly && !!this.where?.installed && !this.where?.legacy,
        modelsFrom: this.where?.legacyModels || '' }
      : { whisperModel: WHISPER_MODELS.includes(opts.whisperModel) ? opts.whisperModel : this.whisperModel(),
        demucsModel: DEMUCS_MODELS.includes(opts.demucsModel) ? opts.demucsModel : this.settings.get('maker.demucsModel') };
    let last = 0;
    const run = this.tool.start(this.where, kind, {
      ...args,
      onLine: (line) => {
        task.lines.push(line.slice(0, 500));
        if (task.lines.length > KEEP_LINES) task.lines.splice(0, task.lines.length - KEEP_LINES);
        if (Date.now() - last > 400) { last = Date.now(); this.onChange(); }
      },
      onStatus: (text) => {
        task.bar = text.slice(0, 200);
        if (Date.now() - last > 400) { last = Date.now(); this.onChange(); }
      },
    });
    this.taskRun = run;
    run.done.then(async ({ code }) => {
      task.code = code;
      task.status = task.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
      this.taskRun = null;
      this.onChange();
      if (!this.closed) await this.check();
    });
    this.onChange();
    return this.view();
  }

  cancelTask() {
    if (this.task?.status !== 'running') return this.view();
    this.task.cancelled = true;
    this.taskRun?.cancel();
    return this.view();
  }

  // ---- views -------------------------------------------------------------------------------------

  jobView(j) {
    return {
      id: j.id, status: j.status, stage: j.stage, percent: Math.round(j.percent || 0), bar: j.bar, kind: j.kind,
      label: j.kind === 'url' ? j.label : path.basename(j.label), artist: j.artist, title: j.title, lyrics: !!j.lyrics.trim(),
      out: j.out, error: j.error, now: j.now, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
      lines: j.lines.slice(-40), result: j.result ? { ...j.result } : null, lyricsFrom: j.lyricsFrom || (j.lyrics.trim() ? 'typed' : ''),
      duration: j.duration || 0, estimate: j.finishedAt ? null : this.estimate(j), times: j.times || null, timer: j.timer || '',
    };
  }

  /** The host's view (state.maker). */
  view() {
    const w = this.where;
    return {
      enabled: !!this.tool,
      where: w ? { root: w.root, hasRoot: w.hasRoot, installed: w.installed, installer: !!w.installer, legacy: w.legacy || '', bundled: w.bundled || '', reuseModels: !!w.legacyModels } : null,
      checks: this.checks,
      checking: this.checking,
      out: this.out(),
      outProblem: this.outInfo().problem,
      task: this.task ? { kind: this.task.kind, status: this.task.status, code: this.task.code, bar: this.task.bar, lines: this.task.lines.slice(-60) } : null,
      jobs: this.jobs.map((j) => this.jobView(j)),
      waitsDuringSongs: !this.onGpu() && !this.settings.get('maker.duringSongs'),
      specs: this.specs || null,
      verdict: this.verdict || null,
      specsAt: this.specsAt || 0,
      whisperModel: this.whisperModel(),
      lyricTimer: this.lyricTimer(), // '' = this autokaraoke has Whisper only (before 0.4.0)
      // seconds a 4-minute song takes on this PC, once it has made one (else null)
      typical: this.speed.estimate({ duration: 240, demucsModel: this.settings.get('maker.demucsModel'),
        whisperModel: this.timingModel({ lyricTimer: this.lyricTimer(), language: this.settings.get('maker.language'), whisperModel: this.whisperModel() }) }),
      lookup: !!this.checks?.features?.lookup,
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.waitTimer);
    this.running?.run?.cancel();
    this.taskRun?.cancel();
  }
}
