// One heavy job at a time (PLAN §31.3): separating vocals (§21, §30) and making karaoke (§31)
// both run Demucs and share the party PC's processor or graphics card. Whoever holds the lane
// runs; the others wait in order, an urgent one (the song on now) ahead of the rest.

export class Lane {
  constructor() {
    this.holder = null;
    this.waiting = []; // { label, urgent, grant }
  }

  /** Resolves with a release function once the lane is ours. */
  acquire(label, { urgent = false } = {}) {
    return new Promise((grant) => {
      if (!this.holder) {
        this.holder = label;
        grant(this.releaser(label));
        return;
      }
      const w = { label, urgent, grant };
      if (urgent) {
        const i = this.waiting.findIndex((x) => !x.urgent);
        if (i < 0) this.waiting.push(w);
        else this.waiting.splice(i, 0, w);
      } else this.waiting.push(w);
    });
  }

  releaser(label) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      this.holder = next ? next.label : null;
      if (next) next.grant(this.releaser(next.label));
    };
  }

  get busy() {
    return this.holder !== null;
  }
}
