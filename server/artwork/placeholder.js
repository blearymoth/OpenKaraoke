// Deterministic gradient "cover" with initials, used until real artwork is cached.
import { hash32 } from '../../shared/text.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initials(name) {
  const words = String(name || '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/^the\s+/i, '')
    .split(/[\s\-_/&+,.]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return '♪';
  const first = [...words[0]].find((c) => /[\p{L}\p{N}]/u.test(c)) || '';
  const second = words.length > 1 ? [...words[1]].find((c) => /[\p{L}\p{N}]/u.test(c)) || '' : '';
  return (first + second).toUpperCase();
}

/** SVG placeholder cover: colours from the artist, initials from the artist (or title). */
export function placeholderSvg({ artist = '', title = '' } = {}) {
  const h = hash32(String(artist || title).toLowerCase());
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >>> 9) % 80)) % 360;
  const angle = (h >>> 17) % 4;
  const [x1, y1, x2, y2] = [[0, 0, 1, 1], [1, 0, 0, 1], [0, 1, 1, 0], [0, 0, 0, 1]][angle];
  const text = esc(initials(artist || title));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
    + `<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
    + `<stop offset="0" stop-color="hsl(${hue1} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue2} 75% 28%)"/></linearGradient></defs>`
    + `<rect width="100" height="100" fill="url(#g)"/>`
    + `<circle cx="${20 + (h % 60)}" cy="${20 + ((h >>> 5) % 60)}" r="${30 + ((h >>> 11) % 25)}" fill="#fff" opacity=".07"/>`
    + `<text x="50" y="50" dy=".35em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" `
    + `font-size="${text.length > 1 ? 36 : 44}" font-weight="700" fill="#fff" fill-opacity=".92">${text}</text></svg>`;
}
