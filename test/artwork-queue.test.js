// The artwork service's queues under stress: provider back-offs, the throttle's priorities,
// image downloads (queue, host back-off, guest budget, eviction), settings changes, the crawler
// and meta.json. The network is faked (test/fake-art.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { ArtworkService, PRIO } from '../server/artwork/service.js';
import { imageUrls } from '../server/artwork/providers.js';
import { Throttle } from '../server/util/throttle.js';
import { RateLimiter } from '../server/util/ratelimit.js';
import { Settings } from '../server/config.js';
import { Catalog } from '../server/library/catalog.js';
import { readJson } from '../server/util/jsonfile.js';
import { tmpDir, rawTracks } from './helpers.js';
import { fakeArtFetch, offlineFetch, pngImage } from './fake-art.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'artwork');
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(FIX, `${name}.json`), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Resolves to the promise's value, or 'timeout' when it takes longer than `ms`. */
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('timed out');
};
/** A promise plus its resolve function (to hold a fake response back). */
const gate = () => {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
};
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const NAMES = [
  'Queen - Bohemian Rhapsody [SF Karaoke]',
  'Adele - Hello [SF Karaoke]',
  'Nobody Knows - Unknown Tune [SF Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
];

async function makeService({ names = NAMES, fetch = fakeArtFetch({ unknown: new Set(['nobody knows']) }), settings: patch, dataDir, now } = {}) {
  dataDir ||= await tmpDir('ok-artq-');
  const settings = new Settings(dataDir);
  settings.update({ artwork: { crawl: false }, ...patch });
  const library = new EventEmitter();
  library.catalog = new Catalog().load(rawTracks(names));
  const art = new ArtworkService({ dataDir, settings, library, fetch, crawlDelayMs: 5, ...(now ? { now } : {}) });
  await art.init({ crawl: false });
  const song = (title) => [...library.catalog.songs.values()].find((s) => s.title === title);
  const artist = (name) => library.catalog.artistList.find((a) => a.name === name);
  return { art, settings, library, song, artist, dataDir, fetch };
}

// ---- the throttle ------------------------------------------------------------------------------

test('throttle: urgent waiters are served first; they give up at once when a pause or the queue ahead is too long', async () => {
  const th = new Throttle({ capacity: 1, perMs: 60 });
  await th.wait(); // the one token is used
  const order = [];
  const crawl = th.wait({ prio: 2 }).then(() => order.push('crawl'));
  const now = th.wait({ prio: 0, maxWaitMs: 5000 }).then(() => order.push('now'));
  await Promise.all([crawl, now]);
  assert.deepEqual(order, ['now', 'crawl'], 'the urgent waiter overtook the patient one');

  // A long pause: patient waiters stay queued, urgent ones are refused right away (not after
  // waiting their turn behind the patient ones).
  th.pause(60_000);
  const patient = th.wait({ prio: 2 });
  patient.catch(() => {});
  assert.equal(await within(th.wait({ prio: 0, maxWaitMs: 1000 }).catch((e) => e.code), 200), 'busy');
  // A pause that starts while an urgent caller waits sends it away too.
  th.resume();
  await patient;
  const waiting = th.wait({ prio: 1, maxWaitMs: 1000 }).catch((e) => e.code);
  th.pause(30_000);
  assert.equal(await within(waiting, 200), 'busy');
  th.resume();

  // The queue ahead counts: 10 waiters at 1 per 60 ms is more than 300 ms.
  const crowd = Array.from({ length: 10 }, () => th.wait({ prio: 1 }).catch((e) => e.code));
  assert.equal(await within(th.wait({ prio: 1, maxWaitMs: 300 }).catch((e) => e.code), 200), 'busy');
  assert.equal(await within(th.wait({ prio: 0, maxWaitMs: 300 }).then(() => 'ok'), 250), 'ok', 'an urgent caller goes first');
  assert.ok(th.waiting > 0);
  th.cancel();
  assert.ok((await Promise.all(crowd)).includes('cancelled'));
  assert.equal(th.waiting, 0);
});

// ---- provider back-offs ------------------------------------------------------------------------

