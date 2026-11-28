// The host's own details for a version (data/trackedits.json): laid over the file name's parse
// result at every build (main thread and worker alike), the version moving to another song when
// its artist or title changes, taken back field by field, the cache keeping the file name's own
// result, and the API (Song details → a version → Edit details).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TrackEdits, applyTrackEdit, cleanTrackPatch } from '../server/library/trackedits.js';
import { Catalog } from '../server/library/catalog.js';
import { parseName } from '../server/library/parse.js';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree } from './helpers.js';
import { fakeArtFetch } from './fake-art.js';

test('an edit laid over a parse result: names, label, version note, marks; the original untouched', () => {
  const p = parseName('Queen - Bohemian Rhapsody (Live) [SF Karaoke]');
  const before = JSON.stringify(p);
  const e = applyTrackEdit(p, { artist: 'Queen & David Bowie', title: 'Under Pressure', brand: 'SC', variant: 'Acoustic, Radio Edit', explicit: true, duet: true });
  assert.equal(JSON.stringify(p), before, 'the parse result is not changed');
  assert.equal(e.artist, 'Queen & David Bowie');
  assert.deepEqual(e.credits, ['Queen', 'David Bowie']);
  assert.equal(e.baseTitle, 'Under Pressure');
  assert.equal(e.brand, 'SC');
  assert.deepEqual(e.variant, ['Acoustic', 'Radio Edit']);
  assert.equal(e.flags.live, undefined, 'live came from the old version note');
  assert.equal(e.flags.acoustic, true);
  assert.equal(e.flags.explicit, true);
  assert.ok(e.tags.includes('Explicit') && e.tags.includes('Duets'));
  const off = applyTrackEdit(e, { explicit: false, brand: '', variant: '' });
  assert.equal(off.flags.explicit, undefined);
  assert.ok(!off.tags.includes('Explicit'));
  assert.equal(off.brand, '');
  assert.deepEqual(off.variant, []);
  assert.equal(applyTrackEdit(p, null), p);
});

