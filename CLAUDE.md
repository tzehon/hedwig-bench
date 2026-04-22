# CLAUDE.md

## Project Overview

Hedwig Bench is a MongoDB Atlas inbox workload benchmark tool. It simulates the bursty campaign-blast write pattern of the Hedwig inbox messaging service with concurrent/isolation reads, mutations, and live dashboards.

## Quick Start

```bash
npm run install:all
npm run dev          # dev mode (frontend + backend)
npm run build && npm start  # production mode (recommended for benchmarking)
```

- Frontend: http://localhost:5173 (dev) or http://localhost:3001 (production)
- Backend API: http://localhost:3001

## Architecture

- **Frontend**: React 18 (Vite), Tailwind CSS, Recharts
- **Backend**: Express.js, WebSocket (`ws`), SQLite (`better-sqlite3`)
- **Engine**: Worker threads for reads (readWorkerPool/readWorkerThread), async lanes for writes and mutations
- **Data Loader**: Worker threads for parallel bulk insertion (insertWorkerPool/insertWorkerThread)

## Key Files

### Engine (`server/src/engine/`)
- `manager.js` — Run lifecycle orchestrator. Steps: connect → shard (if sharded) → indexes → schedule → start workers → tick loop → cleanup
- `writer.js` — Write worker with 50 async lanes, bulk insertMany with ordered:false
- `reader.js` — Read worker with phase-aware queries (point reads during concurrent, list queries during isolation). Runs inside worker threads.
- `readWorkerPool.js` — Spawns N worker threads for reads, aggregates metrics via postMessage
- `readWorkerThread.js` — Worker thread entry point for reads, creates own MongoClient
- `mutationWorker.js` — Update status, delete, update content operations (50 lanes)
- `userSelector.js` — Zipf-distributed user selection with pre-computed CDF lookup table
- `spike.js` — Schedule generator with interleaved write spikes and isolation blocks
- `rateLimiter.js` — Token-bucket rate limiter with 10ms refill, dynamic rate updates
- `metrics.js` — Per-second metrics collection (writes, reads, mutations, system)
- `document.js` — Document generator with pre-built padding block for exact KB sizing
- `indexes.js` — Index setup (4 indexes) + sharding setup (shard key index + shardCollection)
- `insertWorkerPool.js` / `insertWorkerThread.js` — Parallel bulk insert for Data Loader

### Routes (`server/src/routes/`)
- `runs.js` — Benchmark API (start, stop, results, summary computation)
- `loader.js` — Data Loader API (start, stop, status, create-indexes, preview-doc)
- `search.js` — Atlas Search API
- `queries.js` — Query Demo API

### Client (`client/src/`)
- `pages/ConfigPage.jsx` — Benchmark configuration with spike preview
- `pages/LiveDashboard.jsx` — Real-time charts via WebSocket
- `pages/ResultsPage.jsx` — Summary scorecards with target vs achieved table
- `pages/DataLoaderPage.jsx` — Bulk data loading with progress
- `lib/spike.js` — Client-side schedule generator (mirrors server)
- `lib/api.js` — REST client + WebSocket factory

## Workload Model

### Writes
- 35,000 ops/sec peak (bulk insertMany, batch 500, w:majority)
- Campaign blast pattern: ramp → sustain → cooldown

### Reads (interleaved with writes)
- **Concurrent** (60% of run): 8,000 QPS point reads (findOne, 1 doc) during write spikes
- **Isolation** (40% of run): 2,000 QPS list queries (10-50 docs, avg 30) during read-only blocks
- Zipf skew default 1.0 (top 20% users get 80% of reads)

### Mutations (during concurrent phase)
- Update status: 80/sec (5%)
- Delete: 600/sec (41%)
- Update content: 800/sec (54%)
- Total: ~1,480/sec

## Indexes

4 indexes (extended profile) + optional hashed shard key:
- `{ user_id: 1, msg_id: 1 }` — point reads + mutations
- `{ user_id: 1, created_at: -1 }` — recent messages
- `{ created_at: 1 }` with 60-day TTL — auto-deletion
- `{ user_id: 1, status: 1, created_at: -1 }` — filtered inbox
- `{ user_id: "hashed" }` — shard key (sharded mode only)

## Config Defaults

| Setting | Default |
|---------|---------|
| Doc size | 3 KB (configurable, production is 5 KB) |
| Write RPS | 35,000 |
| Concurrent read RPS | 8,000 |
| Isolation read RPS | 2,000 |
| Isolation % | 40% |
| Read lanes | 150 |
| Read worker threads | 4 |
| Read skew (Zipf) | 1.0 |
| Write lanes | 50 |
| Mutation RPS | 1,480 |
| Spikes | 1 |
| Ramp / Sustain / Gap | 60s / 120s / 30s |
| Batch size | 500 |
| Write concern | w:majority |
| Pool size | 200 (auto-sized to lanes + 20) |
| User pool size | 100,000 |

## Deployment Modes

- **Replica Set**: default, no sharding
- **Sharded**: creates `{ user_id: "hashed" }` shard key + index before benchmark/loading

## Testing Notes

- Run from EC2 c5.2xlarge in same region as Atlas cluster (ap-southeast-1)
- Use `npm run build && npm start` for benchmarking (not dev mode)
- Data Loader creates indexes before insertion (incremental build)
- For sharded clusters: load data via Data Loader with Sharded mode, indexes build during insertion
- Check index build progress: `db.adminCommand({ currentOp: true, "command.createIndexes": "inbox" })`
- Check shard distribution: `db.inbox.getShardDistribution()`

## Benchmark Results Summary (1B docs)

| Config | Write Avg Sustain | Concurrent Reads | Cost/hr |
|--------|-------------------|-----------------|---------|
| M60 replica set | 3.4k | 9.4k | ~$5 |
| M80 + 20k IOPS | ~15k | 8k | ~$10 |
| M200 + 64k IOPS (Zipf) | 28.1k | 9.3k | ~$20 |
| 2x M80 + 25k IOPS | 17.3k | 18.2k | ~$20 |
| 3x M80 default IOPS | 30.2k | 9.6k | ~$24 |
| 3x M80 + 15k IOPS | 31.8k | 18.3k | ~$27 |
| **4x M80 default IOPS** | **38.0k** | **9.8k** | **~$33** |
| 4x M60 default IOPS | 33.2k | 9.7k | ~$24 |

## Common Patterns

- Schedule config fields must be passed through manager.js → generateSchedule (past bug: missing fields caused fallback to defaults)
- MongoDB driver `findOne` properly closes cursors; `find().limit(1).next()` may leak connections
- Rate limiter bucket size = 1x rate (prevents overshoot on fast clusters)
- Writer sleeps during rate=0 phases instead of timeout loops
- Mutation worker finds cached user before acquiring rate limiter token
- All read/write/mutation operations include user_id in filter (shard key compatible)
