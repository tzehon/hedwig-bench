/**
 * Worker thread entry point for read operations.
 * Each worker has its own MongoDB connection pool, rate limiter, and read lanes.
 * Communicates with the main thread via postMessage.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { MongoClient } from 'mongodb';
import { RateLimiter } from './rateLimiter.js';
import { ReadWorker } from './reader.js';

const {
  mongoUri,
  dbName,
  collectionName,
  userPoolSize,
  concurrency,
  initialReadRPS,
  maxReadRPS,
} = workerData;

let client;
let rateLimiter;
let reader;
let metricsTimer;

async function init() {
  // Own connection pool — sized to concurrency + headroom
  client = new MongoClient(mongoUri, {
    maxPoolSize: concurrency + 10,
  });
  await client.connect();

  const db = client.db(dbName);
  const collection = db.collection(collectionName);

  // Own rate limiter
  rateLimiter = new RateLimiter(initialReadRPS, Math.max(maxReadRPS, initialReadRPS));

  // Reuse existing ReadWorker class as-is
  reader = new ReadWorker(collection, rateLimiter, {
    userPoolSize,
    concurrency,
  });

  // Seed cache, then signal ready
  await reader.seedCache();
  parentPort.postMessage({ type: 'ready' });

  // Start read lanes
  reader.start();

  // Drain and report metrics every second
  metricsTimer = setInterval(() => {
    const metrics = reader.drainMetrics();
    parentPort.postMessage({ type: 'metrics', data: metrics });
  }, 1000);
}

// Handle messages from main thread
parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'rate':
      if (rateLimiter) rateLimiter.updateRate(msg.readRPS);
      break;
    case 'isolation':
      if (reader) reader.isolationMode = msg.value;
      break;
    case 'stop':
      if (metricsTimer) clearInterval(metricsTimer);
      if (rateLimiter) rateLimiter.stop();
      if (reader) await reader.stop();
      // Send final metrics
      if (reader) {
        const finalMetrics = reader.drainMetrics();
        parentPort.postMessage({ type: 'metrics', data: finalMetrics });
      }
      if (client) {
        try { await client.close(); } catch {}
      }
      parentPort.postMessage({ type: 'stopped' });
      break;
  }
});

// Start
init().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
