// Token-bucket rate limiter with a bounded key space, so an attacker rotating
// through millions of IPs can't exhaust memory: the least recently used keys
// are evicted first.
//
// This is per process. Behind several instances, put the same limits at the
// load balancer or CDN as well (see README, "Running in production").

export class RateLimiter {
  constructor({ capacity, refillPerSec, maxKeys = 100000 }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  // Returns { ok, retryAfter } and consumes `cost` tokens when allowed.
  take(key, cost = 1, now = Date.now()) {
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // re-insert to mark as recently used
      b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
      b.at = now;
    } else {
      b = { tokens: this.capacity, at: now };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    }
    this.buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.ceil((cost - b.tokens) / this.refillPerSec) };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  configure({ capacity, refillPerSec }) {
    if (capacity) this.capacity = capacity;
    if (refillPerSec) this.refillPerSec = refillPerSec;
  }
}
