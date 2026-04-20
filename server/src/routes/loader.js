import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';
import { generateDocument } from '../engine/document.js';
import { setupIndexes, setupSharding } from '../engine/indexes.js';
import { InsertWorkerPool } from '../engine/insertWorkerPool.js';

const router = Router();

/** Map of job ID -> { pool, config, ... } */
const activeJobs = new Map();

/** Injected by index.js */
let broadcastProgress = null;

export function setLoaderBroadcast(fn) {
  broadcastProgress = fn;
}

export function getActiveJobs() {
  return activeJobs;
}

// ────────────────────────────────────────────────────────────
// POST /api/loader/start — Start a new load job
// ────────────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
  try {
    const config = req.body;
    if (!config?.mongoUri) {
      return res.status(400).json({ error: 'mongoUri is required' });
    }

    const jobId = uuidv4();
    const totalDocs = Number(config.totalDocs) || 1000000;
    const docSizeKB = Number(config.docSizeKB ?? config.docSize) || 3;
    const userPoolSize = Number(config.userPoolSize) || 100000;
    const batchSize = Number(config.batchSize) || 1000;
    const writeConcern = config.writeConcern === 'majority' ? 'majority' : '1';
    const threadCount = Number(config.threadCount) || 4;
    const concurrencyPerThread = Number(config.concurrencyPerThread) || 10;
    const dbName = config.dbName || 'hedwig_bench';
    const collectionName = config.collectionName || 'inbox';
    const deploymentMode = config.deploymentMode || 'replicaSet';

    // Drop collection if requested
    if (config.dropCollection) {
      let client;
      try {
        client = new MongoClient(config.mongoUri);
        await client.connect();
        const db = client.db(dbName);
        await db.collection(collectionName).drop();
      } catch (err) {
        // Collection may not exist — that's fine
        if (err.codeName !== 'NamespaceNotFound') {
          console.error('Drop collection warning:', err.message);
        }
      } finally {
        if (client) try { await client.close(); } catch {}
      }
    }

    // Set up sharding + indexes before bulk insert
    {
      let setupClient;
      try {
        setupClient = new MongoClient(config.mongoUri);
        await setupClient.connect();
        const db = setupClient.db(dbName);
        const col = db.collection(collectionName);

        // Shard first (if sharded mode)
        if (deploymentMode === 'sharded') {
          await setupSharding(db, collectionName);
        }

        // Create indexes up front — they build incrementally during insertion
        await setupIndexes(col, 'extended');
      } catch (err) {
        return res.status(500).json({ error: `Setup failed: ${err.message}` });
      } finally {
        if (setupClient) try { await setupClient.close(); } catch {}
      }
    }

    const pool = new InsertWorkerPool({
      mongoUri: config.mongoUri,
      dbName,
      collectionName,
      docSizeKB,
      userPoolSize,
      batchSize,
      writeConcern,
      concurrencyPerThread,
      threadCount,
      totalDocs,
    });

    const job = { pool, config, jobId, startedAt: new Date().toISOString() };
    activeJobs.set(jobId, job);

    // Start insertion — callbacks for progress and completion
    pool.start(
      // onProgress (every second)
      (progress) => {
        if (broadcastProgress) {
          broadcastProgress(jobId, { type: 'progress', data: { jobId, ...progress } });
        }
      },
      // onComplete
      (result) => {
        result.indexesCreated = true; // indexes were created up front
        if (broadcastProgress) {
          broadcastProgress(jobId, { type: 'status', data: { jobId, ...result } });
        }
        activeJobs.delete(jobId);
      },
    ).catch((err) => {
      console.error(`Loader job ${jobId} failed to start:`, err.message);
      if (broadcastProgress) {
        broadcastProgress(jobId, {
          type: 'status',
          data: { jobId, status: 'failed', error: err.message },
        });
      }
      activeJobs.delete(jobId);
    });

    res.status(201).json({ jobId, status: 'running', totalDocs });
  } catch (err) {
    console.error('Error starting loader job:', err);
    res.status(500).json({ error: 'Failed to start loader job' });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/loader/stop/:jobId — Stop a running job
// ────────────────────────────────────────────────────────────
router.post('/stop/:jobId', async (req, res) => {
  try {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'No active job with that ID' });
    }

    await job.pool.stop();
    const status = job.pool.getStatus();
    activeJobs.delete(req.params.jobId);

    res.json({ ok: true, ...status });
  } catch (err) {
    console.error('Error stopping loader job:', err);
    res.status(500).json({ error: 'Failed to stop loader job' });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/loader/status/:jobId — Poll current status
// ────────────────────────────────────────────────────────────
router.get('/status/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'No active job with that ID' });
  }
  res.json(job.pool.getStatus());
});

// ────────────────────────────────────────────────────────────
// POST /api/loader/create-indexes — Create benchmark indexes on demand
// ────────────────────────────────────────────────────────────
router.post('/create-indexes', async (req, res) => {
  const { mongoUri, dbName, collectionName, deploymentMode } = req.body || {};
  if (!mongoUri || !dbName || !collectionName) {
    return res.status(400).json({ error: 'mongoUri, dbName, and collectionName are required' });
  }

  let client;
  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db(dbName);
    const col = db.collection(collectionName);

    // Set up sharding first if needed
    if (deploymentMode === 'sharded') {
      await setupSharding(db, collectionName);
    }

    const count = await setupIndexes(col, 'extended');
    res.json({ ok: true, count });
  } catch (err) {
    console.error('Error creating indexes:', err.message);
    res.status(500).json({ error: `Failed to create indexes: ${err.message}` });
  } finally {
    if (client) try { await client.close(); } catch {}
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/loader/preview-doc — Generate a sample document
// ────────────────────────────────────────────────────────────
router.get('/preview-doc', (req, res) => {
  try {
    const docSize = parseInt(req.query.docSize, 10) || 3;
    const userPoolSize = parseInt(req.query.userPoolSize, 10) || 100000;
    const doc = generateDocument(docSize, userPoolSize);
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate document' });
  }
});

export default router;
