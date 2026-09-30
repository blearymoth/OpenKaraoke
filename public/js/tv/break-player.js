// Break music on the main TV: a plain <audio> element (separate from the karaoke engine)
// that fades in while nobody sings and fades out when the next song starts.
export class BreakPlayer {
  constructor({ onEnded }) {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.id = 'break-audio';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.id = null;
    this.volume = 0;
    this.fade = null;
    this.onEnded = onEnded;
    this.el.addEventListener('ended', () => this.id && this.onEnded(this.id));
    this.el.addEventListener('error', () => {
      if (this.id && this.el.src) this.onEnded(this.id); // unplayable: ask for the next one
    });
  }

  /**
   * @param {{ id, url, volume } | null} bm what the server wants to hear (null = silence)
   * @param {{ main: boolean, unlocked: boolean, master: number }} opts
   */
  apply(bm, { main, unlocked, master = 1 }) {
    if (!bm || !main || !unlocked) {
      if (!this.el.paused) this.fadeTo(0, 1.2, () => this.el.pause());
      if (!bm) this.id = null;
      return;
    }
    const target = Math.max(0, Math.min(1, bm.volume * master));
    if (bm.id !== this.id) {
      const start = () => {
        this.id = bm.id;
        this.el.src = bm.url;
        this.el.volume = 0;
        this.el.play().then(() => this.fadeTo(target, 2.5)).catch(() => {});
      };
      if (this.id && !this.el.paused) this.fadeTo(0, 0.8, start);
      else start();
      this.id = bm.id;
      return;
    }
    if (this.el.paused && this.el.src) this.el.play().catch(() => {});
    if (Math.abs(this.volume - target) > 0.01 || this.el.volume < target - 0.01) this.fadeTo(target, 1.5);
  }

  /** Linear volume ramp over `seconds`, then `done()`. */
  fadeTo(to, seconds, done) {
    clearInterval(this.fade);
    this.volume = to;
    const from = this.el.volume;
    const steps = Math.max(1, Math.round(seconds * 20));
    let i = 0;
    this.fade = setInterval(() => {
      i++;
      this.el.volume = Math.max(0, Math.min(1, from + ((to - from) * i) / steps));
      if (i >= steps) {
        clearInterval(this.fade);
        this.fade = null;
        done?.();
      }
    }, 50);
  }

  get playing() {
    return !this.el.paused && this.el.volume > 0;
  }
}
