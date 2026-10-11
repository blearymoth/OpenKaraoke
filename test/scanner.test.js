import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { scanLibrary, previousKey, nestedRoots, inNestedRoot } from '../server/library/scanner.js';
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

test('a library folder inside another is found once, as its own folder', async () => {
  const root = await fixture();
  await writeTree(root, {
    'YouTube Downloads/Rick Astley - Never Gonna Give You Up.mp4': 5000,
    'YouTube Downloads/Old/Toto - Africa.mp4': 5000,
  });
  const inner = path.join(root, 'YouTube Downloads');
  for (const roots of [[root, inner], [inner, root]]) {
    const res = await scanLibrary(roots);
    assert.deepEqual(res.errors, []);
    const names = res.tracks.map((t) => t.name).sort();
    assert.equal(names.length, new Set(names).size, `no duplicates (${roots.map((r) => path.basename(r))})`);
    assert.equal(res.tracks.length, 6);
    const innerIndex = roots.indexOf(inner);
    for (const t of res.tracks.filter((x) => /Rick|Toto/.test(x.name))) {
      assert.equal(t.root, innerIndex, 'the inner folder owns its tracks');
      assert.ok(!t.dir.startsWith('YouTube Downloads'));
    }
  }
  // Scanning the outer folder alone still skips the inner one (it keeps its own tracks).
  const outerOnly = await scanLibrary([root, inner], { only: [0] });
  assert.deepEqual(outerOnly.rootsOnline, [0]);
  assert.equal(outerOnly.tracks.length, 4);
  const innerOnly = await scanLibrary([root, inner], { only: [1] });
  assert.deepEqual(innerOnly.rootsOnline, [1]);
  assert.deepEqual(innerOnly.tracks.map((t) => t.name).sort(), ['Rick Astley - Never Gonna Give You Up', 'Toto - Africa']);
});

test('the same folder twice, or a link to another library folder, is not scanned twice', async () => {
  const root = await fixture();
  const other = await tmpDir();
  await writeTree(other, { 'Toto - Africa.mp4': 5000 });
  const alias = `${root}-alias`;
  await fs.symlink(root, alias);
  await fs.symlink(other, path.join(root, 'Linked'));
  const res = await scanLibrary([root, alias, other]);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.rootsOnline, [0, 1, 2], 'the alias is there, with nothing of its own');
  assert.equal(res.tracks.filter((t) => t.root === 1).length, 0);
  const names = res.tracks.map((t) => t.name);
  assert.equal(names.length, new Set(names).size);
  assert.equal(res.tracks.find((t) => t.name === 'Toto - Africa').root, 2);
});

test('nestedRoots and inNestedRoot', () => {
  const nested = nestedRoots(['/music', '/music/YouTube', '/music/YouTube/old', '/other', '/music/..hidden', '/music']);
  assert.deepEqual([...nested[0]].sort(), ['..hidden', 'YouTube', 'YouTube/old']);
  assert.deepEqual([...nested[1]], ['old']);
  assert.deepEqual([...nested[2]], []);
  assert.deepEqual([...nested[3]], []);
  assert.deepEqual([...nested[5]].sort(), ['', '..hidden', 'YouTube', 'YouTube/old'], 'a repeated folder has nothing of its own');
  assert.equal(inNestedRoot('YouTube', nested[0]), true);
  assert.equal(inNestedRoot('YouTube/x', nested[0]), true);
  assert.equal(inNestedRoot('YouTubeX', nested[0]), false);
  assert.equal(inNestedRoot('', nested[0]), false);
  assert.equal(inNestedRoot('A/Adele', nested[5]), true);
});
