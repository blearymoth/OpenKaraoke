import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryService, trackSignature, remapRoots, rescanForPaths } from '../server/library/service.js';
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

test('a folder added inside another: its songs are in the library once, and only it is scanned', async () => {
  const { dirs, data, settings } = await setup([{ ...FILES, 'YouTube Downloads/Toto - Africa [KV Karaoke].mp4': 5000 }]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  assert.equal(svc.catalog.size, 3);
  const inner = path.join(dirs[0], 'YouTube Downloads');
  const before = svc.paths;
  const after = await svc.setPaths([dirs[0], inner]);
  assert.equal(svc.catalog.size, 2, 'the outer folder’s copy of the inner folder’s tracks goes at once');
  assert.deepEqual(rescanForPaths(before, after), [inner], 'only the new folder needs a scan');
  const res = await svc.scan({ roots: [inner] });
  assert.deepEqual(res.folders, [inner]);
  assert.equal(svc.catalog.size, 3);
  const toto = [...svc.catalog.tracks.values()].filter((t) => t.name.startsWith('Toto'));
  assert.equal(toto.length, 1, 'never twice');
  assert.equal(toto[0].root, 1);
  assert.equal(svc.absPath(toto[0], 'video'), path.join(inner, 'Toto - Africa [KV Karaoke].mp4'));
  // A full scan keeps it that way; removing the inner folder gives its songs back to the outer one.
  await svc.scan();
  assert.equal(svc.catalog.size, 3);
  const removed = await svc.setPaths([dirs[0]]);
  assert.deepEqual(rescanForPaths([dirs[0], inner], removed), [dirs[0]], 'the folder that held it is scanned again');
  assert.equal(svc.catalog.size, 2);
  await svc.scan({ roots: [dirs[0]] });
  assert.equal(svc.catalog.size, 3);
  assert.equal([...svc.catalog.tracks.values()].find((t) => t.name.startsWith('Toto')).dir, 'YouTube Downloads');
});

test('scanning one folder leaves the others as they were', async () => {
  const { dirs, data, settings } = await setup([FILES, MORE]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  assert.equal(svc.catalog.size, 3);
  await writeTree(dirs[0], { 'D/Dido/Dido - Thank You [SF Karaoke].cdg': 7200, 'D/Dido/Dido - Thank You [SF Karaoke].mp3': 10 });
  await writeTree(dirs[1], { 'E/Eagles/Eagles - Desperado [SF Karaoke].cdg': 7200, 'E/Eagles/Eagles - Desperado [SF Karaoke].mp3': 10 });
  const statuses = [];
  svc.on('status', (s) => statuses.push(s));
  const res = await svc.scan({ roots: [dirs[1]] });
  assert.equal(res.changed, true);
  assert.equal(res.delta, 1);
  assert.deepEqual(res.offlineRoots, []);
  assert.ok(svc.catalog.search('desperado').items.length, 'the scanned folder’s new song is in');
  assert.equal(svc.catalog.search('thank you').items.length, 0, 'the other folder was not scanned');
  const during = statuses.find((s) => s.scanning);
  assert.deepEqual(during.roots.map((r) => r.scanning), [false, true], 'the folder being scanned is marked');
  assert.equal(await svc.scan({ roots: ['/not/a/library/folder'] }), svc.lastScan, 'an unknown folder scans nothing');
  await svc.scan();
  assert.ok(svc.catalog.search('thank you').items.length);
});

test('a scan asked for while another folder is scanned follows it; one that is covered shares it', async () => {
  const { dirs, data, settings } = await setup([FILES, MORE]);
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  const first = svc.scan({ roots: [dirs[0]] });
  assert.equal(svc.scan({ roots: [dirs[0]] }), first, 'the same folder: shared');
  const second = svc.scan({ roots: [dirs[1]] });
  const third = svc.scan();
  assert.notEqual(second, first);
  assert.equal(third, second, 'everything asked for meanwhile is one scan');
  assert.equal(svc.status().roots[1].waiting, true);
  await first;
  const res = await second;
  assert.equal(res.folders, undefined, 'it scanned every folder');
  assert.equal(svc.catalog.size, 3);
  const all = svc.scan();
  assert.equal(svc.scan({ roots: [dirs[1]] }), all, 'a scan of everything covers one folder');
  await all;
});

test('the watcher scans only the folder that appeared', async () => {
  const { dirs, data, settings } = await setup([FILES]);
  const late = `${dirs[0]}-late2`;
  settings.update({ library: { paths: [dirs[0], late] } });
  const svc = new LibraryService({ dataDir: data, settings });
  await svc.init({ scan: false });
  await svc.scan();
  await writeTree(dirs[0], MORE); // (not scanned: its folder didn't come and go)
  await writeTree(late, { 'Toto - Africa [KV Karaoke].mp4': 10 });
  await svc.tick();
  const res = await svc.scanning;
  assert.deepEqual(res.folders, [late]);
  assert.equal(svc.catalog.size, 3);
});

test('remapRoots drops tracks that a nested library folder owns', () => {
  const tracks = [{ root: 0, dir: 'YouTube/x' }, { root: 0, dir: 'A' }, { root: 0, dir: 'YouTubeX' }, { root: 1, dir: '' }];
  const out = remapRoots(tracks, ['/m', '/m/YouTube'], ['/m', '/m/YouTube']);
  assert.deepEqual(out.map((t) => t.dir), ['A', 'YouTubeX', '']);
  assert.deepEqual(rescanForPaths(['/a', '/b'], ['/a', '/b']), []);
  assert.deepEqual(rescanForPaths(['/a'], ['/a', '/b']), ['/b']);
  assert.deepEqual(rescanForPaths(['/a', '/a/b', '/c'], ['/a']), ['/a']);
});
