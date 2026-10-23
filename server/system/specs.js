// Is this PC up to making karaoke? (PLAN §31.2) The facts — NVIDIA graphics cards and their
// memory, processor cores, memory, free space where autokaraoke keeps its models — and a verdict
// from them: fast / fast enough / slow but fine / not recommended, with the lyric timer model that
// suits it. Checked at every start (and by "Check again"), shown in Settings → Karaoke maker, and
// used for the vocal separator's warning too. `assess` is pure (the tests); `gatherSpecs` asks the
// system (nvidia-smi through the caller's runner, never a shell).
import fs from 'node:fs/promises';
import os from 'node:os';

export const VERDICTS = {
  fast: 'Fast',
  good: 'Fast enough',
  slow: 'Slow but fine',
  no: 'Not recommended',
};

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` → [{ name, memMB }]. */
export function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(.+?)\s*,\s*(\d+)\s*$/.exec(line);
    if (m) out.push({ name: m[1].slice(0, 80), memMB: Number(m[2]) });
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The verdict for these facts. NVIDIA with ≥ 5.9 GB: fast (Whisper medium); ≥ 3.8 GB: fast enough
 * (small); else the processor: 8 cores and 16 GB, or 4 cores and 12 GB, slow but fine (small);
 * less: not recommended. Free space under 10 GB (a graphics card's build) or 6 GB is a warning.
 * → { verdict, label, model, why, warnings: [] }
 */
export function assess({ gpus = [], cores = 0, memGB = 0, freeGB = null } = {}) {
  const best = [...gpus].sort((a, b) => b.memMB - a.memMB)[0] || null;
  const gpuGB = best ? best.memMB / 1024 : 0;
  let verdict;
  let model = 'small';
  let why;
  if (gpuGB >= 5.9) {
    verdict = 'fast';
    model = 'medium';
    why = `The graphics card (${best.name}, ${round1(gpuGB)} GB) does the work: a song in a minute or two.`;
  } else if (gpuGB >= 3.8) {
    verdict = 'good';
    why = `The graphics card (${best.name}, ${round1(gpuGB)} GB) does the work, with the smaller lyric timer.`;
  } else if ((cores >= 8 && memGB >= 16) || (cores >= 4 && memGB >= 12)) {
    verdict = 'slow';
    why = `${best ? `The graphics card (${round1(gpuGB)} GB) is too small, so the` : 'No NVIDIA graphics card: the'} processor does the work (${cores} cores, ${round1(memGB)} GB) — several minutes a song.`;
  } else {
    verdict = 'no';
    why = `${cores} cores and ${round1(memGB)} GB of memory${best ? '' : ', no NVIDIA graphics card'}: a song could take very long and slow the party down.`;
  }
  const warnings = [];
  const need = gpuGB >= 3.8 ? 10 : 6;
  if (Number.isFinite(freeGB) && freeGB !== null && freeGB < need) warnings.push(`Only ${round1(freeGB)} GB free where autokaraoke keeps its models (it needs about ${need} GB).`);
  return { verdict, label: VERDICTS[verdict], model, why, warnings };
}

/** The facts on this PC. `run(file, args)` → { code, out } (execFile, never a shell). */
export async function gatherSpecs({ run, diskPaths = [os.homedir()] } = {}) {
  const smi = run ? await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']).catch(() => null) : null;
  const gpus = smi?.code === 0 ? parseNvidiaSmi(smi.out) : [];
  let freeGB = null;
  for (const p of diskPaths) {
    try {
      const st = await fs.statfs(p);
      freeGB = round1((st.bavail * st.bsize) / 2 ** 30);
      break;
    } catch { /* not there: the next one */ }
  }
  return {
    gpus,
    cores: os.availableParallelism?.() || os.cpus().length,
    memGB: round1(os.totalmem() / 2 ** 30),
    freeGB,
  };
}
