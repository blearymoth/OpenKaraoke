// The release year in an MP3's ID3v2 tag (pure: works on the bytes of the start of the file).
// The original release date wins over the recording date: TDOR / TORY, then TDRC / TYER / TDRL.
// ID3v2.2 (3-letter frames: TOR, TYE) is read too. No year, or a tag that makes no sense, is 0.

const FRAMES = [['TDOR', null], ['TORY', 'TOR'], ['TDRC', null], ['TYER', 'TYE'], ['TDRL', null]];
const MIN_YEAR = 1900;

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

/** How many bytes the whole ID3v2 tag takes (header included), or 0 when the file has none. */
export function id3Size(head) {
  if (!head || head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  if (head[3] < 2 || head[3] > 4) return 0;
  for (let i = 6; i < 10; i++) if (head[i] & 0x80) return 0;
  return 10 + syncsafe(head, 6) + (head[3] === 4 && head[5] & 0x10 ? 10 : 0);
}

function text(frame) {
  if (!frame.length) return '';
  const enc = frame[0];
  const body = frame.subarray(1);
  let s;
  if (enc === 1 || enc === 2) {
    if (enc === 1 && body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) s = Buffer.from(body.subarray(2)).toString('utf16le');
    else if (enc === 1 && body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) s = Buffer.from(body.subarray(2)).swap16().toString('utf16le');
    else if (enc === 2) s = Buffer.from(body).swap16().toString('utf16le');
    else s = Buffer.from(body).toString('utf16le');
  } else s = Buffer.from(body).toString(enc === 3 ? 'utf8' : 'latin1');
  return s.replace(/\0.*$/s, '').trim();
}

const yearOf = (s) => {
  const m = /^(\d{4})(?!\d)/.exec(s);
  const y = m ? Number(m[1]) : 0;
  return y >= MIN_YEAR ? y : 0;
};

/** The year in the ID3v2 tag at the start of `buf` (at least the whole tag), or 0. */
export function id3Year(buf) {
  const size = id3Size(buf);
  if (!size) return 0;
  const ver = buf[3];
  const end = Math.min(size, buf.length);
  const flags = buf[5];
  let o = 10;
  if (ver === 3 && flags & 0x40 && end >= o + 4) o += 4 + be32(buf, o); // extended header
  if (ver === 4 && flags & 0x40 && end >= o + 4) o += syncsafe(buf, o);
  const found = new Map();
  const idLen = ver === 2 ? 3 : 4;
  const hdr = ver === 2 ? 6 : 10;
  while (o + hdr <= end) {
    if (buf[o] === 0) break; // padding
    const id = Buffer.from(buf.subarray(o, o + idLen)).toString('latin1');
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const len = ver === 2 ? be24(buf, o + 3) : ver === 4 ? syncsafe(buf, o + 4) : be32(buf, o + 4);
    const start = o + hdr;
    if (len < 0 || start + len > end) break;
    if (!found.has(id)) found.set(id, buf.subarray(start, start + len));
    o = start + len;
  }
  for (const [v34, v2] of FRAMES) {
    const id = ver === 2 ? v2 : v34;
    if (!id || !found.has(id)) continue;
    const y = yearOf(text(found.get(id)));
    if (y) return y;
  }
  return 0;
}