test('Deezer backing off: urgent lookups and "fix artwork" skip it at once; crawl jobs hold no worker', async () => {
  const mb = await fixture('musicbrainz-recording-search');
  const fetch = fakeArtFetch({
    unknown: new Set(['adele']),
    override: (u) => {
      if (u.hostname === 'api.deezer.com') return json({}, 429, { 'retry-after': '40' });
      if (u.hostname === 'musicbrainz.org') return json(mb);
      return undefined;
    },
  });
  const names = ['Adele - Someone Like You [SF Karaoke]', ...Array.from({ length: 12 }, (_, i) => `Band ${i} - Song ${i} [SF Karaoke]`)];
  const { art, library } = await makeService({ names, fetch });
  const songs = [...library.catalog.songs.values()];
  const target = songs.find((s) => s.title === 'Someone Like You');
  // The crawler has Deezer busy when it starts answering 429 (Retry-After: 40 s).
  const crawl = songs.filter((s) => s !== target).map((s) => art.request('song', s, 'crawl'));
  await until(() => art.throttles.deezer.pausedFor() > 30_000);
  await sleep(20);
  assert.equal(art.running.deezer, 0, 'no crawl job sits on a Deezer worker during the back-off');
  assert.deepEqual(await within(Promise.all(crawl), 1000), crawl.map(() => null), 'crawl jobs step aside (asked again on the next pass)');

  const t0 = Date.now();
  assert.equal(await within(art.request('song', target, 'now'), 5000), true, 'the TV’s lookup went on to MusicBrainz');
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(art.songs.get(target.key).p, 'musicbrainz');

  const t1 = Date.now();
  const cands = await within(art.candidates(target), 5000);
  assert.notEqual(cands, 'timeout', 'the host’s dialog got an answer');
  assert.ok(Date.now() - t1 < 4000);
  assert.ok(cands.errors.some((e) => /Deezer is busy/.test(e)));
  assert.ok(cands.items.some((c) => /MusicBrainz/.test(c.provider)));
  await art.close();
});

test('a short back-off: queued crawl jobs wait in the queue (no worker held), then run', async () => {
  let n = 0;
  const fetch = fakeArtFetch({
    override: (u) => (u.hostname === 'api.deezer.com' && u.pathname === '/search' && n++ < 3 ? json({}, 429, { 'retry-after': '1' }) : undefined),
  });
  const names = Array.from({ length: 5 }, (_, i) => `Band ${i} - Song ${i} [SF Karaoke]`);
  const { art, library } = await makeService({ names, fetch });
  const jobs = [...library.catalog.songs.values()].map((s) => art.request('song', s, 'crawl'));
  const results = Promise.all(jobs);
  await until(() => art.throttles.deezer.pausedFor() > 0);
  await sleep(50);
  assert.equal(art.running.deezer, 0);
  assert.equal(art.queues.deezer[PRIO.crawl].length, 2, 'the rest wait for the pause to end');
  assert.deepEqual(await within(results, 4000), [null, null, null, true, true]);
  await art.close();
});

test('a failing fallback provider doesn’t hold up the crawler; its crawl jobs are dropped until the next pass', async () => {
  const fetch = fakeArtFetch({
    unknown: new Set(['band', ...Array.from({ length: 6 }, (_, i) => `band ${i}`)]), // strict and loose searches
    override: (u) => (u.hostname === 'musicbrainz.org' ? new Response('oops', { status: 500 }) : undefined),
  });
  const names = Array.from({ length: 6 }, (_, i) => `Band ${i} - Song ${i} [SF Karaoke]`);
  const { art, library } = await makeService({ names, fetch });
  const songs = [...library.catalog.songs.values()];
  const results = await within(Promise.all(songs.map((s) => art.request('song', s, 'crawl'))), 3000);
  assert.deepEqual(results, songs.map(() => null), 'not stuck behind the MusicBrainz back-off');
  assert.equal(art.queues.musicbrainz[PRIO.crawl].length, 0);
  assert.equal(art.health.musicbrainz.status, 'error');
  for (const s of songs) assert.deepEqual(art.songChain(s.key), ['musicbrainz'], 'Deezer’s miss is kept, MusicBrainz is asked later');
  await art.close();
});

// ---- Cover Art Archive -------------------------------------------------------------------------

