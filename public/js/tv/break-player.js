// Break music on the main TV: a plain <audio> element (separate from the karaoke engine)
// that fades in while nobody sings and fades out when the next song starts.
const RETRY_MS = 1500; // after an unplayable track, wait before asking for another one…
const MAX_RETRY_MS = 30_000; // …twice as long after each failure in a row, up to this

/** The same pick of the same track (`pick` numbers each pick on the server: the same file can come again). */
const same = (a, b) => !!a && !!b && a.id === b.id && a.pick === b.pick;

export class BreakPlayer {
  /** @param {{ onEnded: (id: string, opts: { pick?: number, error?: boolean }) => void }} opts reports to the server */
  constructor({ onEnded }) {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.id = 'break-audio';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.want = null; // the pick the server wants ({ id, pick, url, volume }; null: silence)
    this.loaded = null; // the pick in the element (while switching: the one fading out)
    this.pending = null; // the pick waiting for the old one to fade out
    this.broken = null; // a pick that couldn't play: not loaded again until the server moves on
    this.target = 0; // break volume to fade in to
    this.volume = 0; // where the running fade goes
    this.fade = null;
    this.fails = 0; // unplayable tracks in a row
    this.retry = null;
    this.onEnded = onEnded;
    this.el.addEventListener('ended', () => this.report(this.loaded));
    this.el.addEventListener('playing', () => { this.fails = 0; });
    this.el.addEventListener('error', () => this.failed());
  }

  report(p, error = false) {
    if (p) this.onEnded(p.id, { pick: p.pick, error });
  }

  /**
   * The element can't play its track (the drive is unplugged, an unknown format…): ask the
   * server for another one, a little later after each failure in a row, so a dead drive is
   * never a request/broadcast loop.
   */
  failed() {
    const p = this.loaded;
    if (!p || same(p, this.broken) || !this.el.src) return;
    this.broken = p;
    this.fails++;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (same(this.want, p)) this.report(p, true);
    }, Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (this.fails - 1)));
  }

  /**
   * @param {{ id, pick, url, volume } | null} bm what the server wants to hear (null = silence)
   * @param {{ main: boolean, unlocked: boolean, master: number }} opts
   */
  apply(bm, { main, unlocked, master = 1 }) {
    this.want = bm || null;
    if (this.broken && !same(bm, this.broken)) {
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
    if (same(bm, this.broken)) {
      // Waiting for the server's next pick. Once the wait is over the report has gone out: if
      // the server still wants this pick, it never got it (the TV was reconnecting): again.
      if (!this.retry) this.report(bm, true);
      return;
    }
    if (bm.id !== this.loaded?.id) {
      // Another track: fade the old one out first. Further updates meanwhile (every state
      // broadcast lands here) must not undo the switch.
      if (this.pending?.id === bm.id) {
        this.pending = bm;
        return;
      }
      this.pending = bm;
      if (this.loaded && !this.el.paused) this.fadeTo(0, 0.8, () => this.pending && this.load(this.pending));
      else this.load(bm);
      return;
    }
    this.pending = null; // (back to the loaded track: a switch is called off)
    if (same(bm, this.loaded)) {
      // Over, and the server still wants it: the end report never got there (sent while the
      // TV was reconnecting) or is on its way. Again: the server takes only the first one.
      if (this.el.ended) return this.report(bm);
    } else {
      // A new pick of the same file (a folder with one song, a lucky draw): an ended one plays
      // again from the top (play() restarts it), a paused one carries on, a failed one reloads.
      this.loaded = bm;
      if (this.el.error) return this.load(bm);
    }
    if (this.el.paused) this.el.play().catch(() => {}); // resumes where it stopped
    if (Math.abs(this.volume - this.target) > 0.01 || this.el.volume < this.target - 0.01) this.fadeTo(this.target, 1.5);
  }

  load(bm) {
    clearInterval(this.fade); // (a fade-out still running must not pause the new track)
    this.fade = null;
    this.pending = null;
    this.loaded = bm;
    this.el.src = bm.url;
    this.el.volume = 0;
    this.volume = 0;
    this.el.play().then(() => {
      if (same(this.loaded, bm) && same(this.want, bm)) this.fadeTo(this.target, 2.5);
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
