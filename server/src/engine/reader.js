// Use Math.random for speed — crypto randomness not needed for benchmark data

const DEFAULT_CONCURRENCY = 50;

const STATUSES = ['delivered', 'read', 'unread'];

/**
 * Read worker that queries the collection using phase-aware query patterns,
 * paced by a RateLimiter.
 *
 * - Concurrent mode (writes active): point reads only, returning 1 item.
 * - Isolation mode (read-only phase): list queries returning 50–100 items.
 */
export class ReadWorker {
  /**
   * @param {import('mongodb').Collection} collection
   * @param {import('./rateLimiter.js').RateLimiter} rateLimiter
   * @param {object} config
   * @param {number} config.userPoolSize  - Size of the user ID pool
   * @param {number} [config.concurrency] - Number of concurrent read lanes
   */
  constructor(collection, rateLimiter, config) {
    this._collection = collection;
    this._rateLimiter = rateLimiter;
    this._config = config;
    this._stopped = false;
    this._running = false;

    /** @type {Promise<void>[]} */
    this._lanes = [];

    // Metrics accumulators (drained by MetricsCollector)
    this.opsCount = 0;
    this.errorsCount = 0;
    /** @type {number[]} */
    this.latencies = [];

    this._concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

    /**
     * Controls query pattern selection. Set by RunManager each tick.
     * false = concurrent (point reads, 1 item)
     * true  = isolation (list queries, 50–100 items)
     */
    this.isolationMode = false;
  }

  /**
   * Start the read loop with multiple concurrent lanes.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._stopped = false;

    for (let i = 0; i < this._concurrency; i++) {
      this._lanes.push(this._runLane());
    }
  }

  /**
   * A single concurrent read lane.
   */
  async _runLane() {
    const { userPoolSize } = this._config;

    while (!this._stopped) {
      try {
        await this._rateLimiter.acquire(1);

        // Pick a random user
        const num = 1 + Math.floor(Math.random() * userPoolSize);
        const userId = `user_${String(num).padStart(6, '0')}`;

        const start = performance.now();

        if (this.isolationMode) {
          // ── Isolation: list queries returning 50–100 items ──
          const limit = 50 + Math.floor(Math.random() * 51); // 50–100

          if (Math.random() < 0.5) {
            // Recent messages
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            await this._collection
              .find({ user_id: userId, created_at: { $gt: since } })
              .project({ body: 0 })
              .sort({ created_at: -1 })
              .limit(limit)
              .toArray();
          } else {
            // Filtered inbox
            const status = STATUSES[Math.floor(Math.random() * STATUSES.length)];
            await this._collection
              .find({ user_id: userId, status })
              .project({ body: 0 })
              .sort({ created_at: -1 })
              .limit(limit)
              .toArray();
          }
        } else {
          // ── Concurrent: point reads returning 1 item ──
          const h = '0123456789abcdef';
          let msgId = '';
          for (let i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) msgId += '-';
            else msgId += h[Math.floor(Math.random() * 16)];
          }
          await this._collection.findOne({ user_id: userId, msg_id: msgId });
        }

        const elapsed = performance.now() - start;
        this.opsCount += 1;
        this.latencies.push(elapsed);
      } catch (err) {
        if (this._stopped) break;
        if (err.message === 'RateLimiter stopped') break;
        if (err.message === 'RateLimiter acquire timeout') continue;
        this.errorsCount++;
      }
    }
  }

  /**
   * Drain accumulated metrics and reset counters.
   * @returns {{ ops: number, errors: number, latencies: number[] }}
   */
  drainMetrics() {
    const ops = this.opsCount;
    const errors = this.errorsCount;
    const latencies = this.latencies;
    this.opsCount = 0;
    this.errorsCount = 0;
    this.latencies = [];
    return { ops, errors, latencies };
  }

  /**
   * Stop the worker and wait for in-flight operations to finish.
   */
  async stop() {
    this._stopped = true;
    await Promise.allSettled(this._lanes);
    this._lanes = [];
    this._running = false;
  }
}
