// Do the TV's frames slow down while lyrics play? The frame-rate half of the automatic lighter
// effects (js/tv/lighter.js, docs/PLAN.md §9.5). Pure: no DOM, no imports (test/frame-watch.test.js).
//
// Each window of about 2 s (at least 8 frames) is judged by itself, against its own fastest
// frames: the screen's refresh is not known (the TV window can move to a 30 or 24 Hz TV mode, or
// from a 144 Hz monitor to a 60 Hz TV), and an all-time best would call every frame on the slower
// screen slow. A window is slow when its median frame gap is over 1.35× its fastest tenth (frames
// dropped now and then; never counted below 1000/60 ms, so 45 fps and up on a fast monitor is
// fine), or over 50 ms (under 20 frames a second on any screen). An even half rate (every frame
// two refreshes) looks the same as a 30 Hz TV and is not counted. Two slow windows in a row while
// lyrics play trip it: within about 4 s at any frame rate from 1 fps up.
const WINDOW_MS = 2000; // a window lasts this long…
const MIN_FRAMES = 8; // …with at least this many frames
const SLOWER = 1.35;
const FASTEST = 1000 / 60; // ms: faster frames are not needed for smooth lyrics
const SLOW_MS = 50;
const BREAK_MS = 1000; // a longer gap (a hidden page, a dialog, a busy moment) starts a new window

export class FrameWatch {
  constructor() {
    this.gaps = [];
    this.span = 0;
    this.last = null;
    this.lyrics = false;
    this.slow = 0; // slow windows in a row while lyrics play
  }

  /**
   * Every animation frame: its timestamp (ms), whether lyrics are on screen and playing, and
   * whether the page is visible. → null, or { fps, best } once two windows in a row with lyrics
   * were slow (fps: the slow window's median; best: its fastest frames).
   */
  frame(ts, lyricsPlaying, visible = true) {
    const gap = this.last === null ? Infinity : ts - this.last;
    this.last = ts;
    if (!visible || !(gap <= BREAK_MS) || lyricsPlaying !== this.lyrics) {
      this.gaps.length = 0;
      this.span = 0;
      this.lyrics = lyricsPlaying;
      return null;
    }
    this.gaps.push(gap);
    this.span += gap;
    if (this.span < WINDOW_MS || this.gaps.length < MIN_FRAMES) return null;
    const sorted = this.gaps.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const fast = Math.max(FASTEST, sorted[Math.floor(sorted.length / 10)]);
    this.gaps.length = 0;
    this.span = 0;
    if (!lyricsPlaying) return null;
    this.slow = median > SLOWER * fast || median > SLOW_MS ? this.slow + 1 : 0;
    return this.slow >= 2 ? { fps: 1000 / median, best: 1000 / fast } : null;
  }
}
