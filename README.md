# OpenKaraoke

Self-hosted, KaraFun-style karaoke for Linux. It plays your own CDG+MP3 / MP4 karaoke
library (built for a ~90,000-track USB collection) with:

- **Host app** in the browser: instant typo-tolerant search, artists A–Z, collections,
  queue with fair singer rotation, key change, tempo, favourites, playlists, history
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

Everything runs on your PC — no cloud, no accounts, no runtime npm dependencies. Install it
as a **desktop app** (the TV display is a window of its own on the second screen) or run the
server from the source code.

## Status

All planned milestones are built (M0–M7 in [`docs/PLAN.md`](docs/PLAN.md)): server, TV
display, host controls, guest app, cover art and metadata, party games, break music, guest
photos, remote displays, songbook, systemd service and the two skins. What still needs a
real PC, drive, TV and phones is listed in the owner checklist in
[`docs/HANDOFF.md`](docs/HANDOFF.md).

## Install the desktop app

Download the newest version for your Linux from the
[Releases](https://github.com/blearymoth/OpenKaraoke/releases/latest) page:

| Linux | File | Install |
| --- | --- | --- |
| Any (no installation) | `OpenKaraoke-<version>.AppImage` | make it executable (`chmod +x OpenKaraoke-*.AppImage`), then double-click or run it |
| Fedora, openSUSE | `openkaraoke-<version>.x86_64.rpm` | `sudo dnf install ./openkaraoke-*.rpm` (or double-click it) |
| Ubuntu, Debian, Mint | `openkaraoke_<version>_amd64.deb` | `sudo apt install ./openkaraoke_*.deb` (or double-click it) |

Start **OpenKaraoke** from the applications menu and choose your karaoke folder. **Open TV
display** opens the TV window full screen on the second screen (the TV), with sound and the
microphone (applause meter) allowed — connect the TV first, or later: the window moves there
by itself. Guests scan the QR code on the TV with their phones (same Wi-Fi — or the PC's own
party hotspot, below).

The app keeps itself up to date: it looks for a new release now and then (Settings → About,
or Help › Check for updates…) and installs it when you say so — the AppImage replaces itself,
the .rpm/.deb asks for your password — then **Restart now**.

On Ubuntu 24.04 the AppImage needs `--no-sandbox` (Ubuntu restricts the sandbox AppImages
use); the .deb has no such problem. Settings, the library index and the party are kept in
`~/.config/OpenKaraoke` (your songs stay where they are).

## Run from the source code

Requires Node.js ≥ 18.17 and Chrome or Chromium for the TV display. No `npm install` needed.

```bash
git clone https://github.com/blearymoth/OpenKaraoke.git
cd OpenKaraoke
bin/openkaraoke.sh --library "/run/media/$USER/DRIVE/Karaoke"   # or: npm start -- --library …
```

Then, on the same computer:

1. Open **http://localhost:6527/host** — the host controls (search, queue, key/tempo, settings).
   (6527 spells OKAR on a phone keypad. When another program already uses it, OpenKaraoke
   takes the next free port, keeps it for next time and says which one it is.)
2. Click **Open TV display**, or run `bin/open-tv.sh` to open the TV page full screen on the
   second monitor with sound allowed (and the PC's microphone, for the applause meter game,
   without a permission prompt).
3. Guests scan the QR code on the TV with their phones (same Wi-Fi) and request songs.

The first scan of a large drive runs in the background and takes a few minutes; songs appear
when it finishes, and later starts reuse the saved index.
No karaoke files at hand? `npm run demo` creates a small demo library in `./demo-library`
(`npm start -- --library demo-library`).

To use the host controls from a phone or tablet, set a host PIN in Settings → Party.

### No Wi-Fi the guests can use? The party hotspot

Settings → Party → **Party hotspot** makes the PC open its own Wi-Fi (Linux with
NetworkManager and a Wi-Fi adapter that can be an access point). The TV then shows two QR
codes: **1** joins the party Wi-Fi, **2** opens the party. The page checks the PC first and
says what to fix (a password prompt, a firewall, Wi-Fi switched off, …); if the hotspot can't
start or drops, everything falls back to the home Wi-Fi by itself. A PC on Wi-Fi only leaves
the home network while the hotspot is on (one radio); with an Ethernet cable it keeps both and
shares the internet with the phones.

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
  `npm --prefix desktop test` (end to end, under a virtual screen) and
  `npm --prefix desktop run dist` (AppImage, .rpm and .deb in `desktop/dist/`). Every change to
  the app on `main` is released by [`.github/workflows/desktop.yml`](.github/workflows/desktop.yml).
- Docs: [`CLAUDE.md`](CLAUDE.md) (contributor/agent guide), [`docs/PLAN.md`](docs/PLAN.md),
  [`docs/RESEARCH.md`](docs/RESEARCH.md), [`docs/LIBRARY.md`](docs/LIBRARY.md)

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own licenses
(Preact MIT, htm Apache-2.0, ws MIT, qrcode-generator MIT, Signalsmith Stretch MIT); the
bundled fonts (Bricolage Grotesque, Figtree) are under the SIL Open Font License, see
`public/fonts/`.
