# Handoff — where the project stands and what to do next

_Last updated: 2026-09-30 (end of the second build session). Everything is pushed to GitHub
`main`; the next session can run in the cloud (see the starter prompt at the end)._

## TL;DR
- **M0–M4 are done: the first party-ready version works** — server, TV display, host app and
  guest app. `npm test` → 101/101; `npm run e2e` (Playwright + Chromium) → 17/17 and 26/26.
- Start: `npm start -- --library "/run/media/ruutu/SMILE-2/<collection folder>"` (or
  `bin/openkaraoke.sh …`), open `http://localhost:8080/host` on the PC and `/tv` on the TV
  (`bin/open-tv.sh` opens it full screen on the second monitor with sound allowed).
- No drive at hand? `npm run demo` builds a small demo library (synthesised MP3 + CDG lyrics).
- Next: **M5 artwork & metadata**, then M6 games, M7 polish (PLAN §18). Before that, try a
  real party on the PC with the real drive (checklist below).

## What was verified (session 2)
| Check | Result |
| --- | --- |
| Unit + integration tests (`npm test`) | 101 pass: parser, catalog, scanner/zip (incl. corrupt/ZIP64), library service, router/range/auth, HTTP + WebSocket integration, CDG decoder (synthetic CDGs), rotation, room state machine, security regressions |
| `test/e2e/party.mjs` (TV in Chromium, host over WebSocket) | 17/17: lobby → auto-start intro → lyrics drawn → key/tempo → pause → dropped TV connection + resume → song ends → next singer → lobby; TV without autoplay asks for a click and the host is told |
| `test/e2e/apps.mjs` (host UI desktop, 2 guests on phones, TV) | 26/26: host queues for a phoneless singer, guests join/search/request (key choice), repeat refused, fair rotation order, approval mode via settings, auto-start, up-next banner + "It's your turn!", player bar controls, announcement, reaction on TV, guest removes own song, host removes a guest, no sideways scroll on phones, no console errors |
| Signalsmith timing | measured in an OfflineAudioContext: input time x is emitted at `output + (x − input)/rate` (see audio-engine.js header) |
| Independent code review | 15 findings (1 critical crash, several security/state-machine issues) — all fixed with regression tests, see commit "Fix issues found in an independent code review" |
| Scale | synthetic catalog: search 4–12 ms per request, server RSS ≈110 MB; reviewer measured ≈17 ms search at 90k tracks |

