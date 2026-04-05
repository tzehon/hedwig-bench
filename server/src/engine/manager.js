import { MongoClient } from 'mongodb';
import { RateLimiter } from './rateLimiter.js';
import { WriteWorker } from './writer.js';
import { ReadWorker } from './reader.js';
import { MetricsCollector } from './metrics.js';
import { setupIndexes } from './indexes.js';
import { generateSchedule, getTotalDurationSeconds } from './spike.js';

const COOLDOWN_SECONDS = 60;

/**
 * Determine the phase name for a given second in the schedule.
 */
function resolvePhase(second, config) {
  const { rampSeconds, sustainSeconds, gapSeconds, numSpikes } = config;
  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;
  const cycleLength = spikeLength + gapSeconds;

  let offset = second;

  for (let spike = 0; spike < numSpikes; spike++) {
    const isLastSpike = spike === numSpikes - 1;
    const thisCycleLen = isLastSpike ? spikeLength : cycleLength;

    if (offset < rampSeconds) return 'ramp';
    offset -= rampSeconds;

    if (offset < sustainSeconds) return 'sustain';
    offset -= sustainSeconds;

    if (offset < COOLDOWN_SECONDS) return 'cooldown';
    offset -= COOLDOWN_SECONDS;

    if (!isLastSpike) {
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
    this._readRateLimiter = null;
    this._writer = null;
    this._reader = null;
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
      const poolSize = this._config.poolSize ?? 200;
      this._client = new MongoClient(this._config.mongoUri, {
        maxPoolSize: poolSize,
      });
      await this._client.connect();
      this._db = this._client.db(this._config.dbName);
      this._collection = this._db.collection(this._config.collectionName);

      // ── 2. Optionally drop collection ──
      if (this._config.dropCollection) {
        try {
          await this._collection.drop();
        } catch {
          // Collection may not exist yet; that's fine
        }
      }

      // ── 3. Set up indexes ──
      await setupIndexes(this._collection, this._config.indexProfile);

      // ── 4. Generate spike schedule ──
      this._schedule = generateSchedule({
        targetWriteRPS: this._config.targetWriteRPS,
        numSpikes: this._config.numSpikes,
        rampSeconds: this._config.rampSeconds,
        sustainSeconds: this._config.sustainSeconds,
        gapSeconds: this._config.gapSeconds,
      });

      const totalDuration = getTotalDurationSeconds({
        targetWriteRPS: this._config.targetWriteRPS,
        numSpikes: this._config.numSpikes,
        rampSeconds: this._config.rampSeconds,
        sustainSeconds: this._config.sustainSeconds,
        gapSeconds: this._config.gapSeconds,
      });

      // ── 5. Create rate limiters ──
      // Write rate limiter starts at 0; the tick loop will update it each second
      this._writeRateLimiter = new RateLimiter(
        0,
        Math.max(this._config.targetWriteRPS, 1),
      );
      // Read rate limiter at a steady rate
      const readRPS = this._config.readRPS ?? this._config.targetReadRPS ?? 100;
      this._readRateLimiter = new RateLimiter(readRPS, readRPS);

      // ── 6. Create workers ──
      // Normalize config field names (frontend sends docSize, writeConcern as 'w:1')
      const docSizeKB = this._config.docSizeKB ?? this._config.docSize ?? 3;
      const rawWC = this._config.writeConcern || '1';
      const writeConcern = rawWC.replace('w:', ''); // 'w:1' -> '1', 'w:majority' -> 'majority'

      this._writer = new WriteWorker(this._collection, this._writeRateLimiter, {
        mode: this._config.writeMode,
        batchSize: this._config.batchSize,
        docSizeKB,
        userPoolSize: this._config.userPoolSize,
        writeConcern,
        concurrency: this._config.writeConcurrency,
        uncapped: this._config.uncapped || false,
      });

      this._reader = new ReadWorker(this._collection, this._readRateLimiter, {
        userPoolSize: this._config.userPoolSize,
        concurrency: this._config.readConcurrency,
      });

      // ── 7. Create metrics collector ──
      this._metricsCollector = new MetricsCollector(
        this._writer,
        this._reader,
        this._db,
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

      // ── 8. Start everything ──
      this._writer.start();
      this._reader.start();
      this._metricsCollector.start();

      this._startTime = Date.now();
      this._currentSecond = 0;

      // ── 9. Tick loop: update write rate each second ──
      this._tickTimer = setInterval(() => {
        if (this._stopped) return;

        if (this._currentSecond >= this._schedule.length) {
          // Schedule complete
          this._finish('completed');
          return;
        }

        const entry = this._schedule[this._currentSecond];
        const phase = resolvePhase(this._currentSecond, this._config);

        // Update metrics collector with current phase & target
        this._metricsCollector.phase = phase;
        this._metricsCollector.targetWriteRPS = entry.targetWriteRPS;

        // Update write rate limiter
        this._writeRateLimiter.updateRate(entry.targetWriteRPS);

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

    // Stop rate limiters (this unblocks workers waiting on acquire)
    if (this._writeRateLimiter) this._writeRateLimiter.stop();
    if (this._readRateLimiter) this._readRateLimiter.stop();

    // Stop workers (waits for in-flight ops)
    const workerStops = [];
    if (this._writer) workerStops.push(this._writer.stop());
    if (this._reader) workerStops.push(this._reader.stop());
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