async function caaService(caa) {
  const mb = await fixture('musicbrainz-recording-search');
  const png = pngImage('caa');
  const state = { caa };
  const fetch = fakeArtFetch({
    unknown: new Set(['adele']),
    override: (u) => {
      if (u.hostname === 'musicbrainz.org') return json(mb);
      if (u.hostname === 'coverartarchive.org') {
        const r = state.caa(u);
        if (r === 'png') return new Response(png, { status: 200 });
        return r;
      }
      return undefined;
    },
  });
  const ctx = await makeService({ names: ['Adele - Someone Like You [SF Karaoke]'], fetch });
  return { ...ctx, state, s: [...ctx.library.catalog.songs.values()][0] };
}

test('Cover Art Archive down (HTTP 503 or no answer): nothing is recorded as missing; asked again later', async () => {
  for (const failure of [() => new Response('down', { status: 503 }), () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))]) {
    const { art, s, state } = await caaService(failure);
    assert.equal(await art.request('song', s, 'now'), null, 'not asked now (rather than "nothing found")');
    const e = art.songs.get(s.key);
    assert.ok(!e?.tried?.includes('musicbrainz'), 'no MusicBrainz miss');
    assert.deepEqual(art.songChain(s.key), ['musicbrainz']);
    assert.equal(art.health.musicbrainz.status, 'error');
    assert.match(art.health.musicbrainz.lastError, /Cover Art Archive/);
    // Back online: "try again" finds the cover.
    state.caa = () => 'png';
    art.retryMisses();
    assert.equal(await art.request('song', s, 'now'), true);
    assert.match(art.songs.get(s.key).cover, /^caa:/);
    await art.close();
  }
  // A real "no front cover" (404 everywhere) is still a miss.
  const { art, s } = await caaService(() => new Response('', { status: 404 }));
  assert.equal(await art.request('song', s, 'now'), false);
  assert.deepEqual(art.songs.get(s.key).tried, ['deezer', 'musicbrainz']);
  await art.close();
});

test('fix artwork: a MusicBrainz candidate gets the first release group that really has a cover', async () => {
  const { art, s, state } = await caaService((u) => (u.pathname.includes('2222') ? new Response('', { status: 404 }) : 'png'));
  const { items } = await art.candidates(s);
  const mbItem = items.find((c) => /MusicBrainz/.test(c.provider));
  assert.ok(mbItem);
  await art.choose(s, mbItem.id);
  const e = art.songs.get(s.key);
  assert.equal(e.manual, true);
  assert.equal(e.cover, 'caa:3c4d5e6f-3333-4333-8333-333333333333', 'the release group without art was skipped');
  // No release group with art: the choice is refused instead of saving a broken cover.
  art.candidateCache.clear();
  art.badUrls.clear();
  art.files.clear();
  state.caa = () => new Response('', { status: 404 });
  const again = await art.candidates(s);
  await assert.rejects(art.choose(s, again.items.find((c) => /MusicBrainz/.test(c.provider)).id), /no picture/);
  assert.equal(art.songs.get(s.key).cover, 'caa:3c4d5e6f-3333-4333-8333-333333333333', 'the earlier choice is kept');
  await art.close();
});

// ---- turning things off ----------------------------------------------------------------------------

test('turning a provider or online artwork off stops lookups that are already queued', async () => {
  const unknown = new Set(['band', ...Array.from({ length: 30 }, (_, i) => `band ${i}`)]);
  const fetch = fakeArtFetch({ unknown });
  const names = Array.from({ length: 30 }, (_, i) => `Band ${i} - Song ${i} [SF Karaoke]`);
  const { art, settings, library } = await makeService({ names, fetch });
  const songs = [...library.catalog.songs.values()];
  const all = Promise.all(songs.map((s) => art.request('song', s, 'visible')));
  await until(() => art.queues.musicbrainz[PRIO.visible].length >= 3);
  // MusicBrainz unticked: its queued jobs end (iTunes is off too); no more requests to it.
  const waiting = art.queues.musicbrainz[PRIO.visible].map((job) => job.promise);
  settings.update({ artwork: { providers: { musicbrainz: false } } });
  art.settingsChanged();
  const mbCalls = () => fetch.calls.filter((u) => u.includes('musicbrainz.org')).length;
  const n = mbCalls();
  assert.equal(art.queues.musicbrainz[PRIO.visible].length, 0);
  assert.deepEqual(await within(Promise.all(waiting), 300), waiting.map(() => null), 'not asked');
  await sleep(1300);
  assert.ok(mbCalls() <= n + 1, 'at most the request already on its way');
  // Artwork off: nothing at all goes out any more, and every lookup ends.
  settings.update({ artwork: { enabled: false } });
  art.settingsChanged();
  const total = fetch.calls.length;
  const results = await within(all, 2000);
  assert.notEqual(results, 'timeout');
  await sleep(300);
  assert.equal(fetch.calls.length, total);
  await art.close();
});

