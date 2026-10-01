import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export async function readJson(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // Keep a copy of a corrupt file instead of silently overwriting it.
    try { await fs.copyFile(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return fallback;
  }
}

export async function writeJsonAtomic(file, data, { pretty = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  await fs.rename(tmp, file);
}

export function writeJsonAtomicSync(file, data, { pretty = false } = {}) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsSync.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fsSync.renameSync(tmp, file);
}

/** A JSON document persisted with debounced atomic writes. */
export class JsonDoc {
  constructor(file, defaults = {}, { debounceMs = 800, pretty = false } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.debounceMs = debounceMs;
    this.pretty = pretty;
    this.timer = null;
    this.writing = null;
  }

  async load() {
    const loaded = await readJson(this.file, null);
    if (loaded && typeof loaded === 'object') this.data = deepMerge(structuredClone(this.defaults), loaded);
    return this.data;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => console.error('save failed', this.file, e));
    }, this.debounceMs);
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const snapshot = JSON.parse(JSON.stringify(this.data));
    // A failed write must not poison every later save.
    const prev = (this.writing || Promise.resolve()).catch(() => {});
    this.writing = prev.then(() => writeJsonAtomic(this.file, snapshot, { pretty: this.pretty }));
    return this.writing;
  }

  /** Drops a pending save (a server that could not start must not overwrite the files). */
  discard() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  flushSync() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    writeJsonAtomicSync(this.file, this.data, { pretty: this.pretty });
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge `patch` into `base` (mutates and returns base). Arrays are replaced. */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}
