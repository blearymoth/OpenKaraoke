#!/usr/bin/env node
// Scans a karaoke folder with the real scanner + catalog and prints a report.
// Useful to validate parsing against a new library before starting the server.
//
//   node scripts/scan-report.js "/run/media/$USER/DRIVE/Karaoke" [--search "someone like you"] [--json out.json]
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import { scanLibrary } from '../server/library/scanner.js';
import { Catalog } from '../server/library/catalog.js';
import { formatDuration } from '../shared/text.js';

const args = process.argv.slice(2);
const roots = [];
const searches = [];
let jsonOut = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--search') searches.push(args[++i]);
  else if (args[i] === '--json') jsonOut = args[++i];
  else roots.push(args[i]);
}
if (!roots.length) {
  console.error('Usage: node scripts/scan-report.js <folder> [more folders] [--search "text"] [--json out.json]');
  process.exit(1);
}

const t0 = performance.now();
const res = await scanLibrary(roots, {
  onProgress: (p) => process.stderr.write(`\rscanning… ${p.dirs} folders, ${p.tracks} tracks   `),
});
process.stderr.write('\n');
const scanMs = performance.now() - t0;

const t1 = performance.now();
const cat = new Catalog().load(res.tracks, roots);
const buildMs = performance.now() - t1;

const kinds = {};
for (const t of cat.tracks.values()) kinds[t.kind] = (kinds[t.kind] || 0) + 1;
const totalSec = [...cat.tracks.values()].reduce((a, t) => a + (t.duration || 0), 0);

console.log(`\nFolders scanned : ${res.dirs}`);
console.log(`Tracks          : ${cat.tracks.size}  ${JSON.stringify(kinds)}`);
console.log(`Songs (grouped) : ${cat.songs.size}`);
console.log(`Artists         : ${cat.artists.size}`);
console.log(`Total duration  : ${Math.round(totalSec / 3600)} hours`);
console.log(`Scan time       : ${(scanMs / 1000).toFixed(1)} s, catalog build ${(buildMs / 1000).toFixed(1)} s`);
console.log(`Heap used       : ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
if (res.errors.length) {
  console.log(`Errors          : ${res.errors.length}`);
  for (const e of res.errors.slice(0, 10)) console.log(`   ${e.path}: ${e.error}`);
}
console.log('\nTop labels:', cat.brandCounts.slice(0, 15).map((b) => `${b.brand}(${b.count})`).join(' '));
console.log('Tags      :', cat.tagCounts.map((t) => `${t.tag}(${t.count})`).join(' '));

const noBrand = [...cat.tracks.values()].filter((t) => !t.p.brand).slice(0, 8);
if (noBrand.length) console.log('\nSample tracks without a label tag:\n  ' + noBrand.map((t) => t.name).join('\n  '));

const q = searches.length ? searches : ['someone like you', 'queen', 'bohemain rapsody', 'christmas'];
for (const query of q) {
  const r = cat.search(query, { limit: 5 });
  console.log(`\nSearch "${query}": ${r.total} result(s)${r.fuzzy ? ' (typo-tolerant)' : ''}`);
  for (const s of r.items) console.log(`   ${s.artist} - ${s.title}  [${s.versions} version(s), ${formatDuration(s.duration)}]`);
}

if (jsonOut) {
  await fs.writeFile(jsonOut, JSON.stringify(cat.toCache()));
  console.log(`\nCatalog cache written to ${jsonOut}`);
}
