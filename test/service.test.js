import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LibraryService, trackSignature } from '../server/library/service.js';
import { Settings } from '../server/config.js';
import { tmpDir, writeTree } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function setup(files = {
  'A/Adele/Adele - Hello [SF Karaoke].cdg': 7200 * 10,
  'A/Adele/Adele - Hello [SF Karaoke].mp3': 100,
  'Q/Queen/Queen - Bohemian Rhapsody [SC Karaoke].cdg': 7200 * 20,
  'Q/Queen/Queen - Bohemian Rhapsody [SC Karaoke].mp3': 100,
}) {
  const root = await tmpDir();
  const data = await tmpDir();
  await writeTree(root, files);
  const settings = new Settings(data);
  await settings.load();
  settings.update({ library: { paths: [root] } });
  return { root, data, settings };
}

test('scans, caches and reloads the library from the cache', async () => {
  const { root, data, settings } = await setup();
  const lib = new LibraryService({ dataDir: data, settings, log: quiet, watchIntervalMs: 0 });
  await lib.init({ scan: false });
  assert.equal(lib.catalog.size, 0);
  const events = [];
  lib.on('changed', () => events.push('changed'));
  const r = await lib.scan();
  assert.equal(r.changed, true);
  assert.deepEqual(events, ['changed']);
  assert.equal(lib.catalog.size, 2);
  assert.equal(lib.status().state, 'ready');
  assert.equal(lib.status().roots[0].tracks, 2);

  const hello = lib.catalog.search('hello').items[0];
  const track = lib.catalog.track(hello.trackIds[0]);
  assert.equal(lib.absPath(track, 'audio'), path.join(root, 'A/Adele/Adele - Hello [SF Karaoke].mp3'));
  assert.equal(lib.absPath(track, 'video'), null);

  // no changes -> no rebuild
  const again = await lib.scan();
  assert.equal(again.changed, false);

  // a second service instance loads the cache without scanning
  await settings.flush();
  const lib2 = new LibraryService({ dataDir: data, settings, log: quiet, watchIntervalMs: 0 });
  await lib2.init({ scan: false });
  assert.equal(lib2.catalog.size, 2);
  assert.deepEqual([...lib2.catalog.tracks.keys()].sort(), [...lib.catalog.tracks.keys()].sort());
  await lib.close();
  await lib2.close();
});

test('concurrent scan calls share one run; new files trigger a rebuild', async () => {
  const { root, data, settings } = await setup();
  const lib = new LibraryService({ dataDir: data, settings, log: quiet, watchIntervalMs: 0 });
  await lib.init({ scan: false });
  const a = lib.scan();
  const b = lib.scan();
  assert.equal(a, b);
  await a;
  await writeTree(root, {
    'B/Blur/Blur - Song 2 [SF Karaoke].cdg': 7200 * 5,
    'B/Blur/Blur - Song 2 [SF Karaoke].mp3': 100,
  });
  const r = await lib.scan();
  assert.equal(r.changed, true);
  assert.equal(lib.catalog.size, 3);
  await lib.close();
});

test('keeps tracks of an unplugged drive and reports it offline', async () => {
  const { root, data, settings } = await setup();
  const lib = new LibraryService({ dataDir: data, settings, log: quiet, watchIntervalMs: 0 });
  await lib.init({ scan: false });
  await lib.scan();
  const moved = `${root}-unplugged`;
  await fs.rename(root, moved);
  await lib.checkOnline();
  assert.equal(lib.status().state, 'offline');
  const r = await lib.scan();
  assert.equal(r.changed, false, 'offline root keeps its cached tracks');
  assert.equal(lib.catalog.size, 2);
  const t = [...lib.catalog.tracks.values()][0];
  assert.equal(lib.isOnline(t), false);
  await fs.rename(moved, root);
  await lib.checkOnline();
  assert.equal(lib.status().state === 'ready' || lib.status().state === 'scanning', true);
  await lib.close();
});

test('setPaths remaps and removes roots', async () => {
  const { root, data, settings } = await setup();
  const other = await tmpDir();
  await writeTree(other, {
    'Z/ZZ Top/ZZ Top - La Grange [SC Karaoke].cdg': 7200 * 5,
    'Z/ZZ Top/ZZ Top - La Grange [SC Karaoke].mp3': 100,
  });
  const lib = new LibraryService({ dataDir: data, settings, log: quiet, watchIntervalMs: 0 });
  await lib.init({ scan: false });
  await lib.scan();
  await lib.setPaths([other, root, root]);
  assert.deepEqual(lib.paths, [other, root]);
  await lib.scan();
  assert.equal(lib.catalog.size, 3);
  const adele = [...lib.catalog.tracks.values()].find((t) => t.name.startsWith('Adele'));
  assert.equal(adele.root, 1);
  await lib.setPaths([other]);
  assert.equal(lib.catalog.size, 1);
  await lib.close();
});

test('trackSignature is order independent', () => {
  const a = { root: 0, dir: 'a', name: 'x', kind: 'cdg', size: 1, audio: 'x.mp3' };
  const b = { root: 0, dir: 'b', name: 'y', kind: 'cdg', size: 2, audio: 'y.mp3' };
  assert.equal(trackSignature([a, b]), trackSignature([b, a]));
  assert.notEqual(trackSignature([a, b]), trackSignature([a, { ...b, size: 3 }]));
});
