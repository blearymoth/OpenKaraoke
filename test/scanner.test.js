import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { scanLibrary, previousKey } from '../server/library/scanner.js';
import { mp4DurationSeconds } from '../server/library/mp4.js';
import { listZip, readZipEntry } from '../server/library/zip.js';
import { tmpDir, writeTree, makeZip } from './helpers.js';

function box(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** A tiny MP4 whose `mvhd` reports `seconds` (timescale 1000). `moov` can sit after `mdat`. */
function tinyMp4(seconds, { moovLast = false, version = 0 } = {}) {
  const ticks = Math.round(seconds * 1000);
  let mvhd;
  if (version === 1) {
    mvhd = Buffer.alloc(112);
    mvhd[0] = 1;
    mvhd.writeUInt32BE(1000, 20);
    mvhd.writeBigUInt64BE(BigInt(ticks), 24);
  } else {
    mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(ticks, 16);
  }
  const moov = box('moov', box('mvhd', mvhd));
  const ftyp = box('ftyp', Buffer.from('mp42isom'));
  const mdat = box('mdat', Buffer.alloc(64, 0x11));
  return Buffer.concat(moovLast ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

async function fixture() {
  const root = await tmpDir();
  const cdg = Buffer.alloc(7200 * 200); // 200 seconds of CDG packets
  const zip = makeZip([
    { name: 'Zipped Band - Song.cdg', data: Buffer.alloc(7200 * 90), deflate: true },
    { name: 'Zipped Band - Song.mp3', data: Buffer.from('ID3fake-mp3-data') },
  ]);
  await writeTree(root, {
    'A/Adele/Adele - Hello [SF Karaoke].cdg': cdg,
    'A/Adele/Adele - Hello [SF Karaoke].mp3': 1000,
    'X/XTC/XTC - Dear God [RD Karaoke].CDG': 7200 * 10,
    'X/XTC/XTC - Dear God [RD Karaoke].MP3': 1000,
    'X/XTC/XTC - Lonely MP3 Without Graphics [SF Karaoke].mp3': 1000,
    'Z/Zipped Band/Zipped Band - Song [SC Karaoke].zip': zip,
    'Video/Some Artist - Some Song [KV Karaoke].mp4': 5000,
    '$RECYCLE.BIN/Junk - Junk.cdg': 7200,
    '$RECYCLE.BIN/Junk - Junk.mp3': 10,
    '.hidden/Hidden - Track.cdg': 7200,
  });
  return root;
}

test('finds CDG pairs, videos and zipped tracks', async () => {
  const root = await fixture();
  const res = await scanLibrary([root]);
  assert.deepEqual(res.errors, []);
  const byName = Object.fromEntries(res.tracks.map((t) => [t.name, t]));
  assert.equal(res.tracks.length, 4);

  const adele = byName['Adele - Hello [SF Karaoke]'];
  assert.equal(adele.kind, 'cdg');
  assert.equal(adele.dir, 'A/Adele');
  assert.equal(adele.duration, 200);
  assert.equal(adele.audio, 'Adele - Hello [SF Karaoke].mp3');

  const xtc = byName['XTC - Dear God [RD Karaoke]'];
  assert.equal(xtc.cdg, 'XTC - Dear God [RD Karaoke].CDG');
  assert.equal(xtc.audio, 'XTC - Dear God [RD Karaoke].MP3');

  const zipped = byName['Zipped Band - Song [SC Karaoke]'];
  assert.equal(zipped.kind, 'zip');
  assert.equal(zipped.duration, 90);
  const mp3 = await readZipEntry(path.join(root, zipped.dir, zipped.zip), zipped.entries.audio);
  assert.equal(mp3.toString(), 'ID3fake-mp3-data');
  const cdgData = await readZipEntry(path.join(root, zipped.dir, zipped.zip), zipped.entries.cdg);
  assert.equal(cdgData.length, 7200 * 90);

  const video = byName['Some Artist - Some Song [KV Karaoke]'];
  assert.equal(video.kind, 'video');
  assert.equal(video.video, 'Some Artist - Some Song [KV Karaoke].mp4');
});

test('MP4 duration comes from mvhd, including when moov follows mdat', async () => {
  const root = await tmpDir();
  await writeTree(root, {
    '0028. Adele - Hello.mp4': tinyMp4(294.6),
    '0026. ABBA - Take a chance on me.m4v': tinyMp4(12.5, { moovLast: true, version: 1 }),
    'Broken - Clip.mp4': Buffer.from('not-an-mp4'),
    'Clip.webm': Buffer.from('webm-bytes'),
  });
  assert.equal(await mp4DurationSeconds(path.join(root, '0028. Adele - Hello.mp4')), 294.6);
  const res = await scanLibrary([root]);
  assert.deepEqual(res.errors, []);
  const byVideo = Object.fromEntries(res.tracks.map((t) => [t.video, t]));
  assert.equal(byVideo['0028. Adele - Hello.mp4'].kind, 'video');
  assert.equal(byVideo['0028. Adele - Hello.mp4'].duration, 294.6);
  assert.equal(byVideo['0026. ABBA - Take a chance on me.m4v'].duration, 12.5);
  assert.equal(byVideo['Broken - Clip.mp4'].duration, 0, 'unreadable mp4 is still indexed');
  assert.equal(byVideo['Clip.webm'].duration, 0);

  const adele = byVideo['0028. Adele - Hello.mp4'];
  const again = await scanLibrary([root], { previous: new Map([[previousKey(adele), { ...adele, duration: 0 }]]) });
  const reread = again.tracks.find((t) => t.video === adele.video);
  assert.equal(reread.duration, 294.6, 'a cached video with no duration is measured');

  const kept = await scanLibrary([root], { previous: new Map([[previousKey(adele), { ...adele, duration: 999 }]]) });
  assert.equal(kept.tracks.find((t) => t.video === adele.video).duration, 999);
});

test('reuses previous results and reports missing folders', async () => {
  const root = await fixture();
  const first = await scanLibrary([root]);
  const previous = new Map(first.tracks.map((t) => [previousKey(t), { ...t, duration: 999 }]));
  const second = await scanLibrary([root, path.join(root, 'does-not-exist')], { previous });
  const adele = second.tracks.find((t) => t.name.startsWith('Adele'));
  assert.equal(adele.duration, 999, 'cached duration reused without re-stat');
  assert.equal(second.errors.length, 1);
  assert.match(second.errors[0].error, /not found/i);
});

test('listZip reads central directory', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 't.zip');
  await fs.writeFile(file, makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world!', deflate: true }]));
  const entries = await listZip(file);
  assert.deepEqual(entries.map((e) => [e.name, e.method, e.usize]), [['a.txt', 0, 5], ['b.txt', 8, 6]]);
  assert.equal((await readZipEntry(file, entries[1])).toString(), 'world!');
});

test('corrupt and ZIP64 archives are rejected cleanly (no crash)', async () => {
  const dir = await tmpDir();
  const eocd = (count, cenSize, cenOffset) => {
    const b = Buffer.alloc(22);
    b.writeUInt32LE(0x06054b50, 0);
    b.writeUInt16LE(count, 8);
    b.writeUInt16LE(count, 10);
    b.writeUInt32LE(cenSize, 12);
    b.writeUInt32LE(cenOffset, 16);
    return b;
  };
  const zip64 = path.join(dir, 'z64.zip');
  await fs.writeFile(zip64, eocd(0xffff, 0xffffffff, 0xffffffff));
  await assert.rejects(listZip(zip64), /ZIP64/);
  const bad = path.join(dir, 'bad.zip');
  await fs.writeFile(bad, eocd(1, 5000, 999999));
  await assert.rejects(listZip(bad), /Corrupt/);
  const res = await scanLibrary([dir]);
  assert.equal(res.tracks.length, 0);
});
