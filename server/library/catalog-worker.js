// Worker thread for Catalog.loadAsync() and Catalog.readCache(): builds the catalog, or reads the
// catalog cache, off the server's thread and posts it back compactly. One job per worker.
import { parentPort } from 'node:worker_threads';
import { Catalog, PARSER_VERSION, CHUNK } from './catalog.js';
import { readJson } from '../util/jsonfile.js';

parentPort.once('message', async (job) => {
  try {
    if (job.read) parentPort.postMessage(...await readCache(job.read));
    else parentPort.postMessage(...build(job));
  } catch (e) {
    parentPort.postMessage({ error: e?.message || String(e) });
  }
});

function build({ roots, chunks }) {
  const input = [];
  const fresh = [];
  const dec = new TextDecoder();
  for (const part of chunks) {
    for (const [root, dir, name, duration, p] of JSON.parse(dec.decode(part))) {
      const t = { root, dir, name, duration };
      if (p) {
        t.p = p;
        t.pv = PARSER_VERSION;
      } else fresh.push(input.length);
      input.push(t);
    }
  }
  const out = new Catalog().load(input, roots).exportBuild(input, fresh);
  const pieces = [...out.ids, ...out.parsed, ...out.songs, ...out.artists];
  return [out, [out.order.buffer, out.songOf.buffer, out.artistOrder.buffer, ...pieces.map((u) => u.buffer)]];
}

/**
 * The cache file without its track records (`head`), and the records as pieces of JSON text
 * (UTF-8 bytes, transferred): the server's thread reads them a piece at a time. Null when there
 * is no cache (a corrupt one is kept aside, as readJson does).
 */
async function readCache(file) {
  const cache = await readJson(file, null);
  if (!cache || typeof cache !== 'object' || !Array.isArray(cache.tracks)) return [{ head: cache, tracks: [] }];
  const enc = new TextEncoder();
  const tracks = [];
  for (let i = 0; i < cache.tracks.length; i += CHUNK) tracks.push(enc.encode(JSON.stringify(cache.tracks.slice(i, i + CHUNK))));
  cache.tracks = [];
  return [{ head: cache, tracks }, tracks.map((u) => u.buffer)];
}
