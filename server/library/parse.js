// Turns karaoke file names such as
//   "Adele - Someone Like You [SF Karaoke]"
//   "SC8123-05 - Adele - Hello"
//   "AX-28794 - A Sky Full Of Stars [Coldplay]"
// into structured song information.

import { fold, compact, splitCredits } from '../../shared/text.js';

export const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);
export const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'mpg', 'mpeg', 'wmv', 'flv', 'vob']);
// Formats Chromium-based browsers can normally play directly.
export const BROWSER_VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv']);

const LANG_WORDS = {
  spanish: 'Spanish', mexicana: 'Spanish', mexican: 'Spanish', espanol: 'Spanish', latino: 'Spanish',
  french: 'French', francais: 'French', german: 'German', deutsch: 'German', italian: 'Italian',
  danish: 'Danish', swedish: 'Swedish', svenska: 'Swedish', norwegian: 'Norwegian', maltese: 'Maltese',
  hebrew: 'Hebrew', hewbrew: 'Hebrew', jewish: 'Hebrew', greek: 'Greek', netherlands: 'Dutch', dutch: 'Dutch',
  maori: 'Maori', portuguese: 'Portuguese', brazilian: 'Portuguese', polish: 'Polish', finnish: 'Finnish',
  japanese: 'Japanese', korean: 'Korean', chinese: 'Chinese', russian: 'Russian', turkish: 'Turkish',
  welsh: 'Welsh', tagalog: 'Tagalog', filipino: 'Tagalog', hindi: 'Hindi', cantare: 'Spanish',
};
const COLLECTION_WORDS = {
  disney: 'Disney', 'care bears': 'Kids', childrens: 'Kids', children: 'Kids', kids: 'Kids',
  'karaoke kid': 'Kids', eurovision: 'Eurovision', celtic: 'Celtic', irish: 'Irish', scottish: 'Scottish',
  australian: 'Australian', austrailian: 'Australian', aussie: 'Australian', traditional: 'Traditional',
  christmas: 'Christmas', country: 'Country',
};

const BRAND_ALIASES = {
  'rox box': 'Rok Box', 'rok box': 'Rok Box', 'singers c': "Singer's Choice", "singer's c": "Singer's Choice",
  'singer choice': "Singer's Choice", 'singers choice': "Singer's Choice", singc: "Singer's Choice",
  austrailian: 'Australian', atoy: 'Atoy', zoom: '#Z', 'z': '#Z', hewbrew: 'Hebrew', mega: 'MEGA',
};

// Labels we can name with confidence (shown as tooltips / in the versions list).
export const BRAND_NAMES = {
  SF: 'Sunfly', SC: 'Sound Choice', CB: 'Chartbuster', '#Z': 'Zoom', PHM: 'Pop Hits Monthly',
  THM: 'Top Hits Monthly', SBI: 'SBI', JVC: 'JVC', 'Rok Box': 'Rok Box', 'Silver Saddle': 'Silver Saddle',
  DK: 'DK Karaoke', Disney: 'Disney', "Singer's Choice": "Singer's Choice", NU: 'Nu Tech',
};

const DISC_ID_RE = /^(?:[A-Z]{1,6}[- ]?\d{2,6}(?:[- ]?\d{1,3})?|\d{3,6}-\d{1,3})$/i;

