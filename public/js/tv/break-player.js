// Break music on the main TV: a plain <audio> element (separate from the karaoke engine)
// that fades in while nobody sings and fades out when the next song starts.
const RETRY_MS = 1500; // after an unplayable track, wait before asking for another one…
const MAX_RETRY_MS = 30_000; // …twice as long after each failure in a row, up to this

export class BreakPlayer {
  constructor({ onEnded }) {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.id = 'break-audio';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.id = null; // the track the server wants (null: silence)
    this.loaded = null; // the track in the element (while switching: the one fading out)
    this.pending = null; // the track waiting for the old one to fade out
    this.broken = null; // a track that couldn't play: not loaded again until the server moves on
    this.target = 0; // break volume to fade in to
    this.volume = 0; // where the running fade goes
    this.fade = null;
    this.fails = 0; // unplayable tracks in a row
    this.retry = null;
    this.onEnded = onEnded;
    this.el.addEventListener('ended', () => this.loaded && this.onEnded(this.loaded));
    this.el.addEventListener('playing', () => { this.fails = 0; });
    this.el.addEventListener('error', () => this.failed());
  }

  /**
   * The element can't play its track (the drive is unplugged, an unknown format…): ask the
   * server for another one, a little later after each failure in a row, so a dead drive is
   * never a request/broadcast loop.
   */
  failed() {
    const id = this.loaded;
    if (!id || id === this.broken || !this.el.src) return;
    this.broken = id;
    this.fails++;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.id === id) this.onEnded(id, { error: true });
    }, Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (this.fails - 1)));
  }

  /**
   * @param {{ id, url, volume } | null} bm what the server wants to hear (null = silence)
   * @param {{ main: boolean, unlocked: boolean, master: number }} opts
   */
  apply(bm, { main, unlocked, master = 1 }) {
    this.id = bm?.id || null;
    if (this.broken && this.id !== this.broken) {
      this.broken = null; // the server moved on
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (!bm || !main || !unlocked) {
      this.pending = null; // (a switch under way is called off)
      if (!this.el.paused) this.fadeTo(0, 1.2, () => this.el.pause());
      return;
    }
    this.target = Math.max(0, Math.min(1, bm.volume * master));
    if (bm.id === this.broken) return; // waiting for the server's next pick
    if (bm.id !== this.loaded) {
      // Another track: fade the old one out first. Further updates meanwhile (every state
      // broadcast lands here) must not undo the switch.
      if (this.pending?.id === bm.id) return;
      this.pending = bm;
      if (this.loaded && !this.el.paused) this.fadeTo(0, 0.8, () => this.load(bm));
      else this.load(bm);
      return;
    }
    this.pending = null; // (back to the loaded track: a switch is called off)
    if (this.el.paused && !this.el.ended) this.el.play().catch(() => {}); // resumes where it stopped
    if (Math.abs(this.volume - this.target) > 0.01 || this.el.volume < this.target - 0.01) this.fadeTo(this.target, 1.5);
  }

  load(bm) {
    clearInterval(this.fade); // (a fade-out still running must not pause the new track)
    this.fade = null;
    this.pending = null;
    this.loaded = bm.id;
    this.el.src = bm.url;
    this.el.volume = 0;
    this.volume = 0;
    this.el.play().then(() => {
      if (this.loaded === bm.id && this.id === bm.id) this.fadeTo(this.target, 2.5);
    }).catch(() => {});
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
