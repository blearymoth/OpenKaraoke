// App-wide skins (settings.appearance). The colours themselves live in /css/base.css as tokens;
// this file names the skins and carries the few values needed outside CSS (validated server-side,
// the browser's theme-color, the accent picker's starting value). Keep them in sync with base.css
// (test/themes.test.js checks it).
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

/** WCAG relative luminance of '#rrggbb'. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const DARK_INK = luminance('#111111');

/**
 * Text colour on an accent-coloured button: near-black or white, whichever has the higher WCAG
 * contrast against the accent (sky blue or green get dark text, deep blue gets white).
 */
export function accentInk(accent) {
  if (!ACCENT_RE.test(accent || '')) return '#fff';
  const l = luminance(accent);
  return (l + 0.05) / (DARK_INK + 0.05) > 1.05 / (l + 0.05) ? '#111' : '#fff';
}

/** { theme, accent } with both fields valid. */
export function normalizeAppearance(appearance) {
  return { theme: normalizeTheme(appearance?.theme), accent: normalizeAccent(appearance?.accent) };
}
