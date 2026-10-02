# Handoff — where the project stands and what to do next

_Last updated: 2026-10-02 (end of the third build session plus the desktop app, run in a cloud
sandbox without the owner's PC or drive). Everything is pushed to GitHub `main`._

## TL;DR
- **M0–M7 are built.** On top of the party-ready M4 version, session 3 added cover art and
  metadata (M5), seven party games plus performance ratings (M6) and the polish list (M7):
  break music, guest photos, remote display pairing, live TV preview, printable songbook,
  systemd service, playlists, duet invitations, co-hosts, queue board, preview on headphones.
- `npm test` → 433/433; `npm run e2e` → 14 Playwright scripts, all green (`themes.mjs` checks
  the skins, `hotspot.mjs` the party hotspot, `vocals.mjs` the guide singer, `admin.mjs` and
  `versions.mjs` the admin panel and version votes); `npm --prefix desktop test` → 46/46 (the
  desktop app, also against the built installer). Every milestone also went through an independent review
  whose confirmed findings were fixed and re-verified (table below).
- **Skins** (after session 3): Settings → Appearance switches every screen between **Studio**
  (the new default, midnight navy and teal) and **Party** (the original neon look) — see
  "Skins" below.
- **Desktop app** (after the skins): OpenKaraoke also comes as a Linux app (AppImage, .rpm,
  .deb) with the TV display as a window of its own that opens full screen on the second
  screen, and it **updates itself** from the repository's GitHub releases, which a workflow
  publishes for every change to `main`. The default port is now **6527** (8080 clashed with
  other programs); a busy port moves to the next free one. See "Desktop app" below — the
  repository is private, so the app needs a token to see the releases (explained there).
- **Party hotspot (M5b)**: Settings → Party → **Party hotspot** makes the PC open its own Wi-Fi
  through NetworkManager, so guests don't need the home Wi-Fi. The invite dialog, the TV lobby,
  the corner QR during songs, the queue board, the quiz and the songbook then show **two
  steps**: 1 · join the Wi-Fi (a Wi-Fi QR code, name and password), 2 · open the party. Checks
  run when it is switched on; a failure or a drop during the party falls back to the home
  Wi-Fi by itself and tells the host why and what to do. See "Party hotspot" below — the
  owner's HOTSPOT_PLAN.md never arrived, so PLAN §20 was rebuilt from the request.
- **Lead and backing vocals**: on multiplex tracks the host (and the singer, from their phone)
  turns the original singer off, quiet or full while the music stays as it is; the TV finds
  which channel has the singer by itself. Backing vocals change by switching to a version with
  or without them. See "Lead and backing vocals" below.
- **Admin panel** (after the vocals): the right-hand queue panel is now an admin panel with three
  tabs — **Queue** (up next, requests, tonight), **Playback** (what's on, key/tempo/channels or
  the guide singer, a live TV preview, which screen plays, a few TV settings) and **Devices**
  (TV screens with "Identify" and "Make main", host devices, guests' phones). Phones get a
  "Control" page and a mini player. Each **version** of a song now shows how often it was sung
  here, and guests (on what they heard tonight) and the host vote it up or down: the votes choose
  the default version. See "Admin panel and version votes" below.
- **Nothing in session 3 could touch real hardware or the internet**: the artwork providers were
  unreachable from the sandbox (parsers are tested against fixtures built from the documented
  response shapes), and sound, microphone, TV legibility and phones need the PC. Work through
  the **owner checklist** below before the next party.
- Start as before: `bin/openkaraoke.sh --library "/run/media/ruutu/SMILE-2/<collection folder>"`,
  open `http://localhost:6527/host`, then **Open TV display** (or `bin/open-tv.sh`) — or
  install the desktop app (below).
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
  (Settings → Displays lists them and can forget them all, which revokes their tokens). The
  same page shows which screen plays the sound and lets the host make another one the main
  display; queue boards and mirrors never take the sound by themselves.
- **Live TV preview** (now in the admin panel's Playback tab, a muted light copy of the TV).
- **Preview on headphones**: play a song on the host computer's second audio output.
- **Printable songbook** (Settings → Library: HTML to print to PDF, or CSV; letter/tag/genre/
  decade/popular filters) — `server/http/songbook.js`.
- **systemd user service**: `bin/install-service.sh` (`--status`, `--uninstall`). `--library`
  and `--pin` are saved in the settings once (Settings can change them later); `--port`,
  `--host`, `--data` go in the unit. Running it again restarts the service with the new options;
  it refuses while another copy holds the port. A taken port exits with 78 (not retried).
- **Playlists** (host), **duet invitations** (a guest invites a partner, who accepts on their
  phone; the host picks partners directly), **co-hosts** (the host gives a guest the player and
  queue controls), **"In queue" / "Sung tonight" marks** and **"Most sung here"**, **queue board**
  layout for a second screen (`/tv?layout=board`), search result cache + per-phone rate limit.

## What was verified (session 3)
| Check | Result |
| --- | --- |
| Unit + integration tests (`npm test`) | all pass — artwork providers/matching/service against a fake provider network (`test/fake-art.js`, fixtures in `test/fixtures/artwork/`), every game, ratings, photos, pairing, break music, songbook, marks, host-only routes |
| `npm run e2e` (Chromium) | party 27, apps 34, artwork 37, games 25, polish 95, battle 33, quiz 65, wheel 42, party games 124, themes 127 — all pass; no console errors, no sideways scrolling on phones (measured against the viewport) |
| Provider field names | the sandbox could not reach the APIs (WebFetch and curl were blocked), so the field names were confirmed from the providers' published docs/examples; the fixtures are built from those shapes (`test/fixtures/artwork/README.md`) |
| Independent reviews | Each review ran one reviewer per area (security, state machine, games, TV, UI, operations, performance…), then a second agent tried to refute every finding. M5 (artwork): 36 confirmed (≈24 issues). Last three games: 14 + 1. M6/M7: 53 confirmed (≈35 issues). All fixed with regression tests; every fix was checked again by a fresh verifier (up to three rounds) before it was merged |
| Skins | Party compared with the pre-skins `main` on 112 captured screens (computed style of every element + pixels) after every change: identical apart from the Appearance page and the intended fixes listed under "Skins". Studio: WCAG AA everywhere, 7:1 for TV text (measured over white pictures, the aurora and video frames) |
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
6. **TV legibility** from across the room, in **both skins** (Settings → Appearance): game
   screens, pass-the-mic band, rating card, photo flash, queue board (`/tv?layout=board`),
   intro card with cover/logo. Studio is the default — if you prefer Party as the default for
   your parties, just pick it there (it is remembered).
7. **Phones on the real Wi-Fi**: join, photo upload from an iPhone and an Android phone,
   game answers (latency, early close), duet invitation, vibration (Android only — iPhones get
   the toast). Firewall on Fedora: `sudo firewall-cmd --add-port=6527/tcp` (+ `--permanent`;
   the port the host page shows if 6527 was busy).
8. **Second TV / laptop**: open `http://<PC address>:6527/tv` on it → a pairing code appears →
   approve it in the host. Check it mirrors without sound.
9. **Preview on headphones**: in the song dialog click "Choose headphones…" and pick the
   headphone output (Chrome names the outputs once the page may use the microphone). On a PC
   without a microphone, check the note's route: site settings → Microphone: Allow, after which
   the outputs appear. Never move the system's default output instead — the TV plays on it.
10. **Service**: `bin/install-service.sh --library "/run/media/ruutu/SMILE-2/<folder>"`, reboot
    or log out/in, check `bin/install-service.sh --status`.
11. Print the songbook (Settings → Library → Songbook) to PDF once to see page breaks.
12. **Desktop app** (see "Desktop app" below): install the .rpm from the latest release
    (`sudo dnf install ./openkaraoke-*.x86_64.rpm`) or build it (`npm --prefix desktop install
    && npm --prefix desktop run dist`). With the TV connected as a second screen: **Open TV
    display** → full screen on the TV, sound without a click, the applause meter's microphone
    without a prompt. Plug the TV in after opening the window (it should move there), unplug
    it (it should come back as a window). **GNOME/Wayland (the slowness report)**: the app now
    runs natively on Wayland like Chrome. Settings → About → **Graphics** should say "Hardware
    accelerated"; if it says "Software rendering", press **Copy report** and paste it for the
    next session. Open TV display → the TV window opens maximized where the mouse is → press
    Super+Shift+→ (or drag it to the TV) → it goes full screen on the TV by itself (if both
    screens have the same work area size nothing tells the app: press F11). Compare smoothness
    with the earlier version; if Wayland misbehaves, Settings → About → Display system →
    XWayland (places the TV by itself, restart) and note what changes.
13. **Updates**: in the app, Settings → About → paste a fine-grained token (read-only Contents
    on this repository) → it finds the latest release; after the next push to `main` (and the
    workflow's run, ≈10 min) **Download and install** → the password prompt (rpm) → **Restart
    now**. The data in `~/.config/OpenKaraoke` stays.
14. **Party hotspot**: the checklist at the end of "Party hotspot (M5b)" below.
15. **Lead vocals on real multiplex tracks** (see "Lead and backing vocals" below): play 2–3
    tracks whose names say "Multiplex"/"MPX" from different brands. While the intro runs, the
    Playback tab's Sound section should switch from the channel mode to **Lead off**: you hear
    the music only.
    Pick Quiet and Full — only the singer should come up, the music level should not change. If
    the singer comes up on the wrong side or the music drops, open the Vocals dialog (⋯ next to
    Lead) → "Wrong side…" and fix it (kept for that track), and note the track for the next
    session (`data/vocals.json` has what the TV measured: `l`, `s`, `a`, `c`). Also try one
    ordinary track: it must keep its channel mode (no Lead control unless the dialog suggests a
    guide singer, which is only offered, never used by itself).
16. **Admin panel**: on the party PC, the Playback tab's live preview — is the host window still
    smooth with it on (Graphics in Settings → About)? If not, hide it (remembered). Devices →
    Identify on each screen; a phone's host page (PIN) → Control. Vote a version down from a
    phone after it plays and check the next request of that song gets the other version.

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
8. **Photos need approval by default**: at most 5 waiting per phone, 10 per address, 50 in all
   (a phone with nothing waiting always gets a place); 300 approved/rejected are kept (4 MB each,
   JPEG/PNG/WebP checked by their bytes, uploads checked before their body is read); files live
   in `data/photos/`.
9. Tests create temp folders through `tmpDir()` (removed on exit) and sparse fake CDGs — the
   sandbox disk filled up with ≈30 GB of leftovers before this was fixed.
10. **Skins**: Studio is the default (the owner asked for a more professional look); Party is
    the original look. Studio's design ("Midnight") was chosen by a panel: three designers
    (graphite, midnight, lounge), three judges (brand, accessibility, karaoke host); the losing
    designs are kept on the local branches `studio-graphite` and `studio-lounge` of the
    session's checkout only (not pushed).

## Skins: Studio (default) and Party
- The owner asked for a more professional look as the default while keeping today's one:
  **Settings → Appearance** picks the skin for every screen (host, TV incl. mirrors/preview/
  board/pairing, phones, landing page, games) and an optional accent colour ("Use the skin's
  colour" resets it; text on the accent is dark or white, whichever reads better). Changes show
  live everywhere (screens without a party connection — landing page, PIN and can't-join
  screens — within 2 s; the printable songbook on its next load); guests never see the setting.
- **Studio** (new default, "midnight"): deep navy surfaces (one step lighter per layer), one cool
  teal accent (#2fd3c6) for everything you can press or that is live (buttons, play, progress,
  countdowns, VS, focus), champagne gold (#e8c07a) kept for people and moments (room code,
  "next singer", stars, winners), Figtree throughout (TV headings stay 800 for the far side of the
  room), tracked-capital kickers on the TV ("NEXT SINGER", "UP NEXT"), smaller radii, a machined
  1px top edge on buttons instead of glows, a thin champagne ring around the join QR, a faint
  navy/teal TV aurora (blobs at 0.2 / 0.16, so ink-2 holds 7:1 even where all three overlap),
  covers, artist photos and guests' photos (TV background "photos") at full
  colour behind the TV text, dimmed (brightness 0.4, a 0.65 centre scrim) so it holds 7:1 even over
  a white cover or photo (a guest's new photo still shows bright first, in its frame); panels and
  rows on the TV (up-next chips, the queue board, game results, leaderboards, the recap's rows)
  are a navy surface, never a white wash, which would lift a bright picture under their text
  (highlighted rows a lighter navy), the recap has no accent glow under its slides, the title
  card that slides in while a song starts (over the bottom lyric line) is opaque under all of its
  text and fades out only in its right padding, the ticker is an even band (it lies over a
  video's frame), and so is everything else that crosses the lyrics or a video: the
  pass-the-mic band fades out only within its side padding, a guest's name under a reaction sits
  on a navy chip, and so does a mirror screen's "Mirror display (muted)" (its ticker leaves
  room for it), deep
  game-show quiz colours (wine, royal blue, ochre, emerald — white labels and artist lines 7–11:1
  on the TV, 5.7:1 on ochre; on phones the artist line is at 85%, 4.6:1 or more; four lightness
  steps L* 24/31/37/43 so they differ in grey too, always with the ▲◆●■ shapes) and a 12-colour
  wheel (cobalt first, then pastels, every label 7:1 or more; no pink, the two violet pastels are
  segments 4 and 12) ordered
  so neighbouring segments stay apart for every kind of colour blindness
  (worst pair CIEDE2000 9.0; `test/themes.test.js` checks ≥ 8 for every wheel size, ≥ 10 and
  6 L* between answers, and no pink or purple in the singer colours, answers and first wheel
  segments). Singers' colours: guests pick one of ten; Studio draws them as calm pastels and
  cobalt (`--singer-1…10`; Party shows its neon ones, the stored value is the same). TV text is
  never the faintest ink (`test/themes.test.js` checks the 7:1 cases: white pictures, a white-cover
  mosaic, the aurora, every TV panel's fill and every game screen's own glow over each of them, the
  title card's, the ticker's and the pass-the-mic bands and the reaction and mirror chips over
  white lyrics or video, and that no TV rule in ink-3, a white wash or a translucent black fill
  behind text lacks its Studio counterpart; `test/e2e/themes.mjs` checks the TV screens, and
  measures the lobby, intro and queue board pixel by pixel over a white guest photo and the swept
  aurora, and the title card over the lyrics; `test/e2e/game-party.mjs` keeps the pass-the-mic
  text clear of the band's side padding).
  Disabled buttons go neutral grey, a switch that is
  on has a dark knob, the current bottom tab has a pill behind its icon, losing quiz answers and
  wheel segments turn into quiet navy tiles (7:1 on the TV; the winning segment keeps its colour,
  not lightened) instead of fading, and "TV on" is a
  neutral chip with a green light. App icon: navy tile with a teal mic and sound arcs
  (`public/img/icon-studio.svg`; Party keeps the pink one). Its values are the token block at the
  top of `public/css/base.css`; the few Studio-only rules are scoped
  `:root:not([data-theme="party"])` next to the rule they adjust (grep for it). New tokens
  (`--tv-display-*`, `--kicker-*`, `--raise`, `--switch-knob-on`, `--announce-*`, `--art-scrim`,
  `--photo-filter`, `--r-card`, `--singer-*`) carry Party's old values in the Party block.
- **Party**: the original look, pixel for pixel (checked against `main` at f986733 rule by rule
  and on 112 captured screens, the More page, phone cards, photos, pass-the-mic band, duet
  invitation and rating dock included; `test/themes.test.js` pins the values), apart from a few
  fixes in both skins: the TV intro card's title stops at three lines, so a full card (a duet,
  the logo, Key/Tempo chips, the countdown) keeps the singers' names whole and at full height
  with the status on screen (`test/e2e/artwork.mjs` checks 16:9 and 4:3, counting down and
  waiting, in both skins; the name is fitted again after a skin switch, the two display fonts
  differ in width), three-digit countdowns fit their ring, the phone search box has a short
  placeholder, the host's phone player row fades at the edge where it scrolls (not while the TV
  preview, which sits in that row, is open), the songbook's join address wraps instead of
  running into the QR code, and in the host's Queue → History the time a song was sung has a
  column of its own instead of printing over the singer's name (`test/e2e/themes.mjs` checks a
  desktop and a 360 px phone in both skins).
  Existing parties switch to Studio; a custom `display.accent` became `appearance.accent`.
- How: `settings.appearance` → `server/http/shell.js` writes `data-theme` into each served page
  (ETag per skin, no flash) → `public/js/lib/theme.js` follows changes live. Every skin colour is
  a token; never hard-code one (`test/themes.test.js` fails on any colour with a hue outside the
  two skin blocks, in the CSS, the browser code and the page shells). `test/e2e/themes.mjs`
  saves screenshots of both skins to `test-results/e2e-themes/`.
- Owner: look at both skins on the TV from across the room and on a phone.

## Desktop app (after session 3)
**What**: `desktop/` wraps the same server and pages in Electron (only there: Electron and
electron-builder are dev dependencies of `desktop/package.json`; the server keeps zero runtime
dependencies and still runs with `node server/index.js`).
- `desktop/main.mjs` starts the server in-process (`server/start.js`, shared with
  `server/index.js`), opens the host page in the main window and the TV page in a second
  window: full screen on a screen that isn't the host's (`desktop/displays.mjs`, remembered),
  `autoplayPolicy: no-user-gesture-required` (no "click to start"), microphone allowed for
  the app's own pages (never the camera). A TV plugged in later gets the window; unplugged, it
  comes back. Menu: TV window, move it to the next screen (Ctrl+Shift+T), join link, data
  folder, log file, Check for updates. Links to other sites open in the normal browser; one
  instance at a time; quitting (also logout/SIGTERM) saves the party first. Closing the host
  window quits the app: the TV window closes with it at once (before the party is saved, which
  can take seconds with a big library), so it never lingers on the TV. The TV page is loaded
  from `http://tv.localhost:<port>` (its own origin: Electron keeps zoom per origin, so
  zooming the host window used to zoom the TV too).
- **Graphics / Wayland** (`desktop/graphics.mjs`, Settings → About → Graphics): the owner's
  Electron windows were slow on GNOME while Chrome was smooth. Nothing in the app disabled the
  GPU; the one difference was the restart through XWayland (`--ozone-platform=x11`), which on
  some PCs (NVIDIA on Xwayland 23, software fallback) draws slowly, and software compositing
  makes the TV starve the host window too (one GPU process for both). Now:
  - **Native Wayland by default** (Electron's own default, like Chrome); **XWayland** is a
    choice in Settings → About (saved in `display.json`, applied by a restart;
    `OPENKARAOKE_X11=1` / `OPENKARAOKE_WAYLAND=1` override).
  - On native Wayland the app can't place windows or learn where they are (checked in a
    headless GNOME Shell 46 with two monitors: window positions, `window.screen` and the
    Window Management API's `currentScreen` all stay put). The TV window opens maximized where
    the mouse is, with a hint on it; GNOME resizes a maximized window moved to another screen
    (Super+Shift+→, a drag), and that resize makes it go full screen there. Ctrl+T with the
    mouse on the TV opens it right there (then F11). Verified 13/13 in that GNOME session;
    XWayland still places it by itself (now full screen only after the window is mapped — it
    sometimes stayed a window before).
  - Windows are shown when their page has loaded too: on native Wayland a hidden window never
    paints, so `ready-to-show` never came and the host window never appeared
    (`OPENKARAOKE_WAYLAND=1` had this problem).
  - **Diagnostics**: display system, hardware vs software (GPU feature status from
    `gpu-info-update`, the WebGL renderer — llvmpipe/SwiftShader count as software), graphics
    card and driver, GPU-process crashes, screens, both windows' frame rate, size and zoom;
    **Copy report**, chrome://gpu (also Help menu); one line in the log at start.
  - **Lighter effects** (`.lite-fx` on the pages; Automatic = on when drawing in software):
    still backgrounds, no backdrop blur, a still shade instead of the lyrics' drop-shadow filter.
  - For every PC: the TV writes the music level only on the aurora (it restyled the whole page
    every frame), and the host's seek bar animates only while a song plays.
- Profile: `~/.config/OpenKaraoke` (`data/` = the server's data folder, `logs/openkaraoke.log`,
  `window-state.json`, `updates.json`).
- `desktop/preload.cjs` is the only bridge (`window.okDesktop`: openTv, pickFolder, updates);
  the host page uses it when present (`chooseFolder()`, Open TV display, the update UI).
- **Port**: 6527 by default (a saved 8080 is moved). If the saved port is busy the server
  takes the next free one and saves it; `--port`/`$PORT` stay fixed (exit 78 if busy). One
  server per data folder: `data/server.json` (pid, boot id, port; stale ones are taken over) —
  `bin/open-tv.sh` reads the port from it.
- **Installers**: `npm --prefix desktop run dist` → `desktop/dist/` AppImage, .rpm, .deb
  (`desktop/electron-builder.config.cjs`; the app is unpacked, no asar). The .deb/.rpm install
  to `/opt/OpenKaraoke` with a menu entry; the .deb adds an AppArmor profile (Ubuntu 24.04
  needs one for Electron's sandbox; the AppImage there needs `--no-sandbox`).
- **Updates** (`desktop/updater.mjs`, `desktop/update-logic.mjs`, `public/js/host/updates.js`):
  checks GitHub's latest release 30 s after the start and every 6 h (switch in Settings →
  About) and when asked; a newer version shows a pill in the top bar. **Download and install**:
  an AppImage downloads next to itself and is swapped in; an .rpm/.deb (found by asking the
  package manager who owns the running program) is installed with `pkexec dnf/apt-get` (the
  system's password prompt), or opened in the software centre when there is no prompt. Every
  download is checked against the release's SHA256SUMS and GitHub's digest. **Restart now**
  relaunches the new version with the same options once the party is saved. A copy run from
  the source code only says "git pull".
- **Releases**: `.github/workflows/desktop.yml` runs on every push to `main` that touches the
  app (and by hand): `npm test`, build, the end-to-end test against the built app, SHA256SUMS,
  then a release `v0.1.<run number>` with the commit subjects as notes, marked latest (a draft
  until every file is up). It keeps the 10 newest releases. Bump the version in package.json
  for a new major.minor.
- **Private repository**: GitHub answers 404 for a private repository's releases without
  credentials, so the app shows a token field (Settings → About). A fine-grained personal
  access token with read-only **Contents** on this repository is enough; it is kept in
  `updates.json` (mode 0600), never shown to the pages and only sent to GitHub's API — the
  updater follows download redirects itself so the token never reaches GitHub's file storage
  (Electron's `net.fetch` would forward it, so Node's `fetch` is used). For other people to
  download and update, make the repository public (or publish the releases from a public
  repository) — nothing in the app changes.
- **Tests**: `test/desktop.test.js` (displays, update logic, the updater against a stand-in
  for GitHub: AppImage swap, checksums, token, pkexec paths, redirects) runs in `npm test`;
  `npm --prefix desktop test` drives the real app under Xvfb with two pretend screens
  (`OPENKARAOKE_FAKE_DISPLAYS`) and a stand-in GitHub (`OPENKARAOKE_UPDATE_API`): port
  fallback, TV window placement and sound, microphone, menu, second instance, quit/save, the
  update flow down to the restart. `APP=desktop/dist/linux-unpacked/openkaraoke` tests a build.
- Not testable in the sandbox: a real GPU and two real monitors, pkexec, GNOME's dock grouping —
  checklist items 12–13. (Wayland placement was checked in a headless GNOME Shell, see above.)

## Party hotspot (M5b)
**What** (PLAN §20): the karaoke PC opens its own Wi-Fi through NetworkManager, so guests
don't need the home network (or a router that keeps phones apart). Settings → Party → **Party
hotspot**: a switch, the name (`OpenKaraoke-<ROOM>`, fixed when first switched on), a password
(12 easy characters, made up once; show / change / **New**), the band and, with several Wi-Fi
adapters, which one. While it starts, the checks of PLAN §20.4 appear one by one (✓ / ⚠ / ✗,
each problem with its fix). While it is on, every place that shows the join QR shows two steps
instead: **1 · Join the Wi-Fi** (a `WIFI:` QR code plus the name and password in text) and
**2 · Open the party** (the usual QR, now at `http://10.42.0.1:<port>`) — the invite dialog and
its printed card, the TV lobby, the corner QR during songs, the queue board, the quiz's join
corner, the songbook; the landing page names the Wi-Fi to join first (never the password).
If it can't start or drops during the party (watched every 5 s), it falls back to the home
Wi-Fi by itself: the TV shows the home QR again within seconds, the host gets a toast and a
banner with the reason, the fix, **Try again** and **Turn the hotspot off**. The switch is
remembered: switched on, it starts again with OpenKaraoke (same checks); quitting brings it
down and the home Wi-Fi comes back.

**How it fits together**
- `server/net/nmcli.js` — the only place programs are started: `nmcli` and `firewall-cmd`,
  through `child_process.execFile` (never a shell), every value its own argument and validated
  first, `LC_ALL=C`, timeouts; terse-output parsers; the `connection add` arguments (WPA2/CCMP,
  PMF off, `ipv4.method shared` at a fixed `10.42.0.1/24`, client isolation, `autoconnect no`).
- `server/net/hotspot.js` — the `Hotspot` service: checks, create + bring up, address,
  reachability (`/api/health` answered by this process), watcher, fallback, stop, clean-up of a
  hotspot left up by a crash. One start/stop at a time.
- `server/app.js` / `server/start.js` — `createApp()` gets a runner that never calls nmcli
  unless one is passed; only `startServer()` (CLI and desktop app) passes the real one.
  `info()` gives the hotspot address as the join link while it is on (`mode: 'hotspot'`,
  `wifiName`), never the password. `room.js`: `hotspot.set` / `hotspot.config` /
  `hotspot.retry` (hosts only), live `{ t: 'hotspot' }` progress to hosts, the TV view's
  `hotspot { ssid, password, qr }`, hotspot phones let go at once when it drops.
- `public/js/host/hotspot.js` (Settings block, banner), the invite dialog (`dialogs.js`), the TV
  (`tv/main.js` `JoinSteps`, corner, board), `games/quiz.js`, `index.html`,
  `server/http/songbook.js`.
- Ownership: the hotspot's profile is known by the UUID kept in `data/hotspot.json`; only that
  one is ever taken down or removed (another OpenKaraoke's hotspot on the same PC is left
  alone, a crashed run's is removed at the next start, quitting cancels a start under way).
- Tests: `scripts/fake-nmcli.mjs` is a pretend NetworkManager (20 scenarios, in-process or as
  a program); `test/hotspot.test.js`, `test/hotspot-security.test.js` (real sockets, forged
  peer addresses), `test/e2e/hotspot.mjs` (44 browser checks). The real nmcli is never run in
  tests: `createApp()` has no runner of its own (unit tests and e2e scripts), the real runner
  refuses under `node --test`, `test/start.test.js` passes a fake, and the desktop test sets
  `OPENKARAOKE_FAKE_NMCLI=ok` (a build without the fake then gets no NetworkManager at all).
- Try the UI without Wi-Fi: `OPENKARAOKE_FAKE_NMCLI=ok npm start -- --library demo-library`
  (or any scenario: `wifi-off`, `no-dnsmasq`, `drops`, …).

**Decisions (and why)**
1. **The owner's HOTSPOT_PLAN.md never reached the build session**, so PLAN §20 was rebuilt from
   the request, keeping its numbering (§1–§11 = §20.1–§20.11), and every "(check)" item was
   checked against the code. If the original plan turns up, reconcile it with §20.
2. **Where the plan and the existing design disagreed, the existing behaviour was kept**:
   - The Wi-Fi password and QR are *not* in `info`/`/api/info` (anyone may read those; the plan
     put the QR there) — only in the host view and the TV view; masked in settings views like
     the home Wi-Fi password; guests never get them.
   - The plan said guests keep their identity across a fallback. They can't: the device token
     lives in the page's storage, and `http://10.42.0.1:<port>` and the home address are
     different origins. They come back as new guests (their queued songs stay); a hand-over
     isn't built. The same goes for a phone host's PIN login and a paired screen.
   - The hotspot's settings change only through the `hotspot.*` actions (validated, they start
     and stop it); the generic `settings.update` drops them.
   - `hotspot.set` answers at once and the page follows the checks live (WebSocket requests
     time out after 15 s; a start can take longer).
   - Check 8 ("listens on every address") reads the address the server is actually bound to,
     not a setting (`--host` isn't saved).
   - "One broadcast" on fallback wasn't enough: the home address comes back seconds later, so
     the server looks for it every 5 s for a minute and broadcasts the new join link.
3. **Fixed address `10.42.0.1/24`** (NetworkManager's usual one) so printed cards stay right;
   the name and password are fixed when first switched on (a new room code doesn't rename the
   Wi-Fi under the guests).
4. **Client isolation on** (everyone knows the password: phones reach only the PC); an older
   NetworkManager (< 1.28) runs without it, with a warning.
5. **Checked against a real nmcli** (1.46, in the sandbox without Wi-Fi, plus the 1.46/1.48
   sources): sharing a WPA hotspot needs `wifi.share.protected`, which only the desktop session
   has (checked; the systemd user service outside the session gets ✗ 4 with the fix); a
   password prompt has to be answered within about 20 s (NetworkManager's own limit); the old
   profile must really be deleted and `up` uses the new profile's UUID; NetworkManager's
   "automatic" band is always 2.4 GHz (said so in the page).
6. **Who may switch it**: hosts only (this computer, or a phone with the PIN — not co-hosts). A
   phone host is asked first: on a Wi-Fi-only PC it cuts itself off until it joins the hotspot.
7. Plain HTTP on a network whose password is on the TV: anyone on the hotspot could read the
   others' traffic, so while it is on, run the host controls on the PC itself (checklist 9).
8. **Reviewed adversarially** (security, NetworkManager behaviour, UI, tests/docs; every finding
   checked by a skeptic): 28 confirmed, all fixed — ownership by UUID instead of by name (a
   second OpenKaraoke, e.g. the desktop app next to `npm start`, used to take down the running
   party's hotspot at start-up), quitting during a start, a watcher that gave up without taking
   it down, the desktop test reaching the real nmcli, a name that followed the room code, the
   saved adapter vs the one in use, restarts only when something changed (a failed hotspot
   waits for Try again, where a phone host is asked), the corner codes clear of the lyrics,
   long passwords wrapping, the quiz corner, the landing page following the hotspot, and
   e2e checks that couldn't fail.

**Owner checklist (PLAN §20.11)**
1. Settings → Party → Party hotspot → switch on. A password prompt may appear (polkit):
   allow it within about 20 s. Every check ✓ (or ⚠ with a fix you are fine with).
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

## Lead and backing vocals (after M5b)
**What** (PLAN §21): on a **multiplex** track (the original singer on one channel, the music
alone on the other) the host turns the original singer **off, quiet or full** — exactly, the
music stays as it is (the old way was the channel mode "Right only", which still exists for
other tracks). Backing vocals are in the music on both channels, so they change only by
picking **another version** (named "with/no backing vocals"); the Vocals dialog and the
guests' song sheet offer those versions.
- **Host**: the speaker control (admin panel → Playback → Sound) becomes **Lead off / quiet /
  full** on such a track,
  with a ⋯ button → the **Vocals** dialog (slider, which side, versions to switch to; it lights up
  when the host is asked which side a track named "Multiplex" uses, or when the TV thinks an
  unnamed track is one — only the host can turn that into a Lead control). Add/Edit dialogs have Lead vocal (Automatic / Off / Quiet / Full).
  Settings → Playback: "Guide singer at the start of a song" (off), "Suggest multiplex songs
  found by their sound" (on); Settings → Queue & guests: "Guests can ask for a guide singer" (on).
- **Guests**: the song sheet has a **Guide singer** switch (remembered on the phone) and
  Backing vocals As recorded / With / Without; during their own song a **Guide singer: on/off**
  button. Their choice is on (quiet) or off only.
- **TV**: it finds the singer's side while decoding (nothing extra is read from the drive), tells
  the server once per track (`data/vocals.json`); the intro shows "Guide singer on/quiet"; keys
  C / V step off → quiet → full.
- Code: `shared/vocals.js` (matrix, rules, analysis), `server/room/vocals.js` (store),
  `room.js` (`player.lead/layout/version`, `tv.analysis`, `pickTrack`), `public/js/host/vocals.js`,
  the audio engine's `setMix`. Tests: `test/vocals.test.js`, `test/e2e/vocals.mjs` (the demo's
  "Quiet Storm (Multiplex)": found on the left, the four gains checked at off/quiet/full).

**Decisions**
1. **No source separation** (no AI vocal removal): it would need a model and native code or
   seconds of GPU per song — against the zero-dependency rule — and the library already has what
   karaoke needs: multiplex tracks for the lead, separate versions for backing vocals.
2. **Never a wrong guess on the lead**: a track named Multiplex whose side the analysis can't tell
   plays as before and the host is asked; a track the sound alone suggests is only offered (the
   review found a hard-panned guitar that rests between phrases looks exactly like a guide
   singer: "lead off" would have muted it). A wrong side would play the guide singer on its own.
3. Off by default for every song (`playback.leadVocal` 0) — the usual karaoke — and a singer's
   level is remembered for them only (a guide is a personal need, like the key).
4. "Quiet" is −12 dB (the volume slider's square law), the guest's only "on" level; host and
   co-hosts can set any level. Battle rounds are judged: no guide singer there.

## Admin panel and version votes (after the vocals)
**What** (PLAN §22): the queue panel became an admin panel — Queue / Playback / Devices — and the
player bar is slimmer (what's on, transport, seek, volume, the TV chip; a "Key +1 · 105%" pill
opens the Sound controls). On phones the panel is the **Control** page in the bottom bar and the
player is a mini player (tap it for the full Playback page).
- **Playback**: the live preview is now a part of the tab (no floating box): it runs only while
  the tab is shown and a main TV is connected, "Bigger" shows it large without reloading, Hide is
  remembered; it is a light page (no sound engine, 30 fps, no animations) and a phone or tablet
  gets a cover instead of a music video. "On the TV" has the background, lyrics timing and the
  corner QR at hand. In the desktop app: the TV window's state and buttons (open, full screen,
  which screen; on native Wayland it says how to move it).
- **Devices**: each screen named ("Main TV", "Mirror 1", "Queue board 1") with where it is, its
  browser, since when, whether its sound is blocked; **Identify** shows the name big on that
  screen; **Make main** as before. Host devices ("This device"), guests' phones with their
  browser and a menu (co-host, disconnect, remove). A screen waiting to pair shows here first
  (the top-bar pill opens it).
- **Versions**: every finished song counts a play for its version (`data/versions.json`, kept
  across parties; the history was counted once at the first start). Song details list Sung and
  Votes per version and which one plays by default and why. Guests vote on the version on now
  (Home) and in the song sheet (only versions heard tonight), and can pick a version there.
- **The default-version rule** (decision): a version guests like (two more thumbs up than down)
  plays first — **even over the preferred labels** in Settings → Library; one two votes behind
  plays only when there is no other. **The host's own vote settles it** either way (and every
  host device shares that vote). One guest alone never changes anything. Requests with a chosen
  version and songs already in the queue are never changed. Settings → Queue & guests: "Guests
  can vote on song versions" (on).
- Decisions: the spec (built from a design panel) dropped pinning/resetting versions and a
  "which version?" card; taking one's own vote back is allowed even when the song was not heard
  tonight (it can only remove a vote); the vocals controls sit in the Sound section (the Lead
  control replaces the channel mode on multiplex tracks), not as two "lead/backing" sliders —
  backing vocals change only by version (see above).
- Not in this change: moving votes along when a file is renamed (a new track id starts over);
  live updates of other guests' counts in an open song sheet.
- Code: `public/js/host/panel.js`, `playback.js`, `devices.js`, `menu.js`, `public/js/lib/versions.js`,
  `server/room/versions.js`, `server/util/useragent.js`, room.js (`displayList`, `versionVote`,
  `decorateVersions`, views), the desktop's `okDesktop.tv`. Tests: `test/versions.test.js`,
  `test/version-votes.test.js`, `test/devices.test.js`, `test/e2e/admin.mjs`, `test/e2e/versions.mjs`.

## Next steps
- Owner checklist above, then a real party. Note anything odd for the next session.
- Remaining P2 items (PLAN §2): singer "confidence monitor" layout, teams/tables, optional
  ffmpeg transcoding for AVI/WMV/MPG, mic monitoring with reverb on the PC.
- README screenshots (the e2e scripts already save screenshots to `test-results/`).
- Performance pass on the real library: catalog rebuild in a worker thread (below), memory
  during the first artwork crawl.

## Known limitations / TODOs
- Desktop app: Linux x64 only; no code signing; the AppImage on Ubuntu 24.04 needs
  `--no-sandbox` (or use the .deb). Updates of a private repository need the token (above).
- Catalog rebuild after a rescan with changes blocks the server ≈3–4 s at 90k tracks (the
  TV keeps playing; host/guest UIs pause). Could move to a worker thread.
- Provider parsers are verified against documented shapes only — see checklist item 1.
- Years come from Deezer album release dates (a compilation or remaster can show a later year).
- Video karaoke (MP4/WEBM) is implemented through element mode but untested with real files.
- Phone vibration only works on Android; iPhones get the toast/card only.
- "Preview on headphones" (Song details → Choose headphones…) needs the browser's
  permission once (Chrome: microphone, to name the outputs); check it on the party PC.
- `catalog.js` heap ~200–400 MB while building 90k tracks (unchanged).
- Rotation edge case: after Stop re-queues a song of someone who already sang, a newcomer
  can be placed before an earlier newcomer (manual reordering fixes it).
- `(VR)` annotation meaning still unknown — kept as a version label.

## Starter prompt for the next session
> Read `CLAUDE.md` and `docs/HANDOFF.md`. I ran the owner checklist: <paste notes, e.g. the
> output of `node scripts/artwork-check.js`, wrong covers, CDG problems, applause readings>.
> Fix what I found, keep `npm test`, `npm run e2e` and `npm --prefix desktop test` green (if
> the e2e scripts can't find Playwright: `npm i --no-save playwright-core`), update HANDOFF.md
> and commit + push to `main`.
