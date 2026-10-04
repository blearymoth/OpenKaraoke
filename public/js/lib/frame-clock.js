// The lyrics' clock (docs/PLAN.md §9). Each animation frame moves on by the frame's own duration
// (requestAnimationFrame timestamps are vsync-aligned, so the steps are even) and is pulled
// gently towards the media clock, which jitters: getOutputTimestamp extrapolation, <audio>
// currentTime granularity and, on mirrors, a re-anchor every 250 ms with Wi-Fi latency. It never
// steps back while playing (a backward step made the CD+G decoder replay the song from the
// start); a larger difference is a seek, a pause or a new song, and is followed at once.
// Pure: no DOM.
export class FrameClock {
  constructor({ gain = 0.08, snap = 0.25 } = {}) {
    this.gain = gain; // share of the error corrected per frame (at 60 fps it settles in about 0.25 s)
    this.snap = snap; // seconds: a bigger difference is jumped to
    this.reset();
  }

  reset() {
    this.t = null;
    this.ts = 0;
  }

  /**
   * frameTs: the requestAnimationFrame timestamp (ms); media: the media clock (s); rate: the
   * tempo; playing. → the time to draw (s).
   */
  tick(frameTs, media, rate = 1, playing = true) {
    if (!Number.isFinite(media)) {
      this.t = null; // nothing to follow: start again from the next real time
      return media;
    }
    if (this.t === null || !playing || !Number.isFinite(frameTs)) {
      this.t = media;
      this.ts = frameTs;
      return media;
    }
    const predicted = this.t + ((frameTs - this.ts) / 1000) * (rate > 0 ? rate : 1);
    this.ts = frameTs;
    const err = media - predicted;
    this.t = Math.abs(err) > this.snap ? media : Math.max(this.t, predicted + err * this.gain);
    return this.t;
  }
}
