/**
 * Pool of worker threads for bulk document insertion.
 * Distributes a total doc quota across N workers, each with own MongoClient.
 */
import { Worker } from 'node:worker_threads';

const STOP_TIMEOUT_MS = 10000;

export class InsertWorkerPool {
  /**
   * @param {object} config
   * @param {string} config.mongoUri
   * @param {string} config.dbName
   * @param {string} config.collectionName
   * @param {number} config.docSizeKB
   * @param {number} config.userPoolSize
   * @param {number} config.batchSize
   * @param {string} config.writeConcern
   * @param {number} config.concurrencyPerThread - Insert lanes per worker
   * @param {number} config.threadCount
   * @param {number} config.totalDocs - Total documents to insert
   */
  constructor(config) {
    this._config = config;
    this._threadCount = config.threadCount || 4;
    this._workers = [];
    this._totalDocs = config.totalDocs;

    // Aggregated metrics (updated by worker messages)
    this._docsInserted = 0;
    this._errors = 0;
    this._prevDocsInserted = 0;
    this._completedWorkers = 0;

    this._status = 'idle'; // idle | running | completed | stopped
    this._onComplete = null;
    this._onProgress = null;
    this._startTime = null;
    this._metricsTimer = null;
  }

  /**
   * Start the insertion. Spawns workers and begins inserting.
   * @param {Function} onProgress - Called every second with progress data
   * @param {Function} onComplete - Called when all docs are inserted
   */
  async start(onProgress, onComplete) {
    this._onProgress = onProgress;
    this._onComplete = onComplete;
    this._status = 'running';
    this._startTime = Date.now();

    const {
      mongoUri, dbName, collectionName, docSizeKB, userPoolSize,
      batchSize, writeConcern, concurrencyPerThread,
    } = this._config;

    const baseQuota = Math.floor(this._totalDocs / this._threadCount);
    const remainder = this._totalDocs % this._threadCount;

    const readyPromises = [];

    for (let i = 0; i < this._threadCount; i++) {
      // Last worker gets the remainder
      const workerQuota = baseQuota + (i === this._threadCount - 1 ? remainder : 0);

      const worker = new Worker(
        new URL('./insertWorkerThread.js', import.meta.url),
        {
          workerData: {
            mongoUri,
            dbName,
            collectionName,
            docSizeKB,
            userPoolSize,
            batchSize,
            writeConcern,
            concurrency: concurrencyPerThread,
            quota: workerQuota,
          },
        },
      );

      worker.on('message', (msg) => {
        if (msg.type === 'metrics') {
          // Workers send cumulative counts — track per-worker to compute total
          worker._lastDocsInserted = msg.data.docsInserted;
          worker._lastErrors = msg.data.errors;
        } else if (msg.type === 'complete') {
          this._completedWorkers++;
          if (this._completedWorkers >= this._threadCount) {
            this._finish('completed');
          }
        }
      });

      worker.on('error', (err) => {
        console.error(`Insert worker ${i} error:`, err.message);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && this._status === 'running') {
          console.error(`Insert worker ${i} exited with code ${code}`);
        }
      });

      // Initialize per-worker tracking
      worker._lastDocsInserted = 0;
      worker._lastErrors = 0;

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

    await Promise.all(readyPromises);

    // Aggregate and broadcast metrics every second
    this._metricsTimer = setInterval(() => {
      this._aggregateAndBroadcast();
    }, 1000);
  }

  /**
   * Aggregate metrics from all workers and broadcast progress.
   */
  _aggregateAndBroadcast() {
    let totalDocs = 0;
    let totalErrors = 0;
    for (const worker of this._workers) {
      totalDocs += worker._lastDocsInserted || 0;
      totalErrors += worker._lastErrors || 0;
    }

    const elapsed = (Date.now() - this._startTime) / 1000;
    const rate = elapsed > 0 ? Math.round(totalDocs / elapsed) : 0;
    const remaining = this._totalDocs - totalDocs;
    const eta = rate > 0 ? Math.round(remaining / rate) : 0;

    this._docsInserted = totalDocs;
    this._errors = totalErrors;

    if (this._onProgress) {
      this._onProgress({
        status: this._status,
        totalDocs: this._totalDocs,
        insertedDocs: totalDocs,
        errors: totalErrors,
        elapsedSeconds: Math.round(elapsed),
        rate,
        etaSeconds: eta,
      });
    }
  }

  /**
   * Mark job as finished and clean up.
   */
  _finish(status) {
    if (this._status !== 'running') return;
    this._status = status;

    if (this._metricsTimer) {
      clearInterval(this._metricsTimer);
      this._metricsTimer = null;
    }

    // Final metrics broadcast
    this._aggregateAndBroadcast();

    if (this._onComplete) {
      this._onComplete({
        status,
        totalDocs: this._totalDocs,
        insertedDocs: this._docsInserted,
        errors: this._errors,
        elapsedSeconds: Math.round((Date.now() - this._startTime) / 1000),
        avgRate: Math.round(this._docsInserted / ((Date.now() - this._startTime) / 1000)),
      });
    }
  }

  /**
   * Stop all workers gracefully.
   */
  async stop() {
    this._status = 'stopped';

    if (this._metricsTimer) {
      clearInterval(this._metricsTimer);
      this._metricsTimer = null;
    }

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

    // Final aggregate
    this._aggregateAndBroadcast();
    this._workers = [];
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      status: this._status,
      totalDocs: this._totalDocs,
      insertedDocs: this._docsInserted,
      errors: this._errors,
      elapsedSeconds: this._startTime ? Math.round((Date.now() - this._startTime) / 1000) : 0,
    };
  }
}
