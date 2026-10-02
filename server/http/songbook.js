// Printable songbook (PLAN §2): an A4 HTML page to print or save as PDF, or a CSV file.
//
//   GET /api/export/songbook?format=html|csv&sort=artist|title&letter=A&tag=Duets&genre=Pop
//       &decade=1980&popular=500&explicit=0&columns=3
//
// A whole library is 50-90k songs, built while the party goes on: the print order is sorted
// once per library version, the page is built in slices (the server keeps answering phones
// and the TV in between) and compressed off the main thread.
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { HttpError } from '../util/errors.js';
import { intParam, sendText } from './router.js';
import { qrSvg } from '../util/qr.js';
import { formatDuration } from '../../shared/text.js';
import { Lru } from '../util/lru.js';
import { THEMES, normalizeAppearance, accentColors } from '../../shared/themes.js';

// Studio's page font, from the app's own vendored files (Party's songbook keeps the fonts it always named).
const FIGTREE_FACES = [
  ['latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
  ['latin-ext', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'],
].map(([file, range]) => `@font-face { font-family: 'Figtree'; font-style: normal; font-display: swap; font-weight: 300 900; src: url(/fonts/figtree-${file}.woff2) format('woff2'); unicode-range: ${range}; }\n`).join('');

const gzipAsync = promisify(gzip);
const cache = new Lru({ max: 6, maxBytes: 64 * 1024 * 1024 });
const building = new Map(); // cache key -> Promise<Buffer> (two clicks build one book)
const SLICE = 2000; // songs per slice of work between two turns of the event loop
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => {
  const s = String(v ?? '');
  return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ENTITIES[c]) : s;
};
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^[=+\-@\t\r]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"` : s;
};

/** Songs for the book, in print order. */
export function songbookSongs(catalog, { sort = 'artist', letter = '', tag = '', genre = '', decade = 0, popular = 0, explicit = true } = {}) {
  const filter = {};
  if (tag) filter.tag = tag;
  if (genre) filter.genre = genre;
  if (decade) filter.decade = decade;
  if (!explicit) filter.noExplicit = true;
  const f = Object.keys(filter).length ? filter : null;
  const top = popular > 0 ? new Set(catalog.popular({ limit: popular, filter: f }).items) : null;
  return printOrder(catalog, sort).filter((s) => (top ? top.has(s) : catalog._passes(s, f))
    && (!letter || (sort === 'title' ? letterOfTitle(s) : s.letter) === letter));
}

const artistSort = (s) => s.artistFold.replace(/^the /, '');
const titleSort = (s) => s.titleFold.replace(/^(?:the|a|an) /, '');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const orders = new WeakMap(); // catalog.songList (new on every rebuild) -> { artist, title }

/** Every song by artist or by title ("The"/"A" ignored), sorted once per library version. */
function printOrder(catalog, sort) {
  let o = orders.get(catalog.songList);
  if (!o) orders.set(catalog.songList, (o = {}));
  if (!o[sort]) {
    // The sort keys are computed once per song, not twice per comparison.
    const keyed = catalog.songList.map((s) => ({ s, a: artistSort(s), t: titleSort(s) }));
    keyed.sort(sort === 'title' ? (x, y) => cmp(x.t, y.t) || cmp(x.a, y.a) : (x, y) => cmp(x.a, y.a) || cmp(x.t, y.t));
    o[sort] = keyed.map((k) => k.s);
  }
  return o[sort];
}

const letterOfTitle = (s) => {
  const c = titleSort(s).charAt(0);
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
};

/**
 * Text built in slices: `add()` a piece, `await slice()` every SLICE songs (joins the
 * slice, so the final join is short too, and lets the event loop turn), `text()` at the end.
 */
function sliced() {
  const done = [];
  let parts = [];
  return {
    add: (piece) => parts.push(piece),
    slice: () => {
      done.push(parts.join(''));
      parts = [];
      return nextTurn();
    },
    text: () => done.join('') + parts.join(''),
  };
}

export async function songbookCsv(catalog, songs) {
  const out = sliced();
  out.add('﻿Artist,Title,Versions,Length,Year,Genre,Tags\r\n');
  for (let i = 0; i < songs.length; i++) {
    if (i && i % SLICE === 0) await out.slice();
    const s = songs[i];
    const m = catalog.metaFor(s.key);
    out.add(`${[s.artist, s.title, s.versions, formatDuration(s.duration), m?.year || '', m?.genre || '', s.tags.join('; ')].map(csvCell).join(',')}\r\n`);
  }
  return out.text();
}

