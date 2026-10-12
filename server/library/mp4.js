// Duration of an MP4 / M4V / MOV file from its `mvhd` box.
// Walks box headers and skips payloads, so a large `mdat` is never read.
import fs from 'node:fs/promises';

const MAX_SECONDS = 24 * 3600;

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

/** One ISO BMFF box header, or null when the size is missing or runs past `end`. */
async function boxHeader(fh, offset, end) {
  if (offset < 0 || offset + 8 > end) return null;
  const hdr = await readAt(fh, offset, 16);
  if (hdr.length < 8) return null;
  let size = hdr.readUInt32BE(0);
  const type = hdr.toString('latin1', 4, 8);
  let headerLen = 8;
  if (size === 1) {
    if (hdr.length < 16) return null;
    const big = hdr.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    headerLen = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerLen || offset + size > end) return null;
  return { type, headerLen, next: offset + size, data: offset + headerLen };
}

async function decodeMvhd(fh, data, length) {
  if (length < 20) return null;
  const buf = await readAt(fh, data, Math.min(length, 32));
  const version = buf[0];
  let timescale = 0;
  let duration = 0;
  if (version === 0) {
    if (buf.length < 20) return null;
    timescale = buf.readUInt32BE(12);
    duration = buf.readUInt32BE(16);
  } else if (version === 1) {
    if (buf.length < 32) return null;
    timescale = buf.readUInt32BE(20);
    const big = buf.readBigUInt64BE(24);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(big);
  } else return null;
  if (!timescale) return null;
  return duration / timescale;
}

async function mvhdIn(fh, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = await boxHeader(fh, offset, end);
    if (!box) return null;
    if (box.type === 'mvhd') return decodeMvhd(fh, box.data, box.next - box.data);
    offset = box.next;
  }
  return null;
}

/**
 * Playback length in seconds (one decimal), or 0 when the file has no readable `mvhd`.
 * Never throws: an odd or truncated file just has no duration yet.
 */
export async function mp4DurationSeconds(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    if (size < 16 || size > Number.MAX_SAFE_INTEGER) return 0;
    let offset = 0;
    while (offset + 8 <= size) {
      const box = await boxHeader(fh, offset, size);
      if (!box) return 0;
      if (box.type === 'moov') {
        const seconds = await mvhdIn(fh, box.data, box.next);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) return 0;
        return Math.round(seconds * 10) / 10;
      }
      offset = box.next;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    await fh?.close();
  }
}
