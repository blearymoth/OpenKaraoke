// The one download for everybody: OpenKaraoke-Setup.zip, holding the AppImage as
// "Install OpenKaraoke". A browser saves a download without the permission to run it; a zip
// keeps it, so after unpacking (a double-click on the zip in the Files app) a second double-click
// starts the setup (desktop/setup.mjs). Made by electron-builder's afterAllArtifactBuild hook
// (desktop/electron-builder.config.cjs); build-time only, not in the installer. No compression:
// the AppImage is compressed already.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a buffer (zlib.crc32 where Node has it). */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (2-second steps) of a Date, as a zip stores them. */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Writes a zip of `entries` ([{ name, data: Buffer, mode, mtime }]) to `file`, stored (not
 * compressed), with each entry's Unix permissions (made by "UNIX", as Info-ZIP's zip does), so
 * that unpacking keeps an executable executable. Entries must stay under 4 GB.
 */
function writeZip(file, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    if (data.length >= 0xffffffff) throw new Error(`${e.name} is too big for a zip without zip64`);
    const crc = crc32(data);
    const { time, date } = dosTime(e.mtime || new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // the name is UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 30, 4); // made by: UNIX, zip 3.0 — the external attributes are a Unix mode
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk
    head.writeUInt16LE(0, 36); // internal attributes
    head.writeUInt32LE((((e.mode ?? 0o644) & 0o7777) | 0o100000) * 0x10000 >>> 0, 38); // S_IFREG | mode, high 16 bits
    head.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.concat([...parts, ...central, end]));
  fs.renameSync(tmp, file);
  return file;
}

/** The name the setup has inside the zip: what the person double-clicks. */
const SETUP_NAME = 'Install OpenKaraoke';
/** The zip's name in every release (no version: the README links to the latest one by name). */
const ZIP_NAME = 'OpenKaraoke-Setup.zip';

/** Makes OpenKaraoke-Setup.zip next to (or at `out`) from the AppImage at `appImage`. */
function makeSetupZip(appImage, out = path.join(path.dirname(appImage), ZIP_NAME)) {
  const stat = fs.statSync(appImage);
  return writeZip(out, [{ name: SETUP_NAME, data: fs.readFileSync(appImage), mode: 0o755, mtime: stat.mtime }]);
}

module.exports = { crc32, writeZip, makeSetupZip, SETUP_NAME, ZIP_NAME };
