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
  const readIsolationPct = config.readIsolationPct ?? 0;
  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;

  // Calculate isolation block duration (interleaved after each spike)
  const writeActiveSeconds = numSpikes * spikeLength;
  let isolationBlockDuration = 0;
  if (readIsolationPct > 0) {
    const pct = readIsolationPct / 100;
    const totalIsolation = Math.ceil((pct * writeActiveSeconds) / (1 - pct));
    isolationBlockDuration = numSpikes > 0 ? Math.ceil(totalIsolation / numSpikes) : 0;
  }

  let offset = second;

  for (let spike = 0; spike < numSpikes; spike++) {
    // Write phases
    if (offset < rampSeconds) return { spikeIndex: spike, phase: 'ramp' };
    offset -= rampSeconds;

    if (offset < sustainSeconds) return { spikeIndex: spike, phase: 'sustain' };
    offset -= sustainSeconds;

    if (offset < COOLDOWN_SECONDS) return { spikeIndex: spike, phase: 'cooldown' };
    offset -= COOLDOWN_SECONDS;

    // Isolation or gap after spike
    if (readIsolationPct > 0 && isolationBlockDuration > 0) {
      if (offset < isolationBlockDuration) return { spikeIndex: spike, phase: 'read_only' };
      offset -= isolationBlockDuration;
    } else if (spike < numSpikes - 1) {
      if (offset < gapSeconds) return { spikeIndex: spike, phase: 'gap' };
      offset -= gapSeconds;
    }
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
      peakReadRPS: 0,
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
  let peakReadRPS = 0;
  let totalWriteOps = 0;
  let totalReadOps = 0;
  let totalWriteErrors = 0;
  let totalReadErrors = 0;

  // Sustain-phase metrics for write averages
  const sustainWriteOps = [];
  const sustainWriteP50s = [];
  const sustainWriteP99s = [];
  // Read metrics split by concurrent (sustain) vs isolation (read_only)
  const concurrentReadOps = [];
  const concurrentReadP50s = [];
  const concurrentReadP99s = [];
  const isolationReadOps = [];
  const isolationReadP50s = [];
  const isolationReadP99s = [];

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

    if (writeOps > peakWriteRPS) peakWriteRPS = writeOps;
    if (readOps > peakReadRPS) peakReadRPS = readOps;

    // Sustain-phase aggregation (writes)
    if (phase === 'sustain') {
      sustainWriteOps.push(writeOps);
      sustainWriteP50s.push(writeP50);
      sustainWriteP99s.push(writeP99);
    }

    // Read metrics split by phase
    if (phase === 'sustain' || phase === 'ramp' || phase === 'cooldown') {
      concurrentReadOps.push(readOps);
      concurrentReadP50s.push(readP50);
      concurrentReadP99s.push(readP99);
    }
    if (phase === 'read_only') {
      isolationReadOps.push(readOps);
      isolationReadP50s.push(readP50);
      isolationReadP99s.push(readP99);
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

  const avgConcurrentReadRPS = concurrentReadOps.length > 0
    ? concurrentReadOps.reduce((a, b) => a + b, 0) / concurrentReadOps.length
    : 0;
  const avgIsolationReadRPS = isolationReadOps.length > 0
    ? isolationReadOps.reduce((a, b) => a + b, 0) / isolationReadOps.length
    : 0;

  // Percentiles
  const writeP50 = computePercentile(sustainWriteP50s, 50);
  const writeP90 = computePercentile(sustainWriteP99s, 90);
  const writeP99 = computePercentile(sustainWriteP99s, 99);
  const concReadP50 = computePercentile(concurrentReadP50s, 50);
  const concReadP90 = computePercentile(concurrentReadP99s, 90);
  const concReadP99 = computePercentile(concurrentReadP99s, 99);
  const isoReadP50 = computePercentile(isolationReadP50s, 50);
  const isoReadP90 = computePercentile(isolationReadP99s, 90);
  const isoReadP99 = computePercentile(isolationReadP99s, 99);

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

  const r = (v) => Math.round(v * 100) / 100;
  return {
    peakWriteRPS,
    peakReadRPS,
    avgWriteRPS: r(avgWriteRPS),
    // Concurrent reads (point reads, 1 item, during writes)
    avgConcurrentReadRPS: r(avgConcurrentReadRPS),
    concurrentReadP50: r(concReadP50),
    concurrentReadP90: r(concReadP90),
    concurrentReadP99: r(concReadP99),
    // Isolation reads (list queries, 10-50 items, no writes)
    avgIsolationReadRPS: r(avgIsolationReadRPS),
    isolationReadP50: r(isoReadP50),
    isolationReadP90: r(isoReadP90),
    isolationReadP99: r(isoReadP99),
    // Backward compat: combined read metrics
    avgReadRPS: r(avgConcurrentReadRPS + avgIsolationReadRPS > 0
      ? (concurrentReadOps.length * avgConcurrentReadRPS + isolationReadOps.length * avgIsolationReadRPS)
        / (concurrentReadOps.length + isolationReadOps.length)
      : 0),
    readP50: r(concReadP50),
    readP90: r(concReadP90),
    readP99: r(concReadP99),
    writeP50: r(writeP50),
    writeP90: r(writeP90),
    writeP99: r(writeP99),
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
          broadcastMetrics(id, snapshot);
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
          updateRunResults(id, summary, fullTimeseries);

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