const DISNEY_RE = /\b(?:disney|frozen|moana|encanto|aladdin|little mermaid|lion king|beauty and the beast|mulan|pocahontas|hercules|tangled|toy story|the jungle book|jungle book|mary poppins|high school musical|hannah montana|camp rock|descendants|zombies|coco|zootopia|the princess and the frog|cinderella|snow white|sleeping beauty|peter pan|dumbo|bambi|pinocchio|the aristocats|101 dalmatians|lilo|brave|wreck it ralph|big hero)\b/i;
const MUSICAL_RE = /\b(?:musical|broadway|west end|a chorus line|les miserables|phantom of the opera|wicked|grease|hamilton|mamma mia|cats|evita|chicago|rent|hairspray|west side story|sound of music|oliver|annie|greatest showman|dear evan hansen|jersey boys|joseph and|jesus christ superstar|miss saigon|fiddler on the roof|my fair lady|cabaret|guys and dolls|kiss me kate|south pacific|oklahoma|carousel|aspects of love|a little night music|annie get your gun|anything goes|42nd street|aida|aint misbehavin|rocky horror|little shop of horrors|sweeney todd|into the woods|dreamgirls|book of mormon|waitress|matilda|starlight express|blood brothers|we will rock you|priscilla|legally blonde|avenue q|the king and i|showboat|show boat|funny girl|hello dolly|mame|pippin|godspell|hair|company|follies|a star is born)\b/i;
const CHRISTMAS_RE = /\b(?:christmas|xmas|x mas|santa|jingle bell|jingle bells|noel|navidad|rudolph|sleigh ride|mistletoe|snowman|silent night|holy night|let it snow|winter wonderland|deck the hall|deck the halls|little drummer boy|frosty|feliz navidad|white christmas|holly jolly|nutcracker|joy to the world|hark the herald|o come all ye|away in a manger|we wish you a merry|auld lang syne|carol of the bells|the first noel|god rest ye)\b/i;
const KIDS_RE = /\b(?:barney|sesame street|wiggles|nursery|childrens|children s|kids|kidz|baby shark|peppa|teletubbies|smurfs|chipmunks|alvin and the|pokemon|paw patrol|bob the builder|thomas the tank|care bears|muppets|kermit|spongebob|barbie|my little pony|twinkle twinkle|old macdonald|wheels on the bus|itsy bitsy|hokey cokey|hokey pokey|if youre happy)\b/i;

// Parenthetical annotations that describe the track rather than the song.
const ANNOTATIONS = [
  [/^(?:(?:m|f|male|female)\s*[-/&]\s*(?:m|f|male|female)\s+)?duet(?:\s+version)?$|^duet with .*$/i, (o) => { o.flags.duet = true; }],
  [/^(?:male\s+|female\s+)?solo(?:\s+version)?$/i, (o) => { o.flags.solo = true; }],
  [/^trio$/i, (o) => { o.flags.trio = true; }],
  [/^(?:explicit(?:\s+(?:xxx|implied|version|lyrics))?|xxx|dirty|uncensored|adult(?:\s+version)?|explicit xxx)$/i, (o) => { o.flags.explicit = true; }],
  [/^(?:clean(?:\s+(?:version|ver\.?|edit))?|radio\s+edit|censored|family\s+friendly)$/i, (o) => { o.flags.clean = true; }],
  [/^(?:with\s+|w\/?\s*)?(?:lead\s+)?(?:vocals?|vocal\s+guide|voc)$|^con\s+voz$|^with\s+vocals?$|^wvocals?$|^vocal\s+version$/i, (o) => { o.flags.vocals = true; }],
  [/^(?:w\/?\s*bgv|wbgv|with\s+(?:backing|background)\s+vocals?|bgv|wbuv|with\s+harmony|with\s+bgv)$/i, (o) => { o.flags.bgv = true; }],
  [/^(?:wobgv|w\/?o\s*bgv|no\s+(?:backing|background)\s+vocals?|without\s+(?:backing|background)\s+vocals?|no\s+harmony|no\s+bgv)$/i, (o) => { o.flags.nobgv = true; }],
  [/^(?:multiplex|mpx|multi\s*plex)$/i, (o) => { o.flags.mpx = true; }],
  [/^\d{2,3}\s*kbps$/i, () => {}],
  [/^(?:karaoke(?:\s+version)?|instrumental(?:\s+version)?|backing\s+track|in\s+the\s+style\s+of.*|made\s+famous\s+by.*)$/i, () => {}],
  [/^(?:spanish|french|german|italian|english|danish|swedish|norwegian|dutch|portuguese|hebrew)(?:\s+version)?$/i, (o, text) => {
    const w = fold(text).split(' ')[0];
    if (LANG_WORDS[w]) o.tags.add(LANG_WORDS[w]);
    else if (w === 'english') o.tags.add('English');
    o.variant.push(text);
  }],
];

