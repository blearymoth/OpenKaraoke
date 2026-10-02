// In-memory song catalogue: groups tracks (files) into songs, clusters artist
// spelling variants, and provides fast search/browse over ~100k tracks.
import { fold, compact, editDistance, shortId, splitCredits } from '../../shared/text.js';
import { parseName, titleKeyOf, BRAND_NAMES } from './parse.js';
import { Lru } from '../util/lru.js';

export const PARSER_VERSION = 4;

const segKey = (seg) => compact(String(seg).replace(/^the\s+/i, '').replace(/,\s*the$/i, '')) || compact(seg);

function digitsOf(s) { return s.replace(/\D+/g, ''); }

/**
 * Clusters near-identical keys (typos) with a symmetric-delete index.
 * Returns a function mapping a key to its cluster's canonical key.
 */
function clusterKeys(counts, { minLen = 6, allowDistance2From = 10 } = {}) {
  const parent = new Map();
  const weight = new Map();
  for (const [k, c] of counts) { parent.set(k, k); weight.set(k, c); }
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const wa = weight.get(ra);
    const wb = weight.get(rb);
    if (wa > wb || (wa === wb && ra < rb)) { parent.set(rb, ra); weight.set(ra, wa + wb); }
    else { parent.set(ra, rb); weight.set(rb, wa + wb); }
  };
  const index = new Map();
  for (const k of counts.keys()) {
    if (k.length < minLen) continue;
    const variants = new Set([k]);
    for (let i = 0; i < k.length; i++) variants.add(k.slice(0, i) + k.slice(i + 1));
    for (const v of variants) {
      let arr = index.get(v);
      if (!arr) index.set(v, (arr = []));
      arr.push(k);
    }
  }
  for (const arr of index.values()) {
    if (arr.length < 2 || arr.length > 24) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        if (a === b || a[0] !== b[0]) continue;
        if (digitsOf(a) !== digitsOf(b)) continue;
        const d = editDistance(a, b, 2);
        const len = Math.min(a.length, b.length);
        const ca = counts.get(a);
        const cb = counts.get(b);
        const ratio = Math.min(ca, cb) / Math.max(ca, cb);
        if ((d === 1 && ratio <= 0.7) || (d === 2 && len >= allowDistance2From && ratio <= 0.34)) union(a, b);
      }
    }
  }
  return find;
}

/** Same rules as clusterKeys() but pairwise, which is cheaper for small sets. */
function clusterSmall(counts, { minLen = 8, allowDistance2From = 16 } = {}) {
  const keys = [...counts.keys()].filter((k) => k.length >= minLen);
  const map = new Map();
  if (keys.length < 2) return (k) => k;
  keys.sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1));
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i];
    if (map.has(a)) continue;
    for (let j = i + 1; j < keys.length; j++) {
      const b = keys[j];
      if (map.has(b) || a[0] !== b[0] || Math.abs(a.length - b.length) > 2) continue;
      if (digitsOf(a) !== digitsOf(b)) continue;
      const d = editDistance(a, b, 2);
      const ratio = counts.get(b) / counts.get(a);
      const len = Math.min(a.length, b.length);
      if ((d === 1 && ratio <= 0.7) || (d === 2 && len >= allowDistance2From && ratio <= 0.34) || d === 0) map.set(b, a);
    }
  }
  return (k) => map.get(k) || k;
}

