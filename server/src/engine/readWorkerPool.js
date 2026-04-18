/**
 * Pool of worker threads for read operations.
 * Presents the same interface as ReadWorker (drainMetrics, isolationMode, start, stop)
 * so MetricsCollector can use it as a drop-in replacement.
 */
import { Worker } from 'node:worker_threads';

const STOP_TIMEOUT_MS = 5000;

export class ReadWorkerPool {
  /**
   * @param {object} config
   * @param {string} config.mongoUri
   * @param {string} config.dbName
   * @param {string} config.collectionName
   * @param {number} config.userPoolSize
   * @param {number} config.concurrency     - Total read lanes across all workers
   * @param {number} config.initialReadRPS  - Starting read rate (total)
   * @param {number} config.maxReadRPS      - Max read rate for bucket sizing
   * @param {number} config.threadCount     - Number of worker threads
   */
  constructor(config) {
    this._config = config;
    this._threadCount = config.threadCount || 4;
    this._workers = [];

    // Metrics accumulators (aggregated from all workers)
    this._accOps = 0;
    this._accErrors = 0;
    this._accLatencies = [];

    this._isolationMode = false;
  }

  /**
   * Spawn worker threads and seed their caches.
   * Resolves when all workers are ready.
   */
  async seedCache() {
    const {
      mongoUri, dbName, collectionName, userPoolSize,
      concurrency, initialReadRPS, maxReadRPS,
    } = this._config;

    const baseLanes = Math.floor(concurrency / this._threadCount);
    const remainder = concurrency % this._threadCount;
    const baseRate = initialReadRPS / this._threadCount;

    const readyPromises = [];

    for (let i = 0; i < this._threadCount; i++) {
      const workerConcurrency = baseLanes + (i < remainder ? 1 : 0);
      const workerRate = i < this._threadCount - 1
        ? Math.floor(baseRate)
        : initialReadRPS - Math.floor(baseRate) * (this._threadCount - 1);

      const worker = new Worker(
        new URL('./readWorkerThread.js', import.meta.url),
        {
          workerData: {
            mongoUri,
            dbName,
            collectionName,
            userPoolSize,
            concurrency: workerConcurrency,
            initialReadRPS: workerRate,
            maxReadRPS: Math.ceil(maxReadRPS / this._threadCount),
            zipfExponent: this._config.zipfExponent ?? 0,
          },
        },
      );

      // Collect metrics from worker
      worker.on('message', (msg) => {
        if (msg.type === 'metrics') {
          this._accOps += msg.data.ops;
          this._accErrors += msg.data.errors;
          // Transfer latencies — concat for percentile computation in MetricsCollector
          if (msg.data.latencies && msg.data.latencies.length > 0) {
            this._accLatencies.push(...msg.data.latencies);
          }
        }
      });

      worker.on('error', (err) => {
        console.error(`Read worker ${i} error:`, err.message);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Read worker ${i} exited with code ${code}`);
        }
      });

      // Wait for this worker to be ready
      const readyPromise = new Promise((resolve) => {
        const handler = (msg) => {
          if (msg.type === 'ready') {
            worker.off('message', handler);
            resolve();
          }
        };
        worker.on('message', handler);
      });

      readyPromises.push(readyPromise);
      this._workers.push(worker);
    }

    // Wait for all workers to seed and be ready
    await Promise.all(readyPromises);
  }

  /**
   * Workers auto-start after seedCache. This is a no-op for interface compatibility.
   */
  start() {
    // Workers start their read lanes in init() after seedCache
  }

  /**
   * Update the read rate across all workers (divides evenly).
   * @param {number} totalReadRPS
   */
  updateRate(totalReadRPS) {
    const perWorker = totalReadRPS / this._threadCount;
    for (let i = 0; i < this._workers.length; i++) {
      const workerRate = i < this._workers.length - 1
        ? Math.floor(perWorker)
        : totalReadRPS - Math.floor(perWorker) * (this._workers.length - 1);
      this._workers[i].postMessage({ type: 'rate', readRPS: workerRate });
    }
  }

  /**
   * Set isolation mode on all workers.
   * @param {boolean} value
   */
  set isolationMode(value) {
    this._isolationMode = value;
    for (const worker of this._workers) {
      worker.postMessage({ type: 'isolation', value });
    }
  }

  get isolationMode() {
    return this._isolationMode;
  }

  /**
   * Drain aggregated metrics from all workers and reset.
   * Compatible with MetricsCollector's expected interface.
   * @returns {{ ops: number, errors: number, latencies: number[] }}
   */
  drainMetrics() {
    const ops = this._accOps;
    const errors = this._accErrors;
    const latencies = this._accLatencies;
    this._accOps = 0;
    this._accErrors = 0;
    this._accLatencies = [];
    return { ops, errors, latencies };
  }

  /**
   * Stop all worker threads gracefully.
   */
  async stop() {
    const stopPromises = this._workers.map((worker) => {
      return new Promise((resolve) => {
        let resolved = false;

        const handler = (msg) => {
          if (msg.type === 'stopped' && !resolved) {
            resolved = true;
            worker.off('message', handler);
            resolve();
          }
        };
        worker.on('message', handler);

        // Timeout: force terminate if worker doesn't respond
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            worker.off('message', handler);
            worker.terminate();
            resolve();
          }
        }, STOP_TIMEOUT_MS);

        worker.postMessage({ type: 'stop' });
      });
    });

    await Promise.all(stopPromises);
    this._workers = [];
  }
}
