// The catalog rebuilt in a worker thread (Catalog.loadAsync, catalog-worker.js), and the rescan
// around it in slices, so a big library doesn't stall the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Catalog, PARSER_VERSION } from '../server/library/catalog.js';
import { LibraryService } from '../server/library/service.js';
import { placer, trackPlace } from '../server/library/ids.js';
import { Settings } from '../server/config.js';
import { createApp } from '../server/app.js';
import { offlineFetch } from './fake-art.js';
import { manyTracks, tmpDir, writeTree } from './helpers.js';

/** Everything a build produces, in a form deepEqual can compare. */
const built = (c) => ({
  roots: c.roots,
  tracks: [...c.tracks.entries()].map(([id, t]) => [id, t.id, t.songId, t.p, t.pv]),
  songs: c.songList.map((s) => ({ ...s })),
  songIds: [...c.songs.keys()],
  artists: c.artistList.map((a) => ({ ...a })),
  artistKeys: [...c.artists.keys()],
  brandRank: [...c.brandRank],
  tagCounts: c.tagCounts,
  brandCounts: c.brandCounts,
});
const copy = (list) => list.map((t) => ({ ...t }));

test('loadAsync builds in a worker thread exactly what load builds', async () => {
  const raw = manyTracks(6000);
  // The same folder and name in a second library folder: the second one gets the longer id.
  raw.push({ ...raw[0], root: 1 }, { ...raw[1], root: 1 });
  const roots = ['/media/a/Karaoke', '/media/b/Karaoke'];
  const parsed = copy(raw);
  const sync = new Catalog().load(parsed, roots);
  // Half of the tracks come with a parse result (as after a rescan), half without.
  const input = copy(raw).map((t, i) => (i % 2 ? { ...t, p: parsed[i].p, pv: PARSER_VERSION } : t));
  const viaWorker = new Catalog();
  const version = viaWorker.version;
  await viaWorker.loadAsync(input, roots);
  assert.deepEqual(built(viaWorker), built(sync));
  assert.equal(viaWorker.version, version + 1);
  assert.equal(viaWorker.search('karo').total, sync.search('karo').total);
  assert.ok(input.every((t) => t.id && t.pv === PARSER_VERSION), 'the tracks got their ids and parse results');
});

test('a stopped loadAsync leaves the catalog as it was', async () => {
  const cat = new Catalog().load(manyTracks(300), ['/lib']);
  const before = built(cat);
  const version = cat.version;
  const abort = new AbortController();
  const job = cat.loadAsync(manyTracks(3000, 11), ['/lib'], { signal: abort.signal });
  setImmediate(() => abort.abort());
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(cat.version, version);
  assert.deepEqual(built(cat), before);
});

test('the cache written in slices is the cache', async () => {
  const cat = new Catalog().load(manyTracks(2500), ['/lib']);
  const parts = await cat.toCacheText({ lastScan: { at: 1 }, departed: { '/lib/x': 'abc' } });
  const text = JSON.parse(parts.join(''));
  const plain = cat.toCache();
  for (const k of ['version', 'parser', 'roots', 'dirs', 'tracks']) assert.deepEqual(text[k], plain[k], k);
  assert.deepEqual(text.lastScan, { at: 1 });
  assert.deepEqual(text.departed, { '/lib/x': 'abc' });
  const again = new Catalog().load(Catalog.rawFromCache(text), ['/lib']);
  assert.deepEqual([...again.tracks.keys()], [...cat.tracks.keys()]);
  const empty = JSON.parse((await new Catalog().toCacheText()).join(''));
  assert.deepEqual([empty.tracks, empty.dirs], [[], []]);
});

test('placer gives the same places as trackPlace', () => {
  const roots = ['/media/u/Karaoke', '/', '/media/u/Karaoke/', 'relative/lib', ''];
  const tracks = [
    { root: 0, dir: 'A/Adele', name: 'Adele - Hello' },
    { root: 0, dir: '', name: 'Loose' },
    { root: 1, dir: 'srv', name: 'x' },
    { root: 1, dir: '', name: 'top' },
    { root: 2, dir: 'B/b', name: 'trailing slash root' },
    { root: 3, dir: 'C', name: 'relative' },
    { root: 4, dir: 'D', name: 'no root' },
    { root: 9, dir: 'E', name: 'unknown root' },
    { root: 0, dir: 'F', name: '' },
    { root: 0, dir: 'G', name: '.' },
    { root: 0, dir: 'H/./I', name: 'dotted dir' },
  ];
  const place = placer(roots);
  for (const t of tracks) assert.equal(place(t), trackPlace(roots, t), JSON.stringify(t));
});

