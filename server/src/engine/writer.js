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
    /** @type {number[]} Per-doc latencies (batch time / batch size for bulk) */
    this.latencies = [];
    /** @type {number[]} Per-batch latencies (raw insertMany/insertOne time) */
    this.batchLatencies = [];

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
          // Start timer BEFORE acquire to capture coordinated omission
          const queueStart = performance.now();
          if (!this._uncapped) await this._rateLimiter.acquire(batchSize);
          const docs = generateDocuments(batchSize, docSizeKB, userPoolSize);
          const dbStart = performance.now();
          await this._collection.insertMany(docs, {
            ordered: false,
            writeConcern: this._writeConcern,
          });
          const dbElapsed = performance.now() - dbStart;
          const totalElapsed = performance.now() - queueStart;
          this.opsCount += batchSize;
          this.batchLatencies.push(dbElapsed);
          // Per-doc latency includes queue wait (coordinated omission correction)
          this.latencies.push(totalElapsed / batchSize);
        } else {
          const queueStart = performance.now();
          if (!this._uncapped) await this._rateLimiter.acquire(1);
          const doc = generateDocument(docSizeKB, userPoolSize);
          const dbStart = performance.now();
          await this._collection.insertOne(doc, {
            writeConcern: this._writeConcern,
          });
          const dbElapsed = performance.now() - dbStart;
          const totalElapsed = performance.now() - queueStart;
          this.opsCount += 1;
          this.batchLatencies.push(dbElapsed);
          this.latencies.push(totalElapsed);
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
    const batchLatencies = this.batchLatencies;
    this.opsCount = 0;
    this.errorsCount = 0;
    this.latencies = [];
    this.batchLatencies = [];
    return { ops, errors, latencies, batchLatencies };
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
