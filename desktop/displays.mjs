// Where the desktop app puts the TV window. Pure functions on display lists shaped like
// Electron's ({ id, bounds: { x, y, width, height }, workArea? }), tested in test/desktop.test.js.

const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The display a window (its bounds) is on: the one holding its centre, else the one it overlaps most. */
export function displayFor(displays, rect) {
  if (!displays.length) return null;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const inside = displays.find(({ bounds: b }) => cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height);
  if (inside) return inside;
  return displays.reduce((best, d) => (overlap(d.bounds, rect) > overlap(best.bounds, rect) ? d : best), displays[0]);
}

/**
 * The display for the TV: the one it was on last time when that is still connected and isn't
 * the host window's, else the first one that isn't the host's (preferring one that isn't the
 * primary display). Null when every display is the host's: the TV opens as a normal window.
 */
export function tvDisplay(displays, hostId, { primaryId, rememberedId } = {}) {
  const others = displays.filter((d) => d.id !== hostId);
  if (!others.length) return null;
  return others.find((d) => d.id === rememberedId) || others.find((d) => d.id !== primaryId) || others[0];
}

/** The display after `currentId` (in the system's order), for "move the TV to the next screen". */
export function nextDisplay(displays, currentId) {
  if (!displays.length) return null;
  const i = displays.findIndex((d) => d.id === currentId);
  return displays[(i + 1) % displays.length];
}

/** A `width` × `height` window centred in the display's work area (shrunk to fit). */
export function centredBounds(display, width = 1280, height = 720) {
  const a = display.workArea || display.bounds;
  const w = Math.min(width, a.width);
  const h = Math.min(height, a.height);
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + (a.height - h) / 2), width: w, height: h };
}

/** Saved window bounds when most of them are still on a connected display, else null. */
export function visibleBounds(displays, rect) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !(rect.width > 0) || !(rect.height > 0)) return null;
  const seen = displays.reduce((sum, d) => sum + overlap(d.bounds, rect), 0);
  return seen >= area(rect) * 0.5 ? rect : null;
}
