/**
 * Compute a percentile from a sorted (or unsorted) array of numbers.
 *
 * @param {number[]} values - Array of numeric values
 * @param {number} p - Percentile in 0-100
 * @returns {number} The percentile value, or 0 if array is empty
 */
export function percentile(values, p) {
  if (values.length === 0) return 0;

  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Metrics collector that aggregates write/read worker stats and system-level
 * MongoDB server metrics.
 */
export class MetricsCollector {
  /**
   * @param {import('./writer.js').WriteWorker} writer
   * @param {import('./reader.js').ReadWorker} reader
   * @param {import('mongodb').Db} db - MongoDB database handle (for serverStatus)
   */
  constructor(writer, reader, db) {
    this._writer = writer;
    this._reader = reader;
    this._db = db;
    this._running = false;

    /** @type {Array<object>} */
    this.history = [];

    /** Callback invoked each second with the latest metrics snapshot. */
    this.onMetrics = null;

    this._secondTimer = null;
    this._systemTimer = null;
    this._second = 0;

    // Latest system metrics (refreshed every 5s)
    this._latestSystem = null;

    // Current phase and target RPS (set externally by RunManager)
    this.phase = 'gap';
    this.targetWriteRPS = 0;
  }

  /**
   * Start collecting metrics.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._second = 0;

    // Collect worker metrics every second
    this._secondTimer = setInterval(() => this._collectSecond(), 1000);

    // Collect system metrics every 5 seconds
    this._collectSystem(); // immediate first fetch
    this._systemTimer = setInterval(() => this._collectSystem(), 5000);
  }

  /**
   * Called every second: drain writer/reader metrics and compute percentiles.
   */
  _collectSecond() {
    this._second++;

    const writerMetrics = this._writer.drainMetrics();
    const readerMetrics = this._reader.drainMetrics();

    const snapshot = {
      second: this._second,
      timestamp: new Date().toISOString(),
      phase: this.phase,
      targetWriteRPS: this.targetWriteRPS,
      write: {
        ops: writerMetrics.ops,
        errors: writerMetrics.errors,
        p50: percentile(writerMetrics.latencies, 50),
        p95: percentile(writerMetrics.latencies, 95),
        p99: percentile(writerMetrics.latencies, 99),
      },
      read: {
        ops: readerMetrics.ops,
        errors: readerMetrics.errors,
        p50: percentile(readerMetrics.latencies, 50),
        p95: percentile(readerMetrics.latencies, 95),
        p99: percentile(readerMetrics.latencies, 99),
      },
      system: this._latestSystem,
    };

    this.history.push(snapshot);

    if (this.onMetrics) {
      try {
        this.onMetrics(snapshot);
      } catch {
        // Don't let callback errors kill the collector
      }
    }
  }

  /**
   * Fetch system-level metrics from MongoDB serverStatus.
   */
  async _collectSystem() {
    try {
      const status = await this._db.command({ serverStatus: 1 });

      this._latestSystem = {
        connections: status.connections?.current ?? 0,
        insertOps: status.opcounters?.insert ?? 0,
        queryOps: status.opcounters?.query ?? 0,
        cacheDirtyBytes:
          status.wiredTiger?.cache?.['tracked dirty bytes in the cache'] ?? 0,
        cacheBytes:
          status.wiredTiger?.cache?.['bytes currently in the cache'] ?? 0,
      };
    } catch {
      // serverStatus may fail on some configurations; keep last known value
    }
  }

  /**
   * Stop collecting metrics.
   */
  stop() {
    this._running = false;

    if (this._secondTimer) {
      clearInterval(this._secondTimer);
      this._secondTimer = null;
    }
    if (this._systemTimer) {
      clearInterval(this._systemTimer);
      this._systemTimer = null;
    }
  }
}
