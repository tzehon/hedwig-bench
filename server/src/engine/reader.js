// Use Math.random for speed — crypto randomness not needed for benchmark data

const DEFAULT_CONCURRENCY = 50;

const STATUSES = ['delivered', 'read', 'unread'];

/**
 * Read worker that queries the collection using phase-aware query patterns,
 * paced by a RateLimiter.
 *
 * - Concurrent mode (writes active): point reads only, returning 1 item.
 * - Isolation mode (read-only phase): list queries returning 10–50 items (avg ~30).
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

    /**
     * Cache of known msg_ids per user for point reads that hit real documents.
     * Populated lazily from actual queries.
     * @type {Map<string, string>}
     */
    this._knownMsgIds = new Map();
  }

  /**
   * Pre-seed the msg_id cache by sampling documents from the collection.
   * Called once before lanes start so point reads hit real documents immediately.
   */
  async seedCache() {
    try {
      const docs = await this._collection
        .aggregate([{ $sample: { size: 5000 } }, { $project: { user_id: 1, msg_id: 1 } }])
        .toArray();
      for (const doc of docs) {
        if (doc.user_id && doc.msg_id) {
          this._knownMsgIds.set(doc.user_id, doc.msg_id);
        }
      }
    } catch {
      // Collection may be empty on first run — that's fine
    }
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
          // ── Isolation: list queries returning 10–50 items (avg ~30) ──
          const limit = 10 + Math.floor(Math.random() * 41); // 10–50
          let results;

          if (Math.random() < 0.5) {
            // Recent messages
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            results = await this._collection
              .find({ user_id: userId, created_at: { $gt: since } })
              .project({ body: 0 })
              .sort({ created_at: -1 })
              .limit(limit)
              .toArray();
          } else {
            // Filtered inbox
            const status = STATUSES[Math.floor(Math.random() * STATUSES.length)];
            results = await this._collection
              .find({ user_id: userId, status })
              .project({ body: 0 })
              .sort({ created_at: -1 })
              .limit(limit)
              .toArray();
          }

          // Cache a msg_id for this user so point reads can hit real documents
          if (results.length > 0) {
            const pick = results[Math.floor(Math.random() * results.length)];
            if (pick.msg_id) this._knownMsgIds.set(pick.user_id, pick.msg_id);
          }
        } else {
          // ── Concurrent: point reads returning 1 item ──
          // Use a cached msg_id so the read hits a real document (seeded at start).
          const cachedMsgId = this._knownMsgIds.get(userId);
          if (cachedMsgId) {
            await this._collection.findOne({ user_id: userId, msg_id: cachedMsgId });
          } else {
            // User not in cache — do an indexed lookup, cache for next time
            await this._collection.findOne({ user_id: userId });
          }
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
