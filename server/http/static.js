// Static files and byte-range responses (media seeking needs HTTP Range → 206).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Lru, memoPromise } from '../util/lru.js';

const gzip = promisify(zlib.gzip);

export const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
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
  vob: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  cdg: 'application/octet-stream',
};

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|manifest\+json)|image\/svg\+xml)/;
const gzCache = new Lru({ max: 200, maxBytes: 32 * 1024 * 1024 });

export function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function isFresh(req, etag) {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;
  return inm.split(',').some((t) => t.trim() === etag || t.trim() === '*');
}

/**
 * Resolves `rel` (URL-decoded, relative) inside `root`. Returns null when the path would
 * escape the root, contains a NUL byte, or points at a hidden file/folder.
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/**
 * Parses a single-range `Range` header.
 * @returns {null | 'unsatisfiable' | {start: number, end: number}} null = send everything
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or garbage: ignore it
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n || !size) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function rangeHead(req, res, size, headers) {
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'content-length': 0 });
    res.end();
    return null;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const h = { 'accept-ranges': 'bytes', ...headers, 'content-length': size ? end - start + 1 : 0 };
  if (range) h['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, h);
  if (req.method === 'HEAD' || !size) {
    res.end();
    return null;
  }
  return { start, end };
}

/**
 * Streams (part of) a file honouring Range / If-None-Match. `st` = fs.Stats if already known.
 * `offset`/`length` expose only a slice of the file (e.g. a stored entry inside a zip).
 */
export async function sendFile(req, res, abs, { st, contentType, cacheControl = 'no-cache', etag, offset = 0, length } = {}) {
  st ||= await fsp.stat(abs);
  const size = length ?? st.size - offset;
  const tag = etag || `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': contentType || mimeFor(abs),
    etag: tag,
    'last-modified': st.mtime.toUTCString(),
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  };
  if (isFresh(req, tag)) {
    res.writeHead(304, { etag: tag, 'cache-control': cacheControl });
    res.end();
    return;
  }
  const r = rangeHead(req, res, size, headers);
  if (!r) return;
  const stream = fs.createReadStream(abs, { start: offset + r.start, end: offset + r.end, highWaterMark: 256 * 1024 });
  await pipeline(stream, res).catch(() => {}); // client went away (seeking, skipping) — normal
}

/** Sends an in-memory buffer honouring Range / If-None-Match. */
export function sendBuffer(req, res, buf, { contentType = 'application/octet-stream', cacheControl = 'no-cache', etag, encoding } = {}) {
  const headers = { 'content-type': contentType, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' };
  if (etag) {
    headers.etag = etag;
    if (isFresh(req, etag)) {
      res.writeHead(304, { etag, 'cache-control': cacheControl });
      res.end();
      return;
    }
  }
  if (encoding) {
    // Encoded bodies are sent whole (ranges would refer to the encoded bytes).
    res.writeHead(200, { ...headers, 'content-encoding': encoding, vary: 'Accept-Encoding', 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }
  const r = rangeHead(req, res, buf.length, headers);
  if (!r) return;
  res.end(buf.subarray(r.start, r.end + 1));
}

/**
 * Serves `rel` from `root` (app files). Text files are gzipped (cached in memory).
 * Returns false when the file doesn't exist so the caller can 404.
 */
export async function serveStatic(req, res, root, rel, { cacheControl = 'no-cache' } = {}) {
  const abs = safeJoin(root, rel);
  if (!abs) return false;
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = mimeFor(abs);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (COMPRESSIBLE.test(type) && st.size > 1024 && st.size < 8 * 1024 * 1024 && acceptsGzip(req) && !req.headers.range) {
    if (isFresh(req, etag)) {
      res.writeHead(304, { etag, 'cache-control': cacheControl, vary: 'Accept-Encoding' });
      res.end();
      return true;
    }
    const gz = await memoPromise(gzCache, `${abs}:${etag}`, async () => gzip(await fsp.readFile(abs), { level: 6 }));
    sendBuffer(req, res, gz, { contentType: type, cacheControl, etag, encoding: 'gzip' });
    return true;
  }
  await sendFile(req, res, abs, { st, contentType: type, cacheControl, etag });
  return true;
}
