/**
 * Worker thread for bulk document insertion.
 * Each worker has its own MongoClient, runs N concurrent insert lanes,
 * and reports metrics to the main thread via postMessage.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { MongoClient } from 'mongodb';
import { generateDocuments } from './document.js';

const {
  mongoUri,
  dbName,
  collectionName,
  docSizeKB,
  userPoolSize,
  batchSize,
  writeConcern,
  concurrency,
  quota, // total docs this worker should insert
} = workerData;

let client;
let collection;
let stopped = false;
let docsInserted = 0;
let errors = 0;

// Atomic batch counter — each lane claims a batch before inserting
let docsAssigned = 0;

const wc = writeConcern === 'majority' ? { w: 'majority' } : { w: 1 };

function claimBatch() {
  // Synchronous — no yield between check and assign, so no race condition
  if (docsAssigned >= quota) return 0;
  const thisBatch = Math.min(batchSize, quota - docsAssigned);
  docsAssigned += thisBatch;
  return thisBatch;
}

async function runLane() {
  while (!stopped) {
    const thisBatch = claimBatch();
    if (thisBatch <= 0) break;

    try {
      const docs = generateDocuments(thisBatch, docSizeKB, userPoolSize);
      await collection.insertMany(docs, { ordered: false, writeConcern: wc });
      docsInserted += thisBatch;
    } catch (err) {
      if (stopped) break;
      errors++;
      // Batch was claimed from quota but failed — don't count as inserted.
      // The quota slot is consumed (won't be retried), so total may be
      // slightly under target if there are errors. This is correct behavior.
    }
  }
}

async function init() {
  client = new MongoClient(mongoUri, {
    maxPoolSize: concurrency + 5,
  });
  await client.connect();

  const db = client.db(dbName);
  collection = db.collection(collectionName);

  parentPort.postMessage({ type: 'ready' });

  // Start N concurrent insert lanes
  const lanes = [];
  for (let i = 0; i < concurrency; i++) {
    lanes.push(runLane());
  }

  // Report metrics every second
  const metricsTimer = setInterval(() => {
    parentPort.postMessage({
      type: 'metrics',
      data: { docsInserted, errors },
    });
  }, 1000);

  // Wait for all lanes to complete
  await Promise.allSettled(lanes);

  clearInterval(metricsTimer);

  // Send final metrics
  parentPort.postMessage({
    type: 'metrics',
    data: { docsInserted, errors },
  });

  parentPort.postMessage({ type: 'complete' });
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'stop') {
    stopped = true;
    // Give lanes a moment to finish in-flight ops
    await new Promise((r) => setTimeout(r, 500));
    if (client) {
      try { await client.close(); } catch {}
    }
    parentPort.postMessage({ type: 'stopped', data: { docsInserted, errors } });
  }
});

init().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
