// The browse filters' panel and chips (host Browse page, guest Songs tab): decades, genres,
// collections (tags from the file names) and version types, several values each
// (shared/filters.js: one of a filter's values must match, and every filter that has some).
import { html } from '../vendor/preact.js';
import { VERSION_FILTERS, FILTER_PARAMS, decadeLabel, versionLabel, toggleFilter } from '/shared/filters.js';

// The "Guide singer" version type says the same as the Multiplex collection.
const HIDDEN_TAGS = ['Multiplex'];

/** Each filter's choices: what the library has (with counts), plus anything already chosen. */
export function filterChoices(facets, value, { hideTags = [] } = {}) {
  const hide = new Set([...HIDDEN_TAGS, ...hideTags]);
  const withChosen = (list, chosen) => [...list, ...chosen.filter((v) => !list.some((x) => x.value === v)).map((v) => ({ value: v, count: null }))];
  return {
    decades: withChosen((facets?.decades || []).map((d) => ({ value: d.decade, count: d.count })), value.decades)
      .sort((a, b) => a.value - b.value),
    genres: withChosen((facets?.genres || []).map((g) => ({ value: g.genre, count: g.count })), value.genres),
    tags: withChosen((facets?.tags || []).filter((t) => !hide.has(t.tag)).map((t) => ({ value: t.tag, count: t.count })), value.tags),
    versions: withChosen(VERSION_FILTERS.map((v) => ({ value: v.id, count: facets?.versions?.find((x) => x.id === v.id)?.count || 0 }))
      .filter((v) => v.count), value.versions),
  };
}

export const filterLabel = (key, v) => (key === 'decades' ? decadeLabel(v) : key === 'versions' ? versionLabel(v) : String(v));

/** One toggle chip of a filter (aria-pressed); the count is the library's, not the filtered one. */
export function FilterChip({ k, item, value, onChange }) {
  const on = value[k].includes(item.value);
  return html`<button type="button" class=${`chip ${on ? 'on' : ''}`} aria-pressed=${on} data-filter=${FILTER_PARAMS[k]}
    onClick=${() => onChange(toggleFilter(value, k, item.value))}>${filterLabel(k, item.value)}${item.count ? html` <span class="faint">${item.count.toLocaleString()}</span>` : ''}</button>`;
}

const GROUPS = [['decades', 'Decade'], ['genres', 'Genre'], ['tags', 'Collections'], ['versions', 'Versions']];

/**
 * Every filter as groups of toggle chips. `metaHint`: what to say while no song has a year or
 * genre yet (they come from the online song information).
 */
export function FilterPanel({ facets, value, onChange, hideTags, metaHint }) {
  const choices = filterChoices(facets, value, { hideTags });
  const noMeta = !choices.decades.length && !choices.genres.length;
  return html`<div class="filter-panel">
    ${GROUPS.map(([k, title]) => choices[k].length > 0 && html`<fieldset class="filter-group" key=${k}>
      <legend>${title}</legend>
      <div class="filter-chips">${choices[k].map((item) => html`<${FilterChip} key=${item.value} k=${k} item=${item} value=${value} onChange=${onChange} />`)}</div>
    </fieldset>`)}
    ${noMeta && metaHint && html`<p class="hint">${metaHint}</p>`}
  </div>`;
}
