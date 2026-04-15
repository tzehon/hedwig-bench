# Hedwig Bench

MongoDB Atlas inbox workload benchmark tool with real-time dashboard, Atlas Search showcase, and Query Demo.

Simulates the bursty campaign-blast write pattern of the Hedwig inbox messaging service (0 → 35k+ write ops/sec spikes) with variable-rate reads (3.5k–10k RPS, configurable isolation vs concurrent). Provides live charts, run comparison, and interactive demos of MongoDB query and search capabilities.

![Architecture](https://img.shields.io/badge/stack-React%20%2B%20Express%20%2B%20MongoDB-blue)

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
  - [6. Query Demo](#6-query-demo)
- [Configuration Reference](#configuration-reference)
- [Workload Model](#workload-model)
  - [Spike Algorithm](#spike-algorithm)
  - [Document Schema](#document-schema)
  - [Indexes](#indexes)
  - [Read Query Patterns](#read-query-patterns)
- [API Reference](#api-reference)
  - [Benchmark Endpoints](#benchmark-endpoints)
  - [Search Endpoints](#search-endpoints)
  - [Query Endpoints](#query-endpoints)
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
React Frontend  <--- WebSocket --->  Express Backend  --- mongodb --->  Atlas Cluster
(Vite, Tailwind,                     (Load Engine,
 Recharts)                            SQLite, WS)
```

**Frontend pages:** Configure & Run, Live Dashboard, Results, History & Compare, Atlas Search, Query Demo

**Backend engine:** Document Gen, Spike Scheduler (write + read), Write Worker (50 lanes), Read Worker (50 lanes), Token-Bucket Rate Limiters, Metrics Collector

**Data flow:** Frontend configures a run via REST API. Backend drives the load engine, streams per-second metrics over WebSocket to the live dashboard, and persists results to SQLite.

- **Frontend**: React 18 (Vite), Tailwind CSS, Recharts for live charts.
- **Backend**: Express.js, `ws` for real-time metrics streaming, official MongoDB Node.js driver (`mongodb` v6).
- **Storage**: `better-sqlite3` for run metadata, config, and full time-series persistence across restarts.
- **Metrics**: Streamed via WebSocket from backend to frontend every second during a run.

---

## Prerequisites

- **Node.js** >= 18 (uses ES modules, `performance.now()`)
- **npm** >= 9
- **MongoDB Atlas cluster** — M10+ recommended for benchmarks; M60+ for full 35k RPS load tests
- **Atlas Search**: For the search showcase tab, the cluster must support Atlas Search (M10+; not available on M0 free tier)
- **Network access**: The machine running hedwig-bench must be able to reach the Atlas cluster. Add its IP to your Atlas Network Access list.

---

## Quick Start

```bash
cd hedwig-bench

# Install all dependencies (root + server + client)
npm run install:all

# (Optional) Pre-fill your MongoDB URI so you don't have to paste it each time
cp client/.env.example client/.env
# Edit client/.env and set VITE_MONGO_URI=mongodb+srv://...

# Start both frontend and backend in dev mode
npm run dev
```

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001
- **Health check**: http://localhost:3001/api/health

Open the frontend, paste your MongoDB URI (or it's pre-filled from `.env`), and click **Quick Smoke Test** to verify everything works.

---

## Usage Guide

### 1. Configure & Run (`/`)

The home page presents a form with collapsible sections for all benchmark parameters.

**Key features:**
- **Run name**: Optional label for the run (shown in history, dashboard, results, and comparison).
- **MongoDB URI masking**: After you enter the URI, it's masked in the UI. Click the eye icon to toggle visibility. The URI is never logged in full.
- **Live document preview**: As you adjust the document size slider, a debounced API call generates and displays a sample document in formatted JSON.
- **Spike pattern preview**: An SVG visualization updates in real time as you adjust spike parameters.
- **Uncapped mode**: Removes the write rate limiter to find the cluster's maximum throughput.
- **Before-run options**: Keep existing data, delete data but keep indexes, or drop the entire collection.
- **Quick Smoke Test**: One-click preset — 1 spike, 5k write RPS, 500 constant read RPS, 10s ramp, 30s sustain. Takes ~100 seconds.

**Starting a run:**
1. Fill in the MongoDB URI (required) or set it via `VITE_MONGO_URI` in `client/.env`.
2. Adjust parameters as needed.
3. Click **Start Benchmark** and confirm.
4. You're redirected to the Live Dashboard.

### 2. Live Dashboard (`/run/:id`)

Shows real-time benchmark progress with charts updating every second via WebSocket.

**Layout:**
- **Top bar**: Run name/ID, elapsed time (MM:SS), current phase badge (Ramp / Sustain / Cooldown / Gap / Read Only / Complete) with Concurrent/Isolation mode indicator, progress bar, and a segmented bar showing the concurrent vs isolation split.
- **Throughput charts** (side-by-side): Write ops/sec actual vs target (dashed), Read ops/sec actual vs target (both dynamic).
- **Latency charts** (side-by-side): Write latency per document (p50/p95/p99), Read latency per query (p50/p95/p99) with 50ms threshold reference line.
- **System chart** (wide): Connection count, insert ops/sec, query ops/sec, WiredTiger dirty cache bytes. Updates every 5 seconds.
- **Bottom bar**: Error counts and error rate percentage. Flashes red if error rate exceeds 1%.

**Controls:**
- **Stop Run**: Graceful shutdown — finishes in-flight operations, flushes metrics, saves partial results.
- **View Results**: Appears when the run completes.

### 3. Results (`/results/:id`)

Static report view after a run completes.

**Summary cards (top row):**
- **Configuration**: Doc size, index profile, write mode, write concern.
- **Write Performance**: Peak write RPS, avg sustain RPS, p50/p90/p99 latency (per document).
- **Concurrent Reads**: Target vs achieved QPS with formula (e.g. `8k qps × 1 doc = 8k docs/s`), p50/p90/p99 latency.
- **Isolation Reads**: Target vs achieved QPS with formula (e.g. `2k qps × ~30 docs = 60k docs/s`), p50/p90/p99 latency.

**Read targets vs achieved table**: Shows side-by-side comparison for each phase:

| Phase | Target QPS | Docs/query | Target Docs/s | Achieved QPS | Achieved Docs/s | p99 |
|-------|-----------|------------|---------------|-------------|-----------------|-----|
| Concurrent (60%) | 8,000 | 1 | 8,000 | actual | actual | ms |
| Isolation (40%) | 2,000 | ~30 avg | ~60,000 | actual | actual × 30 | ms |

**Full charts**: Same as the Live Dashboard but with all data and zoom/pan via Recharts Brush controls.

**Per-spike breakdown table**: For each spike — peak write RPS, avg write latency, peak read latency, error count.

**Export buttons:**
- **Download JSON**: Full run data (config + summary + time-series) as `.json`.
- **Download Markdown Report**: Structured report with tables, suitable for pasting into docs/Slack.

### 4. Run History & Compare (`/history`)

**Runs table**: All past runs sorted newest-first with: name, date, status, doc size, write mode, index profile, peak write RPS, p99 latency. Delete button per row.

**Comparing runs:**
1. Check 2–4 runs in the table.
2. Click **Compare Selected**.
3. Overlay charts (write/read throughput, write/read p99 latency) and side-by-side summary table with config differences highlighted.

**Clear History**: Deletes all saved runs.

### 5. Atlas Search Showcase (`/search`)

A demo page showcasing MongoDB Atlas Search capabilities — full-text search, autocomplete, faceted filtering, and relevance scoring. This is not a benchmark; it demonstrates additional MongoDB functionality.

**Setup:**
1. Connect to your Atlas cluster (URI auto-filled from env).
2. Create the Atlas Search index (one-click button). Index builds asynchronously.
3. Run a benchmark first so there's data in the collection to search.

**Features:**
- **Search bar** with real-time autocomplete dropdown (type-ahead powered by edge n-grams on `subject`).
- **Suggested searches**: Clickable cards demonstrating full-text, fuzzy matching, and phrase search.
- **Filters**: Combine text search with status, user ID, and date range filters in a single query.
- **Results**: Relevance-ranked with highlighted search terms, latency display, and pagination.
- **Capabilities sidebar**: Explains each Atlas Search feature being demonstrated.

### 6. Query Demo (`/queries`)

Interactive query runner demonstrating MongoDB's query capabilities with explain plans.

**Query patterns:**
- **Point Read**: Fetch a single message by user + msg_id.
- **Recent Messages**: Fetch user's recent inbox (last 24h).
- **Filtered Inbox**: Fetch user's messages filtered by status, sorted by recency.

For each query, the results show:
- The executed MongoDB query.
- Returned documents.
- Server-side execution time (from explain).
- Index used (or "Collection Scan" warning).
- Documents and keys examined.

---

## Configuration Reference

| Section | Parameter | Default | Range / Options | Description |
|---------|-----------|---------|-----------------|-------------|
| | Run name | (optional) | — | Label for the run (shown in history/comparison) |
| Connection | MongoDB URI | (from env or manual) | — | Atlas connection string |
| Connection | Database name | `hedwig_bench` | — | Target database |
| Connection | Collection name | `inbox` | — | Target collection |
| Connection | Pool size | `200` | 1+ | MongoClient `maxPoolSize` |
| Document | Doc size (KB) | `3` | 1–50 | Document is padded to this size |
| Document | User pool size | `100,000` | 1+ | Number of unique `user_id` values |
| Index | Profile | `extended` | — | Fixed: 4 indexes (point read, recent inbox, TTL, filtered inbox) |
| Write | Mode | `bulk` | `bulk` / `single` | `insertMany` vs `insertOne` |
| Write | Batch size | `500` | 1+ | Docs per `insertMany` (bulk only) |
| Write | Target peak RPS | `35,000` | 1,000–50,000 | Peak write ops/sec during sustain |
| Write | Write concern | `w:majority` | — | Fixed at `w:majority` |
| Write | Uncapped mode | `off` | on / off | Skip rate limiter to find max throughput |
| Read | Mode | `variable` | `constant` / `variable` | **Constant**: fixed rate, concurrent with writes (baseline). **Variable**: different rates for concurrent vs isolation phases. |
| Read | Concurrent RPS | `8,000` | 100–20,000 | Variable mode: read ops/sec during write-active phases (point reads, 1 item) |
| Read | Isolation RPS | `2,000` | 100–20,000 | Variable mode: read ops/sec during read-only phase (list queries, 10–50 items, avg ~30) |
| Read | Isolation % | `40` | 0–80 | Variable mode: percentage of total run time that is read-only (no concurrent writes) |
| Read | Concurrency (lanes) | `50` | 1–500 | Concurrent read lanes. Increase for high RPS targets (>5k) or high-latency setups. |
| Spike | Number of spikes | `2` | 1–10 | How many write spikes |
| Spike | Ramp-up (seconds) | `60` | 30–300 | Linear ramp from 0 → target RPS |
| Spike | Sustain (seconds) | `120` | 30–600 | Hold at target RPS |
| Spike | Gap (seconds) | `30` | 30–300 | Pause between spikes (reads continue) |
| Actions | Before run | Keep data | Keep / Delete data / Drop collection | What to do before starting |

**Quick Smoke Test** overrides: 1 spike, 5,000 write RPS, 500 constant read RPS (no isolation), 10s ramp, 30s sustain (~100s total).

---

## Workload Model

### Spike Algorithm

The spike simulator controls both the write and read workers' target RPS every second based on a pre-computed schedule.

#### Write spikes

Each write spike has three phases:

```
Target Write RPS
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

1. **Ramp** (configurable, default 60s): Linear interpolation from 0 → target RPS.
2. **Sustain** (configurable, default 120s): Hold at target RPS.
3. **Cooldown** (fixed 60s): Linear ramp from target RPS → 0.

Between spikes: **Gap** (configurable, default 30s) where write target = 0.

#### Read schedule

Two modes are available:

**Constant mode** (legacy): Reads run at a fixed rate throughout the entire benchmark, concurrent with writes. No isolation phase is appended. Useful as a simple baseline.

**Variable mode** (default): Isolation blocks are **interleaved after each write spike**, not appended at the end. Each phase has its own read rate and query pattern:

- **Concurrent phases** (ramp/sustain/cooldown): Reads at 8,000 RPS using point reads (1 item). Reads use `secondaryPreferred` to avoid contention with writes on the primary.
- **Isolation blocks** (after each spike): Reads at 2,000 RPS using list queries (10–50 items, avg ~30). No concurrent writes.

```
  Write RPS                              Read RPS
    ▲                                      ▲
35k │  ╱──╲        ╱──╲                 8k │──────╲     ╱──────╲
    │ ╱    ╲      ╱    ╲                   │       ╲   ╱        ╲
    │╱      ╲    ╱      ╲              2k │        ╲─╱          ╲────
  0 │────────╲──╱────────╲────           0 │─────────────────────────
    │ Spike1  Iso  Spike2  Iso             │ Conc.  Iso  Conc.   Iso
```

#### Total duration formula

```
writeActive = numSpikes × (rampSeconds + sustainSeconds + 60)
totalIsolation = ceil(isolationPct × writeActive / (1 − isolationPct))
blockDuration = ceil(totalIsolation / numSpikes)
total = writeActive + numSpikes × blockDuration
```

Default (2 spikes, 40% isolation): `writeActive = 480s, blockDuration = 160s → total = 480 + 320 = 800s ≈ 13.3 minutes`

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
  "created_at": "2026-04-06T10:30:00.000Z",
  "metadata": {
    "channel": "inbox",
    "priority": "normal",
    "template_id": "tmpl_d4e5f6"
  }
}
```

- `user_id`: Random from pool (`user_000001` to `user_{poolSize}`)
- `msg_id`: UUID
- `campaign_id`: Random hex (`camp_` + 6 hex chars)
- `subject`: Selected from 20 realistic subject line templates
- `body`: Padded with random text to reach the exact target document size in KB
- `status`: Random choice of `"delivered"`, `"read"`, `"unread"`
- `created_at`: Current timestamp at insert time
- `metadata`: Nested subdocument demonstrating MongoDB's native nested document support

### Indexes

Fixed at the **Extended** profile (4 indexes):

| Index | Purpose |
|-------|---------|
| `{ user_id: 1, msg_id: 1 }` | Point read by user + message ID |
| `{ user_id: 1, created_at: -1 }` | Recent inbox query sorted by recency |
| `{ created_at: 1 }` with 60-day TTL | Auto-deletion of old messages |
| `{ user_id: 1, status: 1, created_at: -1 }` | Filtered inbox by status, sorted by recency |

### Read Query Patterns

The read worker runs at a variable rate (paced by a token-bucket rate limiter updated each second) and switches query patterns based on the current phase:

All reads use `readPreference: secondaryPreferred` to avoid contention with writes on the primary.

**Concurrent mode** (60% of run — writes active, 8k RPS): point reads only, returning 1 item per query. Pre-seeded msg_id cache ensures reads hit real documents.

| Pattern | MongoDB Query | Items returned |
|---------|---------------|----------------|
| **Point read** | `findOne({ user_id, msg_id })` | 1 |

**Isolation mode** (40% of run — read-only, 2k RPS): list queries returning 10–50 items (avg ~30) per query. Interleaved after each write spike.

| Pattern | Weight | MongoDB Query | Items returned |
|---------|--------|---------------|----------------|
| **Recent messages** | 50% | `find({ user_id, created_at: { $gt: 24h ago } }).project({ body: 0 }).sort({ created_at: -1 }).limit(10–50)` | 10–50 |
| **Filtered inbox** | 50% | `find({ user_id, status }).project({ body: 0 }).sort({ created_at: -1 }).limit(10–50)` | 10–50 |

List queries project out the `body` field (realistic for inbox list views). Point reads return the full document.

---

## API Reference

### Benchmark Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runs` | Start a new benchmark run. Body: config JSON. Returns `{ id, status }`. |
| `GET` | `/api/runs` | List all runs (without time-series data). |
| `GET` | `/api/runs/:id` | Get full run details including config, summary, and time-series. |
| `DELETE` | `/api/runs/:id` | Delete a run and its data. |
| `POST` | `/api/runs/:id/stop` | Gracefully stop a running benchmark. |
| `GET` | `/api/runs/preview-doc?docSize=3&userPoolSize=100000` | Generate and return a sample document. |
| `POST` | `/api/runs/cleanup` | Drop collection, remove search index, optionally clear history. |
| `GET` | `/api/health` | Health check. Returns `{ ok: true }`. |

### Search Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/search/connect` | Connect to Atlas for search. Body: `{ mongoUri, dbName, collectionName }`. |
| `GET` | `/api/search/index` | Check if the Atlas Search index exists. |
| `POST` | `/api/search/index` | Create the Atlas Search index. |
| `POST` | `/api/search/query` | Full-text search. Body: `{ query, filters?, page?, pageSize? }`. |
| `POST` | `/api/search/autocomplete` | Autocomplete suggestions. Body: `{ prefix }`. |

### Query Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/queries/connect` | Connect to Atlas for queries. Body: `{ mongoUri, dbName, collectionName }`. |
| `GET` | `/api/queries/sample-ids` | Fetch sample user_ids, msg_ids, campaign_ids from the collection. |
| `POST` | `/api/queries/run` | Run a query with explain. Body: `{ type, params }`. |

### WebSocket

Connect to `ws://localhost:3001/ws/runs/:id` to receive real-time metrics during a run.

**Message types:**

```json
{
  "type": "metrics",
  "data": {
    "second": 42,
    "phase": "sustain",
    "targetWriteRPS": 35000,
    "targetReadRPS": 4036,
    "write": { "ops": 34890, "errors": 0, "p50": 0.2, "p95": 0.4, "p99": 1.9 },
    "read": { "ops": 4011, "errors": 0, "p50": 2.1, "p95": 5.4, "p99": 9.2 },
    "system": { "connections": 187, "insertOps": 34800, "queryOps": 4002, "cacheDirtyBytes": 1048576 }
  }
}
```

Write latencies are **per document** (batch time ÷ batch size). `targetReadRPS` changes each second based on the schedule (concurrent rate during writes, variable during isolation). System `insertOps` and `queryOps` are per-second rates (delta from `serverStatus` opcounters).

---

## Engine Internals

The load generation engine lives in `server/src/engine/`:

| Component | File | Description |
|-----------|------|-------------|
| **Document Generator** | `document.js` | Generates inbox documents with exact KB sizing. Uses pre-built padding block and `Math.random` for fast generation (~0.5ms per 500-doc batch). |
| **Index Setup** | `indexes.js` | Creates 4 indexes (Extended profile). Uses `createIndexes` for idempotent batch creation. |
| **Rate Limiter** | `rateLimiter.js` | Token-bucket with monotonic-clock-based 10ms refill. Supports dynamic rate updates. Bucket size tracks current rate to prevent burst overshoot. |
| **Spike Scheduler** | `spike.js` | Pre-computes the run schedule as `{ second, targetWriteRPS, targetReadRPS }` entries. Calculates isolation phase duration and concurrent read rate. Also used client-side for spike preview SVG. |
| **Write Worker** | `writer.js` | 50 concurrent lanes. Each lane: acquire tokens → generate docs → `insertMany`/`insertOne` → record per-doc latency. Supports uncapped mode (bypasses rate limiter). |
| **Read Worker** | `reader.js` | 150 concurrent lanes using `secondaryPreferred`. Phase-aware: point reads (1 item) during concurrent, list queries (10–50 items) during isolation. Rate dynamically updated each second. |
| **Metrics Collector** | `metrics.js` | Every second: drains worker accumulators, sorts latencies once, computes p50/p95/p99. Every 5 seconds: `serverStatus` for system metrics (per-second deltas). |
| **Run Manager** | `manager.js` | Orchestrates: connect → (delete data / drop collection) → create indexes → generate schedule → start workers → tick loop (updates both write and read rate limiters each second) → cleanup. |

**Concurrency model**: Async concurrency pools (not `worker_threads`). 50 write lanes + 50 read lanes sharing a connection pool of 200. At 35k RPS with batch 500, the client uses ~4% CPU for doc generation — the rest is async IO.

---

## Deployment Guide

### Running Locally

```bash
npm run install:all
npm run dev
```

Best for smoke tests. Network latency to Atlas will inflate latency measurements.

### Running on EC2 (Recommended for Full Load)

For 10k+ RPS benchmarks, run from an EC2 instance in the **same AWS region** as your Atlas cluster.

**Recommended**: `c5.2xlarge` (8 vCPU, 16 GB RAM) in `ap-southeast-1`.

```bash
# Install Node.js and git
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs git

# Clone and set up
git clone <repo-url> hedwig-bench
cd hedwig-bench
npm run install:all

# Set your MongoDB URI
echo 'VITE_MONGO_URI=mongodb+srv://...' > client/.env

# Build and start
npm run build
npm start
```

Access via `http://<ec2-public-ip>:3001`. Open port 3001 in the security group.

### Production Build

```bash
npm run build    # Output: client/dist/
npm start        # Express serves both API and built frontend
```

---

## Performance Tuning

### Maximizing Write Throughput

| Lever | How | Impact |
|-------|-----|--------|
| **Batch size** | Increase from 500 to 1000+ | Fewer round trips, higher throughput |
| **Uncapped mode** | Check the toggle | Find actual cluster ceiling |
| **Same-region EC2** | Run in `ap-southeast-1` | Eliminates network latency |
| **NVMe storage** | Use NVMe tier | Higher burst capacity |
| **Provisioned IOPS** | Enable on Atlas | More consistent IO throughput |

### Reducing Latency

| Lever | How | Impact |
|-------|-----|--------|
| **Same-region deployment** | Critical | Network latency dominates |
| **Smaller documents** | Reduce doc size | Less data per operation |
| **Pre-warm the cluster** | Run a smoke test first | Atlas auto-scales; cold starts are slower |

---

## Troubleshooting

### "Failed to start run" / Connection errors

- Verify your MongoDB URI is correct (test with `mongosh` first).
- Check that your IP is in the Atlas Network Access list.
- Ensure the Atlas cluster is running (not paused).

### WebSocket disconnects during a run

- The dashboard auto-reconnects after 2 seconds.
- The run continues on the backend even if the frontend disconnects.

### Server won't start / SQLite errors

- Ensure the `server/data/` directory is writable.
- Delete `server/data/hedwig-bench.db` to reset if corrupted.

### Charts show no data

- Check the WebSocket connection indicator in the top bar.
- Verify the backend is running (`curl http://localhost:3001/api/health`).

### Run stuck in "running" status

- If the server was killed without graceful shutdown, runs may be stuck.
- Delete from the History page or use `DELETE /api/runs/:id`.

### Atlas Search index not building

- Requires M10+ clusters (not available on M0 free tier).
- Index builds are asynchronous — may take a few minutes.
- Ensure the collection has data (run a benchmark first).

### "Delete data keep indexes" is slow

- `deleteMany({})` removes documents one by one. For large datasets (millions of docs), use "Drop collection" instead — it's instant and indexes are recreated automatically.

---

## Project Structure

```
hedwig-bench/
├── package.json                    # Root: concurrently runs server + client
├── .gitignore
├── README.md
├── GUIDE.md                        # Step-by-step getting started guide
│
├── client/                         # React frontend (Vite + Tailwind + Recharts)
│   ├── package.json
│   ├── index.html                  # MongoDB leaf favicon
│   ├── .env.example                # VITE_MONGO_URI template
│   ├── vite.config.js              # Dev proxy: /api → :3001, /ws → ws://:3001
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── src/
│       ├── main.jsx                # React Router setup
│       ├── App.jsx                 # Nav layout (MongoDB green theme)
│       ├── index.css               # Tailwind directives + custom scrollbar
│       ├── pages/
│       │   ├── ConfigPage.jsx      # Config form, doc preview, spike SVG, cleanup
│       │   ├── LiveDashboard.jsx   # Real-time charts via WebSocket
│       │   ├── ResultsPage.jsx     # Summary cards (p50/p90/p99), charts, export
│       │   ├── HistoryPage.jsx     # Runs table, multi-run comparison, clear history
│       │   ├── SearchPage.jsx      # Atlas Search showcase (full-text, autocomplete)
│       │   └── QueryPage.jsx       # Query Demo (3 patterns, explain, index used)
│       └── lib/
│           ├── api.js              # REST client (fetch) + WebSocket factory
│           └── spike.js            # Client-side schedule generator (write + read, for previews)
│
├── server/                         # Express backend
│   ├── package.json
│   └── src/
│       ├── index.js                # Express + HTTP + WebSocket server, static files
│       ├── routes/
│       │   ├── runs.js             # Benchmark API + summary computation + cleanup
│       │   ├── search.js           # Atlas Search API (connect, index, query, autocomplete)
│       │   └── queries.js          # Query Demo API (run, explain, sample-ids)
│       ├── db/
│       │   └── database.js         # SQLite (better-sqlite3) CRUD layer
│       └── engine/
│           ├── document.js         # Document generator (pre-built padding, Math.random)
│           ├── indexes.js          # Extended index profile (4 indexes)
│           ├── rateLimiter.js      # Token-bucket (monotonic clock, dynamic rate)
│           ├── spike.js            # Schedule generator (write spikes + read isolation phase)
│           ├── writer.js           # Write worker (50 lanes, bulk/single, uncapped mode)
│           ├── reader.js           # Read worker (50 lanes, 3 query patterns)
│           ├── metrics.js          # Per-second + system metrics (per-doc latency)
│           └── manager.js          # Run lifecycle orchestrator
│
└── server/data/                    # Created at runtime
    └── hedwig-bench.db             # SQLite database (gitignored)
```

---

## Safety

> **Never point this tool at a production cluster.**

This tool generates heavy write load. Safeguards built in:

- **Confirmation dialog**: Start Benchmark requires explicit confirmation with target RPS displayed.
- **Drop collection guard**: Separate confirmation when dropping data.
- **URI masking**: MongoDB URI is masked in the UI and never logged in full.
- **Graceful shutdown**: Ctrl+C stops all active runs, finishes in-flight operations, flushes metrics, and saves partial results. 5-second force-exit timeout.

**Recommendations:**
- Use a dedicated benchmark cluster, separate from staging/production.
- Monitor Atlas metrics (CPU, IOPS, connections) alongside hedwig-bench during runs.
- Start with a Quick Smoke Test to validate connectivity before full-scale benchmarks.
