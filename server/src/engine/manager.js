import { MongoClient } from 'mongodb';
import { RateLimiter } from './rateLimiter.js';
import { WriteWorker } from './writer.js';
import { ReadWorkerPool } from './readWorkerPool.js';
import { MutationWorker } from './mutationWorker.js';
import { MetricsCollector } from './metrics.js';
import { setupIndexes, setupSharding } from './indexes.js';
import { generateSchedule, getTotalDurationSeconds } from './spike.js';

const COOLDOWN_SECONDS = 60;

/**
 * Determine the phase name for a given second in the schedule.
 * Supports interleaved isolation blocks after each spike.
 */
function resolvePhase(second, config) {
  const { rampSeconds, sustainSeconds, gapSeconds, numSpikes } = config;
  const readIsolationPct = config.readIsolationPct ?? 0;
  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;

  // Calculate isolation block duration
  const writeActiveSeconds = numSpikes * spikeLength;
  let isolationBlockDuration = 0;
  if (readIsolationPct > 0) {
    const pct = readIsolationPct / 100;
    const totalIsolation = Math.ceil((pct * writeActiveSeconds) / (1 - pct));
    isolationBlockDuration = numSpikes > 0 ? Math.ceil(totalIsolation / numSpikes) : 0;
  }

  let offset = second;

  for (let spike = 0; spike < numSpikes; spike++) {
    if (offset < rampSeconds) return 'ramp';
    offset -= rampSeconds;

    if (offset < sustainSeconds) return 'sustain';
    offset -= sustainSeconds;

    if (offset < COOLDOWN_SECONDS) return 'cooldown';
    offset -= COOLDOWN_SECONDS;

    if (readIsolationPct > 0 && isolationBlockDuration > 0) {
      if (offset < isolationBlockDuration) return 'read_only';
      offset -= isolationBlockDuration;
    } else if (spike < numSpikes - 1) {
      if (offset < gapSeconds) return 'gap';
      offset -= gapSeconds;
    }
  }

  return 'complete';
}

/**
 * Orchestrates an entire load-generation run: connects to MongoDB, sets up
 * indexes, creates workers, drives the spike schedule, and collects metrics.
 */
export class RunManager {
  /**
   * @param {object} config          - Full run configuration
   * @param {string} config.mongoUri - MongoDB connection URI
   * @param {string} config.dbName   - Database name
   * @param {string} config.collectionName - Collection name
   * @param {boolean} [config.dropCollection] - Drop collection before run
   * @param {string} config.indexProfile     - 'minimal' | 'ttl' | 'extended'
   * @param {number} config.targetWriteRPS
   * @param {number} config.numSpikes
   * @param {number} config.rampSeconds
   * @param {number} config.sustainSeconds
   * @param {number} config.gapSeconds
   * @param {'bulk' | 'single'} config.writeMode
   * @param {number} config.batchSize
   * @param {number} config.docSizeKB
   * @param {number} config.userPoolSize
   * @param {string} config.writeConcern     - '1' or 'majority'
   * @param {number} [config.writeConcurrency]  - Concurrent write lanes
   * @param {number} [config.readConcurrency]   - Concurrent read lanes
   * @param {number} [config.readRPS]            - Read rate per second
   * @param {Function} onMetrics       - Called each second with metrics snapshot
   * @param {Function} onStatusChange  - Called with 'running', 'completed', 'stopped', 'error'
   */
  constructor(config, onMetrics, onStatusChange) {
    this._config = config;
    this._onMetrics = onMetrics;
    this._onStatusChange = onStatusChange;

    this._client = null;
    this._db = null;
    this._collection = null;
    this._writeRateLimiter = null;
    this._mutationRateLimiter = null;
    this._writer = null;
    this._reader = null;
    this._mutation = null;
    this._metricsCollector = null;
    this._schedule = null;
    this._tickTimer = null;

    this._currentSecond = 0;
    this._startTime = null;
    this._stopped = false;
    this._running = false;
  }

