// The app's HTML shells carry the current skin (settings.appearance) so the very first paint
// uses the right one: <html data-theme="…"> (+ the accent override as inline tokens), the
// browser's theme-color and the favicon. The apps then follow changes live (public/js/lib/theme.js).
import { THEMES, normalizeAppearance, accentInk } from '../../shared/themes.js';

/** `html` with the skin written into <html>, <meta name="theme-color"> and the favicon links. */
export function withAppearance(html, appearance) {
  const { theme, accent } = normalizeAppearance(appearance);
  const style = accent ? ` style="--neon: ${accent}; --neon-ink: ${accentInk(accent)};"` : '';
  return html
    .replace(/<html\b([^>]*)>/i, (_, attrs) => `<html${attrs.replace(/\s+(?:data-theme|style)="[^"]*"/gi, '')} data-theme="${theme}"${style}>`)
    .replace(/(<meta\s+name="theme-color"\s+content=")[^"]*(")/i, `$1${THEMES[theme].themeColor}$2`)
    .replace(/(<link\s+rel="(?:icon|apple-touch-icon)"\s+href=")\/img\/icon(?:-studio)?\.svg(")/gi, `$1${THEMES[theme].icon}$2`);
}

/** URL of the skin's app icon (for /favicon.ico). */
export function appIconUrl(appearance) {
  return THEMES[normalizeAppearance(appearance).theme].icon;
}

/** Short id of an appearance for ETags and cache keys: "studio", "party-00c2ff". */
export function appearanceVariant(appearance) {
  const { theme, accent } = normalizeAppearance(appearance);
  return accent ? `${theme}-${accent.slice(1)}` : theme;
}

// The "page not found" page has no stylesheet: its few colours per skin (Party's are the ones it always had).
const NOT_FOUND_COLORS = {
  studio: { bg: '#0a1120', ink: '#e8eef7' },
  party: { bg: '#0e0b16', ink: '#eee' },
};

/** A small self-contained "page not found" page in the current skin's colours. */
export function notFoundPage(appearance) {
  const { theme, accent } = normalizeAppearance(appearance);
  const c = NOT_FOUND_COLORS[theme];
  return `<!doctype html><html lang="en" data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found · OpenKaraoke</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:${c.bg};color:${c.ink};font:16px system-ui,sans-serif;text-align:center">
<div><div style="font-size:64px">🎤</div><h1 style="margin:.2em 0">Page not found</h1><p><a href="/" style="color:${accent || THEMES[theme].accent}">Go to the start page</a></p></div></body></html>`;
}
