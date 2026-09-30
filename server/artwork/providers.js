// Online artwork & metadata providers (PLAN §12, RESEARCH §3). Each provider only builds
// request URLs and turns responses into normalised candidates; the network, rate limits and
// caching live in service.js, so everything here is pure and tested against saved fixtures.
//
// Song candidate: { provider, id, title, version, artist, album, albumId, albumType, duration,
//                   rank, explicit, year, genre, cover, covers[], artistPicture }
// Artist info:    { provider, id, name, picture, fanart[], logo, cutout, banner, mbid, genre }
// Images are stored as compact "refs" ("dz:<url>", "caa:<mbid>", …); imageUrls() expands a ref
// into { s, m, l } URLs (≈250, 500 and 1000+ px).
import { yearOf, normalizeGenre } from './match.js';

export const USER_AGENT = (version = '0') => `OpenKaraoke/${version} ( https://github.com/blearymoth/OpenKaraoke )`;

/** Hosts images may be downloaded from (provider data is partly user-edited: no SSRF). */
const IMAGE_HOSTS = [/(^|\.)dzcdn\.net$/, /^coverartarchive\.org$/, /(^|\.)archive\.org$/, /(^|\.)theaudiodb\.com$/, /(^|\.)fanart\.tv$/, /(^|\.)mzstatic\.com$/];

export function allowedImageUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && IMAGE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

const q = (s) => String(s || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');

// ---- image refs ------------------------------------------------------------------------------

const DEEZER_SIZE_RE = /\/\d+x\d+-[^/]*$/;

/** Deezer image URL → ref, or null for Deezer's empty placeholders (".../artist//250x250-…"). */
function deezerRef(url) {
  if (typeof url !== 'string' || !url || /\/images\/(?:cover|artist)\/\//.test(url)) return null;
  return allowedImageUrl(url) ? `dz:${url}` : null;
}

function plainRef(prefix, url) {
  return typeof url === 'string' && url && allowedImageUrl(url) ? `${prefix}:${url}` : null;
}

/** Expands an image ref into URLs for small (≈250 px), medium (≈500 px) and large (≥1000 px). */
export function imageUrls(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const v = ref.slice(i + 1);
  switch (kind) {
    case 'dz': {
      if (!DEEZER_SIZE_RE.test(v)) return { s: v, m: v, l: v };
      const sized = (n) => v.replace(DEEZER_SIZE_RE, `/${n}x${n}-000000-80-0-0.jpg`);
      return { s: sized(250), m: sized(500), l: sized(1000) };
    }
    case 'caa': {
      if (!/^[0-9a-f-]{36}$/i.test(v)) return null;
      const base = `https://coverartarchive.org/release-group/${v}/front`;
      return { s: `${base}-250`, m: `${base}-500`, l: `${base}-1200` };
    }
    case 'it': {
      const sized = (n) => v.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, `/${n}x${n}bb.$1`);
      return { s: sized(250), m: sized(600), l: sized(1000) };
    }
    case 'tadb':
      return { s: `${v}/small`, m: `${v}/medium`, l: v };
    case 'ftv':
      return { s: v.replace('/fanart/', '/preview/'), m: v.replace('/fanart/', '/preview/'), l: v };
    case 'url':
      return { s: v, m: v, l: v };
    default:
      return null;
  }
}

// ---- Deezer -----------------------------------------------------------------------------------

export const deezer = {
  name: 'deezer',
  label: 'Deezer',
  kinds: ['song', 'artist'],
  throttle: { capacity: 10, perMs: 1250 }, // 8 requests/s — the quota is 50 per 5 s
  workers: 3,

  songUrls(query) {
    const strict = (artist) => `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${q(artist)}" track:"${q(query.title)}"`)}&strict=on&limit=15`;
    const urls = [strict(query.artist)];
    if (query.primary && query.primary !== query.artist) urls.push(strict(query.primary));
    urls.push(`https://api.deezer.com/search?q=${encodeURIComponent(`${q(query.primary)} ${q(query.title)}`)}&limit=15`);
    return urls;
  },

  /** Deezer answers errors with HTTP 200 and { error: { type, message, code } }; code 4 = quota. */
  apiError(json) {
    if (!json || typeof json !== 'object' || !json.error) return null;
    const code = Number(json.error.code);
    return { quota: code === 4, notFound: code === 800, message: `${str(json.error.type, 60)}: ${str(json.error.message)} (${code})` };
  },

  parseSongs(json) {
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.filter((t) => t && typeof t === 'object' && (t.type === undefined || t.type === 'track')).map((t) => ({
      provider: 'deezer',
      id: str(t.id, 40),
      title: str(t.title_short) || str(t.title),
      version: str(t.title_version),
      artist: str(t.artist?.name),
      artistId: str(t.artist?.id, 40),
      album: str(t.album?.title),
      albumId: str(t.album?.id, 40),
      duration: Number(t.duration) || 0,
      rank: Number(t.rank) || 0,
      explicit: t.explicit_lyrics === true,
      cover: deezerRef(t.album?.cover_xl) || deezerRef(t.album?.cover_big) || deezerRef(t.album?.cover_medium),
      artistPicture: deezerRef(t.artist?.picture_xl) || deezerRef(t.artist?.picture_big) || deezerRef(t.artist?.picture_medium),
    })).filter((c) => c.id && c.title && c.artist);
  },

  albumUrl(id) {
    return /^\d{1,20}$/.test(String(id)) ? `https://api.deezer.com/album/${id}` : null;
  },

  parseAlbum(json) {
    if (!json || typeof json !== 'object') return null;
    const genres = Array.isArray(json.genres?.data) ? json.genres.data : [];
    return {
      genre: normalizeGenre(genres[0]?.name),
      year: yearOf(json.release_date),
      label: str(json.label, 80),
      type: str(json.record_type, 20),
    };
  },

  artistUrls(name) {
    return [`https://api.deezer.com/search/artist?q=${encodeURIComponent(q(name))}&limit=8`];
  },

  parseArtists(json) {
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.filter((a) => a && typeof a === 'object').map((a) => ({
      provider: 'deezer',
      id: str(a.id, 40),
      name: str(a.name),
      picture: deezerRef(a.picture_xl) || deezerRef(a.picture_big) || deezerRef(a.picture_medium),
      fans: Number(a.nb_fan) || 0,
    })).filter((a) => a.name);
  },
};

