import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryService, trackSignature, remapRoots, rescanForPaths } from '../server/library/service.js';
import { idMoves, trackReturns } from '../server/library/ids.js';
import { Settings } from '../server/config.js';
import { createApp } from '../server/app.js';
import { HOST_VOTER } from '../server/room/versions.js';
import { offlineFetch } from './fake-art.js';
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

test('idMoves follows one file across a split and a fold, not a neighbour or a removed folder', () => {
  const oldRoots = ['/m'];
  const nest = ['/m', '/m/YouTube Downloads'];
  const toto = { id: 'aaa', root: 0, dir: 'YouTube Downloads/Old', name: 'Toto - Africa' };
  const near = { id: 'bbb', root: 0, dir: 'YouTubeX', name: 'Toto - Africa' };
  const adele = { id: 'ccc', root: 0, dir: 'A/Adele', name: 'Adele - Hello' };
  const toto2 = { id: 'zzz', root: 1, dir: 'Old', name: 'Toto - Africa' };
  assert.deepEqual(idMoves(oldRoots, [toto, near, adele], nest, [near, adele, toto2]), [{ from: 'aaa', to: 'zzz' }]);
  assert.deepEqual(idMoves(nest, [near, adele, toto2], oldRoots, [toto, near, adele]), [{ from: 'zzz', to: 'aaa' }]);
  assert.equal(trackReturns(oldRoots, toto, nest), true);
  assert.equal(trackReturns(oldRoots, near, nest), false);
  assert.equal(trackReturns(oldRoots, adele, nest), false);
  assert.equal(trackReturns(nest, toto2, oldRoots), true, 'folded back into the parent');
  assert.equal(trackReturns(['/m', '/other'], { root: 1, dir: 'A', name: 'X' }, ['/m']), false, 'a removed folder is not folded back');
});

