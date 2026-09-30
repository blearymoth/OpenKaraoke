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

Everything runs on your PC — no cloud, no accounts, no runtime npm dependencies.

## Status

The first party-ready version works: server, TV display, host controls and guest app
(milestones M0–M4 in [`docs/PLAN.md`](docs/PLAN.md)). Cover art, party games and extras
such as break music are next — see [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Quick start

Requires Node.js ≥ 18.17 and Chrome or Chromium for the TV display. No `npm install` needed.

```bash
git clone https://github.com/blearymoth/OpenKaraoke.git
cd OpenKaraoke
bin/openkaraoke.sh --library "/run/media/$USER/DRIVE/Karaoke"   # or: npm start -- --library …
```

Then, on the same computer:

1. Open **http://localhost:8080/host** — the host controls (search, queue, key/tempo, settings).
2. Click **Open TV display**, or run `bin/open-tv.sh` to open the TV page full screen on the
   second monitor with sound allowed.
3. Guests scan the QR code on the TV with their phones (same Wi-Fi) and request songs.

The first scan of a large drive runs in the background and takes a few minutes; songs appear
when it finishes, and later starts reuse the saved index.
No karaoke files at hand? `npm run demo` creates a small demo library in `./demo-library`
(`npm start -- --library demo-library`).

To use the host controls from a phone or tablet, set a host PIN in Settings → Party.

## Check a library without starting the server

```bash
node scripts/scan-report.js "/path/to/your/karaoke/folder" --search "someone like you"
```

## Development

- `npm test` — unit and integration tests (Node's built-in test runner)
- `npm run e2e` — end-to-end tests in Chromium (needs Playwright: `npm i -D playwright-core`)
- `npm run demo` — build the demo library
- `npm run vendor` — rebuild vendored browser/server libraries (after `npm install`)
- Docs: [`CLAUDE.md`](CLAUDE.md) (contributor/agent guide), [`docs/PLAN.md`](docs/PLAN.md),
  [`docs/RESEARCH.md`](docs/RESEARCH.md), [`docs/LIBRARY.md`](docs/LIBRARY.md)

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own licenses
(Preact MIT, htm Apache-2.0, ws MIT, qrcode-generator MIT, Signalsmith Stretch MIT); the
bundled fonts (Bricolage Grotesque, Figtree) are under the SIL Open Font License, see
`public/fonts/`.
