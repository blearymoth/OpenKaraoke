const busyError = () => Object.assign(new Error('Provider is busy'), { code: 'busy' });

/**
 * Async token bucket for outgoing requests: `await throttle.wait()` resolves when the next
 * request may be sent (`capacity` requests per `perMs`, bursts up to `capacity`).
 * `pause(ms)` backs off (HTTP 429, quota errors, network down). Waiters are served by priority
 * (lower `prio` first), then in order of arrival.
 */
export class Throttle {
  constructor({ capacity = 1, perMs = 1000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.rate = capacity / perMs;
    this.tokens = capacity;
    this.now = now;
    this.at = now();
    this.until = 0;
    this.waiters = []; // { prio, deadline, resolve, reject }, sorted by prio
    this.timer = null;
  }

  get waiting() {
    return this.waiters.length;
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

  /** Milliseconds until the waiter at position `k` (0 = next in line) would get its token. */
  eta(k) {
    this.refill();
    const pause = this.pausedFor();
    const ready = Math.min(this.capacity, this.tokens + pause * this.rate); // when the pause ends
    const missing = k + 1 - ready;
    return pause + (missing > 0 ? missing / this.rate : 0);
  }

  /**
   * Waits for a token. Rejects with `code: 'busy'` as soon as the wait — the back-off pause plus
   * the waiters served first — would exceed `maxWaitMs`, so urgent callers give up at once
   * instead of queueing behind a long back-off or a crowd of patient callers.
   */
  wait({ maxWaitMs = Infinity, prio = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let i = this.waiters.length;
      while (i > 0 && this.waiters[i - 1].prio > prio) i--;
      this.waiters.splice(i, 0, { prio, deadline: this.now() + maxWaitMs, resolve, reject });
      this.dispatch();
    });
  }

  dispatch() {
    clearTimeout(this.timer);
    this.timer = null;
    while (this.waiters.length && this.delay() <= 0) {
      this.tokens -= 1;
      this.waiters.shift().resolve();
    }
    if (!this.waiters.length) return;
    const t = this.now();
    let k = 0;
    this.waiters = this.waiters.filter((w) => {
      if (t + this.eta(k) > w.deadline) {
        w.reject(busyError());
        return false;
      }
      k++;
      return true;
    });
    if (!this.waiters.length) return;
    this.timer = setTimeout(() => this.dispatch(), Math.max(1, this.delay()));
  }

  /** Stops handing out tokens for `ms` (extends, never shortens, a running pause). */
  pause(ms) {
    this.until = Math.max(this.until, this.now() + ms);
    this.dispatch(); // urgent waiters that can't wait this long give up now
  }

  /** Ends a pause early (e.g. the host pressed "try again"). */
  resume() {
    this.until = 0;
    this.dispatch();
  }

  /** Rejects every waiter (`code: 'cancelled'`), e.g. on shutdown. */
  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.waiters.splice(0)) w.reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
  }
}
