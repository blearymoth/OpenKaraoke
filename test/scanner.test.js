import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { scanLibrary, previousKey } from '../server/library/scanner.js';
import { listZip, readZipEntry } from '../server/library/zip.js';
import { tmpDir, writeTree, makeZip } from './helpers.js';

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
