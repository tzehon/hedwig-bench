# Hedwig Bench — Getting Started Guide

A step-by-step walkthrough for running the benchmark, Query Demo, and Atlas Search.

---

## Prerequisites

1. **Node.js 18+** installed
2. **MongoDB Atlas cluster** with your IP whitelisted in Network Access
   - M10+ for benchmarks and Atlas Search
   - M80 NVMe recommended for full 35k RPS load tests
3. Your Atlas connection string (e.g. `mongodb+srv://user:pass@cluster.mongodb.net`)

---

## 1. Install and Start

```bash
cd hedwig-bench
npm run install:all

# (Optional) Pre-fill your MongoDB URI
cp client/.env.example client/.env
# Edit client/.env and set VITE_MONGO_URI=mongodb+srv://...

npm run dev
```

Two servers start:
- **Frontend** at http://localhost:5173
- **Backend** at http://localhost:3001

Open the frontend in your browser.

---

## 2. Smoke Test (~1.5 minutes)

This verifies connectivity and gives you a quick feel for the tool.

1. Paste your Atlas URI in the **Connection** section (or it's pre-filled from `.env`)
2. Click **Quick Smoke Test**
3. Confirm the dialog
4. You land on the **Live Dashboard** — watch the charts update in real time
5. After ~100 seconds the run completes and you're taken to **Results**

What to check:
- Did the green "Actual" lines track the dashed "Target" lines for both writes and reads?
- What's the p99 write latency (per document)?
- Any errors in the bottom bar?

---

## 3. Full Benchmark (~13.5 minutes)

Go back to the home page (`/`). Your URI is still saved.

### Recommended settings for the Hedwig workload

| Setting | Value | Why |
|---------|-------|-----|
| Doc size | 3 KB | Default |
| Write mode | Bulk | Simulates campaign blast inserts |
| Batch size | 500 | Good balance of throughput vs latency |
| Target write RPS | 35,000 | Hedwig peak write rate |
| Write concern | w:majority | Fixed — matches production durability |
| Read mode | Variable | Variable for realistic patterns; Constant for a simple baseline |
| Min read RPS | 3,500 | Floor during gaps and isolation ramp |
| Avg read RPS | 5,000 | Target average read rate across the run |
| Max read RPS | 10,000 | Peak during the read isolation spike |
| Read isolation | 40% | 40% of run is read-only, 60% concurrent with writes |
| Read lanes | 50 | Increase if reads can't keep up at high RPS |
| Spikes | 2 | Simulates multiple campaign blasts |
| Ramp | 60s | Gradual ramp to peak |
| Sustain | 120s | 2 minutes at peak per spike |
| Gap | 30s | Between spikes (reads continue at min RPS) |
| Uncapped mode | Off | Rate-limited to test at target RPS |

### First full run

1. Select **Drop collection** under "Before run" (start clean)
2. Click **Start Benchmark**, confirm
3. Watch the Live Dashboard for ~13.5 minutes (includes read-only isolation phase)
4. Review results when complete

### Second run (with existing data)

1. Select **Keep existing data** — data from the first run stays
2. Run again with the same or different settings
3. This is more realistic: reads now query against millions of existing documents

### Comparing constant vs variable reads

To see the impact of read isolation vs concurrent-only reads:
1. Run once in **Variable** mode (default: 40% isolation, min 3.5k / avg 5k / max 10k RPS)
2. Run again in **Constant** mode at the same average (5,000 RPS)
3. Go to History → compare the two runs to see latency differences

### Finding max throughput

1. Check **Uncapped mode** in Write Configuration
2. Set 1 spike, 10s ramp, 30s sustain
3. Start — this removes the write rate limiter and shows the cluster's actual ceiling

---

## 4. Compare Runs

After 2+ runs, go to **Run History** (`/history`).

1. Check the boxes next to 2–4 runs
2. Click **Compare Selected**
3. You get:
   - **Overlay charts** — throughput and latency lines from each run on the same axes
   - **Side-by-side table** — config and performance differences highlighted

Use **Clear History** to delete all runs.

---

## 5. Query Demo

The **Query Demo** tab (`/queries`) lets you run the 3 Scylla-equivalent query patterns interactively and see results, execution stats, and which index was used.

### Setup

1. Go to the **Query Demo** tab
2. Enter the same Atlas URI, database, and collection name
3. Click **Connect**
4. Sample IDs are auto-fetched from the collection

> Note: Run a benchmark first so there's data in the collection to query.

### Query patterns

| Query | What it does | Scylla equivalent |
|-------|-------------|-------------------|
| **Point Read** | Fetch a single message by user + msg_id | `WHERE pk = ? AND msg_id = ?` |
| **Recent Messages** | Fetch user's recent inbox (last 24h) | `WHERE pk = ? AND created_at > ? LIMIT ?` |
| **Filtered Inbox** | Fetch user's messages by status | `WHERE pk = ? AND status = ? ORDER BY created_at DESC LIMIT ? ALLOW FILTERING` |

For each query, the results show:
- The executed MongoDB query
- Returned documents
- **Server-side execution time** (from explain)
- **Index used** (green) or "Collection Scan" (red)
- Documents and keys examined
- Scylla CQL comparison

---

## 6. Atlas Search Demo

The **Atlas Search** tab (`/search`) showcases full-text search, autocomplete, and faceted filtering — capabilities that ScyllaDB doesn't have.

### Setup

1. Go to the **Atlas Search** tab
2. Enter the same Atlas URI, database, and collection name
3. Click **Connect**
4. Click **Create Search Index** — builds asynchronously (1–2 minutes)
5. Refresh until the status shows **Index Ready**

> Note: Atlas Search requires M10+ clusters. Not available on free tier (M0).

### What to demo

| Feature | How to show it |
|---------|---------------|
| Full-text search | Click "order shipped" or "security update" suggested cards |
| Fuzzy matching | Click "rewadr" (typo) — still finds "reward" |
| Autocomplete | Type 3+ characters in the search bar, watch dropdown |
| Faceted filtering | Combine text search with status/user/date filters |
| Relevance scoring | Results ranked by score, highlighted terms |

---

## 7. Cleanup

### Option A: In-app cleanup

1. Go to the home page (`/`)
2. Scroll down and expand the **Cleanup** section
3. Check or uncheck "Also clear local run history"
4. Click **Cleanup**, confirm

### Option B: Delete the Atlas cluster

If you created a dedicated cluster for benchmarking, just terminate it in the Atlas UI.

---

## Running on EC2 for Full Load

For 35k+ RPS tests, run from an EC2 instance in the same AWS region as your Atlas cluster.

```bash
# On a c5.2xlarge in ap-southeast-1
sudo yum install -y nodejs git    # or apt-get on Ubuntu
git clone <repo-url> hedwig-bench && cd hedwig-bench
npm run install:all

# Set your MongoDB URI
echo 'VITE_MONGO_URI=mongodb+srv://...' > client/.env

npm run build && npm start
```

Access at `http://<ec2-public-ip>:3001` (open port 3001 in security group).

---

## Quick Reference

| Action | How |
|--------|-----|
| Start the app | `npm run dev` |
| Pre-fill URI | Set `VITE_MONGO_URI` in `client/.env` |
| Run a smoke test | Home page → Quick Smoke Test |
| Run a full benchmark | Home page → adjust settings → Start Benchmark |
| Find max throughput | Check Uncapped mode → Start |
| Watch live progress | Auto-redirects to Live Dashboard |
| View results | Auto-redirects after run completes |
| Compare runs | History page → check 2–4 runs → Compare Selected |
| Demo queries | Query Demo tab → Connect → run queries |
| Demo Atlas Search | Atlas Search tab → Connect → Create Index → search |
| Clean up | Home page → Cleanup section |
| Stop the app | `Ctrl+C` in the terminal |