test('artwork turned off while MusicBrainz answers: the cover check is not taken for "no cover"', async () => {
  const mb = await fixture('musicbrainz-recording-search');
  const hold = gate();
  const fetch = fakeArtFetch({
    unknown: new Set(['adele']),
    override: (u) => (u.hostname === 'musicbrainz.org' ? hold.p.then(() => json(mb)) : undefined),
  });
  const { art, settings, library } = await makeService({ names: ['Adele - Someone Like You [SF Karaoke]'], fetch });
  const s = [...library.catalog.songs.values()][0];
  const result = art.request('song', s, 'now');
  await until(() => fetch.calls.some((u) => u.includes('musicbrainz.org')));
  settings.update({ artwork: { enabled: false } });
  art.settingsChanged();
  hold.open();
  assert.equal(await result, null);
  assert.ok(!art.songs.get(s.key)?.tried?.includes('musicbrainz'));
  settings.update({ artwork: { enabled: true } });
  assert.deepEqual(art.songChain(s.key), ['musicbrainz'], 'asked again once artwork is back on');
  await art.close();
});

// ---- the host's choices, artist upgrades ---------------------------------------------------------------

test('the host’s "no cover" made while an automatic lookup is under way is kept', async () => {
  const hold = gate();
  const inner = fakeArtFetch();
  let asked = false;
  const fetch = async (input) => {
    if (String(input).includes('api.deezer.com/album/')) {
      asked = true;
      await hold.p; // the album request takes a while
    }
    return inner(input);
  };
  fetch.calls = inner.calls;
  const { art, song } = await makeService({ fetch });
  const s = song('Call Me');
  const lookup = art.request('song', s, 'visible');
  await until(() => asked);
  art.setNone(s);
  hold.open();
  assert.equal(await lookup, true);
  assert.deepEqual({ ...art.songs.get(s.key), at: 0 }, { miss: true, manual: true, at: 0, v: 1 });
  await art.close();
});

test('an artist lookup upgraded to fanart/logo: the caller waits for that lookup; it keeps the caller’s priority', async () => {
  const { art, artist, song } = await makeService();
  const a = artist('Blondie');
  const picture = art.request('artist', a, 'visible', 'picture');
  const all = art.request('artist', a, 'visible', 'all'); // e.g. a guest opened the artist page
  assert.equal(await picture, true);
  const follow = art.jobs.get(`artist:${a.key}`);
  assert.equal(follow?.prio, PRIO.visible, 'not promoted to "now"');
  assert.equal(await all, true);
  assert.equal(art.artists.get(a.key).fanart.length, 2, 'resolved after the fanart lookup');

  // The TV's focus prefetches the fanart and the logo in the sizes it shows.
  const q = artist('Queen');
  art.request('artist', q, 'visible', 'picture');
  art.focus([song('Bohemian Rhapsody')]);
  await until(() => {
    const e = art.artists.get(q.key);
    return e?.logo && art.cached(imageUrls(e.logo).m) && art.cached(imageUrls(e.fanart[0]).l);
  });
  await art.close();
});

// ---- images ----------------------------------------------------------------------------------

const coverRef = (i) => `dz:https://e-cdns-images.dzcdn.net/images/cover/${String(i).padStart(32, '0')}/1000x1000-000000-80-0-0.jpg`;

