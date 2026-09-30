// Text normalisation helpers shared by the server and the browser.
// Everything here is pure and dependency free.

const SPECIAL = {
  'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ß': 'ss',
  'đ': 'd', 'Đ': 'd', 'ł': 'l', 'Ł': 'l', 'þ': 'th', 'Þ': 'th', 'ı': 'i', 'ð': 'd',
};
const SPECIAL_RE = /[øØæÆœŒßđĐłŁþÞıð]/g;
const MARKS_RE = /[̀-ͯ]/g;

/** Lower-case, accent-free, punctuation-free string with single spaces. */
export function fold(input) {
  return String(input ?? '')
    .replace(SPECIAL_RE, (c) => SPECIAL[c] || c)
    .normalize('NFKD')
    .replace(MARKS_RE, '')
    .toLowerCase()
    .replace(/['’`´‘]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** fold() without spaces - handy for keys ("A-Ha", "A Ha", "Aha" -> "aha"). */
export function compact(input) {
  return fold(input).replace(/ /g, '');
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost;
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

/** Dice coefficient on character bigrams of folded strings (0..1). */
export function similarity(a, b) {
  const x = compact(a);
  const y = compact(b);
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.substr(i, 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.substr(i, 2);
    const n = grams.get(g);
    if (n > 0) { hits++; grams.set(g, n - 1); }
  }
  return (2 * hits) / (x.length + y.length - 2);
}

/** Deterministic 32-bit hash (FNV-1a) of a string. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Short stable id (base36) built from two differently seeded hashes. */
export function shortId(str) {
  const a = hash32(str).toString(36);
  const b = hash32('~' + str + '#').toString(36);
  return (a + b).slice(0, 12);
}

/** "3:05" style duration. */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Split an artist credit into individual performers. */
export function splitCredits(artist) {
  return String(artist || '')
    .replace(/\((?:duet|solo|trio|wbgv|wobgv|musical)\)/gi, ' ')
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|w\/|vs\.?|versus|x|and|&|\+)\s+|\s*,\s*|\s*\/\s*|\s+&\s*|\s*&\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pick a readable text colour (black/white) for a background hex colour. */
export function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
}
