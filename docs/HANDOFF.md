# Handoff — where the project stands and what to do next

_Last updated: 2026-09-30 (second build session: M1–M4 done, M5 artwork mostly done, M6 started)._

## TL;DR
- **M0 foundation, M1 server, M2 TV player, M3 room + host app and M4 guest app are done** —
  this is the first party-ready version: host on the PC, lyrics + audio on the TV, guests
  request songs from their phones via the QR code.
- `npm test` → 95 tests green. `npm run e2e` (Playwright) → full browser flow green.
- **Not yet run against the real USB library** (the session-2 agent worked in a cloud container
  without the drive). Everything was verified with a synthetic 90k-track tree (performance) and
  a synthetic demo library of real WAV+CDG songs (`npm run demo -- <dir>`). Do the checklist
  below on the PC first.
- **Home screens have gallery rows** (horizontal cover-art carousels: Popular, Sung tonight,
  Favourites, Random picks, top collections; guests get Popular / Try something new / a collection).
- **M5 artwork & metadata is implemented but only tested against recorded-shape fixtures** — this
  cloud container can't reach Deezer/MusicBrainz/TheAudioDB. Check it on the PC (see checklist).
- **M6 games started**: crowd poll ("what's next?") and roulette wheel (songs / singers / dares)
  work across host, TV and phones. Battle and music quiz are next.
- Next: finish M5 on the PC (real API check, "fix artwork" screen), M6 battle + quiz, M7 polish.

## First run on the PC (owner checklist)
```bash
cd ~/Projects/karaoke && git pull
node scripts/scan-report.js "/run/media/ruutu/SMILE-2/<collection folder>" --search "someone like you"
npm start -- --library "/run/media/ruutu/SMILE-2/<collection folder>"
# host:  http://localhost:8080/host        TV:  bin/open-tv.sh   (or http://localhost:8080/tv + click Start)
```
Then check: covers appear within a few seconds for songs you open/queue (Settings → Artwork shows
the background lookup progress; if the matches look wrong, note examples for the matching rules in
`server/artwork/providers.js`), a real MP3+CDG plays with lyrics in sync (adjust **Settings → Playback → Lyrics
offset** if words are early/late on the TV), key/tempo changes sound fine, a phone can join via
the QR code (same Wi-Fi; if the join URL shows the wrong address set **Settings → Network →
Address for guests**), unplugging the USB drive shows "library offline" and replugging recovers.

## What was verified
| Check | Result |
| --- | --- |
| `npm test` (node:test) | 95 pass: parser, catalog, scanner/zip, settings/QR/net, library service, HTTP router/Range/media/zip/API, WebSocket, auth + PIN back-off, CDG decoder (synthetic streams), rotation/ETA, Room over real WebSockets (guest join, rotation, player flow, limits, approvals, TV reload, bans, settings, PIN login), cross-site/DNS-rebinding protection |
| `npm run e2e` (headless Chromium) | TV autoplay start, typo search, add-to-queue, intro → lyrics, audio clock advances, key change reaches the TV, 2 phone guests join + request, fair rotation order, reactions on the TV, "your turn" notification |
| Manual browser runs (screenshots reviewed) | lyrics with word highlighting, tempo 1.2 (2.42 s per 2 s), pause/seek, vocal cut, mirror display in sync with the main TV, click-to-start gate without the autoplay flag, all host views/dialogs, phone layouts, printable QR card |
| Parser on all 90,479 names from the owner's song list (session 1) | 99% get a label; ~50.5k songs, ~11.8k artists |
| Server on a synthetic 90k-track tree (11.6k folders) | first scan 4.1 s + build 4.1 s; restart: cache load 3.0 s + no-change rescan 1.3 s; `/api/search` 12–35 ms over HTTP; RSS ≈ 475 MB; `library.json` 33 MB |

## How it fits together (details in `docs/PLAN.md`)
- `server/app.js` wires settings → auth → library → HTTP (API, media, static) → WebSocket hub →
  Room. `server/index.js` is the CLI (`--library` replaces the saved folders; `--port`/`--host`
  are not saved; `--pin` is).
