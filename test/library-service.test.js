import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryService, trackSignature, remapRoots } from '../server/library/service.js';
import { Settings } from '../server/config.js';
import { tmpDir, writeTree } from './helpers.js';

const FILES = {
  'A/Adele/Adele - Hello [SF Karaoke].cdg': 7200 * 100,
  'A/Adele/Adele - Hello [SF Karaoke].mp3': 500,
  'Q/Queen/Queen - Bohemian Rhapsody [SC Karaoke].cdg': 7200 * 300,
  'Q/Queen/Queen - Bohemian Rhapsody [SC Karaoke].mp3': 500,
};

const MORE = {
  'B/Blondie/Blondie - Call Me [SF Karaoke].cdg': 7200 * 200,
  'B/Blondie/Blondie - Call Me [SF Karaoke].mp3': 500,
};

async function setup(roots) {
  const dirs = [];
  for (const files of roots) {
    const dir = await tmpDir('ok-lib-');
    await writeTree(dir, files);
    dirs.push(dir);
  }
  const data = await tmpDir('ok-data-');
  const settings = new Settings(data);
  await settings.load();
  settings.update({ library: { paths: dirs } });
  return { dirs, data, settings };
}

test('first start scans and writes the cache; the next start loads it without scanning', async () => {
  const { data, settings } = await setup([FILES]);
  const svc = new LibraryService({ dataDir: data, settings });
  const progress = [];
  svc.on('progress', (p) => progress.push(p));
  await svc.init();
  assert.ok(svc.scanning, 'scan runs in the background');
  const res = await svc.scanning;
  assert.equal(res.tracks, 2);
  assert.equal(res.changed, true);
  assert.equal(svc.catalog.songs.size, 2);
  assert.ok(progress.length >= 1);
  await svc.saving;

  const again = new LibraryService({ dataDir: data, settings });
  await again.init({ scan: false });
  assert.equal(again.scanning, null);
  assert.equal(again.catalog.size, 2);
  assert.deepEqual([...again.catalog.tracks.keys()].sort(), [...svc.catalog.tracks.keys()].sort());
  assert.equal(again.lastScan.tracks, 2, 'last scan info is kept in the cache');
});

test('rescan only rebuilds and saves when files changed', async () => {
  const { dirs, data, settings } = await setup([FILES]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  await svc.saving;
  const cacheFile = path.join(data, 'library.json');
  const mtime1 = (await fs.stat(cacheFile)).mtimeMs;
  const version1 = svc.catalog.version;

  const same = await svc.scan();
  assert.equal(same.changed, false);
  assert.equal(svc.catalog.version, version1, 'catalog not rebuilt');
  assert.equal((await fs.stat(cacheFile)).mtimeMs, mtime1, 'cache not rewritten');

  await writeTree(dirs[0], MORE);
  let changedEvents = 0;
  svc.on('changed', () => changedEvents++);
  const res = await svc.scan();
  assert.equal(res.changed, true);
  assert.equal(res.delta, 1);
  assert.equal(changedEvents, 1);
  assert.ok(svc.catalog.search('call me').items.length);
});

test('concurrent scan calls share one scan', async () => {
  const { data, settings } = await setup([FILES]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  const a = svc.scan();
  const b = svc.scan();
  assert.equal(a, b);
  await a;
});

test('a folder that goes offline keeps its tracks and is reported', async () => {
  const { dirs, data, settings } = await setup([FILES, MORE]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  assert.equal(svc.catalog.size, 3);
  assert.equal(svc.status().offline, false);

  const moved = `${dirs[1]}-unplugged`;
  await fs.rename(dirs[1], moved);
  const statuses = [];
  svc.on('status', (s) => statuses.push(s));
  await svc.checkOnline();
  assert.equal(statuses.at(-1).offline, true);
  assert.deepEqual(statuses.at(-1).roots.map((r) => r.online), [true, false]);

  const res = await svc.scan();
  assert.equal(svc.catalog.size, 3, 'tracks of the unplugged drive are kept');
  assert.deepEqual(res.offlineRoots, [dirs[1]]);
  const blondie = [...svc.catalog.tracks.values()].find((t) => t.name.startsWith('Blondie'));
  assert.equal(svc.isTrackOnline(blondie), false);
  assert.ok(svc.catalog.search('call me').items.length, 'still searchable');
});

test('the watcher indexes a folder that appears after start', async () => {
  const { dirs, data, settings } = await setup([FILES]);
  const late = `${dirs[0]}-late`;
  settings.update({ library: { paths: [dirs[0], late] } });
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  assert.deepEqual(svc.rootsOnline, [true, false]);
  await writeTree(late, MORE);
  await svc.tick();
  assert.ok(svc.scanning, 'scan triggered by the watcher');
  await svc.scanning;
  assert.equal(svc.catalog.size, 3);
});

test('an empty mount point counts as offline', async () => {
  const empty = await tmpDir('ok-empty-');
  const data = await tmpDir('ok-data-');
  const settings = new Settings(data);
  await settings.load();
  settings.update({ library: { paths: [empty] } });
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init();
  assert.deepEqual(svc.rootsOnline, [false]);
  assert.equal(svc.scanning, null, 'nothing to scan while offline');
});

test('setPaths drops removed folders and absPath resolves indexed files only', async () => {
  const { dirs, data, settings } = await setup([FILES, MORE]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  const blondie = [...svc.catalog.tracks.values()].find((t) => t.name.startsWith('Blondie'));
  assert.equal(svc.absPath(blondie, 'audio'), path.join(dirs[1], 'B/Blondie', 'Blondie - Call Me [SF Karaoke].mp3'));
  assert.equal(svc.absPath(blondie, 'video'), null);
  assert.equal(svc.absPath(blondie, 'p'), null);

  await svc.setPaths([dirs[1]]);
  assert.deepEqual(settings.get('library.paths'), [dirs[1]]);
  assert.equal(svc.catalog.size, 1);
  const t = [...svc.catalog.tracks.values()][0];
  assert.equal(t.root, 0);
  assert.equal(svc.absPath(t, 'cdg'), path.join(dirs[1], 'B/Blondie', 'Blondie - Call Me [SF Karaoke].cdg'));
});

test('trackSignature is order independent and remapRoots reindexes', () => {
  const a = { root: 0, dir: 'A', name: 'x', kind: 'cdg', size: 1 };
  const b = { root: 0, dir: 'B', name: 'y', kind: 'cdg', size: 2 };
  assert.equal(trackSignature([a, b]), trackSignature([b, a]));
  assert.notEqual(trackSignature([a, b]), trackSignature([a, { ...b, size: 3 }]));
  const out = remapRoots([{ root: 0 }, { root: 1 }], ['/one', '/two'], ['/two']);
  assert.deepEqual(out, [{ root: 0 }]);
});
