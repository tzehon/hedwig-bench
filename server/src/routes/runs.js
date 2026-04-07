import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RunManager } from '../engine/manager.js';
import { generateDocument } from '../engine/document.js';
import {
  createRun,
  updateRunStatus,
  updateRunResults,
  getRun,
  getAllRuns,
  deleteRun,
} from '../db/database.js';

const router = Router();

/** Map of run ID -> active RunManager instance */
const activeRuns = new Map();

/** Injected by index.js so routes can broadcast WebSocket messages */
let broadcastMetrics = null;
let broadcastStatus = null;

/**
 * Inject WebSocket broadcast functions from the server setup.
 */
export function setBroadcastFunctions(metricsFn, statusFn) {
  broadcastMetrics = metricsFn;
  broadcastStatus = statusFn;
}

/**
 * Get the active runs map (used by index.js for graceful shutdown).
 */
export function getActiveRuns() {
  return activeRuns;
}

// ────────────────────────────────────────────────────────────
// Summary computation
// ────────────────────────────────────────────────────────────

const COOLDOWN_SECONDS = 60;

/**
 * Determine which spike index a given second belongs to, and the phase within that spike.
 */
function resolveSpikeAndPhase(second, config) {
  const { rampSeconds, sustainSeconds, gapSeconds, numSpikes } = config;
  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;
  const cycleLength = spikeLength + gapSeconds;

  let offset = second;

  for (let spike = 0; spike < numSpikes; spike++) {
    const isLastSpike = spike === numSpikes - 1;
    const thisCycleLen = isLastSpike ? spikeLength : cycleLength;

    if (offset < thisCycleLen) {
      // This second belongs to this spike
      let phase;
      let localOffset = offset;
      if (localOffset < rampSeconds) {
        phase = 'ramp';
      } else {
        localOffset -= rampSeconds;
        if (localOffset < sustainSeconds) {
          phase = 'sustain';
        } else {
          localOffset -= sustainSeconds;
          if (localOffset < COOLDOWN_SECONDS) {
            phase = 'cooldown';
          } else {
            phase = 'gap';
          }
        }
      }
      return { spikeIndex: spike, phase };
    }
    offset -= isLastSpike ? spikeLength : cycleLength;
  }

  return { spikeIndex: -1, phase: 'complete' };
}

/**
 * Compute a summary object from the timeseries metrics and run config.
 */
