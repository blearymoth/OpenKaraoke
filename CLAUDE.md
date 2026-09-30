# OpenKaraoke — guide for Claude Code

OpenKaraoke is a self-hosted, KaraFun-style karaoke party app that runs on the owner's
**Linux PC**. A small Node.js server indexes a local karaoke library (≈90,000 CDG+MP3 tracks
on a USB drive) and serves three browser apps over the home network:

| App | URL | Who uses it |
| --- | --- | --- |
| Host | `/host` | the person running the party (laptop/desktop, or phone/tablet with PIN) |
| TV display | `/tv` | the TV / projector (second screen of the PC, or any browser) — **plays the audio** |
| Guest | `/j/<ROOM>` (QR code) | party guests on their phones: search, request songs, react, play games |

**Start here:** read `docs/HANDOFF.md` (current status + next steps), then `docs/PLAN.md`
(full spec, architecture, protocol, roadmap). `docs/RESEARCH.md` has the feature research
and artwork-API facts; `docs/LIBRARY.md` describes the owner's karaoke collection.

## Hard rules

- **Zero runtime npm dependencies.** Everything needed at runtime is vendored:
  `server/vendor/ws.mjs` (WebSocket server), `server/vendor/qrcode.mjs`,
  `public/js/vendor/preact.js` (Preact + hooks + htm), `public/js/vendor/signalsmith-stretch.mjs`
  (key/tempo). Rebuild them with `npm install && npm run vendor` (devDependencies only).
  Never add native modules (no better-sqlite3, sharp, etc.) — the app must run with a plain
  `node server/index.js` on any Linux box with Node ≥ 18.17.
- **No front-end build step.** Browser code is plain ES modules served as-is.
  UI uses Preact + `htm` tagged templates: `import { html, render, useState } from '/js/vendor/preact.js'`.
- **ESM everywhere** (`"type": "module"`). Node built-ins only (`node:fs`, `node:http`, …).
- `shared/` is isomorphic (imported by both server and browser): no Node APIs there.
  The browser imports it from `/shared/...` (the server must serve that folder).
- Never commit media, song lists/CSVs from the owner's drive, `data/`, or API keys.
- Keep the library code fast: 90k tracks must scan, build (≈3 s) and search (<30 ms).

## Commands

```bash
npm test                                   # unit tests (node:test), must stay green
node scripts/scan-report.js "<karaoke folder>" [--search "text"]   # validate parser/catalog on a real library
npm start -- --library "<karaoke folder>"  # server on :8080 (entry point server/index.js)
npm run vendor                             # rebuild vendored libs after `npm install`
npm run demo -- /tmp/karaoke-demo          # synthetic demo songs (WAV+CDG) when the drive isn't around
npm run e2e                                # browser E2E (needs Playwright + Chromium; not part of npm test)
```

## Code map (what exists today)

- `shared/text.js` — `fold()` (accent/punctuation-insensitive), `compact()`, `editDistance()`,
  `similarity()`, `shortId()` (stable ids), `splitCredits()`, `formatDuration()`.
- `server/library/parse.js` — file-name parser: `"Artist - Title [SF Karaoke]"` →
  artist/title/brand/variant/flags(duet, explicit, clean, bgv, mpx, medley…)/tags(languages,
  Christmas, Disney, Musicals, Kids…). Handles typos/truncation of the `[… Karaoke]` tag,
  disc-id prefixes, `"Beatles, The"`. `artistKeyOf()`/`titleKeyOf()` build grouping keys.
- `server/library/scanner.js` — concurrent directory walk: CDG + audio pairs, video files,
  zipped MP3+G; duration = CDG bytes / 7200. Reuses a previous scan to avoid re-stat.
- `server/library/zip.js` — tiny ZIP reader (stored/deflate) for zipped tracks.
- `server/library/catalog.js` — groups tracks into songs (label versions), clusters artist
  spelling typos, artist pages incl. collaborations, typo-tolerant search, tags, popular,
  random, best-version picking, compact on-disk cache (`toCache` / `rawFromCache`).