test('a patch from the host is cleaned; nonsense is refused', () => {
  assert.deepEqual(cleanTrackPatch({ artist: '  The   Beatles ', title: 'Help!\n', brand: null, explicit: false, other: 1 }),
    { artist: 'The Beatles', title: 'Help!', brand: null, explicit: false });
  assert.deepEqual(cleanTrackPatch({ brand: '', variant: '' }), { brand: '', variant: '' }, 'no label is a value');
  assert.throws(() => cleanTrackPatch({ title: '   ' }), /can't be empty/);
  assert.throws(() => cleanTrackPatch({ explicit: 'yes' }), /yes or no/);
  assert.equal(cleanTrackPatch({ title: 'x'.repeat(500) }).title.length, 120);
});

test('the edits file: set, take back field by field, kept across a restart, follows moved ids', async () => {
  const dir = await tmpDir('ok-edits-');
  const file = path.join(dir, 'trackedits.json');
  const edits = await new TrackEdits(file, { now: () => 5 }).load();
  edits.set('abc123', { title: 'Hello', explicit: true });
  edits.set('abc123', { explicit: null });
  assert.deepEqual(edits.get('abc123'), { title: 'Hello', at: 5 });
  assert.throws(() => edits.set('__proto__', { title: 'x' }), /Unknown version/);
  assert.equal(edits.get('constructor'), null);
  assert.equal(edits.rekey([{ from: 'abc123', to: 'def456' }]), 1);
  await edits.flush();
  const again = await new TrackEdits(file).load();
  assert.deepEqual(again.get('def456'), { title: 'Hello', at: 5 });
  edits.set('def456', { title: null });
  assert.equal(edits.get('def456'), null, 'nothing left: the record goes');
  await fs.writeFile(file, JSON.stringify({ tracks: { ok1: { title: 7, brand: '', bogus: 1 }, 'bad id!': { title: 'x' } } }));
  assert.deepEqual(Object.keys((await new TrackEdits(file).load()).tracks), ['ok1']);
});

const raw = (names) => names.map((n) => ({ root: 0, dir: 'Q/Queen', name: n, kind: 'cdg', cdg: `${n}.cdg`, audio: `${n}.mp3`, duration: 200 }));

test('the catalog: an edited version moves to another song, in the worker too; the cache keeps the file name’s result', async () => {
  const names = ['Queen - Bohemian Rhapsody [SF Karaoke]', 'Queen - Bohemian Rhapsody [SC Karaoke]', 'Queen - Killer Quen [SF Karaoke]'];
  const plain = new Catalog().load(raw(names), ['/lib']);
  const typo = [...plain.tracks.values()].find((t) => t.p.title === 'Killer Quen');
  const sc = [...plain.tracks.values()].find((t) => t.p.brand === 'SC');
  const edits = { [typo.id]: { title: 'Killer Queen' }, [sc.id]: { artist: 'Freddie Mercury', explicit: true } };
  const make = () => {
    const c = new Catalog();
    c.editFor = (id) => edits[id] || null;
    c.editsObject = () => edits;
    return c;
  };
  const here = make().load(raw(names), ['/lib']);
  const there = await make().loadAsync(raw(names), ['/lib']);
  for (const c of [here, there]) {
    const titles = c.songList.map((s) => `${s.artist} – ${s.title}`).sort();
    assert.deepEqual(titles, ['Freddie Mercury – Bohemian Rhapsody', 'Queen – Bohemian Rhapsody', 'Queen – Killer Queen']);
    const t = c.track(sc.id);
    assert.equal(t.p.flags.explicit, true);
    assert.equal(t.po.artist, 'Queen', 'the file name’s own result is kept');
    const rec = c.toCache().tracks.find((r) => r.n === t.name);
    assert.equal(rec.p.artist, 'Queen', 'the cache holds the file name’s result, not the edit');
  }
  // An edit taken back: the next build shows the file name's again.
  delete edits[sc.id];
  const tracks = [...here.tracks.values()];
  here.load(tracks, ['/lib']);
  assert.equal(here.track(sc.id).p.artist, 'Queen');
  assert.equal(here.track(sc.id).po, undefined);
  assert.equal(here.songList.length, 2);
});

test('editing a version through the API: details, year and genre; restart keeps them; guests may not', async () => {
  const lib = await tmpDir('ok-lib-');
  const files = {};
  for (const name of ['Queen - Bohemian Rhapsody [SF Karaoke]', 'Queen - Bohemian Rhapsody [SC Karaoke]']) {
    files[`Q/Queen/${name}.cdg`] = Buffer.alloc(7200 * 10);
    files[`Q/Queen/${name}.mp3`] = Buffer.alloc(100);
  }
  await writeTree(lib, files);
  const dataDir = await tmpDir('ok-data-');
  let app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch: fakeArtFetch(), crawl: false });
  await app.library.scan();
  await app.listen(0, '127.0.0.1');
  const base = () => `http://127.0.0.1:${app.port}`;
  const get = async (p) => (await fetch(`${base()}${p}`)).json();
  const post = (body) => fetch(`${base()}/api/library/track`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const song = app.library.catalog.songList[0];
    const detail = await get(`/api/songs/${song.id}`);
    const sf = detail.versions.find((v) => v.brand === 'SF');
    assert.deepEqual(sf.fileInfo, { artist: 'Queen', title: 'Bohemian Rhapsody', brand: 'SF', variant: '', explicit: false, duet: false });
    assert.equal(sf.edited, undefined);

    // The label and a version note: same song; the year and genre go to the song.
    let res = await post({ trackId: sf.id, brand: 'Sunfly', variant: 'Live', year: 1975, genre: 'Rock' });
    assert.equal(res.status, 200);
    let r = await res.json();
    assert.equal(r.songId, song.id);
    let d = await get(`/api/songs/${song.id}`);
    let v = d.versions.find((x) => x.id === sf.id);
    assert.deepEqual([v.brand, v.variant, v.edited.sort()], ['Sunfly', 'Live', ['brand', 'variant']]);
    assert.deepEqual([d.own.year, d.own.genre], [1975, 'Rock']);

    // A new title: the version moves to a song of its own.
    r = await (await post({ trackId: sf.id, title: 'Bohemian Rhapsody (Live Aid)' })).json();
    assert.notEqual(r.songId, song.id);
    d = await get(`/api/songs/${r.songId}`);
    assert.deepEqual([d.title, d.versions.length], ['Bohemian Rhapsody (Live Aid)', 1]);
    assert.equal((await get(`/api/songs/${song.id}`)).versions.length, 1);
    assert.ok((await get('/api/search?q=live%20aid')).items.some((s) => s.id === r.songId), 'search finds the new title');

    // Bad input changes nothing.
    assert.equal((await post({ trackId: sf.id, title: '' })).status, 400);
    assert.equal((await post({ trackId: sf.id, year: 1500 })).status, 400);
    assert.equal((await post({ trackId: 'nope', title: 'x' })).status, 404);

    // A restart: the edits are kept (and the cache did not swallow them).
    await app.close();
    app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch: fakeArtFetch(), crawl: false });
    await app.listen(0, '127.0.0.1');
    assert.equal(app.library.catalog.track(sf.id).p.title, 'Bohemian Rhapsody (Live Aid)');
    await app.library.scan({ reason: 'test' });
    assert.equal(app.library.catalog.track(sf.id).p.title, 'Bohemian Rhapsody (Live Aid)', 'a rescan keeps them too');

    // Back to the file name: one song again.
    r = await (await post({ trackId: sf.id, reset: true })).json();
    assert.equal(r.songId, song.id);
    assert.equal((await get(`/api/songs/${song.id}`)).versions.length, 2);
    assert.equal(app.trackEdits.size, 0);

    app.settings.update({ party: { trustLocalhost: false } });
    assert.equal((await post({ trackId: sf.id, title: 'x' })).status, 403);
    const guestView = await get(`/api/songs/${song.id}`);
    assert.equal(guestView.versions[0].fileInfo, undefined, 'guests do not get the editor’s details');
  } finally {
    await app.close();
  }
});
