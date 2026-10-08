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
- ✅ P1 **Lead vocal level** on multiplex tracks (the original singer off / quiet / full, the music
  unchanged) and **backing vocals** by version (with / without), for the host and, on their own
  song, the singer — §21.
- ✅ P0 "Next singer" intro card with countdown, then auto-start (or start-paused mode).
- ✅ P0 Preload next track during the intro; break music fades out when the next song starts.
- 🟡 P0 Video karaoke (MP4/WEBM) with the same controls (tempo via playbackRate, key via stretch live input) — implemented, untested with real video files.
- ✅ P1 Background behind transparent CDG: blurred cover / artist fanart (Ken-Burns), idle cover mosaic, audio
  visualiser, guest photos, or plain colour. CDG smoothing (Scale2x) for crisp text on big TVs.
- ✅ P1 Lyric sync offset setting (ms) and automatic output-latency compensation (getOutputTimestamp).
- ✅ P1 **Lyric layouts** (§9.6): the disc's own pages, **two lines at a time** (karaoke-bar style)
  or a **scrolling list** (like music apps), from the sung lines found in each CD+G disc.
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
- The same server also runs inside the **desktop app** (`desktop/`, Electron): the host page is
  the main window, `/tv` a window of its own (full screen on the second screen), guests still
  join over the network. Port 6527 by default, or the next free one (kept); one server per
  data folder (`data/server.json`).

## 4. Directory layout

```
server/
  index.js              ✅ entry: args → logging → start.js
  start.js              ✅ data-folder lock, port (saved, or the next free one), createApp, listen
  app.js                ✅ settings → library → http + ws → room → artwork → games
  config.js             ✅ settings schema/defaults, CLI args, data dir, default port 6527
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
    shell.js            ✅ the current skin written into every HTML page (data-theme, theme-color)
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
  util/                 ✅ log, jsonfile, net (free ports), qr, datalock (one server per data folder)
  vendor/               ✅ ws.mjs, qrcode.mjs
shared/
  text.js               ✅ normalisation, ids, distances
  cdg.js                ✅ isomorphic CDG decoder (browser renderer + server "lyrics frame" picker)
  lyrics.js             ✅ readable lyrics: looks, colour keying, readable palette, colour roles, scroll timeline (§9.5)
  graphics.js           ✅ which WebGL renderers draw in software (TV lighter effects, desktop Graphics)
  protocol.js           ✅ shared constants shared by server and clients
  themes.js             ✅ skins (Studio, Party): ids, names, appearance validation
  quiz.js wheel.js applause.js   ✅ game rules shared by the server and the TV/phones
public/
  index.html            ✅ landing: links to Host / TV / Join + QR
  host.html tv.html guest.html   ✅ app shells (import maps not needed; import /js/... directly)
  css/                  ✅ base.css (skin tokens: Studio + Party), host.css, tv.css, guest.css
  js/vendor/            ✅ preact.js (Preact+hooks+htm), signalsmith-stretch.mjs
  js/lib/               ✅ ws-client.js, store.js, components.js, icons.js, audio-engine.js, theme.js,
                           lyrics-renderer.js + frame-clock.js (the TV's lyrics, §9.5), cdg-canvas.js (the quiz's lyrics frame)
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
  lyrics-check.js       ✅ how the readable lyrics treat a real library: PNG contact sheets + report (§9.5)
  vendor.js             ✅ rebuild vendored libs
test/                   ✅ node:test suites + e2e/ (Playwright scripts, `npm run e2e`)
docs/                   ✅ PLAN (this), HANDOFF, RESEARCH, LIBRARY
desktop/                ✅ the Linux desktop app (Electron + electron-builder, dev dependencies here only)
  main.mjs              ✅ server in-process, host window, TV window on the second screen, menu, permissions
  displays.mjs          ✅ which screen the TV window goes to (pure)
  preload.cjs           ✅ window.okDesktop: openTv, pickFolder, updates
  updater.mjs update-logic.mjs   ✅ updates from GitHub releases (AppImage swap, pkexec dnf/apt-get)
  electron-builder.config.cjs    ✅ AppImage, .rpm, .deb → desktop/dist/
  test/app.mjs          ✅ end to end under Xvfb (npm --prefix desktop test)
.github/workflows/desktop.yml    ✅ test, build and release the desktop app for every change on main
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
`{ t:'hello', role:'host'|'tv'|'guest', token?, deviceId, name?, room?, display?:'main'|'mirror'|'board'|'preview', artSeq?, resume? }`.
Server replies `{ t:'welcome', clientId, role, token?, serverTime, state, art }` (a TV also gets `display`
and a secret per-connection `resume` key, kept in memory and sent back when it reconnects) or
`{ t:'denied', reason }`.
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
  A screen that reconnects while its old socket still looks open (Wi-Fi drop, caught only by
  the heartbeat) replaces that socket as main display, and stands in only if the old one did:
  the same page (its `resume` key matches the main display's connection) or the same paired
  screen (same TV token), asking for the same kind of display.
- **guest**: `room` must match `party.roomCode`; `deviceId` (random, stored in localStorage) must not be banned.
- Tokens = HMAC-SHA256(secret, role + ':' + pinVersion + ':' + id), secret in `data/secret.json`.

Client → server (all may carry `rid`):
```
queue.add {songId, trackId?, singerId?|singerName?, key?, tempo?, lead?, bgv?, partners?[], mystery?, position?:'next'|'end'}
queue.remove {entryId}   queue.move {entryId, index}   queue.update {entryId, patch}
queue.approve {entryId}  queue.reject {entryId}  queue.clear  queue.shuffle
player.play {entryId?}  player.pause  player.resume  player.next  player.restart  player.stop
player.seek {pos}  player.key {semitones}  player.tempo {rate}  player.channel {mode}  player.volume {v}
player.lead {level}  player.layout {layout}  player.version {trackId}   (vocals, §21)
version.vote {trackId, vote: 1|-1|0}   display.identify {id}   (§22)
singer.add/update/remove/merge     guest.update(me) guest.kick guest.ban guest.cohost
favorite.toggle {songId}  playlist.save/delete/queue   settings.update {patch}   library.rescan
announce {text, seconds}  reaction {emoji}  rate {entryId, stars}  photo.approve/reject/rejectWaiting
duet.answer {entryId, accept}  duet.invites {allow}   (guest: answer / turn off duet invitations)
game.start {type, config}  game.action {...}  game.answer {...}  game.vote {...}  game.end
display.approve {code}  display.deny {id|code|all}  display.main {id}  display.forget
tv.status / tv.ended / tv.error / tv.ready / tv.analysis   ping {c}
```
`game.action` may carry the game's `step` (in the host view; it counts phase changes): a control
drawn for an older step is ignored (`{ stale: true }`), and so is one that arrives within
`GAME_SETTLE_MS` (600 ms) of a host control that moved the game on — the second click of a double
click lands on the button the host's screen has meanwhile drawn for the new phase. The host's
phase buttons stay disabled for that long too, so a double click never skips a phase.

Server → client: `welcome`, `state`, `time`, `tv`, `res`, `toast`, `notify` (to one device:
"You're up next!"), `reaction`, `announce`, `game`, `lib` (scan progress), `art`
`{ seq, songs, artists, all? }` (images that became available or changed; guests don't get
queued mystery songs or their artists until the song is out in the open: it starts, or is queued
without the mystery; one removed unplayed stays withheld), `pong {c, s}`.

Rate limits: reactions 2/s per device, queue.add 10/min per device, photos 5/10 min. Photo
uploads are checked (photos on, named, not banned, rate limit) before their body is read; one
upload at a time per phone, 2 per address, 8 in all. An upload is cut off after 5 s without
data or 20 s in all, and when all 8 slots are taken a newcomer replaces the slowest upload that
is under 64 KB/s after 2 s or still arriving after 8 s (so uploads that stall or trickle can't
keep guests out: holding every slot would take a new upload, and photo token, per second). At most 5
photos per phone, 10 per address and 50 in all wait for the host. When the list (or the address's
share) is full, a new photo replaces the oldest one from the busiest address (its busiest phone)
if that has more waiting than the sender's address, else from the busiest phone at the sender's
address if that has more than the sender — so a phone with nothing waiting always gets a place
and a flood (many guest names, several addresses) pushes out its own photos first. The host can
turn down every waiting photo at once (`photo.rejectWaiting`). 300 approved/rejected are kept
(rejected, then the oldest approved, go first — waiting photos never push out approved ones).
Duet invitations (a guest's `queue.add` with `partners: [singerId]`): the partner is asked
(`notify` kind `duet`) only once the song is in the queue (after host approval when that is
on), and every open invitation is in the partner's own state (`me.invites`) so a locked or
reloaded phone still shows it. One open invitation per inviter → partner, at most 3 waiting
per partner, 3 per pair and 6 per partner per 10 min, a "no" sticks for that song; a guest can
turn invitations off (`duet.invites`). Bans, singer removal and the song starting withdraw them.

## 8. HTTP API

```
GET  /                         landing          GET /host  /tv  /j/:code  (/guest)  app shells
GET  /api/info                 { name, roomCode, joinUrl, lanUrls, version, library status, appearance }
GET  /api/search?q&limit&offset&tag&letter      { total, fuzzy, items: SongSummary[] }
GET  /api/songs/:id            song detail (versions, meta, plays; per version plays, up, down, mine,
                               heard tonight, status; default first + defaultTrackId, defaultWhy — §22)
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
POST /api/photos               guest photo upload (raw image body ≤ 4 MB, x-guest-token header)
GET  /api/photos/:id           approved photo
GET  /api/fs/list?path=…       (host only) list sub-folders for the library folder picker
GET  /api/history?limit        (host only)   GET /api/export/songbook?format=html|csv&…
GET  /print/qr                 printable A4 QR card
```
Host-only endpoints check the host token (header `Authorization: Bearer`, or cookie) or localhost trust.
`/api/songs/:id` with a valid guest token (`x-guest-token`, sent by the guest app) gives the guest's
view even from this computer: their own vote, no file paths, no explicit versions under the filter.

## 9. TV display & playback

### 9.1 Page structure (`/tv`)
Layers (bottom → top): background (art/visualiser/photos) · the lyric box (§9.5) or video ·
overlays, all outside the lyric box (a one-line "🎤 Name · Title by Artist" strip above the
lyrics for the first 8 s, the join QR in the side margin, bottom ticker with next singers +
message, "Up next" banner in the last 20 s, progress bar, reactions rising in the right margin,
announcements) · full-screen scenes (idle lobby, intro card, games, recap).

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
- Render: see §9.5 (the TV) — palette → RGBA through a colour table, the background colours keyed
  out by what is on screen, no CSS filter. Define Transparent (28) is parsed but never keyed (it
  is a 16-entry table, and keying it can hide white text). `seek()` ignores a time that is not a
  number; the latest Scroll Preset fill colour is kept in `scrollFill`.
- Seeking backwards = reset + replay packets from 0 (≈90k packets, a few ms; `scroll()` copies
  whole rows). Scale2x (EPX) on the index buffer before palette mapping for smooth big-screen
  text (`scale2xRect` redoes only a rectangle).
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
  vocal-cut L−R, or on a multiplex track the lead vocal level — §21) → track gain (loudness normalisation) → fade gain → master gain → destination.
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
- `bin/open-tv.sh`: `chromium --kiosk --window-position=<x>,0 --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --user-data-dir=~/.config/openkaraoke-tv http://localhost:6527/tv` (the port the running server wrote to `data/server.json`)
  (the last flag auto-accepts the microphone prompt for the applause meter; the profile is TV-only).