test('image downloads: urgent ones first, a bounded queue of on-demand ones (newest first)', async () => {
  const held = [];
  const order = [];
  const fetch = fakeArtFetch();
  const wrapped = async (input) => {
    const url = String(input);
    if (url.includes('dzcdn.net')) {
      order.push(url);
      const g = gate();
      held.push(g);
      await g.p;
    }
    return fetch(input);
  };
  wrapped.calls = fetch.calls;
  const { art } = await makeService({ fetch: wrapped });
  art.imageThrottle = new Throttle({ capacity: 1000, perMs: 1000 }); // only the queue matters here
  const visible = Array.from({ length: 70 }, (_, i) => art.image(coverRef(i), 's', PRIO.visible));
  await until(() => held.length === 4);
  // 4 downloading, 66 waiting: the 6 oldest waiting ones are dropped at once.
  const early = await within(Promise.all(visible.slice(4, 10)), 500);
  assert.deepEqual(early, [null, null, null, null, null, null]);
  const tv = art.image(coverRef(999), 'm', PRIO.now);
  held.shift().open();
  await until(() => held.length === 4);
  assert.match(order.at(-1), /0{29}999\/500x500/, 'the TV’s picture went ahead of 60 waiting ones');
  // Let everything through.
  const drain = setInterval(() => { while (held.length) held.shift().open(); }, 5);
  assert.ok(await tv);
  const done = await Promise.all(visible);
  clearInterval(drain);
  assert.equal(done.filter(Boolean).length, 64);
  await art.close();
});

test('an image host that doesn’t answer is left alone for a while (no wait per picture)', async () => {
  let down = true;
  const fetch = fakeArtFetch({ override: (u) => (down && u.hostname.endsWith('dzcdn.net') ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } })) : undefined) });
  const { art } = await makeService({ fetch });
  assert.equal(await art.image(coverRef(1), 's'), null);
  const n = fetch.calls.length;
  assert.equal(await art.image(coverRef(2), 'm'), null);
  assert.equal(await art.image(coverRef(3), 'l'), null);
  assert.equal(fetch.calls.length, n, 'not asked again while backing off');
  await assert.rejects(art.image(coverRef(4), 's', PRIO.now, { strict: true }), (e) => e.code === 'unavailable');
  down = false;
  art.retryMisses(); // the host's "try again"
  assert.ok(await art.image(coverRef(2), 'm'));
  await art.close();
});

test('guests have a budget for lookups and downloads; the host has none', async () => {
  const { art, song } = await makeService({ fetch: fakeArtFetch() });
  art.guestLimit = new RateLimiter({ capacity: 2, perMs: 60_000 });
  const guest = { isHost: false, ip: '192.168.1.50', query: new URLSearchParams('s=1000') };
  for (const t of ['Bohemian Rhapsody', 'Hello', 'Call Me']) assert.equal(await art.serveSong(guest, song(t)), false);
  await until(() => art.songs.get(song('Bohemian Rhapsody').key)?.cover && art.songs.get(song('Hello').key)?.cover);
  await sleep(50);
  assert.equal(art.songs.has(song('Call Me').key), false, 'the third lookup was not queued');
  const n = art.fetch.calls.length;
  assert.equal(await art.image(coverRef(5), 'l', PRIO.visible, { mayDownload: () => art.mayFetch(guest) }), null);
  assert.equal(art.fetch.calls.length, n, 'no download over the budget');
  assert.ok(await art.image(coverRef(5), 'l', PRIO.visible, { mayDownload: () => art.mayFetch({ isHost: true }) }));
  assert.ok(art.mayFetch({ isHost: false, ip: '192.168.1.51' }), 'every phone has its own budget');
  await art.close();
});

test('the cache evicts big pictures before the small list thumbnails', async () => {
  const { art } = await makeService({ settings: { artwork: { crawl: false, maxCacheMB: 20 } } });
  const kb = 1024;
  const add = (key, size, used) => {
    art.files.set(key, { ext: 'png', size, used });
    art.bytes += size;
  };
  for (let i = 0; i < 100; i++) add(`s${String(i).padStart(39, '0')}`, 20 * kb, 1000 + i); // old thumbnails
  for (let i = 0; i < 4; i++) add(`b${String(i).padStart(39, '0')}`, 6 * 1024 * kb, 5000 + i); // newer 1000 px pictures
  art.evict();
  assert.ok(art.bytes <= 18 * 1024 * kb);
  assert.equal([...art.files.keys()].filter((k) => k[0] === 's').length, 100, 'every thumbnail kept');
  assert.deepEqual([...art.files.keys()].filter((k) => k[0] === 'b').map((k) => k.at(-1)), ['2', '3'], 'the oldest big ones went');
  await art.close();
});

