// Browse filters (isomorphic): decades, genres, tags and version types, several values each.
// A song passes when it matches one value of every filter that has values (OR within a filter,
// AND across filters). In a URL each value is its own parameter: ?decade=1980&decade=1990&tag=Duets.

/** What a version can offer, found in the file names (and the file type for videos). */
export const VERSION_FILTERS = [
  { id: 'mpx', label: 'Guide singer', hint: 'Multiplex: the original singer on a channel of its own' },
  { id: 'bgv', label: 'With backing vocals' },
  { id: 'nobgv', label: 'No backing vocals' },
  { id: 'video', label: 'Music video' },
];
const VERSION_IDS = new Set(VERSION_FILTERS.map((v) => v.id));

/** Filter → its URL parameter name. */
export const FILTER_PARAMS = { decades: 'decade', genres: 'genre', tags: 'tag', versions: 'version' };
export const MAX_FILTER_VALUES = 12;
const MAX_TEXT = 60;

export const emptyFilters = () => ({ decades: [], genres: [], tags: [], versions: [] });

const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '');
const decade = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1900 && n <= 2090 && n % 10 === 0 ? n : 0;
};
/** Valid, unique and sorted, so the same choice always gives the same filter (and cache key). */
const clean = (values, one) => {
  const out = [];
  for (const v of values) {
    const x = one(v);
    if (x && !out.includes(x)) out.push(x);
    if (out.length >= MAX_FILTER_VALUES) break;
  }
  return out.sort((a, b) => (typeof a === 'number' ? a - b : a.localeCompare(b)));
};

/**
 * Filters from URL parameters (`URLSearchParams`, or anything with `getAll`). Unknown version
 * types, odd decades and over-long names are dropped.
 */
export function readFilters(params) {
  const all = (name) => (typeof params?.getAll === 'function' ? params.getAll(name) : []);
  return {
    decades: clean(all('decade'), decade),
    genres: clean(all('genre'), text),
    tags: clean(all('tag'), text),
    versions: clean(all('version'), (v) => (VERSION_IDS.has(v) ? v : '')),
  };
}

/** The same filters, cleaned (e.g. a state object kept by a page). */
export function cleanFilters(f = {}) {
  return {
    decades: clean(f.decades || [], decade),
    genres: clean(f.genres || [], text),
    tags: clean(f.tags || [], text),
    versions: clean(f.versions || [], (v) => (VERSION_IDS.has(v) ? v : '')),
  };
}

/** URL parameters for `f`: `{ decade: [1980, 1990], tag: ['Duets'] }` (empty filters left out). */
export function filterParams(f) {
  const out = {};
  for (const [key, name] of Object.entries(FILTER_PARAMS)) if (f?.[key]?.length) out[name] = f[key].map(String);
  return out;
}

export const filterCount = (f) => Object.keys(FILTER_PARAMS).reduce((n, k) => n + (f?.[k]?.length || 0), 0);

/** Adds or removes one value of one filter (a new object). */
export function toggleFilter(f, key, value) {
  const list = f[key] || [];
  const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  return cleanFilters({ ...f, [key]: next });
}

export const decadeLabel = (d) => (d >= 2000 ? `${d}s` : `’${String(d).slice(2)}s`);
export const versionLabel = (id) => VERSION_FILTERS.find((v) => v.id === id)?.label || id;
