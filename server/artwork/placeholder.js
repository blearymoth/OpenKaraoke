// Deterministic placeholder artwork: a colourful gradient with the artist's initials.
// Used whenever no real cover art is cached (never a 404, so <img> tags always show something).
import { hash32, fold } from '../../shared/text.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function initialsOf(name) {
  const words = String(name || '').replace(/^the\s+/i, '').replace(/[([].*$/, '').split(/[\s\-&+/,]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return '♪';
  const first = [...words[0]].find((c) => /[\p{L}\p{N}]/u.test(c)) || '';
  const second = words.length > 1 ? [...words[words.length > 2 && words[1].length < 3 ? 2 : 1]].find((c) => /[\p{L}\p{N}]/u.test(c)) || '' : '';
  return (first + second).toUpperCase() || '♪';
}

export function placeholderSvg({ artist = '', title = '', seed } = {}) {
  const h = hash32(seed || fold(artist) || fold(title) || '?');
  const hue = h % 360;
  const hue2 = (hue + 35 + ((h >>> 9) % 70)) % 360;
  const angle = (h >>> 17) % 4;
  const [x1, y1, x2, y2] = [[0, 0, 1, 1], [1, 0, 0, 1], [0, 1, 1, 0], [0.5, 0, 0.5, 1]][angle];
  const initials = esc(initialsOf(artist || title));
  const size = initials.length > 1 ? 34 : 40;
  const cx = 18 + ((h >>> 3) % 64);
  const cy = 18 + ((h >>> 11) % 64);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">`
    + `<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
    + `<stop offset="0" stop-color="hsl(${hue} 72% 52%)"/><stop offset="1" stop-color="hsl(${hue2} 70% 24%)"/></linearGradient>`
    + `<radialGradient id="r" cx="${cx}%" cy="${cy}%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="100" height="100" fill="url(#g)"/><rect width="100" height="100" fill="url(#r)"/>`
    + `<circle cx="50" cy="50" r="36" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width="7"/>`
    + `<circle cx="50" cy="50" r="23" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>`
    + `<text x="50" y="50" dy=".35em" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-weight="800" font-size="${size}" letter-spacing="-1" fill="#fff" fill-opacity=".94">${initials}</text>`
    + '</svg>';
}
