// Static files and byte-range responses (audio/video seeking needs HTTP Range).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { text } from './router.js';

export const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  vob: 'video/mpeg',
  cdg: 'application/octet-stream',
};

export function mimeOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;

export function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

/**
 * Parses a single `Range: bytes=…` header.
 * @returns {{start:number,end:number}|null|'invalid'} null = no/ignored range
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // multiple ranges or other units: serve the whole file
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return 'invalid';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

function notModified(req, etag) {
  const inm = req.headers['if-none-match'];
  if (!inm || !etag) return false;
  return inm.split(/\s*,\s*/).some((t) => t === etag || t === '*' || t.replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

function rangeFor(req, size, etag) {
  const ifRange = req.headers['if-range'];
  if (ifRange && etag && ifRange !== etag) return null;
  return parseRange(req.headers.range, size);
}

/**
 * Streams (a slice of) a file with Range/ETag/HEAD support.
 * `offset`/`length` expose part of a bigger file (e.g. a stored zip entry).
 */
export async function sendFile(req, res, file, { type, stat, cacheControl = 'private, max-age=3600', offset = 0, length, etag } = {}) {
  const st = stat || await fsp.stat(file);
  const size = length ?? st.size;
  const tag = etag || `W/"${size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const headers = {
    'content-type': type || mimeOf(file),
    'accept-ranges': 'bytes',
    etag: tag,
    'last-modified': st.mtime.toUTCString(),
    'cache-control': cacheControl,
  };
  if (notModified(req, tag)) { res.writeHead(304, headers); res.end(); return; }
  const range = rangeFor(req, size, tag);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  let start = 0;
  let end = size - 1;
  if (range) {
    ({ start, end } = range);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
  }
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = fs.createReadStream(file, { start: offset + start, end: offset + end });
  pipeline(stream, res, () => {});
}

/** Sends an in-memory buffer with Range/ETag support; gzips it when allowed and useful. */
export function sendBuffer(req, res, buf, { type = 'application/octet-stream', etag, cacheControl = 'private, max-age=3600', gzipped } = {}) {
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cacheControl, vary: 'accept-encoding' };
  if (etag) headers.etag = etag;
  if (notModified(req, etag)) { res.writeHead(304, headers); res.end(); return; }
  const range = rangeFor(req, buf.length, etag);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${buf.length}` });
    res.end();
    return;
  }
  if (range) {
    const part = buf.subarray(range.start, range.end + 1);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${buf.length}`, 'content-length': part.length });
    res.end(req.method === 'HEAD' ? undefined : part);
    return;
  }
  if (gzipped && acceptsGzip(req)) {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': gzipped.length });
    res.end(req.method === 'HEAD' ? undefined : gzipped);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': buf.length });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/** Resolves `rel` inside `root`, or null if it escapes the folder. */
export function safeJoin(root, rel) {
  if (rel.includes('\0')) return null;
  const abs = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

const gzCache = new Map(); // abs path -> { key, gz }

/** Serves a file from a public folder: ETag, gzip for text, no directory listings. */
export async function serveStatic(req, res, root, rel, { cacheControl = 'no-cache' } = {}) {
  const abs = safeJoin(root, rel);
  if (!abs) { text(res, 403, 'Forbidden'); return; }
  let st;
  try { st = await fsp.stat(abs); } catch { text(res, 404, 'Not found'); return; }
  if (!st.isFile()) { text(res, 404, 'Not found'); return; }
  const type = mimeOf(abs);
  if (COMPRESSIBLE.test(type) && st.size > 1024 && st.size < 8 << 20 && acceptsGzip(req) && !req.headers.range) {
    const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { 'content-type': type, etag, 'cache-control': cacheControl, vary: 'accept-encoding' };
    if (notModified(req, etag)) { res.writeHead(304, headers); res.end(); return; }
    let entry = gzCache.get(abs);
    if (!entry || entry.key !== etag) {
      const raw = await fsp.readFile(abs);
      entry = { key: etag, gz: zlib.gzipSync(raw, { level: 6 }) };
      gzCache.set(abs, entry);
    }
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': entry.gz.length });
    res.end(req.method === 'HEAD' ? undefined : entry.gz);
    return;
  }
  await sendFile(req, res, abs, { type, stat: st, cacheControl });
}