- The **Room** (`server/room/room.js`) is authoritative for party state and broadcasts per-role
  views (`host`, `tv`, `guest` + per-device `me`). The **main TV** is authoritative for media
  time: `public/js/tv/player.js` reconciles the desired player state (load/decode, play/pause,
  `seekSeq` seeks, key/tempo/channel/volume) and reports `tv.status` 4×/s, `tv.ended`, `tv.error`.
- Audio: `public/js/lib/audio-engine.js` — Signalsmith Stretch in buffer mode for CDG tracks,
  element mode (`<video>`) for video; 2×2 channel matrix; loudness gain; our own time map.
- Security: the PC is trusted as host only for direct requests (IP/localhost/host-name `Host`
  header, same `Origin`); other devices need the PIN (Bearer token); cross-site WebSocket
  upgrades and cross-site POSTs are refused; JSON bodies must be `application/json`.

## Decisions already made (and why)
1. **Node server + browser clients, all local.** Owner wants it to run on Linux, offline-capable.
2. **No database, no native modules.** 90k tracks fit in memory (catalog) with a JSON cache.
3. **Vendored runtime libs** (`ws`, `qrcode-generator`, Preact + htm, **Signalsmith Stretch**).
4. **No front-end build step**: Preact + `htm` tagged templates as plain ES modules.
5. **The TV page is the player**; server authoritative for party state, main TV for media time.
6. **Second screen** via the Window Management API + `bin/open-tv.sh` kiosk launcher.
7. **Auth**: PC trusted (localhost), other devices PIN; remote TVs pair with a 4-digit code.
8. **Artwork**: Deezer primary, MusicBrainz/CAA fallback, TheAudioDB for artists; iTunes off.
9. **Battle scoring = audience voting (+ optional applause meter)** — no pitch data in CDG.
10. **Rotation**: round-robin by lead singer, newcomers first, the singer who was already told
    "you're up next" is never bumped. A skipped song counts as sung only after 45 s.
11. **A TV reload during a song** pauses the party; the same display coming back within 15 s
    resumes automatically (and a display that reconnects while its old socket still looks alive
    simply takes over). If the server restarts mid-song, that song goes back to the top of the queue.
12. **"You're up next"** is sent in the last 75 s of the song on stage; that singer is then
    protected from being bumped by newcomers. Changing the host PIN signs out remote hosts.

## Next steps (in order)

### M5 — Artwork & metadata 🟡 (built in session 2, not yet run against the real APIs)
Done:
- `server/artwork/providers.js` — Deezer (strict search → loose fallback, album → genre/year,
  artist pictures), MusicBrainz recording search → Cover Art Archive (studio album preferred over
  compilations), TheAudioDB artist thumb/fanart/logo/cutout, optional iTunes (linked, not cached).
  `scoreMatch()` = artist/title similarity (≥ 0.75/0.7), penalises karaoke/tribute/cover albums,
  duration within 15 s bonus; `best()` picks the top candidate ≥ 0.6.
- `server/artwork/service.js` — priority queue (0 stage/next, 1 on screen, 2 crawl), per-provider
  token buckets (Deezer 8/s, MusicBrainz 1/s, TheAudioDB 0.45/s, iTunes 0.3/s), quota/429 back-off
  and retry, 5-min pause when providers are unreachable or fail 5× in a row, images in `data/art/`
  (sha1 names, type sniffed, 8 MB max, LRU eviction at `maxCacheMB`), metadata in `data/meta.json`,
  misses retried after 30 days, background crawl (popular first, `artwork.crawl`, `--no-crawl`).
- `/api/art/song/:id?s=` and `/api/art/artist/:key?type=picture|fanart|logo&song=` serve cached
  images or placeholders (`no-store` while a lookup is pending); `{ t: 'art', ids }` WS events make
  clients re-request covers (`artVersions` in `public/js/lib/ui.js`); the catalog gets genre/year/
  explicit/rank via `catalog.metaFor`; genre/decade browse in host (Collections) and guest chips;
  TV stage background uses artist fanart when `artwork.background` is on; Settings → Artwork shows
  progress with start/pause/retry.
