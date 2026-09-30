# Handoff — where the project stands and what to do next

_Last updated: 2026-09-30 (end of the first build session)._

## TL;DR
- **Milestone M0 (foundation) is done and tested**: file-name parser, library scanner (CDG
  pairs / video / zip), catalog with version grouping + artist typo clustering + typo-tolerant
  search, settings schema, utilities, vendored libraries. `npm test` → 35/35 passing.
- **The server does not run yet** — `server/index.js` doesn't exist. Next is **M1: make the
  server run** (library service, HTTP API, media streaming, WebSocket hub), then the TV player
  (M2), room + host app (M3) and guest app (M4). The full spec is in `docs/PLAN.md`.

## What was verified
| Check | Result |
| --- | --- |
| Unit tests (`npm test`) | 35 pass: parser table, grouping keys, catalog grouping/clustering/search/cache, scanner + zip fixtures, settings, QR, net |
| Parser on all 90,479 names from the owner's song list | 99% get a label; ~50.5k songs, ~11.8k artists; typos merged (e.g. Morisette → Morissette) |
| Scanner + catalog on real files from the drive (4 real MP3+CDG pairs) | durations from CDG size match the MP3 length; search works (`scripts/scan-report.js`) |
| Performance (90k simulated tracks) | build 2.5–3.5 s, search 3–20 ms, fuzzy ≤ 100 ms |
| GitHub | `main` pushed to blearymoth/OpenKaraoke |