test('settling ids on a rescan of the same folders matches settling them by path', async () => {
  const roots = ['/media/u/Karaoke', '/media/u/More'];
  const snap = [
    { id: 'a1', root: 0, dir: 'A', name: 'Same' },
    { id: 'b1', root: 0, dir: 'B', name: 'Collides' },
    { id: 'c1', root: 0, dir: 'C', name: 'Gone' },
    { id: 'd1', root: 1, dir: '', name: 'Other root' },
    { id: 'e1', root: 1, dir: 'E', name: 'Swapped one' },
    { id: 'e2', root: 1, dir: 'E', name: 'Swapped two' },
    { id: 'z1', root: 5, dir: 'Z', name: 'No such root' },
  ];
  const now = [
    { id: 'a1', root: 0, dir: 'A', name: 'Same' },
    { id: 'b2', root: 0, dir: 'B', name: 'Collides' },
    { id: 'd1', root: 1, dir: '', name: 'Other root' },
    { id: 'e2', root: 1, dir: 'E', name: 'Swapped one' },
    { id: 'e1', root: 1, dir: 'E', name: 'Swapped two' },
    { id: 'n1', root: 0, dir: 'N', name: 'New' },
    { id: 'x1', root: 0, dir: 'X', name: '' },
  ];
  const run = async (how) => {
    const data = await tmpDir('ok-data-');
    const settings = new Settings(data);
    await settings.load();
    const svc = new LibraryService({ dataDir: data, settings });
    svc.catalog.tracks = new Map(now.map((t) => [t.id, { ...t }]));
    if (how === 'fast') svc.settleSameRoots(snap, roots);
    else svc.settleByPlace(roots, snap, roots);
    return { moves: svc.takeIdMoves(), departed: [...svc.departed] };
  };
  const fast = await run('fast');
  assert.deepEqual(fast, await run('by place'));
  assert.deepEqual(fast.moves, [{ from: 'b1', to: 'b2' }, { from: 'e1', to: 'e2' }, { from: 'e2', to: 'e1' }]);
});

test('a rescan of a small library through the worker thread', async () => {
  const lib = await tmpDir('ok-lib-');
  await writeTree(lib, { 'A/Adele/Adele - Hello [SF Karaoke].cdg': 7200 * 100, 'A/Adele/Adele - Hello [SF Karaoke].mp3': 500 });
  const data = await tmpDir('ok-data-');
  const settings = new Settings(data);
  await settings.load();
  settings.update({ library: { paths: [lib] } });
  const svc = new LibraryService({ dataDir: data, settings, workerMinTracks: 0 });
  await svc.init({ scan: false });
  await svc.scan();
  await writeTree(lib, { 'B/Blondie/Blondie - Call Me [SF Karaoke].cdg': 7200 * 200, 'B/Blondie/Blondie - Call Me [SF Karaoke].mp3': 500 });
  let changed = 0;
  svc.on('changed', () => changed++);
  const res = await svc.scan();
  assert.equal(res.changed, true);
  assert.equal(changed, 1);
  assert.equal(svc.catalog.search('call me').items[0]?.artist, 'Blondie');
  await svc.saving;
  const cache = JSON.parse(await fs.readFile(path.join(data, 'library.json'), 'utf8'));
  assert.equal(cache.tracks.length, 2);
  assert.equal(cache.lastScan.changed, true);
});

