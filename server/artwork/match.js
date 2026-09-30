// Matching karaoke songs to online catalogue entries (PLAN §12): clean up the artist and
// title for searching, then score candidates so covers of karaoke/tribute albums and
// wrong songs lose against the original recording. Pure functions, unit tested.
import { similarity, splitCredits, fold } from '../../shared/text.js';

/** Candidates below this score are ignored. */
export const MIN_CONFIDENCE = 0.62;

// Words that mark a recording as a cover / karaoke / novelty version of the song.
const JUNK_RE = /\b(?:karaoke|instrumental|backing track|in the style of|style of|made famous|made popular|originally performed|as performed by|as popularized|tribute|cover version|covers?|re-?recorded|lullaby|lullabies|8[- ]bit|music box|piano version|workout|sing-?along|sound-?alike|performed by|parody|kids version|string quartet)\b/i;
// Albums that are compilations: fine, but the original album is preferred (better year).
const COMPILATION_RE = /\b(?:greatest hits|best of|the best|hits|collection|anthology|essential|essentials|gold|number ones|no\. 1s|platinum|ultimate|definitive|complete|singles|now that'?s what|compilation|various artists|\d{2,3} (?:hits|songs))\b/i;
const LIVE_RE = /\b(?:live|in concert|unplugged|mtv unplugged)\b/i;
const REMIX_RE = /\b(?:remix|mix|rmx|edit|dub|version)\b/i;

/** Artist names with symbols that search engines spell out ("P!nk", "Ke$ha"). */
function spellSymbols(s) {
  return String(s || '')
    .replace(/(\p{L})!(\p{L})/gu, '$1i$2')
    .replace(/(\p{L})\$(\p{L}|$)/gu, '$1s$2')
    .replace(/(\p{L})@(\p{L})/gu, '$1a$2');
}

const stripThe = (s) => String(s || '').replace(/^\s*the\s+/i, '').replace(/,\s*the\s*$/i, '');

/** Bracketed and trailing annotations removed: "Hello (Live) [Karaoke]" → "Hello". */
export function titleCore(title) {
  let t = String(title || '');
  t = t.replace(/\s*[([{][^)\]}]*[)\]}]/g, ' '); // every bracket group
  t = t.replace(/\s+-\s+(?:.*\b(?:version|edit|remaster(?:ed)?|mix|live|mono|stereo|karaoke|demo|take|remix)\b.*)$/i, '');
  t = t.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '');
  return t.replace(/\s+/g, ' ').trim() || String(title || '').trim();
}

/** The title to search for: trailing annotations removed, leading "(I Can't Get No)" kept. */
export function searchTitle(title) {
  let t = String(title || '').trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, '').trim();
    if (!next || next === t) break;
    t = next;
  }
  t = t.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  return t.replace(/\s+/g, ' ') || String(title || '').trim();
}

/** Performers credited on a song, "The" dropped, symbols spelled out. */
export function creditsOf(artist) {
  const list = splitCredits(spellSymbols(artist)).map(stripThe).filter(Boolean);
  return list.length ? list : [stripThe(spellSymbols(artist))];
}

/** The query sent to providers for one catalog song. */
export function songQuery(song) {
  const credits = creditsOf(song.artist);
  return {
    artist: spellSymbols(stripThe(song.artist)).replace(/\s*\((?:duet|solo|trio)\)\s*/gi, ' ').trim(),
    primary: credits[0],
    credits,
    title: searchTitle(song.title),
    raw: String(song.title || ''),
    duration: Number(song.duration) || 0,
  };
}

/** 0..1: how well a candidate's artist credit matches ours (any performer counts). */
export function artistSimilarity(candidate, query) {
  const full = spellSymbols(stripThe(candidate));
  let best = similarity(full, query.artist);
  if (best === 1) return 1;
  const theirs = creditsOf(candidate);
  for (const mine of query.credits) {
    best = Math.max(best, similarity(full, mine));
    for (const t of theirs) best = Math.max(best, similarity(t, mine));
  }
  return best;
}

/** 0..1: how well a candidate title matches ours (annotations ignored on both sides). */
export function titleSimilarity(candidate, query) {
  const mine = [query.title, titleCore(query.title)];
  const theirs = [candidate, titleCore(candidate), searchTitle(candidate)];
  let best = 0;
  for (const a of mine) for (const b of theirs) best = Math.max(best, similarity(a, b));
  return best;
}

/**
 * Scores a normalised candidate `{ artist, title, album?, version?, duration?, rank?, albumType? }`
 * against a song query. Returns 0 for "not this song", otherwise a confidence in 0..1.
 */
