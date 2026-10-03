# Karaoke libraries: what the parser expects

Notes on how large CD+G karaoke collections are usually laid out and named — useful when tuning
the parser and the catalog. Never commit media or song lists from a real library.

## Layout

A typical collection on a USB drive:

```
<library folder>/
  #/  A/ … Z/                      first letter of the artist ('#' = digits/symbols/non-Latin)
    <Artist>/                      one folder per artist spelling
      <Artist> - <Title> [<LABEL> Karaoke].mp3
      <Artist> - <Title> [<LABEL> Karaoke].cdg
  *.csv, *.txt                     song books / track lists (often Windows-1252 encoded)
```

- **MP3+CDG pairs**; zips and video files are supported too.
- MP3s: 44.1 kHz stereo, 128–320 kbps; the ID3 `title` often repeats the file name's
  `"<Title> [<LABEL> Karaoke]"`.
- **CDG duration = file size / 7200 bytes** and matches the MP3 length exactly
  (e.g. 2,152,128 bytes → 298.9 s). The scanner uses this — no MP3 decoding needed.
- Windows-formatted drives carry `$RECYCLE.BIN` and `System Volume Information` at the root
  (skipped).

## Naming quirks the parser handles (see `test/parse.test.js`)
- Hundreds of label codes, e.g. SF (Sunfly), SC (Sound Choice), CB (Chartbuster), #Z (Zoom), ME,
  MM, DC, PS, L, EZ, HM, MH, VS, KV, AS, DK, THM, NU, MF, SN, SGB, SBI, P, …; some tracks are just
  `[Karaoke]`.
- Language/region "labels": Spanish, French, German, Italian, Danish, Swedish, Maltese, Hebrew,
  Irish, Scottish, Australian (also misspelt "Austrailian"), Greek, Netherlands, Maori…
- Typos/truncation of the tag: `[#Z Karaaoke]`, `[L Karaolke]`, `[SN Karoke]`, `[CB Kararoke]`,
  `[SCKaraoke]`, `CB Karaoke]` (missing `[`), `[SBI Kar` / `[SC K` (names cut at a length limit).
- Truncated titles, e.g. `Adele - Someone Like Yo [KV Karaoke]` → merged with "Someone Like You"
  by per-artist fuzzy title clustering.
- Disc-id "artists": `AX-28794 - A Sky Full Of Stars [Coldplay]` → artist Coldplay.
- Annotations: `(Duet)`, `(VR)` (meaning unclear, kept as a variant label), `(Explicit)`,
  `(Clean)`, `(Wbgv)`/`(Wobgv)` (with/without backing vocals), `(Con Voz)`/`(Wvocal)` (guide vocals),
  `(Multiplex)` (the guide singer on one channel — PLAN §21), `(Solo)`, `(Live)`, `(Acoustic)`,
  `(Part 1)`, remixes, medleys with `+` separated titles.
- Artist spelling variants in separate folders ("Alanis Morisette/Morissette/Morrisette",
  "Abba/ABBA", "A-Teens/A Teens/Ateens", "Aggro Santos Feat./ft/&") → clustered.

## Performance target
The catalog is tuned for about 90,000 tracks (≈50k songs once label versions are grouped, ≈12k
artists): build ≈2.5–3.5 s, search 3–20 ms (fuzzy fallback ≤100 ms), cache file ≈30 MB JSON,
heap ≈200–400 MB during the build.

## Validate on a real library
```bash
node scripts/scan-report.js "<library folder>" --search "someone like you"
```
The first full scan of a USB hard drive is I/O bound (thousands of directories and one `stat` per
file); later scans reuse cached sizes (see `previous` in `scanLibrary`).
