// Minimal ZIP reader (stored + deflate) used for zipped MP3+G karaoke tracks.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Lists the entries of a zip file. */
export async function listZip(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);
    const cen = Buffer.alloc(cenSize);
    await fh.read(cen, 0, cenSize, cenOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cen.length; i++) {
      if (cen.readUInt32LE(p) !== CEN_SIG) break;
      const flags = cen.readUInt16LE(p + 8);
      const method = cen.readUInt16LE(p + 10);
      const csize = cen.readUInt32LE(p + 20);
      const usize = cen.readUInt32LE(p + 24);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      const offset = cen.readUInt32LE(p + 42);
      const rawName = cen.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
      entries.push({ name, method, csize, usize, offset, encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Returns a readable stream with the (decompressed) data of one entry. */
export async function openZipEntry(file, entry) {
  const fh = await fs.open(file, 'r');
  let dataStart;
  try {
    const loc = Buffer.alloc(30);
    await fh.read(loc, 0, 30, entry.offset);
    if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error('Bad zip local header');
    dataStart = entry.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  if (entry.encrypted) throw new Error('Encrypted zip entries are not supported');
  const raw = entry.csize > 0
    ? createReadStream(file, { start: dataStart, end: dataStart + entry.csize - 1 })
    : createReadStream(file, { start: dataStart, end: dataStart });
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
  raw.destroy();
  throw new Error(`Unsupported zip compression method ${entry.method}`);
}

/** Reads a whole entry into memory. */
export async function readZipEntry(file, entry) {
  const stream = await openZipEntry(file, entry);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
