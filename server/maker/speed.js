// How fast this PC makes songs (PLAN §31.2 "measure, don't guess"). Every finished make prints
// `Times: download 12s, separate 95s, mp3 3s, timing 40s, cdg 2s`; each stage's seconds per minute
// of song are kept (the last few, per model) in data/maker/speed.json, and a job whose length is
// known gets "about N minutes". Nothing is shown until this PC has made a song with those models.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP = 5; // the last few makes per stage
const STAGES = ['download', 'separate', 'mp3', 'timing', 'cdg'];
const KEY = /^(download|separate|mp3|timing|cdg)(?::[\w.-]{1,40})?$/;

/** The key a stage's speed is kept under: separation per vocal remover, timing per lyric timer. */
export function stageKey(stage, { demucsModel = 'htdemucs', whisperModel = 'medium' } = {}) {
  if (stage === 'separate') return `separate:${demucsModel}`;
  if (stage === 'timing') return `timing:${whisperModel}`;
  return stage;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class Speed {
  /** @param {{ file: string }} o */
  constructor({ file }) {
    this.file = file;
    this.rates = {}; // key → [seconds per minute of song, …] (newest last)
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [k, v] of Object.entries(d?.rates || {})) {
        if (KEY.test(k) && Array.isArray(v)) this.rates[k] = v.filter((x) => Number.isFinite(x) && x >= 0 && x < 36000).slice(-KEEP);
      }
    } catch { /* none yet */ }
    return this;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.part`, `${JSON.stringify({ rates: this.rates }, null, 1)}\n`);
    await fs.rename(`${this.file}.part`, this.file);
  }

  /**
   * One finished make: `times` from its Times line (a stage that was cached is null and teaches
   * nothing), `duration` the song's length in seconds.
   */
  record({ times, duration, demucsModel, whisperModel }) {
    const minutes = duration / 60;
    if (!times || !(minutes > 0.1)) return false;
    let any = false;
    for (const stage of STAGES) {
      const s = times[stage];
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) continue;
      const key = stageKey(stage, { demucsModel, whisperModel });
      this.rates[key] = [...(this.rates[key] || []), Math.round((s / minutes) * 100) / 100].slice(-KEEP);
      any = true;
    }
    return any;
  }

  /**
   * Seconds a song of `duration` seconds is likely to take, or null when this PC hasn't made one
   * with these models yet. `url`: it is downloaded first (counted only once a download was timed).
   */
  estimate({ duration, url = false, demucsModel, whisperModel }) {
    const minutes = duration / 60;
    if (!(minutes > 0)) return null;
    const rate = (stage) => {
      const r = this.rates[stageKey(stage, { demucsModel, whisperModel })];
      return r?.length ? median(r) : null;
    };
    const separate = rate('separate');
    const timing = rate('timing');
    if (separate === null || timing === null) return null;
    const rest = (rate('mp3') || 0) + (rate('cdg') || 0) + (url ? rate('download') || 0 : 0);
    return Math.round((separate + timing + rest) * minutes);
  }
}

export { aboutMinutes } from '../../shared/maker.js';
