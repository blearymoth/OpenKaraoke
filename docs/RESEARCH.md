# Artwork research notes (September 2026)

Collected while planning OpenKaraoke's cover art and metadata. Section 1's Deezer/iTunes field names come from the
official docs and captured responses; they could not be fetched live from the build
environment, so **verify them with one live request from the PC** before relying on them.

## 1. Cover art & graphics services

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
Artwork: developers.deezer.com/termsofuse, navidrome.org/docs/usage/integration/external-services,
performance-partners.apple.com/search-api, developer.apple.com iTunes Search API docs,
musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting, musicbrainz.org/doc/Cover_Art_Archive/API,
theaudiodb.com/free_music_api, github.com/fanart-tv/fanart.tv-api,
developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide,
discogs.com/developers.
