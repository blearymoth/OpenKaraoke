// App-wide skins (settings.appearance). The colours themselves live in /css/base.css as tokens;
// this file names the skins and carries the few values needed outside CSS (validated server-side,
// the browser's theme-color, the accent picker's starting value). Keep them in sync with base.css
// (test/themes.test.js checks it).
import { contrastText } from './text.js';

export const THEMES = {
  studio: {
    name: 'Studio',
    description: 'Calm graphite and one clear accent. Easy to read, easy on the eyes.',
    themeColor: '#0f1216', // --night
    accent: '#6ea8fe', // --neon
  },
  party: {
    name: 'Party',
    description: 'Neon pink, night-club purple and marquee lights.',
    themeColor: '#150f26',
    accent: '#ff3d8b',
  },
};

export const THEME_IDS = Object.keys(THEMES);
export const DEFAULT_THEME = 'studio';
export const ACCENT_RE = /^#[0-9a-f]{6}$/i;

/** A known skin id; anything else is the default skin. */
export function normalizeTheme(theme) {
  return typeof theme === 'string' && Object.hasOwn(THEMES, theme) ? theme : DEFAULT_THEME;
}

/** '#rrggbb' in lower case, or '' (= the skin's own accent) for anything else. */
export function normalizeAccent(accent) {
  return typeof accent === 'string' && ACCENT_RE.test(accent) ? accent.toLowerCase() : '';
}

/** Readable text colour on an accent-coloured button. */
export function accentInk(accent) {
  return contrastText(accent);
}

/** { theme, accent } with both fields valid. */
export function normalizeAppearance(appearance) {
  return { theme: normalizeTheme(appearance?.theme), accent: normalizeAccent(appearance?.accent) };
}