- Mirrors: `/tv?display=mirror` — muted, fetch CDG only, estimate position from `time` messages
  and a ping/pong clock offset (`serverNow = Date.now() + offset`).

### 9.5 Readable lyrics
The owner: "The scrolling lyrics dont work well, the way the page renders. Create a more fool
proof way to easily read the text." What was wrong (measured): on a PC that draws without a
graphics card the TV ran at ≈5 fps while the lyrics changed (0.8 fps at 4K), so a glide showed as
2–4 jumps — two `drop-shadow` filters on the canvas, the background shade picking up the dialogs'
`.scrim` backdrop blur, Ken Burns, and a full redraw for every 1-pixel scroll step; light discs
turned into dark words on dark art (their background was keyed out whatever its colour); weak
disc palettes; opaque strips in a disc's scroll-fill or border colour; the title card, reactions
and banners over the lyrics; letters changing shape at non-integer scales; and any backward step
of the clock replaying the whole song.

**The rule: never put a CSS filter, mask, backdrop-filter or rounded clip on an element whose
content moves or changes every frame.** In software drawing each one redraws its whole area on
every frame. Legibility comes from still elements (the plate) and from the pixels (the outline).

**Settings** (Settings → TV display; lists and defaults in `shared/lyrics.js`, an invalid value in
an update is dropped):
- `display.lyricsLook`: `panel` (default) "On a dark panel", `clear` "Over the background, with an
  outline", `disc` "As the disc made them". The admin panel's Playback tab switches it too.
- `display.lyricsMotion`: `smooth` (default) or `disc` (the disc's own 1-pixel steps).
- `display.cdgSmoothing` (on): Scale2x, filtered scaling; off: the disc's square pixels, a whole
  number of device pixels each (the lyrics may be a little smaller).
- `display.lighterEffects`: `auto` (default), `on`, `off` (below).
- Migration: a saved `display.cdgTransparent: false` (the old "Show the background behind the
  lyrics" switch) becomes `lyricsLook: 'disc'`; the key is removed either way.

**The looks.** All three keep today's box (min(86vh, 86vw / 1.5) high, 3:2, centred) and have no
filter. *panel*: a still, rounded plate behind the window in
`rgba(var(--lyrics-plate-rgb), var(--lyrics-plate-alpha))` (tokens in both skins: `--night-rgb`,
0.9); the disc's background colours are keyed out and its colours made readable on the plate.
*clear*: no plate; keyed, readable colours and a 1-CD+G-pixel dark outline baked into the pixels
(`--shade-rgb` at 0.9; with lighter effects the still radial shade under the lyrics). *disc*:
nothing keyed or changed, opaque, in a frame of the disc's border colour (`--disc-border`, set
from its palette) with a box-shadow.

**The renderer** (`public/js/lib/lyrics-renderer.js`; DOM in `tv.html`: `#lyrics` >
`.lyr-plate` + `.lyr-window` (overflow hidden, square corners) > `canvas#cdg`):
- The canvas holds the decoder's whole 300×216 memory (with smoothing its Scale2x, 600×432). The
  disc's scroll offsets and the smoothed scroll are a `translate()` of the canvas in whole device
  pixels: a 1-pixel scroll step costs no redraw, only a compositor move. A 12-row memory move
  redraws, and the transform drops by 12 rows in the same frame (12·k is whole, so they cancel).
- `layout()` (load, resize, devicePixelRatio change, smoothing change): the box height snapped to
  a multiple of 16 device pixels (smoothing) or to a whole k per CD+G pixel (`pixelated`),
  placed in whole device pixels; a box smaller than the disc's 192 rows (the host's live preview)
  shrinks in multiples of 16, filtered, in either mode; it publishes `--lyr-left/top/w/h` for
  the overlay layout.
- `render(t)` every animation frame: a backward step under 0.3 s is held (jitter, mirrors); the
  decoder catches up; a redraw only when its memory or the colour table changed: the rectangle of
  memory that differs from what was drawn (grown by 2 pixels for the outline and Scale2x) goes
  through a 17-entry colour table (16 + the outline) and `putImageData` of that rectangle only.
  Colour tables are cached by key (last 64).
- The quiz's lyrics frame keeps `CdgRenderer` (`js/lib/cdg-canvas.js`).

**Scroll smoothing** (`scrollTimeline`, `scrollShift`): at load one pass over the scroll packets
gives S = 12·(rows moved) + offset at every change. A disc with at least 8 one- or two-pixel steps
is smoothed with a box mean over the widest of 60/45/30/20/10 packets that stays within 3 CD+G
pixels of the disc; jumps of more than 2 pixels (page turns) are never smoothed. The window loses
up to 3 rows at the top and bottom (the insets), which hides rows the smoothing would show early
or late.

**Frame clock** (`public/js/lib/frame-clock.js`): the lyrics' time advances with the animation
frame's timestamp × tempo and is pulled 8% per frame towards the media clock; it never steps back
while playing, snaps to the media clock on a jump of more than 0.25 s and follows it when paused.
Reset on load, stop and a display change.

**Colours** (`shared/lyrics.js`, pure):
- Keying, at every redraw, from the window's histogram: colours covering ≥ 35% (kept down to 20%),
  the memory-preset colour at ≥ 10%, the latest scroll-preset fill colour (since the last memory
  preset) when it is on screen, the border colour when it shows nowhere but the strip the offsets
  uncover, and any colour that looks the same (OKLab ΔE < 0.02) as a keyed one. Nothing keyed (a
  picture screen): shown as is.
- Keying holds still for a screen (`ScreenKeying`; a screen lasts from one memory preset to the
  next, the decoder's `presetCount`), so a box drawn or erased tile by tile (a title card) no longer
  flashes on, off and on again: a colour that has covered ≥ 35% on this screen stays keyed while
  what is on screen of it is an area (≥ 50% of its pixels with all 8 neighbours alike), not lines
  of words; and one the load-time pass saw at ≥ 35% at any sample of the screen is keyed from the
  screen's start — unless the pass also saw it drawn in lines (≥ 64 pixels, mostly not inside an
  area) at two samples or more, when it is held only while it looks like an area. These holds
  apply only when something else is background (a picture screen still shows as is), and colours
  held but not on screen are added after the look-alike step (they never hide a look-alike).
