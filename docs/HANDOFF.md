# Handoff — where the project stands and what to do next

_Last updated: 2026-09-30 (end of the third build session, run in a cloud sandbox without the
owner's PC or drive). Everything is pushed to GitHub `main`._

## TL;DR
- **M0–M7 are built.** On top of the party-ready M4 version, session 3 added cover art and
  metadata (M5), seven party games plus performance ratings (M6) and the polish list (M7):
  break music, guest photos, remote display pairing, live TV preview, printable songbook,
  systemd service, playlists, duet invitations, co-hosts, queue board, preview on headphones.
- `npm test` → all green (see the table below); `npm run e2e` → 9 Playwright scripts, all green.
- **Nothing in session 3 could touch real hardware or the internet**: the artwork providers were
  unreachable from the sandbox (parsers are tested against fixtures built from the documented
  response shapes), and sound, microphone, TV legibility and phones need the PC. Work through
  the **owner checklist** below before the next party.
- Start as before: `bin/openkaraoke.sh --library "/run/media/ruutu/SMILE-2/<collection folder>"`,
  open `http://localhost:8080/host`, then **Open TV display** (or `bin/open-tv.sh`).
  To start it automatically at login: `bin/install-service.sh --library "…"`.

## What was built in session 3

### M5 — artwork & metadata (PLAN §12)
- `server/artwork/providers.js`: Deezer (search, album → genre/year/label), MusicBrainz +
  Cover Art Archive, TheAudioDB (artist picture, fanart, logo; key `123`), optional iTunes and
  Fanart.tv (own key). Images are stored as compact refs (`dz:…`, `caa:<mbid>`, `tadb:…`) and
  only downloaded from an allow-list of image hosts (no SSRF through provider data).
- `server/artwork/match.js`: cleans karaoke names (credits like `P!nk`, `feat.`, `(Duet)`),
  scores candidates (artist ≥ 0.75, title ≥ 0.7, penalties for karaoke/tribute/live/remix/
  compilations, duration check) and normalises genres.
- `server/artwork/service.js`: one priority queue per provider (**now** = current/next song,
  **visible** = what a screen shows, **crawl** = background), token-bucket throttles with
  back-off (`server/util/throttle.js`), `data/meta.json` (debounced atomic writes),
  `data/art/` image cache with an LRU size limit (`artwork.maxCacheMB`, custom covers are
  pinned), a resumable background crawler (popular songs first) and batched `art` events so
  every screen swaps placeholders for covers as they arrive.
- UI: covers everywhere, artist pages with pictures/logos, genre and decade browsing (host
  Collections, guest chips), Settings → Artwork (progress, ETA, providers, keys, "try songs
  without a cover again"), **Fix artwork** in the song dialog (pick another candidate, "no
  cover", look up again, upload your own picture), TV artist fanart (Ken Burns), idle cover
  mosaic in the lobby, cover/logo/year on the intro card.
- `scripts/artwork-check.js`: live check of every provider — **run it on the PC** (below).

### M6 — party games (PLAN §13), all in `server/games/` + `public/js/games/`
- Framework: `Game` base class (phases with server-time deadlines, per-role views, timers that
  die with the game), one game at a time, "exclusive" games keep songs from starting, games
  can queue or sing songs themselves (`gameQueue`, `gameSing` with snippets that fade out),
  results go into tonight's recap. Host: **Games** page; phones get a Game tab.
- **Crowd poll** "What's next?" (4 songs, phones vote, winner queued).
- **Music quiz** (intro / snippet / name the artist / lyrics peek / cover zoom / helium /
  slow-mo / reverse / decade rounds, speed scoring, streaks, leaderboard, podium). The TV
  plays the clips; phones never receive a clip, a media URL or the answer before the reveal.
- **Battle** (duel, knockout bracket, showcase; same/random/host-picked songs; full, 90 s or
  60 s; phone voting A/B or 1–10; optional judges).
- **Roulette wheel** (songs, singers, dares, genres, duet pairs; drawn on the server, the TV
  animates the spin onto the result; phones only learn it when the wheel stops).
- **Pass the mic** (during songs the TV flashes the next participant; their phone buzzes).
- **Applause meter** (the TV page measures the PC microphone for 5 s → 0–100; kiosk TV started
  with `bin/open-tv.sh` gets the mic without a prompt).
- **Party recap** (totals, top singers, best rated, most-sung artists, crowd favourite, game
  winners; auto-advancing slides).
- **Performance ratings**: after each finished song phones can give 1–5 ★ for 40 s (not for
  their own song); averages show in history and on the singers page.

### M7 — polish (PLAN §18)
- **Break music** (`server/room/breakmusic.js`, `public/js/tv/break-player.js`): quiet backing
  tracks from the library (matching the next song's genre/decade) or a music folder, fading
  out when the next song starts; skip from the host player bar. Optional **autoplay**: when
  the queue stays empty (`playback.whenQueueEmpty = autoplay`), a popular sing-along for
  "Everyone" is queued.
- **Guest photos** (`server/room/photos.js`): phones upload a resized picture, the host
  approves it (Photos page; approval can be turned off), the TV flashes it and can use the
  photos as its background slideshow.
- **Remote display pairing**: a `/tv` on another machine shows a code; the host approves it
  (Settings → Displays lists them and can forget them all, which revokes their tokens).
- **Live TV preview** in the host player bar (a muted mini mirror).
- **Preview on headphones**: play a song on the host computer's second audio output.
- **Printable songbook** (Settings → Library: HTML to print to PDF, or CSV; letter/tag/genre/
  decade/popular filters) — `server/http/songbook.js`.
- **systemd user service**: `bin/install-service.sh` (`--status`, `--uninstall`).
- **Playlists** (host), **duet invitations** (a guest invites a partner, who accepts on their
  phone; the host picks partners directly), **co-hosts** (the host gives a guest the player and
  queue controls), **"In queue" / "Sung tonight" marks** and **"Most sung here"**, **queue board**
  layout for a second screen (`/tv?layout=board`), search result cache + per-phone rate limit.

## What was verified (session 3)
| Check | Result |
| --- | --- |
| Unit + integration tests (`npm test`) | all pass — artwork providers/matching/service against a fake provider network (`test/fake-art.js`, fixtures in `test/fixtures/artwork/`), every game, ratings, photos, pairing, break music, songbook, marks, host-only routes |
| `npm run e2e` (Chromium) | party 20, apps 26, artwork 17, games 13, polish 29, battle 31, quiz 59, wheel 40, party games 39 — all pass; no console errors, no sideways scrolling on phones |
| Provider field names | the sandbox could not reach the APIs (WebFetch and curl were blocked), so the field names were confirmed from the providers' published docs/examples; the fixtures are built from those shapes (`test/fixtures/artwork/README.md`) |
| Independent reviews | M5 review: 36 confirmed findings (≈24 distinct issues); M6/M7 and party-games reviews running — fixes are being merged (this row is updated when they land) |
| Quiz scale | 30 questions from a synthetic 90,000-song catalog in ≈220 ms |

## Owner checklist — needs the PC
0. `cd ~/Projects/karaoke && git pull` (nothing to install; still no runtime npm packages).
1. **Artwork providers, live**: `node scripts/artwork-check.js` — one request per provider,
   what the parsers make of it and which expected fields are missing. If something is missing,
   run `node scripts/artwork-check.js --save /tmp/art-fixtures` and copy the raw responses over
   `test/fixtures/artwork/` (same file names), then commit (or paste the output for the next
   session).
2. Start with the real drive and let the crawler run (Settings → Artwork shows progress and
   ETA). Open a few popular and a few obscure songs: are the covers right? Wrong ones can be
   fixed in the song dialog (Fix artwork); if many are wrong, note examples for the next
   session (match thresholds are in `server/artwork/match.js`).
3. **Real CDGs are still the biggest open risk** (all test CDGs come from our own writer):
   play 2–3 songs from different brands (Sound Choice, Zoom, Sunfly) and check colours,
   highlight wipes and page changes. The quiz "lyrics peek" round and the TV mosaic also use them.
4. **Speakers**: break music volume (Settings → Playback), quiz clips (helium/slow-mo quality,
   clicks at clip edges), wheel ticks and fanfare, fades between break music and songs,
   Bluetooth latency (Settings → Playback → Lyrics timing).
5. **Applause meter**: start the TV with `bin/open-tv.sh` (it passes
   `--use-fake-ui-for-media-stream`, so Chrome uses the default mic without asking). A quiet room
   should read ≈10–25 and loud cheering ≈70–95; otherwise adjust `FLOOR_DB`/`CEIL_DB` in
   `shared/applause.js`. A normal Chrome window asks for the mic once.
6. **TV legibility** from across the room: game screens, pass-the-mic flash, rating card,
   photo flash, queue board (`/tv?layout=board`), intro card with cover/logo.
7. **Phones on the real Wi-Fi**: join, photo upload from an iPhone and an Android phone,
   game answers (latency, early close), duet invitation, vibration (Android only — iPhones get
   the toast). Firewall on Fedora: `sudo firewall-cmd --add-port=8080/tcp` (+ `--permanent`).
8. **Second TV / laptop**: open `http://<PC address>:8080/tv` on it → a pairing code appears →
   approve it in the host. Check it mirrors without sound.
9. **Preview on headphones**: in the song dialog pick the headphone output (Chrome shows the
   device list once it may use audio devices).
10. **Service**: `bin/install-service.sh --library "/run/media/ruutu/SMILE-2/<folder>"`, reboot
    or log out/in, check `bin/install-service.sh --status`.
11. Print the songbook (Settings → Library → Songbook) to PDF once to see page breaks.

## How it fits together (new in session 3)
- `server/app.js` wires `ArtworkService` (`server/artwork/service.js`) next to the library;
  its `art`/`status` events become `{t:'art'}` broadcasts and `{t:'artwork'}` to hosts.
- `server/room/room.js` gained: game lifecycle (`gameStart/gameInput/gameTv/gameEnd/gameClose`,
  `gameBlocks()` holds the queue while an exclusive game runs), ratings, pairing, duet
  invitations, co-host actions (`COHOST_ACTIONS`), playlists, break music (`breakmusic.js`)
  and photos (`photos.js`). Views stay role-specific: the TV gets clips/answers only when it
  needs them, phones never get device ids or answers early.
- Games: `server/games/<type>.js` (server rules) + `public/js/games/<type>.js` (host Setup and
  Control, TV scene/overlay, phone view) + optional `shared/<type>.js` (rules used on both
  sides). Registry: `server/games/index.js` and `public/js/games/index.js`.
- TV: `public/js/tv/main.js` picks the scene (lobby, intro, singing, game scene, board,
  pairing, preview); `controller.js` owns the media clock and lets a game drive key/tempo while
  no song is on (quiz clips); `break-player.js` plays break music on a separate `<audio>`.

## Decisions made in session 3 (and why)
1. **Provider order**: Deezer → MusicBrainz/CAA → iTunes (off by default: its terms don't allow
   caching). Artist graphics from TheAudioDB (free key `123`), Fanart.tv only with your own key.
   Online lookups can be turned off entirely (Settings → Artwork); they are the only outgoing traffic.
2. **Guests can't add other people's names to the queue**: a guest duet is an *invitation*
   the partner accepts on their own phone (keeps the session-2 rule that guests only queue for
   themselves). The host can still pick partners directly.
3. **Co-hosts** get player and queue controls only — never settings, PIN, bans, displays or
   photo moderation.
4. **Remote TVs need host approval** (pairing code); "forget all displays" bumps a token
   version so every paired TV has to pair again.
5. **Game results are drawn on the server** (wheel, quiz answers, battle order) and revealed to
   phones only at the reveal, so a phone's dev tools can't cheat.
6. **The applause meter uses the PC's microphone on the TV page** — phones on plain LAN http
   are not a secure context, so their mics are unavailable.
7. **Break music on by default, autoplay off**: an empty queue shows the lobby unless the host
   chooses autoplay.
8. **Photos need approval by default**, at most 300 are kept (4 MB each, JPEG/PNG/WebP checked
   by their bytes), files live in `data/photos/`.
9. Tests create temp folders through `tmpDir()` (removed on exit) and sparse fake CDGs — the
   sandbox disk filled up with ≈30 GB of leftovers before this was fixed.

## Skins: Studio (default) and Party
- The owner asked for a more professional look as the default while keeping today's one:
  **Settings → Appearance** picks the skin for every screen (host, TV incl. mirrors/preview/
  board/pairing, phones, landing page, games) and an optional accent colour ("Use the skin's
  colour" resets it; text on the accent is dark or white, whichever reads better). Changes show
  live everywhere (screens without a party connection — landing page, PIN and can't-join
  screens — within 2 s; the printable songbook on its next load); guests never see the setting.
- **Studio** (new default, "midnight"): deep navy surfaces, one cool teal accent (#2fd3c6) with a
  warm gold second highlight, Figtree headings, smaller radii, soft shadows instead of glows,
  calm navy/teal TV backgrounds, deep colour-blind-safe quiz colours (wine, blue, ochre, emerald —
  always paired with the shapes) and a navy-and-teal app icon (`public/img/icon-studio.svg`; Party
  keeps the pink one). Its values are the token block at the top of `public/css/base.css`, plus
  two Studio-only rules at the end of that file (lighter answer tints for vote shapes and bars).
- **Party**: the original look, pixel for pixel (checked against a890418 rule by rule and on 47
  screens; `test/themes.test.js` pins the values). Existing parties switch to Studio; a custom
  `display.accent` became `appearance.accent`.
- How: `settings.appearance` → `server/http/shell.js` writes `data-theme` into each served page
  (ETag per skin, no flash) → `public/js/lib/theme.js` follows changes live. Every skin colour is
  a token; never hard-code one. `test/e2e/themes.mjs` saves screenshots of both skins to
  `test-results/e2e-themes/`.
- Owner: look at both skins on the TV from across the room and on a phone.

## Next steps
- Owner checklist above, then a real party. Note anything odd for the next session.
- Remaining P2 items (PLAN §2): singer "confidence monitor" layout, teams/tables, optional
  ffmpeg transcoding for AVI/WMV/MPG, mic monitoring with reverb on the PC.
- README screenshots (the e2e scripts already save screenshots to `test-results/`).
- Performance pass on the real library: catalog rebuild in a worker thread (below), memory
  during the first artwork crawl.

## Known limitations / TODOs
- Catalog rebuild after a rescan with changes blocks the server ≈3–4 s at 90k tracks (the
  TV keeps playing; host/guest UIs pause). Could move to a worker thread.
- Provider parsers are verified against documented shapes only — see checklist item 1.
- Years come from Deezer album release dates (a compilation or remaster can show a later year).
- Video karaoke (MP4/WEBM) is implemented through element mode but untested with real files.
- Phone vibration only works on Android; iPhones get the toast/card only.
- `catalog.js` heap ~200–400 MB while building 90k tracks (unchanged).
- Rotation edge case: after Stop re-queues a song of someone who already sang, a newcomer
  can be placed before an earlier newcomer (manual reordering fixes it).
- `(VR)` annotation meaning still unknown — kept as a version label.

## Starter prompt for the next session
> Read `CLAUDE.md` and `docs/HANDOFF.md`. I ran the owner checklist: <paste notes, e.g. the
> output of `node scripts/artwork-check.js`, wrong covers, CDG problems, applause readings>.
> Fix what I found, keep `npm test` and `npm run e2e` green (if the e2e scripts can't find
> Playwright: `npm i --no-save playwright-core`), update HANDOFF.md and commit + push to `main`.
