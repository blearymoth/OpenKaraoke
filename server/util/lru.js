/** Small LRU cache with an optional byte budget (for buffers). */
export class Lru {
  constructor({ max = 16, maxBytes = Infinity, sizeOf = (v) => v?.length || 0 } = {}) {
    this.max = max;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.map = new Map();
    this.bytes = 0;
  }

  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key, value) {
    if (this.map.has(key)) this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return value; // too big to cache
    this.map.set(key, value);
    this.bytes += size;
    while (this.map.size > this.max || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      this.delete(oldest);
    }
    return value;
  }

  delete(key) {
    if (!this.map.has(key)) return;
    this.bytes -= this.sizeOf(this.map.get(key));
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  get size() { return this.map.size; }
}

/**
 * Caches in-flight promises so concurrent callers share one computation; once resolved,
 * the value itself is cached (so byte budgets apply to it).
 */
export function memoPromise(lru, key, compute) {
  const hit = lru.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const p = Promise.resolve().then(compute);
  lru.set(key, p);
  p.then(
    (v) => { if (lru.map.get(key) === p) lru.set(key, v); },
    () => { if (lru.map.get(key) === p) lru.delete(key); },
  );
  return p;
}
