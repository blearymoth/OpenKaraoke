// /media/:trackId/(audio|cdg|video) — streams indexed tracks only (never arbitrary paths).
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { HttpError } from './router.js';
import { sendFile, sendBuffer, mimeOf } from './static.js';
import { entryDataOffset, readZipEntry } from '../library/zip.js';
import { LRU } from '../util/lru.js';

const gzip = promisify(zlib.gzip);
const PARTS = new Set(['audio', 'cdg', 'video']);

async function gzipIfSmaller(buf) {
  const gz = await gzip(buf, { level: 6 });
  return gz.length < buf.length * 0.9 ? gz : null;
}

export class MediaService {
  /** @param {{ library: import('../library/service.js').LibraryService }} o */
  constructor({ library, cdgCacheEntries = 24, zipCacheBytes = 96 << 20 }) {
    this.library = library;
    this.cdg = new LRU({ max: cdgCacheEntries, sizeOf: (v) => v.buf.length + (v.gz?.length || 0) });
    this.zip = new LRU({ max: 16, maxBytes: zipCacheBytes, sizeOf: (v) => v.buf.length });
    this.zipOffsets = new LRU({ max: 256, sizeOf: () => 1 });
  }

  register(router) {
    router.get('/media/:trackId/:part', (req, res, { params }) => this.handle(req, res, params.trackId, params.part));
  }

  resolve(trackId, part) {
    if (!PARTS.has(part)) throw new HttpError(404, 'Unknown media part');
    const track = this.library.catalog.track(trackId);
    if (!track) throw new HttpError(404, 'Unknown track');
    if (!this.library.isOnline(track)) throw new HttpError(503, 'The library drive is offline', { offline: true });
    return track;
  }

  async handle(req, res, trackId, part) {
    const track = this.resolve(trackId, part);
    try {
      if (track.kind === 'zip') return await this.sendZipPart(req, res, track, part);
      const file = track.kind === 'cdg'
        ? (part === 'cdg' ? this.library.absPath(track, 'cdg') : part === 'audio' ? this.library.absPath(track, 'audio') : null)
        : (part === 'video' ? this.library.absPath(track, 'video') : null);
      if (!file) throw new HttpError(404, `This track has no ${part}`);
      if (part === 'cdg') return await this.sendCdg(req, res, track, file);
      return await sendFile(req, res, file, { type: mimeOf(file) });
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'File is missing — rescan the library');
      throw e;
    }
  }

  async sendCdg(req, res, track, file) {
    const st = await fsp.stat(file);
    const etag = `W/"cdg-${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    let entry = this.cdg.get(track.id);
    if (!entry || entry.etag !== etag) {
      const buf = await fsp.readFile(file);
      entry = { etag, buf, gz: await gzipIfSmaller(buf) };
      this.cdg.set(track.id, entry);
    }
    sendBuffer(req, res, entry.buf, { type: 'application/octet-stream', etag, gzipped: entry.gz });
  }

  async sendZipPart(req, res, track, part) {
    const entry = track.entries?.[part];
    if (!entry) throw new HttpError(404, `This track has no ${part}`);
    const file = this.library.absPath(track, 'zip');
    const st = await fsp.stat(file);
    const etag = `W/"z${part}-${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const type = part === 'cdg' ? 'application/octet-stream' : mimeOf(entry.name);
    const key = `${track.id}:${part}`;
    if (entry.method === 0 && part !== 'cdg') {
      // Stored entry: stream the byte slice straight from the zip (Range works as usual).
      let offset = this.zipOffsets.get(`${key}:${etag}`);
      if (offset === undefined) {
        offset = await entryDataOffset(file, entry);
        this.zipOffsets.set(`${key}:${etag}`, offset);
      }
      return sendFile(req, res, file, { type, stat: st, offset, length: entry.usize, etag });
    }
    let cached = this.zip.get(key);
    if (!cached || cached.etag !== etag) {
      const buf = await readZipEntry(file, entry);
      cached = { etag, buf, gz: part === 'cdg' ? await gzipIfSmaller(buf) : null };
      this.zip.set(key, cached);
    }
    return sendBuffer(req, res, cached.buf, { type, etag, gzipped: cached.gz });
  }
}
