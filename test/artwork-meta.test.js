// The catalog hears about new song metadata only when it changes something the catalog uses
// (each change re-sorts the popular list and drops the filtered lists on the next request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ArtworkService } from '../server/artwork/service.js';
import { Settings } from '../server/config.js';
import { Catalog } from '../server/library/catalog.js';
import { offlineFetch } from './fake-art.js';
import { tmpDir, rawTracks } from './helpers.js';

test('service: only metadata the catalog ranks, filters or shows invalidates its caches', async () => {
  const dataDir = await tmpDir('ok-art-meta-');
  const settings = new Settings(dataDir);
  settings.update({ artwork: { crawl: false } });
  const library = new EventEmitter();
  library.catalog = new Catalog().load(rawTracks(['Adele - Hello [SF Karaoke]', 'Queen - Killer Queen [SF Karaoke]']));
  const art = new ArtworkService({ dataDir, settings, library, fetch: offlineFetch });
  await art.init({ crawl: false });
  const [hello, killer] = library.catalog.songList;
  const scheduled = () => {
    const on = !!art.timers.meta;
    clearTimeout(art.timers.meta);
    art.timers.meta = null;
    return on;
  };
  art.setSong(hello, { miss: true, tried: ['deezer'], at: 1, v: 1 });
  assert.equal(scheduled(), false, 'a miss without data changes nothing the catalog uses');
  art.setSong(hello, { miss: true, tried: ['deezer', 'itunes'], at: 2, v: 1 });
  assert.equal(scheduled(), false);
  art.setSong(hello, { miss: true, tried: ['deezer', 'itunes'], year: 2015, at: 3, v: 1 });
  assert.equal(scheduled(), true, 'a year: decade pages and facets');
  art.setSong(killer, { p: 'deezer', cover: 'dz:a', rank: 500000, at: 4, v: 1 });
  assert.equal(scheduled(), true);
  art.setSong(killer, { p: 'deezer', cover: 'dz:a', rank: 500000, confidence: 0.9, at: 5, v: 1 });
  assert.equal(scheduled(), false, 'same cover and rank');
  art.setSong(killer, { p: 'deezer', cover: 'dz:a', rank: 500000, explicit: true, at: 6, v: 1 });
  assert.equal(scheduled(), true, 'explicit: the guests’ filter');
  await art.refresh(killer);
  assert.equal(scheduled(), true, 'forgetting a cover');
  await art.close();
});
