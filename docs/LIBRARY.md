# The owner's karaoke collection

Facts gathered from the USB drive (read-only) — useful when tuning the parser/catalog.
Do **not** commit files or song lists from the drive.

## Layout

```
/run/media/ruutu/SMILE-2/<collection folder>/
  #/  A/ … Z/                      first letter of the artist ('#' = digits/symbols/non-Latin)
    <Artist>/                      one folder per artist spelling (≈16k folders)
      <Artist> - <Title> [<LABEL> Karaoke].mp3
      <Artist> - <Title> [<LABEL> Karaoke].cdg
  Karaoke song Book by Artist.csv  ┐ song lists (Windows-1252 encoded, columns Artist,Title)
  Karaoke song Book by Title.csv   │ 90,479 rows — handy for offline parser experiments
  Raw CSV.csv                      ┘
  Readme_1st.txt, Track list.txt
```

- Only **MP3+CDG pairs** (no zips, no video) — ≈90,479 tracks, ≈180k files, ≈550 GB.
- MP3s: 44.1 kHz stereo, 128–320 kbps; ID3 `title` = `"<Title> [<LABEL> Karaoke]"`, `artist` = artist.
- **CDG duration = file size / 7200 bytes** and matches the MP3 length exactly
  (e.g. 2,152,128 bytes → 298.9 s; MP3 298.90 s). The scanner uses this — no MP3 decoding needed.
- `$RECYCLE.BIN` and `System Volume Information` exist at the drive root (skipped).

## Naming quirks the parser handles (see `test/parse.test.js`)
- ~247 label codes: SF (Sunfly) 11.3k, SC (Sound Choice) 11.1k, CB (Chartbuster) 6k, #Z (Zoom) 5.5k,
  ME 3.6k, Spanish 3.2k, MM 2.3k, DC 2.1k, PS, L, EZ, HM, MH, VS, KV, AS, Atoy, DK, THM, NU, MF,
  French 1.2k, SN, SGB, SBI, P, …; ~900 tracks just `[Karaoke]`.
- Language/region "labels": Spanish, French, German, Italian, Danish, Swedish, Maltese, Hebrew,
  Irish, Scottish, Australian (also misspelt "Austrailian"), Greek, Netherlands, Maori…
- Typos/truncation of the tag: `[#Z Karaaoke]`, `[L Karaolke]`, `[SN Karoke]`, `[CB Kararoke]`,
  `[SCKaraoke]`, `CB Karaoke]` (missing `[`), `[SBI Kar` / `[SC K` (names cut at a length limit).
- Truncated titles, e.g. `Adele - Someone Like Yo [KV Karaoke]` → merged with "Someone Like You"
  by per-artist fuzzy title clustering.
- Disc-id "artists": `AX-28794 - A Sky Full Of Stars [Coldplay]` → artist Coldplay.
- Annotations: `(Duet)` 383+, `(VR)` 209 (meaning unclear, kept as a variant label), `(Explicit)`,
  `(Clean)`, `(Wbgv)`/`(Wobgv)` (with/without backing vocals), `(Con Voz)`/`(Wvocal)` (guide vocals),
  `(Multiplex)` (vocals on one channel → offer L/R channel modes), `(Solo)`, `(Live)`,
  `(Acoustic)`, `(Part 1)`, remixes, medleys with `+` separated titles.
- Artist spelling variants in separate folders ("Alanis Morisette/Morissette/Morrisette",
  "Abba/ABBA", "A-Teens/A Teens/Ateens", "Aggro Santos Feat./ft/&") → clustered.

## Catalog results on the full list (CSV simulation, this machine)
- 90,479 tracks → **~50.5k songs** (label versions grouped) and **~11.8k artists**.
- Most versions: ABBA – Dancing Queen (27), Neil Diamond – Sweet Caroline (24), ABBA – Waterloo (24).
- Build ≈2.5–3.5 s (parse cached ≈2.5 s), search 3–20 ms (fuzzy fallback ≤100 ms),
  cache file ≈30 MB JSON. Heap ≈200–400 MB during build.
- Tags: Duets 3.9k (includes "A & B" credits), Spanish 3k, French 1.2k, Australian 1k,
  Christmas 650, German 630, Musicals 600, Italian 440, Kids 430, Disney 320, Medleys 200.

## Validate on the real drive
```bash
node scripts/scan-report.js "/run/media/ruutu/SMILE-2/<collection folder>" --search "someone like you"
```
The first full scan of a USB HDD is I/O bound (≈16k directories + 90k `stat` calls); later scans
reuse cached sizes (see `previous` in `scanLibrary`).