/** Serves `fn(ctx)` over HTTP (the placeholder when it returns false); returns the base URL and a stop function. */
async function serveOver(fn) {
  const server = http.createServer(async (req, res) => {
    const ctx = { req, res, isHost: true, ip: '127.0.0.1', query: new URL(req.url, 'http://x').searchParams };
    try {
      if (!(await fn(ctx))) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('placeholder');
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e.code || e.message));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => server.close(r)) };
}

test('a big picture downloaded into a full cache is kept and served; pictures used minutes ago go last', async () => {
  const big = Buffer.concat([pngImage('big'), Buffer.alloc(150 * 1024)]); // a 1000 px cover (over 64 KB)
  const fetch = fakeArtFetch({ override: (u) => (u.hostname.endsWith('dzcdn.net') && u.pathname.includes('/1000x1000') ? new Response(big, { status: 200 }) : undefined) });
  const { art, song } = await makeService({ fetch, settings: { artwork: { crawl: false, maxCacheMB: 20 } } });
  const kb = 1024;
  const add = (key, size, used) => {
    art.files.set(key, { ext: 'png', size, used });
    art.bytes += size;
  };
  add(`o${'0'.repeat(39)}`, 200 * kb, 500); // an old big picture
  add(`r${'0'.repeat(39)}`, 200 * kb, Date.now() - 2 * 60_000); // fetched for the TV two minutes ago
  for (let i = 0; art.bytes + 25 * kb <= art.cacheMax(); i++) add(`s${String(i).padStart(39, '0')}`, 25 * kb, 1000 + i); // old thumbnails: the cache is full

  // The TV asks for a big cover: the download pushes the cache over its limit.
  const img = await art.image(coverRef(7), 'l', PRIO.now);
  assert.ok(img, 'image() gave the file');
  assert.ok((await fs.stat(img.abs)).size > 150 * kb, 'and it is on the disk');
  assert.ok(art.cached(imageUrls(coverRef(7)).l), 'and in the index');
  assert.ok(art.bytes <= art.cacheMax());
  assert.ok(!art.files.has(`o${'0'.repeat(39)}`), 'the old big picture went first');
  assert.ok(art.files.has(`r${'0'.repeat(39)}`), 'the recent one is kept (thumbnails go before it)');

  // Over HTTP, with the cache full again: the TV gets the picture, not an error.
  const s = song('Hello');
  art.songs.set(s.key, { p: 'deezer', id: '1', cover: coverRef(8), at: Date.now(), v: 1 });
  for (let i = 0; art.bytes + 25 * kb <= art.cacheMax(); i++) add(`t${String(i).padStart(39, '0')}`, 25 * kb, 2000 + i);
  const http1 = await serveOver((ctx) => art.serveSong(ctx, s));
  const res = await globalThis.fetch(`${http1.url}/?s=1000`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal((await res.arrayBuffer()).byteLength, big.length);

  // A cached file that is gone from the disk after all: the placeholder, and the index forgets it.
  const file = art.cached(imageUrls(coverRef(8)).l);
  await fs.unlink(file.abs);
  const before = art.bytes;
  const gone = await globalThis.fetch(`${http1.url}/?s=1000`);
  assert.equal(gone.status, 200);
  assert.equal(await gone.text(), 'placeholder');
  assert.equal(art.cached(imageUrls(coverRef(8)).l), null);
  assert.equal(art.bytes, before - big.length);
  await http1.stop();
  await art.close();
});

test('right after a restart, cached pictures are served (even offline) while the cache is still being indexed', async () => {
  const first = await makeService();
  const s = first.song('Hello');
  assert.equal(await first.art.request('song', s, 'now'), true);
  const cover = first.art.songs.get(s.key).cover;
  assert.ok(await first.art.image(cover, 's'));
  await first.art.close();
  const again = await makeService({ dataDir: first.dataDir, fetch: offlineFetch });
  const img = await again.art.image(cover, 's');
  assert.ok(img, 'found on disk, not downloaded');
  assert.equal(img.type, 'image/png');
  await again.art.close();
});

// ---- the crawler -----------------------------------------------------------------------------------

test('crawler: "try again", new songs and a provider turned on wake a finished crawl at once', async () => {
  const { art, settings, library, song } = await makeService();
  settings.update({ artwork: { crawl: true } });
  art.crawlTick();
  // Passes (skipping the minute between them) until one finds nothing to do: then it rests 30 minutes.
  const finish = () => until(() => {
    if (art.crawl.state === 'done') return true;
    if (!art.crawl.list && art.crawl.inFlight <= 0) {
      art.crawl.restartAt = 0;
      clearTimeout(art.crawl.timer);
      art.crawlTick();
    }
    return false;
  }, 8000);
  await finish();
  assert.ok(art.crawl.restartAt - Date.now() > 20 * 60_000);
  const calls = (host) => art.fetch.calls.filter((u) => u.includes(host)).length;

  // "Try songs without a cover again": the missed song is asked at once.
  let n = calls('api.deezer.com/search');
  assert.equal(art.retryMisses().cleared, 1);
  await until(() => calls('api.deezer.com/search') > n);
  await until(() => art.songs.get(song('Unknown Tune').key)?.miss);

  // New songs in the library.
  library.catalog = new Catalog().load(rawTracks([...NAMES, 'Abba - Waterloo [SF Karaoke]']));
  library.emit('changed');
  const waterloo = [...library.catalog.songs.values()].find((x) => x.title === 'Waterloo');
  await until(() => art.songs.get(waterloo.key)?.cover);

  // A provider turned on: the songs nobody found are asked there.
  await finish();
  n = calls('itunes.apple.com');
  settings.update({ artwork: { providers: { itunes: true } } });
  art.settingsChanged();
  await until(() => calls('itunes.apple.com') > n);
  await art.close();
});

test('crawler: the artist phase doesn’t pile artists onto TheAudioDB, and it prefetches artist pictures', async () => {
  const names = Array.from({ length: 24 }, (_, i) => `Band ${i} - Song ${i} [SF Karaoke]`);
  const fetch = fakeArtFetch({ override: (u) => (u.hostname === 'api.deezer.com' && u.pathname === '/search/artist' ? json({ data: [], total: 0 }) : undefined) });
  const { art, settings, library } = await makeService({ names, fetch });
  // Every song is known already (no artist picture came with it), one artist has a picture.
  const songs = [...library.catalog.songs.values()];
  for (const s of songs) art.songs.set(s.key, { p: 'deezer', id: '1', cover: coverRef(s.title.length), at: Date.now(), v: 1 });
  const pictured = library.catalog.artistList[0];
  const picture = coverRef(4242).replace('/cover/', '/artist/');
  art.artists.set(pictured.key, { picture, tried: ['deezer'], at: Date.now(), v: 1 });
  settings.update({ artwork: { crawl: true } });
  art.crawlTick();
  let most = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    most = Math.max(most, art.queues.theaudiodb[PRIO.crawl].length + art.runningCrawl.theaudiodb);
    await sleep(20);
  }
  assert.ok(most > 0, 'TheAudioDB was asked');
  assert.ok(most <= 6, `at most a handful queued for TheAudioDB (was ${most})`);
  assert.ok(art.cached(imageUrls(picture).s), 'the known artist picture was downloaded for the lists');
  await art.close();
});

