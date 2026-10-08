# OpenKaraoke

> From my agentic manager: Hello all, I commissioned this app because I didnt like what was out there for Linux Karaoke support. Made for my Uncle Jim. Thanks

Self-hosted, KaraFun-style karaoke for Linux. It plays your own CDG+MP3 / MP4 karaoke
library (built for large collections — about 90,000 tracks on a USB drive) with:

- **Host app** in the browser: instant typo-tolerant search, artists A–Z, collections,
  queue with fair singer rotation, key change, tempo, favourites, playlists, history,
  the original singer off / quiet / full on multiplex tracks, versions with or without backing vocals
- **TV display on a second screen**: CDG lyrics over cover art / artist fanart / visualisers,
  next-singer cards, ticker, reactions
- **QR-code guest lobby**: guests scan the code on the TV and request songs from their phones
- **Cover art & artist graphics** matched from Deezer, MusicBrainz/Cover Art Archive and
  TheAudioDB, cached locally
- **Party games**: singing battles with audience voting, a music quiz, roulette wheel, polls,
  pass-the-mic and more
- **Party hotspot**: no shared Wi-Fi? The PC opens its own (through NetworkManager) and the TV
  shows two QR codes — join the Wi-Fi, then open the party
- **Two skins**: a calm, professional **Studio** look (the default) and the original neon
  **Party** look — switch every screen at once in Settings → Appearance

Everything runs on your PC — no cloud, no accounts.

## Install — one download, no terminal