- Colour roles, from a load-time pass over the song (a screen every 0.5 s, in 8 ms slices, the
  first 10 s before the song starts, never mid-song statistics): areas, edges (outlines, halos)
  and fills (everything else); until it finishes every colour is a fill. The same pass notes each
  screen's big and line colours for `ScreenKeying`.
- `readablePalette` (OKLab, hue and chroma kept): dark words on a light background flip to light
  on dark; fills rise to 7:1 or more against the plate over mid-grey (the brightest backdrop the
  skins leave), keeping their order and at least 0.12 ΔE apart (sung and unsung stay apart); halos
  stay at least 0.35 L below the dimmest fill; a disc that already reads well is left byte for
  byte.

**Lyric-safe layout** (`tv.css`, `--lyr-side`, `--lyr-band`, `--band-h`…): nothing shown with the
lyrics covers the box (checked at 1920×1080, 1280×720, 1366×768, 1024×768, 1280×1024, 2560×1080 and
a 720×1280 mirror): the title strip, "Up next" and Paused are one line in the band above the box;
the join QR sits in the side margin at 17:10 and wider, a row in that band below; reactions rise
in the right margin (hidden on portrait screens); the progress bar is on the ticker's top edge;
the pass-the-mic band and the battle badge use the band, the photo flash the side margin. One
notice at a time in the band (each has its own place there and nothing else keeps them apart):
Paused takes it — Up next and the battle badge wait (the ticker still lists the next singers) —
and below 17:10 the pass-the-mic holder's pill (at the band's right end there) waits for the
title strip, Up next and Paused; the pass-the-mic band hides the others while it is up.

**Lighter effects anywhere** (`public/js/tv/lighter.js`): `html.lite-auto` gives every TV page
what the desktop app's `.lite-fx` gives its windows — still backgrounds (no drift or Ken Burns,
and the photo slideshows behind a song hold still), no blur: the song's cover behind the lyrics
loses its 7vh blur (`--art-bg-filter-lite`, the same dimming without it; it is drawn again for
every song, and in software that blur froze a 4K TV for ≈2 s at a time as a song started) and
is left out under the artist's photos (still and opaque there). `on`: always;
`off`: never; `auto`: when the browser draws in software (a WebGL context with
`failIfMajorPerformanceCaveat` fails, or its renderer is a software one — `shared/graphics.js`)
or when two windows in a row while lyrics play are slow (`public/js/tv/frame-watch.js`, pure). A
window is ≈2 s of frames (at least 8), judged by itself because the screen's refresh is unknown
(the TV window can move to a 30 or 24 Hz TV mode, or from a 144 Hz monitor): slow when its median
frame gap is above 1.35× its own fastest tenth (counted as no faster than 60 fps: 45 fps and up is
fine) or above 50 ms (under 20 fps). A steady half rate (every frame two refreshes) looks the same
as a 30 Hz TV and is not counted. It trips within ≈4 s at any rate from 1 fps up; it stays until
the page reloads; the reason is logged once and kept in `data-lite-reason`. The host's preview and the queue board never decide by themselves. The
desktop app marks its pages with this PC's choice (`data-lighter`); its "off" wins over `auto`.
The TV's art shade is `.art-shade` (the dialogs' `.scrim` brought a full-screen backdrop blur).

**Budget** (software drawing, a busy photo, a smooth-scrolling disc): 1080p ≥ 40 fps with Ken
Burns, 60 with lighter effects; 4K with lighter effects ≥ 45 fps during a glide; ≤ 2 ms of script
per frame, ≤ 5 ms for a colour-table change. Measured in headless Chromium (SwiftShader, 4 cores,
the repro library's smooth scroller, a bright busy artist photo), before → after: 1080p with Ken
Burns 5 → 47 fps; 1080p with lighter effects 60 (glide 60); 1920×1080 at 2× (4K pixels) with
lighter effects 60 (glide 60); a 3840×2160 viewport 0.8 → 9 fps without and 34 → 55 fps with
lighter effects, but the frames that move the lyrics take two refreshes there (≈33 fps while
gliding): the compositor's bilinear scaling of the moving canvas over the 5-megapixel window is
the cost in software (nearest-neighbour costs half). With "Smooth lyrics text" off (whole-number
scale, `pixelated`) that viewport glides at 54–60 fps. Script per frame: 0.3 ms median, 0.5 ms at
the 95th percentile, 3–4 ms worst (a 12-row move redraws the whole canvas); a colour-table change
with an empty cache 2.5 ms (the first, not yet compiled, ≈10 ms); no decoder replay while playing.
Under lighter effects the slideshows behind a song (artist photos, guests' photos) hold still: a
new full-screen picture froze software drawing for ≈0.25 s at 1080p and 2.4 s at 4K; and the
cover is not blurred (with the blur, four freezes of 1.5–2.1 s as each song started at 3840×2160;
without, the longest frame ≈150 ms, at 1080p none over 70 ms).

**Tests**: `test/lyrics.test.js` (archetype discs, keying and its holds per screen, roles,
timeline), `test/frame-clock.test.js`, `test/frame-watch.test.js`,
`test/cdg.test.js`, settings in `test/util.test.js`, tokens and lyric-box rules in
`test/themes.test.js`, `test/e2e/lyrics.mjs`; on a real library, `scripts/lyrics-check.js`.

### 9.6 Lyric layouts
The owner: "I want this app to have several different popular methods of displaying text. Verify
its readable and not jittery or confusing." Three layouts, `display.lyricsLayout` (Settings → TV
display → **Lyrics layout**, and the admin panel's Playback tab → On the TV):
- `page` (default) **Pages, as on the disc** — §9.5, unchanged.
- `lines` **Two lines at a time** — the line being sung and the next one, as karaoke bars, KaraFun
  and karaoke videos show them. Two places, one above the other; lines take them in turn (line j of
  a verse is in place j % 2), so a line never moves once it is up, and the next line is always up
  while one is sung. A line comes in when the line two before it is sung (it lingers up to 0.25 s,
  then the new one fades in 0.1 s after it has gone, or at once when that would leave the new one
  less than 1 s); a verse's first two lines come in 4 s before it, with a countdown (three dots,
  one goes out a second) over the first line; a pause of more than 8 s ends a verse and clears the
  screen 1.5 s after its last line.
- `scroll` **Scrolling list, like music apps** — every line in one column, the line being sung in
  focus 40 % down the box at full strength, the lines to come at 60 %, the ones sung at 38 %; the
  column glides to the next line in 0.45 s (smoothstep: starts and ends at rest), ending as it
  starts, never before the line before is nearly done (after a pause of more than 3 s the next line
  comes into focus 2.5 s early, with the countdown); lines sung together (starting within 0.5 s, a
  duet) are one stop, in focus together. Lines fade out towards the box's edges.
Both keep the lyric box of §9.5 (so every overlay rule holds), its look (panel, clear outline,
disc colours) and the readable palette; every line of a song is drawn at the same scale: the
widest line fills 96 % of the box (and, scrolling, at least four lines and their gaps fit), a
whole number of device pixels per CD+G pixel with smoothing off.

**Finding the lines** (`shared/lyric-lines.js`, `analyzeLines` / `linesAsync`, once per song in 8 ms
slices; ≈60–200 ms of processor time for a 3–5 minute disc): CD+G is pictures, not text, so the
lines are the disc's own letters. One pass over the packets judges every tile once its packets stop
(NORMAL + XOR writes of one tile are one change): letters re-coloured without being erased are
being sung (a highlight bar painted behind them counts); a tile that erases letters is a redraw (a
page written over a page); a re-colouring the other way than the disc's wipes so far (sung back to
unsung) is a redraw too. Where singing starts outside any line, a line is born: the band of rows
with ink around it (gaps of up to 3 empty rows, at most 64 rows: a taller band is a picture). The
line keeps its own copy of its pixels — each one's unsung colour, its sung colour and the packet it
turned (its first change in the biggest burst of changes; changes more than 1.5 s before or after
it belong to page redraws) — so it can be drawn before it is on the disc's screen and after the disc
erased it. It ends when the screen is cleared, 30 % of it is erased, a tile writes other letters over
it, or it scrolls out of sight (scrolls move it with the memory). Background colours are the
window's big colours, the preset colour and the scroll fill (as §9.5's keying, without the
look-alikes and holds). Ink more than 3 pixels from any sung pixel is dropped (leftovers). Lines with
fewer than 24 (or 5 %) sung pixels are dropped; the rest are sorted by when they start. A disc with
fewer than 4 lines, or less than 60 % of its re-colouring inside them, is not followed: the TV shows
its pages (`data-layout="page"` with `data-layout-wanted` the choice) — titles, info cards,
countdown squares, "INSTRUMENTAL", words that are never sung and discs that never re-colour never
become lines. While the pass runs (a moment as the song loads) nothing is shown (`data-layout="wait"`).

