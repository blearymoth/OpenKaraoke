// The release year in the MP3 files' own tags: the ID3 reader, the background pass, and where
// the tag sits among the years (host's own > file tag > online).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { id3Year, id3Size } from '../server/library/id3.js';
import { TagYears } from '../server/library/tagyears.js';
import { SongMeta } from '../server/library/songmeta.js';
import { Catalog } from '../server/library/catalog.js';
import { tmpDir, writeTree, rawTracks } from './helpers.js';

const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** An ID3v2 tag with text frames { TDRC: '1975', … } (version 2, 3 or 4; encoding 0 latin1, 1 utf16, 3 utf8). */
export function id3Tag(frames, { ver = 3, enc = 0, padding = 20 } = {}) {
  const parts = [];
  for (const [id, value] of Object.entries(frames)) {
    let body;
    if (enc === 1) body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
    else body = Buffer.concat([Buffer.from([enc]), Buffer.from(value, enc === 3 ? 'utf8' : 'latin1')]);
    let head;
    if (ver === 2) head = Buffer.concat([Buffer.from(id), Buffer.from([0, (body.length >> 8) & 255, body.length & 255])]);
    else {
      const len = Buffer.alloc(4);
      if (ver === 4) syncsafe(body.length).copy(len); else len.writeUInt32BE(body.length);
      head = Buffer.concat([Buffer.from(id), len, Buffer.from([0, 0])]);
    }
    parts.push(head, body);
  }
  parts.push(Buffer.alloc(padding));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, 0]), syncsafe(body.length), body]);
}

test('id3: the year of v2.3, v2.4 and v2.2 tags, in any text encoding', () => {
  assert.equal(id3Year(id3Tag({ TYER: '1975' })), 1975);
  assert.equal(id3Year(id3Tag({ TDRC: '1983-06-01' }, { ver: 4, enc: 3 })), 1983);
  assert.equal(id3Year(id3Tag({ TYER: '1969' }, { enc: 1 })), 1969);
  assert.equal(id3Year(id3Tag({ TYE: '1991' }, { ver: 2 })), 1991);
  assert.equal(id3Year(id3Tag({ TDRC: '2011' }, { ver: 4, enc: 1 })), 2011);
});

test('id3: the original release date wins over the recording or reissue date', () => {
  assert.equal(id3Year(id3Tag({ TDRC: '2015', TDOR: '1977-02-04' }, { ver: 4 })), 1977);
  assert.equal(id3Year(id3Tag({ TYER: '2009', TORY: '1980' })), 1980);
  assert.equal(id3Year(id3Tag({ TDOR: 'unknown', TDRC: '1999' }, { ver: 4 })), 1999, 'a date that is no year is skipped');
});

test('id3: no tag, no year, a bad year or a damaged tag give 0', () => {
  assert.equal(id3Year(Buffer.from('not a tag at all')), 0);
  assert.equal(id3Size(Buffer.alloc(4)), 0);
  assert.equal(id3Year(id3Tag({ TIT2: 'Hello' })), 0);
  assert.equal(id3Year(id3Tag({ TYER: '0000' })), 0);
  assert.equal(id3Year(id3Tag({ TYER: '1850' })), 0);
  const cut = id3Tag({ TYER: '1975' }, { padding: 0 });
  assert.equal(id3Year(cut.subarray(0, 14)), 0, 'a tag cut short');
  const lying = Buffer.from(id3Tag({ TYER: '1975' }));
  lying.writeUInt32BE(9999, 14);
  assert.equal(id3Year(lying), 0, 'a frame longer than its tag');
});

async function libraryWith(names, tags) {
  const root = await tmpDir('ok-tags-');
  const raw = rawTracks(names);
  const files = {};
  raw.forEach((t, i) => { files[`${t.dir}/${t.audio}`] = tags[i] ? Buffer.concat([tags[i], Buffer.alloc(64)]) : Buffer.alloc(64); });
  await writeTree(root, files);
  const library = new EventEmitter();
  library.catalog = new Catalog().load(raw, [root]);
  library.isTrackOnline = () => true;
  library.absPath = (t, part) => path.join(root, t.dir, t[part]);
  return { root, raw, library };
}

test('tag years: read in a pass, kept, and read again only when the file changed', async () => {
  const { root, library, raw } = await libraryWith(
    ['Abba - Waterloo [SF Karaoke]', 'Queen - Killer Queen [SF Karaoke]', 'Adele - Hello [SF Karaoke]'],
    [id3Tag({ TYER: '1974' }), id3Tag({ TDOR: '1974-10-11', TDRC: '2011' }, { ver: 4 }), null],
  );
  const file = path.join(root, 'tags.json');
  const ty = await new TagYears(file).load();
  assert.equal(await ty.scan(library), 2, 'two songs got a year');
  const keyOf = (n) => library.catalog.songList.find((s) => s.title.toLowerCase().includes(n)).key;
  assert.equal(ty.get(keyOf('waterloo')), 1974);
  assert.equal(ty.get(keyOf('killer')), 1974, 'the original date, not the 2011 reissue');
  assert.equal(ty.get(keyOf('hello')), 0);
  assert.equal(ty.size, 2);
  assert.equal(await ty.scan(library), 0, 'nothing changed: nothing read');
  await ty.flush();
  const again = await new TagYears(file).load();
  assert.equal(again.get(keyOf('waterloo')), 1974, 'kept between runs');
  // The file is retagged (same name, new size): the new year is found.
  const t = raw[0];
  await writeTreeFile(path.join(root, t.dir, t.audio), Buffer.concat([id3Tag({ TYER: '1975' }), Buffer.alloc(200)]));
  assert.equal(await again.scan(library), 1);
  assert.equal(again.get(keyOf('waterloo')), 1975);
});

async function writeTreeFile(file, buf) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, buf);
}

test('tag years: the host\'s own year wins, then the file\'s tag, then the online one', async () => {
  const dir = await tmpDir('ok-tags-meta-');
  const meta = await new SongMeta(path.join(dir, 'songmeta.json')).load();
  meta.tagYears = { get: (k) => (k === 'a' || k === 'b' ? 1975 : 0) };
  const online = { year: 2015, rank: 5 };
  assert.deepEqual({ y: meta.apply('c', online).year }, { y: 2015 }, 'no tag, no host year: online');
  const withTag = meta.apply('a', online);
  assert.equal(withTag.year, 1975);
  assert.equal(withTag.rank, 5, 'the rest of the online entry is kept');
  assert.equal(withTag.fileTag.year, true);
  assert.equal(meta.apply('a', online), withTag, 'the same object while nothing changed');
  meta.set('a', { year: 1980 });
  const host = meta.apply('a', online);
  assert.equal(host.year, 1980);
  assert.equal(host.host.year, true);
  assert.equal(host.fileTag, undefined);
  assert.equal(meta.apply('b', null).year, 1975, 'a song with no online entry at all');
  assert.equal(meta.checked('b').year, 1975, 'the checker counts a tagged year as checked');
  assert.equal(meta.checked('c'), null);
  meta.discard();
});
