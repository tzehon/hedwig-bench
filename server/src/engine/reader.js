// Use Math.random for speed — crypto randomness not needed for benchmark data

const DEFAULT_CONCURRENCY = 50;

/**
 * Query patterns modelled after Scylla access patterns:
 *
 *   1. Point read:       WHERE user_id = ? AND msg_id = ?
 *   2. Recent messages:  WHERE user_id = ? AND created_at > ? LIMIT ?
 *   3. Filtered inbox:   WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?
 *
 * The reader randomly selects among these weighted patterns each operation.
 */
const QUERY_PATTERNS = [
  { name: 'point_read', weight: 30 },
  { name: 'recent_messages', weight: 40 },
  { name: 'filtered_inbox', weight: 30 },
];

const TOTAL_WEIGHT = QUERY_PATTERNS.reduce((sum, p) => sum + p.weight, 0);
const STATUSES = ['delivered', 'read', 'unread'];

function pickQueryPattern() {
  const roll = Math.floor(Math.random() * TOTAL_WEIGHT);
  let cumulative = 0;
  for (const pattern of QUERY_PATTERNS) {
    cumulative += pattern.weight;
    if (roll < cumulative) return pattern.name;
  }
  return QUERY_PATTERNS[QUERY_PATTERNS.length - 1].name;
}

/**
 * Read worker that queries the collection using realistic query patterns,
 * paced by a RateLimiter.
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
        // Start timer BEFORE acquire to capture coordinated omission
        const queueStart = performance.now();
        await this._rateLimiter.acquire(1);

        // Pick a random user
        const num = 1 + Math.floor(Math.random() * userPoolSize);
        const userId = `user_${String(num).padStart(6, '0')}`;

        const pattern = pickQueryPattern();
        const start = performance.now();

        switch (pattern) {
          case 'point_read': {
            // WHERE user_id = ? AND msg_id = ?
            // Use a random UUID — will usually miss (simulates cache-miss reads),
            // which is a realistic worst-case for point reads.
            const h = '0123456789abcdef';
            let msgId = '';
            for (let i = 0; i < 36; i++) {
              if (i === 8 || i === 13 || i === 18 || i === 23) msgId += '-';
              else msgId += h[Math.floor(Math.random() * 16)];
            }
            await this._collection.findOne({ user_id: userId, msg_id: msgId });
            break;
          }
          case 'recent_messages': {
            // WHERE user_id = ? AND created_at > ? LIMIT 20
            // Look for messages in the last 24 hours
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            await this._collection
              .find({ user_id: userId, created_at: { $gt: since } })
              .sort({ created_at: -1 })
              .limit(20)
              .toArray();
            break;
          }
          case 'filtered_inbox': {
            // WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20
            const status = STATUSES[Math.floor(Math.random() * STATUSES.length)];
            await this._collection
              .find({ user_id: userId, status })
              .sort({ created_at: -1 })
              .limit(20)
              .toArray();
            break;
          }
        }

        const elapsed = performance.now() - queueStart; // includes queue wait
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