const VARIANT_RE = /\b(?:live|acoustic|acoustative|unplugged|remix(?:ed)?|re mixed|rmx|mix|version|ver|edit|reprise|medley|megamix|extended|radio|original|demo|remaster(?:ed)?|orchestral|piano|a\s?capp?ella|reggae|country|dance|salsa|tango|slow|fast|short|long|film|movie|show|tv|theme|part\s*\d+|pt\.?\s*\d+|intro|outro|key|lower|higher|style|live lounge|special|single|album|vr)\b/i;
const KEEP_IN_KEY_RE = /\b(?:part\s*\d+|pt\.?\s*\d+)\b/i;

function normalizeSpaces(s) {
  return String(s).normalize('NFC').replace(/[_ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalBrand(raw) {
  let b = normalizeSpaces(raw).replace(/^[\[(]+|[\])]+$/g, '').trim();
  if (!b) return '';
  const low = b.toLowerCase();
  if (BRAND_ALIASES[low]) return BRAND_ALIASES[low];
  // Upper-case short codes ("sc" -> "SC", "#me" -> "#ME")
  if (/^#?[a-z0-9]{1,5}$/i.test(b)) return b.toUpperCase();
  return b.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Matches a word that *looks like* "Karaoke", including typos and truncation
// seen in real collections ("Karaaoke", "Karoke", "Kararoke", "Karaolke", "Kar").
const KARAOKE_WORD = /\bk\s?a\s?r(?:a|o|r|l|e|k)*[a-z]*\.?$/i;

const isKaraokePrefix = (w) => w.length >= 1 && 'karaoke'.startsWith(w.toLowerCase().replace(/\.$/, ''));

/** Returns { brand, rest } if the string ends with a karaoke label tag. */
export function extractBrand(s) {
  // 1) "... [SF Karaoke]" / "... (Zoom Karaoke)" / truncated "... [SBI Kar" / "[SCKaraoke]"
  const open = Math.max(s.lastIndexOf('['), s.lastIndexOf('('));
  if (open > 0) {
    const closed = /[\])]\s*$/.test(s);
    const inner = s.slice(open + 1).replace(/[\])]\s*$/, '').trim();
    const words = inner.split(/\s+/).filter(Boolean);
    const last = words[words.length - 1] || '';
    if (inner.length <= 40 && KARAOKE_WORD.test(last) && /^k/i.test(last)) {
      return { brand: canonicalBrand(words.slice(0, -1).join(' ')), rest: s.slice(0, open).trim() };
    }
    const glued = /^(#?[A-Z0-9]{1,6})kara+o?l?k?e?$/i.exec(last);
    if (inner.length <= 40 && glued && closed) {
      return { brand: canonicalBrand([...words.slice(0, -1), glued[1]].join(' ')), rest: s.slice(0, open).trim() };
    }
    // Unterminated bracket near the end is a truncated tag ("[SC K", "[Singers C").
    if (s[open] === '[' && !closed && !s.slice(open).includes(']') && s.length - open <= 18) {
      const tagWords = isKaraokePrefix(last) && words.length > 1 ? words.slice(0, -1) : words;
      const maybe = tagWords.join(' ');
      return { brand: maybe.length <= 14 ? canonicalBrand(maybe) : '', rest: s.slice(0, open).trim() };
    }
  }
  // 2) "... CB Karaoke]" (opening bracket missing)
  const m = /^(.*?)\s+(\S{1,12})\s+Karaoke\]\s*$/i.exec(s);
  if (m) return { brand: canonicalBrand(m[2]), rest: m[1].trim() };
  return null;
}

function classifyAnnotation(o, text) {
  const t = text.trim();
  if (!t) return 'drop';
  for (const [re, apply] of ANNOTATIONS) {
    if (re.test(t)) { apply(o, t); return 'drop'; }
  }
  if (VARIANT_RE.test(t)) { o.variant.push(t); return KEEP_IN_KEY_RE.test(t) ? 'keep-key' : 'variant'; }
  return 'keep';
}

/**
 * Strips recognised annotations from a title/artist string.
 * Returns { display, base } where `base` has every parenthetical removed
 * except ones that should stay part of the grouping key.
 */
function stripAnnotations(o, str) {
  let display = str;
  let base = str;
  const re = /\s*(\(([^()]*)\)|\[([^\[\]]*)\])/g;
  const parts = [];
  let m;
  while ((m = re.exec(str))) parts.push({ whole: m[0], inner: m[2] ?? m[3] ?? '' });
  for (const p of parts) {
    const kind = classifyAnnotation(o, p.inner);
    if (kind === 'drop') {
      display = display.replace(p.whole, ' ');
      base = base.replace(p.whole, ' ');
    } else if (kind === 'variant' || kind === 'keep') {
      // Sub-titles such as "Heroes (We Could Be)" stay visible but do not split versions.
      base = base.replace(p.whole, ' ');
      if (p.whole.trim().startsWith('[')) display = display.replace(p.whole, ` (${p.inner.trim()})`);
    } else if (kind === 'keep-key') {
      base = base.replace(p.whole, ' ' + p.inner + ' ');
      if (p.whole.trim().startsWith('[')) display = display.replace(p.whole, ` (${p.inner.trim()})`);
    }
  }
  // Also catch a trailing unbracketed "- Live" / "- Acoustic Version".
  const dash = / - ((?:live|acoustic|remix|radio edit|single version|extended mix)[^-]*)$/i.exec(display);
  if (dash) { o.variant.push(dash[1]); base = base.replace(dash[0], ' '); }
  return { display: normalizeSpaces(display).replace(/\s+([,.!?])/g, '$1'), base: normalizeSpaces(base) };
}

function letterOf(name) {
  const c = fold(name).charAt(0);
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
}

/**
 * Parse a file base name (without extension).
 * @param {string} baseName
 * @param {string} dirName parent folder name, used when the file name has no artist.
 */
export function parseName(baseName, dirName = '') {
  const o = { artist: '', title: '', brand: '', discId: '', variant: [], flags: {}, tags: new Set() };
  let s = normalizeSpaces(baseName);

  const b = extractBrand(s);
  if (b) { o.brand = b.brand; s = b.rest; }

  let artist = '';
  let title = '';
  let sep = s.indexOf(' - ');
  if (sep > 0) {
    artist = s.slice(0, sep);
    title = s.slice(sep + 3);
  } else {
    const m = /^(.+?)\s+-(\S.*)$|^(.+?\S)-\s+(.+)$/.exec(s);
    if (m) { artist = m[1] || m[3]; title = m[2] || m[4]; }
    else {
      const folder = normalizeSpaces(dirName);
      artist = folder && folder.length > 1 ? folder : '';
      title = s;
    }
  }
  artist = artist.trim().replace(/^(.+?),\s*the$/i, 'The $1'); // "Beatles, The" -> "The Beatles"
  title = title.trim();

  // "SC8123-05 - Artist - Title"
  if (DISC_ID_RE.test(artist) && title.includes(' - ')) {
    o.discId = artist;
    sep = title.indexOf(' - ');
    artist = title.slice(0, sep).trim();
    title = title.slice(sep + 3).trim();
  }
  // "Artist - Title - SC8123-05"
  const tailId = / - ([A-Z]{1,6}[- ]?\d{2,6}(?:[- ]?\d{1,3})?)$/i.exec(title);
  if (tailId && DISC_ID_RE.test(tailId[1])) {
    o.discId = o.discId || tailId[1];
    title = title.slice(0, tailId.index).trim();
  }
  // "AX-28794 - A Sky Full Of Stars [Coldplay]" -> the bracket holds the artist
  if (DISC_ID_RE.test(artist)) {
    const br = /\s*\[([^\[\]]+)\]\s*$/.exec(title);
    if (br && !VARIANT_RE.test(br[1]) && !/explicit|clean|duet/i.test(br[1])) {
      o.discId = o.discId || artist;
      artist = br[1].trim();
      title = title.slice(0, br.index).trim();
    }
  }

  // The brand may also name a language or collection ("[Spanish Karaoke]").
  if (o.brand) {
    const bl = fold(o.brand);
    for (const w of bl.split(' ')) {
      if (LANG_WORDS[w]) o.tags.add(LANG_WORDS[w]);
    }
    if (COLLECTION_WORDS[bl]) o.tags.add(COLLECTION_WORDS[bl]);
    for (const w of bl.split(' ')) if (COLLECTION_WORDS[w]) o.tags.add(COLLECTION_WORDS[w]);
  }

  const a = stripAnnotations(o, artist);
  const t = stripAnnotations(o, title);
  o.artist = a.display || 'Unknown Artist';
  o.title = t.display || s || baseName;
  o.baseTitle = t.base || o.title;
  o.baseArtist = a.base || o.artist;

  // Collections inferred from names
  const hay = fold(o.artist + ' ' + o.title);
  if (CHRISTMAS_RE.test(hay)) o.tags.add('Christmas');
  if (DISNEY_RE.test(fold(o.artist)) || /disney/i.test(o.brand)) o.tags.add('Disney');
  if (MUSICAL_RE.test(fold(o.artist)) || /\(musical\)/i.test(artist)) o.tags.add('Musicals');
  if (KIDS_RE.test(hay)) o.tags.add('Kids');
  if (/\+/.test(o.title) && o.title.split('+').length >= 3 || /\b(?:medley|megamix|mega mix)\b/i.test(o.title + ' ' + o.variant.join(' '))) {
    o.flags.medley = true;
  }
  const credits = splitCredits(o.baseArtist);
  const bandLike = /\s(?:&|and|\+)\s+the\s/i.test(o.baseArtist);
  if (!o.flags.solo && (o.flags.duet || (credits.length >= 2 && !bandLike
      && /\s(?:&|and|with|duet)\s/i.test(o.baseArtist) && !/\s(?:feat\.?|ft\.?|featuring)\s/i.test(o.baseArtist)))) {
    o.tags.add('Duets');
  }
  if (o.flags.medley) o.tags.add('Medleys');
  if (o.flags.explicit) o.tags.add('Explicit');
  for (const v of o.variant) {
    if (/\blive\b/i.test(v)) o.flags.live = true;
    if (/acoustic|unplugged|acoustative/i.test(v)) o.flags.acoustic = true;
  }

  o.credits = credits;
  o.letter = letterOf(o.artist);
  o.tags = [...o.tags];
  o.variant = [...new Set(o.variant.map((v) => normalizeSpaces(v)))];
  for (const k of Object.keys(o.flags)) if (!o.flags[k]) delete o.flags[k];
  return o;
}

/** Artist key used for grouping: order independent set of credited performers. */
export function artistKeyOf(baseArtist) {
  const credits = splitCredits(baseArtist).map((c) => compact(c.replace(/^the\s+|,\s*the$/i, ''))).filter(Boolean);
  if (!credits.length) return compact(baseArtist) || 'unknown';
  return [...new Set(credits)].sort().join('+');
}

/** Title key used for grouping versions of the same song. */
export function titleKeyOf(baseTitle) {
  return compact(String(baseTitle).replace(/^the\s+/i, '')) || compact(baseTitle) || 'untitled';
}