function computeSummary(timeseries, config) {
  if (!timeseries || timeseries.length === 0) {
    return {
      peakWriteRPS: 0,
      avgWriteRPS: 0,
      avgReadRPS: 0,
      writeP99: 0,
      readP99: 0,
      totalWriteOps: 0,
      totalReadOps: 0,
      totalWriteErrors: 0,
      totalReadErrors: 0,
      errorRate: 0,
      verdict: 'fail',
      perSpike: [],
    };
  }

  let peakWriteRPS = 0;
  let totalWriteOps = 0;
  let totalReadOps = 0;
  let totalWriteErrors = 0;
  let totalReadErrors = 0;

  // Sustain-phase metrics for averages
  const sustainWriteOps = [];
  const sustainReadOps = [];
  // Collect ALL raw latencies from sustain phases for true percentile computation
  const allSustainWriteLatencies = [];
  const allSustainReadLatencies = [];

  // Per-spike accumulators
  const numSpikes = config.numSpikes || 1;
  const perSpikeData = Array.from({ length: numSpikes }, () => ({
    peakWriteRPS: 0,
    writeLatencies: [],
    readLatencies: [],
    errorCount: 0,
  }));

  for (const entry of timeseries) {
    const second = entry.second - 1; // entry.second is 1-based
    const { spikeIndex, phase } = resolveSpikeAndPhase(second, config);

    const writeOps = entry.write?.ops ?? 0;
    const readOps = entry.read?.ops ?? 0;
    const writeErrors = entry.write?.errors ?? 0;
    const readErrors = entry.read?.errors ?? 0;
    const writeP99 = entry.write?.p99 ?? 0;
    const readP99 = entry.read?.p99 ?? 0;
    const writeP50 = entry.write?.p50 ?? 0;
    const readP50 = entry.read?.p50 ?? 0;

    totalWriteOps += writeOps;
    totalReadOps += readOps;
    totalWriteErrors += writeErrors;
    totalReadErrors += readErrors;

    if (writeOps > peakWriteRPS) {
      peakWriteRPS = writeOps;
    }

    // Sustain-phase aggregation
    if (phase === 'sustain') {
      sustainWriteOps.push(writeOps);
      sustainReadOps.push(readOps);
      // Collect raw latencies if available, otherwise fall back to per-second percentiles
      if (entry.write?._rawLatencies) {
        allSustainWriteLatencies.push(...entry.write._rawLatencies);
      }
      if (entry.read?._rawLatencies) {
        allSustainReadLatencies.push(...entry.read._rawLatencies);
      }
    }

    // Per-spike aggregation
    if (spikeIndex >= 0 && spikeIndex < numSpikes) {
      const spike = perSpikeData[spikeIndex];
      if (writeOps > spike.peakWriteRPS) {
        spike.peakWriteRPS = writeOps;
      }
      if (writeP50 > 0) spike.writeLatencies.push(writeP50);
      if (readP99 > 0) spike.readLatencies.push(readP99);
      spike.errorCount += writeErrors + readErrors;
    }
  }

  const avgWriteRPS = sustainWriteOps.length > 0
    ? sustainWriteOps.reduce((a, b) => a + b, 0) / sustainWriteOps.length
    : 0;

  const avgReadRPS = sustainReadOps.length > 0
    ? sustainReadOps.reduce((a, b) => a + b, 0) / sustainReadOps.length
    : 0;

  // True percentiles from ALL raw latencies across sustain phases (no double-percentiling)
  const sortedWriteLat = allSustainWriteLatencies.sort((a, b) => a - b);
  const sortedReadLat = allSustainReadLatencies.sort((a, b) => a - b);
  const writeP50 = computePercentile(sortedWriteLat, 50);
  const writeP90 = computePercentile(sortedWriteLat, 90);
  const writeP99 = computePercentile(sortedWriteLat, 99);
  const readP50 = computePercentile(sortedReadLat, 50);
  const readP90 = computePercentile(sortedReadLat, 90);
  const readP99 = computePercentile(sortedReadLat, 99);

  const totalOps = totalWriteOps + totalReadOps;
  const totalErrors = totalWriteErrors + totalReadErrors;
  const errorRate = totalOps > 0 ? (totalErrors / totalOps) * 100 : 0;

  const perSpike = perSpikeData.map((spike, i) => ({
    spikeIndex: i,
    peakWriteRPS: spike.peakWriteRPS,
    avgWriteLatency: spike.writeLatencies.length > 0
      ? spike.writeLatencies.reduce((a, b) => a + b, 0) / spike.writeLatencies.length
      : 0,
    peakReadLatency: spike.readLatencies.length > 0
      ? Math.max(...spike.readLatencies)
      : 0,
    errorCount: spike.errorCount,
  }));

  return {
    peakWriteRPS,
    avgWriteRPS: Math.round(avgWriteRPS * 100) / 100,
    avgReadRPS: Math.round(avgReadRPS * 100) / 100,
    writeP50: Math.round(writeP50 * 100) / 100,
    writeP90: Math.round(writeP90 * 100) / 100,
    writeP99: Math.round(writeP99 * 100) / 100,
    readP50: Math.round(readP50 * 100) / 100,
    readP90: Math.round(readP90 * 100) / 100,
    readP99: Math.round(readP99 * 100) / 100,
    totalWriteOps,
    totalReadOps,
    totalWriteErrors,
    totalReadErrors,
    errorRate: Math.round(errorRate * 1000) / 1000,
    perSpike,
  };
}

/**
 * Simple percentile calculation on an array of numbers.
 */
function computePercentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────

/**
 * POST /api/runs - Start a new benchmark run
 */
router.post('/', (req, res) => {
  try {
    const config = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Request body must be a config object' });
    }

    const id = uuidv4();

    // Save to SQLite
    createRun(id, config);

    // Collected timeseries for this run
    const timeseries = [];

    // Create RunManager with callbacks
    const manager = new RunManager(
      config,
      // onMetrics - called each second with a snapshot
      (snapshot) => {
        timeseries.push(snapshot);
        if (broadcastMetrics) {
          // Strip raw latency arrays before sending over WebSocket (too large)
          const { write, read, ...rest } = snapshot;
          const { _rawLatencies: _wRaw, ...wClean } = write || {};
          const { _rawLatencies: _rRaw, ...rClean } = read || {};
          broadcastMetrics(id, { ...rest, write: wClean, read: rClean });
        }
      },
      // onStatusChange
      (status) => {
        const completedAt = (status === 'completed' || status === 'stopped' || status === 'error')
          ? new Date().toISOString()
          : null;

        // Map 'error' to 'failed' for storage
        const dbStatus = status === 'error' ? 'failed' : status;

        updateRunStatus(id, dbStatus, completedAt);

        if (status === 'completed' || status === 'stopped' || status === 'error') {
          // Compute summary and persist
          const fullTimeseries = timeseries.length > 0 ? timeseries : manager.getHistory();
          const summary = computeSummary(fullTimeseries, config);
          // Strip raw latency arrays before persisting (too large for SQLite)
          const cleanTimeseries = fullTimeseries.map(({ write, read, ...rest }) => {
            const { _rawLatencies: _w, ...wClean } = write || {};
            const { _rawLatencies: _r, ...rClean } = read || {};
            return { ...rest, write: wClean, read: rClean };
          });
          updateRunResults(id, summary, cleanTimeseries);

          // Clean up active run
          activeRuns.delete(id);

          // Broadcast final status
          if (broadcastStatus) {
            broadcastStatus(id, { status: dbStatus, summary });
          }
        } else {
          // Broadcast running status
          if (broadcastStatus) {
            broadcastStatus(id, { status: dbStatus });
          }
        }
      },
    );

    activeRuns.set(id, manager);

    // Start asynchronously - don't await
    manager.start().catch((err) => {
      console.error(`Run ${id} failed to start:`, err);
      updateRunStatus(id, 'failed', new Date().toISOString());
      activeRuns.delete(id);
      if (broadcastStatus) {
        broadcastStatus(id, { status: 'failed' });
      }
    });

    res.status(201).json({ id, status: 'running' });
  } catch (err) {
    console.error('Error creating run:', err);
    res.status(500).json({ error: 'Failed to create run' });
  }
});

