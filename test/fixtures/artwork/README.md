# Artwork provider fixtures

Sample responses used by `test/artwork-providers.test.js` and the fake provider in
`test/fake-art.js`. They are **constructed from the documented response shapes**, not
captured live: the cloud session that wrote them (2026-09-30) could not reach the provider
hosts (egress policy), so field names were confirmed from the providers' documentation and
client-library references via web search:

| Provider | Confirmed |
| --- | --- |
| Deezer | track `id, title, title_short, title_version, duration, rank, explicit_lyrics, md5_image, artist{…picture_*}, album{…cover_*}`; album `genre_id, genres.data[].name, release_date, record_type, label`; errors `{"error":{"type":"Exception","message":"Quota limit exceeded","code":4}}`; covers on `*.dzcdn.net/images/cover/<md5>/<N>x<N>-000000-80-0-0.jpg` |
| MusicBrainz | `ws/2/recording?query=…&fmt=json` → `recordings[].{id, score, title, length (ms), "artist-credit", "first-release-date", releases[]."release-group"{id, "primary-type", "secondary-types"}}`; 1 request/s per IP, 503 when exceeded, contactable User-Agent required |
| Cover Art Archive | `/release-group/<mbid>/front-250\|500\|1200` → 307 redirect to the image, 404 when there is none |
| TheAudioDB | `api/v1/json/123/search.php?s=` → `{ artists: [...] }` or `{ artists: null }`; `strArtistThumb, strArtistLogo, strArtistCutout, strArtistFanart[2-4], strArtistBanner, strMusicBrainzID, strGenre`; `/small`, `/medium` image suffixes; free key 30 requests/min |
| iTunes | `search?entity=song` → `results[].{trackId, trackName, artistName, collectionName, artworkUrl100, releaseDate, primaryGenreName, trackExplicitness, trackTimeMillis}` |
| Fanart.tv | `webservice.fanart.tv/v3/music/<mbid>?api_key=` → `artistbackground, artistthumb, hdmusiclogo, musiclogo, musicbanner` lists of `{ id, url, likes }` |

Ids, hashes and image paths are made up. **Replace them with real captures** on a machine
with internet access:

```bash
node scripts/artwork-check.js --save test/fixtures/artwork/live
```

`artwork-check.js` calls each provider once, prints what the parsers extract, flags missing
fields, and (with `--save`) writes the raw responses next to these files.
