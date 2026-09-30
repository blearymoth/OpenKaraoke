# OpenKaraoke

Self-hosted, KaraFun-style karaoke for Linux. It plays your own CDG+MP3 / MP4 karaoke
library (built for a ~90,000-track USB collection) with:

- **Host app** in the browser: instant typo-tolerant search, artists A–Z, collections,
  queue with fair singer rotation, key change, tempo, channel modes (multiplex / vocal cut),
  favourites, history, singers, guests and settings for everything
- **TV display on a second screen**: CDG lyrics over blurred cover art or a visualiser,
  next-singer countdown cards, "up next" banner, ticker, floating emoji reactions, announcements
- **QR-code guest lobby**: guests scan the code on the TV, pick a name and emoji, search the
  catalogue, request songs and cheer from their phones — no app install
- Coming next: cover art & artist graphics (Deezer, MusicBrainz/Cover Art Archive, TheAudioDB),
  party games (singing battles with audience voting, music quiz, roulette wheel, polls)

Everything runs on your PC — no cloud, no accounts, no runtime npm dependencies.

## Quick start

Requires Node.js ≥ 18.17 and Chromium/Chrome for the TV.

```bash
git clone https://github.com/blearymoth/OpenKaraoke.git
cd OpenKaraoke
npm start -- --library "/run/media/$USER/MYDRIVE/Karaoke"     # or bin/openkaraoke.sh --library …
```

Then:

| What | Where |
| --- | --- |
| Host controls (on the PC) | http://localhost:8080/host |
| TV display | `bin/open-tv.sh` (full screen on the 2nd monitor, sound allowed) or open http://localhost:8080/tv and click **Start** |
| Guests | scan the QR code on the TV (same Wi-Fi) |

The first scan of a big USB drive takes a while; later starts load the index from
`data/library.json` and rescan in the background. The library folder can also be chosen in
**Settings → Library**. To control the party from a tablet or phone, set a **host PIN** in
Settings → Party & security and open `http://<pc-address>:8080/host`.

No karaoke files at hand? `npm run demo -- /tmp/karaoke-demo` writes a few synthetic demo songs.

Options: `--port 8081`, `--data <dir>`, `--pin 1234`, `--no-scan`, `--help`.

## Development

- `npm test` — unit + integration tests (Node's built-in test runner)
- `npm run e2e` — browser end-to-end check (TV + host + two phone guests) with Playwright,
  screenshots in `test-results/e2e/` (`npm i -g playwright` first)
- `node scripts/scan-report.js "<folder>"` — validate the parser/catalog on a real library
- `npm run vendor` — rebuild vendored browser/server libraries (after `npm install`)
- Docs: [`CLAUDE.md`](CLAUDE.md) (contributor/agent guide), [`docs/HANDOFF.md`](docs/HANDOFF.md)
  (status), [`docs/PLAN.md`](docs/PLAN.md) (spec & roadmap), [`docs/RESEARCH.md`](docs/RESEARCH.md),
  [`docs/LIBRARY.md`](docs/LIBRARY.md)

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own licenses
(Preact MIT, htm Apache-2.0, ws MIT, qrcode-generator MIT, Signalsmith Stretch MIT).
