// The release year written in the MP3 files' own ID3 tags, read in the background and kept in
// data/tagyears.json by song key. It sits between the host's own year and the online one
// (library/songmeta.js apply): a year someone put in the file beats Deezer's album date (which
// can be a compilation's or a reissue's), and the host's own year still beats both.
// A file is read again only when its size or time changed, so a later pass is only stat calls.
import fs from 'node:fs/promises';
import { JsonDoc } from '../util/jsonfile.js';
import { slicer, abortError } from '../util/slice.js';
import { id3Size, id3Year } from './id3.js';
import { MIN_YEAR, maxYear } from './songmeta.js';

const MAX_TAG_BYTES = 256 * 1024;
const TRACKS_PER_SONG = 3;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class TagYears {
  constructor(file, { now = () => Date.now() } = {}) {
    this.doc = new JsonDoc(file, { version: 1, songs: {} }, { debounceMs: 3000 });
    this.songs = Object.create(null); // song key → { year (0 = read, none), f, size, mtime }
    this.now = now;
    this.running = null;
    this.again = false;
    this.onChange = null;
    this.stopped = false;
    this.controller = null;
  }

  async load() {
    const raw = await this.doc.load();
    const src = raw.songs && typeof raw.songs === 'object' ? raw.songs : {};
    for (const [key, r] of Object.entries(src)) {
      if (BAD_KEYS.has(key) || !r || typeof r !== 'object' || typeof r.f !== 'string') continue;
      this.songs[key] = { year: Number.isInteger(r.year) ? r.year : 0, f: r.f, size: r.size || 0, mtime: r.mtime || 0 };
    }
    this.doc.data = { version: 1, songs: this.songs };
    return this;
  }

  /** The year in a song's file tag, or 0. */
  get(key) {
    if (typeof key !== 'string' || BAD_KEYS.has(key) || !Object.hasOwn(this.songs, key)) return 0;
    const y = this.songs[key].year;
    return y >= MIN_YEAR && y <= maxYear(this.now()) ? y : 0;
  }

  get size() {
    let n = 0;
    for (const k in this.songs) if (this.songs[k].year) n++;
    return n;
  }

  /** Reads the tags of every song whose file is new or changed. One pass at a time; a call during one asks for another. */
  scan(library) {
    if (this.stopped) return Promise.resolve(0);
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.controller = new AbortController();
    this.running = this.pass(library, this.controller.signal)
      .catch((e) => { if (e.name !== 'AbortError') throw e; return 0; })
      .finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.scan(library).catch(() => {});
        }
      });
    return this.running;
  }

  async pass(library, signal) {
    const cat = library.catalog;
    const tick = slicer(signal, 12);
    let changed = 0;
    for (const song of cat.songList) {
      let first = null;
      let year = 0;
      let used = null;
      for (const id of song.trackIds.slice(0, TRACKS_PER_SONG)) {
        const t = cat.track(id);
        if (!t || !t.audio || !/\.mp3$/i.test(t.audio) || !library.isTrackOnline(t)) continue;
        const file = library.absPath(t, 'audio');
        if (!file) continue;
        let st;
        try { st = await fs.stat(file); } catch { continue; }
        first ||= { f: t.audio, size: st.size, mtime: Math.floor(st.mtimeMs) };
        const have = this.songs[song.key];
        if (have && have.f === t.audio && have.size === st.size && have.mtime === Math.floor(st.mtimeMs)) { used = have; break; }
        const y = await readYear(file, signal);
        if (y) { year = y; used = { year: y, f: t.audio, size: st.size, mtime: Math.floor(st.mtimeMs) }; break; }
        await tick();
      }
      if (!used && first) used = { year: 0, ...first };
      if (used) {
        const old = this.songs[song.key];
        if (used !== old) {
          if ((old?.year || 0) !== used.year) changed++;
          this.songs[song.key] = used;
          this.doc.save();
        }
      }
      await tick();
    }
    if (changed) this.onChange?.(changed);
    return changed;
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
  }

  flush() { return this.doc.flush(); }
  discard() { this.doc.discard(); }
}

async function readYear(file, signal) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const head = Buffer.alloc(10);
    const { bytesRead } = await fh.read(head, 0, 10, 0);
    if (bytesRead < 10) return 0;
    const size = id3Size(head);
    if (!size || size > MAX_TAG_BYTES) return 0;
    const buf = Buffer.alloc(size);
    const r = await fh.read(buf, 0, size, 0);
    if (signal?.aborted) throw abortError();
    return id3Year(buf.subarray(0, r.bytesRead));
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return 0;
  } finally {
    await fh?.close().catch(() => {});
  }
}
