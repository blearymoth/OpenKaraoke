/** Small LRU cache bounded by entry count and (optionally) total byte size. */
export class LRU {
  constructor({ max = 32, maxBytes = Infinity, sizeOf = (v) => v?.length || 0 } = {}) {
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
    if (size > this.maxBytes) return;
    this.map.set(key, value);
    this.bytes += size;
    while (this.map.size > this.max || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      this.delete(oldest);
    }
  }

  delete(key) {
    const v = this.map.get(key);
    if (v === undefined) return false;
    this.bytes -= this.sizeOf(v);
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  get size() { return this.map.size; }
}
