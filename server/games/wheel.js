// Roulette wheel (PLAN §13.3): segments are songs, singers or dares. The server picks the
// result; the TV animates a spin that lands on it.

export const DEFAULT_DARES = [
  'Sing it in an opera voice',
  'Sing with your eyes closed',
  'Dance the whole chorus',
  'Pick a duet partner from the crowd',
  'Sing it as a whisper… then shout the chorus',
  'Robot voice for the first verse',
  'Swap the lyrics for “la la la”',
  'Sing to someone in the audience',
];

export const SPIN_MS = 6500;

export class WheelGame {
  static type = 'wheel';

  /**
   * @param {object} o
   * @param {'songs'|'singers'|'dares'} o.kind
   * @param {object[]} o.segments { id, label, sub?, color? }
   */
  constructor({ kind = 'songs', segments, now = Date.now, rng = Math.random, onChange = () => {}, spinMs = SPIN_MS }) {
    if (!segments || segments.length < 2) throw new Error('The wheel needs at least two segments');
    this.id = Math.random().toString(36).slice(2, 10);
    this.kind = kind;
    this.segments = segments.slice(0, 16);
    this.now = now;
    this.rng = rng;
    this.onChange = onChange;
    this.spinMs = spinMs;
    this.phase = 'ready'; // ready -> spinning -> landed (-> spinning again)
    this.result = null;
    this.spinId = 0;
    this.spinStartedAt = 0;
    this.history = [];
    this.timer = null;
  }

  spin() {
    if (this.phase === 'spinning') throw new Error('The wheel is already spinning');
    this.result = Math.floor(this.rng() * this.segments.length);
    // extra turns + where inside the segment it stops, so every spin looks different
    this.turns = 4 + Math.floor(this.rng() * 3);
    this.offset = 0.15 + this.rng() * 0.7;
    this.spinId++;
    this.spinStartedAt = this.now();
    this.phase = 'spinning';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.land(), this.spinMs);
    this.timer.unref?.();
    this.onChange();
    return this.result;
  }

  land() {
    if (this.phase !== 'spinning') return;
    this.phase = 'landed';
    this.history.push(this.result);
    this.onChange();
  }

  /** Removes the landed segment (e.g. a singer who already had their turn). */
  removeResult() {
    if (this.phase !== 'landed' || this.segments.length <= 2) throw new Error('Nothing to remove');
    this.segments.splice(this.result, 1);
    this.result = null;
    this.phase = 'ready';
    this.onChange();
  }

  action(name) {
    if (name === 'spin') return this.spin();
    if (name === 'remove') return this.removeResult();
    throw new Error(`Unknown wheel action ${name}`);
  }

  view() {
    return {
      id: this.id,
      type: 'wheel',
      kind: this.kind,
      phase: this.phase,
      segments: this.segments,
      result: this.phase === 'ready' ? null : this.result,
      spinId: this.spinId,
      turns: this.turns,
      offset: this.offset,
      spinStartedAt: this.spinStartedAt,
      spinMs: this.spinMs,
    };
  }

  resultSegment() {
    return this.result == null || this.phase !== 'landed' ? null : this.segments[this.result];
  }

  dispose() {
    clearTimeout(this.timer);
  }
}
