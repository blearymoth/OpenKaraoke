# Research notes (September 2026)

Collected while planning OpenKaraoke. Section 3's Deezer/iTunes field names come from the
official docs and captured responses; they could not be fetched live from the build
environment, so **verify them with one live request from the PC** before relying on them.

## 1. KaraFun (Web, Windows, Mac, iOS/Android, TV) — the reference product

**Player controls**
- Key and tempo up/down, remembered per song; vocal guide on/off with separate lead/backing
  vocal volumes (needs multitrack stems — not available for CDG+MP3).
- "Ask options" dialog when queueing: singer name, key, tempo, vocals.
- **Start in pause**: next song waits for the singer to press play.
- Keyboard shortcuts for key, tempo, mute lead, ±5 s seek.

**Display**: singer name shown at song start; light/dark theme; **dual screen** (separate
lyrics window for the TV while the queue stays on the host screen); photos sent by guests
appear under the lyrics; green-screen mode (Windows).

**Remote control (QR lobby)**: QR code or remote code opens a browser page — no install.
Guests browse the catalogue, queue songs, see what's coming up, send photos, join Quiz/Battle.
Host sees who is connected. Pro: permission management, admin rights for chosen guests,
hide karaoke/battle on guest phones, permanent printable QR code, up to 100 guests.

**Singer rotation (Pro, 2025)**: groups (person / table / team, default one per phone); one
song per group in turn; "those who haven't sung yet are prioritised"; "play with priority
after" override; guests only see their own requests; rotation view vs classic queue view.

**Library**: favourites, playlists, history, offline sync, BPM/key metadata, Vocal Match.

**Between songs**: background music (5 built-in tunes, own MP3s on Windows); Automix (2026)
picks music that fits the next song; scrolling banner with upcoming singers + custom message.

**Games**
- **Quiz**: 2–1,000 players answer on phones via QR. Round types: Riff, Intro, Missing Lyrics,
  Helium, Stretched Tempo, Rewind, Band Builder, Music Culture. "Interlude": after an answer,
  guests can sing a ~30 s karaoke snippet of that song.
- **Battle** (2026): phones as microphones with real-time pitch scoring, "flames", live
  leaderboard; **Battle Versus**: team duets with a podium. (Needs melody data — we substitute
  audience voting / applause meter, see PLAN §13.)

**Parental control**: explicit songs show an "E" tag but won't play; password to disable.

**Gap OpenKaraoke fills**: KaraFun for Windows removed playback of local CDG/MP3/MP4 files.

## 2. Features from other karaoke apps worth copying

`[OK]` works with CDG+MP3 · `[NOTES]` needs melody/pitch data.

- **Karaoke Mugen**: public suggestion list + operator-curated play list; crowd poll for the
  next song; per-guest quotas (songs or minutes) freed by likes/time; smart insert
  (first-time requesters first), balancing, smart shuffle; intros/outros/jingles/sponsors;
  blind-test quiz (hide video/lyrics/sound, 25 s to guess, bonus < 10 s, 30 s reveal, fuzzy
  answer matching); open/limited/closed guest interface; announcements; mystery songs;
  blacklist/whitelist; random autoplay when the queue is empty. [OK]