**[⬇ Download OpenKaraoke for Linux](https://github.com/blearymoth/OpenKaraoke/releases/latest/download/OpenKaraoke-Setup.zip)**
(`OpenKaraoke-Setup.zip`, about 120 MB)

Everything OpenKaraoke needs is inside that one file. You don't need npm, Node.js, a terminal
or anything else. It works on any 64-bit Linux PC: Ubuntu, Linux Mint, Fedora, Debian, Pop!_OS,
Zorin, openSUSE and others.

1. Open your **Downloads** folder and **double-click `OpenKaraoke-Setup.zip`**. A file called
   **Install OpenKaraoke** appears next to it.
2. **Double-click Install OpenKaraoke** and click **Install**. It installs just for you, so it
   doesn't ask for a password. It adds OpenKaraoke to your applications menu and puts an icon on
   your desktop.
3. Click **Start OpenKaraoke**. Later, start it from the applications menu or the desktop icon.
   The first time, choose the folder with your karaoke songs, for example on your USB drive.

You can delete the zip and “Install OpenKaraoke” afterwards, or keep them to install OpenKaraoke
on another computer.

**Using it.** **Open TV display** opens the TV window full screen on the second screen (the
TV), with sound and the microphone (for the applause meter) allowed. Connect the TV first, or
later: the window moves there by itself. Guests scan the QR code on the TV with their phones
(same Wi-Fi, or the PC's own party hotspot, below).

**Updates.** OpenKaraoke checks for new versions by itself and installs one when you say so
(Settings → About, or Help › Check for updates…). Then click **Restart now**.

**Uninstall.** Right-click OpenKaraoke in the applications menu and choose **Uninstall
OpenKaraoke**, or use Settings → About → **Uninstall…** in the app. Your songs are never
touched. What OpenKaraoke saved (settings, playlists, favourites, history, song index, pictures)
stays in `~/.config/OpenKaraoke`, unless you tick “Also delete what OpenKaraoke saved”: then it
goes to the Trash.

**Run OpenKaraoke like a server.** Settings → About → **Start OpenKaraoke when I log in** and
**Keep the party running when this window is closed**: the TV window and the guests' phones
carry on while you run the party from a phone or tablet (set a host PIN in Settings → Party).
To stop it, open OpenKaraoke again and use **Quit OpenKaraoke** in Settings → About.

### If something doesn't work

- **Double-clicking “Install OpenKaraoke” does nothing.** Some very minimal systems lack FUSE,
  which the app needs to start. Use the `.deb` (Ubuntu, Mint, Debian) or `.rpm` (Fedora,
  openSUSE) from the [release page](https://github.com/blearymoth/OpenKaraoke/releases/latest)
  instead: double-click it and click Install in the software centre.
- **Your Files app shows the zip's contents instead of unpacking it** (an archive manager
  opened it). Use **Extract**, then double-click “Install OpenKaraoke” in the folder it made.
- **You never need the terminal** to install OpenKaraoke: commands like `npm install` are
  only for developers working on the source code.

### Other downloads

The [release page](https://github.com/blearymoth/OpenKaraoke/releases/latest) also has:

| File | For |
| --- | --- |
| `openkaraoke_<version>_amd64.deb` | Ubuntu, Debian, Mint: installs for everyone on the PC (asks for your password) |
| `openkaraoke-<version>.x86_64.rpm` | Fedora, openSUSE: installs for everyone on the PC (asks for your password) |
| `OpenKaraoke-<version>.AppImage` | the same program as “Install OpenKaraoke”, run straight from the file (Settings → About can install it) |

Settings, the library index and the party are kept in `~/.config/OpenKaraoke`. Your songs stay
where they are.

## Advanced: run the server from the source code

The installed app runs its own server. You only need this to run OpenKaraoke on a machine
without a desktop, or to work on the code. It requires Node.js ≥ 18.17 and Chrome or Chromium
for the TV display. The server has no runtime dependencies, so it needs no `npm install`.

```bash
git clone https://github.com/blearymoth/OpenKaraoke.git
cd OpenKaraoke
bin/openkaraoke.sh --library "/run/media/$USER/DRIVE/Karaoke"   # or: npm start -- --library …
```

Then, on the same computer:

1. Open **http://localhost:6527/host** for the host controls (search, queue, key/tempo,
   settings). 6527 spells OKAR on a phone keypad. When another program already uses that port,
   OpenKaraoke takes the next free one, keeps it for next time and says which one it is.
2. Click **Open TV display**, or run `bin/open-tv.sh`. It opens the TV page full screen on the
   second monitor with sound allowed, and the PC's microphone (for the applause meter game)
   without a permission prompt.
3. Guests scan the QR code on the TV with their phones (same Wi-Fi) and request songs.

`bin/install-service.sh` starts the server with the computer (a systemd service).

The first scan of a large drive runs in the background and takes a few minutes. Songs appear
when it finishes, and later starts reuse the saved index.
No karaoke files at hand? `npm run demo` creates a small demo library in `./demo-library`
(`npm start -- --library demo-library`).

To use the host controls from a phone or tablet, set a host PIN in Settings → Party.

### No Wi-Fi the guests can use? The party hotspot

Settings → Party → **Party hotspot** makes the PC open its own Wi-Fi. It needs Linux with
NetworkManager and a Wi-Fi adapter that can act as an access point. The TV then shows two QR
codes: **1** joins the party Wi-Fi, **2** opens the party.

The page checks the PC first and says what to fix: a password prompt, a firewall, Wi-Fi
switched off, and so on. If the hotspot can't start or drops, everything falls back to the home
Wi-Fi by itself. A PC on Wi-Fi only leaves the home network while the hotspot is on (one
radio). With an Ethernet cable it keeps both and shares the internet with the phones.

## Check a library without starting the server

```bash
node scripts/scan-report.js "/path/to/your/karaoke/folder" --search "someone like you"
```

## Development

- `npm test` — unit and integration tests (Node's built-in test runner)
- `npm run e2e` — end-to-end tests in Chromium (needs Playwright: `npm i -D playwright-core`)
- `npm run demo` — build the demo library
- `npm run vendor` — rebuild vendored browser/server libraries (after `npm install`)
- The desktop app: `npm --prefix desktop install`, then `npm --prefix desktop start` (runs it),
  `npm --prefix desktop test` (end to end under a virtual screen: the app, and the setup window
  with install, start, uninstall) and `npm --prefix desktop run dist` (`OpenKaraoke-Setup.zip`,
  AppImage, .rpm and .deb in `desktop/dist/`). Every change to the app on `main` is released by
  [`.github/workflows/desktop.yml`](.github/workflows/desktop.yml).
- Docs: [`CLAUDE.md`](CLAUDE.md) (contributor/agent guide), [`docs/PLAN.md`](docs/PLAN.md),
  [`docs/RESEARCH.md`](docs/RESEARCH.md), [`docs/LIBRARY.md`](docs/LIBRARY.md)

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own licenses
(Preact MIT, htm Apache-2.0, ws MIT, qrcode-generator MIT, Signalsmith Stretch MIT — full texts
in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)); the
bundled fonts (Bricolage Grotesque, Figtree) are under the SIL Open Font License, see
`public/fonts/`.
