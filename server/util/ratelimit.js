/**
 * Token-bucket rate limiter keyed by a string (device id, IP…).
 * `capacity` tokens, refilled at `capacity / perMs`.
 */
export class RateLimiter {
  constructor({ capacity, perMs }) {
    this.capacity = capacity;
    this.rate = capacity / perMs;
    this.buckets = new Map();
  }

  /** Takes `n` tokens; returns false when the caller is over the limit. */
  take(key, n = 1, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
      if (this.buckets.size > 5000) this.prune(now);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.rate);
    b.at = now;
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }

  prune(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.rate >= this.capacity) this.buckets.delete(k);
    }
  }
}