- **Karaoke Eternal** (open source, closest architecture): round-robin queue ("a latecomer
  sings right after the next-up singer"), password rooms, QR join, stars, MP3+G incl. zipped,
  MilkDrop visualisations behind CDG with background removed automatically. [OK]
- **OpenKJ**: rotation with saved regulars, rotation ticker on the CDG screen, break music
  that fades around each track, idle slideshow, remote requests, key/tempo/EQ, silence detection. [OK]
- **AllKaraoke.party**: browser UltraStar game; phones become mics by scanning a QR code
  ("Remote Mic", 1–4 players) with pitch scoring and duel mode. [NOTES]
  (Note: phone mics need HTTPS — getUserMedia isn't available on plain-http LAN pages.)
- **UltraStar Deluxe / Vocaluxe / Performous / UltraStar Play**: Duel, Blind, Until 5000,
  Team duel with "pass the mic" cue, jokers to re-roll songs, Medley, Tic-Tac-Toe, Challenge,
  tournaments. Scoring [NOTES]; jokers, hand-off cues and brackets work with voting. [OK]
- **SingStar**: Battle, Duet, Pass the Mic (teams); Celebration mode randomly picks singer,
  song and style. Random-picker structure [OK].
- **Let's Sing**: Classic, Feat. (duets), Mixtape (5 short extracts), Let's Party (teams),
  World Contest, phone-as-mic. Mixtape-style medleys [OK].
- **Singa Party Mode**: join by QR or 4-letter code without account; host accepts, reorders,
  removes requests. [OK]
- **Lucky Voice**: "Pass the Mic" on-screen prompts; "Feeling Lucky?" random singer+song pairing. [OK]
- **Smule**: async duets, "Moments" (sing one section). Mostly needs recording.
- **Stingray**: vocals on/off, 100-song queue, casting, animated backdrops. [OK except vocals]
- **Common party games** [OK]: song/singer roulette or theme wheel; name-that-tune on the intro;
  missing lyrics (mask the CDG); helium/stretched/reversed rounds; duet-battle brackets with
  phone voting; applause meter; karaoke bingo; blind singer; musical chairs.

## 3. Cover art & graphics services

| Service | Auth | Rate limit | Images | Notes |
| --- | --- | --- | --- | --- |
| **Deezer** `api.deezer.com` | none for public catalogue endpoints | ~50 req / 5 s (error code 4 = quota) | album `cover_small/medium/big/xl` = 56/250/500/1000 px; artist `picture_*` | New app registration closed (2026) but keyless search works; ToS: non-commercial/private use OK. Best primary. |
| **iTunes Search** `itunes.apple.com/search` | none | ~20 req/min, ≤200 results | `artworkUrl100` → replace `100x100bb` with up to `3000x3000bb` | No artist images; explicit tracks reportedly missing since late 2025; ToS: artwork only to promote the store, **no caching** → off by default. |
| **MusicBrainz + Cover Art Archive** | none (MB needs `User-Agent: App/1.0 ( contact )`) | MB 1 req/s (503 when exceeded); CAA none | `/release-group/{mbid}/front-250|500|1200` | Canonical ids, original-album covers. Good fallback. |
| **TheAudioDB** | free key `123` (key `2` now 404s) | 30 req/min free (1 result per search); premium $8/mo 100/min + v2 | artist `strArtistThumb, strArtistLogo, strArtistCutout, strArtistClearart, strArtistWideThumb, strArtistFanart[2-4], strArtistBanner`; album `strAlbumThumb(HQ), strAlbumCDart, strAlbum3D*` | `/small` or `/medium` suffix gives 250/500 px. `searchtrack.php` returned empty in tests. Also `strMusicBrainzID, strGenre, strStyle, strMood`. Great for TV backgrounds/logos. |
| **Fanart.tv** | API key (+ optional personal key) | — | `artistbackground` 1920×1080, `artistthumb`, `musiclogo`/`hdmusiclogo` (transparent PNG), `musicbanner`, `albumcover`, `cdart` | Needs MusicBrainz ids. Optional. |
| **Spotify Web API** | Premium owner, dev mode max 5 users (Feb/Mar 2026 changes) | — | 640 px covers | Search max 10 results, bulk endpoints removed. **Not worth it.** |
| **Last.fm** | key | — | album art OK; artist images are a placeholder star (`2a96cbd8b46e442fc41c2b86b821562f`) | Filter the placeholder if used. |
| **Discogs** | token | 60 req/min | covers (not freely licensed) | Only as a last-resort fallback. |
| **Genius** | token | — | `song_art_image_url`, `header_image_url`, artist image + primary/secondary/text colours | Colours could theme the TV per song. |

**Deezer search fields** (`/search?q=artist:"queen" track:"bohemian rhapsody"&strict=on&limit=5`):
track `id, title, title_short, title_version, duration, rank, preview, explicit_lyrics,
explicit_content_lyrics, explicit_content_cover, md5_image, link`; `artist{id,name,picture,picture_small|medium|big|xl}`;
`album{id,title,cover,cover_small|medium|big|xl,md5_image}`. Image URL pattern:
`https://…dzcdn.net/images/{cover|artist}/{md5}/{N}x{N}-000000-80-0-0.jpg`. "No picture" is an
empty md5 (`images/artist//…`) or the MD5 of the empty string (`d41d8cd98f00b204e9800998ecf8427e`,
a grey silhouette); both must be treated as missing.
Genre/date are **not** in search results: `/album/{id}` → `genre_id, genres.data[].name, release_date, label`;
`/track/{id}` → `release_date, bpm, isrc`.

**iTunes fields** (`/search?term=queen+bohemian+rhapsody&entity=song&limit=5`): `artistName,
collectionName, trackName, artistId, collectionId, trackId, artworkUrl30/60/100, releaseDate,
primaryGenreName, trackExplicitness/collectionExplicitness (explicit|cleaned|notExplicit),
trackTimeMillis`.

**Recommended strategy for ~50k unique songs**
1. Normalise + dedupe (the catalog already groups label versions → ~50k songs).
2. Deezer strict search at 5–8 req/s (≈2–3 h for everything, popular songs first); score by
   fuzzy artist/title match, duration ±10 s, original album over compilations, then `rank`.
   Store ids + `md5_image`; call `/album/{id}` once per album for genre/year.
3. Misses → MusicBrainz release-group → Cover Art Archive (→ iTunes only if enabled).
4. Artist visuals once per artist: Deezer `picture_xl`, TheAudioDB fanart/logo/cutout (+MBID),
   optional Fanart.tv 1080p backgrounds.
5. Cache everything locally, serve from the Node server, keep a retry-after for misses, give
   the host a "fix artwork" screen for low-confidence matches. Keep it private/non-commercial.

## Sources
KaraFun: karafun.com/features, karafun.com/remote, karafun.com/help (web_610, web_484, web_487,
web_483, windows_404, general_176), karafun.com/blog/1511 (singer rotation), /blog/1670 (quiz),
/blog/1522 (interlude), /blog/1749 & /blog/1771 (battle), /blog/1755 (party games),
karafun.com/pro, business.karafun.com, App Store listing id431050674.
Other apps: mugen.karaokes.moe/en/features.html, docs.karaokes.moe, karaoke-eternal.com (+ GitHub
CHANGELOG), github.com/OpenKJ/OpenKJ, allkaraoke.party, github.com/UltraStar-Deluxe/USDX/wiki/Party-Mode,
Vocaluxe GameDesignDocument, performous.org, en.wikipedia.org/wiki/SingStar, singa.com/blog/introducing-party-mode-karaoke,
luckyvoice.com/blog/lucky-voice-karaoke-software-games, stingray.com.
Artwork: developers.deezer.com/termsofuse, navidrome.org/docs/usage/integration/external-services,
performance-partners.apple.com/search-api, developer.apple.com iTunes Search API docs,
musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting, musicbrainz.org/doc/Cover_Art_Archive/API,
theaudiodb.com/free_music_api, github.com/fanart-tv/fanart.tv-api,
developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide,
discogs.com/developers.
