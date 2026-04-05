import { generateDocuments, generateDocument } from './document.js';

const DEFAULT_CONCURRENCY = 50;

/**
 * Write worker that inserts documents into MongoDB, paced by a RateLimiter.
 */
export class WriteWorker {
  /**
   * @param {import('mongodb').Collection} collection
   * @param {import('./rateLimiter.js').RateLimiter} rateLimiter
   * @param {object} config
   * @param {'bulk' | 'single'} config.mode
   * @param {number} config.batchSize      - Documents per insertMany (bulk mode)
   * @param {number} config.docSizeKB      - Target document size in KB
   * @param {number} config.userPoolSize   - User pool size
   * @param {string} config.writeConcern   - '1' or 'majority'
   * @param {number} [config.concurrency]  - Number of concurrent lanes
   */
  constructor(collection, rateLimiter, config) {
    this._collection = collection;
    this._rateLimiter = rateLimiter;
    this._config = config;
    this._uncapped = config.uncapped || false;
    this._stopped = false;
    this._running = false;

    /** @type {Promise<void>[]} */
    this._lanes = [];

    // Metrics accumulators (drained by MetricsCollector)
    this.opsCount = 0;
    this.errorsCount = 0;
    /** @type {number[]} */
    this.latencies = [];

    this._writeConcern = config.writeConcern === 'majority'
      ? { w: 'majority' }
      : { w: 1 };

    this._concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /**
   * Start the write loop with multiple concurrent lanes.
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
   * A single concurrent write lane.
   */
  async _runLane() {
    const { mode, batchSize, docSizeKB, userPoolSize } = this._config;

    while (!this._stopped) {
      try {
        if (mode === 'bulk') {
          if (!this._uncapped) await this._rateLimiter.acquire(batchSize);
          const docs = generateDocuments(batchSize, docSizeKB, userPoolSize);
          const start = performance.now();
          await this._collection.insertMany(docs, {
            ordered: false,
            writeConcern: this._writeConcern,
          });
          const elapsed = performance.now() - start;
          this.opsCount += batchSize;
          this.latencies.push(elapsed);
        } else {
          if (!this._uncapped) await this._rateLimiter.acquire(1);
          const doc = generateDocument(docSizeKB, userPoolSize);
          const start = performance.now();
          await this._collection.insertOne(doc, {
            writeConcern: this._writeConcern,
          });
          const elapsed = performance.now() - start;
          this.opsCount += 1;
          this.latencies.push(elapsed);
        }
      } catch (err) {
        if (this._stopped) break;
        if (err.message === 'RateLimiter stopped') break;
        // Timeouts are expected when rate is near 0 during cooldown/gap — just retry
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
    // Wait for all lanes to finish their current operation
    await Promise.allSettled(this._lanes);
    this._lanes = [];
    this._running = false;
  }
}
