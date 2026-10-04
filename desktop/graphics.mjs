// Graphics in the desktop app: which display system the app runs on (native Wayland or XWayland),
// whether this PC draws with its graphics card or in software, and whether the pages should use
// lighter effects. Pure functions (tested in test/desktop.test.js); desktop/main.mjs gathers the
// facts from Electron and shows them in Settings → About.
import { isSoftwareRenderer } from '../shared/graphics.js';

export const BACKENDS = ['auto', 'wayland', 'x11'];
export const LIGHTER = ['auto', 'on', 'off'];

/** The saved choices (userData/display.json), completed. */
export function displaySettings(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    backend: BACKENDS.includes(s.backend) ? s.backend : 'auto',
    lighter: LIGHTER.includes(s.lighter) ? s.lighter : 'auto',
  };
}

/**
 * The display system to run on. On a Wayland desktop the app runs natively, like Chrome (Electron's
 * own default): smooth, but Wayland doesn't let apps put a window on a screen of their choosing, so
 * the TV window is moved there by the person (one shortcut) and then goes full screen by itself.
 * XWayland ("x11") places the TV window by itself but can draw slowly on some PCs; it is a choice in
 * Settings → About (or OPENKARAOKE_X11=1). OPENKARAOKE_WAYLAND=1 and an explicit --ozone-platform
 * switch win over the saved choice.
 * → { kind: 'x11-session' | 'wayland' | 'xwayland' | 'other', relaunchX11, why }
 */
export function chooseBackend({ platform, env = {}, argv = [], saved = {} }) {
  if (platform !== 'linux') return { kind: 'other', relaunchX11: false, why: platform };
  if (env.XDG_SESSION_TYPE !== 'wayland' || !env.WAYLAND_DISPLAY) {
    return { kind: env.XDG_SESSION_TYPE === 'x11' || (!env.WAYLAND_DISPLAY && env.DISPLAY) ? 'x11-session' : 'other', relaunchX11: false, why: 'not a Wayland desktop' };
  }
  const given = argv.find((a) => a.startsWith('--ozone-platform='));
  if (given) return { kind: given === '--ozone-platform=x11' ? 'xwayland' : 'wayland', relaunchX11: false, why: 'command line' };
  if (env.OPENKARAOKE_WAYLAND) return { kind: 'wayland', relaunchX11: false, why: 'OPENKARAOKE_WAYLAND' };
  const x11 = !!env.OPENKARAOKE_X11 || displaySettings(saved).backend === 'x11';
  if (x11 && env.DISPLAY) return { kind: 'xwayland', relaunchX11: true, why: env.OPENKARAOKE_X11 ? 'OPENKARAOKE_X11' : 'Settings → About' };
  return { kind: 'wayland', relaunchX11: false, why: x11 ? 'no XWayland (DISPLAY is not set)' : 'default' };
}

/**
 * Does this PC draw with its graphics card? `features` = app.getGPUFeatureStatus(); `renderer` =
 * the WebGL renderer string a page sees ('' when WebGL is off). GPU compositing "enabled" alone
 * isn't proof (SwiftShader says enabled too), so a software renderer's name counts against it.
 * → { accelerated: true | false | null (not known yet), text }
 */
export function gpuVerdict({ features, renderer = '', ready = true }) {
  if (!ready || !features) return { accelerated: null, text: 'Checking…' };
  const compositing = String(features.gpu_compositing || '');
  if (!compositing.startsWith('enabled')) return { accelerated: false, text: 'Software rendering — no graphics acceleration (slow)' };
  if (isSoftwareRenderer(renderer)) return { accelerated: false, text: `Software rendering (${renderer}) — slow` };
  return { accelerated: true, text: 'Hardware accelerated' };
}

/** Lighter effects on the pages: always, never, or when the PC draws in software. */
export function useLighterEffects(setting, verdict) {
  const s = displaySettings({ lighter: setting }).lighter;
  if (s === 'on') return true;
  if (s === 'off') return false;
  return verdict?.accelerated === false;
}

/** The GPU process's refusal ("GPU access is disabled due to frequent crashes") in plain words. */
export function gpuInfoProblem(message) {
  const m = String(message || '');
  if (!m) return '';
  if (/disabled|not allowed/i.test(m)) return 'The graphics process is not in use (software compositing).';
  return m.slice(0, 200);
}

/** One line for the log file. */
export function graphicsLine(r) {
  const f = r.features || {};
  return [
    `display system ${r.kind}${r.ozone ? ` (ozone ${r.ozone})` : ''}`,
    `session ${r.session || '?'}`,
    `gpu_compositing ${f.gpu_compositing || '?'}`,
    `rasterization ${f.rasterization || '?'}`,
    `webgl ${f.webgl || '?'}`,
    r.renderer ? `renderer ${r.renderer}` : '',
    r.gpuProblem ? `(${r.gpuProblem})` : '',
    `lighter effects ${r.lighter ? 'on' : 'off'}`,
  ].filter(Boolean).join(', ');
}
