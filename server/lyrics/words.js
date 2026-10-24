// A disc's words (PLAN §31.16): for a CD+G version that has a vocal — a multiplex disc's guide
// singer, or a version the host separated (§30) — autokaraoke times lyrics against that vocal
// (`autokaraoke words`): the ones the host pasted, else looked up, else what Whisper hears. The
// result is data/lyrics/<trackId>/words.json; the disc's files and its CDG are never touched. Then
// the TV can write the disc's real words (§9.7) and the lyrics editor can fix them, as for a song
// made here. One job per track; each waits for the vocal (a multiplex one is separated first), then
// for the heavy-job lane, and — on a PC without a graphics card — for the song on stage to end.
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { cleanLyrics } from '../../shared/maker.js';
import { readMakeLine, LYRICS_SOURCES } from '../maker/autokaraoke.js';

const log = logger('words');
const WAIT_MS = 2000; // how often a job waiting for the song to end looks again
const KEEP = 12; // finished jobs shown

export const WORD_STATES = {
  vocal: 'Separating the singer',
  waiting: 'Waiting for the song to end',
  queued: 'Waiting its turn',
  working: 'Finding the words',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export class WordJobs {
  /**
   * @param {object} o
   * @param {import('./edits.js').LyricEdits} o.edits
   * @param {import('../maker/jobs.js').Maker} o.maker  autokaraoke, its lane and settings
   * @param {(trackId: string, cancelled: () => boolean) => Promise<string>} o.vocalFor  the vocal's file
   *   once it is ready (a multiplex disc's is separated first); throws a UserError when the version has none
   * @param {(trackId: string) => { artist: string, title: string, duration: number }|null} o.songOf
   * @param {() => void} [o.onChange]
   */
  constructor({ edits, maker, vocalFor, songOf, onChange = () => {} }) {
    this.edits = edits;
    this.maker = maker;
    this.vocalFor = vocalFor;
    this.songOf = songOf;
    this.onChange = onChange;
    this.jobs = new Map(); // trackId → job
  }

  /** Why a version's words can't be found now ('' = they can). */
  problem() {
    const m = this.maker;
    if (!m?.tool) return 'The Karaoke maker is not available.';
    if (!m.where?.installed) return 'Install the Karaoke maker first (Settings → Karaoke maker).';
    if (m.checks && !m.checks.features?.words) return 'Update the Karaoke maker first (Settings → Karaoke maker): this copy can’t find a disc’s words.';
    return '';
  }

  /** Host: find the words of a version. input: { lyrics?: string, lookup?: boolean }. */
  async start(trackId, input = {}) {
    const track = this.edits.library.catalog.track(trackId);
    if (!track) throw new UserError('That version is not in the library (it may have been rescanned).', { status: 404 });
    const f = this.edits.files(track);
    if (!f) throw new UserError('Only CD+G versions can get their words.');
    if ((await this.edits.source(track))?.kind === 'made') throw new UserError('This song was made here: its words are already there (Edit lyrics).');
    const problem = this.problem();
    if (problem) throw new UserError(problem);
    const old = this.jobs.get(trackId);
    if (old && ['vocal', 'waiting', 'queued', 'working'].includes(old.state)) throw new UserError('Its words are already being found.');
    const lyrics = cleanLyrics(input.lyrics);
    const s = this.maker.settings;
    const lookup = !lyrics && input.lookup !== false && !!this.maker.checks?.features?.lookup;
    const job = {
      trackId, state: 'vocal', error: '', at: Date.now(), lyrics,
      sources: lookup ? (s.get('maker.lyricsSources') || []).filter((x) => LYRICS_SOURCES.includes(x)) : [],
      language: s.get('maker.language') || '', lyricsFrom: lyrics ? 'typed' : '', lines: 0, run: null,
    };
    this.jobs.set(trackId, job);
    this.trim();
    this.onChange();
    void this.run(job);
    return this.jobView(job);
  }

  async run(job) {
    const { trackId } = job;
    let release = null;
    try {
      const vocals = await this.vocalFor(trackId, () => job.state === 'cancelled');
      if (job.state === 'cancelled') return;
      while (this.maker.mustWait({ now: false })) { // (no graphics card, a song on, maker.duringSongs off)
        if (job.state !== 'waiting') this.set(job, 'waiting');
        await new Promise((r) => setTimeout(r, WAIT_MS).unref?.());
        if (job.state === 'cancelled') return;
      }
      this.set(job, 'queued');
      release = this.maker.lane ? await this.maker.lane.acquire('words') : () => {};
      if (job.state === 'cancelled') return;
      this.set(job, 'working');
      const dir = this.edits.dir(trackId);
      await fs.mkdir(dir, { recursive: true });
      const output = path.join(dir, 'words.new.json');
      const lyricsFile = job.lyrics ? path.join(dir, 'words-lyrics.txt') : '';
      if (lyricsFile) await fs.writeFile(lyricsFile, `${job.lyrics}\n`);
      const song = this.songOf(trackId) || {};
      const lines = [];
      job.run = this.maker.tool.start(this.maker.where, 'words', {
        vocals, output, lyricsFile, lyricsSources: job.sources, artist: song.artist || '', title: song.title || '', duration: song.duration || 0,
        language: job.language, whisperModel: this.maker.whisperModel(),
        onLine: (l) => {
          lines.push(l);
          const r = readMakeLine(l);
          if (r.lyricsFrom && r.lyricsFrom !== 'looking') {
            job.lyricsFrom = r.lyricsFrom;
            this.onChange();
          }
        },
      });
      const { code } = await job.run.done;
      job.run = null;
      await Promise.all([lyricsFile, path.join(dir, 'words.lyrics.txt')].filter(Boolean).map((p) => fs.rm(p, { force: true })));
      if (job.state === 'cancelled') return void (await fs.rm(output, { force: true }));
      const done = lines.map((l) => /^Words: (\d+) lines/.exec(l)).find(Boolean);
      if (code !== 0 || !done) {
        await fs.rm(output, { force: true });
        const why = [...lines].reverse().find((l) => /error/i.test(l)) || lines.at(-1) || `autokaraoke stopped (${code})`;
        throw new UserError(`The words could not be found: ${why.replace(/^error:\s*/i, '').slice(0, 200)}`);
      }
      await this.edits.setWords(trackId, output);
      job.lines = Number(done[1]);
      this.set(job, 'done');
    } catch (e) {
      if (job.state === 'cancelled') return;
      if (!(e instanceof UserError)) log.info(`words for ${trackId} failed: ${e.message}`);
      job.error = e instanceof UserError ? e.message : 'Something went wrong — see the log.';
      this.set(job, 'failed');
    } finally {
      release?.();
    }
  }

  set(job, state) {
    job.state = state;
    this.onChange();
  }

  /** Host: stop finding a version's words. */
  cancel(trackId) {
    const job = this.jobs.get(trackId);
    if (!job || !['vocal', 'waiting', 'queued', 'working'].includes(job.state)) return false;
    job.state = 'cancelled';
    job.run?.cancel();
    this.onChange();
    return true;
  }

  dismiss(trackId) {
    const job = this.jobs.get(trackId);
    if (!job || ['vocal', 'waiting', 'queued', 'working'].includes(job.state)) return false;
    this.jobs.delete(trackId);
    this.onChange();
    return true;
  }

  trim() {
    const finished = [...this.jobs.values()].filter((j) => !['vocal', 'waiting', 'queued', 'working'].includes(j.state)).sort((a, b) => b.at - a.at);
    for (const j of finished.slice(KEEP)) this.jobs.delete(j.trackId);
  }

  jobView(j) {
    const song = this.songOf(j.trackId) || {};
    return {
      trackId: j.trackId, state: j.state, label: WORD_STATES[j.state], error: j.error, at: j.at, lines: j.lines,
      lyricsFrom: j.lyricsFrom, title: song.title || '', artist: song.artist || '',
    };
  }

  /** The host's view: the jobs, newest first. */
  view() {
    return [...this.jobs.values()].sort((a, b) => b.at - a.at).map((j) => this.jobView(j));
  }

  rekey(moves) {
    for (const m of Array.isArray(moves) ? moves : []) {
      const j = m && this.jobs.get(m.from);
      if (!j || m.from === m.to) continue;
      this.jobs.delete(m.from);
      j.trackId = m.to;
      this.jobs.set(m.to, j);
    }
  }

  close() {
    for (const j of this.jobs.values()) j.run?.cancel();
  }
}