test('crawler: songs and artists waiting for a provider in a long back-off are left alone (short ticks, no fake rate)', async () => {
  const names = Array.from({ length: 3000 }, (_, i) => `Band ${i} - Song ${i} [SF Karaoke]`);
  const { art, settings, library } = await makeService({ names });
  // Most songs are known (with their list thumbnails cached); every 10th still waits for
  // MusicBrainz (Deezer had nothing). Every artist waits for TheAudioDB.
  let i = 0;
  const pending = [];
  for (const s of library.catalog.songs.values()) {
    if (i++ % 10 === 0) {
      art.songs.set(s.key, { miss: true, tried: ['deezer'], at: Date.now(), v: 1 });
      pending.push(s);
      continue;
    }
    art.songs.set(s.key, { p: 'deezer', id: '1', cover: coverRef(i), at: Date.now(), v: 1 });
    art.files.set(art.fileKey(imageUrls(coverRef(i)).s), { ext: 'jpg', size: 20_000, used: 1 });
  }
  for (const a of library.catalog.artistList) art.artists.set(a.key, { tried: ['deezer'], at: Date.now(), v: 1 });
  assert.deepEqual(art.artistChain(library.catalog.artistList[0].key), ['theaudiodb']);
  // Both answer HTTP 502: a back-off of a minute.
  art.failed('musicbrainz', 'error', 'HTTP 502');
  art.failed('theaudiodb', 'error', 'HTTP 502');
  const pauseEnd = Date.now() + art.throttles.musicbrainz.pausedFor();

  let requests = 0;
  const request = art.request.bind(art);
  art.request = (...args) => {
    requests++;
    return request(...args);
  };
  // How many songs and artists each crawl tick looks at.
  let looked = 0;
  for (const name of ['songChain', 'artistChain']) {
    const fn = art[name].bind(art);
    art[name] = (...args) => {
      looked++;
      return fn(...args);
    };
  }
  const tick = art.crawlTick.bind(art);
  let most = 0;
  art.crawlTick = () => {
    looked = 0;
    tick();
    most = Math.max(most, looked);
  };
  settings.update({ artwork: { crawl: true } });
  art.crawlTick();
  await until(() => art.crawl.restartAt, 5000); // the pass ended
  assert.ok(most > 0 && most <= 1000, `a slice of the catalogue per tick (was ${most})`);
  assert.equal(requests, 0, 'no lookup was started for them');
  assert.equal(art.jobs.size, 0);
  assert.equal(art.fetch.calls.filter((u) => /musicbrainz|theaudiodb/.test(u)).length, 0);
  art._status = null;
  const st = art.status();
  assert.equal(st.state, 'waiting');
  assert.equal(st.perMin, 0, 'nothing was looked up');
  assert.equal(st.etaSec, null);
  assert.equal(st.songs.pending, pending.length);
  assert.ok(Math.abs(art.crawl.restartAt - pauseEnd) < 2000, 'the next pass comes when the back-off ends (not every minute)');

  // The back-off is over: the songs are asked, and the rate counts those lookups.
  art.throttles.musicbrainz.resume();
  art.wakeCrawl();
  await until(() => art.songs.get(pending[0].key).tried.includes('musicbrainz'), 5000);
  assert.ok(requests > 0);
  await until(() => art.crawl.recent.length > 0);
  art._status = null;
  assert.ok(art.status().perMin > 0);
  await art.close();
});