/**
 * GET /api/runs - List all runs (without timeseries)
 */
router.get('/', (_req, res) => {
  try {
    const runs = getAllRuns();
    res.json(runs);
  } catch (err) {
    console.error('Error listing runs:', err);
    res.status(500).json({ error: 'Failed to list runs' });
  }
});

/**
 * GET /api/runs/preview-doc - Generate a sample document
 * (Must be defined before /:id to avoid matching "preview-doc" as an ID)
 */
router.get('/preview-doc', (req, res) => {
  try {
    const docSize = parseInt(req.query.docSize, 10) || 1;
    const userPoolSize = parseInt(req.query.userPoolSize, 10) || 100000;
    const doc = generateDocument(docSize, userPoolSize);
    res.json(doc);
  } catch (err) {
    console.error('Error generating preview document:', err);
    res.status(500).json({ error: 'Failed to generate document' });
  }
});

/**
 * GET /api/runs/:id - Get a single run with full details
 */
router.get('/:id', (req, res) => {
  try {
    const run = getRun(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  } catch (err) {
    console.error('Error getting run:', err);
    res.status(500).json({ error: 'Failed to get run' });
  }
});

/**
 * DELETE /api/runs/:id - Delete a run
 */
router.delete('/:id', (req, res) => {
  try {
    deleteRun(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting run:', err);
    res.status(500).json({ error: 'Failed to delete run' });
  }
});

/**
 * POST /api/runs/:id/stop - Stop a running benchmark
 */
router.post('/:id/stop', async (req, res) => {
  try {
    const manager = activeRuns.get(req.params.id);
    if (!manager) {
      return res.status(404).json({ error: 'No active run with that ID' });
    }
    await manager.stop();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error stopping run:', err);
    res.status(500).json({ error: 'Failed to stop run' });
  }
});

/**
 * POST /api/runs/cleanup - Drop the benchmark collection and optionally clear run history
 * Body: { mongoUri, dbName, collectionName, clearHistory? }
 */
router.post('/cleanup', async (req, res) => {
  const { mongoUri, dbName, collectionName, clearHistory } = req.body || {};

  if (!mongoUri || !dbName || !collectionName) {
    return res.status(400).json({ error: 'mongoUri, dbName, and collectionName are required' });
  }

  const results = { collection: false, searchIndex: false, history: false };

  let client;
  try {
    const { MongoClient } = await import('mongodb');
    client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // Drop the collection
    try {
      await collection.drop();
      results.collection = true;
    } catch (err) {
      // Collection may not exist — that's fine
      if (err.codeName === 'NamespaceNotFound') {
        results.collection = true; // already clean
      } else {
        throw err;
      }
    }

    // Try to drop search index if it exists
    try {
      const indexes = await collection.listSearchIndexes().toArray();
      for (const idx of indexes) {
        await collection.dropSearchIndex(idx.name);
      }
      results.searchIndex = true;
    } catch {
      // Search indexes may not be supported or collection was dropped — fine
      results.searchIndex = true;
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
    return res.status(500).json({ error: 'Failed to clean up MongoDB: ' + err.message });
  } finally {
    if (client) {
      try { await client.close(); } catch {}
    }
  }

  // Clear local run history
  if (clearHistory) {
    try {
      const allRuns = getAllRuns();
      for (const run of allRuns) {
        deleteRun(run.id);
      }
      results.history = true;
    } catch (err) {
      console.error('Error clearing history:', err.message);
    }
  }

  res.json({ ok: true, results });
});

export default router;
