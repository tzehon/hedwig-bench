# Hedwig Bench — Getting Started Guide

A step-by-step walkthrough for running the benchmark and Atlas Search demo.

---

## Prerequisites

1. **Node.js 18+** installed
2. **MongoDB Atlas cluster** with your IP whitelisted in Network Access
   - M0 (free tier) works for smoke tests
   - M10+ for real benchmarks and Atlas Search
   - M50+ for full 35k RPS load tests
3. Your Atlas connection string (e.g. `mongodb+srv://user:pass@cluster.mongodb.net`)

---

## 1. Install and Start

```bash
cd hedwig-bench
npm run install:all
npm run dev
```

Two servers start:
- **Frontend** at http://localhost:5173
- **Backend** at http://localhost:3001

Open the frontend in your browser.

---

## 2. Smoke Test (~ 2.5 minutes)

This verifies connectivity and gives you a quick feel for the tool.

1. Paste your Atlas URI in the **Connection** section
2. Click **Quick Smoke Test**
3. Confirm the dialog
4. You land on the **Live Dashboard** — watch the charts update in real time
5. After ~2.5 minutes the run completes and you're taken to **Results**

What to check:
- Did the green "Actual" line track the dashed "Target" line?
- What's the p99 write latency?
- Any errors in the bottom bar?
- Did it PASS or FAIL?

---

## 3. Full Benchmark (~ 20 minutes)

Go back to the home page (`/`). Your URI is still saved.

### Recommended settings for the Hedwig workload

| Setting | Value | Why |
|---------|-------|-----|
| Doc size | 7 KB | Matches Scylla row size (5–9 KB) |
| Index profile | TTL (3 indexes) | Includes 60-day TTL auto-cleanup |
| Write mode | Bulk | Simulates campaign blast inserts |
| Batch size | 500 | Good balance of throughput vs latency |
| Target write RPS | 35,000 | Hedwig peak write rate |
| Write concern | w:majority | Fixed — matches production durability |
| Target read RPS | 1,500 | Hedwig steady-state read rate |
| Spikes | 3 | Simulates multiple campaign blasts |
| Ramp | 120s | Gradual ramp to peak |
| Sustain | 180s | 3 minutes at peak per spike |
| Gap | 60s | 1 minute between spikes (reads continue) |

### First full run

1. Check **Drop collection before run** (start clean)
2. Click **Start Benchmark**, confirm
3. Watch the Live Dashboard for ~20 minutes
4. Review results when complete

### Second run (with existing data)

1. **Uncheck** Drop collection — data from the first run stays
2. Run again with the same or different settings
3. This is more realistic: reads now query against millions of existing documents

---

## 4. Compare Runs

After 2+ runs, go to **Run History** (`/history`).

1. Check the boxes next to 2–4 runs
2. Click **Compare Selected**
3. You get:
   - **Overlay charts** — throughput and latency lines from each run on the same axes
   - **Side-by-side table** — config and performance differences highlighted

### Useful comparisons

| Run A | Run B | What you learn |
|-------|-------|----------------|
| Bulk inserts | Single inserts | Throughput difference for batch vs one-at-a-time |
| 5 KB docs | 9 KB docs | Impact of document size on write throughput |
| TTL indexes (3) | Extended indexes (4) | Write overhead of the extra status filter index |
| Empty collection | 10M+ documents | How performance changes with data volume |

---

## 5. Atlas Search Demo

This tab showcases full-text search capabilities that ScyllaDB doesn't have. It's a demo, not a benchmark.

### Setup

1. Go to the **Atlas Search** tab
2. Enter the same Atlas URI, database, and collection name
3. Click **Connect**
4. Click **Create Search Index** — this builds asynchronously on Atlas (1–2 minutes)
5. Refresh until the status shows **Index Ready**

> Note: Atlas Search requires M10+ clusters. It won't work on the free tier (M0).

### What to demo

**Suggested searches** — click any card on the page:

| Query | What it shows |
|-------|---------------|
| "order shipped" | Full-text phrase matching across subject field |
| "security update" | Multi-word relevance search |
| "rewadr" (typo) | Fuzzy matching — still finds "reward" |
| "subscription expiring" | Cross-field relevance ranking |
| "welcome" | Simple single-word search |

**Autocomplete** — start typing in the search bar (3+ characters). Suggestions drop down in real time, powered by edge n-gram tokenization on the `subject` field.

**Filters** — combine text search with structured filters in a single query:
- Status: filter by `delivered`, `read`, or `unread`
- User ID: search within a specific user's inbox (e.g. `user_000042`)
- Date range: restrict results to a time window

**What to highlight to stakeholders:**
- "This is a single query — text search + filters + sorting by relevance, all in one."
- "ScyllaDB can't do this without adding Elasticsearch or Solr as a separate system."
- "Autocomplete, fuzzy matching, and highlighting are built into Atlas — no extra infra."

---

## 6. Cleanup

When you're done, clean up the benchmark data.

### Option A: In-app cleanup

1. Go to the home page (`/`)
2. Scroll down and expand the **Cleanup** section
3. Check or uncheck "Also clear local run history"
4. Click **Cleanup**, confirm
5. This drops the collection, removes the search index, and optionally clears local run history

### Option B: Delete the Atlas cluster

If you created a dedicated cluster for benchmarking, just terminate it in the Atlas UI — cleanest option.

### Option C: Manual cleanup

```bash
# Drop collection via mongosh
mongosh "your-atlas-uri" --eval '
  use hedwig_bench;
  db.inbox.drop();
'

# Delete local run history
rm server/data/hedwig-bench.db
```

---

## Running on EC2 for Full Load

Your laptop likely can't push 35k ops/sec with `w:majority` over the internet. For that, run from an EC2 instance in the same AWS region as your Atlas cluster.

```bash
# Spin up a c5.2xlarge in ap-southeast-1
# SSH in, then:

# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs    # Amazon Linux
# or: sudo apt-get install -y nodejs    # Ubuntu

# Set up the project
git clone <repo-url> hedwig-bench
cd hedwig-bench
npm run install:all
npm run build
npm start
```

Access at `http://<ec2-public-ip>:3001` (open port 3001 in the security group).

With <2ms latency to Atlas in the same region, you should be able to hit the full 35k RPS target.

---

## Quick Reference

| Action | How |
|--------|-----|
| Start the app | `npm run dev` |
| Run a smoke test | Home page → Quick Smoke Test |
| Run a full benchmark | Home page → adjust settings → Start Benchmark |
| Watch live progress | Auto-redirects to Live Dashboard |
| View results | Auto-redirects after run completes, or `/results/:id` |
| Compare runs | History page → check 2–4 runs → Compare Selected |
| Demo Atlas Search | Atlas Search tab → Connect → Create Index → search |
| Clean up | Home page → Cleanup section, or delete the Atlas cluster |
| Stop the app | `Ctrl+C` in the terminal |