  /**
   * Start the load generation run.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    this._stopped = false;

    try {
      this._onStatusChange('running');

      // ── 1. Connect to MongoDB ──
      // Pool for main thread: writes + system queries only (reads use worker thread pools)
      const writeLanes = this._config.writeConcurrency ?? 50;
      const minPool = writeLanes + 20; // +20 for serverStatus, index ops, etc.
      const poolSize = Math.max(this._config.poolSize ?? 200, minPool);
      this._client = new MongoClient(this._config.mongoUri, {
        maxPoolSize: poolSize,
      });
      await this._client.connect();
      this._db = this._client.db(this._config.dbName);
      this._collection = this._db.collection(this._config.collectionName);

      // ── 2. Optionally clear data ──
      if (this._config.dropCollection) {
        try {
          await this._collection.drop();
        } catch {
          // Collection may not exist yet; that's fine
        }
      } else if (this._config.deleteData) {
        await this._collection.deleteMany({});
      }

      // ── 3. Set up sharding (if sharded mode) ──
      if (this._config.deploymentMode === 'sharded') {
        await setupSharding(this._db, this._config.collectionName);
      }

      // ── 4. Set up indexes ──
      await setupIndexes(this._collection, this._config.indexProfile);

      // ── 5. Generate spike schedule ──
      const scheduleConfig = {
        targetWriteRPS: this._config.targetWriteRPS,
        numSpikes: this._config.numSpikes,
        rampSeconds: this._config.rampSeconds,
        sustainSeconds: this._config.sustainSeconds,
        gapSeconds: this._config.gapSeconds,
        // Read schedule config
        readRPSConcurrent: this._config.readRPSConcurrent,
        readRPSIsolation: this._config.readRPSIsolation,
        readIsolationPct: this._config.readIsolationPct,
        // Legacy fallbacks
        readRPSMin: this._config.readRPSMin,
        readRPSMax: this._config.readRPSMax,
        readRPSAvg: this._config.readRPSAvg,
        targetReadRPS: this._config.targetReadRPS,
        readRPS: this._config.readRPS,
      };
      this._schedule = generateSchedule(scheduleConfig);

      const totalDuration = getTotalDurationSeconds(scheduleConfig);

      // ── 6. Create rate limiter (writes only — reads have per-worker limiters) ──
      this._writeRateLimiter = new RateLimiter(
        0,
        Math.max(this._config.targetWriteRPS, 1),
      );

      const initialReadRPS = this._schedule[0]?.targetReadRPS ?? this._config.readRPSConcurrent ?? 100;
      const maxReadRPS = Math.max(this._config.readRPSConcurrent ?? 0, this._config.readRPSIsolation ?? 0, initialReadRPS);

      // ── 7. Create workers ──
      const docSizeKB = this._config.docSizeKB ?? this._config.docSize ?? 3;
      const rawWC = this._config.writeConcern || '1';
      const writeConcern = rawWC.replace('w:', '');

      this._writer = new WriteWorker(this._collection, this._writeRateLimiter, {
        mode: this._config.writeMode,
        batchSize: this._config.batchSize,
        docSizeKB,
        userPoolSize: this._config.userPoolSize,
        writeConcern,
        concurrency: this._config.writeConcurrency,
        uncapped: this._config.uncapped || false,
      });

      // Read worker pool — spawns N worker threads, each with own connection + rate limiter
      this._reader = new ReadWorkerPool({
        mongoUri: this._config.mongoUri,
        dbName: this._config.dbName,
        collectionName: this._config.collectionName,
        userPoolSize: this._config.userPoolSize,
        concurrency: this._config.readConcurrency ?? 150,
        initialReadRPS,
        maxReadRPS,
        threadCount: this._config.readWorkerThreads ?? 4,
      });

      // ── 8. Create mutation worker (updates + deletes on existing docs) ──
      // Avg ~1480/sec total: status update 80, delete 600, content update 800
      const mutationRPS = this._config.mutationRPS ?? 1480;
      this._mutationRateLimiter = new RateLimiter(mutationRPS, mutationRPS);
      this._mutation = new MutationWorker(this._collection, this._mutationRateLimiter, {
        userPoolSize: this._config.userPoolSize,
        concurrency: 10,
      });

      // ── 9. Create metrics collector ──
      this._metricsCollector = new MetricsCollector(
        this._writer,
        this._reader,
        this._db,
        this._mutation,
      );
      this._metricsCollector.onMetrics = (snapshot) => {
        if (this._onMetrics) {
          try {
            this._onMetrics(snapshot);
          } catch {
            // Don't let callback errors affect the run
          }
        }
      };

      // ── 10. Pre-seed caches & start everything ──
      await this._reader.seedCache();
      await this._mutation.seedCache();
      this._writer.start();
      this._reader.start();
      this._mutation.start();
      this._metricsCollector.start();

      this._startTime = Date.now();
      this._currentSecond = 0;

      // ── 10. Tick loop: update rates each second ──
      this._tickTimer = setInterval(() => {
        if (this._stopped) return;

        if (this._currentSecond >= this._schedule.length) {
          // Schedule complete
          this._finish('completed');
          return;
        }

        const entry = this._schedule[this._currentSecond];
        const phase = resolvePhase(this._currentSecond, this._config);

        // Update metrics collector with current phase & targets
        this._metricsCollector.phase = phase;
        this._metricsCollector.targetWriteRPS = entry.targetWriteRPS;
        this._metricsCollector.targetReadRPS = entry.targetReadRPS;

        // Update write rate limiter + read worker pool rate
        this._writeRateLimiter.updateRate(entry.targetWriteRPS);
        this._reader.updateRate(entry.targetReadRPS);

        // Mutations run during concurrent phase only (they are write ops)
        const mutationRPS = this._config.mutationRPS ?? 1480;
        this._mutationRateLimiter.updateRate(entry.targetWriteRPS > 0 ? mutationRPS : 0);

        // Switch read query patterns based on phase
        // Concurrent (writes active): point reads (1 item)
        // Isolation (writes off): list queries (10–50 items, avg ~30)
        this._reader.isolationMode = entry.targetWriteRPS === 0;

        this._currentSecond++;
      }, 1000);
    } catch (err) {
      this._onStatusChange('error');
      await this._cleanup();
      throw err;
    }
  }

  /**
   * Internal: finish the run with a given status.
   */
  async _finish(status) {
    if (this._stopped) return;
    this._stopped = true;

    // Clear tick timer
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }

