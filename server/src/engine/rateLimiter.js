/**
 * Token-bucket rate limiter with smooth refill and an async waiter queue.
 */
export class RateLimiter {
  /**
   * @param {number} tokensPerSecond - Refill rate
   * @param {number} [bucketSize] - Maximum bucket capacity (defaults to tokensPerSecond)
   */
  constructor(tokensPerSecond, bucketSize) {
    this.tokensPerSecond = tokensPerSecond;
    this.bucketSize = bucketSize ?? tokensPerSecond;
    this.tokens = this.bucketSize; // start full
    this._stopped = false;
    this._lastRefillTime = performance.now();

    /** @type {Array<{ count: number, resolve: () => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> | null }>} */
    this._waiters = [];

    // Refill every 10 ms for smooth pacing
    this._refillInterval = setInterval(() => this._refill(), 10);
  }

  /** Refill tokens based on elapsed time (handles timer drift). */
  _refill() {
    if (this._stopped) return;

    const now = performance.now();
    const elapsedMs = now - this._lastRefillTime;
    this._lastRefillTime = now;

    const tokensToAdd = this.tokensPerSecond * (elapsedMs / 1000);
    this.tokens = Math.min(this.bucketSize, this.tokens + tokensToAdd);

    // Try to drain the waiter queue
    this._drainWaiters();
  }

  /** Try to satisfy waiters from the front of the queue. */
  _drainWaiters() {
    while (this._waiters.length > 0) {
      const front = this._waiters[0];
      if (this.tokens >= front.count) {
        this.tokens -= front.count;
        this._waiters.shift();
        if (front.timer !== null) {
          clearTimeout(front.timer);
        }
        front.resolve();
      } else {
        break; // not enough tokens for the next waiter
      }
    }
  }

  /**
   * Acquire tokens. Resolves when the requested tokens are available.
   * @param {number} [count=1] - Number of tokens to acquire
   * @returns {Promise<void>}
   */
  acquire(count = 1) {
    if (this._stopped) {
      return Promise.reject(new Error('RateLimiter stopped'));
    }

    // Fast path: tokens available immediately
    if (this._waiters.length === 0 && this.tokens >= count) {
      this.tokens -= count;
      return Promise.resolve();
    }

    // Slow path: enqueue a waiter
    return new Promise((resolve, reject) => {
      const waiter = { count, resolve, reject, timer: null };

      // Safety timeout: if we can never get this many tokens, don't wait forever.
      // Max wait = count / tokensPerSecond * 2 + 5s as a generous bound.
      const maxWaitMs = this.tokensPerSecond > 0
        ? Math.max((count / this.tokensPerSecond) * 2000, 5000) + 5000
        : 30000;

      waiter.timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx !== -1) {
          this._waiters.splice(idx, 1);
          reject(new Error('RateLimiter acquire timeout'));
        }
      }, maxWaitMs);

      this._waiters.push(waiter);
    });
  }

  /**
   * Update the refill rate dynamically.
   * @param {number} newTokensPerSecond
   */
  updateRate(newTokensPerSecond) {
    this.tokensPerSecond = newTokensPerSecond;
    // Keep bucket size equal to current rate (1 second of tokens) to prevent overshoot
    this.bucketSize = Math.max(newTokensPerSecond, 1000);
    // Cap current tokens to new bucket size
    this.tokens = Math.min(this.tokens, this.bucketSize);
  }

  /**
   * Stop the rate limiter: reject all pending waiters and halt refills.
   */
  stop() {
    this._stopped = true;

    if (this._refillInterval) {
      clearInterval(this._refillInterval);
      this._refillInterval = null;
    }

    const err = new Error('RateLimiter stopped');
    for (const waiter of this._waiters) {
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(err);
    }
    this._waiters.length = 0;
  }
}
