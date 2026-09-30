// Tiny HTTP router: `/api/songs/:id` style params, a trailing `*` wildcard,
// JSON/text helpers and a size-limited body reader.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message || String(status));
    this.status = status;
    this.extra = extra;
  }
}

function compile(pattern) {
  const names = [];
  let re = '^';
  for (const part of pattern.split('/').filter(Boolean)) {
    if (part === '*') { names.push('rest'); re += '(?:/(.*))?'; continue; }
    re += '/';
    if (part.startsWith(':')) { names.push(part.slice(1)); re += '([^/]+)'; }
    else re += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (re === '^') re += '/';
  return { re: new RegExp(`${re}/?$`), names };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const { re, names } = compile(pattern);
    this.routes.push({ method, re, names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /** Returns false if no route matched (so the caller can fall through). */
  async handle(req, res, url = new URL(req.url, 'http://x')) {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (r.method !== method) { methodMismatch = true; continue; }
      const params = {};
      r.names.forEach((n, i) => { params[n] = m[i + 1] ?? ''; });
      try {
        await r.handler(req, res, { params, query: url.searchParams, url, pathname });
      } catch (e) {
        sendError(res, e);
      }
      return true;
    }
    if (methodMismatch) {
      sendError(res, new HttpError(405, 'Method not allowed'));
      return true;
    }
    return false;
  }
}

export function sendError(res, e) {
  const status = e instanceof HttpError ? e.status : 500;
  if (status >= 500) console.error('[http]', e);
  if (res.headersSent) { res.destroy(); return; }
  json(res, status, { error: e instanceof HttpError ? e.message : 'Internal error', ...(e.extra || {}) });
}

export function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

export function text(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { location, 'content-length': 0 });
  res.end();
}

/** Reads the request body into a Buffer, rejecting bodies larger than `limit` bytes. */
export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) { reject(new HttpError(413, 'Request body too large')); req.resume(); return; }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'Request body too large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

export async function readJsonBody(req, limit = 256 * 1024) {
  // Only real JSON requests: HTML forms from other sites can't send this content type.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected application/json');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

/** Integer query parameter clamped to [min, max]. */
export function intParam(query, name, def, min, max) {
  const raw = query.get(name);
  if (raw == null || raw === '') return def;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
