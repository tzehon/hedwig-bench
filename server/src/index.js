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

  const match = pathname.match(/^\/ws\/runs\/([a-f0-9-]+)$/i);
  if (!match) {
    socket.destroy();
    return;
  }

  const runId = match[1];

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, runId);
  });
});

wss.on('connection', (ws, _request, runId) => {
  // Add this client to the run's client set
  if (!wsClients.has(runId)) {
    wsClients.set(runId, new Set());
  }
  wsClients.get(runId).add(ws);

  // Handle client disconnect
  ws.on('close', () => {
    const clients = wsClients.get(runId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        wsClients.delete(runId);
      }
    }
  });

  // Handle errors gracefully
  ws.on('error', (err) => {
    console.error(`WebSocket error for run ${runId}:`, err.message);
    const clients = wsClients.get(runId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        wsClients.delete(runId);
      }
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

  // Stop all active runs
  const activeRuns = getActiveRuns();
  const stopPromises = [];
  for (const [runId, manager] of activeRuns) {
    console.log(`Stopping active run: ${runId}`);
    stopPromises.push(
      manager.stop().catch((err) => {
        console.error(`Error stopping run ${runId}:`, err.message);
      }),
    );
  }
  await Promise.allSettled(stopPromises);

  // Close search connection
  await disconnectSearch().catch(() => {});

  // Close all WebSocket connections
  for (const [runId, clients] of wsClients) {
    for (const ws of clients) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors
      }
    }
  }
  wsClients.clear();

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