test('plays, votes, vocals and prefs follow a folder that becomes its own root, and the fold back', async () => {
  const root = await tmpDir('ok-lib-');
  const other = await tmpDir('ok-lib-');
  await writeTree(root, {
    ...FILES,
    'YouTube Downloads/Toto - Africa [KV Karaoke].mp4': 5000,
    'YouTubeX/Toto - Africa [KV Karaoke].mp4': 5000,
  });
  await writeTree(other, { 'Blondie - Call Me [SF Karaoke].mp4': 5000 });
  const data = await tmpDir('ok-data-');
  let app = await createApp({ dataDir: data, args: { library: [root, other] }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  try {
    await app.library.scan();
    const byDir = (dir) => [...app.library.catalog.tracks.values()].find((t) => t.dir === dir);
    const toto = byDir('YouTube Downloads');
    const decoy = byDir('YouTubeX');
    const adele = [...app.library.catalog.tracks.values()].find((t) => t.name.startsWith('Adele'));
    const blondie = [...app.library.catalog.tracks.values()].find((t) => t.name.startsWith('Blondie'));
    const oldToto = toto.id;
    const oldDecoy = decoy.id;
    const oldAdele = adele.id;
    const oldBlondie = blondie.id;
    app.room.versions.addPlay(oldToto);
    app.room.versions.addPlay(oldToto);
    app.room.versions.vote(oldToto, HOST_VOTER, 1);
    app.room.versions.vote(oldToto, 'guest-aaaa', -1);
    app.room.versions.addPlay(oldDecoy);
    app.room.versions.addPlay(oldAdele);
    app.room.versions.addPlay(oldBlondie);
    app.room.vocals.set(oldToto, { l: 'stereo', s: '', lean: '', a: 1, c: 'low' });
    app.room.s.trackPrefs[oldToto] = { channel: 'left', layout: 'mpxL' };
    app.room.s.songPrefs['adele|hello'] = { trackId: oldToto, key: 2 };
    app.room.s.queue.push({ id: 'q1', trackId: oldToto });
    app.room.s.tonight.history.unshift({ trackId: oldToto, title: 'Africa' });
    const historyPath = path.join(data, 'history.jsonl');
    const historyBody = `${JSON.stringify({ trackId: oldToto, skipped: false })}\n`;
    await fs.writeFile(historyPath, historyBody);

    const inner = path.join(root, 'YouTube Downloads');
    await app.room.libraryPaths({ paths: [root, inner] });
    await app.library.scanning;
    const moved = [...app.library.catalog.tracks.values()].find((t) => t.name.startsWith('Toto') && t.root === 1);
    assert.ok(moved, 'the inner folder’s track is back');
    assert.equal(moved.dir, '');
    assert.notEqual(moved.id, oldToto);
    assert.equal(app.room.versions.info(moved.id).plays, 2);
    assert.equal(app.room.versions.info(moved.id).host, 1);
    assert.equal(app.room.versions.info(moved.id, 'guest-aaaa').mine, -1);
    assert.equal(app.room.versions.info(oldToto).plays, 0, 'the old id no longer holds the plays');
    assert.equal(app.room.versions.info(oldDecoy).plays, 1);
    assert.equal(byDir('YouTubeX').id, oldDecoy, 'YouTubeX is a different folder');
    assert.equal(app.room.versions.info(oldAdele).plays, 1);
    assert.equal(app.room.vocals.get(oldToto), null);
    assert.equal(app.room.vocals.get(moved.id).l, 'stereo');
    assert.deepEqual(app.room.s.trackPrefs[moved.id], { channel: 'left', layout: 'mpxL' });
    assert.equal(app.room.s.trackPrefs[oldToto], undefined);
    assert.equal(app.room.s.songPrefs['adele|hello'].trackId, moved.id);
    assert.equal(app.room.s.queue[0].trackId, moved.id);
    assert.equal(app.room.s.tonight.history[0].trackId, moved.id);
    assert.equal(await fs.readFile(historyPath, 'utf8'), historyBody, 'history.jsonl is not rewritten');
    assert.equal(app.room.versions.info(oldBlondie).plays, 1, 'a removed folder keeps its own plays');
    assert.equal([...app.library.catalog.tracks.values()].some((t) => t.id === oldBlondie), false);

    await app.room.libraryPaths({ paths: [root] });
    await app.library.scanning;
    const back = byDir('YouTube Downloads');
    assert.equal(back.id, oldToto);
    assert.equal(app.room.versions.info(back.id).plays, 2);
    assert.equal(app.room.versions.info(back.id).host, 1);
    assert.equal(app.room.versions.info(moved.id).plays, 0);
    assert.equal(app.room.s.trackPrefs[back.id].layout, 'mpxL');
    assert.equal(app.room.s.songPrefs['adele|hello'].trackId, back.id);
  } finally {
    await app.close();
  }

  // Restart after the split was saved but before the new folder was scanned: the next scan still moves them.
  app = await createApp({ dataDir: data, args: { library: [root] }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  try {
    await app.library.scan();
    const toto = [...app.library.catalog.tracks.values()].find((t) => t.dir === 'YouTube Downloads');
    assert.equal(app.room.versions.info(toto.id).plays, 2, 'still on the folded id');
    const inner = path.join(root, 'YouTube Downloads');
    await app.library.setPaths([root, inner]);
    assert.equal([...app.library.catalog.tracks.values()].some((t) => t.name.startsWith('Toto') && t.dir === 'YouTube Downloads'), false);
    await app.close();
  } catch (e) {
    await app.close();
    throw e;
  }

  app = await createApp({ dataDir: data, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  try {
    const still = [...app.library.catalog.tracks.values()].find((t) => t.name.startsWith('Toto') && !t.dir);
    assert.equal(still, undefined, 'not scanned yet');
    const oldId = [...Object.keys(app.room.versions.tracks)].find((id) => app.room.versions.info(id).plays === 2);
    assert.ok(oldId);
    await app.library.saving;
    await app.close();
  } catch (e) {
    await app.close();
    throw e;
  }

  app = await createApp({ dataDir: data, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  try {
    const inner = path.join(root, 'YouTube Downloads');
    await app.library.scan({ roots: [inner] });
    const moved = [...app.library.catalog.tracks.values()].find((t) => t.name.startsWith('Toto') && t.root === 1);
    assert.ok(moved);
    assert.equal(app.room.versions.info(moved.id).plays, 2);
    assert.equal(app.room.versions.info(moved.id).host, 1);
    assert.equal(app.room.vocals.get(moved.id)?.l, 'stereo');
    assert.equal(app.room.s.trackPrefs[moved.id]?.channel, 'left');
  } finally {
    await app.close();
  }
});

test('remapRoots drops tracks that a nested library folder owns', () => {
  const tracks = [{ root: 0, dir: 'YouTube/x' }, { root: 0, dir: 'A' }, { root: 0, dir: 'YouTubeX' }, { root: 1, dir: '' }];
  const out = remapRoots(tracks, ['/m', '/m/YouTube'], ['/m', '/m/YouTube']);
  assert.deepEqual(out.map((t) => t.dir), ['A', 'YouTubeX', '']);
  assert.deepEqual(rescanForPaths(['/a', '/b'], ['/a', '/b']), []);
  assert.deepEqual(rescanForPaths(['/a'], ['/a', '/b']), ['/b']);
  assert.deepEqual(rescanForPaths(['/a', '/a/b', '/c'], ['/a']), ['/a']);
});
