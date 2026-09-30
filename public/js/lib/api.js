// HTTP API helpers.
import { storage } from './ws-client.js';

export function hostToken() {
  return storage('ok.hostToken');
}

export async function api(path, { params, method = 'GET', body, signal } = {}) {
  let url = path;
  if (params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const s = q.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const headers = {};
  const token = hostToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Cover art URL for a song summary (placeholder SVG until artwork exists). */
export function artUrl(song, size = 250, { plain = false } = {}) {
  if (!song?.id) return '/img/icon.svg';
  return `/api/art/song/${encodeURIComponent(song.id)}?s=${size}${song.art ? '&v=1' : ''}${plain ? '&plain=1' : ''}`;
}

export function qrUrl(text, opts = {}) {
  const q = new URLSearchParams({ text, ...opts });
  return `/api/qr.svg?${q}`;
}
