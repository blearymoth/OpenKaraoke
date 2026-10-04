// Lighter effects on any TV page (docs/PLAN.md §9): still backgrounds and no blur (tv.css, under
// html.lite-auto), so the lyrics stay smooth on a PC that draws without graphics acceleration.
// The desktop app puts its own .lite-fx on its windows (desktop/main.mjs); this covers Chrome in
// kiosk mode (bin/open-tv.sh) and any other browser. display.lighterEffects: 'on' always, 'off'
// never, 'auto' when the browser draws in software or the frames slow down while lyrics play —
// unless the desktop app's choice for this PC is "off" (<html data-lighter="off">). Once tripped,
// the automatic ones stay on until the page reloads.
import { isSoftwareRenderer } from '/shared/graphics.js';
import { normalizeLighterEffects } from '/shared/lyrics.js';
import { FrameWatch } from './frame-watch.js';

/** Why this browser draws in software ('' when it doesn't): from a throwaway WebGL context. */
export function softwareRenderer() {
  try {
    // The browser refuses a context that would be much slower than usual (drawn in software).
    const gl = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!gl) return 'no graphics acceleration';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return isSoftwareRenderer(name) ? name : '';
  } catch {
    return '';
  }
}

export class LighterEffects {
  /** auto: whether this page may decide by itself (not the host's preview or the queue board). */
  constructor({ root = document.documentElement, auto = true } = {}) {
    this.root = root;
    this.auto = auto;
    this.setting = 'auto';
    this.reason = '';
    if (auto) {
      const software = softwareRenderer();
      if (software) this.reason = `the browser draws in software: ${software}`;
    }
    this.watch = new FrameWatch(); // frames slowing down while lyrics play (js/tv/frame-watch.js)
    this.apply();
  }

  /** display.lighterEffects from the party settings. */
  set(setting) {
    setting = normalizeLighterEffects(setting);
    if (setting === this.setting) return;
    this.setting = setting;
    this.apply();
  }

  /** Every animation frame: its timestamp, and whether lyrics are on screen and playing. */
  frame(ts, lyricsPlaying) {
    if (!this.auto) return;
    if (this.reason) {
      this.apply(); // (the desktop app marks the page with its choice after it has started)
      return;
    }
    const slow = this.watch.frame(ts, lyricsPlaying, document.visibilityState === 'visible');
    if (slow) {
      this.reason = `${Math.round(slow.fps)} frames a second with lyrics, ${Math.round(slow.best)} at best`;
      this.apply();
    }
  }

  apply() {
    const auto = this.setting === 'auto' && !!this.reason && this.root.dataset.lighter !== 'off';
    const on = this.setting === 'on' || auto;
    if (this.root.classList.contains('lite-auto') !== on) this.root.classList.toggle('lite-auto', on);
    if (auto && this.root.dataset.liteReason !== this.reason) {
      this.root.dataset.liteReason = this.reason;
      console.info(`OpenKaraoke TV: lighter effects (${this.reason})`);
    }
  }
}
