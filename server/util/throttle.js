/**
 * Async token bucket for outgoing requests: `await throttle.wait()` resolves when the next
 * request may be sent (`capacity` requests per `perMs`, bursts up to `capacity`).
 * `pause(ms)` backs off (HTTP 429, quota errors, network down); waiters queue in order.
 */
export class Throttle {
  constructor({ capacity = 1, perMs = 1000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.rate = capacity / perMs;
    this.tokens = capacity;
    this.now = now;
    this.at = now();
    this.until = 0;
    this.chain = Promise.resolve();
    this.waiting = 0;
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.at) * this.rate);
    this.at = t;
  }

  /** Milliseconds until a request may go out (0 = now). */
  delay() {
    this.refill();
    const t = this.now();
    if (t < this.until) return this.until - t;
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.rate);
  }

  /** Milliseconds left of a back-off pause (0 when not paused). */
  pausedFor() {
    return Math.max(0, this.until - this.now());
  }

  /**
   * Waits for a token. Rejects with `code: 'busy'` when the wait would exceed `maxWaitMs`
   * (so urgent callers can give up instead of queueing behind a long back-off).
   */
  wait({ maxWaitMs = Infinity } = {}) {
    this.waiting++;
    const run = this.chain.then(async () => {
      for (;;) {
        const d = this.delay();
        if (d <= 0) break;
        if (d > maxWaitMs) throw Object.assign(new Error('Provider is busy'), { code: 'busy' });
        await new Promise((resolve) => setTimeout(resolve, Math.min(d, 1000)));
      }
      this.tokens -= 1;
    });
    this.chain = run.catch(() => {});
    return run.finally(() => { this.waiting--; });
  }

  /** Stops handing out tokens for `ms` (extends, never shortens, a running pause). */
  pause(ms) {
    this.until = Math.max(this.until, this.now() + ms);
  }

  /** Ends a pause early (e.g. the host pressed "try again"). */
  resume() {
    this.until = 0;
  }
}