// ---- MusicBrainz + Cover Art Archive ---------------------------------------------------------------

const MB_BAD_SECONDARY = new Set(['Compilation', 'Live', 'Soundtrack', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Karaoke', 'Interview', 'Spokenword', 'Audiobook']);
const MB_TYPE_ORDER = { Album: 0, Single: 1, EP: 2, Other: 4, Broadcast: 5 };

export const musicbrainz = {
  name: 'musicbrainz',
  label: 'MusicBrainz + Cover Art Archive',
  kinds: ['song'],
  throttle: { capacity: 1, perMs: 1100 }, // 1 request/s per IP, 503 above it
  workers: 1,

  songUrls(query) {
    const lucene = `recording:"${q(query.title)}" AND artist:"${q(query.primary)}"`;
    return [`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(lucene)}&fmt=json&limit=10`];
  },

  parseSongs(json) {
    const recs = Array.isArray(json?.recordings) ? json.recordings : [];
    return recs.filter((r) => r && typeof r === 'object').map((r) => {
      const credit = Array.isArray(r['artist-credit']) ? r['artist-credit'] : [];
      const artist = credit.map((c) => `${str(c?.name) || str(c?.artist?.name)}${typeof c?.joinphrase === 'string' ? c.joinphrase : ''}`).join('').trim();
      const groups = new Map();
      for (const rel of Array.isArray(r.releases) ? r.releases : []) {
        const g = rel?.['release-group'];
        if (!g?.id || !/^[0-9a-f-]{36}$/i.test(g.id) || groups.has(g.id)) continue;
        const secondary = Array.isArray(g['secondary-types']) ? g['secondary-types'] : [];
        groups.set(g.id, {
          id: g.id,
          title: str(g.title) || str(rel.title),
          bad: secondary.some((s) => MB_BAD_SECONDARY.has(s)),
          compilation: secondary.includes('Compilation'),
          order: MB_TYPE_ORDER[g['primary-type']] ?? 3,
          year: yearOf(rel.date) || 9999,
          official: rel.status === 'Official',
        });
      }
      const ordered = [...groups.values()].sort((a, b) => a.bad - b.bad || b.official - a.official || a.order - b.order || a.year - b.year);
      const tags = Array.isArray(r.tags) ? [...r.tags].sort((a, b) => (b?.count || 0) - (a?.count || 0)) : [];
      const genre = tags.map((t) => normalizeGenre(t?.name)).find((g) => KNOWN_GENRES.has(g)) || '';
      return {
        provider: 'musicbrainz',
        id: str(r.id, 40),
        title: str(r.title),
        version: str(r.disambiguation),
        artist,
        album: ordered[0]?.title || '',
        albumType: ordered[0]?.compilation ? 'compilation' : '',
        duration: Number(r.length) > 0 ? Number(r.length) / 1000 : 0,
        rank: 0,
        explicit: false,
        year: yearOf(r['first-release-date']),
        genre,
        cover: null, // unknown until the Cover Art Archive answers
        covers: ordered.slice(0, 3).map((g) => `caa:${g.id}`),
      };
    }).filter((c) => c.id && c.title && c.artist);
  },
};

const KNOWN_GENRES = new Set(['Pop', 'Rock', 'Dance', 'Rap/Hip Hop', 'R&B', 'Soul & Funk', 'Electro', 'Folk', 'Films/Games', 'Kids', 'Latin', 'Alternative', 'Metal', 'Country', 'Jazz', 'Blues', 'Reggae', 'Classical', 'Holiday', 'Christian']);

// ---- TheAudioDB --------------------------------------------------------------------------------------

export const theaudiodb = {
  name: 'theaudiodb',
  label: 'TheAudioDB',
  kinds: ['artist'],
  throttle: { capacity: 2, perMs: 4000 }, // free key: 30 requests/min
  workers: 1,

  artistUrls(name, { key = '123' } = {}) {
    const k = /^[\w-]{1,64}$/.test(String(key)) ? key : '123';
    return [`https://www.theaudiodb.com/api/v1/json/${k}/search.php?s=${encodeURIComponent(q(name))}`];
  },

  parseArtists(json) {
    const list = Array.isArray(json?.artists) ? json.artists : []; // { artists: null } when nothing matches
    return list.filter((a) => a && typeof a === 'object').map((a) => ({
      provider: 'theaudiodb',
      id: str(a.idArtist, 40),
      name: str(a.strArtist),
      picture: plainRef('tadb', a.strArtistThumb),
      fanart: [a.strArtistFanart, a.strArtistFanart2, a.strArtistFanart3, a.strArtistFanart4].map((u) => plainRef('tadb', u)).filter(Boolean),
      logo: plainRef('tadb', a.strArtistLogo),
      cutout: plainRef('tadb', a.strArtistCutout),
      banner: plainRef('tadb', a.strArtistBanner),
      mbid: /^[0-9a-f-]{36}$/i.test(a.strMusicBrainzID || '') ? a.strMusicBrainzID : '',
      genre: normalizeGenre(a.strGenre),
    })).filter((a) => a.name);
  },
};

// ---- iTunes (off by default: Apple's terms don't allow caching artwork) ------------------------------------

export const itunes = {
  name: 'itunes',
  label: 'iTunes (Apple)',
  kinds: ['song'],
  throttle: { capacity: 1, perMs: 3000 }, // ≈20 requests/min
  workers: 1,

  songUrls(query) {
    return [`https://itunes.apple.com/search?term=${encodeURIComponent(`${q(query.primary)} ${q(query.title)}`)}&entity=song&limit=15`];
  },

  parseSongs(json) {
    const list = Array.isArray(json?.results) ? json.results : [];
    return list.filter((r) => r && typeof r === 'object' && (r.kind === 'song' || r.wrapperType === 'track')).map((r) => ({
      provider: 'itunes',
      id: str(r.trackId, 40),
      title: str(r.trackName),
      version: '',
      artist: str(r.artistName),
      album: str(r.collectionName),
      albumId: str(r.collectionId, 40),
      duration: Number(r.trackTimeMillis) > 0 ? Number(r.trackTimeMillis) / 1000 : 0,
      rank: 0,
      explicit: r.trackExplicitness === 'explicit',
      year: yearOf(r.releaseDate),
      genre: normalizeGenre(r.primaryGenreName),
      cover: plainRef('it', r.artworkUrl100),
    })).filter((c) => c.id && c.title && c.artist);
  },
};

// ---- Fanart.tv (needs the owner's API key and a MusicBrainz artist id) -------------------------------------

export const fanarttv = {
  name: 'fanarttv',
  label: 'Fanart.tv',
  kinds: ['artist'],
  throttle: { capacity: 2, perMs: 1000 },
  workers: 1,
  needsKey: true,

  artistUrl(mbid, key) {
    if (!/^[0-9a-f-]{36}$/i.test(mbid || '') || !/^[\w-]{8,64}$/.test(key || '')) return null;
    return `https://webservice.fanart.tv/v3/music/${mbid}?api_key=${key}`;
  },

  parseArtist(json) {
    if (!json || typeof json !== 'object') return null;
    const images = (list) => (Array.isArray(list) ? [...list] : [])
      .filter((i) => i && typeof i.url === 'string')
      .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
      .map((i) => plainRef('ftv', i.url))
      .filter(Boolean);
    return {
      provider: 'fanarttv',
      fanart: images(json.artistbackground).slice(0, 6),
      logo: images(json.hdmusiclogo)[0] || images(json.musiclogo)[0] || null,
      picture: images(json.artistthumb)[0] || null,
      banner: images(json.musicbanner)[0] || null,
    };
  },
};

export const PROVIDERS = { deezer, musicbrainz, theaudiodb, itunes, fanarttv };
/** Song lookups try these in order until one matches. */
export const SONG_CHAIN = ['deezer', 'musicbrainz', 'itunes'];
/** Artist lookups ask all of these (each adds pictures, fanart, logos…). */
export const ARTIST_CHAIN = ['deezer', 'theaudiodb', 'fanarttv'];