export async function songbookHtml(catalog, songs, { title, joinUrl, roomCode, sort = 'artist', columns = 3, appearance } = {}) {
  const out = sliced();
  let letter = null;
  let artist = null;
  for (let i = 0; i < songs.length; i++) {
    if (i && i % SLICE === 0) await out.slice();
    const s = songs[i];
    const l = sort === 'title' ? letterOfTitle(s) : s.letter;
    if (l !== letter) {
      if (artist !== null) out.add('</ul></div>');
      if (letter !== null) out.add('</section>');
      out.add(`<section class="letter"><h2>${esc(l)}</h2>`);
      letter = l;
      artist = null;
    }
    const flags = `${s.flags.duet || s.tags.includes('Duets') ? ' <i title="Duet">♥</i>' : ''}${catalog.isExplicit(s) ? ' <i title="Explicit">E</i>' : ''}`;
    if (sort === 'title') {
      out.add(`<p class="t"><b>${esc(s.title)}</b>${flags} <span>${esc(s.artist)}</span></p>`);
      continue;
    }
    if (s.artist !== artist) {
      if (artist !== null) out.add('</ul></div>');
      out.add(`<div class="a"><h3>${esc(s.artist)}</h3><ul>`);
      artist = s.artist;
    }
    out.add(`<li>${esc(s.title)}${flags}</li>`);
  }
  if (artist !== null) out.add('</ul></div>');
  if (letter !== null) out.add('</section>');
  const qr = joinUrl ? qrSvg(joinUrl, { margin: 0 }) : '';
  const cols = Math.min(4, Math.max(1, columns));
  const look = normalizeAppearance(appearance); // the on-screen toolbar and headings follow the skin
  const { accent, ink } = accentColors(look);
  const party = look.theme === 'party';
  const headFont = party ? "'Bricolage', " : "'Figtree', ";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Songbook</title>
<style>
${party ? '' : FIGTREE_FACES}@page { size: A4; margin: 12mm 10mm 14mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 8.6pt/1.3 'Figtree', system-ui, sans-serif; color: #111; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
header { display: flex; align-items: center; gap: 14px; padding: 0 0 8px; border-bottom: 2px solid #111; margin-bottom: 8px; }
header h1 { font: 800 22pt/1 ${party ? "'Bricolage', 'Figtree', " : "'Figtree', "}system-ui, sans-serif; margin: 0; flex: 1; }
header p { margin: 2px 0 0; color: #555; }
header .qr { flex: none; width: 26mm; height: 26mm; }
header .qr svg { width: 100%; height: 100%; }
header .join { text-align: right; font-size: 8pt; color: #333; max-width: 60mm; }
header .join b { font-size: 13pt; letter-spacing: 0.15em; }
header .join .url { font-size: 11pt; letter-spacing: 0.01em; overflow-wrap: anywhere; } /* a long address wraps instead of running into the QR code */
main { column-count: ${cols}; column-gap: 7mm; column-rule: 1px solid #ddd; }
section.letter h2 { font: 800 15pt/1 ${headFont}system-ui, sans-serif; margin: 6px 0 3px; padding: 2px 6px; background: #111; color: #fff; break-after: avoid; }
.a { break-inside: avoid; margin: 0 0 4px; }
.a h3 { font-size: 9pt; margin: 3px 0 1px; }
.a ul { list-style: none; margin: 0; padding: 0 0 0 8px; }
.a li, .t { margin: 0; text-indent: -8px; padding-left: 8px; }
.t span { color: #555; }
i { font-style: normal; font-size: 7pt; font-weight: 700; color: #b0003a; }
.toolbar { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: ${THEMES[look.theme].themeColor}; color: #fff; font: 14px ${party ? '' : "'Figtree', "}system-ui, sans-serif; }
.toolbar button { font: inherit; font-weight: 700; padding: 8px 16px; border: 0; border-radius: ${party ? '99px' : '10px'}; background: ${accent}; color: ${ink}; cursor: pointer; }
.page { padding: 12px 16px; }
@media print { .toolbar { display: none; } .page { padding: 0; } }
</style></head><body>
<div class="toolbar"><button onclick="print()">Print or save as PDF</button><span>${songs.length.toLocaleString('en')} songs — use your browser’s print dialog (A4, “Save as PDF” works too).</span></div>
<div class="page">
<header><div><h1>${esc(title)}</h1><p>${songs.length.toLocaleString('en')} songs · ${sort === 'title' ? 'by title' : 'by artist'} · ${esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</p></div>
${qr ? `<div class="join">Scan to request songs from your phone<br>or open <b class="url">${esc(String(joinUrl).replace(/^https?:\/\//, ''))}</b><br>Room code <b>${esc(roomCode)}</b></div><div class="qr">${qr}</div>` : ''}</header>
<main>${out.text()}</main>
</div></body></html>`;
}

export function songbookRoutes(router, app, { requireHost }) {
  router.get('/api/export/songbook', async (ctx) => {
    requireHost(ctx);
    const q = ctx.query;
    const format = q.get('format') === 'csv' ? 'csv' : 'html';
    const opts = {
      sort: q.get('sort') === 'title' ? 'title' : 'artist',
      letter: (q.get('letter') || '').slice(0, 1).toUpperCase().replace(/[^A-Z#]/, ''),
      tag: (q.get('tag') || '').slice(0, 60),
      genre: (q.get('genre') || '').slice(0, 60),
      decade: intParam(q, 'decade', 0, 0, 2100),
      popular: intParam(q, 'popular', 0, 0, 100000),
      explicit: q.get('explicit') !== '0',
      columns: intParam(q, 'columns', 3, 1, 4),
    };
    const catalog = app.library.catalog;
    if (!catalog.songList.length) throw new HttpError(404, 'The library is empty — nothing to print yet.');
    const info = app.info();
    const appearance = app.settings.get('appearance');
    const key = JSON.stringify([format, opts, catalog.version, catalog.metaVersion, info.name, info.joinUrl, appearance]);
    let body = cache.get(key);
    if (!body) {
      let job = building.get(key);
      if (!job) {
        job = (async () => {
          const songs = songbookSongs(catalog, opts);
          const text = format === 'csv'
            ? await songbookCsv(catalog, songs)
            : await songbookHtml(catalog, songs, { title: info.name, joinUrl: info.joinUrl, roomCode: info.roomCode, sort: opts.sort, columns: opts.columns, appearance });
          const gz = await gzipAsync(Buffer.from(text), { level: 6 });
          cache.set(key, gz);
          return gz;
        })().finally(() => building.delete(key));
        building.set(key, job);
      }
      body = await job;
    }
    const headers = { 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'cache-control': 'no-store' };
    if (format === 'csv') headers['content-disposition'] = 'attachment; filename="songbook.csv"';
    sendText(ctx.res, 200, body, format === 'csv' ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8', headers);
  });
}