To do:
- Run against the real APIs on the PC; tune `scoreMatch` thresholds with real misses.
- "Fix artwork" screen (choose among candidates / upload a custom image), Fanart.tv provider.
- TV lobby cover mosaic from popular songs with art.

### M6 — Games 🟡 (poll + wheel done in session 2)
Framework: `server/games/index.js` (`Games` on the Room: one game at a time, `game.start` /
`game.action` / `game.end` for hosts, `game.vote` for guests and hosts; `game` field in the tv/host
views, `guestView()` per device hides spoilers; a `{ t: 'game', event: 'start' }` message makes
phones jump to Home). Games are small classes with `view()`, `action(name)`, `dispose()`.
- `poll.js` — 2–6 random songs (collection filter, explicit/max-length rules), timed vote, change
  vote allowed, random tie-break, host queues the winner as the next song (`source: 'game:poll'`).
- `wheel.js` — songs / singers (online + phone-less) / dares; the server picks result + turns +
  offset, the TV (`public/js/tv/games.js`) animates an SVG wheel that lands on it; remove segment,
  queue the song.
- UIs: host `#/games` (`public/js/host/games.js`), TV scene overlay, guest vote card (Kahoot colours).
Next: **Battle** (2–8 contestants, phone voting A/B or 1–10, optional applause meter on the PC,
bracket), then **Music Quiz** (`pickLyricsFrame` in `shared/cdg.js` is ready; the TV needs a
"quiz clip" playback mode: play N seconds of a track without the CDG, or show a static CDG frame).

### M7 — Polish
Break music / autoplay when the queue is empty (`playback.whenQueueEmpty`, `breakMusic.*` are in
the settings but marked "coming soon"), guest photos, ratings + party recap, printable songbook,
systemd `--user` unit (`bin/install-service.sh`), README screenshots, CSP header, performance
pass (move `catalog.load` to a worker thread so big rescans don't block the event loop).

## Known limitations / TODOs
- Real-drive validation still pending (see checklist). Only WAV+CDG (demo), zipped WAV+CDG and
  unit-test fixtures have been played; MP3 decoding is done by Chromium (`decodeAudioData`).
- **Video karaoke** (MP4/WEBM) is implemented (element mode, key via a live stretch node, tempo
  via `playbackRate`) but untested — the owner's library has no videos. MKV/AVI may not play.
- Lyrics sync uses `outputLatency + baseLatency`; HDMI/Bluetooth sinks may need
  `playback.lyricOffsetMs`. Mirrors follow 4 Hz `time` messages (no drift correction).
- The decoded song lives in the AudioWorklet (~100 MB per 5 min); the next song is decoded only
  during the last 45 s of the current one (or during the intro countdown).
- Guests on the party PC itself count as "host" for HTTP API filters (explicit filter); the
  server still applies guest rules to their queue requests.
- Guests can't pick a duet partner yet (host can add several singers to an entry via Edit).
- Queue drag & drop is mouse-only; touch devices use the up/next/remove buttons.
- `catalog.js`: heap ~200–400 MB while building 90k tracks; the "Duets" tag also includes plain
  "A & B" credits; artist clustering thresholds are conservative; `(VR)` meaning unknown.
- `scanner.js` follows symlinks without loop detection.
- `catalog.load` is synchronous (≈3–4 s for 90k tracks) — rescans that find changes block the
  event loop for that long (playback on the TV is unaffected; host/guest UIs pause briefly).

## Starter prompt for your Claude Code agent
> Read `CLAUDE.md`, `docs/HANDOFF.md` and `docs/PLAN.md`. Continue with the next unfinished
> milestone (M5 artwork & metadata) as described in HANDOFF "Next steps", following the hard
> rules in CLAUDE.md (no runtime npm deps, ESM, no build step). If the library at
> `/run/media/ruutu/SMILE-2/` is available, run the HANDOFF "First run" checklist first. Keep
> `npm test` (and `npm run e2e` if Playwright is installed) green, update HANDOFF.md, and commit +
> push after each working piece.
