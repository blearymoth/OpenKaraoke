// Songs from a link (PLAN §31): what a link may be, and the lyrics someone typed — the same
// rules on the phones, the host page and the server (isomorphic, no Node APIs).

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
export const MAX_LINK = 500;
export const MAX_LYRICS = 20000;

/**
 * A YouTube video link → `{ url: 'https://www.youtube.com/watch?v=<id>', id }`, or `{ error }`.
 * Only YouTube; no other site, no user name or password, no port, no playlist (a video that is in
 * a playlist is that video). Everything else in the link is dropped.
 */
export function parseLink(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { error: 'Paste a YouTube link.' };
  if (text.length > MAX_LINK || /\s/.test(text)) return { error: 'That doesn’t look like a YouTube link.' };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: 'That doesn’t look like a YouTube link.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'That doesn’t look like a YouTube link.' };
  if (u.username || u.password || u.port) return { error: 'That doesn’t look like a YouTube link.' };
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return { error: 'Only YouTube links can be made into karaoke.' };
  let id = '';
  const parts = u.pathname.split('/').filter(Boolean);
  if (host.endsWith('youtu.be')) id = parts[0] || '';
  else if (parts[0] === 'watch') id = u.searchParams.get('v') || '';
  else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1] || '';
  else if (parts[0] === 'playlist') return { error: 'That’s a playlist — open one video and copy its link.' };
  if (!VIDEO_ID.test(id)) return { error: 'That doesn’t look like a YouTube video link.' };
  return { url: `https://www.youtube.com/watch?v=${id}`, id };
}

/** Typed lyrics: plain lines, no control characters, at most MAX_LYRICS characters; '' when there are none. */
export function cleanLyrics(input) {
  if (typeof input !== 'string') return '';
  const text = input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '').slice(0, MAX_LYRICS);
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  while (lines.length && !lines.at(-1)) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  return lines.join('\n');
}

/** A song request's states and what they say (the guest's phone, the host's Decisions page). */
export const LINK_STATES = {
  pending: 'Waiting for the host',
  queued: 'Approved — waiting its turn',
  working: 'Being made',
  done: 'Ready',
  failed: 'It didn’t work',
  denied: 'Not this time',
  cancelled: 'Cancelled',
};

/** States a request can still change from (it is still open). */
export const OPEN_LINK_STATES = ['pending', 'queued', 'working'];

/** Seconds → "about N minutes" (how long making a song takes on this PC, PLAN §31.2). */
export function aboutMinutes(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 50) return 'under a minute';
  const m = Math.max(1, Math.round(seconds / 60));
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}
