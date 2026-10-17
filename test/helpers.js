import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { setLogLevel } from '../server/util/log.js';

setLogLevel(process.env.LOG_LEVEL || 'warn');

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) fsSync.rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp folder, removed again when the test process exits. */
export async function tmpDir(prefix = 'openkaraoke-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Writes files described as { 'rel/path': Buffer|string|number(bytes) }. A number makes a
 * sparse file of zeros (reads the same, but takes no disk space: fake CDGs are 1.4 MB each).
 */
export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (typeof content === 'number') {
      await fs.writeFile(abs, '');
      await fs.truncate(abs, content);
    } else {
      await fs.writeFile(abs, content);
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a small zip archive. entries: [{ name, data, deflate }] */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

/** Raw scanner-style track records built from "Artist - Title [Brand Karaoke]" names. */
export function rawTracks(names) {
  return names.map((name, i) => {
    const artist = name.split(' - ')[0];
    return {
      root: 0,
      dir: `${artist[0].toUpperCase()}/${artist}`,
      name,
      kind: 'cdg',
      cdg: `${name}.cdg`,
      audio: `${name}.mp3`,
      size: 7200 * (180 + i),
      duration: 180 + i,
    };
  });
}

/**
 * `n` raw tracks named like a big karaoke library (Letter/Artist/Artist - Title [Brand Karaoke]):
 * songs in several label versions, artist typos, duets, explicit and multiplex versions.
 * Deterministic for a seed. For tests of the catalog at a size where speed matters.
 */
export function manyTracks(n, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const syl = ['ka', 'ro', 'li', 'na', 'mo', 'te', 'sa', 'vi', 'do', 'ra', 'ne', 'lu', 'pa', 'gi', 'be', 'to', 'ma', 'ri', 'so', 'fe', 'al', 'en', 'or', 'is'];
  const word = () => {
    let w = '';
    for (let i = 2 + Math.floor(rnd() * 2); i > 0; i--) w += pick(syl);
    return w[0].toUpperCase() + w.slice(1);
  };
  const brands = ['SF', 'SC', 'ZM', 'PH', 'CB', 'DK', 'MM', 'SB', 'KV', 'PI'];
  const artists = Array.from({ length: Math.max(10, Math.round(n / 6)) }, () => (rnd() < 0.2 ? 'The ' : '') + word() + (rnd() < 0.6 ? ` ${word()}` : '') + (rnd() < 0.05 ? ` & ${word()}` : ''));
  const songs = Array.from({ length: Math.round(n * 0.6) }, () => ({ a: pick(artists), t: Array.from({ length: 1 + Math.floor(rnd() * 3) }, word).join(' ') }));
  const out = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const s = songs[i < songs.length ? i : Math.floor(rnd() * songs.length)];
    const a = rnd() < 0.01 ? s.a.slice(0, -1) : s.a; // a typo
    const extra = rnd() < 0.05 ? ' (Duet)' : rnd() < 0.03 ? ' (Explicit)' : rnd() < 0.04 ? ' (Multiplex)' : '';
    let name = `${a} - ${s.t}${extra} [${pick(brands)} Karaoke]`;
    if (used.has(name)) name = `${a} - ${s.t}${extra} (Version ${i}) [${pick(brands)} Karaoke]`;
    used.add(name);
    const size = 7200 * (150 + Math.floor(rnd() * 150));
    out.push({ root: 0, dir: `${a[0].toUpperCase()}/${a}`, name, kind: 'cdg', cdg: `${name}.cdg`, audio: `${name}.mp3`, size, duration: size / 7200, mtime: 1700000000000 + i });
  }
  return out;
}
