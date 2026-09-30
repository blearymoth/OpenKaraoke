// Online artwork/metadata providers (PLAN §12, RESEARCH §3). Every function takes a
// `get(url) → Promise<json>` so the service can rate-limit and tests can inject fixtures.
import { similarity, splitCredits } from '../../shared/text.js';

export const UA = 'OpenKaraoke/0.1 ( https://github.com/blearymoth/OpenKaraoke )';

export class ProviderError extends Error {
  constructor(message, { retryAfter = 0, quota = false } = {}) {
    super(message);
    this.retryAfter = retryAfter;
    this.quota = quota;
  }
}

/** Main credit only, without "(Duet)" style annotations. */
export function cleanArtist(artist) {
  const s = String(artist || '').replace(/\((?:duet|solo|trio|wbgv|wobgv|musical|vr)\)/gi, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

export function primaryArtist(artist) {
  return splitCredits(cleanArtist(artist))[0] || cleanArtist(artist);
}

/** Title without brackets, karaoke/version words and medley tails. */
export function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(?:karaoke|instrumental)(?:\s+version)?\b/gi, ' ')
    .replace(/\s+-\s+(?:live|remaster(?:ed)?|radio edit|single version).*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOT_ORIGINAL = /karaoke|tribute|in the style of|made famous|originally performed|backing track|instrumental|cover version|\bcovers?\b|sing-?along|hits of the|as popularized|8-bit|lullaby|piano version/i;

/**
 * 0..1 confidence that `cand` is the original recording of `want`.
 * want: { artist, title, duration }, cand: { artist, title, album, duration, rank }
 */
export function scoreMatch(want, cand) {
  const wa = cleanArtist(want.artist);
  const credits = [wa, ...splitCredits(wa)];
  const a = Math.max(...credits.map((c) => similarity(c, cand.artist || '')));
  const wt = cleanTitle(want.title);
  const t = Math.max(similarity(wt, cleanTitle(cand.title)), cand.titleShort ? similarity(wt, cleanTitle(cand.titleShort)) : 0);
  if (a < 0.75 || t < 0.7) return 0;
  let score = a * 0.45 + t * 0.45;
  if (NOT_ORIGINAL.test(`${cand.album || ''} ${cand.artist || ''} ${cand.title || ''}`)) score -= 0.35;
  if (want.duration > 0 && cand.duration > 0) {
    const d = Math.abs(want.duration - cand.duration);
    if (d <= 15) score += 0.08;
    else if (d > 90) score -= 0.12;
  }
  score += Math.min(0.02, (cand.rank || 0) / 5e7);
  return Math.max(0, Math.min(1, score));
}

export function best(want, candidates, min = 0.6) {
  let top = null;
  for (const c of candidates) {
    const s = scoreMatch(want, c);
    if (s >= min && (!top || s > top.confidence)) top = { ...c, confidence: Math.round(s * 100) / 100 };
  }
  return top;
}

// ---- Deezer ----------------------------------------------------------------------------------

function deezerCheck(json) {
  if (json?.error) {
    const quota = json.error.code === 4;
    throw new ProviderError(`Deezer: ${json.error.message || json.error.type || 'error'}`, { quota, retryAfter: quota ? 5000 : 0 });
  }
  return json;
}

export function deezerTracks(json) {
  return (deezerCheck(json)?.data || []).filter((d) => d && d.type !== 'artist').map((d) => ({
    provider: 'deezer',
    id: String(d.id),
    title: d.title || '',
    titleShort: d.title_short || '',
    artist: d.artist?.name || '',
    artistId: d.artist?.id ? String(d.artist.id) : null,
    artistPic: d.artist?.picture_xl || d.artist?.picture_big || null,
    album: d.album?.title || '',
    albumId: d.album?.id ? String(d.album.id) : null,
    cover: d.album?.cover_medium ? { m: d.album.cover_medium, l: d.album.cover_xl || d.album.cover_big || d.album.cover_medium } : null,
    duration: d.duration || 0,
    rank: d.rank || 0,
    explicit: !!d.explicit_lyrics,
  })).filter((c) => c.cover);
}

export async function deezerSearch(get, want) {
  const artist = primaryArtist(want.artist);
  const title = cleanTitle(want.title);
  const strict = `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}&strict=on&limit=10`;
  let list = deezerTracks(await get(strict));
  if (!list.length) list = deezerTracks(await get(`https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=10`));
  return list;
}

/** Genre + year of an album. */
export async function deezerAlbum(get, albumId) {
  const j = deezerCheck(await get(`https://api.deezer.com/album/${encodeURIComponent(albumId)}`));
  const year = Number(String(j.release_date || '').slice(0, 4)) || null;
  return { genre: j.genres?.data?.[0]?.name || null, year, label: j.label || null };
}

export async function deezerArtist(get, name) {
  const j = deezerCheck(await get(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`));
  const list = (j.data || []).map((a) => ({ name: a.name, pic: a.picture_xl || a.picture_big || null, fans: a.nb_fan || 0 }))
    .filter((a) => a.pic && !/\/artist\/\/|images\/artist\/(?:0+)?\//.test(a.pic));
  const scored = list.map((a) => ({ ...a, s: similarity(name, a.name) })).filter((a) => a.s >= 0.85);
  scored.sort((x, y) => y.s - x.s || y.fans - x.fans);
  return scored[0] ? { picture: scored[0].pic } : null;
}

// ---- MusicBrainz + Cover Art Archive --------------------------------------------------------------

export function musicbrainzCandidates(json) {
  const out = [];
  for (const r of json?.recordings || []) {
    const artist = (r['artist-credit'] || []).map((c) => `${c.name}${c.joinphrase || ''}`).join('').trim();
    const rels = (r.releases || []).filter((rel) => rel['release-group']?.id);
    rels.sort((x, y) => relRank(x) - relRank(y) || String(x.date || '9999').localeCompare(String(y.date || '9999')));
    const rel = rels[0];
    if (!rel) continue;
    const rg = rel['release-group'].id;
    out.push({
      provider: 'musicbrainz',
      id: r.id,
      title: r.title || '',
      artist,
      album: rel.title || '',
      albumId: rg,
      cover: { m: `https://coverartarchive.org/release-group/${rg}/front-250`, l: `https://coverartarchive.org/release-group/${rg}/front-1200` },
      duration: r.length ? Math.round(r.length / 1000) : 0,
      year: Number(String(r['first-release-date'] || rel.date || '').slice(0, 4)) || null,
      rank: 0,
    });
  }
  return out;
}

function relRank(rel) {
  const g = rel['release-group'] || {};
  const secondary = g['secondary-types'] || [];
  if (g['primary-type'] === 'Album' && !secondary.length) return 0;
  if (g['primary-type'] === 'Single' && !secondary.length) return 1;
  if (!secondary.includes('Compilation')) return 2;
  return 3;
}

export async function musicbrainzSearch(get, want) {
  const q = `recording:"${cleanTitle(want.title)}" AND artist:"${primaryArtist(want.artist)}"`;
  return musicbrainzCandidates(await get(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=8`));
}

// ---- TheAudioDB (artist pictures, fanart, logos) ----------------------------------------------------

export function audiodbArtistFrom(json, name) {
  const a = (json?.artists || []).find((x) => similarity(x.strArtist || '', name) >= 0.85);
  if (!a) return null;
  const pick = (...keys) => keys.map((k) => a[k]).find((v) => typeof v === 'string' && /^https?:\/\//.test(v)) || null;
  return {
    picture: pick('strArtistThumb'),
    fanart: pick('strArtistFanart', 'strArtistFanart2', 'strArtistFanart3', 'strArtistWideThumb'),
    logo: pick('strArtistLogo'),
    cutout: pick('strArtistCutout'),
    genre: a.strGenre || null,
    mbid: a.strMusicBrainzID || null,
  };
}

export async function audiodbArtist(get, name, key = '123') {
  return audiodbArtistFrom(await get(`https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(key || '123')}/search.php?s=${encodeURIComponent(name)}`), name);
}

// ---- iTunes (optional; its terms forbid caching, so images are linked, not stored) -------------------

export function itunesCandidates(json) {
  return (json?.results || []).filter((r) => r.artworkUrl100).map((r) => ({
    provider: 'itunes',
    id: String(r.trackId),
    title: r.trackName || '',
    artist: r.artistName || '',
    album: r.collectionName || '',
    cover: { m: r.artworkUrl100.replace(/100x100bb/, '250x250bb'), l: r.artworkUrl100.replace(/100x100bb/, '1000x1000bb') },
    remote: true,
    duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 0,
    year: Number(String(r.releaseDate || '').slice(0, 4)) || null,
    genre: r.primaryGenreName || null,
    explicit: r.trackExplicitness === 'explicit',
    rank: 0,
  }));
}

export async function itunesSearch(get, want) {
  const term = `${primaryArtist(want.artist)} ${cleanTitle(want.title)}`;
  return itunesCandidates(await get(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8`));
}