function pickDisplay(spellings) {
  let best = '';
  let bestScore = -1;
  for (const [name, count] of spellings) {
    let score = count * 10;
    if (name !== name.toUpperCase() && name !== name.toLowerCase()) score += 3; // Proper Case
    if (/[^\x00-\x7f]/.test(name)) score += 1; // keeps accents when tied
    if (/\s{2,}|^\W/.test(name)) score -= 5;
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best;
}

function mostCommon(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  let best;
  let n = -1;
  for (const [v, c] of m) if (c > n) { best = v; n = c; }
  return best;
}

export class Catalog {
  constructor() {
    this.roots = [];
    this.tracks = new Map();
    this.songs = new Map();
    this.artists = new Map();
    this.songList = [];
    this.artistList = [];
    this.tagCounts = [];
    this.brandCounts = [];
    this.vocab = null;
    this.version = 0;
    this.plays = new Map(); // songId -> times performed (all time)
    this.metaFor = () => null; // injected: songKey -> metadata (genre, year, rank...)
    this.metaVersion = 0; // bump with metaChanged() when metadata arrives
    this.builtAt = 0;
    this._popularCache = null; // { v, list }: every song, most popular first
    this._filtered = new Lru({ max: 32, maxBytes: 400_000 }); // filtered popular lists (size = songs)
  }

  get size() { return this.tracks.size; }

  /** Rebuild from raw scanner tracks (parse results may be cached on `t.p`). */
  load(rawTracks, roots = this.roots) {
    const t0 = Date.now();
    this.roots = roots;
    const tracks = new Map();
    for (const t of rawTracks) {
      if (!t.p || t.pv !== PARSER_VERSION) {
        const dirName = t.dir ? t.dir.split('/').pop() : '';
        t.p = parseName(t.name, dirName);
        t.pv = PARSER_VERSION;
      }
      let id = shortId(`${t.dir}/${t.name}`);
      if (tracks.has(id)) id = shortId(`${t.root}:${t.dir}/${t.name}`);
      t.id = id;
      tracks.set(id, t);
    }
    this.tracks = tracks;
    this._build();
    this.version++;
    this.builtAt = Date.now();
    this.buildMs = this.builtAt - t0;
    return this;
  }

  _build() {
    // 1. credit segment statistics
    const segCounts = new Map();
    const segSpell = new Map();
    for (const t of this.tracks.values()) {
      const credits = t.p.credits?.length ? t.p.credits : splitCredits(t.p.baseArtist);
      t._segs = credits.map((c) => {
        const k = segKey(c);
        segCounts.set(k, (segCounts.get(k) || 0) + 1);
        let sp = segSpell.get(k);
        if (!sp) segSpell.set(k, (sp = new Map()));
        const clean = c.replace(/\s+/g, ' ').trim();
        sp.set(clean, (sp.get(clean) || 0) + 1);
        return k;
      }).filter(Boolean);
      if (!t._segs.length) t._segs = ['unknown'];
    }
    const canon = clusterKeys(segCounts);

    // 2. artist groups and their titles
    const byArtist = new Map();
    for (const t of this.tracks.values()) {
      const keys = [...new Set(t._segs.map(canon))];
      t._artistKey = [...keys].sort().join('+');
      t._credits = keys;
      t._titleKey = titleKeyOf(t.p.baseTitle);
      let g = byArtist.get(t._artistKey);
      if (!g) byArtist.set(t._artistKey, (g = []));
      g.push(t);
    }

    // 3. merge title typos within an artist, then build songs
    const songs = new Map();
    for (const [artistKey, list] of byArtist) {
      const titleCounts = new Map();
      for (const t of list) titleCounts.set(t._titleKey, (titleCounts.get(t._titleKey) || 0) + 1);
      const canonTitle = titleCounts.size < 2 ? (k) => k
        : titleCounts.size <= 150 ? clusterSmall(titleCounts, { minLen: 8, allowDistance2From: 16 })
          : clusterKeys(titleCounts, { minLen: 8, allowDistance2From: 16 });
      for (const t of list) {
        const key = `${artistKey}|${canonTitle(t._titleKey)}`;
        let s = songs.get(key);
        if (!s) {
          s = { id: shortId(key), key, tracks: [], credits: t._credits };
          songs.set(key, s);
        }
        s.tracks.push(t);
      }
    }

    // 4. artist entities (one per canonical credit)
    const clusterSpell = new Map();
    for (const [k, sp] of segSpell) {
      const c = canon(k);
      let m = clusterSpell.get(c);
      if (!m) clusterSpell.set(c, (m = new Map()));
      for (const [name, n] of sp) m.set(name, (m.get(name) || 0) + n);
    }
    const artists = new Map();
    const artistFor = (key) => {
      let a = artists.get(key);
      if (!a) {
        const name = pickDisplay(clusterSpell.get(key) || new Map([[key, 1]]));
        a = { key, name, letter: letterOf(name), songIds: [], count: 0, solo: 0, trackCount: 0 };
        artists.set(key, a);
      }
      return a;
    };

    // 5. finalize songs
    const foldMemo = new Map();
    const mfold = (x) => {
      let v = foldMemo.get(x);
      if (v === undefined) { v = fold(x); foldMemo.set(x, v); }
      return v;
    };
    const songMap = new Map();
    const tagCounts = new Map();
    const brandCounts = new Map();
    for (const s of songs.values()) {
      const ts = s.tracks;
      const plain = ts.filter((t) => !t.p.variant.length);
      const titles = (plain.length ? plain : ts).map((t) => t.p.title);
      s.title = mostCommon(titles);
      if (s.credits.length === 1) {
        s.artist = artistFor(s.credits[0]).name;
      } else {
        s.artist = mostCommon(ts.map((t) => t.p.artist));
      }
      s.artistKeys = s.credits;
      s.letter = letterOf(s.artist.replace(/^the\s+/i, ''));
      s.trackIds = ts.map((t) => t.id);
      const tags = new Set();
      const flags = {};
      for (const t of ts) {
        t.songId = s.id;
        for (const tag of t.p.tags) tags.add(tag);
        if (t.p.flags.medley) flags.medley = true;
        if (t.p.brand) brandCounts.set(t.p.brand, (brandCounts.get(t.p.brand) || 0) + 1);
      }
      // A song is explicit only if every version is explicit (clean versions exist otherwise).
      flags.explicit = ts.every((t) => t.p.flags.explicit);
      if (!flags.explicit) delete flags.explicit;
      if (ts.every((t) => t.p.flags.duet)) flags.duet = true;
      s.tags = [...tags];
      s.flags = flags;
      const durs = ts.map((t) => t.duration).filter((d) => d > 0).sort((a, b) => a - b);
      s.duration = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
      s.versions = ts.length;
      s.artistFold = mfold(s.artist);
      s.titleFold = mfold(s.title);
      const alt = new Set();
      for (const t of ts) {
        const af = mfold(t.p.artist);
        if (af !== s.artistFold) alt.add(af);
        const tf = mfold(t.p.title);
        if (tf !== s.titleFold) alt.add(tf);
      }
      s.altFold = [...alt].join(' ');
      s.hay = ` ${s.titleFold} ${s.artistFold} ${s.altFold} `;
      for (const tag of s.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      for (let i = 0; i < s.credits.length; i++) {
        const a = artistFor(s.credits[i]);
        a.songIds.push(s.id);
        a.count++;
        a.trackCount += ts.length;
        if (s.credits.length === 1) a.solo++;
      }
      delete s.tracks;
      songMap.set(s.id, s);
    }
    for (const t of this.tracks.values()) { delete t._segs; delete t._titleKey; }

    this.songs = songMap;
    this.songList = [...songMap.values()];
    this.artists = artists;
    for (const a of artists.values()) {
      a.fold = mfold(a.name);
      a.sortKey = a.fold.replace(/^the /, '');
      a.letter = letterOf(a.sortKey); // "The Beatles" is browsed under B
    }
    this.artistList = [...artists.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    for (const a of this.artistList) {
      a.songIds.sort((x, y) => {
        const p = songMap.get(x).titleFold;
        const q = songMap.get(y).titleFold;
        return p < q ? -1 : p > q ? 1 : 0;
      });
    }
    const brandRank = new Map([...brandCounts].sort((a, b) => b[1] - a[1]).map(([b], i) => [b, i]));
    this.brandRank = brandRank;
    this.tagCounts = [...tagCounts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    this.brandCounts = [...brandCounts].map(([brand, count]) => ({ brand, name: BRAND_NAMES[brand] || brand, count })).sort((a, b) => b.count - a.count);
    this.vocab = null;
    this._popularCache = null;
    this._filtered.clear();
  }

  track(id) { return this.tracks.get(id); }
  song(id) { return this.songs.get(id); }
  artist(key) { return this.artists.get(key); }

  /** Popularity used for ranking: number of label versions, plays here and online rank. */
  popularity(s) {
    const meta = this.metaFor(s.key);
    const rank = meta?.rank ? Math.min(20, meta.rank / 50000) : 0;
    return Math.min(24, s.versions * 2.5) + (this.plays.get(s.id) || 0) * 4 + rank;
  }

  isExplicit(s) {
    if (s.flags.explicit) return true;
    const meta = this.metaFor(s.key);
    return !!(meta?.explicit && !s.trackIds.some((id) => this.tracks.get(id)?.p.flags.clean));
  }

  _passes(s, f) {
    if (!f) return true;
    if (f.noExplicit && this.isExplicit(s)) return false;
    if (f.tag && !s.tags.includes(f.tag)) return false;
    if (f.letter && s.letter !== f.letter) return false;
    if (f.artist && !s.artistKeys.includes(f.artist)) return false;
    if (f.maxDuration && s.duration > f.maxDuration) return false;
    if (f.minDuration && s.duration && s.duration < f.minDuration) return false;
    if (f.genre || f.decade || f.hasArt) {
      const m = this.metaFor(s.key);
      if (f.genre && m?.genre !== f.genre) return false;
      if (f.decade && (!m?.year || Math.floor(m.year / 10) * 10 !== f.decade)) return false;
      if (f.hasArt && !m?.cover) return false;
    }
    if (f.exclude && f.exclude.has(s.id)) return false;
    return true;
  }

  _buildVocab() {
    const words = new Map();
    for (const s of this.songList) {
      for (const w of s.hay.split(' ')) if (w.length >= 3) words.set(w, (words.get(w) || 0) + 1);
    }
    this.vocab = [...words.keys()];
  }

  _fuzzy(token) {
    if (token.length < 4) return [];
    if (!this.vocab) this._buildVocab();
    const max = token.length >= 7 ? 2 : 1;
    const out = [];
    for (const w of this.vocab) {
      if (Math.abs(w.length - token.length) > max) continue;
      if (w[0] !== token[0] && max === 1) continue;
      if (editDistance(w, token, max) <= max) out.push(w);
      if (out.length > 30) break;
    }
    return out;
  }

  /**
   * Full-text search over artist + title (+ alternative spellings).
   * Typo tolerant when exact matching yields few results.
   */
  search(query, { limit = 60, offset = 0, filter = null } = {}) {
    const q = fold(query);
    if (!q) return { total: 0, items: [] };
    let tokens = q.split(' ').filter(Boolean).map((t) => [t]);
    let results = this._matchTokens(q, tokens, filter);
    let fuzzy = false;
    if (results.length < 8) {
      const expanded = tokens.map(([t]) => {
        if (this._anyContains(t)) return [t];
        const alts = this._fuzzy(t);
        return alts.length ? [t, ...alts] : [t];
      });
      if (expanded.some((alts) => alts.length > 1)) {
        const seen = new Set(results.map((r) => r[1].id));
        for (const r of this._matchTokens(q, expanded, filter)) {
          if (!seen.has(r[1].id)) { r[0] -= 15; results.push(r); fuzzy = true; }
        }
      }
    }
    results.sort((a, b) => b[0] - a[0] || a[1].title.length - b[1].title.length);
    return { total: results.length, fuzzy, items: results.slice(offset, offset + limit).map((r) => r[1]) };
  }

  _anyContains(token) {
    for (const s of this.songList) if (s.hay.includes(token)) return true;
    return false;
  }

  _matchTokens(q, tokens, filter) {
    const out = [];
    const qTitle = ` ${q} `;
    for (const s of this.songList) {
      const hay = s.hay;
      let score = 0;
      let ok = true;
      const artistQuery = s.artistFold === q;
      for (const alts of tokens) {
        let best = -1;
        for (const tok of alts) {
          const i = hay.indexOf(tok);
          if (i < 0) continue;
          const wordStart = hay.charCodeAt(i - 1) === 32;
          const inTitle = i <= s.titleFold.length + 1;
          const pts = (wordStart ? 10 : 3) + (inTitle ? 3 : 0) + (tok.length > 3 ? 1 : 0);
          if (pts > best) best = pts;
        }
        if (best < 0) { ok = false; break; }
        if (!artistQuery) score += best;
      }
      if (!ok || !this._passes(s, filter)) continue;
      if (s.artistFold === q) score += 55;
      else {
        if (s.titleFold === q) score += 70;
        else if (s.titleFold.startsWith(q)) score += 35;
        else if (` ${s.titleFold} `.includes(qTitle)) score += 20;
        if (s.artistFold.startsWith(q)) score += 25;
      }
      if (q === `${s.artistFold} ${s.titleFold}` || q === `${s.titleFold} ${s.artistFold}`) score += 60;
      score += this.popularity(s);
      out.push([score, s]);
    }
    return out;
  }

  listArtists({ letter = '', q = '', limit = 200, offset = 0, sort = 'name', minSongs = 1 } = {}) {
    let list = this.artistList;
    if (letter) list = list.filter((a) => a.letter === letter);
    if (q) {
      const f = fold(q);
      list = list.filter((a) => a.fold.includes(f));
    }
    if (minSongs > 1) list = list.filter((a) => a.count >= minSongs);
    if (sort === 'count') list = [...list].sort((a, b) => b.trackCount - a.trackCount);
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }

  songsOfArtist(key) {
    const a = this.artists.get(key);
    if (!a) return [];
    return a.songIds.map((id) => this.songs.get(id)).filter(Boolean);
  }

  /** Call when plays or online metadata changed so cached rankings are rebuilt. */
  metaChanged() {
    this.metaVersion++;
  }

  /** Every song, most popular first (ties keep the catalogue order); rebuilt after changes. */
  popularList() {
    const v = `${this.version}:${this.metaVersion}`;
    if (this._popularCache?.v !== v) {
      this._popularCache = { v, list: this._byPopularity(this.songList) };
      this._filtered.clear(); // filters use the metadata too
    }
    return this._popularCache.list;
  }

  /**
   * `list` sorted by popularity. Each song's popularity is computed once and packed with its
   * position into one number, so a native numeric sort does the work (~20 ms for 55k songs
   * instead of ~150 ms with two popularity() calls per comparison).
   */
  _byPopularity(list) {
    const n = list.length;
    const span = 2 ** Math.max(1, Math.ceil(Math.log2(n + 1)));
    const pop = new Float64Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      const p = Math.round(this.popularity(list[i]) * 1e6);
      pop[i] = p > 0 ? p : 0; // (also NaN from odd metadata)
      if (pop[i] > max) max = pop[i];
    }
    if (!Number.isSafeInteger((max + 1) * span)) return [...list].sort((a, b) => this.popularity(b) - this.popularity(a));
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = pop[i] * span + (span - 1 - i);
    keys.sort();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = list[span - 1 - (keys[n - 1 - i] % span)];
    return out;
  }

  /** Popular songs passing `filter` (null = all). Filtered lists are cached for paging. */
  _popularFiltered(filter) {
    const all = this.popularList();
    if (!filter) return all;
    const key = filter.exclude ? null : JSON.stringify(filter); // a Set of ids: not cacheable
    let list = key && this._filtered.get(key);
    if (!list) {
      list = all.filter((s) => this._passes(s, filter));
      if (key) this._filtered.set(key, list);
    }
    return list;
  }

  popular({ limit = 100, offset = 0, filter = null } = {}) {
    const list = this._popularFiltered(filter);
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }

  /** The `n` most popular songs passing `filter` (stops early, no total: e.g. the TV mosaic). */
  topSongs(n, filter = null) {
    const out = [];
    for (const s of this.popularList()) {
      if (out.length >= n) break;
      if (this._passes(s, filter)) out.push(s);
    }
    return out;
  }

  /** Songs performed at this party place, most performed first ("Most sung here"). */
  mostSung({ limit = 100, offset = 0, filter = null } = {}) {
    const list = [];
    for (const [id, n] of this.plays) {
      const s = n > 0 && this.songs.get(id);
      if (s && this._passes(s, filter)) list.push(s);
    }
    list.sort((a, b) => (this.plays.get(b.id) || 0) - (this.plays.get(a.id) || 0) || this.popularity(b) - this.popularity(a));
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }

  byTag(tag, { limit = 100, offset = 0, sort = 'popular', filter = null } = {}) {
    const f = { ...(filter || {}), tag };
    const list = sort === 'title'
      ? this.songList.filter((s) => this._passes(s, f)).sort((a, b) => a.title.localeCompare(b.title))
      : this._popularFiltered(f);
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }

  filterSongs(filter, { limit = 100, offset = 0, sort = 'popular' } = {}) {
    let list;
    if (sort === 'title') list = this.songList.filter((s) => this._passes(s, filter)).sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'artist') list = this.songList.filter((s) => this._passes(s, filter)).sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    else list = this._popularFiltered(filter);
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }

  /** Random songs, weighted towards popular ones when `popularBias` > 0. */
  random(n, filter = null, { popularBias = 0.7, rng = Math.random } = {}) {
    let pool = popularBias > 0 ? this._popularFiltered(filter) : filter ? this.songList.filter((s) => this._passes(s, filter)) : this.songList;
    if (!pool.length) return [];
    if (popularBias > 0 && pool.length > n * 8) {
      pool = pool.slice(0, Math.max(n * 20, Math.floor(pool.length * (1 - popularBias) * 0.2) + n * 20));
    }
    const out = [];
    const used = new Set();
    let guard = 0;
    while (out.length < n && guard++ < n * 50) {
      const s = pool[Math.floor(rng() * pool.length)];
      if (used.has(s.id)) continue;
      used.add(s.id);
      out.push(s);
    }
    return out;
  }

  /** Genre / decade facets from online metadata (cached until the catalog or metadata changes). */
  facets() {
    const v = `${this.version}:${this.metaVersion}`;
    if (this._facetCache?.v === v) return this._facetCache.value;
    const value = this._facets();
    this._facetCache = { v, value };
    return value;
  }

  _facets() {
    const genres = new Map();
    const decades = new Map();
    for (const s of this.songList) {
      const m = this.metaFor(s.key);
      if (!m) continue;
      if (m.genre) genres.set(m.genre, (genres.get(m.genre) || 0) + 1);
      if (m.year) {
        const d = Math.floor(m.year / 10) * 10;
        decades.set(d, (decades.get(d) || 0) + 1);
      }
    }
    return {
      genres: [...genres].map(([genre, count]) => ({ genre, count })).sort((a, b) => b.count - a.count),
      decades: [...decades].map(([decade, count]) => ({ decade, count })).sort((a, b) => a.decade - b.decade),
      tags: this.tagCounts,
    };
  }

  /** Default version to play: preferred labels first, then "plain" versions. */
  bestTrack(song, brandPrefs = []) {
    return this.rankTracks(song, brandPrefs)[0];
  }

  /** A song's versions, best first (the brand order, no variant, karaoke rather than vocal mixes). */
  rankTracks(song, brandPrefs = []) {
    const ts = song.trackIds.map((id) => this.tracks.get(id)).filter(Boolean);
    return ts.sort((a, b) => this.trackScore(b, brandPrefs) - this.trackScore(a, brandPrefs));
  }

  /** How good a version is by its label alone (higher is better). */
  trackScore(t, brandPrefs = []) {
    let sc = 0;
    const bi = brandPrefs.indexOf(t.p.brand);
    if (bi >= 0) sc += 100 - bi * 5;
    if (!t.p.variant.length) sc += 30;
    if (t.p.flags.vocals) sc -= 25;
    if (t.p.flags.mpx) sc -= 10;
    if (t.kind === 'video') sc += 5;
    const br = this.brandRank?.get(t.p.brand);
    if (br !== undefined) sc += Math.max(0, 12 - br);
    return sc;
  }

  // ---- serialisation -------------------------------------------------------

  songSummary(s, extra) {
    if (!s) return null;
    const m = this.metaFor(s.key);
    const out = {
      id: s.id, artist: s.artist, title: s.title, dur: Math.round(s.duration), v: s.versions,
    };
    if (s.flags.duet || s.tags.includes('Duets')) out.duet = 1;
    if (this.isExplicit(s)) out.x = 1;
    if (m?.year) out.year = m.year;
    if (m?.cover) out.art = 1;
    if (extra) Object.assign(out, extra);
    return out;
  }

  trackSummary(t) {
    return {
      id: t.id,
      brand: t.p.brand,
      brandName: BRAND_NAMES[t.p.brand] || '',
      variant: t.p.variant.join(', '),
      dur: Math.round(t.duration),
      kind: t.kind,
      flags: t.p.flags,
      artist: t.p.artist,
      title: t.p.title,
      file: `${t.dir ? t.dir + '/' : ''}${t.name}`,
      discId: t.p.discId || undefined,
    };
  }

  songDetail(id) {
    const s = this.songs.get(id);
    if (!s) return null;
    const versions = s.trackIds.map((tid) => this.tracks.get(tid)).filter(Boolean).map((t) => this.trackSummary(t));
    const rank = (b) => this.brandRank?.get(b) ?? 999;
    versions.sort((a, b) => (a.variant ? 1 : 0) - (b.variant ? 1 : 0) || rank(a.brand) - rank(b.brand));
    return {
      ...this.songSummary(s),
      key: s.key,
      tags: s.tags,
      flags: s.flags,
      artists: s.artistKeys.map((k) => ({ key: k, name: this.artists.get(k)?.name || k })),
      versions,
      plays: this.plays.get(s.id) || 0,
      meta: this.metaFor(s.key) || null,
    };
  }

  /** Compact representation for the on-disk cache. */
  toCache() {
    const dirs = [];
    const dirIndex = new Map();
    const tracks = [];
    for (const t of this.tracks.values()) {
      const dk = `${t.root}\u0000${t.dir}`;
      let di = dirIndex.get(dk);
      if (di === undefined) { di = dirs.length; dirIndex.set(dk, di); dirs.push([t.root, t.dir]); }
      const rec = { d: di, n: t.name, k: t.kind, s: t.size, du: t.duration, m: t.mtime || 0 };
      if (t.kind === 'cdg') {
        if (t.cdg !== `${t.name}.cdg`) rec.c = t.cdg;
        const ext = t.audio.slice(t.audio.lastIndexOf('.') + 1);
        rec.a = t.audio === `${t.name}.${ext}` ? ext : t.audio;
      }
      if (t.kind === 'video') rec.v = t.video;
      if (t.kind === 'zip') { rec.z = t.zip; rec.e = t.entries; }
      rec.p = t.p;
      tracks.push(rec);
    }
    return { version: 3, parser: PARSER_VERSION, roots: this.roots, savedAt: Date.now(), dirs, tracks };
  }

  static rawFromCache(cache) {
    if (!cache || cache.version !== 3) return null;
    const out = [];
    for (const r of cache.tracks) {
      const [root, dir] = cache.dirs[r.d];
      const t = { root, dir, name: r.n, kind: r.k, size: r.s, duration: r.du, mtime: r.m };
      if (r.k === 'cdg') {
        t.cdg = r.c || `${r.n}.cdg`;
        t.audio = r.a.includes('.') ? r.a : `${r.n}.${r.a}`;
      }
      if (r.k === 'video') t.video = r.v;
      if (r.k === 'zip') { t.zip = r.z; t.entries = r.e; }
      if (cache.parser === PARSER_VERSION && r.p) { t.p = r.p; t.pv = PARSER_VERSION; }
      out.push(t);
    }
    return out;
  }
}

export function letterOf(name) {
  const c = fold(name).charAt(0);
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
}
