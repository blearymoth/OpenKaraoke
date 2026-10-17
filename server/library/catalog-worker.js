// Worker thread for Catalog.loadAsync(): builds the catalog off the server's thread and posts
// it back compactly (Catalog.exportBuild). One job per worker.
import { parentPort } from 'node:worker_threads';
import { Catalog, PARSER_VERSION } from './catalog.js';

parentPort.once('message', ({ roots, chunks }) => {
  try {
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
    parentPort.postMessage(out, [out.order.buffer, out.songOf.buffer, out.artistOrder.buffer, ...pieces.map((u) => u.buffer)]);
  } catch (e) {
    parentPort.postMessage({ error: e?.message || String(e) });
  }
});
