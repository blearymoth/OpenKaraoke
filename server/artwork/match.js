// Matching karaoke songs to online catalogue entries (PLAN §12): clean up the artist and
// title for searching, then score candidates so covers of karaoke/tribute albums and
// wrong songs lose against the original recording. Pure functions, unit tested.
import { similarity, splitCredits, fold, compact } from '../../shared/text.js';

/** Candidates below this score are ignored. */
export const MIN_CONFIDENCE = 0.62;

// Words that mark a recording as a cover / karaoke / novelty version of the song.
const JUNK_RE = /\b(?:karaoke|instrumental|backing track|in the style of|style of|made famous|made popular|originally performed|as performed by|as popularized|tribute|cover version|covers?|re-?recorded|lullaby|lullabies|8[- ]bit|music box|piano version|workout|sing-?along|sound-?alike|performed by|parody|kids version|string quartet)\b/gi;
// "Music Box" is also a real album (Mariah Carey): in album names it only counts with these.
const MUSIC_BOX_ALBUM_RE = /\b(?:versions?|renditions?|lullab\w*|tribute|plays|performs|arrangements?)\b/i;
// Albums that are compilations: fine, but the original album is preferred (better year).
const COMPILATION_RE = /\b(?:greatest hits|best of|the best|hits|collection|anthology|essential|essentials|gold|number ones|no\. 1s|platinum|ultimate|definitive|complete|singles|now that'?s what|compilation|various artists|\d{2,3} (?:hits|songs))\b|#1'?s\b/i;
const LIVE_RE = /\b(?:live|in concert|unplugged|mtv unplugged)\b/i;
const REMIX_RE = /\b(?:remix|mix|rmx|edit|dub|version)\b/i;

/** The junk words in a text, spelled one way ("Sing-Along" = "sing along", "Covers" = "cover"). */
function junkWords(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(JUNK_RE)) out.add(m[0].toLowerCase().replace(/[\s-]+/g, '').replace(/ies$/, 'y').replace(/s$/, ''));
  return out;
}

/** Artist names with symbols that search engines spell out ("P!nk", "Ke$ha"). */
function spellSymbols(s) {
  return String(s || '')
    .replace(/(\p{L})!(\p{L})/gu, '$1i$2')
    .replace(/(\p{L})\$(\p{L}|$)/gu, '$1s$2')
    .replace(/(\p{L})@(\p{L})/gu, '$1a$2');
}

const stripThe = (s) => String(s || '').replace(/^\s*the\s+/i, '').replace(/,\s*the\s*$/i, '');

const NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const NUMBER_RE = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;
const numerals = (s) => String(s || '').replace(NUMBER_RE, (w) => NUMBERS[w.toLowerCase()]);

/** similarity() of two names, also with number words as digits ("Jackson Five" = "Jackson 5"). */
function nameSimilarity(a, b) {
  const s = similarity(a, b);
  return s === 1 ? 1 : Math.max(s, similarity(numerals(a), numerals(b)));
}

const words = (s) => fold(s).split(' ').filter(Boolean);

/** Each credit in `short` is the last word(s) of a different credit in `long`. */
function tailsOf(short, long) {
  const used = new Set();
  return short.every((s) => {
    const sw = words(s);
    const i = long.findIndex((l, j) => {
      const lw = words(l);
      return !used.has(j) && sw.length > 0 && sw.length <= lw.length && lw.slice(-sw.length).join(' ') === sw.join(' ');
    });
    if (i >= 0) used.add(i);
    return i >= 0;
  });
}

/**
 * Duos and groups credited by surname: "Hall & Oates" = "Daryl Hall & John Oates". Both sides
 * need the same number (≥ 2) of performers, so "Queen" ≠ "Queen Latifah", "Oates" ≠ "John Oates".
 */
function surnameCredits(a, b) {
  return a.length > 1 && a.length === b.length && (tailsOf(a, b) || tailsOf(b, a));
}

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
  let best = nameSimilarity(full, query.artist);
  if (best === 1) return 1;
  const theirs = creditsOf(candidate);
  for (const mine of query.credits) {
    best = Math.max(best, nameSimilarity(full, mine));
    for (const t of theirs) best = Math.max(best, nameSimilarity(t, mine));
  }
  if (best < 0.9 && surnameCredits(query.credits, theirs)) best = 0.9;
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

/** The candidate's score before it is capped to 0..1 (so the album bonuses still rank a tie). */
function rawScore(c, query) {
  const a = artistSimilarity(c.artist, query);
  const t = titleSimilarity(c.title, query);
  if (a < 0.75 || t < 0.7) return 0;
  let score = 0.5 * a + 0.5 * t;
  const wanted = `${query.raw || query.title}`;
  // A junk word is fine when our own title or artist has it too ("Hello (Karaoke Version)",
  // "Cover Girls"); any other one means a cover or novelty version: never picked automatically.
  const ours = junkWords(`${wanted} ${query.artist || ''}`);
  const album = MUSIC_BOX_ALBUM_RE.test(c.album || '') ? c.album : String(c.album || '').replace(/\bmusic box\b/gi, ' ');
  const junk = junkWords(`${c.title} ${c.version || ''} ${album} ${c.artist}`);
  if ([...junk].some((w) => !ours.has(w))) score -= 0.5;
  if (LIVE_RE.test(`${c.title} ${c.version || ''} ${c.album || ''}`) && !LIVE_RE.test(wanted)) score -= 0.08;
  if (REMIX_RE.test(`${c.version || ''}`) && !/remaster/i.test(c.version || '') && !REMIX_RE.test(wanted)) score -= 0.05;
  if (c.albumType === 'compilation' || COMPILATION_RE.test(c.album || '')) score -= 0.04;
  if (query.duration > 0 && c.duration > 0) {
    const d = Math.abs(query.duration - c.duration);
    if (d <= 15) score += 0.04;
    else if (d > 60) score -= 0.08;
  }
  if (c.rank > 0) score += Math.min(0.03, (c.rank / 1_000_000) * 0.03);
  return Math.max(0, Math.round(score * 1000) / 1000);
}