**Not verified yet (needs the owner's PC):** a full scan of the real USB drive, real CDG files
from the drive in the TV, real speakers/Bluetooth latency (`playback.lyricOffsetMs`), video
karaoke files (none on the drive), second-screen placement via `bin/open-tv.sh` / the Window
Management API on the owner's desktop (GNOME/KDE, X11/Wayland), phones on the real Wi-Fi.

**Real CDGs are the biggest open risk.** Every CDG the tests and the demo use comes from our own
writer (`scripts/lib/cdg-writer.js`), so if the writer and the decoder share a misreading of the
spec (colour-table packing, XOR tiles, scrolling), only real files will show it. Session 2 could
not read the drive, so play 2–3 songs from different brands (e.g. Sound Choice, Zoom, Sunfly)
early on the PC and check colours, highlight wipes and page changes.

## First real party — checklist for the owner
0. Get the new code: `cd ~/Projects/karaoke && git pull`.
1. `node scripts/scan-report.js "/run/media/ruutu/SMILE-2/<collection folder>"` (sanity check).
2. `bin/openkaraoke.sh --library "/run/media/ruutu/SMILE-2/<collection folder>"`; the first
   scan runs in the background (minutes on a USB HDD), later starts reuse `data/library.json`.
3. Open `http://localhost:8080/host`, then **Open TV display** (or run `bin/open-tv.sh`).
   A TV page opened by hand needs one click to allow sound — the host player bar says so.
4. Scan the QR code with a phone on the same Wi-Fi. If phones can't connect, check the
   firewall (on Fedora: `sudo firewall-cmd --add-port=8080/tcp`, add `--permanent` to keep it) and the join address shown
   in the invite dialog (Settings → Party has the room code; `server.publicUrl` overrides it).
5. If lyrics run late with Bluetooth speakers, raise Settings → Playback → Lyrics timing.

## How it fits together (new in session 2)
- `server/app.js` builds everything (`createApp`), `server/index.js` is the CLI.
- `server/room/room.js` is the party state machine; every client action is a WebSocket
  request handled there; views are role-specific and coalesced (≤ every 40 ms).
  Player states: `idle → intro → (ready) → playing ⇄ paused`. The server decides what plays;
  the main TV owns the media clock (`tv.ready / tv.status / tv.ended / tv.error / tv.audio`).
- `public/js/tv/controller.js` + `public/js/lib/audio-engine.js`: decode MP3 → Signalsmith
  (buffer mode) for key/tempo; `<audio>`/`<video>` element mode for video or undecodable audio.
- `public/js/lib/cdg-canvas.js` + `shared/cdg.js`: CDG → Scale2x → RGBA with a transparent
  background over blurred art (placeholder art until M5).
- Host UI `public/js/host/*`, guest UI `public/js/guest/main.js`, shared components in
  `public/js/lib/{components,store,icons,ws-client}.js`. Styles: `public/css/{base,host,tv,guest}.css`.

## Decisions made in session 2 (and why)
1. **Auto-start**: the first song queued while nothing plays starts after the countdown when a
   TV is connected (`playback.autoStart`, default on) — "the first song starts the party".
   Never after the host pressed Stop (until Play), never when the queue already had songs.
2. **Guest identity = signed device token** (`guest.<id>.<hmac>` in localStorage), issued
   on the first hello; new identities are rate-limited per IP.
3. **Security model**: host = localhost (trusted Host name + same-site Origin) or PIN token;
   WebSocket upgrades/POSTs from other sites are refused (CSRF, DNS rebinding). If the owner
   reaches the app through a custom host name, set it as `server.publicUrl`.
4. **"Stop" returns the song to the top of the queue** (not logged as sung); "Next" logs it
   as skipped; songs count as sung when finished or ≥60 % / ≥30 s played.
5. **Mirrors**: extra `/tv` screens are muted mirrors driven by the main TV's clock
   (CDG only; basic — pairing of remote TVs is M7).
6. **Artists are filed under the word after "The"** in A–Z (catalog letter change).
7. **Fonts are vendored** (Bricolage Grotesque + Figtree, OFL, `public/fonts/`) — no network.
8. Demo/test CDGs come from `scripts/lib/cdg-writer.js` + a bitmap font generated once from
   DejaVu Sans Condensed Bold (dev tooling only, not used at runtime).

## Next steps (in order)

### M5 — artwork & metadata (start here)
- `server/artwork/service.js` + `providers.js` per PLAN §12 (Deezer first, MusicBrainz/CAA
  fallback, TheAudioDB for artist fanart), cache in `data/art/` + `data/meta.json`, on-demand
  priority for current/next/visible songs, background crawler (popular first), `art` events.
- Hook points already exist: `app.artwork.serveSong(ctx, song)` / `serveArtist(ctx, artist)`
  in `server/http/api.js` (return true when served), `catalog.metaFor` + `metaChanged()`.
- UI: covers already load from `/api/art/song/:id` everywhere (placeholder SVG today);
  add genre/decade facets (host Collections, guest chips) once metadata exists.
- **Verify the Deezer field names with one live request first** (RESEARCH §3). In a cloud
  sandbox the shell can't reach these APIs: read one sample response per provider with
  WebFetch, and test the providers against saved JSON fixtures instead of the network.

### M6 — games (PLAN §13), M7 — polish (PLAN §18)
M7 includes: break music between singers, guest photos, remote display pairing, printable
songbook, systemd user service, host live preview, duet UI (the server already accepts
`partners` from the host), playlists, performance ratings.

## Known limitations / TODOs
- Catalog rebuild after a rescan with changes blocks the server ≈3–4 s at 90k tracks (the
  TV keeps playing; host/guest UIs pause). Could move to a worker thread.
- Guest search runs ≈17 ms CPU per request at 90k tracks; fine for a party, but a
  per-client debounce/limit on `/api/search` would help with very many phones.
- Video karaoke (MP4/WEBM) is implemented through element mode but untested with real files;
  tempo uses `playbackRate`, key change routes through the stretcher (adds ~0.1 s latency).
- Remote (non-local) TV displays are refused until pairing exists (M7).
- The host's "Preview on headphones" from PLAN §10 is not implemented.
- `catalog.js` heap ~200–400 MB while building 90k tracks (unchanged from session 1).
- Rotation edge case: after Stop re-queues a song of someone who already sang, a newcomer
  can be placed before an earlier newcomer (manual reordering fixes it).
- `(VR)` annotation meaning still unknown — kept as a version label.

## Starter prompt for the next session (cloud)
> Read `CLAUDE.md`, `docs/HANDOFF.md` and `docs/PLAN.md` §12. You are in a cloud sandbox with no
> access to my PC or my karaoke drive. Implement milestone **M5 (artwork & metadata)** as
> described in HANDOFF "Next steps", following the hard rules in CLAUDE.md (no runtime npm deps,
> ESM, no build step). Confirm each provider's field names with WebFetch and test the providers
> against saved JSON fixtures. Keep `npm test` and `npm run e2e` green with new tests (if the
> e2e script can't find Playwright: `npm i --no-save playwright-core`), update HANDOFF.md, and commit + push to `main`
> after each working piece. Then continue with M6 (games) and M7 (polish). Anything that needs my
> PC (real drive, real CDGs, speakers, TV, phones) goes in the owner checklist instead.