Not yet verified: a full scan of the real USB drive (run `scripts/scan-report.js` on the PC
first — it's the fastest way to validate everything against 90k real files).

## Decisions already made (and why)
1. **Node server + browser clients, all local.** Owner wants it to run on Linux, offline-capable.
2. **No database, no native modules.** 90k tracks fit in memory (catalog) with a JSON cache;
   keeps install = `git clone` + `node server/index.js`.
3. **Vendored runtime libs** (see `CLAUDE.md`): `ws` (bundled with esbuild), `qrcode-generator`,
   Preact + htm (single ESM file), **Signalsmith Stretch** (MIT, WASM AudioWorklet) for
   high-quality key change + tempo in the browser.
4. **No front-end build step**: Preact + `htm` tagged templates as plain ES modules.
5. **The TV page is the player** (decodes MP3, renders CDG, plays audio). Server is authoritative
   for party state; the main TV is authoritative for media time. Host UI shows a preview.
6. **Second screen** via the Window Management API (`getScreenDetails`) + a kiosk launcher
   script with `--autoplay-policy=no-user-gesture-required`.
7. **Auth**: the PC itself is trusted (localhost); other devices need the host PIN; remote TV
   displays pair with a code approved by the host; guests join with the room code.
8. **Artwork**: Deezer primary (no key), MusicBrainz/Cover Art Archive fallback, TheAudioDB for
   artist fanart/logos; iTunes off by default (its terms forbid caching). Everything cached locally.
9. **Battle scoring = audience voting (+ optional applause meter)**, not pitch scoring — CDG files
   have no melody data, and phone microphones need HTTPS which a LAN http app doesn't have.
10. Repo is **MIT** licensed (owner can change).

## Next steps (in order)

### M1 — server runs (start here)
1. `server/library/service.js` — `LibraryService extends EventEmitter`
   - `init()`: load `data/library.json` → `Catalog.rawFromCache()` → `catalog.load()`; then, if
     `settings.library.rescanOnStart` and a root exists, `scan()` in the background.
   - `scan()`: single-flight; `previous` map from current tracks (`previousKey(t)`);
     `scanLibrary(paths, { previous, onProgress })` → emit `progress`; rebuild + save cache
     **only if the track set changed** (compare a signature of keys + sizes); emit `changed`.
   - `absPath(track, part)`: `path.join(paths[track.root], track.dir, track[part])` — only for
     indexed tracks, never user-supplied paths.
   - Online watcher (20 s): roots appearing/disappearing (USB unplugged) → `status` events,
     auto-scan when a root comes back and was never scanned.
2. `server/http/router.js` (routes with `:params`, `json()`, `readBody(limit)`), `static.js`
   (ETag, gzip text, traversal-safe, `sendFile` with **HTTP Range** → 206), `media.js`
   (`/media/:trackId/audio|cdg|video`, zip entries via `openZipEntry`, gzip CDG with a small LRU),
   `api.js` (PLAN §8: info, search, songs, artists, browse, random, qr.svg, fs/list for host).
3. `server/ws/hub.js` — `WebSocketServer({ noServer: true })` on `/ws`, hello handshake,
   heartbeat (ping every 20 s, drop dead sockets), JSON messages, `rid` request/response helper.
4. `server/index.js` — args (`--help`), data dir, `Settings` + CLI overrides (port, `--library`
   paths saved to settings, `--pin`), room code (generate once), `LibraryService`, HTTP server
   (API, media, static `/js /css /shared`, app shells `/host /tv /j/:code`), hub, prints
   `http://localhost:PORT/host`, the LAN join URL, and flushes state on SIGINT/SIGTERM.
5. `bin/openkaraoke.sh` — checks `node -v` ≥ 18.17, runs the server with the given args.
6. **Done when**: `npm start -- --library "/run/media/ruutu/SMILE-2/<collection folder>"` logs
   scan progress; `curl 'localhost:8080/api/search?q=hello'` returns songs;
   `curl -r 0-99 -o /dev/null -w '%{http_code}' localhost:8080/media/<trackId>/audio` → `206`;
   tests still green (add tests for router/range/media using the zip + tmp fixtures).

### M2 — TV player
`shared/cdg.js` (spec PLAN §9.2, write a synthetic-CDG unit test), `public/js/lib/audio-engine.js`
(PLAN §9.3 — Signalsmith buffer mode, own time map, channel matrix, fades, loudness), `/tv`
page with idle lobby (QR via `/api/qr.svg`), intro card, singing overlays, click-to-start,
keyboard shortcuts. Test with real tracks from the drive in Chrome.

Signalsmith usage sketch:
```js
import SignalsmithStretch from '/js/vendor/signalsmith-stretch.mjs';
const ctx = new AudioContext();
const stretch = await SignalsmithStretch(ctx);           // AudioWorkletNode + helpers
stretch.connect(matrixInput);
const buf = await ctx.decodeAudioData(await (await fetch(`/media/${id}/audio`)).arrayBuffer());
await stretch.addBuffers([buf.getChannelData(0), buf.getChannelData(1 % buf.numberOfChannels)]);
const t0 = ctx.currentTime + 0.1;
stretch.schedule({ active: true, output: t0, input: 0, rate: 1, semitones: 0 }); // remember (t0, input, rate)
// key change later: stretch.schedule({ output: ctx.currentTime + 0.05, input: currentInputTime(), rate, semitones: +2 })
```

### M3 → M7
See `docs/PLAN.md` §18. M4 completes the first party-ready version (host + TV + guests).

## Known limitations / TODOs in existing code
- `catalog.js`: heap ~200–400 MB while building 90k tracks — fine on a desktop; trim
  `p.baseArtist/baseTitle/credits` after build if memory matters. The "Duets" tag also
  includes plain "A & B" credits (≈3.9k songs); consider showing explicit `(Duet)` songs first.
- `catalog.metaFor` returns `null` until the artwork/metadata service (M5) injects it; call
  `catalog.metaChanged()` when metadata or play counts change.
- Artist clustering thresholds are conservative (edit distance 1, or 2 for keys ≥ 10 chars
  with a count ratio ≤ 0.34); watch for false merges of genuinely different artists.
- `scanner.js` follows symlinks without loop detection (add a realpath visited-set if needed).
- `(VR)` annotation meaning unknown — kept as a version label.

## Starter prompt for your Claude Code agent
> Read `CLAUDE.md`, `docs/HANDOFF.md` and `docs/PLAN.md`. Implement milestone **M1 (server
> runs)** exactly as described in HANDOFF "Next steps", following the hard rules in CLAUDE.md
> (no runtime npm deps, ESM, no build step). Validate against my real library at
> `/run/media/ruutu/SMILE-2/` (run `node scripts/scan-report.js` on it first), keep `npm test`
> green with new tests, update HANDOFF.md status, and commit + push after each working piece.
> Then continue with M2, M3 and M4.
