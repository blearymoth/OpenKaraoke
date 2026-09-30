// Tiny HTTP router: routes with :params and a trailing * wildcard, JSON/text
// helpers and a request body reader with a size limit.
import { HttpError, UserError } from '../util/errors.js';
import { logger } from '../util/log.js';

const log = logger('http');

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * @param {string} method GET | POST | PUT | DELETE (GET routes also answer HEAD)
   * @param {string} pattern e.g. '/api/songs/:id' or '/js/*' (the wildcard becomes params.rest)
   * @param {(ctx: object) => any} handler returning a value sends it as JSON
   */
  add(method, pattern, handler) {
    const keys = [];
    const segs = pattern.replace(/\/+$/, '').split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      if (seg === '*') { keys.push('rest'); return '(.*)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    const re = new RegExp(`^${segs.join('/') || ''}/?$`);
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /** Returns { handler, params }, { allowed: [...] } for a method mismatch, or null. */
  match(method, pathname) {
    let allowed = null;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) {
        (allowed ||= new Set()).add(r.method);
        continue;
      }
      const params = {};
      for (let i = 0; i < r.keys.length; i++) {
        const v = safeDecode(m[i + 1] ?? '');
        if (v === null) return null;
        params[r.keys[i]] = v;
      }
      return { handler: r.handler, params };
    }
    return allowed ? { allowed: [...allowed] } : null;
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

export function sendText(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : buf);
}

/** Reads the request body; throws HttpError(413) above `limit` bytes. */
export async function readBody(req, limit = 1 << 20) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, `Request body too large (max ${Math.round(limit / 1024)} KB)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Request body too large (max ${Math.round(limit / 1024)} KB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, limit = 256 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function sendError(res, err) {
  const status = err instanceof UserError ? err.status : 500;
  if (status >= 500) {
    if (err?.expose) log.warn(err.message);
    else log.error(err?.stack || err);
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const headers = {};
  if (status === 413) headers.connection = 'close';
  const body = { error: err?.expose ? err.message : 'Internal server error', code: err?.code || 'error' };
  if (err?.extra) Object.assign(body, err.extra);
  json(res, status, body, headers);
}

/** Integer query parameter clamped to [min, max]. */
export function intParam(query, name, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = query.get(name);
  if (raw === null || raw === '') return def;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