// ---- meta.json -------------------------------------------------------------------------------------

test('meta.json: written in slices (valid JSON, every entry); less often while the crawler runs', async () => {
  const { art, dataDir, song } = await makeService();
  for (let i = 0; i < 4500; i++) art.songs.set(`key "${i}" ü\n`, { p: 'deezer', id: String(i), cover: coverRef(i), at: i, v: 1 });
  art.artists.set('a', { picture: coverRef(1), tried: ['deezer'] });
  await art.save();
  const data = await readJson(path.join(dataDir, 'meta.json'));
  assert.equal(data.version, 1);
  assert.equal(Object.keys(data.songs).length, 4500);
  assert.deepEqual(data.songs['key "4499" ü\n'], { p: 'deezer', id: '4499', cover: coverRef(4499), at: 4499, v: 1 });
  assert.deepEqual(data.artists.a.tried, ['deezer']);
  assert.deepEqual(data.albums, {});

  art.crawl.state = 'running';
  art.saveSoon();
  assert.ok(art.saveDue - Date.now() > 60_000, 'crawl results are written every couple of minutes');
  art.setNone(song('Hello'));
  assert.ok(art.saveDue - Date.now() <= 10_000, 'the host’s choice is written soon');
  await art.close();
  assert.equal((await readJson(path.join(dataDir, 'meta.json'))).songs[song('Hello').key].manual, true, 'written on close');
});