    // Set final phase
    if (this._metricsCollector) {
      this._metricsCollector.phase = 'complete';
    }

    await this._cleanup();
    this._running = false;
    this._onStatusChange(status);
  }

  /**
   * Gracefully stop the run.
   */
  async stop() {
    await this._finish('stopped');
  }

  /**
   * Clean up all resources.
   */
  async _cleanup() {
    // Stop the tick timer
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }

    // Stop rate limiters
    if (this._writeRateLimiter) this._writeRateLimiter.stop();
    if (this._mutationRateLimiter) this._mutationRateLimiter.stop();

    // Stop workers (waits for in-flight ops)
    const workerStops = [];
    if (this._writer) workerStops.push(this._writer.stop());
    if (this._reader) workerStops.push(this._reader.stop());
    if (this._mutation) workerStops.push(this._mutation.stop());
    await Promise.allSettled(workerStops);

    // Stop metrics collector
    if (this._metricsCollector) this._metricsCollector.stop();

    // Close MongoDB connection
    if (this._client) {
      try {
        await this._client.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Get the full metrics history.
   */
  getHistory() {
    return this._metricsCollector?.history ?? [];
  }

  /**
   * Get current run info.
   */
  getStatus() {
    return {
      running: this._running,
      currentSecond: this._currentSecond,
      totalSeconds: this._schedule?.length ?? 0,
      phase: this._metricsCollector?.phase ?? 'idle',
    };
  }
}
