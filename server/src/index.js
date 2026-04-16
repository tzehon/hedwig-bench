import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';

import { initDatabase } from './db/database.js';
import runsRouter, { setBroadcastFunctions, getActiveRuns } from './routes/runs.js';
import searchRouter, { disconnect as disconnectSearch } from './routes/search.js';
import queriesRouter, { disconnect as disconnectQueries } from './routes/queries.js';
import loaderRouter, { setLoaderBroadcast, getActiveJobs as getActiveLoaderJobs } from './routes/loader.js';

const PORT = 3001;

// ────────────────────────────────────────────────────────────
// 1. Initialize SQLite
// ────────────────────────────────────────────────────────────
initDatabase();

// ────────────────────────────────────────────────────────────
// 2. Express app
// ────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

app.use('/api/runs', runsRouter);
app.use('/api/search', searchRouter);
app.use('/api/queries', queriesRouter);
app.use('/api/loader', loaderRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Serve built frontend in production
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(join(clientDist, 'index.html'));
  });
}

// ────────────────────────────────────────────────────────────
// 3. HTTP server
// ────────────────────────────────────────────────────────────
const server = createServer(app);

// ────────────────────────────────────────────────────────────
// 4. WebSocket server
// ────────────────────────────────────────────────────────────

/** Map of run ID -> Set<WebSocket> */
const wsClients = new Map();
/** Map of loader job ID -> Set<WebSocket> */
const loaderWsClients = new Map();

const wss = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade requests for WebSocket
server.on('upgrade', (request, socket, head) => {
  // Parse the URL to extract the run ID
  // Expected path: /ws/runs/:id
  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const runMatch = pathname.match(/^\/ws\/runs\/([a-f0-9-]+)$/i);
  const loaderMatch = pathname.match(/^\/ws\/loader\/([a-f0-9-]+)$/i);

  if (!runMatch && !loaderMatch) {
    socket.destroy();
    return;
  }

  const id = runMatch ? runMatch[1] : loaderMatch[1];
  const namespace = runMatch ? 'run' : 'loader';

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, { id, namespace });
  });
});

wss.on('connection', (ws, _request, { id, namespace }) => {
  const clientMap = namespace === 'loader' ? loaderWsClients : wsClients;

  if (!clientMap.has(id)) {
    clientMap.set(id, new Set());
  }
  clientMap.get(id).add(ws);

  ws.on('close', () => {
    const clients = clientMap.get(id);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) clientMap.delete(id);
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${namespace} ${id}:`, err.message);
    const clients = clientMap.get(id);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) clientMap.delete(id);
    }
  });
});

/**
 * Send a JSON message to a single WebSocket client, handling errors gracefully.
 */
function safeSend(ws, message) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Client may have disconnected; ignore
    }
  }
}

/**
 * Broadcast a metrics snapshot to all WebSocket clients for a given run.
 */
function broadcastMetrics(runId, snapshot) {
  const clients = wsClients.get(runId);
  if (!clients || clients.size === 0) return;

  const message = { type: 'metrics', data: snapshot };
  for (const ws of clients) {
    safeSend(ws, message);
  }
}

/**
 * Broadcast a status change to all WebSocket clients for a given run.
 */
function broadcastStatusChange(runId, statusData) {
  const clients = wsClients.get(runId);
  if (!clients || clients.size === 0) return;

  const message = { type: 'status', data: statusData };
  for (const ws of clients) {
    safeSend(ws, message);
  }
}

// Inject broadcast functions into the runs router
setBroadcastFunctions(broadcastMetrics, broadcastStatusChange);

/**
 * Broadcast loader progress to all WebSocket clients for a given job.
 */
function broadcastLoaderProgress(jobId, message) {
  const clients = loaderWsClients.get(jobId);
  if (!clients || clients.size === 0) return;
  for (const ws of clients) {
    safeSend(ws, message);
  }
}

setLoaderBroadcast(broadcastLoaderProgress);

// ────────────────────────────────────────────────────────────
// 5. Start listening
// ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Hedwig Bench server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/runs/:id`);
});

// ────────────────────────────────────────────────────────────
// 6. Graceful shutdown
// ────────────────────────────────────────────────────────────
async function shutdown() {
  console.log('\nShutting down gracefully...');

  // Stop all active runs and loader jobs
  const activeRuns = getActiveRuns();
  const activeLoaderJobs = getActiveLoaderJobs();
  const stopPromises = [];

  for (const [runId, manager] of activeRuns) {
    console.log(`Stopping active run: ${runId}`);
    stopPromises.push(
      manager.stop().catch((err) => {
        console.error(`Error stopping run ${runId}:`, err.message);
      }),
    );
  }

  for (const [jobId, job] of activeLoaderJobs) {
    console.log(`Stopping loader job: ${jobId}`);
    stopPromises.push(
      job.pool.stop().catch((err) => {
        console.error(`Error stopping loader job ${jobId}:`, err.message);
      }),
    );
  }

  await Promise.allSettled(stopPromises);

  // Close search connection
  await disconnectSearch().catch(() => {});
  await disconnectQueries().catch(() => {});

  // Close all WebSocket connections
  for (const clientMap of [wsClients, loaderWsClients]) {
    for (const [, clients] of clientMap) {
      for (const ws of clients) {
        try {
          ws.close(1001, 'Server shutting down');
        } catch {}
      }
    }
    clientMap.clear();
  }

  // Close the WebSocket server
  wss.close(() => {
    // Close the HTTP server
    server.close(() => {
      console.log('Server shut down.');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