export function scoreCandidate(c, query) {
  const a = artistSimilarity(c.artist, query);
  const t = titleSimilarity(c.title, query);
  if (a < 0.75 || t < 0.7) return 0;
  let score = 0.5 * a + 0.5 * t;
  const wanted = `${query.raw || query.title}`;
  const theirs = `${c.title} ${c.version || ''} ${c.album || ''} ${c.artist}`;
  if (JUNK_RE.test(theirs) && !JUNK_RE.test(wanted)) score -= 0.5; // never picked automatically
  if (LIVE_RE.test(`${c.title} ${c.version || ''} ${c.album || ''}`) && !LIVE_RE.test(wanted)) score -= 0.08;
  if (REMIX_RE.test(`${c.version || ''}`) && !/remaster/i.test(c.version || '') && !REMIX_RE.test(wanted)) score -= 0.05;
  if (c.albumType === 'compilation' || COMPILATION_RE.test(c.album || '')) score -= 0.04;
  if (query.duration > 0 && c.duration > 0) {
    const d = Math.abs(query.duration - c.duration);
    if (d <= 15) score += 0.04;
    else if (d > 60) score -= 0.08;
  }
  if (c.rank > 0) score += Math.min(0.03, (c.rank / 1_000_000) * 0.03);
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

/** Best candidate at or above `min` confidence, or null. */
export function pickBest(candidates, query, min = MIN_CONFIDENCE) {
  let best = null;
  for (const c of candidates || []) {
    const confidence = scoreCandidate(c, query);
    if (confidence >= min && (!best || confidence > best.confidence)) best = { candidate: c, confidence };
  }
  return best;
}

/** Candidates sorted by score (for the host's "fix artwork" picker); keeps weak ones too. */
export function rankCandidates(candidates, query) {
  return (candidates || [])
    .map((c) => ({ ...c, confidence: scoreCandidate(c, query) }))
    .sort((x, y) => y.confidence - x.confidence);
}

/** Artist search results: the one whose name matches best (≥ 0.8), or null. */
export function pickArtist(artists, name) {
  const query = { artist: spellSymbols(stripThe(name)), credits: creditsOf(name) };
  let best = null;
  for (const a of artists || []) {
    const s = similarity(spellSymbols(stripThe(a.name)), query.artist);
    if (s >= 0.8 && (!best || s > best.score)) best = { artist: a, score: s };
  }
  return best?.artist || null;
}

// Genre names differ per provider; map the common ones onto one vocabulary.
const GENRE_ALIASES = {
  'hip-hop/rap': 'Rap/Hip Hop', 'hip hop': 'Rap/Hip Hop', 'hip-hop': 'Rap/Hip Hop', rap: 'Rap/Hip Hop', 'rap/hip hop': 'Rap/Hip Hop',
  'r&b/soul': 'R&B', 'r and b': 'R&B', rnb: 'R&B', 'r&b': 'R&B', soul: 'Soul & Funk', funk: 'Soul & Funk', 'soul & funk': 'Soul & Funk',
  electronic: 'Electro', electronica: 'Electro', dance: 'Dance', edm: 'Dance', 'singer/songwriter': 'Folk', folk: 'Folk',
  soundtrack: 'Films/Games', 'films/games': 'Films/Games', 'film scores': 'Films/Games', 'musicals': 'Films/Games',
  "children's music": 'Kids', kids: 'Kids', 'latin music': 'Latin', latin: 'Latin', 'alternative': 'Alternative',
  'alternative rock': 'Alternative', 'indie rock': 'Alternative', indie: 'Alternative', 'indie pop': 'Alternative',
  'hard rock': 'Rock', 'soft rock': 'Rock', 'pop rock': 'Pop', 'dance pop': 'Pop', 'dance-pop': 'Pop', 'synth-pop': 'Pop', rock: 'Rock', 'rock & roll': 'Rock', 'heavy metal': 'Metal', metal: 'Metal', pop: 'Pop',
  country: 'Country', jazz: 'Jazz', blues: 'Blues', reggae: 'Reggae', classical: 'Classical', christmas: 'Holiday',
  holiday: 'Holiday', 'christian & gospel': 'Christian', gospel: 'Christian', christian: 'Christian',
};

/** Normalised genre name (keeps unknown genres as they are, trimmed). */
export function normalizeGenre(g) {
  const s = String(g || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return GENRE_ALIASES[s.toLowerCase()] || GENRE_ALIASES[fold(s)] || s.slice(0, 40);
}

/** Year from "1975-10-31", "1975" or a Date-ish string; 0 when unknown or implausible. */
export function yearOf(date) {
  const m = /^(\d{4})/.exec(String(date || ''));
  const y = m ? Number(m[1]) : 0;
  return y >= 1900 && y <= 2100 ? y : 0;
}
