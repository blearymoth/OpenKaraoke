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
 */
export async function scanLibrary(roots, { previous = new Map(), onProgress, signal, concurrency = 8 } = {}) {
  const tracks = [];
  const errors = [];
  const rootsOnline = [];
  let dirsDone = 0;
  let lastReport = 0;
  const queue = [];

  for (let r = 0; r < roots.length; r++) {
    try {
      const st = await fs.stat(roots[r]);
      if (st.isDirectory()) { queue.push({ root: r, rel: '' }); rootsOnline.push(r); }
      else errors.push({ path: roots[r], error: 'Not a folder' });
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
      if (ent.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(abs, name));
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }
      if (isDir) {
        if (!SKIP_DIRS.has(name.toLowerCase())) queue.push({ root, rel: rel ? `${rel}/${name}` : name });
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

export function previousKey(t) {
  return `${t.root}\u0000${t.dir}\u0000${t.name}`;
}
