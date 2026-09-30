// Media streaming: /media/:trackId/(audio|cdg|video).
// Only files that belong to an indexed track are ever served — never user-supplied paths.
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { HttpError } from '../util/errors.js';
import { Lru, memoPromise } from '../util/lru.js';
import { sendFile, sendBuffer, mimeFor, acceptsGzip } from './static.js';
import { readZipEntry, entryDataOffset } from '../library/zip.js';

const gzip = promisify(zlib.gzip);
const PARTS = new Set(['audio', 'cdg', 'video']);
const MAX_CDG_BYTES = 32 * 1024 * 1024; // ≈ 74 minutes
const CACHE = 'private, max-age=86400';

/** Where the bytes of one part of a track live: a file field, or an entry of the track's zip. */
export function mediaSource(track, part) {
  if (track.kind === 'cdg') {
    if (part === 'audio') return { field: 'audio', name: track.audio };
    if (part === 'cdg') return { field: 'cdg', name: track.cdg };
  } else if (track.kind === 'video') {
    if (part === 'video') return { field: 'video', name: track.video };
  } else if (track.kind === 'zip') {
    const entry = track.entries?.[part];
    if (entry) return { zipEntry: entry, name: entry.name };
  }
  return null;
}

/** Relative media URLs for a track, as used by the TV player. */
export function mediaUrls(track) {
  if (!track) return null;
  if (track.kind === 'video' || (track.kind === 'zip' && track.entries?.video)) return { kind: 'video', video: `/media/${track.id}/video` };
  return { kind: 'cdg', audio: `/media/${track.id}/audio`, cdg: `/media/${track.id}/cdg` };
}

export function mediaRoutes(router, { library }) {
  // CDG files are tiny once gzipped (mostly zero bytes) and read in one go by the TV.
  const cdgCache = new Lru({ max: 12, maxBytes: 64 * 1024 * 1024, sizeOf: (e) => (e?.raw ? e.raw.length + e.gz.length : 0) });
  // Compressed zip entries have to be inflated to serve byte ranges.
  const zipCache = new Lru({ max: 4, maxBytes: 128 * 1024 * 1024 });

  const cdgEntry = (key, load) => memoPromise(cdgCache, key, async () => {
    const raw = await load();
    return { raw, gz: await gzip(raw, { level: 6 }) };
  });

  const sendCdg = (req, res, entry, etag) => {
    if (acceptsGzip(req) && !req.headers.range && entry.gz.length < entry.raw.length) {
      return sendBuffer(req, res, entry.gz, { contentType: 'application/octet-stream', cacheControl: CACHE, etag, encoding: 'gzip' });
    }
    return sendBuffer(req, res, entry.raw, { contentType: 'application/octet-stream', cacheControl: CACHE, etag });
  };

  router.get('/media/:trackId/:part', async ({ req, res, params }) => {
    const part = params.part.replace(/\.[a-z0-9]{2,4}$/i, ''); // "/audio.mp3" works too
    if (!PARTS.has(part)) throw new HttpError(404, 'Unknown media type');
    const track = library.catalog.track(params.trackId);
    if (!track) throw new HttpError(404, 'Unknown track (the library may have been rescanned)');
    const source = mediaSource(track, part);
    if (!source) throw new HttpError(404, `This track has no ${part}`);

    try {
      if (source.zipEntry) {
        const zipPath = library.absPath(track, 'zip');
        const entry = source.zipEntry;
        if (entry.encrypted) throw new HttpError(415, 'Encrypted zip files are not supported');
        const etag = `W/"z${track.id}-${part}-${entry.usize.toString(16)}"`;
        if (part === 'cdg') return sendCdg(req, res, await cdgEntry(`z:${track.id}`, () => readZipEntry(zipPath, entry)), etag);
        if (entry.method === 0) {
          // Stored (uncompressed) entry: stream the byte range straight from the zip.
          const offset = await entryDataOffset(zipPath, entry);
          return sendFile(req, res, zipPath, { offset, length: entry.usize, contentType: mimeFor(entry.name), cacheControl: CACHE, etag });
        }
        if (entry.usize > 128 * 1024 * 1024) throw new HttpError(415, 'This zipped video is compressed and too large — unzip it into the library folder');
        const buf = await memoPromise(zipCache, `${track.id}:${part}`, () => readZipEntry(zipPath, entry));
        return sendBuffer(req, res, buf, { contentType: mimeFor(entry.name), cacheControl: CACHE, etag });
      }

      const abs = library.absPath(track, source.field);
      if (!abs) throw new HttpError(404, 'File not found');
      if (part === 'cdg') {
        const st = await fsp.stat(abs);
        if (st.size > MAX_CDG_BYTES) throw new HttpError(415, 'CDG file is too large');
        const etag = `W/"c${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        return sendCdg(req, res, await cdgEntry(`${abs}:${etag}`, () => fsp.readFile(abs)), etag);
      }
      await sendFile(req, res, abs, { contentType: mimeFor(abs), cacheControl: CACHE });
    } catch (e) {
      if (['ENOENT', 'ENOTDIR', 'EIO', 'ENODEV', 'ENXIO'].includes(e.code)) {
        const online = await library.checkOnline();
        if (!online[track.root]) throw new HttpError(503, 'The karaoke drive is not connected', { code: 'library_offline' });
        throw new HttpError(404, 'File not found — try rescanning the library');
      }
      throw e;
    }
  });
}