- `server/config.js` — `DEFAULT_SETTINGS` (every setting + default), `Settings` (JSON doc with
  sanitised updates), CLI `parseArgs`, room codes, data dir resolution.
- `server/util/{log,jsonfile,net,qr}.js` — logger, atomic JSON persistence (`JsonDoc`),
  LAN address detection / localhost check, QR SVG + Wi-Fi QR payload.
- `server/library/service.js` — `LibraryService`: cache load/save (`data/library.json`), single-flight
  background `scan()`, rebuild only when the track signature changes, drive offline watcher, `absPath()`.
- `server/http/` — `router.js` (tiny router + `json`/`readBody`), `static.js` (ETag, gzip, Range),
  `media.js` (`/media/:trackId/audio|cdg|video`, zip entries), `api.js` (PLAN §8 endpoints).
- `server/ws/hub.js` — WebSocket hub (hello → `hub.onHello`, heartbeat, `hub.handle(type, fn, {roles})`
  with `rid` replies, `broadcast`). `server/room/auth.js` — HMAC tokens, localhost trust, PIN back-off.
- `server/app.js` — wires everything (tests create apps with `createApp`); `server/index.js` — CLI entry.
- `server/room/room.js` — the party (queue, rotation, player state machine, guests, displays,
  per-role views, notifications, history); `rotation.js` — pure queue-order/ETA helpers.
- `server/artwork/` — `providers.js` (Deezer, MusicBrainz/CAA, TheAudioDB, iTunes parsers + `scoreMatch`),
  `service.js` (`ArtworkService`: rate-limited priority queue, `data/art/` cache, `data/meta.json`,
  crawler, `/api/art/*` handlers), `placeholder.js` (gradient + initials SVG).
- `server/util/lru.js`; `public/js/lib/shelf.js` (gallery rows of cover cards).
- `shared/cdg.js` (CDG decoder), `shared/protocol.js` (channel modes, key/tempo ranges, emojis).
- `public/js/lib/` — `ws-client.js` (reconnecting WS + `rid` requests + clock offset), `store.js`
  (`createStore`/`useStore`), `api.js`, `ui.js` (icons, Cover, Modal, toasts, hooks),
  `audio-engine.js` (Signalsmith Stretch), `cdg-canvas.js`.
- `public/js/tv/` (TV app + `player.js` reconciler), `public/js/host/` (host app),
  `public/js/guest/` (phone app for `/j/<code>`); page shells `public/{index,host,tv,guest,print-qr}.html`.
- `scripts/make-demo-library.js` — synthetic demo library (WAV + CDG) for trying things without the drive.
- `test/` — node:test suites + helpers (`makeZip`, `writeTree`, `rawTracks`).

Planned modules and their responsibilities are specified in `docs/PLAN.md` §4.

## Conventions

- 2-space indent, semicolons, single quotes, `const` by default, small focused modules.
- Server state changes go through the `Room` actions (see PLAN §6) so every client gets a
  consistent broadcast; clients never mutate shared state directly.
- WebSocket messages are JSON `{ t: 'type', ... }`; requests carry `rid` and get
  `{ t: 'res', rid, ok, data | error }` (PLAN §7).
- Persist with `JsonDoc` (debounced atomic writes) under the data dir (`data/` by default,
  override with `--data` or `OPENKARAOKE_DATA`).
- Add/extend unit tests for any parser, catalog, queue/rotation or game-scoring change.
- UI text is English. Dark "party" theme; TV UI must be legible from across a room.

## Owner's environment (for local testing)

- Linux desktop, Node available. Karaoke library on a USB drive mounted at
  `/run/media/ruutu/SMILE-2/` (one collection folder inside, organised `Letter/Artist/Artist - Title [Brand Karaoke].{mp3,cdg}`).
- Project checkout: `~/Projects/karaoke` (this repo).
- The TV display is expected to run in Chrome/Chromium on the same PC (HDMI second screen);
  guests use phones on the same Wi-Fi.
