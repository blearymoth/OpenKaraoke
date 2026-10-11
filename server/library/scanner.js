// Walks library folders and finds karaoke tracks:
//  - CDG graphics + audio pairs (MP3/M4A/OGG/FLAC/WAV) sharing a base name
//  - video karaoke files (MP4/WEBM/MKV/...)
//  - zipped MP3+G tracks
import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTS, VIDEO_EXTS } from './parse.js';
import { listZip } from './zip.js';

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '.trash', '.trashes', '.git', 'node_modules', '@eadir', '.thumbnails']);
const AUDIO_PREF = ['mp3', 'm4a', 'ogg', 'opus', 'aac', 'flac', 'wav', 'oga'];
export const CDG_BYTES_PER_SECOND = 7200; // 300 packets of 24 bytes

/**
 * @param {string[]} roots absolute folder paths
 * @param {object} opts
 * @param {Map<string, object>} [opts.previous] key `${root}\u0000${dir}\u0000${name}` -> previous raw track
 * @param {(p: object) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {number[]} [opts.only] scan only these roots (indexes into `roots`); default all
 *
 * A root inside another root is that root's own: the outer one skips its folder, so no track
 * is found twice (e.g. ~/Music and ~/Music/YouTube Downloads both added).
 */
export async function scanLibrary(roots, { previous = new Map(), onProgress, signal, concurrency = 8, only = null } = {}) {
  const tracks = [];
  const errors = [];
  const rootsOnline = [];
  let dirsDone = 0;
  let lastReport = 0;
  const queue = [];
  // Real paths too: a root reached through a symbolic link, or a link inside one root that leads
  // to another, is still found once.
  const real = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => path.resolve(r))));
  const nestedReal = nestedRoots(real);
  const nested = nestedRoots(roots).map((inner, i) => new Set([...inner, ...nestedReal[i]]));

  for (let r = 0; r < roots.length; r++) {
    if (only && !only.includes(r)) continue;
    try {
      const st = await fs.stat(roots[r]);
      if (!st.isDirectory()) errors.push({ path: roots[r], error: 'Not a folder' });
      else {
        rootsOnline.push(r);
        if (!nested[r].has('')) queue.push({ root: r, rel: '' }); // (the same folder as an earlier root: found there)
      }
    } catch (e) {
      errors.push({ path: roots[r], error: e.code === 'ENOENT' ? 'Folder not found (is the drive plugged in?)' : e.message });
    }
  }

  const report = (force = false) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 250)) return;
    lastReport = now;
    onProgress({ dirs: dirsDone, tracks: tracks.length, queued: queue.length });
  };

  async function readDir({ root, rel }) {
    const abs = rel ? path.join(roots[root], rel) : roots[root];
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: abs, error: e.message });
      return;
    }
    const groups = new Map();
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.') || name.startsWith('._')) continue;
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      let link = false;
      if (ent.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(abs, name));
          isDir = st.isDirectory();
          isFile = st.isFile();
          link = isDir;
        } catch { continue; }
      }
      if (isDir) {
        const childRel = rel ? `${rel}/${name}` : name;
        if (SKIP_DIRS.has(name.toLowerCase()) || nested[root].has(childRel)) continue; // (another root: scanned as itself)
        if (link) {
          const to = await fs.realpath(path.join(abs, name)).catch(() => '');
          if (real.some((x, i) => i !== root && x === to)) continue;
        }
        queue.push({ root, rel: childRel });
        continue;
      }
      if (!isFile) continue;
      const dot = name.lastIndexOf('.');
      if (dot <= 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (ext !== 'cdg' && ext !== 'zip' && !AUDIO_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue;
      const base = name.slice(0, dot);
      const key = base.toLowerCase();
      let g = groups.get(key);
      if (!g) { g = { base, audio: {}, video: null, cdg: null, zip: null }; groups.set(key, g); }
      if (ext === 'cdg') { g.cdg = name; g.base = base; }
      else if (ext === 'zip') g.zip = name;
      else if (AUDIO_EXTS.has(ext)) g.audio[ext] = name;
      else g.video = name;
    }

    const jobs = [];
    for (const g of groups.values()) {
      const audioExt = AUDIO_PREF.find((e) => g.audio[e]);
      const prevKey = `${root}\u0000${rel}\u0000${g.base}`;
      const prev = previous.get(prevKey);
      if (g.cdg && audioExt) {
        const t = { root, dir: rel, name: g.base, kind: 'cdg', cdg: g.cdg, audio: g.audio[audioExt], size: 0, duration: 0 };
        if (prev && prev.kind === 'cdg' && prev.cdg === g.cdg && prev.audio === t.audio && prev.size) {
          t.size = prev.size; t.duration = prev.duration; t.mtime = prev.mtime;
          tracks.push(t);
        } else {
          jobs.push(fs.stat(path.join(abs, g.cdg)).then((st) => {
            t.size = st.size;
            t.mtime = Math.round(st.mtimeMs);
            t.duration = Math.round((st.size / CDG_BYTES_PER_SECOND) * 10) / 10;
            tracks.push(t);
          }, (e) => errors.push({ path: path.join(abs, g.cdg), error: e.message })));
        }
      } else if (g.video) {
        const t = { root, dir: rel, name: g.base, kind: 'video', video: g.video, size: 0, duration: prev?.duration || 0 };
        if (prev && prev.kind === 'video' && prev.video === g.video && prev.size) {
          t.size = prev.size; t.mtime = prev.mtime;
          tracks.push(t);
        } else {
          jobs.push(fs.stat(path.join(abs, g.video)).then((st) => {
            t.size = st.size;
            t.mtime = Math.round(st.mtimeMs);
            tracks.push(t);
          }, (e) => errors.push({ path: path.join(abs, g.video), error: e.message })));
        }
      } else if (g.zip) {
        if (prev && prev.kind === 'zip' && prev.zip === g.zip && prev.entries) {
          tracks.push({ ...prev });
          continue;
        }
        jobs.push(listZip(path.join(abs, g.zip)).then((entries) => {
          const files = entries.filter((e) => !e.name.endsWith('/'));
          const cdg = files.find((e) => e.name.toLowerCase().endsWith('.cdg'));
          const audio = AUDIO_PREF.map((x) => files.find((e) => e.name.toLowerCase().endsWith('.' + x))).find(Boolean);
          const video = files.find((e) => VIDEO_EXTS.has(e.name.split('.').pop().toLowerCase()));
          if (cdg && audio) {
            tracks.push({
              root, dir: rel, name: g.base, kind: 'zip', zip: g.zip,
              entries: { cdg, audio },
              size: cdg.usize, duration: Math.round((cdg.usize / CDG_BYTES_PER_SECOND) * 10) / 10,
            });
          } else if (video) {
            tracks.push({ root, dir: rel, name: g.base, kind: 'zip', zip: g.zip, entries: { video }, size: video.usize, duration: 0 });
          }
        }, (e) => errors.push({ path: path.join(abs, g.zip), error: e.message })));
      }
    }
    if (jobs.length) await Promise.all(jobs);
    dirsDone++;
    report();
  }

  const pending = new Set();
  while (queue.length || pending.size) {
    if (signal?.aborted) break;
    while (queue.length && pending.size < concurrency) {
      const job = queue.pop();
      const p = readDir(job).finally(() => pending.delete(p));
      pending.add(p);
    }
    if (pending.size) await Promise.race(pending);
  }
  if (pending.size) await Promise.allSettled([...pending]);
  report(true);
  return { tracks, errors, rootsOnline, aborted: !!signal?.aborted, dirs: dirsDone };
}

/**
 * For each root, the folders (relative, '/'-separated) that are other roots: they belong to
 * those roots, not to this one. Two equal roots: the later one is left to the first.
 */
export function nestedRoots(roots) {
  const abs = roots.map((r) => path.resolve(String(r)));
  return abs.map((outer, i) => {
    const inner = new Set();
    abs.forEach((p, j) => {
      if (i === j) return;
      const rel = path.relative(outer, p);
      if (rel === '') {
        if (j < i) inner.add(''); // (the same folder as an earlier root: nothing of its own)
      } else if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) inner.add(rel.split(path.sep).join('/'));
    });
    return inner;
  });
}

/** True when a track's folder (`dir`, relative to its root) is inside one of `inner` (nestedRoots()). */
export function inNestedRoot(dir, inner) {
  if (!inner.size) return false;
  if (inner.has('')) return true;
  for (const x of inner) if (dir === x || dir.startsWith(`${x}/`)) return true;
  return false;
}

export function previousKey(t) {
  return `${t.root}\u0000${t.dir}\u0000${t.name}`;
}
