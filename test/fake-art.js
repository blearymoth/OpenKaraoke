// A fake "internet" for the artwork providers: answers Deezer, TheAudioDB, MusicBrainz and
// image CDN requests with provider-shaped JSON (see test/fixtures/artwork) and small PNGs,
// so tests and the e2e scripts never touch the network.
import zlib from 'node:zlib';
import { hash32 } from '../shared/text.js';

/** fetch() that always fails like a machine without internet. */
export const offlineFetch = async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
};

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A size×size PNG with a diagonal two-colour gradient derived from `seed`. */
export function pngImage(seed = 'x', size = 64) {
  const h = hash32(String(seed));
  const c1 = [h & 255, (h >>> 8) & 255, (h >>> 16) & 255];
  const c2 = [255 - c1[1], c1[2], 255 - c1[0]];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      for (let k = 0; k < 3; k++) raw[y * (size * 3 + 1) + 1 + x * 3 + k] = Math.round(c1[k] * (1 - t) + c2[k] * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const GENRES = ['Pop', 'Rock', 'Dance', 'R&B'];

/**
 * @param {object} [opts]
 * @param {Set<string>} [opts.unknown] artists (lower case) Deezer doesn't know
 * @param {(url: URL) => Response|undefined} [opts.override] answer some URLs yourself
 * @returns {typeof fetch & { calls: string[] }}
 */
export function fakeArtFetch({ unknown = new Set(), override } = {}) {
  const calls = [];
  const fn = async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const custom = override?.(url);
    if (custom) return custom;
    const host = url.hostname;
    if (host === 'api.deezer.com') {
      if (url.pathname === '/search') {
        const q = url.searchParams.get('q') || '';
        // Strict search: artist:"…" track:"…"; loose search: "<first word = artist> <title>".
        const m = /artist:"([^"]*)"\s+track:"([^"]*)"/.exec(q) || /^(\S+)\s+(.+)$/.exec(q);
        if (!m) return json({ data: [], total: 0 });
        const [, artist, title] = m;
        if (unknown.has(artist.toLowerCase())) return json({ data: [], total: 0 });
        const id = hash32(`${artist}|${title}`) % 1e9;
        const md5 = hash32(`cover:${artist}|${title}`).toString(16).padStart(8, '0').repeat(4);
        const amd5 = hash32(`artist:${artist}`).toString(16).padStart(8, '0').repeat(4);
        const albumId = hash32(`album:${artist}`) % 1e7;
        const cov = (n) => `https://e-cdns-images.dzcdn.net/images/cover/${md5}/${n}x${n}-000000-80-0-0.jpg`;
        const pic = (n) => `https://e-cdns-images.dzcdn.net/images/artist/${amd5}/${n}x${n}-000000-80-0-0.jpg`;
        return json({
          data: [{
            id, readable: true, title, title_short: title, title_version: '', duration: 200, rank: 500000 + (id % 400000),
            explicit_lyrics: false, md5_image: md5, type: 'track',
            artist: { id: albumId, name: artist, picture_medium: pic(250), picture_big: pic(500), picture_xl: pic(1000), type: 'artist' },
            album: { id: albumId, title: `${artist} Greatest`, cover_medium: cov(250), cover_big: cov(500), cover_xl: cov(1000), md5_image: md5, type: 'album' },
          }],
          total: 1,
        });
      }
      if (url.pathname === '/search/artist') {
        const name = url.searchParams.get('q') || '';
        if (unknown.has(name.toLowerCase())) return json({ data: [], total: 0 });
        const amd5 = hash32(`artist:${name}`).toString(16).padStart(8, '0').repeat(4);
        return json({ data: [{ id: hash32(name) % 1e6, name, picture_xl: `https://e-cdns-images.dzcdn.net/images/artist/${amd5}/1000x1000-000000-80-0-0.jpg`, nb_fan: 10, type: 'artist' }], total: 1 });
      }
      const album = /^\/album\/(\d+)$/.exec(url.pathname);
      if (album) {
        const n = Number(album[1]);
        return json({ id: n, title: 'Album', genre_id: 1, genres: { data: [{ id: 1, name: GENRES[n % GENRES.length], type: 'genre' }] }, release_date: `${1970 + (n % 50)}-06-01`, record_type: 'album', label: 'Label', type: 'album' });
      }
      return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
    }
    if (host === 'www.theaudiodb.com') {
      const name = url.searchParams.get('s') || '';
      if (unknown.has(name.toLowerCase())) return json({ artists: null });
      const base = `https://r2.theaudiodb.com/images/media/artist/${hash32(name).toString(36)}`;
      return json({ artists: [{ idArtist: String(hash32(name) % 1e6), strArtist: name, strGenre: 'Pop', strArtistThumb: `${base}/thumb.jpg`, strArtistFanart: `${base}/fanart1.jpg`, strArtistFanart2: `${base}/fanart2.jpg`, strArtistLogo: `${base}/logo.png`, strArtistCutout: null, strArtistBanner: null, strMusicBrainzID: null }] });
    }
    if (host === 'musicbrainz.org') return json({ created: '2026-01-01T00:00:00Z', count: 0, offset: 0, recordings: [] });
    if (host === 'itunes.apple.com') return json({ resultCount: 0, results: [] });
    if (/(^|\.)dzcdn\.net$|theaudiodb\.com$|archive\.org$|fanart\.tv$|mzstatic\.com$/.test(host)) {
      const png = pngImage(url.pathname, 48);
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
