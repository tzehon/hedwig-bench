# Hedwig Bench

MongoDB Atlas inbox workload benchmark tool with a real-time dashboard and Atlas Search showcase.

Simulates the bursty campaign-blast write pattern of the Hedwig inbox messaging service (0 → 30–40k write ops/sec spikes, 5–10 times per day) with concurrent stable reads (1–2k RPS), then produces a visual pass/fail report. Built to evaluate MongoDB Atlas as a replacement for ScyllaDB.

![Architecture](https://img.shields.io/badge/stack-React%20%2B%20Express%20%2B%20MongoDB-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Usage Guide](#usage-guide)
  - [1. Configure & Run](#1-configure--run)
  - [2. Live Dashboard](#2-live-dashboard)
  - [3. Results](#3-results)
  - [4. Run History & Compare](#4-run-history--compare)
  - [5. Atlas Search Showcase](#5-atlas-search-showcase)
- [Configuration Reference](#configuration-reference)
- [Workload Model](#workload-model)
  - [Spike Algorithm](#spike-algorithm)
  - [Document Schema](#document-schema)
  - [Index Profiles](#index-profiles)
  - [Read Query Patterns](#read-query-patterns)
- [Pass/Fail Criteria](#passfail-criteria)
- [API Reference](#api-reference)
  - [Benchmark Endpoints](#benchmark-endpoints)
  - [Search Endpoints](#search-endpoints)
  - [WebSocket](#websocket)
- [Engine Internals](#engine-internals)
- [Deployment Guide](#deployment-guide)
  - [Running Locally](#running-locally)
  - [Running on EC2 (Recommended for Full Load)](#running-on-ec2-recommended-for-full-load)
  - [Production Build](#production-build)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Safety](#safety)

---

## Architecture

```
+-------------------------+         +-----------------------------+
|  React Frontend         |         |  Express + WebSocket        |
|  (Vite, Tailwind,       | <--WS-->|  Backend Server             |
|   Recharts)             |         |                             |
|                         |         |  +------------------------+ |
|  Pages:                 |         |  | Load Engine             | |
|  - Configure & Run      |         |  | - Document Gen          | |
|  - Live Dashboard       |         |  | - Spike Scheduler       | |
|  - Results              |         |  | - Write Worker          | |
|  - History & Compare    |         |  | - Read Worker           | |
|  - Atlas Search         |         |  | - Rate Limiter          | |
|                         |         |  | - Metrics               | |
+-------------------------+         |  +-----------+------------+ |
                                    |              |              |
                                    |  +-----------+------------+ |
                                    |  | SQLite (runs DB)        | |
                                    |  +------------------------+ |
                                    +-------------+---------------+
                                                  |
                                                  | mongodb driver
                                                  v
                                    +-----------------------------+
                                    |  MongoDB Atlas              |
                                    |  (target cluster)           |
                                    +-----------------------------+
```

- **Frontend**: React 18 (Vite), Tailwind CSS, Recharts for live charts.
- **Backend**: Express.js, `ws` for real-time metrics streaming, official MongoDB Node.js driver (`mongodb` v6).
- **Storage**: `better-sqlite3` for run metadata, config, and full time-series persistence across restarts.
- **Metrics**: Streamed via WebSocket from backend to frontend every second during a run.

---

## Prerequisites

- **Node.js** >= 18 (uses ES modules, `performance.now()`, `crypto.randomBytes`)
- **npm** >= 9
- **MongoDB Atlas cluster** (or any MongoDB 5.0+ instance) — free tier (M0) works for smoke tests; M10+ recommended for real benchmarks; M50+ for full 35k RPS load tests
- **Atlas Search**: For the search showcase tab, the cluster must support Atlas Search (M10+ or dedicated; not available on M0 free tier)
- **Network access**: The machine running hedwig-bench must be able to reach the Atlas cluster. Add its IP to your Atlas Network Access list.

---

## Quick Start

```bash
# Clone / enter the project
cd hedwig-bench

# Install all dependencies (root + server + client)
npm run install:all

# Start both frontend and backend in dev mode
npm run dev
```

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001
- **Health check**: http://localhost:3001/api/health

Open the frontend, paste your MongoDB URI, and click **Quick Smoke Test** to verify everything works.

---

## Usage Guide

### 1. Configure & Run (`/`)

The home page presents a form with collapsible sections for all benchmark parameters.

**Key features:**
- **MongoDB URI masking**: After you enter the URI, it's masked in the UI. Click the eye icon to toggle visibility. The URI is never logged in full.
- **Live document preview**: As you adjust the document size slider, a debounced API call generates and displays a sample document in formatted JSON so you can see exactly what will be inserted.
- **Spike pattern preview**: An SVG visualization updates in real time as you adjust spike parameters (count, ramp, sustain, gap), showing the full timeline of write rate targets.
- **Quick Smoke Test**: One-click preset — 1 spike, 5k write RPS, 500 read RPS, 30s ramp, 60s sustain. Takes about 2.5 minutes.

**Starting a run:**
1. Fill in the MongoDB URI (required).
2. Adjust parameters as needed (defaults are tuned for the Hedwig workload).
3. Click **Start Benchmark**.
4. Confirm the dialog ("This will generate up to X write ops/sec...").
5. If "Drop collection" is checked, confirm a second dialog.
6. You're redirected to the Live Dashboard.

### 2. Live Dashboard (`/run/:id`)

Shows real-time benchmark progress with charts updating every second via WebSocket.

**Layout:**
- **Top bar**: Run ID, elapsed time (MM:SS), current phase badge (Ramp / Sustain / Cooldown / Gap / Complete), progress bar.
- **Throughput charts** (side-by-side): Write ops/sec actual vs target (dashed), Read ops/sec actual vs target. Lines turn green/yellow/red based on how close actual is to target.
- **Latency charts** (side-by-side): Write and read latency with p50/p95/p99 lines and a 50ms threshold reference line.
- **System chart** (wide): Connection count, insert ops/sec, query ops/sec, WiredTiger dirty cache bytes. Updates every 5 seconds.
- **Bottom bar**: Error counts and error rate percentage. Flashes red if error rate exceeds 1%.

**Controls:**
- **Stop Run**: Graceful shutdown — finishes in-flight operations, flushes metrics, saves partial results, then redirects to Results.
- **View Results**: Appears when the run completes; links to the Results page.

**Auto-reconnect**: If the WebSocket disconnects, a "Reconnecting..." indicator appears and it retries after 2 seconds.

### 3. Results (`/results/:id`)

Static report view after a run completes.

**Summary cards (top row):**
- **Configuration**: Doc size, index profile, write mode, write concern.
- **Write Performance**: Peak write RPS, avg sustain RPS, p99 latency. Green/red border based on p99 vs 50ms threshold.
- **Read Performance**: Achieved read RPS, p99 latency. Green/red border.
- **Verdict**: Large PASS or FAIL with criteria breakdown.

**Full charts**: Same as the Live Dashboard but with all data and zoom/pan via Recharts Brush controls.

**Per-spike breakdown table**: For each spike — peak write RPS, avg write latency, peak read latency, error count.

**Export buttons:**
- **Download JSON**: Full run data (config + summary + time-series) as `.json`.
- **Download Markdown Report**: Structured report with tables, suitable for pasting into docs/Slack.

### 4. Run History & Compare (`/history`)

**Runs table**: All past runs sorted newest-first with: run ID, date, status, doc size, write mode, index profile, peak write RPS, p99 latency, verdict. Delete button per row.

**Comparing runs:**
1. Check 2–4 runs in the table.
2. Click **Compare Selected**.
3. The compare view shows:
   - **Overlay charts** (2x2): Write throughput, read throughput, write p99, read p99 — each with one line per selected run in a distinct color.
   - **Side-by-side summary table**: Config and performance fields as rows, one column per run. Cells where values differ are highlighted, making it easy to spot the impact of changing one variable (e.g., bulk vs single, 5KB vs 9KB, M50 vs M60).

### 5. Atlas Search Showcase (`/search`)

A demo page showcasing MongoDB Atlas Search capabilities — full-text search, autocomplete, faceted filtering, and relevance scoring. This is not a benchmark; it demonstrates functionality that ScyllaDB cannot do without an external search engine.

**Setup:**
1. Connect to your Atlas cluster (same URI as benchmarking).
2. Create the Atlas Search index (one-click button). Index builds asynchronously; the page shows status.
3. Run a benchmark first so there's data in the collection to search.

**Features:**
- **Search bar** with real-time autocomplete dropdown (type-ahead powered by edge n-grams on `subject`).
- **Suggested searches**: Clickable cards like "order shipped", "rewadr" (typo/fuzzy), "security update" to demonstrate different search features.
- **Filters**: Combine text search with status, user ID, and date range filters in a single query.
- **Results**: Relevance-ranked with highlighted search terms, latency display, and pagination.
- **Capabilities sidebar**: Explains each Atlas Search feature being demonstrated.

---

## Configuration Reference

| Section | Parameter | Default | Range / Options | Description |
|---------|-----------|---------|-----------------|-------------|
| Connection | MongoDB URI | (required) | — | Atlas connection string |
| Connection | Database name | `hedwig_bench` | — | Target database |
| Connection | Collection name | `inbox` | — | Target collection |
| Connection | Pool size | `200` | 1+ | MongoClient `maxPoolSize` |
| Document | Doc size (KB) | `7` | 1–50 | Document is padded to this size |
| Document | User pool size | `100,000` | 1+ | Number of unique `user_id` values |
| Index | Profile | `ttl` | `minimal` / `ttl` / `extended` | See [Index Profiles](#index-profiles) |
| Write | Mode | `bulk` | `bulk` / `single` | `insertMany` vs `insertOne` |
| Write | Batch size | `500` | 1+ | Docs per `insertMany` (bulk only) |
| Write | Target peak RPS | `35,000` | 1,000–50,000 | Peak write ops/sec during sustain |
| Write | Write concern | `w:majority` | — | Fixed at `w:majority` |
| Read | Target RPS | `1,500` | 100–5,000 | Constant read ops/sec |
| Spike | Number of spikes | `3` | 1–10 | How many write spikes |
| Spike | Ramp-up (seconds) | `120` | 30–300 | Linear ramp from 0 → target RPS |
| Spike | Sustain (seconds) | `180` | 30–600 | Hold at target RPS |
| Spike | Gap (seconds) | `60` | 30–300 | Pause between spikes (reads continue) |
| Actions | Drop collection | `false` | — | Drop collection before the run starts |

**Quick Smoke Test** overrides: 1 spike, 5,000 write RPS, 500 read RPS, 30s ramp, 60s sustain, 30s gap (~2.5 min total).

---

## Workload Model

### Spike Algorithm

The spike simulator controls the write worker's target RPS every second based on a pre-computed schedule.

Each spike has three phases:

```
Target RPS
    ▲
    │         ┌──────────────┐
max │        ╱│   SUSTAIN    │╲
    │       ╱ │              │ ╲
    │      ╱  │              │  ╲
    │     ╱   │              │   ╲
    │    ╱    │              │    ╲
  0 │───╱─────┴──────────────┴─────╲────── time
    │  RAMP                      COOL
    │  (configurable)            DOWN
    │                            (60s fixed)
```

1. **Ramp** (configurable, default 120s): Linear interpolation from 0 → target RPS.
   - At second `t`: `currentTarget = targetRPS × (t / rampSeconds)`
2. **Sustain** (configurable, default 180s): Hold at target RPS.
3. **Cooldown** (fixed 60s): Linear ramp from target RPS → 0.
   - At second `t`: `currentTarget = targetRPS × (1 - t / 60)`

Between spikes: **Gap** (configurable, default 60s) where write target = 0. Reads continue at their constant rate throughout.

A full 3-spike run:

```
RPS
35k │    ╱──╲        ╱──╲        ╱──╲
    │   ╱    ╲      ╱    ╲      ╱    ╲
    │  ╱      ╲    ╱      ╲    ╱      ╲
    │ ╱        ╲  ╱        ╲  ╱        ╲
  0 │╱──────────╲╱──────────╲╱──────────╲───
    └──────────────────────────────────────── time
     spike 1     spike 2     spike 3
      (360s)  gap  (360s)  gap  (360s)
              60s          60s
```

**Total duration formula:**
```
total = numSpikes × (rampSeconds + sustainSeconds + 60) + (numSpikes - 1) × gapSeconds
```

Default (3 spikes): `3 × (120 + 180 + 60) + 2 × 60 = 1200s = 20 minutes`

### Document Schema

```json
{
  "_id": "ObjectId(...)",
  "user_id": "user_042819",
  "msg_id": "13269247-1f10-4865-9059-ad3507c28f98",
  "campaign_id": "camp_a1b2c3",
  "subject": "Your weekly digest is ready",
  "body": "...(padded to reach target doc size)...",
  "status": "unread",
  "created_at": "2026-03-28T10:30:00.000Z",
  "metadata": {
    "channel": "inbox",
    "priority": "normal",
    "template_id": "tmpl_d4e5f6"
  }
}
```

- `user_id`: Random from pool (`user_000001` to `user_{poolSize}`)
- `msg_id`: UUID — matches the Scylla `msg_id` clustering key
- `campaign_id`: Random hex (`camp_` + 6 hex chars)
- `subject`: Selected from 20 realistic subject line templates
- `body`: Padded with random words to reach the exact target document size in KB
- `status`: Random choice of `"delivered"`, `"read"`, `"unread"`
- `created_at`: Current timestamp at insert time
- `metadata`: Nested subdocument — demonstrates MongoDB's native nested document support (something Scylla can't do without frozen UDTs)

### Index Profiles

Modelled after the Scylla access patterns (`WHERE pk = ? AND msg_id = ?`, `WHERE pk = ? AND created_at > ?`, `WHERE pk = ? AND status = ? ORDER BY created_at DESC`):

| Profile | # Indexes | Indexes Created |
|---------|-----------|-----------------|
| **Minimal** | 2 | `{ user_id: 1, msg_id: 1 }` — point read by user + message ID |
| | | `{ user_id: 1, created_at: -1 }` — recent inbox query |
| **TTL** | 3 | All Minimal indexes + |
| | | `{ created_at: 1 }` with `expireAfterSeconds: 5184000` (60-day auto-deletion) |
| **Extended** | 4 | All TTL indexes + |
| | | `{ user_id: 1, status: 1, created_at: -1 }` — filtered inbox by status (avoids collection scan that Scylla needs `ALLOW FILTERING` for) |

Start with **TTL** (the default) which matches the Hedwig production requirement. Use **Extended** if you want to benchmark the cost of supporting the filtered-inbox query efficiently.

### Read Query Patterns

The read worker randomly selects among three query patterns that mirror the Scylla access patterns:

| Pattern | Weight | MongoDB Query | Scylla Equivalent |
|---------|--------|---------------|-------------------|
| **Point read** | 30% | `findOne({ user_id, msg_id })` | `WHERE pk = ? AND msg_id = ?` |
| **Recent messages** | 40% | `find({ user_id, created_at: { $gt: 24h ago } }).sort({ created_at: -1 }).limit(20)` | `WHERE pk = ? AND created_at > ? LIMIT ?` |
| **Filtered inbox** | 30% | `find({ user_id, status }).sort({ created_at: -1 }).limit(20)` | `WHERE pk = ? AND status = ? ORDER BY created_at DESC LIMIT ? ALLOW FILTERING` |

Note: The Extended index profile adds `{ user_id: 1, status: 1, created_at: -1 }` which makes the filtered inbox query efficient. With Minimal/TTL profiles, MongoDB will use `{ user_id: 1, created_at: -1 }` and filter in-memory — still faster than Scylla's `ALLOW FILTERING` in most cases.

---

## Pass/Fail Criteria

A run receives a **PASS** verdict when **all three** conditions are met:

| Condition | Threshold | Rationale |
|-----------|-----------|-----------|
| Write throughput | Achieved >90% of target RPS during sustain phases | The cluster can keep up with the write load |
| Write p99 latency | <50ms | Acceptable for async inbox delivery |
| Error rate | <1% of total operations | Minimal failures under load |

If any condition fails, the verdict is **FAIL**. The Results page shows which specific criteria failed.

---

## API Reference

### Benchmark Endpoints

All endpoints are prefixed with `/api`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runs` | Start a new benchmark run. Body: config JSON. Returns `{ id, status }`. |
| `GET` | `/api/runs` | List all runs (without time-series data for performance). |
| `GET` | `/api/runs/:id` | Get full run details including config, summary, and time-series. |
| `DELETE` | `/api/runs/:id` | Delete a run and its data. |
| `POST` | `/api/runs/:id/stop` | Gracefully stop a running benchmark. |
| `GET` | `/api/runs/preview-doc?docSize=7&userPoolSize=100000` | Generate and return a sample document. |
| `GET` | `/api/health` | Health check. Returns `{ ok: true }`. |

**Example — start a smoke test:**

```bash
curl -X POST http://localhost:3001/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "mongoUri": "mongodb+srv://user:pass@cluster.mongodb.net",
    "dbName": "hedwig_bench",
    "collectionName": "inbox",
    "poolSize": 200,
    "docSize": 7,
    "userPoolSize": 100000,
    "indexProfile": "ttl",
    "writeMode": "bulk",
    "batchSize": 500,
    "targetWriteRPS": 5000,
    "writeConcern": "w:majority",
    "targetReadRPS": 500,
    "numSpikes": 1,
    "rampSeconds": 30,
    "sustainSeconds": 60,
    "gapSeconds": 30,
    "dropCollection": false
  }'
```

### Search Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/search/connect` | Connect to Atlas for search. Body: `{ mongoUri, dbName, collectionName }`. |
| `GET` | `/api/search/index` | Check if the Atlas Search index exists. |
| `POST` | `/api/search/index` | Create the Atlas Search index (async, builds in background). |
| `POST` | `/api/search/query` | Full-text search. Body: `{ query, filters?, page?, pageSize? }`. |
| `POST` | `/api/search/autocomplete` | Autocomplete suggestions. Body: `{ prefix }`. |

**Atlas Search index definition** created by `POST /api/search/index`:

```json
{
  "name": "default",
  "definition": {
    "mappings": {
      "dynamic": false,
      "fields": {
        "subject": [
          { "type": "string", "analyzer": "lucene.standard" },
          { "type": "autocomplete", "tokenization": "edgeGram", "minGrams": 3, "maxGrams": 15 }
        ],
        "body": { "type": "string", "analyzer": "lucene.standard" },
        "campaign_id": { "type": "string", "analyzer": "lucene.keyword" },
        "status": { "type": "string", "analyzer": "lucene.keyword" },
        "user_id": { "type": "string", "analyzer": "lucene.keyword" },
        "created_at": { "type": "date" }
      }
    }
  }
}
```

### WebSocket

Connect to `ws://localhost:3001/ws/runs/:id` to receive real-time metrics during a run.

**Message types:**

```json
// Metrics snapshot (every second)
{
  "type": "metrics",
  "data": {
    "second": 42,
    "timestamp": "2026-03-28T10:30:42.000Z",
    "phase": "ramp",
    "targetWriteRPS": 12250,
    "write": {
      "ops": 11890,
      "errors": 0,
      "p50": 3.2,
      "p95": 8.1,
      "p99": 14.7
    },
    "read": {
      "ops": 1498,
      "errors": 0,
      "p50": 2.1,
      "p95": 5.4,
      "p99": 9.2
    },
    "system": {
      "connections": 187,
      "insertOps": 524310,
      "queryOps": 62940,
      "cacheDirtyBytes": 1048576
    }
  }
}

// Status change
{
  "type": "status",
  "data": {
    "status": "completed",
    "summary": { ... }
  }
}
```

System metrics (`system` field) update every 5 seconds; between updates the last known value is included. Latencies are in milliseconds.

---

## Engine Internals

The load generation engine lives in `server/src/engine/` and consists of these components:

| Component | File | Description |
|-----------|------|-------------|
| **Document Generator** | `document.js` | Generates inbox documents with exact KB sizing. Uses `crypto.randomBytes` for IDs, `crypto.randomUUID` for msg_id, and a pool of 20 subject line templates. Includes nested `metadata` subdocument. |
| **Index Setup** | `indexes.js` | Creates indexes based on the selected profile, modelled after Scylla access patterns. Uses `createIndexes` for idempotent batch creation. |
| **Rate Limiter** | `rateLimiter.js` | Token-bucket implementation with 10ms refill interval for smooth pacing. Supports dynamic rate updates (called every second by the spike scheduler). Async `acquire()` with a FIFO waiter queue. |
| **Spike Scheduler** | `spike.js` | Pre-computes the entire run schedule as an array of `{ second, targetWriteRPS }` entries. Also used client-side for the spike pattern preview SVG. |
| **Write Worker** | `writer.js` | Runs 50 concurrent "lanes" (configurable). Each lane loops: acquire tokens → generate documents → `insertMany`/`insertOne` → record latency. Supports bulk (`ordered: false`) and single insert modes. Write concern fixed at `w:majority`. |
| **Read Worker** | `reader.js` | Runs 20 concurrent lanes (configurable). Each lane picks a random query pattern (point read 30%, recent messages 40%, filtered inbox 30%), acquires a token, executes the query, and records latency. |
| **Metrics Collector** | `metrics.js` | Every second: drains worker accumulators, computes p50/p95/p99 latencies, emits a snapshot. Every 5 seconds: calls `serverStatus` for system metrics (connections, opcounters, WiredTiger cache). |
| **Run Manager** | `manager.js` | Orchestrates the full lifecycle: connect → (drop collection) → create indexes → generate schedule → create workers → tick loop (1s interval, update rate limiter) → cleanup on completion/stop/error. |

**Concurrency model**: The write and read workers use async concurrency pools (not `worker_threads`). Each "lane" is an independent async loop that acquires tokens from the rate limiter before each operation. With 50 write lanes and batch size 500, you can have up to 50 in-flight `insertMany` calls simultaneously.

**Rate limiter details**: The token bucket refills every 10ms (100 times/second) for smooth pacing. When the spike scheduler updates the target RPS each second, it calls `rateLimiter.updateRate()` which changes the refill rate. Tokens that exceed the bucket capacity are discarded — this prevents burst buildup during gaps.

---

## Deployment Guide

### Running Locally

Best for smoke tests and development.

```bash
npm run install:all
npm run dev
```

**Limitations**: Your local machine's network latency to Atlas will inflate latency measurements, and your CPU/bandwidth may cap out before hitting high RPS targets.

### Running on EC2 (Recommended for Full Load)

For benchmarks targeting 10k+ RPS, run hedwig-bench from an EC2 instance in the **same AWS region** as your Atlas cluster (e.g., `ap-southeast-1` for Hedwig).

**Recommended instance**: `c5.2xlarge` (8 vCPU, 16 GB RAM) or larger.

```bash
# On EC2 instance (Amazon Linux 2 / Ubuntu)
# Install Node.js 18+
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs   # or sudo apt-get install -y nodejs

# Clone and set up
git clone <repo-url> hedwig-bench
cd hedwig-bench
npm run install:all

# Build frontend for production
npm run build

# Start in production mode (serves built frontend from Express)
npm start
```

Access via `http://<ec2-public-ip>:3001`. Make sure security group allows inbound on port 3001.

**Alternatively**, run just the backend on EC2 and the frontend locally with the Vite proxy pointing to the EC2 instance.

### Production Build

```bash
# Build the frontend
npm run build
# Output: client/dist/

# Start the server (will serve the API; point a reverse proxy at it)
cd server && npm start
```

For production deployments, put nginx or similar in front to serve the static frontend files and proxy `/api` and `/ws` to the Express server.

---

## Performance Tuning

### Maximizing Write Throughput

| Lever | How | Impact |
|-------|-----|--------|
| **Batch size** | Increase from 500 to 1000–2000 | Fewer round trips, higher throughput, higher per-batch latency |
| **Connection pool** | Increase from 200 to 500+ | More concurrent connections to Atlas |
| **Run from same region** | EC2 in `ap-southeast-1` | Eliminates cross-region latency |
| **Atlas tier** | Scale up to M50/M60 | More IOPS and memory |

### Reducing Latency

| Lever | How | Impact |
|-------|-----|--------|
| **Same-region deployment** | Critical | Network latency is often the dominant factor |
| **Fewer indexes** | Use Minimal profile | Each index adds write overhead |
| **Smaller documents** | Reduce doc size | Less data per operation |
| **Pre-warm the cluster** | Run a smoke test first | Atlas auto-scales; cold starts are slower |

### If You Can't Hit Target RPS

If the actual write RPS is significantly below target:

1. **Check the bottom bar** for errors — connection timeouts, rate limiting from Atlas, auth failures.
2. **Look at the system chart** — if connections are maxed, increase pool size.
3. **Try from EC2** — local machines are usually network-bottlenecked.
4. **Reduce batch size** — smaller batches complete faster and can improve pacing accuracy at very high rates.
5. **Check Atlas metrics** — the cluster itself may be CPU/IOPS saturated. Scale up the tier.

---

## Troubleshooting

### "Failed to start run" / Connection errors

- Verify your MongoDB URI is correct (test with `mongosh` first).
- Check that your IP is in the Atlas Network Access list.
- Ensure the Atlas cluster is running (not paused).

### WebSocket disconnects during a run

- The dashboard auto-reconnects after 2 seconds.
- If persistent, check that no proxy/firewall is terminating WebSocket connections.
- The run continues on the backend even if the frontend disconnects — reconnect to see live data, or check results after completion.

### "RateLimiter acquire timeout" errors

- This can happen if the rate limiter's target drops to 0 during a gap while workers are still trying to acquire tokens.
- These are handled gracefully and counted as errors in metrics. A small number is expected during phase transitions.

### Server won't start / SQLite errors

- Ensure the `server/data/` directory is writable.
- Delete `server/data/hedwig-bench.db` to reset the database if corrupted.

### Charts show no data

- Ensure WebSocket is connected (check the connection indicator dot in the top bar).
- Verify the backend is running (`curl http://localhost:3001/api/health`).
- Check browser console for errors.

### Run stuck in "running" status

- If the server was killed without graceful shutdown, runs may be stuck.
- Delete the run from the History page, or use `DELETE /api/runs/:id`.

### Atlas Search index not building

- Atlas Search requires M10+ clusters (not available on free tier M0).
- Index builds are asynchronous — it may take a few minutes. Use the refresh button on the Search page to check status.
- Ensure the collection has data (run a benchmark first).

---

## Project Structure

```
hedwig-bench/
├── package.json                    # Root: concurrently runs server + client
├── .gitignore
├── README.md
│
├── client/                         # React frontend (Vite + Tailwind + Recharts)
│   ├── package.json
│   ├── index.html
│   ├── vite.config.js              # Dev proxy: /api → :3001, /ws → ws://:3001
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── src/
│       ├── main.jsx                # React Router setup
│       ├── App.jsx                 # Nav layout + Outlet
│       ├── index.css               # Tailwind directives + custom scrollbar
│       ├── pages/
│       │   ├── ConfigPage.jsx      # Full config form, doc preview, spike SVG
│       │   ├── LiveDashboard.jsx   # Real-time charts via WebSocket
│       │   ├── ResultsPage.jsx     # Summary cards, charts with zoom, export
│       │   ├── HistoryPage.jsx     # Runs table + multi-run comparison overlay
│       │   └── SearchPage.jsx      # Atlas Search showcase (full-text, autocomplete)
│       └── lib/
│           ├── api.js              # REST client (fetch) + WebSocket factory
│           └── spike.js            # Client-side schedule generator (for previews)
│
├── server/                         # Express backend
│   ├── package.json
│   └── src/
│       ├── index.js                # Express + HTTP + WebSocket server, SIGINT handler
│       ├── routes/
│       │   ├── runs.js             # Benchmark API routes + summary computation
│       │   └── search.js           # Atlas Search API (connect, index, query, autocomplete)
│       ├── db/
│       │   └── database.js         # SQLite (better-sqlite3) CRUD layer
│       └── engine/
│           ├── document.js         # Document generator (exact KB sizing, nested metadata)
│           ├── indexes.js          # Index profile setup (modelled from Scylla queries)
│           ├── rateLimiter.js      # Token-bucket (10ms refill, async waiters)
│           ├── spike.js            # Schedule generator (ramp/sustain/cooldown/gap)
│           ├── writer.js           # Write worker (50 lanes, bulk/single, w:majority)
│           ├── reader.js           # Read worker (20 lanes, 3 query patterns)
│           ├── metrics.js          # Per-second + system metrics collector
│           └── manager.js          # Run lifecycle orchestrator
│
└── server/data/                    # Created at runtime
    └── hedwig-bench.db             # SQLite database (gitignored)
```

---

## Safety

> **Never point this tool at a production cluster.**

This tool is designed to generate heavy write load. Safeguards built in:

- **Confirmation dialog**: The "Start Benchmark" button always shows a confirmation dialog stating the target write RPS and asking for explicit confirmation before proceeding.
- **Drop collection guard**: If "Drop collection before run" is checked, a separate confirmation dialog warns that all data will be lost.
- **URI masking**: The MongoDB URI is masked in the UI after entry (first 20 characters + "...") with a toggle to reveal. The full URI is never logged by the backend.
- **Graceful shutdown**: Ctrl+C (SIGINT/SIGTERM) gracefully stops all active runs, finishes in-flight operations, flushes metrics, and saves partial results before exiting. A 5-second timeout forces exit if graceful shutdown hangs.

**Recommendations:**
- Use a dedicated benchmark cluster, separate from staging/production.
- For Atlas, create a temporary cluster specifically for benchmarking and delete it when done.
- Monitor Atlas metrics (CPU, IOPS, connections) alongside hedwig-bench during runs.
- Start with a Quick Smoke Test to validate connectivity and configuration before running full-scale benchmarks.
