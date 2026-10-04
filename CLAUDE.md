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
and artwork-API facts; `docs/LIBRARY.md` describes how karaoke libraries are laid out and named.

## Hard rules

- **Zero runtime npm dependencies** (the server and the pages). Everything needed at runtime is vendored:
  `server/vendor/ws.mjs` (WebSocket server), `server/vendor/qrcode.mjs`,
  `public/js/vendor/preact.js` (Preact + hooks + htm), `public/js/vendor/signalsmith-stretch.mjs`
  (key/tempo). Rebuild them with `npm install && npm run vendor` (devDependencies only).
  Never add native modules (no better-sqlite3, sharp, etc.) — the app must run with a plain
  `node server/index.js` on any Linux box with Node ≥ 18.17. The one exception is the desktop
  app: `desktop/package.json` has Electron and electron-builder as its own dev dependencies;
  nothing outside `desktop/` may import them, and `desktop/` only wraps the same server.
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
npm start -- --library "<karaoke folder>"  # server on :6527, or the next free port (bin/openkaraoke.sh does the same + Node check)
npm run demo                               # demo library in ./demo-library (synth MP3 + CDG lyrics)
node scripts/scan-report.js "<karaoke folder>" [--search "text"]   # validate parser/catalog on a real library
bin/open-tv.sh                             # TV page in Chrome kiosk mode on the 2nd screen, sound allowed
npm run vendor                             # rebuild vendored libs after `npm install`
npm --prefix desktop install               # the desktop app's Electron + electron-builder (once)
npm --prefix desktop start                 # run the desktop app from the source
npm --prefix desktop test                  # desktop app end to end (Playwright + Xvfb); APP=<built exe> tests a build
npm --prefix desktop run dist              # AppImage, .rpm, .deb in desktop/dist/ (OPENKARAOKE_VERSION=x.y.z)
```

## Code map

Server (`server/`)
- `index.js` CLI entry (banner, signals) → `start.js` `startServer()` (data-folder lock
  `data/server.json`, the port: `--port`/`$PORT` fixed, else the saved one or the next free one,
  kept) → `app.js` `createApp()`: settings, auth, library, router (API + media + pages),
  WebSocket hub, Room. Tests start it on port 0.
- `config.js` — `DEFAULT_SETTINGS` (every setting + default), `Settings` (sanitised updates), CLI
  args, `DEFAULT_PORT` (6527; a saved 8080 is migrated).
- `library/` — `parse.js` (file names → artist/title/brand/flags/tags), `scanner.js` (CDG+audio
  pairs, video, zips; duration = CDG bytes / 7200), `zip.js`, `catalog.js` (grouping, typo
  clustering, search, browse, cache), `service.js` (cache load/save, background rescans,
  offline/online watcher, `absPath`).
- `http/` — `router.js`, `static.js` (ETag, gzip, byte ranges, `safeJoin`), `media.js`
  (`/media/:trackId/audio|cdg|video`, zip entries), `api.js` (PLAN §8), `shell.js` (writes the
  current skin into every HTML page: `<html data-theme>`, theme-color; part of the ETag).
- `room/` — `room.js` (party state machine, all WebSocket actions, role views), `rotation.js`
  (fair rotation + ETA, pure), `auth.js` (localhost trust, PIN → host token, device tokens,
  Host/Origin trust), `vocals.js` (`data/vocals.json`: what the TV found in each track's channels),
  `versions.js` (`data/versions.json`: plays and up/down votes per version, the default version).
- `ws/hub.js` — hello handshake, heartbeat, `rid` request/response, broadcasts.
- `net/` — the party hotspot (PLAN §20): `nmcli.js` (the only place programs are started:
  `nmcli`/`firewall-cmd` through `execFile`, parsers, validation, `connection add` arguments),
  `hotspot.js` (`Hotspot`: checks, start/stop, watcher, fallback). `createApp()` never calls
  nmcli unless given a runner; `start.js` passes the real one. Tests use
  `scripts/fake-nmcli.mjs` (`OPENKARAOKE_FAKE_NMCLI=<scenario>` to try the UI by hand).
- `artwork/placeholder.js` — gradient + initials SVG (real artwork comes in M5).
- `util/` — log (+ `setLogSink` for the desktop log file), useragent (device names for the host's
  Devices list), jsonfile (`JsonDoc`), net (LAN
  addresses, trusted Host/Origin, free ports), datalock, qr, lru, ratelimit, errors
  (`UserError` = message safe to show).

Shared (`shared/`, imported by server and browser): `text.js`, `cdg.js` (CD+G decoder,
Scale2x, RGBA), `protocol.js` (constants: channel modes, key/tempo ranges, reactions,
avatars, denial messages), `themes.js` (the skins' ids/names, validation of `settings.appearance`),
`vocals.js` (lead vocal on multiplex tracks: the channel matrix, what a track allows, the channel
analysis — PLAN §21), `lyrics.js` (readable lyrics: the looks' settings, colour keying, colour
roles, the readable palette, the scroll timeline — PLAN §9.5), `graphics.js` (which WebGL
renderers draw in software).

Browser (`public/`, plain ES modules, Preact + htm)
- `tv.html` + `js/tv/` — `controller.js` (follows server state, owns the media clock, reports
  `tv.ready/status/ended/error/audio`), `main.js` (lobby, intro, lyrics overlays, shortcuts),
  `lighter.js` (lighter effects by themselves: software drawing, slow frames).
- `js/lib/audio-engine.js` — Signalsmith buffer mode (key/tempo) + element mode; channel
  matrix, loudness, fades. `js/lib/lyrics-renderer.js` — the TV's lyrics (decoder memory on a
  canvas moved by a transform, dirty rectangles, looks); `js/lib/frame-clock.js` — the lyrics'
  even, never-backward clock; `js/lib/cdg-canvas.js` — the quiz's CDG renderer.
- `host.html` + `js/host/` — `main.js` (shell, routes, PIN screen, shortcuts), `state.js`,
  `player.js` (slim bar, phones' mini player), `panel.js` (the admin panel: Queue / Playback /
  Devices tabs; the phones' Control page), `queue.js`, `playback.js` (now playing + version vote,
  sound, live preview, TV window), `devices.js` (screens, host devices, guests), `menu.js`,
  `views.js`, `dialogs.js`, `settings.js`, `hotspot.js` (party hotspot block + banner),
  `vocals.js` (Lead control + Vocals dialog), `graphics.js` (Settings → About → Graphics, desktop app).
- `guest.html` + `js/guest/main.js` — join, search, song sheet, queue, reactions, alerts.
- `js/lib/` — `ws-client.js` (reconnect, `request()`, `sendReliable()`), `store.js`, `versions.js`
  (version names/labels, thumbs up/down),
  `components.js`, `icons.js`, `theme.js` (follows the skin live, `token()` for code that needs
  a colour). CSS: `css/base.css` (the two skins' tokens + components), `host.css`, `tv.css`, `guest.css`.

Desktop app (`desktop/`, Electron; see docs/HANDOFF.md "Desktop app")
- `main.mjs` — runs `startServer()` in-process, host window, TV window (full screen on another
  screen, autoplay + microphone allowed for our own pages only), menu, single instance, saving
  on quit, native Wayland (TV moved by the person, full screen on the move) or an XWayland
  restart when chosen; `okDesktop.tv` state for the host's Playback tab. `displays.mjs` (pure placement), `graphics.mjs` (display system, GPU
  verdict, lighter effects), `preload.cjs` (`window.okDesktop`: openTv, pickFolder, updates,
  graphics, onNotice — the host page checks for it), `updater.mjs` + `update-logic.mjs`
  (GitHub releases; the token only ever goes to the API, redirects are followed by hand),
  `electron-builder.config.cjs` (installers), `test/app.mjs` (end to end).
- `.github/workflows/desktop.yml` releases `v<major.minor>.<run>` for every app change on main.

Tests (`test/`): node:test suites + helpers; `test/e2e/` Playwright scripts (`lyrics.mjs`: the
TV's readable lyrics). Dev tooling: `scripts/lib/cdg-writer.js` (+ `cdg-font.js`) writes
synthetic CDGs for tests and the demo; `scripts/lyrics-check.js` (+ `lib/png.js`) checks the
readable lyrics on a real library (PNG contact sheets).

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
- The party hotspot: call `nmcli` only through `child_process.execFile` (never a shell), every
  value validated and its own argument; **never run the real nmcli in tests** — inject a runner
  (`fakeNmcli(scenario).run`). The hotspot password goes to the host and TV views only.
- Single-column CSS grids need `grid-template-columns: minmax(0, 1fr)` or long unwrapped
  text widens the page on phones.
- UI text is English. Two dark skins (`settings.appearance.theme`): **Studio** (default, midnight
  navy + one teal accent, champagne gold for people and moments) and **Party** (neon pink/purple).
  Every skin-specific colour, gradient, glow, font, radius or type treatment is a token defined
  per skin at the top of `css/base.css` (`--neon` is the accent) — never hard-code one in CSS or
  JS (`test/themes.test.js` fails on a colour with a hue outside the skin blocks); canvas/SVG
  code reads tokens, and a singer's colour is drawn through `singerColor()`
  (`shared/protocol.js`, → `--singer-N`). A new token gets Party's current value so Party renders as
  before; the few Studio-only rules are scoped `:root:not([data-theme="party"])`. Party must keep
  looking exactly as it did (test/themes.test.js pins its values). TV UI must be legible from
  across a room.

## Owner's environment (for local testing)

- Linux desktop, Node available. Karaoke library on a USB drive mounted at
  `/run/media/<user>/<drive>/` (one collection folder inside, organised `Letter/Artist/Artist - Title [Brand Karaoke].{mp3,cdg}`).
- Project checkout: a local clone of this repo.
- The TV display is expected to run in Chrome/Chromium on the same PC (HDMI second screen);
  guests use phones on the same Wi-Fi.
