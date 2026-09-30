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

🚧 Early development. The library engine (scanner, parser, catalog/search) is done and tested;
the server, TV player and apps are next. See [`docs/HANDOFF.md`](docs/HANDOFF.md) for the
current status and [`docs/PLAN.md`](docs/PLAN.md) for the full spec and roadmap.

## Try the library engine

Requires Node.js ≥ 18.17.

```bash
git clone https://github.com/blearymoth/OpenKaraoke.git
cd OpenKaraoke
npm test
node scripts/scan-report.js "/path/to/your/karaoke/folder" --search "someone like you"
```

## Development

- `npm test` — unit tests (Node's built-in test runner)
- `npm run vendor` — rebuild vendored browser/server libraries (after `npm install`)
- Docs: [`CLAUDE.md`](CLAUDE.md) (contributor/agent guide), [`docs/PLAN.md`](docs/PLAN.md),
  [`docs/RESEARCH.md`](docs/RESEARCH.md), [`docs/LIBRARY.md`](docs/LIBRARY.md)

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own licenses
(Preact MIT, htm Apache-2.0, ws MIT, qrcode-generator MIT, Signalsmith Stretch MIT).
