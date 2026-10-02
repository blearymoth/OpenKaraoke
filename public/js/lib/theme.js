// The app-wide skin in the browser (settings.appearance: { theme, accent }). The server writes
// the skin into <html> of every page (no flash of the other one); the host, TV and guest apps
// call applyAppearance() with each new state, before rendering it, to follow changes live.
// Screens without a live connection (landing page, PIN and can't-join screens) use
// followAppearance(). Colours live in /css/base.css; code that needs one as a value (QR codes)
// reads the token.
import { THEMES, normalizeAppearance, normalizeTheme, accentInk } from '/shared/themes.js';

const root = document.documentElement;
const tokens = new Map();
let applied = '';

/** Switches data-theme, the accent override, theme-color and the favicon when they changed. */
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
  for (const link of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) {
    if (link.getAttribute('href') !== THEMES[theme].icon) link.setAttribute('href', THEMES[theme].icon);
  }
  tokens.clear();
}

/** URL of the current skin's app icon, for places CSS can't swap it (a background image). */
export function appIcon() {
  return THEMES[normalizeTheme(root.dataset.theme)].icon;
}

const FOLLOW_MS = 2000;
let followers = 0;
let followTimer = 0;

/**
 * For screens with no live connection: checks the skin every few seconds (while the page is
 * visible) so a switch reaches them without a reload. Returns the function that stops it.
 */
export function followAppearance() {
  if (followers++ === 0) followTimer = setInterval(checkAppearance, FOLLOW_MS);
  let on = true;
  return () => {
    if (!on) return;
    on = false;
    if (--followers === 0) clearInterval(followTimer);
  };
}

async function checkAppearance() {
  if (document.hidden) return;
  try {
    const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
    if (followers) applyAppearance(info.appearance);
  } catch { /* the server is away: try again next time */ }
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
