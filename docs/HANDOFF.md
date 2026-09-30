# Handoff — where the project stands and what to do next

_Last updated: 2026-09-30 (second build session: M1 done)._

## TL;DR
- **M0 (foundation)** and **M1 (server runs)** are done and tested. `npm start -- --library <folder>`
  starts the server: it loads the cached index, rescans in the background, serves the JSON API,
  streams media with HTTP Range, and accepts WebSocket clients. `npm test` → all green.
- Next: **M2 TV player**, **M3 room + host app**, **M4 guest app** (full spec in `docs/PLAN.md`).

## What was verified
| Check | Result |
| --- | --- |
| Unit tests (`npm test`) | parser, catalog, scanner/zip, settings/QR/net, library service, HTTP router/Range/media/zip/API, WebSocket hello/ping/rid, auth tokens + PIN back-off |
| Parser on all 90,479 names from the owner's song list | 99% get a label; ~50.5k songs, ~11.8k artists; typos merged (e.g. Morisette → Morissette) |
| Scanner + catalog on real files from the drive (4 real MP3+CDG pairs, session 1) | durations from CDG size match the MP3 length; search works (`scripts/scan-report.js`) |
| **Server on a synthetic 90k-track tree** (11.6k folders, sparse files, session 2) | first scan 4.1 s + build 4.1 s; restart: cache load 3.0 s + no-change rescan 1.3 s; `/api/search` 12–35 ms over HTTP (fuzzy typo query ≈130 ms incl. building the vocabulary once); RSS ≈ 475 MB; `library.json` 33 MB |
| Media endpoint | `curl -r 0-99 …/media/<id>/audio` → `206`; CDG gzip; stored + deflated zip entries with Range |

**Not yet verified on the real USB drive** — the session-2 agent ran in a cloud container without
access to `/run/media/ruutu/SMILE-2/`. First thing to do on the PC:
```bash
node scripts/scan-report.js "/run/media/ruutu/SMILE-2/<collection folder>" --search "someone like you"
npm start -- --library "/run/media/ruutu/SMILE-2/<collection folder>"
curl 'localhost:8080/api/search?q=hello'
```

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

### M1 — server runs ✅ (done in session 2)
What exists now (see the code map in `CLAUDE.md`):
- `server/library/service.js` — `LibraryService`: cache load (roots remapped by path), single-flight
  `scan()` with progress events, rebuild + save **only when the track signature changed**, parse
  results reused across rescans, tracks of an unplugged drive are kept (state `offline`/`partial`),
  20 s online watcher that rescans a drive that comes back, `setPaths()`, `absPath()`.
- `server/http/router.js` (params, `*` wildcard, 405, `readBody` limit), `static.js` (ETag/304,
  gzip text, traversal-safe, `sendFile`/`sendBuffer` with Range → 206/416), `media.js`
  (`/media/:trackId/audio|cdg|video`, stored zip entries streamed as a byte slice, deflated ones
  via an LRU, CDG gzip LRU), `api.js` (PLAN §8 + `/api/settings`, `/api/library/*`).
- `server/ws/hub.js` — hello handshake (delegated to `hub.onHello`), heartbeat, `rid` replies,
  per-client token bucket, `broadcast(msg, filter)`.
- `server/room/auth.js` — HMAC tokens (`data/secret.json`), localhost trust, PIN with back-off.
- `server/artwork/placeholder.js` — gradient + initials SVG (`/api/art/*` until M5).
- `server/app.js` (wiring, testable) + `server/index.js` (CLI) + `bin/openkaraoke.sh`.
- `--library` **replaces** the saved library folders; `--port`/`--host` are not saved; `--pin` is.

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
> Read `CLAUDE.md`, `docs/HANDOFF.md` and `docs/PLAN.md`. Continue with the next unfinished
> milestone as described in HANDOFF "Next steps", following the hard rules in CLAUDE.md
> (no runtime npm deps, ESM, no build step). Validate against my real library at
> `/run/media/ruutu/SMILE-2/` (run `node scripts/scan-report.js` on it first), keep `npm test`
> green with new tests, update HANDOFF.md status, and commit + push after each working piece.
> Then continue with M2, M3 and M4.
