# OpenKaraoke — product spec, architecture and roadmap

Status legend: ✅ done · 🟡 partly done · ⬜ not started. Section numbers are referenced from
`CLAUDE.md` and `docs/HANDOFF.md`.

---

## 1. Goals

Build a **web-based karaoke app as fully featured as KaraFun Web**, but for the owner's own
local library, running entirely on their **Linux PC** (no cloud):

1. Play a **~90,000-track CDG+MP3 library** from a USB drive (also: zipped MP3+G, MP4/WEBM video).
2. **Second screen**: TV/projector window for lyrics & visuals, host controls on the laptop.
3. **QR-code lobby**: guests scan a QR code on the TV, pick a name, search the catalogue and
   request songs from their phones — no app install.
4. **Cover art & graphics** matched automatically from online music databases (Deezer,
   MusicBrainz/Cover Art Archive, TheAudioDB, optional iTunes/Fanart.tv) and cached locally.
5. **Party games**: singing Battle, Music Quiz, roulette wheel, polls, pass-the-mic, applause
   meter, audience ratings, party recap.
6. Everything KaraFun-like: key change, tempo, singer rotation, approvals, limits, favourites,
   playlists, history, explicit filter, background music between singers, ticker, themes.

Non-goals (for now): internet hosting, accounts, streaming catalogues, pitch-graded scoring
(needs melody data that CDG files don't have — see §13.8), native mobile apps.

## 2. Feature list

P0 = needed for a first real party, P1 = next, P2 = later. Each line is an acceptance criterion.

### Library & search
- ✅ P0 Scan folders recursively; pair `.cdg` with `.mp3/.m4a/.ogg/.opus/.aac/.flac/.wav`; video files; zipped MP3+G.
- ✅ P0 Parse `Artist - Title [Brand Karaoke]` names incl. typos/truncations; flags & tags (PLAN §5.1).
- ✅ P0 Group label versions into one song; cluster artist typos; artist pages incl. collaborations.
- ✅ P0 Typo-tolerant instant search (<30 ms on 90k tracks); popular list; tags; random.
- ✅ P0 Library service: on-disk cache (`data/library.json`), background rescan with progress,
  drive offline/online detection (poll every 20 s), rescan button, "library offline" banner.
- ✅ P0 Folder picker in host settings (server lists directories; suggest mounted drives under
  `/run/media/$USER`, `/media/$USER`) + CLI `--library`.
- ✅ P1 Genre / decade browse (host Collections + genre/decade pages, guest chips; metadata from §12), "Most sung here", live "In queue" / "Sung tonight" marks.
- ✅ P1 Printable songbook (HTML → print to PDF, or CSV) with filters (letter, tag, genre, decade, popular only) — Settings → Library.
- ⬜ P2 Optional ffmpeg transcoding for AVI/WMV/MPG video when `ffmpeg` is installed.

### Playback (TV display)
- ✅ P0 CDG renderer (canvas, all instructions, scroll, transparency) synced to audio (§9.2).
- ✅ P0 Audio engine on Web Audio + Signalsmith Stretch: **key change ±6 semitones**,
  **tempo 70–130 %**, seek, pause, fade in/out, volume, loudness normalisation (§9.3).
- ✅ P0 Channel modes for multiplex/guide-vocal tracks: stereo, left, right, mono, vocal-cut (L−R).
- ✅ P0 "Next singer" intro card with countdown, then auto-start (or start-paused mode).
- ✅ P0 Preload next track during the intro; break music fades out when the next song starts.
- 🟡 P0 Video karaoke (MP4/WEBM) with the same controls (tempo via playbackRate, key via stretch live input) — implemented, untested with real video files.
- ✅ P1 Background behind transparent CDG: blurred cover / artist fanart (Ken-Burns), idle cover mosaic, audio
  visualiser, guest photos, or plain colour. CDG smoothing (Scale2x) for crisp text on big TVs.
- ✅ P1 Lyric sync offset setting (ms) and automatic output-latency compensation (getOutputTimestamp).
- ⬜ P2 Mic monitoring with reverb/echo on the PC (localhost only, latency warning).

### Second screen & displays
- ✅ P0 `/tv` page = the player (one **main** display plays audio). Click-to-start overlay
  (autoplay policy) + fullscreen. Keyboard shortcuts for single-screen use.
- ✅ P0 Host button "Open TV display": `window.getScreenDetails()` (Window Management API) to place
  a popup on the non-primary screen, then fullscreen. Fallback: normal popup + instructions.
- ✅ P0 `bin/open-tv.sh`: launches Chromium/Chrome in kiosk mode on the 2nd screen with
  `--autoplay-policy=no-user-gesture-required` (no click needed).
- ✅ P1 Mirror displays (extra TVs/projectors, muted, clock-synced); host live preview (mini mirror in the player bar).
- ✅ P1 Remote display pairing: a non-local `/tv` shows a pairing code; host approves it (Settings → Displays can forget them all).
- 🟡 P2 "Queue board" layout (`/tv?layout=board`) ✅; singer "confidence monitor" layout ⬜.

### Queue, singers, rotation
- ✅ P0 Queue with drag-reorder, play next, remove, edit singer/key/tempo, clear, shuffle.
- ✅ P0 Singers (name, emoji, colour), linked to guest devices; host can add singers without phones.
- ✅ P0 Fair **rotation** (round-robin by singer, newcomers first) or FIFO mode (§6.3).
- ✅ P0 ETA per queue entry; "You're up next!" notification on the singer's phone.
- ✅ P0 Request approval mode; per-guest limit; max song length; no repeats tonight; explicit filter.
- 🟡 P1 Duets ✅ (host picks a partner; a guest invites a partner, who accepts on their phone), teams/tables ⬜, "mystery song" entries ✅.
- ✅ P1 Per-song remembered key/tempo (per singer when known).
- ✅ P1 Favourites (host + per guest), playlists (host), history (tonight in the UI, all time in `history.jsonl`), re-queue.

### Guests (phones)
- ✅ P0 QR join → name + emoji → search, browse (popular, artists A–Z, tags), song sheet with
  versions (labels), optional key, "Sing it" → confirmation with position & ETA.
- ✅ P0 Queue view (own entries highlighted, remove own), now-playing, reactions (floating emojis on TV).
- ✅ P1 Photo upload (client-side resize, host moderation) → TV photo flash / slideshow background.
- ✅ P1 Co-host promotion (host grants playback/queue controls to a guest).
- ✅ P1 Rate the performance (1–5 ★) after each song → average in history and singer stars.
- ✅ P1 Wi-Fi QR code on the TV lobby (SSID/password from settings).

### Host app
- ✅ P0 KaraFun-style layout: sidebar nav, top search, main content, right queue panel, bottom
  player bar (transport, seek, key ±, tempo ±, channel mode, volume, TV status).
- ✅ P0 Views: Home, Search, Artists (A–Z), Tags/Collections, Popular, Song details (versions,
  preview on host headphones), Singers, Requests (approvals), History, Settings.
- ✅ P0 Settings UI for every implemented key in `DEFAULT_SETTINGS` (keys of unbuilt features are hidden).
- ✅ P0 Invite panel: big QR, join URL, room code, printable QR table card (print pop-up).
- ✅ P1 Announcements (big overlay text on TV), ticker message, "new party" (reset tonight's stats).
- ✅ P1 Keyboard shortcuts (space, arrows, +/- key, [ ] tempo, N next, F fullscreen TV).

### Artwork & metadata
- ✅ P0 On-demand cover art per song (Deezer → MusicBrainz/Cover Art Archive → iTunes), cached to
  `data/art/`, placeholder SVG (gradient + initials) while missing; live refresh via `art` events.
- ✅ P1 Background crawler for the whole library (popular first), resumable, rate-limited,
  progress + ETA in settings. Artist pictures, genre, year, explicit flag, popularity rank.
- ✅ P1 TheAudioDB (key `123`) artist fanart/logo/cutout for TV backgrounds, intro card and artist pages.
- ✅ P2 "Fix artwork" (choose among candidates, "no cover", look up again, upload your own picture),
  optional iTunes & Fanart.tv.
- ⬜ Live verification against the real APIs (the cloud session could not reach them): run
  `node scripts/artwork-check.js` on the PC.

### Games (§13)
- ✅ P1 Music Quiz (phones answer, speed scoring, leaderboard, rounds: intro, name the artist,
  lyrics peek, cover zoom, helium/slow-mo/reverse audio, year/decade, sing-along interlude).
- ✅ P1 Battle (2–8 contestants, head-to-head or knockout, phone voting + optional applause meter + judges).
- ✅ P1 Roulette wheel (songs / singers / dares / genres / duet roulette).
- ✅ P1 Crowd poll "what's next?", Pass-the-mic relay, applause meter (TV microphone), party recap screen.

### Between songs
- ✅ P1 Break music (random instrumentals from the library matching the next song's genre/decade,
  or a music folder) with fades; "when queue is empty": lobby / break music / autoplay sing-along.

## 3. Architecture

```
            USB drive (CDG+MP3)                         Internet (optional)
                   │ fs                                        │ https (artwork, metadata)
┌──────────────────▼───────────────────────────────────────────▼──────────────┐
│ Node server (server/index.js)                                                │
│  Library service ─ scanner, catalog, cache        Artwork service ─ providers│
│  HTTP: static files, JSON API, media streaming (Range), art, QR SVG          │
│  WebSocket hub (/ws) ── Room (party state machine) ── Games                  │
│  Persistence: data/*.json (JsonDoc)                                          │
└───────▲───────────────────────▲──────────────────────────▲──────────────────┘
        │ ws + http              │ ws + http                 │ ws + http
   /host (laptop)          /tv (TV, main display)       /j/CODE (guest phones)
   controls, library       plays audio, renders CDG,    search, request, react,
   settings, games         overlays, game screens       vote/answer in games
```

- The **server is authoritative** for party state (queue, singers, current entry, desired
  play/pause, games). The **main TV display is authoritative for media time**: it decodes and
  plays audio locally and reports position ~4×/s.
- Media is served over HTTP; the TV fetches the MP3 and CDG for the current and next entry.
- One party ("room") per server. The room code only exists so QR/join links are unambiguous.

## 4. Directory layout

```
server/
  index.js              ✅ entry: args → settings → library → http + ws → room → artwork → games
  config.js             ✅ settings schema/defaults, CLI args, data dir
  library/
    parse.js            ✅ file-name parser
    scanner.js          ✅ directory walk
    zip.js              ✅ zip reader
    catalog.js          ✅ grouping, clustering, search, browse, cache
    service.js          ✅ Library: cache load/save, rescan, progress events, online watcher, paths
  http/
    songbook.js         ✅ printable songbook (HTML) and CSV export
    router.js           ✅ tiny router: routes with :params, json/text helpers, body reader (size limit)
    static.js           ✅ static files (ETag, gzip for text, no path traversal), sendFile with Range
    api.js              ✅ JSON endpoints (§8)
    media.js            ✅ /media/:trackId/(audio|cdg|video), zip entries, content types, gzip CDG
  ws/hub.js             ✅ WebSocket transport (vendored ws), heartbeat, per-client send, rate limits
  room/
    room.js             ✅ party state + actions + per-role views + broadcast coalescing
    rotation.js         ✅ fair insert / ETA helpers (pure, unit tested)
    auth.js             ✅ host PIN, localhost trust, tokens (HMAC with data/secret), display pairing
    breakmusic.js       ✅ break music between songs (library or music folder) + autoplay sing-alongs
    photos.js           ✅ guest photo uploads, moderation, TV flash/slideshow
  artwork/
    service.js          ✅ per-provider priority queues, rate limiters/back-off, meta.json, image cache, crawler
    providers.js        ✅ deezer, musicbrainz+caa, theaudiodb, itunes, fanarttv (pure parsers, image refs, host allow-list)
    match.js            ✅ search-title/credit cleanup, candidate scoring, genre normalisation
    placeholder.js      ✅ deterministic gradient SVG with initials
  games/
    base.js index.js    ✅ Game base class (phases, timers, per-role views) + registry
    quiz.js battle.js wheel.js poll.js relay.js applause.js recap.js   ✅ (§13)
  util/                 ✅ log, jsonfile, net, qr
  vendor/               ✅ ws.mjs, qrcode.mjs
shared/
  text.js               ✅ normalisation, ids, distances
  cdg.js                ✅ isomorphic CDG decoder (browser renderer + server "lyrics frame" picker)
  protocol.js           ✅ shared constants shared by server and clients
  quiz.js wheel.js applause.js   ✅ game rules shared by the server and the TV/phones
public/
  index.html            ✅ landing: links to Host / TV / Join + QR
  host.html tv.html guest.html   ✅ app shells (import maps not needed; import /js/... directly)
  css/                  ✅ base.css (tokens, dark theme), host.css, tv.css, guest.css
  js/vendor/            ✅ preact.js (Preact+hooks+htm), signalsmith-stretch.mjs
  js/lib/               ✅ ws-client.js, store.js, components.js, icons.js, audio-engine.js, cdg-canvas.js
  js/host/ js/tv/ js/guest/   ✅ views/components per app
  js/games/             ✅ one module per game: host Setup/Control, TV scene/overlay, phone view
  fonts/ img/           ✅ bundled OFL fonts (Bricolage Grotesque + Figtree), app icon
bin/
  openkaraoke.sh        ✅ start script (checks Node version, starts server, prints URLs)
  open-tv.sh            ✅ kiosk Chromium on 2nd screen with autoplay allowed
  install-service.sh    ✅ systemd --user unit (--status, --uninstall)
scripts/
  scan-report.js        ✅ validate a library from the CLI
  artwork-check.js      ✅ live check of the artwork providers (run on the PC; --save refreshes fixtures)
  vendor.js             ✅ rebuild vendored libs
test/                   ✅ node:test suites + e2e/ (Playwright scripts, `npm run e2e`)
docs/                   ✅ PLAN (this), HANDOFF, RESEARCH, LIBRARY
```

## 5. Data model

### 5.1 Track (one playable file set) — built by scanner + parser
```js
{ id,                       // shortId(`${dir}/${name}`) – stable across rescans
  root, dir, name,          // root index into settings.library.paths, relative dir, base name
  kind: 'cdg'|'video'|'zip',
  cdg, audio | video | zip + entries{cdg,audio|video},
  size, duration, mtime,    // duration (s) = cdg bytes / 7200 for CDG tracks
  p: { artist, title, brand, discId, variant[], flags{duet,solo,trio,explicit,clean,vocals,bgv,nobgv,mpx,medley,live,acoustic},
       tags[], baseArtist, baseTitle, credits[], letter },
  songId }
```
### 5.2 Song (group of versions) — `catalog.songs`
```js
{ id, key: 'artistKeys|titleKey', artist, title, artistKeys[], letter, trackIds[], versions,
  duration (median), tags[], flags{duet?,medley?,explicit?}, artistFold, titleFold, hay }
```
Client summary (`catalog.songSummary`): `{ id, artist, title, dur, v, duet?, x?(explicit), year?, art? }`.

### 5.3 Artist — `catalog.artists`
`{ key, name, letter, songIds[], count, solo, trackCount, sortKey }` (a song appears on every credited artist).

### 5.4 Party state (persisted in `data/state.json`)
```js
{ session: { id, startedAt },                 // "tonight" – reset by host "New party"; auto after 8 h idle
  singers: [{ id, name, emoji, color, deviceId?, team?, createdAt, lastSangAt, sung (tonight), totalSung }],
  queue:   [Entry], pending: [Entry],          // pending = awaiting approval
  current: Entry|null, player: { state, position, key, tempo, channelMode, volume },
  profiles: { [deviceId]: { name, emoji, color, singerId, favorites[], coHost, banned, createdAt, lastSeen } },
  hostFavorites: [songId], playlists: [{ id, name, songIds[] }],
  songPrefs: { [songKey]: { key, tempo, trackId, bySinger: { [singerId]: { key, tempo } } } },
  photos: [{ id, deviceId, status: 'pending'|'approved'|'rejected', createdAt, w, h }],
  stats: { plays: { [songId]: n } } }
Entry = { id, songId, trackId, singerIds[], addedBy: deviceId|'host', addedAt, key: 0, tempo: 1,
          mystery?, note?, source: 'guest'|'host'|'game:<type>', status: 'queued'|'pending' }
```
History is append-only JSONL: `data/history.jsonl` — `{ at, sessionId, songId, trackId, artist, title, singers[], key, tempo, playedSec, skipped, rating? }`.

## 6. Room (party logic)

### 6.1 Player state machine (server view)
```
idle ──start(entry)──▶ intro (countdown N s, TV preloads) ──▶ playing ⇄ paused
  ▲                        │ startPaused ▶ ready ──play──▶ playing
  │                        └─ skip ─────────────────────────────┐
  └──── queue empty ◀── finish(entry) ◀── TV 'ended' | host 'next'┘ ──▶ intro (next) | break | idle
```
- `intro`: `introEndsAt = now + countdown`; TV shows the next-singer card, preloads media and
  starts when both the countdown is over and media is decoded.
- `finish`: write history, bump singer stats and plays, open rating window (if enabled),
  then auto-advance (setting) or go idle/break/autoplay (`playback.whenQueueEmpty`).
- If the main display disconnects: keep the entry, mark `displayLost`, pause; when a display
  reconnects it gets a `sync` with entry + last position and waits for the host to press play.

### 6.2 Commands to the main display
`{ t:'tv', cmd:'load'|'play'|'pause'|'seek'|'stop'|'key'|'tempo'|'channel'|'volume'|'preload', ... }`
Display reports `{ t:'tv.status', entryId, pos, dur, playing, rate, key }` (≈4 Hz),
`tv.ended`, `tv.error`, `tv.ready`. Server relays compact `time` updates to hosts (4 Hz),
mirrors (4 Hz) and guests (1 Hz).

### 6.3 Queue ordering (rotation.js — pure functions, unit test them)
- **FIFO**: append.
- **Rotation** (default): round-robin by lead singer. For queue position *i*, round(i) = number
  of earlier entries with the same lead singer. The currently performing singer counts as having
  one entry in round 0. A new entry for singer S with *k* queued entries gets round *k*
  and is inserted **after the last entry whose round ≤ k**.
- **Newcomers first** (setting): if S has not sung tonight and has no queued entries, insert
  after the last round-0 entry whose singer also hasn't sung yet (i.e. before round-0 entries of
  people who already sang).
- Host overrides: "play next" (index 0), drag anywhere. Duets rotate by their lead singer.
- ETA(i) = remaining(current) + Σ_{j<i} (duration_j / tempo_j + countdown + 5 s gap).

### 6.4 Guest limits & checks (on add)
`guestsEnabled`, not banned, `maxPerGuest` (queued + pending), `maxDuration`, `allowRepeats`
(performed tonight or already queued → reject for guests / warn host), `explicitFilter`
(guests can't queue explicit songs; they are hidden from guest search).
`requireApproval` → entry goes to `pending`; host approve inserts per ordering rules.

### 6.5 Broadcasts
Actions mark the room dirty; a flush (≤ every 50 ms) sends role-specific views:
host view (everything incl. pending, profiles, displays, settings, library status),
tv view (queue for ticker, current entry with media URLs, singers, game display state, display
settings, join URL/QR), guest view (queue — mystery entries masked, current, own pending, public
settings subset, game public state) + per-device `me` block.

## 7. WebSocket protocol & auth

Endpoint `/ws`. Client first sends
`{ t:'hello', role:'host'|'tv'|'guest', token?, deviceId, name?, room?, display?:'main'|'mirror'|'board'|'preview', artSeq? }`.
Server replies `{ t:'welcome', clientId, role, token?, serverTime, state, art }` or `{ t:'denied', reason }`.
`art` = `{ seq }` plus the artwork changes after the hello's `artSeq` (`songs`, `artists`), or
`all: true` when the server can't tell any more (restart, long offline).

Auth rules:
- **host**: request from this computer (loopback or own IP) when `party.trustLocalhost`, or a
  valid host token (obtained with the PIN via `{ t:'auth.pin', pin }`). If no PIN is set,
  remote host access is refused with a hint to set one on the PC.
- **tv**: local → allowed. Remote → pairing: display shows a 4-digit code, host approves
  (`display.approve`) → token issued and stored by the display. Only waiting codes count towards
  the limit of 20; one address holds at most two (a new one replaces its oldest); a denied code
  is dropped after a minute. A hidden `preview` is only for this computer or a host token.
- **main display** (plays the sound): the first plain `/tv`. When it disconnects, another plain
  `/tv` stands in and hands the sound back to the next plain `/tv` that connects; mirrors
  (`display=mirror`), queue boards (`layout=board`) and previews never take it by themselves
  (playback pauses instead). The host can pick any non-board display (`display.main {id}`).
  A paired screen (same TV token) that reconnects while its old socket still looks open (Wi-Fi
  drop, caught only by the heartbeat) replaces that socket as main display, and stands in only
  if the old one did.
- **guest**: `room` must match `party.roomCode`; `deviceId` (random, stored in localStorage) must not be banned.
- Tokens = HMAC-SHA256(secret, role + ':' + pinVersion + ':' + id), secret in `data/secret.json`.

Client → server (all may carry `rid`):
```
queue.add {songId, trackId?, singerId?|singerName?, key?, tempo?, partners?[], mystery?, position?:'next'|'end'}
queue.remove {entryId}   queue.move {entryId, index}   queue.update {entryId, patch}
queue.approve {entryId}  queue.reject {entryId}  queue.clear  queue.shuffle
player.play {entryId?}  player.pause  player.resume  player.next  player.restart  player.stop
player.seek {pos}  player.key {semitones}  player.tempo {rate}  player.channel {mode}  player.volume {v}
singer.add/update/remove/merge     guest.update(me) guest.kick guest.ban guest.cohost
favorite.toggle {songId}  playlist.save/delete/queue   settings.update {patch}   library.rescan
announce {text, seconds}  reaction {emoji}  rate {entryId, stars}  photo.approve/reject
game.start {type, config}  game.action {...}  game.answer {...}  game.vote {...}  game.end
display.approve {code}  display.deny {id|code|all}  display.main {id}  display.forget
tv.status / tv.ended / tv.error / tv.ready   ping {c}
```
Server → client: `welcome`, `state`, `time`, `tv`, `res`, `toast`, `notify` (to one device:
"You're up next!"), `reaction`, `announce`, `game`, `lib` (scan progress), `art`
`{ seq, songs, artists, all? }` (images that became available or changed; guests don't get
queued mystery songs or their artists until the song is out in the open: it starts, or is queued
without the mystery; one removed unplayed stays withheld), `pong {c, s}`.

Rate limits: reactions 2/s per device, queue.add 10/min per device, photos 5/10 min.

## 8. HTTP API

```
GET  /                         landing          GET /host  /tv  /j/:code  (/guest)  app shells
GET  /api/info                 { name, roomCode, joinUrl, lanUrls, version, library status }
GET  /api/search?q&limit&offset&tag&letter      { total, fuzzy, items: SongSummary[] }
GET  /api/songs/:id            song detail (versions, meta, plays)
GET  /api/artists?letter&q&limit&offset&sort    GET /api/artists/:key  { artist, songs }
GET  /api/browse/popular?limit&offset&tag&genre&decade
GET  /api/browse/facets        { genres, decades, tags }
GET  /api/browse/tag/:tag      GET /api/random?n&tag&genre&decade
GET  /api/qr.svg?text=…        QR code (text ≤ 512 chars)
GET  /api/art/song/:id?s=250|500|1000     image | placeholder SVG (never 404)
GET  /api/art/artist/:key?type=picture|fanart|logo|cutout
GET  /media/:trackId/audio     audio (Range) — from file or zip entry
GET  /media/:trackId/cdg       CDG bytes (gzip when accepted; cache a few in memory)
GET  /media/:trackId/video     video (Range)
POST /api/photos               guest photo upload (raw image body ≤ 4 MB, x-device-id header)
GET  /api/photos/:id           approved photo
GET  /api/fs/list?path=…       (host only) list sub-folders for the library folder picker
GET  /api/history?limit        (host only)   GET /api/export/songbook?format=html|csv&…
GET  /print/qr                 printable A4 QR card
```
Host-only endpoints check the host token (header `Authorization: Bearer`, or cookie) or localhost trust.

## 9. TV display & playback

### 9.1 Page structure (`/tv`)
Layers (bottom → top): background (art/visualiser/photos) · CDG canvas (transparent bg) or video ·
overlays (lower-third "🎤 Name — Title · Artist" for 6 s at start, top-right small QR, bottom
ticker with next singers + message, "Up next" banner in the last 20 s, progress bar,
floating reactions, announcements) · full-screen scenes (idle lobby, intro card, games, recap).

Idle lobby: party name, big QR + join URL + room code, Wi-Fi QR (optional), animated cover
mosaic / visualiser, "Up next" if queue has entries, library size.

### 9.2 CDG decoder (`shared/cdg.js`)
- Packets of 24 bytes, 300 packets/s. Only packets with `(b0 & 0x3F) === 9` are CDG.
  Instruction `b1 & 0x3F`, data = bytes 4..19 (16 bytes, use `& 0x3F`).
- Instructions: 1 Memory Preset (clear to colour, ignore repeats>0 optional), 2 Border Preset,
  6 Tile Normal, 38 Tile XOR, 20 Scroll Preset, 24 Scroll Copy, 28 Define Transparent,
  30/31 Load Colour Table low/high (12-bit RGB → ×17).
- Framebuffer 300×216 colour indices (visible 288×192 at x 6..293, y 12..203). Tile = 6×12 at
  (col·6, row·12); bit 5 is the left-most pixel.
- Scroll: hCmd (1 = right 6 px, 2 = left), vCmd (1 = down 12 px, 2 = up); Copy wraps, Preset
  fills with colour; h/v offsets (0–5 / 0–11) shift the displayed image for smooth scrolling.
- Render: palette → RGBA ImageData; **transparent background** mode makes the memory-preset
  colour (and border) alpha 0 so art/visuals show through; add CSS drop-shadow for legibility.
- Seeking backwards = reset + replay packets from 0 (≈90k packets, < 20 ms). Track dirty tiles;
  optional Scale2x (EPX) on the index buffer before palette mapping for smooth big-screen text.
- Server-side use: pick a "lyrics frame" for quiz rounds (time with most non-background pixels
  between 30 % and 70 % of the song).

### 9.3 Audio engine (`public/js/lib/audio-engine.js`)
- `AudioContext` → **Signalsmith Stretch** node (`SignalsmithStretch(ctx)`, buffer mode):
  fetch + `decodeAudioData`, `addBuffers([L, R])`, `schedule({ output, input, rate, semitones })`,
  `start()/stop()`. Handles key (semitones) and tempo (rate) with high quality.
- Keep our own time map of every `schedule()` call → **audible input time** =
  `input0 + (ctx.currentTime - outputLatency - output0) * rate`; drive the CDG renderer with it
  (don't rely on the node's `inputTime` message, which is ahead by its internal latency).
- Graph: stretch → 2×2 channel matrix (GainNodes via ChannelSplitter/Merger: stereo, L, R, mono,
  vocal-cut L−R) → track gain (loudness normalisation) → fade gain → master gain → destination.
- Loudness: after decode compute RMS/approx. LUFS; target −16 LUFS; clamp ±9 dB; cache per track
  on the server (`tv.analysis`).
- Preload: decode next entry during the intro; drop decoded buffers after use (≈100 MB/track).
- Fallback "light mode" (weak TVs / decode failure): `<audio>` element → MediaElementSource →
  stretch in live-input mode (key only) + `playbackRate`/`preservesPitch` for tempo.
- Video: `<video>` element, same graph via MediaElementSource; tempo via playbackRate.

### 9.4 Second screen
- Host "Open TV display": if `'getScreenDetails' in window`, request permission, pick a screen
  that isn't `currentScreen`, `window.open('/tv', 'ok-tv', 'popup,left=…,top=…,width=…,height=…')`.
  The TV page shows one "Click to start" overlay (unlocks audio, requests fullscreen).
- `bin/open-tv.sh`: `chromium --kiosk --window-position=<x>,0 --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --user-data-dir=~/.config/openkaraoke-tv http://localhost:8080/tv`
  (the last flag auto-accepts the microphone prompt for the applause meter; the profile is TV-only).
- Mirrors: `/tv?display=mirror` — muted, fetch CDG only, estimate position from `time` messages
  and a ping/pong clock offset (`serverNow = Date.now() + offset`).

## 10. Host app (`/host`)
Layout: top bar (logo, party name, room code chip → invite modal, TV status, search box),
left nav, main view, right queue panel (tabs Queue / Requests / History), bottom player bar.
Views: Home (now playing, quick actions, popular carousel, tags), Search, Artists A–Z → Artist
page (header with fanart/logo), Collections (tags), Genres/Decades (when metadata exists),
Favourites, Playlists, History, Singers, Games, Photos (moderation), Settings (Library,
Display, Playback, Queue & guests, Artwork, Security, About). Song details modal: cover, meta,
versions table (label, variant, duration, file) with "Queue this version" and "Preview".

## 11. Guest app (`/j/:code`)
Join (name, emoji, colour) → bottom tabs: **Home** (now singing, my next turn + ETA, reactions),
**Search** (instant search, chips: Popular, Artists, Duets, Christmas, languages…),
**Queue** (upcoming, mine highlighted, remove mine), **Me** (my requests, favourites, history,
edit profile). Song sheet: cover, versions, key −3…+3, duet partner, mystery toggle → "Sing it!".
Game tab appears when a game is active (answer/vote UIs). Must work on iOS Safari 16+ / Android Chrome.

## 12. Artwork & metadata
- Providers (see RESEARCH §3): **Deezer** (no key; ~50 req/5 s; `artist:"…" track:"…"`
  strict search; `cover_{small,medium,big,xl}` = 56/250/500/1000 px; artist `picture_*`;
  `explicit_lyrics`; `rank`; album `/album/{id}` gives genre + release_date),
  **MusicBrainz + Cover Art Archive** (1 req/s, UA `OpenKaraoke/0.1 ( contact )`;
  `/release-group/{mbid}/front-500`), **TheAudioDB** (key `123`, 30 req/min, artist
  thumb/logo/fanart/cutout/banner), optional **iTunes** (~20 req/min, `artworkUrl100` → replace
  `100x100bb` with `600x600bb`; ToS: no caching — off by default), optional **Fanart.tv** (user key).
- Matching: clean artist (primary credit, drop "(Duet)", "feat …") and title (drop variants,
  "karaoke", brackets). Score candidates with `similarity()` on artist & title (≥ 0.75 & ≥ 0.7),
  prefer original albums (penalise "karaoke", "tribute", "hits", "cover", "in the style of"
  unless our own title or artist has that word — "Cover Girls"), prefer duration within ±15 s.
  Duos credited by surname match ("Hall & Oates" = "Daryl Hall & John Oates"), number words
  match digits ("Jackson Five"). Store confidence.
- Artists: the catalog splits credits on "&", "+", "/", commas, so band names fall apart
  ("Sam & Dave" → Sam, Dave). A performer never credited alone is searched by the act it
  appears in ("Sam & Dave"), never by the fragment (a namesake's photos); each performer of a
  featured list ("feat. Pharrell Williams, Katy Perry & Big Sean") is searched by name unless
  that list leads songs of its own ("with Brooks & Dunn"). The name searched for is stored
  (`n`, and `pictureFor` for a picture that came with a matched song); art found under an old
  name is dropped, also when the library changes during a lookup. A fragment in several acts
  ("Peter": Peter, Paul & Mary / Peter & Gordon) holds the most common act's art, so the TV only
  shows fanart/logos found for one of the song's own acts. Art found under a performer's own
  name stands in only when the providers were asked about the act and know nothing ("Elton John"
  for "Elton John & Kiki Dee"), since that name may be a namesake ("Dave" the rapper and the
  Dave of "Sam & Dave" are one catalog artist); the two are never mixed. An act never looked up
  gets no stand-ins (also offline); one looked up long ago keeps them while it is asked again or
  can't be asked (a refresh starts `tried` over; `asked` keeps the databases that searched for
  the name before until they answer again, so one backing off changes nothing). When the act's
  first lookup ends with nothing found, an `artChoice` event (server-internal: no image changed)
  rebuilds the TV's view.
  Deezer's "no picture" images (`images/artist//…`, MD5 of "" `d41d8cd9…`) are ignored, and
  so are version-1 pictures that came with a matched song (no mark; then any performer in the
  track's credit got it): they are looked up again for the current search name.
- Cache: `data/art/<sha1(url)>.jpg` (download 250 px for lists, 1000 px for TV on demand),
  metadata in `data/meta.json` keyed by song key: `{ provider, id, cover:{s,m,l}, artistPic,
  genre, year, explicit, rank, album, confidence, fetchedAt }`; misses retried after 30 days.
- Priorities: current/next entries > songs visible in UIs (on-demand) > background crawl
  (popular first). Per-provider token-bucket limiters, exponential back-off on 429/quota errors.
- Placeholder: deterministic gradient from `hash32(artist)` with initials, served as SVG.
- Clients: `<img src="/api/art/song/ID?s=250">`; server pushes `art` events so UIs refresh
  (the event's `seq` becomes `&v=` in the URL). Images and placeholders are sent `no-cache`
  with an ETag, so a changed cover also reaches pages opened later (a 304 otherwise).

## 13. Games
All games are server state machines (`server/games/*.js`) with a public view for TV/phones.
Phones auto-join when they send an answer/vote; the host controls start/next/end.

1. **Music Quiz** (KaraFun Quiz / Karaoke Mugen blind test style): N questions (5–30), timer
   10–30 s, 4 choices on phones (Kahoot colours/shapes). Round types: *Intro* (first seconds of
   the backing track, CDG hidden), *Mid-song snippet*, *Name the artist*, *Lyrics peek*
   (static CDG frame from the middle of the song, no audio), *Cover zoom* (needs art),
   *Helium* (+7 semitones), *Slow-mo* (rate 0.7), *Reverse* (reversed buffer), *Year/decade*
   (needs metadata). Distractors from the same decade/genre or similar popularity; never
   duplicate titles. Score = 500 + 500·(1 − t/T) for correct answers, streak bonus +100.
   Reveal (cover + title, who got it), leaderboard every 3 questions, final podium + confetti.
   Optional "sing-along interlude" (30 s of the answer with lyrics).
2. **Battle**: 2–8 contestants (singers or teams). Formats: head-to-head (1–3 rounds), knockout
   bracket, showcase (everyone sings, highest average wins). Song pick: same song / each picks /
   random from filter / wheel. Snippet length: full, 90 s or 60 s (fade out). Voting: phones
   (pick A/B or rate 1–10), optional applause meter (PC mic via localhost TV/host page), optional
   judges (host enters scores). VS intro, live vote bars, winner podium, battle history.
3. **Roulette wheel**: segments = random songs (filters), singers, dares, genres or duet pairs.
   Server decides the result; TV animates a spin landing on it; action = queue/assign/show dare.
4. **Crowd poll "What's next?"**: 4 candidates, 20 s vote, winner queued (sing-along or host).
5. **Pass the mic**: during a song, TV flashes "PASS THE MIC ➜ NAME" at random 15–40 s
   intervals among participants; that phone vibrates.
6. **Applause meter**: 5 s mic measurement on the PC (localhost is a secure context; phones on
   LAN http are not, so no phone mics) → 0–100 meter.
7. **Ratings & recap**: optional 1–5 ★ after each song; "Party recap" screen (top singers,
   most-sung artists, crowd favourite, total songs/time).
8. Not possible with CDG (no melody/lyric text): pitch-scored singing, "finish the lyric".
   Could be added later for UltraStar `.txt` songs if the owner adds any.

## 14. Settings reference
The single source of truth is `DEFAULT_SETTINGS` in `server/config.js`; `Settings.update()`
drops unknown keys and coerces types. Host UI renders forms for every group there.

## 15. Persistence (`data/`, git-ignored)
`settings.json`, `secret.json`, `library.json` (catalog cache), `state.json` (party state),
`history.jsonl`, `meta.json` (artwork/metadata), `art/` (images), `photos/` (guest uploads).

## 16. Security & privacy
LAN only by default (binds 0.0.0.0 so phones can connect). Host actions need localhost or PIN
token; displays need localhost or pairing; guests limited by role checks and rate limits;
uploads size-limited and re-encoded client-side; directory listing only for host and only
folders; media endpoints only serve files that are indexed tracks (never arbitrary paths).
No telemetry. Outbound traffic only to the artwork providers (can be disabled).

## 17. Testing
- Unit (node:test): parser table, catalog grouping/search, scanner/zip fixtures, rotation
  ordering, ETA, limits, quiz scoring/distractors, battle brackets, auth tokens, settings.
- CDG: generate a synthetic CDG in a test (tile writes, colour tables, scroll) and assert the
  framebuffer; also decode a real `.cdg` from the drive when available (local only).
- E2E (optional devDependency `playwright-core` with system Chromium): host + tv + 2 guests
  in one browser, queue → intro → play → ended; screenshot each screen.
- Library smoke test: `node scripts/scan-report.js "<drive>"`.

## 18. Roadmap
- ✅ **M0 Foundation**: parser, scanner, zip, catalog/search, settings, utils, vendored libs, tests.
- ✅ **M1 Server runs**: `library/service.js`, `http/{router,static,api,media}.js`, `ws/hub.js`,
  `server/index.js`, `bin/openkaraoke.sh`; `/api/search` + media streaming work against the real drive.
- ✅ **M2 TV player**: `shared/cdg.js` (+ tests), audio engine, `/tv` scenes (idle lobby with QR,
  intro, singing overlays), click-to-start, keyboard shortcuts.
- ✅ **M3 Room + host app**: room/rotation/auth, host UI (search, queue panel, player bar,
  singers, settings, invite modal), open-TV-on-second-screen, kiosk script.
- ✅ **M4 Guest app**: join flow, search/browse, song sheet, queue, reactions, notifications.
  → **first real party possible**.
- ✅ **M5 Artwork & metadata**: providers, cache, placeholders, crawler, genres/decades browse
  (provider parsers tested against documented-shape fixtures; live check pending on the PC).
- ✅ **M6 Games**: quiz, battle, wheel, poll, pass-the-mic, applause meter, ratings, recap
  (game framework in `server/games/`, UIs in `public/js/games/`; sound/mic/legibility to check on the PC).
- ⬜ **M7 Polish**: break music/autoplay, photos, mirrors & pairing, printable songbook/QR card,
  systemd service, README screenshots, performance pass.

## 19. Open questions for the owner
- Host PIN default: none (localhost-only host) — OK?
- Default label preference order for versions (e.g. SF → Zoom → Sound Choice)?
- Should explicit songs be hidden from guests by default?
- Break music source: library instrumentals (default) or a music folder?
