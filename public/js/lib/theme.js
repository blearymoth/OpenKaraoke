// The app-wide skin in the browser (settings.appearance: { theme, accent }). The server writes
// the skin into <html> of every page (no flash of the other one); the host, TV and guest apps
// call applyAppearance() with each new state, before rendering it, to follow changes live.
// Colours live in /css/base.css; code that needs one as a value (QR codes) reads the token.
import { THEMES, normalizeAppearance, accentInk } from '/shared/themes.js';

const root = document.documentElement;
const tokens = new Map();
let applied = '';

/** Switches data-theme, the accent override and theme-color when they changed. */
export function applyAppearance(appearance) {
  if (!appearance) return;
  const { theme, accent } = normalizeAppearance(appearance);
  const key = `${theme}|${accent}`;
  if (key === applied && root.dataset.theme === theme) return;
  applied = key;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  if (accent) {
    root.style.setProperty('--neon', accent);
    root.style.setProperty('--neon-ink', accentInk(accent));
  } else {
    root.style.removeProperty('--neon');
    root.style.removeProperty('--neon-ink');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEMES[theme].themeColor;
  tokens.clear();
}

/** The current value of a CSS token on <html>, e.g. token('--qr-dark'). */
export function token(name) {
  if (tokens.has(name)) return tokens.get(name);
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  if (value) tokens.set(name, value); // not before the stylesheet has loaded
  return value;
}

/** URL of a QR code image drawn in the skin's QR colours (dark on paper). */
export function qrSrc(text) {
  return `/api/qr.svg?margin=0&dark=${encodeURIComponent(token('--qr-dark'))}&light=${encodeURIComponent(token('--qr-light'))}&text=${encodeURIComponent(text)}`;
}