test('the server answers requests while a rescan rebuilds a big catalog', async () => {
  // A big library folder known from the cache (not scanned again) and a small one that is:
  // the rescan of the small one rebuilds the whole catalog.
  const big = await tmpDir('ok-lib-');
  await writeTree(big, { 'readme.txt': 'not karaoke' });
  const small = await tmpDir('ok-lib-');
  await writeTree(small, { 'A/Adele/Adele - Hello [SF Karaoke].cdg': 7200 * 100, 'A/Adele/Adele - Hello [SF Karaoke].mp3': 500 });
  const data = await tmpDir('ok-data-');
  const roots = [big, small];
  const N = 25000;
  await fs.writeFile(path.join(data, 'library.json'), JSON.stringify(new Catalog().load(manyTracks(N), roots).toCache()));
  const app = await createApp({ dataDir: data, args: { library: roots }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.port}`;
    await app.library.ready(); // (a cache this big loads in the background)
    assert.equal(app.library.catalog.size, N);
    assert.ok(app.library.workerMinTracks <= N);

    let building = false;
    let inWorker = false;
    const rebuild = app.library.rebuild.bind(app.library);
    app.library.rebuild = async (...args) => {
      building = true;
      try {
        return await rebuild(...args);
      } finally {
        building = false;
      }
    };
    const loadAsync = app.library.catalog.loadAsync.bind(app.library.catalog);
    app.library.catalog.loadAsync = (...args) => {
      inWorker = true;
      return loadAsync(...args);
    };

    const scan = app.library.scan({ roots: [small] });
    let done = false;
    scan.finally(() => { done = true; });
    const waits = [];
    let answeredWhileBuilding = 0;
    while (!done) {
      const t0 = performance.now();
      const res = await fetch(`${base}/api/search?q=karo`);
      assert.equal(res.status, 200);
      assert.ok((await res.json()).items.length);
      waits.push(performance.now() - t0);
      if (building) answeredWhileBuilding++;
    }
    const result = await scan;
    assert.equal(result.changed, true);
    assert.ok(inWorker, 'the catalog was rebuilt in the worker thread');
    assert.ok(answeredWhileBuilding >= 5, `searches answered while the catalog was rebuilt: ${answeredWhileBuilding}`);
    const slowest = Math.max(...waits);
    assert.ok(slowest < 300, `the slowest answer took ${Math.round(slowest)} ms (rebuild: ${app.library.catalog.buildMs} ms)`);
    assert.equal(app.library.catalog.size, N + 1);
    const found = await (await fetch(`${base}/api/search?q=adele%20hello`)).json();
    assert.equal(found.items[0]?.title, 'Hello');
  } finally {
    await app.close();
  }
});

/** A data folder whose library.json holds `tracks` under `cacheRoots`; the settings say `paths`. */
async function cachedLibrary(tracks, cacheRoots, paths, extra = {}) {
  const data = await tmpDir('ok-data-');
  const cat = new Catalog().load(tracks, cacheRoots);
  await fs.writeFile(path.join(data, 'library.json'), (await cat.toCacheText({ lastScan: { at: 5, tracks: tracks.length }, ...extra })).join(''));
  const settings = new Settings(data);
  await settings.load();
  settings.update({ library: { paths, rescanOnStart: false } });
  return { data, settings };
}

/** What a loaded LibraryService holds. */
const loaded = (svc) => ({
  ...built(svc.catalog),
  signature: svc.signature,
  departed: [...svc.departed],
  moves: svc.takeIdMoves(),
  lastScan: svc.lastScan,
  rootCounts: svc.rootCounts,
  hasCache: svc.hasCache,
});

test('Catalog.readCache reads in a worker thread what readJson and rawFromCache read', async () => {
  const data = await tmpDir('ok-data-');
  const file = path.join(data, 'library.json');
  const tracks = manyTracks(2500);
  tracks.push({ root: 0, dir: 'V', name: 'Toto - Africa', kind: 'video', video: 'Toto - Africa.mp4', size: 5, duration: 0, mtime: 1 });
  tracks.push({ root: 0, dir: 'Z', name: 'Zipped', kind: 'zip', zip: 'Zipped.zip', entries: { cdg: 'a.cdg', audio: 'a.mp3' }, size: 5, duration: 9, mtime: 2 });
  await fs.writeFile(file, (await new Catalog().load(tracks, ['/lib']).toCacheText({ lastScan: { at: 1 } })).join(''));
  const plain = JSON.parse(await fs.readFile(file, 'utf8'));
  const { cache, raw } = await Catalog.readCache(file);
  assert.deepEqual(raw, Catalog.rawFromCache(plain));
  assert.deepEqual({ ...cache, tracks: undefined }, { ...plain, tracks: undefined });

  assert.deepEqual(await Catalog.readCache(path.join(data, 'missing.json')), { cache: null, raw: null });
  await fs.writeFile(file, '{"version":3,"tracks":[');
  assert.deepEqual(await Catalog.readCache(file), { cache: null, raw: null });
  assert.ok((await fs.readdir(data)).some((f) => f.startsWith('library.json.corrupt-')), 'a corrupt cache is kept aside');
  await fs.writeFile(file, JSON.stringify({ version: 2, tracks: [] }));
  assert.equal((await Catalog.readCache(file)).raw, null, 'an old cache format is not read');
});

test('a big cache loads in the background exactly as it loads at once', async () => {
  const roots = ['/media/u/Karaoke'];
  const split = [...roots, '/media/u/Karaoke/A']; // a folder that became a library folder of its own
  const tracks = manyTracks(3000);
  const departed = { '/media/u/Karaoke/Gone/x - y': 'abc123' };
  for (const [cacheRoots, paths, extra] of [[roots, roots, {}], [roots, split, { departed }]]) {
    const one = await cachedLibrary(tracks.map((t) => ({ ...t })), cacheRoots, paths, extra);
    const sync = new LibraryService({ dataDir: one.data, settings: one.settings, watchIntervalMs: 1e9 });
    await sync.init({ scan: false });
    assert.equal(sync.loading, null);
    await sync.saving;

    const two = await cachedLibrary(tracks.map((t) => ({ ...t })), cacheRoots, paths, extra);
    const bg = new LibraryService({ dataDir: two.data, settings: two.settings, cacheWorkerMinBytes: 0, workerMinTracks: 0 });
    const changed = [];
    bg.on('changed', (e) => changed.push(e.reason));
    await bg.init({ scan: false });
    assert.ok(bg.loading, 'still loading when init() returns');
    assert.equal(bg.status().loading, true);
    assert.equal(bg.catalog.size, 0);
    await bg.ready();
    assert.equal(bg.loading, null);
    assert.equal(bg.status().loading, false);
    assert.deepEqual(changed, ['cache']);
    const want = loaded(sync);
    if (paths === split) assert.ok(want.departed.length > 1 && want.rootCounts[0] < tracks.length, 'the split case moves tracks out');
    assert.deepEqual(loaded(bg), want);
    await bg.saving;
    const saved = async (dir) => { const c = JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8')); delete c.savedAt; return c; };
    assert.deepEqual(await saved(two.data), await saved(one.data), 'the same cache is written back (or not)');
  }
});

test('a scan asked for while the cache loads waits for it; stop() ends both', async () => {
  const lib = await tmpDir('ok-lib-');
  await writeTree(lib, { 'A/Adele/Adele - Hello [SF Karaoke].cdg': 7200 * 100, 'A/Adele/Adele - Hello [SF Karaoke].mp3': 500 });
  const { data, settings } = await cachedLibrary(manyTracks(2000).map((t) => ({ ...t, dir: `Z/${t.dir}` })), [lib], [lib]);

  const svc = new LibraryService({ dataDir: data, settings, cacheWorkerMinBytes: 0 });
  await svc.init({ scan: false });
  assert.ok(svc.loading);
  const res = await svc.scan();
  // The scan compared the folder with the loaded cache: the cached tracks are gone, Adele is new.
  assert.equal(res.changed, true);
  assert.equal(res.delta, 1 - 2000);
  assert.equal(svc.catalog.size, 1);
  await svc.saving;

  const again = new LibraryService({ dataDir: data, settings, cacheWorkerMinBytes: 0 });
  await again.init({ scan: true });
  again.stop();
  await again.ready();
  assert.equal(again.catalog.size, 0, 'stopped before the catalog was in');
  assert.equal(again.scanning, null, 'no scan after a stop');
});

test('the server listens before a big cache is in; songs wait for it, health does not', async () => {
  const lib = await tmpDir('ok-lib-');
  await writeTree(lib, { 'readme.txt': 'x' });
  const N = 8000;
  const { data } = await cachedLibrary(manyTracks(N), [lib], [lib]);
  assert.ok((await fs.stat(path.join(data, 'library.json'))).size >= 1_500_000, 'big enough to load in the background');
  const app = await createApp({ dataDir: data, args: { library: [lib] }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.port}`;
    assert.ok(app.library.loading, 'createApp did not wait for the catalog');
    assert.equal(app.room.tvView().library.loading, true);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.ok(app.library.loading, 'health answered before the catalog was in');
    const found = await (await fetch(`${base}/api/search?q=karo`)).json();
    assert.ok(found.items.length, 'the search waited for the catalog');
    assert.equal(app.library.loading, null);
    assert.equal(app.library.catalog.size, N);
  } finally {
    await app.close();
  }
});