/**
 * Scores a normalised candidate `{ artist, title, album?, version?, duration?, rank?, albumType? }`
 * against a song query. Returns 0 for "not this song", otherwise a confidence in 0..1.
 */
export function scoreCandidate(c, query) {
  return Math.min(1, rawScore(c, query));
}

/** Best candidate at or above `min` confidence, or null. */
export function pickBest(candidates, query, min = MIN_CONFIDENCE) {
  let best = null;
  for (const c of candidates || []) {
    const raw = rawScore(c, query);
    if (raw >= min && (!best || raw > best.raw)) best = { candidate: c, confidence: Math.min(1, raw), raw };
  }
  return best && { candidate: best.candidate, confidence: best.confidence };
}

/** Candidates sorted by score (for the host's "fix artwork" picker); keeps weak ones too. */
export function rankCandidates(candidates, query) {
  return (candidates || [])
    .map((c) => ({ c, raw: rawScore(c, query) }))
    .sort((x, y) => y.raw - x.raw)
    .map(({ c, raw }) => ({ ...c, confidence: Math.min(1, raw) }));
}

/**
 * 0..1: how well an artist's name matches `name` as a whole ("Elton John & Kiki Dee" is not
 * Kiki Dee, but "Daryl Hall & John Oates" is "Hall & Oates").
 */
export function artistNameScore(theirs, name) {
  const s = nameSimilarity(spellSymbols(stripThe(theirs)), spellSymbols(stripThe(name)));
  return s < 0.9 && surnameCredits(creditsOf(name), creditsOf(theirs)) ? 0.9 : s;
}

/** Artist search results: the one whose name matches best (≥ 0.8), or null. */
export function pickArtist(artists, name) {
  let best = null;
  for (const a of artists || []) {
    const s = artistNameScore(a.name, name);
    if (s >= 0.8 && (!best || s > best.score)) best = { artist: a, score: s };
  }
  return best?.artist || null;
}

// Separators between different acts in a credit ("A feat. B", "A with B", "A x B", "A vs. B").
// "&", "and", "+", "/" and commas also occur inside band names, so they don't count here.
const ACTS_RE = /\s+(?:feat\.?|ft\.?|featuring|with|w\/|vs\.?|versus|x)\s+/i;
const nameKey = (s) => compact(stripThe(spellSymbols(s))); // "&" = "and" (see fold)

/** The acts in a credit, lead first: "A feat. B, C & D" → ["A", "B, C & D"]. */
export function actsOf(credit) {
  return String(credit || '').replace(/\((?:duet|solo|trio)\)/gi, ' ').split(ACTS_RE).map((s) => s.trim()).filter(Boolean);
}

/**
 * The name to search artist databases for. The catalog splits credits into performers on "&",
 * "+", "/", "and" and commas, which also cuts band names apart ("Sam & Dave" → "Sam", "Dave";
 * "Earth, Wind & Fire" → "Earth", "Wind", "Fire"), and a search for such a part finds some other
 * artist of that name. So a performer that is never credited on its own is looked up by the act
 * it appears in, e.g. "Sam & Dave" (the most common one when there are several).
 * A whole act next to "feat.", "with"… is its own name ("DJ Snake feat. Lil Jon"), and so is each
 * performer in a featured list ("feat. Pharrell Williams, Katy Perry & Big Sean"), unless that
 * list leads one of the credits too: then it is a band ("Reba McEntire with Brooks & Dunn").
 * @param {{ name: string, solo?: number }} artist catalog artist
 * @param {string[]} credits the full artist credit of each of its songs
 */
export function artistSearchName(artist, credits = []) {
  if (artist.solo > 0 || !credits.length) return artist.name;
  const me = nameKey(artist.name);
  const parsed = credits.map((credit) => ({ credit: String(credit || '').trim(), acts: actsOf(credit) }));
  const leads = new Set(parsed.filter(({ acts }) => acts.length).map(({ acts }) => nameKey(acts[0])));
  const named = (act) => creditsOf(act).some((c) => nameKey(c) === me);
  const counts = new Map(); // act key → [spelling, songs]
  for (const { credit, acts } of parsed) {
    if (acts.some((act, i) => nameKey(act) === me || (i > 0 && !leads.has(nameKey(act)) && named(act)))) return artist.name;
    const act = acts.find(named) || credit;
    if (!act) continue;
    const k = nameKey(act);
    const c = counts.get(k);
    if (c) c[1]++;
    else counts.set(k, [act, 1]);
  }
  let best = artist.name;
  let n = 0;
  for (const [act, count] of counts.values()) if (count > n) { best = act; n = count; }
  return best;
}

/** True when two search names are the same apart from spelling details. */
export function sameSearchName(a, b) {
  return nameKey(a) === nameKey(b);
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
