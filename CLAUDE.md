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
npm test                                   # unit + integration tests (node:test), must stay green
npm run e2e                                # browser end-to-end (Playwright + Chromium; not in npm test)
npm start -- --library "<karaoke folder>"  # server on :8080 (bin/openkaraoke.sh does the same + Node check)
npm run demo                               # demo library in ./demo-library (synth MP3 + CDG lyrics)
node scripts/scan-report.js "<karaoke folder>" [--search "text"]   # validate parser/catalog on a real library
bin/open-tv.sh                             # TV page in Chrome kiosk mode on the 2nd screen, sound allowed
npm run vendor                             # rebuild vendored libs after `npm install`
```

## Code map

Server (`server/`)
- `index.js` CLI entry (banner, signals) → `app.js` `createApp()`: settings, auth, library,
  router (API + media + pages), WebSocket hub, Room. Tests start it on port 0.
- `config.js` — `DEFAULT_SETTINGS` (every setting + default), `Settings` (sanitised updates), CLI args.
- `library/` — `parse.js` (file names → artist/title/brand/flags/tags), `scanner.js` (CDG+audio
  pairs, video, zips; duration = CDG bytes / 7200), `zip.js`, `catalog.js` (grouping, typo
  clustering, search, browse, cache), `service.js` (cache load/save, background rescans,
  offline/online watcher, `absPath`).
- `http/` — `router.js`, `static.js` (ETag, gzip, byte ranges, `safeJoin`), `media.js`
  (`/media/:trackId/audio|cdg|video`, zip entries), `api.js` (PLAN §8), `shell.js` (writes the
  current skin into every HTML page: `<html data-theme>`, theme-color; part of the ETag).
- `room/` — `room.js` (party state machine, all WebSocket actions, role views), `rotation.js`
  (fair rotation + ETA, pure), `auth.js` (localhost trust, PIN → host token, device tokens,
  Host/Origin trust).
- `ws/hub.js` — hello handshake, heartbeat, `rid` request/response, broadcasts.
- `artwork/placeholder.js` — gradient + initials SVG (real artwork comes in M5).
- `util/` — log, jsonfile (`JsonDoc`), net (LAN addresses, trusted Host/Origin), qr, lru,
  ratelimit, errors (`UserError` = message safe to show).

Shared (`shared/`, imported by server and browser): `text.js`, `cdg.js` (CD+G decoder,
Scale2x, RGBA), `protocol.js` (constants: channel modes, key/tempo ranges, reactions,
avatars, denial messages), `themes.js` (the skins' ids/names, validation of `settings.appearance`).

Browser (`public/`, plain ES modules, Preact + htm)
- `tv.html` + `js/tv/` — `controller.js` (follows server state, owns the media clock, reports
  `tv.ready/status/ended/error/audio`), `main.js` (lobby, intro, lyrics overlays, shortcuts).
- `js/lib/audio-engine.js` — Signalsmith buffer mode (key/tempo) + element mode; channel
  matrix, loudness, fades. `js/lib/cdg-canvas.js` — CDG renderer.
- `host.html` + `js/host/` — `main.js` (shell, routes, PIN screen, shortcuts), `state.js`,
  `player.js`, `queue.js`, `views.js`, `dialogs.js`, `settings.js`.
- `guest.html` + `js/guest/main.js` — join, search, song sheet, queue, reactions, alerts.
- `js/lib/` — `ws-client.js` (reconnect, `request()`, `sendReliable()`), `store.js`,
  `components.js`, `icons.js`, `theme.js` (follows the skin live, `token()` for code that needs
  a colour). CSS: `css/base.css` (the two skins' tokens + components), `host.css`, `tv.css`, `guest.css`.

Tests (`test/`): node:test suites + helpers; `test/e2e/` Playwright scripts. Dev tooling:
`scripts/lib/cdg-writer.js` (+ `cdg-font.js`) writes synthetic CDGs for tests and the demo.

Planned modules and their responsibilities are specified in `docs/PLAN.md` §4.

## Conventions

- 2-space indent, semicolons, single quotes, `const` by default, small focused modules.
- Server state changes go through the `Room` actions (see PLAN §6) so every client gets a
  consistent broadcast; clients never mutate shared state directly.
- WebSocket messages are JSON `{ t: 'type', ... }`; requests carry `rid` and get
  `{ t: 'res', rid, ok, data | error }` (PLAN §7).
- Persist with `JsonDoc` (debounced atomic writes) under the data dir (`data/` by default,
  override with `--data` or `OPENKARAOKE_DATA`).
- Add/extend unit tests for any parser, catalog, queue/rotation or game-scoring change, and
  keep `npm run e2e` passing for UI changes (check phones: no sideways scrolling).
- Treat guests as untrusted: validate every field, rate-limit, never trust ids from the client
  (use `client.data.deviceId` from the signed token), use `Object.hasOwn` for lookups keyed by
  client strings. New POST endpoints use `readJsonBody` (requires `application/json`).
- Single-column CSS grids need `grid-template-columns: minmax(0, 1fr)` or long unwrapped
  text widens the page on phones.
- UI text is English. Two dark skins (`settings.appearance.theme`): **Studio** (default, calm
  graphite + one accent) and **Party** (neon pink/purple). Every skin-specific colour, gradient,
  glow, font or radius is a token defined per skin at the top of `css/base.css` (`--neon` is the
  accent) — never hard-code one in CSS or JS; canvas/SVG code reads tokens. Party must keep
  looking exactly as it did (test/themes.test.js pins its values). TV UI must be legible from
  across a room.

## Owner's environment (for local testing)

- Linux desktop, Node available. Karaoke library on a USB drive mounted at
  `/run/media/ruutu/SMILE-2/` (one collection folder inside, organised `Letter/Artist/Artist - Title [Brand Karaoke].{mp3,cdg}`).
- Project checkout: `~/Projects/karaoke` (this repo).
- The TV display is expected to run in Chrome/Chromium on the same PC (HDMI second screen);
  guests use phones on the same Wi-Fi.