**Drawing** (`public/js/lib/lyric-lines-view.js`, inside `.lyr-window`, the page's canvas hidden): one
small canvas per line shown, made when it comes up (Scale2x with smoothing, the outline of the clear
look baked in, the colour table of `lyricsLut` for its palette and keying with the song's colour
roles); redrawn only while its pixels turn (the number sung at the moment changes); moved by a
`translate` in whole device pixels and faded by `opacity` — no filter, mask or rounded clip. Where
and how visible every line is comes from pure functions of the song time (`shared/lyric-layout.js`:
`twoLinePlan`/`shown`, `scrollPlan`/`focusAt`/`stopAt`/`scrollAlpha`, `countdownAt`, `lineScale`):
the TV, a mirror and the host's preview draw the same thing at the same moment, and nothing moves
that the plan doesn't move. The panel's plate is a band behind the two lines (the whole box when
scrolling); the disc look puts the disc's background colour in the window.

**Verified** (`test/e2e/layouts.mjs`, every animation frame of ≈60 s of songs recorded and checked
against the plan worked out in Node from the disc): the clock never goes back; a two-line line never
moves; the scrolling list puts every line exactly where the plan says on every frame, moves only in
glides, never back, never faster than 1.5× a glide's mean speed; opacity never changes faster than
the quickest fade; each line's sung pixels are the disc's own at that moment (pixel count); the line
being sung is always fully up, the next one up by its middle, lines never overlap and appear in sung
order; a 12 s instrumental clears the screen; the letters (every fill colour) reach 7:1 on the panel,
are 6.9 % of the screen high at 1920×1080 (≥ 4.5 %: legible across a room) and stay inside the box
and its plate; the looks have no filter; a disc that never re-colours keeps its pages; a switch while
singing, the mirror and the host's preview follow. In software drawing (headless Chromium) the
scrolling list runs at 60 fps at 1920×1080 and at 3840×2160 with lighter effects, 0.3 ms of script a
frame (95th percentile). On a real Sound Choice disc (a public sample, not in the repository) the pass
finds all 101 lines in sung order (100 % of its re-colouring) in ≈150 ms; the disc shows some lines
only 0.4 s before they are sung (its page turns); two lines show every line 0.57 s or more ahead
(median 2.8 s), the scrolling list shows each line from the start of the song.

**Known limits**: with two places, a line can come in only once the line two before it is sung, so
after a very short line (0.2–0.5 s, "SHE CRIED") the next one has about that long — the scrolling
list has no such limit; lines sung together with the line before (a duet) come in as soon as a place
is free; a line the disc draws wider than its screen is cut where the disc cuts it; colour-cycling
wipes (the palette changes, not the pixels) are not seen as singing (such a disc keeps its pages).

## 10. Host app (`/host`)
Layout: top bar (logo, party name, room code chip → invite modal, TV status, search box),
left nav, main view, right **admin panel** (tabs Queue / Playback / Devices — §22), bottom player
bar (what's on, transport, seek, volume, TV chip). Phones (≤ 900 px): the panel is the "Control"
page (`#/panel/queue|playback|devices`) and a mini player (play/pause, next; tap → Playback).
Views: Home (now playing, quick actions, popular carousel, tags), Search, Artists A–Z → Artist
page (header with fanart/logo), Collections (tags), Genres/Decades (when metadata exists),
Favourites, Playlists, History, Singers, Games, Photos (moderation), Settings (Library,
Display, Playback, Queue & guests, Artwork, Security, About). Song details modal: cover, meta,
versions table (label, variant, duration, file) with "Queue this version" and "Preview".

## 11. Guest app (`/j/:code`)
Join (name, emoji, colour) → bottom tabs: **Home** (now singing, my next turn + ETA, reactions),
**Search** (instant search, chips: Popular, Artists, Duets, Christmas, languages…),
**Queue** (upcoming, mine highlighted, remove mine), **Me** (my requests, favourites, history,
edit profile). Song sheet: cover, versions (a Version picker with thumbs, §22), key −3…+3, guide
singer, backing vocals, duet partner, mystery toggle → "Sing it!". Home: the version on now with
thumbs up / down.
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

**Skins** — `appearance: { theme: 'studio' | 'party', accent: '' | '#rrggbb' }`, Settings →
Appearance. Studio (default) is midnight navy with one cool teal accent (#2fd3c6) for anything
pressable or live and champagne gold (#e8c07a) for people and moments — Figtree, small radii, no
coloured glows, tracked-capital TV kickers, deep colour-blind-safe game colours, calm singer
colours (a singer stores one of `COLORS`; `singerColor()` draws it as the skin's `--singer-N`);
Party is the original neon look. `accent` overrides the skin's accent (`--neon`) in either skin; text on it (`--neon-ink`)
is near-black or white, whichever has the higher WCAG contrast (a skin's own accent keeps its own
`--neon-ink`). Unknown skin ids in an update are ignored. The server writes `data-theme`
(+ the accent) into every HTML page it serves, so the first paint is right and a page cached
under another skin is never reused (the skin is part of the ETag); host, TV and phones follow
changes live through their state (`appearance`), screens without party state (landing page, PIN
and can't-join screens) check `/api/info` every 2 s. All colours
are CSS tokens per skin in `public/css/base.css` (`:root` = Studio, `[data-theme="party"]`);
JS that needs a colour (QR codes) reads the token. The app icon follows the skin too: every
`<img src="/img/icon.svg">` shows `--app-icon` (Studio: `img/icon-studio.svg`; Party: the
original), and the favicon links and `/favicon.ico` point at the skin's icon. Settings saved before skins existed: a custom
`display.accent` became `appearance.accent`, the old default pink was dropped.

**Lyrics on the TV** — `display.lyricsLayout` (`page` | `lines` | `scroll`, §9.6),
`display.lyricsLook` (`panel` | `clear` | `disc`), `display.lyricsMotion`
(`smooth` | `disc`), `display.cdgSmoothing`, `display.lighterEffects` (`auto` | `on` | `off`), §9.5.
A value not on its list is ignored in an update and reset to the default in a saved file; the old
`display.cdgTransparent: false` became `lyricsLook: 'disc'`.

## 15. Persistence (`data/`, git-ignored)
`settings.json`, `secret.json`, `library.json` (catalog cache), `state.json` (party state),
`history.jsonl`, `meta.json` (artwork/metadata), `vocals.json` (what the TV found in each
track's channels, §21), `versions.json` (plays and votes per version, never reset — §22), `art/` (images), `photos/` (guest uploads),
`server.json` (while running: pid, port — one server per data folder). The desktop app's data
folder is `~/.config/OpenKaraoke/data`.

## 16. Security & privacy
LAN only by default (binds 0.0.0.0 so phones can connect). Host actions need localhost or PIN
token; displays need localhost or pairing; guests limited by role checks and rate limits;
uploads size-limited and re-encoded client-side; directory listing only for host and only
folders; media endpoints only serve files that are indexed tracks (never arbitrary paths).
No telemetry. Outbound traffic only to the artwork providers (can be disabled) and, in the
desktop app, GitHub's API for updates (can be switched off in Settings → About; a token for a
private repository is kept in `updates.json`, mode 0600, and only sent to GitHub's API).

## 17. Testing
- Unit (node:test): parser table, catalog grouping/search, scanner/zip fixtures, rotation
  ordering, ETA, limits, quiz scoring/distractors, battle brackets, auth tokens, settings.
- CDG: generate a synthetic CDG in a test (tile writes, colour tables, scroll) and assert the
  framebuffer; also decode a real `.cdg` from the drive when available (local only).
- Readable lyrics (§9.5): archetype discs for the readable palette, keying, roles and the scroll
  timeline (`test/lyrics.test.js`), the frame clock, and `test/e2e/lyrics.mjs` on the TV (no filter,
  overlays clear of the lyric box at seven screen sizes, a light disc at 7:1, a glide without a
  decoder replay, fill/border strips keyed, the disc look, lighter effects, mirror and preview).
  On a real library: `node scripts/lyrics-check.js "<drive>"` (contact sheets to look through).
- Lyric layouts (§9.6): `test/lyric-lines.test.js` on discs in real discs' styles
  (`test/lyric-discs.js`) and the demo library; `test/e2e/layouts.mjs` records every frame on the
  TV and checks it against the plan (readable, not jittery, not confusing — see §9.6).
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
- ✅ **M7 Polish**: break music/autoplay, photos, mirrors & pairing, printable songbook/QR card,
  systemd service, playlists, duet invitations, co-hosts, host preview. Still open: README
  screenshots, a performance pass on the real library.
- ✅ **Skins** (owner request): Studio (default, professional) and Party (the original look),
  Settings → Appearance (§14).
- ✅ **Desktop app** (owner request): Linux AppImage/.rpm/.deb with the TV display as a window
  on the second screen, default port 6527 with a free-port fallback, and updates from the
  repository's releases (published by `.github/workflows/desktop.yml` for every change on main).
- ✅ **M5b Party hotspot** (owner request): the PC opens its own Wi-Fi through NetworkManager;
  two QR codes (join the Wi-Fi, then open the party); checks and an automatic fallback to the
  home Wi-Fi (§20). Built and tested against a fake NetworkManager; the owner checklist
  (§20.11) needs the PC.

## 19. Open questions for the owner
- Host PIN default: none (localhost-only host) — OK?
- Default label preference order for versions (e.g. SF → Zoom → Sound Choice)?
- Should explicit songs be hidden from guests by default?
- Break music source: library instrumentals (default) or a music folder?

## 20. M5b — Party hotspot

> The owner's HOTSPOT_PLAN.md did not reach the build session (the message said it was
> attached, but no file came with it). This section is rebuilt from the owner's description,
> keeping its numbering (§1 … §11 below are §20.1 … §20.11), and every item marked "(check)"
> was checked against the code; where the code differs, the code wins and the difference is
> written next to the item ("Code: …"). If the original plan turns up, reconcile it with this.

### 20.1 What it is
The karaoke PC creates its own Wi-Fi hotspot through NetworkManager (`nmcli`), so guests do
not need to be on the home Wi-Fi (or the home Wi-Fi blocks phones from seeing each other —
"client isolation" in many routers and every guest network). When the hotspot is on, the
invite dialog and the TV lobby show **two QR codes**: **1 · Join the Wi-Fi** (a `WIFI:`
payload) and **2 · Open the party** (the usual join QR, pointing at the hotspot address).
When it is off — or when it can't be used — everything works as before ("same Wi-Fi mode").

### 20.2 What the host sees
- Settings → Party → **Party hotspot**: a switch, the network name (default
  `OpenKaraoke-<ROOM>`), a password (generated, 12 characters, can be changed or regenerated;
  8–63 characters, WPA2), the band (Automatic / 2.4 GHz / 5 GHz — NetworkManager's
  "Automatic" access point is always on a 2.4 GHz channel, so the page says so) and, on a PC with several
  Wi-Fi adapters, which one. A status line ("On: OpenKaraoke-ABCD at 10.42.0.1") and the
  list of checks (§20.4) with ✓ / ⚠ / ✗ and the fix for each problem; **Try again**.
- Invite dialog and TV lobby: two steps with two QR codes while the hotspot is on, the
  network name and password in text under step 1 (people type it on laptops).
- When the hotspot can't start or drops during the party: a banner on the host page with the
  reason and the fix, a toast, and **Try again**; the TV and the invite go back to the one
  QR code of the home network (§20.5).
- The switch is remembered: with it on, the hotspot starts again with the next start of
  OpenKaraoke (with the same checks).

### 20.3 How it is built
- `server/net/nmcli.js` — how to talk to NetworkManager: `nmcli` (and `firewall-cmd --state`)
  are called **only** through `child_process.execFile` (never a shell), with `LC_ALL=C`, terse
  output (`-t` / `-g`), a timeout and an output limit. A *runner* `(cmd, args) → { code,
  stdout, stderr }` is injected. Changed after the check: `createApp()` has **no** runner of its
  own (NetworkManager is never asked: tests and `npm run e2e` call it directly and are not all
  under `node --test`); only `server/start.js` (the CLI and the desktop app) gives the real one
  — or the fake with `OPENKARAOKE_FAKE_NMCLI=<scenario>` (if the fake can't be loaded, e.g. a
  packaged app, no NetworkManager at all, never the real one), or another program with
  `OPENKARAOKE_NMCLI=<path>` — and the real one also refuses under `node --test`. The desktop
  test goes through `startServer` and sets `OPENKARAOKE_FAKE_NMCLI=ok`; `test/start.test.js`
  passes a fake runner. Parsers for terse output (`\:` escapes, `[n]` lists) are pure functions.
- `server/net/hotspot.js` — `Hotspot` (EventEmitter): `start()` runs the checks (§20.4),
  creates or updates the NetworkManager connection `OpenKaraoke hotspot` (802-11-wireless
  mode `ap`, `ipv4.method shared` — NetworkManager gives phones addresses (DHCP/DNS) and
  shares this PC's internet when it has some), brings it up, reads its IPv4 address, checks
  that this server answers there (`/api/health`), and from then on watches it (every 5 s);
  `stop()` brings it down (NetworkManager then reconnects the home Wi-Fi by itself). States:
  `off` → `starting` → `on` | `failed`; `on` → `failed` when it drops; `stopping` → `off`.
  The connection: `autoconnect no` (never up at boot without OpenKaraoke), a fixed
  `ipv4.addresses 10.42.0.1/24` (printed QR cards stay right), `ipv6.method disabled`, WPA2
  (`rsn`, `ccmp`, no PMF — like GNOME's own hotspot) and `802-11-wireless.ap-isolation yes`
  (phones can't reach each other; NetworkManager < 1.28 rejects it: retried without, ⚠). One
  start or stop at a time. Changed after the review: **ownership by UUID** — the UUID that
  `connection add` printed is kept in `data/hotspot.json` (one server per data folder), and only
  that profile is ever brought down or deleted (off, quit, a drop, the start-up clean-up after a
  crash). A party hotspot of another OpenKaraoke on the same PC (another data folder) is never
  touched; unused same-name profiles are tidied at the next start. Quitting waits at most 4 s;
  a start still under way (a password prompt, a slow `up`) is cancelled by deleting its profile.
  A watcher that gives up removes what is left of it ("failed" means off).
- **App wiring (check).** Code: `createApp()` in `server/app.js` builds settings, auth,
  library, artwork, router, hub and room, and `app.closers` closes them; the hotspot service
  is created there too (`app.hotspot`, with an optional injected runner for tests and the
  desktop app's in-process server), closed on shutdown (brought down if this process brought
  it up), and its state changes make the room broadcast.
- **Join URL (check).** Code: `app.info()` computes `baseUrl = server.publicUrl || lanUrls[0]
  || http://localhost:<port>` and `joinUrl = <baseUrl>/j/<ROOM>` on every call; the TV lobby,
  the invite dialog, the queue board and the songbook all use `info.joinUrl`. In hotspot mode
  `baseUrl` becomes `http://<hotspot address>:<port>` — the only address phones on the hotspot
  can reach — even when `server.publicUrl` is set (that one names the home network); `info`
  also gets `mode: 'hotspot' | 'lan'`. Code: `GET /api/info` returns `app.info()` to anyone and
  the TV and guests get `publicInfo()` (name, room code, join URL only), so the hotspot's name,
  password and Wi-Fi QR are **not** in `info`: they are in the host view's `hotspot` and the TV
  view's `hotspot` only. More places show the join QR than listed first — the TV's corner QR
  during songs, the quiz's join corner, the queue board, the landing page, the songbook — and
  all of them re-render from `info.joinUrl` with the next broadcast.
- **QR encoder (check).** Code: `server/util/qr.js` has `qrSvg()` (vendored qrcode-generator,
  byte mode, UTF-8) and `wifiPayload({ ssid, password, security, hidden })` with the standard
  escapes (`\ ; , : "`); `/api/qr.svg?text=` renders any text for the pages. The hotspot QR
  reuses both (security `WPA`).
- **Settings (check).** Code: `DEFAULT_SETTINGS` in `server/config.js` is the schema —
  `Settings.update()` drops unknown keys and coerces types; `party.wifi` (the home Wi-Fi QR on
  the TV) already exists and its password is masked in views (`MASK`) and ignored when sent
  back masked. New: `party.hotspot: { enabled: false, ssid: '', password: '', band: 'auto',
  ifname: '' }`; the password is masked the same way; the room validates the values (§20.6)
  before saving. In hotspot mode the TV shows the hotspot's Wi-Fi QR instead of `party.wifi`'s.
- **Health endpoint (check).** Code: there was none. New: `GET /api/health` →
  `{ ok: true, version, instance }` (`instance` = random per process, nothing secret) — the
  hotspot's own reachability check, and handy for the owner (`curl http://10.42.0.1:6527/api/health`).
- **Listening address (check).** Code: `server.host` defaults to `0.0.0.0`
  (`listenAddress()` in config.js), but `--host` is never saved to the settings — so check 8
  reads the address the server is really bound to (`app.server.address()`), not the setting.
  Bound to one address (or loopback) phones on the hotspot can't reach it: blocking check.

### 20.4 Checks when the hotspot is switched on
Blocking (✗: the hotspot is not used, §20.5) unless marked ⚠ (a warning shown with its fix):
1. **Linux** (NetworkManager) — otherwise "The party hotspot needs Linux with NetworkManager."
2. **nmcli is installed** — fix: "Install NetworkManager (`sudo apt install network-manager`
   / `sudo dnf install NetworkManager`), or use the home Wi-Fi."
3. **NetworkManager is running** (`nmcli -t -f RUNNING general`) — fix: `sudo systemctl start
   NetworkManager`.
4. **Allowed to change the network** (`nmcli -t -f PERMISSION,VALUE general permissions`:
   `org.freedesktop.NetworkManager.network-control`, `settings.modify.system` and
   `wifi.share.protected` are `yes`, or `auth` = a password prompt: ⚠) — `no`: "This user may
   not change the network or share a Wi-Fi hotspot: run OpenKaraoke as the desktop user (not
   over SSH or as a service of another user)." (The systemd user service of
   `bin/install-service.sh` runs outside the desktop session: no password prompt can appear
   there, so it needs `yes`.) Changed after checking real nmcli (1.46/1.48): sharing a WPA
   hotspot also needs `wifi.share.protected`, which stock polkit gives only to the active
   desktop session (`yes`/`no`, never `auth`) — without it `up` fails with "Not authorized to
   share connections via wifi." The prompt comes on `connection delete`/`add` (not `up`), and
   NetworkManager's D-Bus calls give up after 25 s whatever `--wait` says, so the fix says
   "give it within about 20 seconds" (no longer wait 90 s).
5. **Wi-Fi is switched on** (`nmcli -t -f WIFI radio`) — fix: "Switch Wi-Fi on (top-right
   menu) — flight mode off."
6. **A Wi-Fi adapter** (`nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device`; the chosen one,
   else the first `wifi` device neither `unavailable` nor `unmanaged`) — fix: "Plug in a USB
   Wi-Fi adapter." An `unmanaged` adapter (NetworkManager's `unmanaged-devices`) fails with
   its own fix (`up` would say "device is strictly unmanaged").
7. **The adapter can be a hotspot** (`nmcli -g WIFI-PROPERTIES.AP device show <dev>` = `yes`;
   `-g` prints the bare value) — fix: "This Wi-Fi adapter can't be a hotspot; a USB adapter
   that supports AP mode can."
8. **This server listens on every address** (`server.host` is `0.0.0.0` / `::`) — fix: start
   without `--host`, or with `--host 0.0.0.0`.
9. ⚠ **Another hotspot** (GNOME's own "Hotspot") runs on the adapter — the party hotspot takes
   its place.
   ⚠ **The home Wi-Fi drops** — the adapter is connected to a Wi-Fi network and there is no
   other connection (Ethernet): "This PC leaves <SSID> while the hotspot is on: no internet
   for new song covers and updates until it is off. Ethernet keeps both."
10. **The hotspot came up** (`nmcli connection up` succeeded within 30 s) — the reason
    NetworkManager gave, e.g. "Not authorized" (fix: answer the password prompt / allow it),
    "no secrets" (fix: password), "802.1X supplicant failed", "IP configuration could not be
    reserved" (fix: `sudo apt install dnsmasq-base` — NetworkManager's shared mode needs it).
    The old profile is deleted first (`delete id` removes every profile of that name); if that
    fails (exit other than 0 or 10, e.g. 7 "Insufficient privileges") the start stops there —
    `add` would succeed with a twin name and `up id` could pick the old profile. `up` uses the
    UUID that `add` printed. On 5 GHz a timeout ("supplicant took too long") gets the fix
    "choose 2.4 GHz" (regulatory limits).
11. **It has an address** (`IP4.ADDRESS` of the device) — fix: "NetworkManager gave the
    hotspot no address: install dnsmasq-base."
12. **This server answers on the hotspot address** — `GET http://<address>:<port>/api/health`
    answered by this process (`instance` matches) within 3 s (no keep-alive). Changed after the
    check: this request goes through `lo`, never through the Wi-Fi or its firewall zone, so it
    does not prove that *phones* get through — ⚠ 13 covers firewalls. Fix: "Another program may
    use this address: restart OpenKaraoke."
13. ⚠ **Firewall** — `firewall-cmd --state` = running (Fedora): "If phones can't open the
    party: `sudo firewall-cmd --zone=nm-shared --add-port=<port>/tcp --permanent && sudo
    firewall-cmd --reload`"; `ufw` installed and its `/etc/ufw/ufw.conf` says `ENABLED=yes`
    (Ubuntu): "`sudo ufw allow in on <device> to any port <port> proto tcp`". (Checked from
    files and the non-root `--state`; never run as root.)
Checks 1–8 run before anything changes; a ✗ stops there. 10–12 run after `up`; a ✗ brings the
hotspot down again.

### 20.5 Fallback
- A ✗ during `start()`, the connection going down, the adapter disconnecting or losing its
  address while the party runs (the watcher, every 5 s, two misses in a row) → state `failed`
  with `{ check, reason, fix }`; `info.mode` goes back to `lan`, so the join URL, the TV lobby
  and the invite dialog switch to the home-network QR at once (one broadcast). The host gets a
  toast and a banner with the reason and the fix, and **Try again**.
- The setting stays on (the owner's choice); the next start (or Try again) tries again.
- Hosts follow every check as it runs (a `{ t: 'hotspot' }` message to hosts only); every
  screen gets one broadcast when the hotspot comes or goes (`info.mode`/`joinUrl` change).
- The hotspot's phones and screens can't be reached any more: their connections are closed at
  once (a paired TV on it pauses the song, as when any TV leaves) instead of at the next
  heartbeat (20–40 s). Connections of this computer stay.
- The home network's address comes back some seconds after a drop or stop (NetworkManager
  reconnects the Wi-Fi): for a minute the server looks for it every 5 s and broadcasts the new
  join link when it appears (until then it can be `localhost` on a Wi-Fi-only PC).
- Switching it off, quitting OpenKaraoke: the connection is brought down if this process
  brought it up (a hotspot the owner started by hand in GNOME is left alone and not used).
- Guests already on the hotspot when it drops lose the connection; their phones rejoin the
  home Wi-Fi on their own and the home QR on the TV gets them back in. Changed after the check:
  they come back as **new** guests — the device token lives in the page's storage, and
  `http://10.42.0.1:<port>` and `http://192.168.x.y:<port>` are different origins (the same for
  a remote host's PIN login and a paired screen's pairing). Their queued songs stay in the
  rotation under the old name. A hand-over (the guest page finding the home address and taking
  its token along) is possible later; not built.

### 20.6 Security
- Nothing about who may do what changes: guests on the hotspot are guests, the host is this
  computer or someone with the PIN.
- **Host header (check).** Code: `isTrustedHostHeader()` accepts any IP literal (no DNS
  rebinding possible), so `10.42.0.1:<port>` is accepted. Test: guests on that Host join.
- **Origin (check).** Code: `isTrustedOrigin()` accepts this computer's names and its own
  addresses (read from the network interfaces at every call). The hotspot address is ours,
  and is also added to the trusted names while the hotspot is on (`auth.extraNames()`), so a
  page from `http://10.42.0.1:<port>` may use the WebSocket and POST; any other origin —
  another site, another hotspot client's address — is refused (403 / no upgrade). Tests.
- **Host role (check).** Code: `Auth.isHost()` trusts `isLocalAddress(ip)` (when
  `party.trustLocalhost` is on) — loopback and this computer's own addresses only — and a TV
  skips pairing only when `client.isLocal`. A phone on the hotspot (`10.42.0.x`) is not local:
  no host rights without the PIN and no TV without pairing, whatever Host/Origin it sends.
  NetworkManager's shared mode never NATs traffic *to* this PC (only forwarded traffic leaving
  through the uplink), so phones keep their own addresses (per-IP rate limits stay meaningful),
  and a forged source address of this PC is dropped by Linux as a martian. Tests over real
  sockets with forged peer addresses and a mocked interface table.
- Plain HTTP on a WPA2 network whose password is on the TV: anyone on the hotspot can read the
  others' traffic (the PIN, host and pairing tokens). Client isolation stops spoofing between
  phones; still, while the hotspot is on the host should use the PC rather than a phone with
  the PIN (said in the owner checklist).
- With an Ethernet uplink, shared mode lets the phones reach the home network (router, NAS,
  printers) through this PC's address. The app doesn't touch the firewall (that needs root);
  said in the uplink check and the owner checklist.
- Who may switch it: every host (this computer, or someone with the PIN) — not co-hosts. A
  remote host on the home Wi-Fi switching it on can cut itself off on a Wi-Fi-only PC: the UI
  says so before.
- `nmcli` gets every value as its own argument (`execFile`, no shell); the name (1–32 bytes,
  no control characters, not starting with `-`), password (8–63 printable ASCII), band
  (`auto | bg | a`) and adapter (`[A-Za-z0-9_.-]{1,15}`) are validated before. The password is
  on `nmcli`'s command line for a moment (visible to other local users in `ps`) — acceptable
  for a party password that is shown on the TV anyway.
- The password goes to the host and TV views only (the QR), masked in settings views like
  `party.wifi.password`; guests never get it.

### 20.7 Tests
- `scripts/fake-nmcli.mjs` — a fake `nmcli` (the commands the app uses, terse output, exit
  codes, NetworkManager's error texts) driven by a scenario: `ok`, `home-wifi` (⚠ 9),
  `gnome-hotspot` (⚠ 9), `auth` (⚠ 4), `no-session` (✗ 4: over SSH, may not share Wi-Fi),
  `no-nmcli`, `nm-stopped`, `no-permission`, `wifi-off`, `no-device`, `unmanaged`, `no-ap`,
  `up-fails`, `no-dnsmasq`, `no-address`, `drops` (goes down after a few watcher polls),
  `firewalld` (⚠ 13), `old-nm` (no client isolation), `leftover` (a party hotspot still up),
  `delete-fails` (an old profile that can't be removed). Outputs, exit codes and texts were
  checked against a real nmcli 1.46 (no Wi-Fi: the access-point paths from the 1.46/1.48
  sources). Usable in-process (`fakeNmcli(scenario)` → runner;
  `OPENKARAOKE_FAKE_NMCLI=<scenario>` for trying the UI by hand) and as a program
  (`OPENKARAOKE_NMCLI=scripts/fake-nmcli.mjs`, scenario in `FAKE_NMCLI_SCENARIO`, state kept
  between runs in `FAKE_NMCLI_STATE`).
- Files: `test/hotspot.test.js` (runner, parsers, the service against every scenario, the app
  wiring) and `test/hotspot-security.test.js` (§20.6 over real HTTP/WebSocket: the server's
  sockets get forged peer addresses, `os.networkInterfaces()` is a fixed table).
- Unit: parsers, every scenario's checks/state/fix, fallback on drop, stop/close, argument
  validation (nothing reaches the runner), the default runner refusing to run under tests.
- Integration: `createApp({ hotspot: { run } })` → `info()` in both modes, room views (host gets
  checks and the QR, TV the QR, guests nothing), settings masking, `/api/health`; security
  (§20.6) over real HTTP/WebSocket with forged Host/Origin headers.
- e2e: the invite dialog and the TV lobby show both QR codes while on and one after the drop;
  the host's banner and Try again; Settings block.
- **Never** the real `nmcli` in tests.

### 20.8 Protocol
- Host actions: `hotspot.set { on }`, `hotspot.config { ssid?, password?, band?, ifname? }`
  (validated; regenerate = `password: ''` → a new one), `hotspot.retry`.
- Host view: `hotspot { enabled, state, ssid, password (shown to the host), band, ifname,
  address, device (in use), devices[], checks[{ id, level: ok|warn|fail, text, fix }], reason,
  fix, tv: { ssid, password, qr } | null }`; TV view: `hotspot { ssid, password, qr } | null`
  (only while on); guest view: nothing.
- `info.mode`, `info.joinUrl` as above. `GET /api/health`.

### 20.9 UI
- Settings → Party: the Party hotspot block (§20.2) above the home Wi-Fi fields.
- Invite dialog: "1 · Join the Wi-Fi" (QR, name, password) and "2 · Open the party" (QR,
  address, room code) side by side, stacked on phones; the printable card gets both.
- TV lobby: the two steps instead of the one QR (legible from across the room; both skins).
- Host page: a warning banner while `failed` (reason, fix, Try again, Turn off).

### 20.10 Build order (commit + push after each green step)
1. This section; `/api/health`; `server/net/nmcli.js` (runner + parsers) and
   `scripts/fake-nmcli.mjs`; unit tests.
2. `server/net/hotspot.js`: checks, start/stop, watcher, fallback; scenario tests.
3. App wiring: settings, `info()` mode and join URL, trusted names, room actions and views,
   shutdown; security tests (§20.6).
4. UI: Settings block, invite dialog and TV lobby with two QR codes, host banner; e2e.
5. Docs: HANDOFF (TL;DR, decisions, the owner checklist §20.11), README.

### 20.11 Owner checklist
1. Settings → Party → Party hotspot → switch on. A password prompt may appear (polkit):
   allow it. Every check ✓ (or ⚠ with a fix you are fine with).
2. Phone: scan **1** on the TV — it joins `OpenKaraoke-…`; scan **2** — the party opens. An
   iPhone and an Android phone. Request a song, react, play a game round.
3. A PC on Wi-Fi only: it leaves the home Wi-Fi while the hotspot is on (⚠ 9) and reconnects
   when it is switched off. With Ethernet: the phones get internet through the PC.
4. Fedora/Ubuntu firewall: if phones can't open step 2, apply the fix shown (⚠ 13).
5. Pull the plug: `nmcli connection down "OpenKaraoke hotspot"` in a terminal during a song —
   within ~10 s the TV shows the home-network QR and the host page says why; Try again.
6. Quit OpenKaraoke with the hotspot on: it goes off and the home Wi-Fi comes back.
7. 2.4 GHz vs 5 GHz: older phones may only see 2.4 GHz.
8. On a PC with Wi-Fi only the hotspot has no internet: Android asks "This network has no
   internet access. Stay connected?" — guests answer **Yes** (else the phone may keep using
   mobile data and can't open step 2).
9. While the hotspot is on, run the host controls on the PC itself rather than a phone with the
   PIN (everyone on the hotspot knows its password). With Ethernet, phones on the hotspot can
   reach the home network through the PC.
10. Started as the systemd user service (`bin/install-service.sh`): the hotspot needs the
    permission without a password prompt (check 4 says so if not).

## 21. Lead and backing vocals

What CD+G karaoke recordings really allow — no source separation, nothing invented:

- **Lead vocal** (the original singer, a "guide"): on a **multiplex** (MPX) track one channel is
  the music alone and the other the music plus the singer. With the singer's channel X = a·M + V
  and the music channel Y = M, both speakers get c·Y + g·X with g = (lead/100)² and c = 1 − g·a,
  i.e. **M + g·V**: every level from off to full is exact and the music never changes (also for a
  channel recorded at another level or inverted, a ∈ [−2, 2]). Singer on L → matrix
  [g, c, g, c]; on R → [c, g, c, g] (`[L→L, R→L, L→R, R→R]`). `shared/vocals.js mixMatrix()`.
  Off = the music channel on both speakers (what the old "Left/Right only" channel mode did).
- **Backing vocals** are mixed into the music on both channels: only **another version** of the
  song changes them (file-name flags `bgv` "with backing vocals", `nobgv` "no backing vocals").
- "Con Voz" / "with vocals" versions (flag `vocals`, not MPX) have the singer in the stereo mix:
  shown as such, no level.

**Finding the singer's side.** The TV analyses each decoded track (it decodes it anyway;
`analyseChannelsAsync`, in 2 s chunks so the lyrics keep drawing): least-squares fit X ≈ a·Y for
both sides, then the residual X − a·Y relative to the music channel in 0.1 s frames. On a
multiplex track it is silent between the lines and loud while the guide sings; the other side's
never goes quiet. Result `{ l: 'mono'|'stereo'|'mpx', s: 'L'|'R'|'', lean, a, c: 'high'|'low' }`,
sent once per track as `tv.analysis` (main display only; checked field by field; the TV sends
its recent ones again after a reconnect), kept in `data/vocals.json` (≤ 20 000 tracks, the oldest
10 % dropped). `c: 'high'` (a clear gap, quiet moments spread over ≥ 3 of 5 parts of the song) is
kept for the log only. The analysis yields to the page through a MessageChannel every 10 s of
audio (timers would be throttled in a background tab and hold up the song's start).

**What a track allows** (`resolveVocals`, server; `player.vocals` in every view):
1. The host's correction (`player.layout` `auto|stereo|mpxL|mpxR`, kept per track in
   `trackPrefs`) wins.
2. The file name says multiplex and the analysis found the side → **adjustable**.
3. Named multiplex, the analysis only leans one way → adjustable on that side; no lean → the
   host is **asked** which side (until then it plays as before — a wrong guess would play the
   guide singer alone).
4. Not named multiplex (also "Con Voz" / "with vocals" mixes): whatever the analysis found is
   only **suggested** to the host, never used by itself — a hard-panned instrument that rests
   between phrases looks just like a guide singer, and "lead off" would mute it all song long.
   Setting `playback.findGuideVocal` off stops the suggestions.
The music level `a` is fitted for both sides (`aL`, `aR`), so a side set by hand or found by a
lean uses its own measurement (a channel with the singer alone has a ≈ 0).
Versions report `vocals.lead`: `adjustable`, `multiplex` (named, not analysed yet — the TV finds
the side on first play), `mixed` or none (`leadKind`; also a named one whose side the TV couldn't
tell, until the host answers).

**Level** `player.lead` 0–100 (presets off 0 / quiet 50 = −12 dB / full 100). Starts at: chosen
when queued → this singer's last level for the song (`songPrefs.bySinger`, never another
singer's) → `playback.leadVocal` (0). Host and co-hosts: any level. The singer's own phone, on
their own song: guide on (50) or off, rate-limited, setting `queue.guestVocals`. TV shortcut
C / V: off → quiet → full. `player.channel` is refused on an adjustable track ("use Lead vocal").
A battle round is judged: no guide singer (0, refused). Nothing playing → `player.vocals` null.

**Queueing** `queue.add {lead, bgv}`: `pickTrack` prefers a version that fits — a guide singer →
adjustable, else named multiplex; no guide → not one with the singer mixed in; `bgv` → with /
without backing vocals — falling back to the usual version. Guests' `lead` is snapped to 0/50.
`player.version {trackId}` (host) switches the song on to another version of the same song: it
starts again (intro), remembered as the song's version.

**UI.** Host (admin panel → Playback → Sound): "Lead off/quiet/full" instead of the channel mode on an adjustable track,
plus a Vocals button (highlighted when the host is asked or a guide was suggested) → the Vocals
dialog: level slider + presets, which side (correction), backing-vocal and multiplex versions to
switch to. Add/Edit dialogs: Lead vocal (Automatic / Off / Quiet / Full) on songs that have one;
version lists say what each version allows. Guest song sheet: a Guide singer switch (remembered
on the phone) and Backing vocals As recorded / With / Without (when such versions exist); during
their song a "Guide singer: on/off" button. TV intro: "Guide singer on/quiet" chip. Break music
skips multiplex tracks.

## 22. Admin panel, devices, version play counts and votes

**Admin panel** (`public/js/host/panel.js`). The right-hand column has three tabs (remembered,
WAI-ARIA tabs with arrow/Home/End keys); on phones it is the Control page.
- **Queue** (`queue.js`): segments Up next (now-singing card → Playback, drag list, Shuffle,
  Clear) / Requests / Tonight.
- **Playback** (`playback.js`): *Now playing* (singer, song, key/tempo/video pills, status:
  countdown, error + Try again, no TV, sound blocked, a game using the TV; idle: "Start the
  queue", break music + Skip), the **version row** (label, "Sung N times here", Your pick /
  Guests like it / Avoided, thumbs, All versions); on the phone page also the transport, seek and
  volume. *Sound*: Key and Tempo steppers, the channel mode or (multiplex, §21) the Lead control.
  *Video*: the **live preview** (a muted `/tv?display=preview` iframe — only while the tab is
  shown, the page is visible, a main TV is connected and it isn't hidden; "Bigger" moves the same
  element into an overlay, nothing reloads; off by default on phones), which screen plays the
  sound (+ Change → Devices), the desktop app's TV window controls (`okDesktop.tv`: open/close,
  full screen, which screen — native Wayland: the person moves it), and "On the TV" quick settings
  (background, lyrics look, lyrics timing ±2 s, corner QR, announce) saved without a toast.
- **Devices** (`devices.js`): a plain-words summary; screens waiting to pair (Approve/Deny);
  **TV screens** "Main TV" / "Mirror N" / "Queue board N" with where, device, paired, since,
  "Sound blocked", stand-in, **Make main** and **Identify** (`display.identify`: the name big on
  that screen for 6 s); **Host devices** (this computer / phone at IP, browser, "This device");
  **Guests** online (avatar, co-host, songs waiting, browser; menu: co-host, disconnect, remove,
  let back in), offline ones folded. Settings → Displays and the Singers page reuse these rows and
  buttons.
- The preview page is light (`body.preview`): no audio context, 30 fps, no animations or blur; a
  host device other than this computer gets `&video=0` (a cover instead of the music video).
- Device names come from the User-Agent (`server/util/useragent.js`, a fixed list: "Chrome ·
  Android", "LG TV", "OpenKaraoke app"…), computed once per connection, host view only.

**Version play counts and votes** (`server/room/versions.js`, `data/versions.json`
`{ version, backfilled, tracks: { <trackId>: { p, v: { '@host' | deviceId: 1 | -1 } } } }`).
- A completed song (same rule as the song count) adds a play to its version. The first start
  counts the history (`history.jsonl`, streamed; tried again next start when unreadable).
- `version.vote` — guests: a name, not banned, `guests.versionVotes` on, not an explicit version
  under the filter, **heard tonight** (on now or in tonight's history, skipped too — a broken
  version can be voted down), 20 a minute per guest and 120 per 10 min per address; taking one's
  own vote back is always allowed. The host (every host device shares `@host`) votes on anything.
  A co-host votes as a guest. A ban removes that guest's votes. At most 100 guest voters per
  version.
- **Status**: the host's vote settles it (up → liked, down → avoided); otherwise guests' net ≥ +2
  → liked, ≤ −2 → avoided. **The default version** (`bestVersion`, used by every automatic pick:
  requests without a version, playlists, break music, games): liked first, then neither, avoided
  last; within a tier the host's vote, the guests' net (a lone ±1 never changes anything), the
  version used last time, then the label score (`catalog.trackScore`: brand priority, plain, no
  vocal mix…). So a version guests like beats the preferred labels; the host's thumbs down undoes
  it. A picked version and songs already queued are never changed.
- Views: host `current.version` `{ label, count, plays, up, down, mine, host, status }`, guests
  `{ label, count, plays, up, down }` + `me.versionVote`, `rules.versionVotes`; the TV none.


## 23. Installing: one download for any Linux PC

**Goal** (owner, 2026-10-08): one "Windows-style" installer with everything inside — no npm, no
Node.js, no terminal, no extra packages — for any machine, run from a GUI; the server run from
the source code becomes the secondary, advanced way. (The owner's uncle, on Ubuntu 24.04, had
tried the developer route and failed.)

**The download**: `OpenKaraoke-Setup.zip` on every release (no version in its name; the README
links to `releases/latest/download/OpenKaraoke-Setup.zip`). Inside, one file: **Install
OpenKaraoke**, the AppImage, mode 0755 (a browser saves files without the permission to run them;
a zip made "by Unix" keeps it — Files on GNOME unpacks with libarchive, which honours it). Steps:
double-click the zip, double-click "Install OpenKaraoke", Install.

**The AppImage** (electron-builder, `toolsets.appimage: '1.0.3'`): the static type-2 runtime
needs only `fusermount3`/`fusermount` (every desktop distro), not libfuse2; its AppRun adds
`--no-sandbox` only where unprivileged user namespaces are blocked (Ubuntu 24.04 AppArmor).
Electron carries Node and Chromium, so nothing else is needed. The .deb/.rpm stay for whoever
prefers a system package (installed for everyone, with a password).

**The setup** (`desktop/setup.mjs`, `desktop/setup/`; file work in `desktop/install.mjs`):
the app decides at start what it is for (`startMode`): `--uninstall` → uninstall; an AppImage
that isn't the installed copy (not a release's own `OpenKaraoke-<version>.AppImage`, and not
chosen to "run without installing") → the setup window; else the app. `$APPIMAGE` counts only for
the program inside that AppImage (`ownAppImage`). The setup window runs on a throwaway profile, starts no server, and serves
its page through its own `okapp://app` scheme (desktop/setup/, public/, shared/). Pages: Install
(desktop shortcut on, start at login off), Update (older copy installed), Installed (Start /
Install again / Uninstall…), a note when a system package is installed, Installing (progress),
Done (Start OpenKaraoke / Close), Uninstall? (also delete what it saved; "Quit OpenKaraoke for
me" while it is open), Removed, Failed.

**Per-user install** (no password, XDG): `$XDG_DATA_HOME/OpenKaraoke/` (`OpenKaraoke.AppImage`,
`openkaraoke.png`, `install.json`), `$XDG_DATA_HOME/applications/openkaraoke.desktop` (named
after the window's app id; action "Uninstall OpenKaraoke" → `--uninstall`), the desktop shortcut
(`app.getPath('desktop')/OpenKaraoke.desktop`, executable, `metadata::trusted`), optional
`$XDG_CONFIG_HOME/autostart/openkaraoke.desktop`. Entries carry `X-OpenKaraoke-Install=user`; only
those are touched (someone else's file in their place is kept aside and put back). Exec values are quoted and escaped per the Desktop Entry Specification. The
installed copy updates itself (the updater swaps its AppImage) and repairs its entries at start.

**Uninstall** (GUI only, always confirmed in a system dialog or the setup window): the menu
entry's action (this person's copy), Settings → About → Uninstall… (this copy), or the setup
window; removes the program, entries and icon; optionally what it saved, `~/.config/OpenKaraoke`
(settings, playlists, favourites, history, song index, pictures), to the Trash, after the app has
ended — a detached `sh` waits for its pid — and only a folder named OpenKaraoke. A .deb/.rpm is
removed with pkexec + apt-get/dpkg/dnf/zypper/rpm. Not while an update downloads.

**Server mode in the app** (Settings → About, `startup.json`): "Keep the party running when this
window is closed" — closing the host window leaves the server, the TV window and the phones
going; a second start brings the window back; "Quit OpenKaraoke" stops it. "Start OpenKaraoke
when I log in" writes the
autostart entry for however this copy is installed. The source-code server (`node
server/index.js`, `bin/install-service.sh`) is unchanged.

**Tests**: `test/install.test.js`; `desktop/test/setup.mjs` (from the source, and with
`SETUP_APPIMAGE` against the real AppImage — the release workflow does, unzipped from the zip).

**Not covered**: Windows, macOS and arm64 Linux; a system without any FUSE (use the .deb/.rpm).
