import { Router } from 'express';
import { MongoClient } from 'mongodb';

const router = Router();

// ────────────────────────────────────────────────────────────
// Connection state
// ────────────────────────────────────────────────────────────

let client = null;
let db = null;
let collection = null;
let currentUri = null;
let currentDbName = null;
let currentCollectionName = null;

/**
 * Mask a MongoDB URI so credentials are not leaked in error messages.
 */
function maskUri(uri) {
  if (!uri) return '<no uri>';
  try {
    const url = new URL(uri);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return uri.replace(/:([^@/]+)@/, ':***@');
  }
}

/**
 * Connect (or reconnect) to MongoDB.
 */
async function connect(uri, dbName, collectionName) {
  if (client && uri !== currentUri) {
    await client.close();
    client = null;
    db = null;
    collection = null;
  }

  if (client) {
    currentUri = uri;
    currentDbName = dbName;
    currentCollectionName = collectionName;
    db = client.db(dbName);
    collection = db.collection(collectionName);
    return;
  }

  currentUri = uri;
  currentDbName = dbName;
  currentCollectionName = collectionName;

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  collection = db.collection(collectionName);
}

/**
 * Disconnect from MongoDB gracefully.
 */
export async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    collection = null;
  }
}

/**
 * Ensure we have an active connection.
 */
function ensureConnected() {
  if (!collection) {
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Helpers: extract explain info
// ────────────────────────────────────────────────────────────

/**
 * Extract explain summary from a find-style explain result.
 */
function extractFindExplain(explainResult) {
  try {
    const execStats = explainResult?.executionStats || {};
    const winningPlan = explainResult?.queryPlanner?.winningPlan || {};

    // Walk the plan tree to find the index name
    let indexUsed = null;
    let stage = winningPlan.stage || null;

    function walkPlan(plan) {
      if (!plan) return;
      if (plan.indexName) {
        indexUsed = plan.indexName;
      }
      if (plan.inputStage) {
        if (!indexUsed && plan.inputStage.indexName) {
          indexUsed = plan.inputStage.indexName;
        }
        if (plan.inputStage.stage) {
          stage = plan.inputStage.stage;
        }
        walkPlan(plan.inputStage);
      }
      if (plan.inputStages) {
        for (const s of plan.inputStages) {
          walkPlan(s);
        }
      }
    }
    walkPlan(winningPlan);

    return {
      executionTimeMillis: execStats.executionTimeMillis ?? null,
      totalDocsExamined: execStats.totalDocsExamined ?? null,
      totalKeysExamined: execStats.totalKeysExamined ?? null,
      indexUsed,
      stage: stage || (winningPlan.stage ?? null),
    };
  } catch {
    return {
      executionTimeMillis: null,
      totalDocsExamined: null,
      totalKeysExamined: null,
      indexUsed: null,
      stage: null,
    };
  }
}

/**
 * Extract explain summary from an aggregate-style explain result.
 */
function extractAggregateExplain(explainResult) {
  try {
    // Aggregate explain can be nested differently
    // Try common paths
    const stages = explainResult?.stages || [];
    const execStats = explainResult?.executionStats || {};

    // For simple aggregations, the explain may have a queryPlanner at the top level
    if (explainResult?.queryPlanner) {
      return extractFindExplain(explainResult);
    }

    // Check stages[0].$cursor for aggregation with initial find
    const cursorStage = stages[0]?.$cursor;
    if (cursorStage) {
      return extractFindExplain(cursorStage);
    }

    // Fallback: try to extract from executionStats directly
    let indexUsed = null;
    let stage = null;

    if (execStats.executionStages) {
      stage = execStats.executionStages.stage;
      if (execStats.executionStages.inputStage) {
        indexUsed = execStats.executionStages.inputStage.indexName || null;
        stage = execStats.executionStages.inputStage.stage || stage;
      }
    }

    return {
      executionTimeMillis: execStats.executionTimeMillis ?? null,
      totalDocsExamined: execStats.totalDocsExamined ?? null,
      totalKeysExamined: execStats.totalKeysExamined ?? null,
      indexUsed,
      stage,
    };
  } catch {
    return {
      executionTimeMillis: null,
      totalDocsExamined: null,
      totalKeysExamined: null,
      indexUsed: null,
      stage: null,
    };
  }
}

// ────────────────────────────────────────────────────────────
// POST /api/queries/connect
// ────────────────────────────────────────────────────────────

router.post('/connect', async (req, res) => {
  try {
    const { mongoUri, dbName, collectionName } = req.body;
    if (!mongoUri || !dbName || !collectionName) {
      return res.status(400).json({ error: 'mongoUri, dbName, and collectionName are required' });
    }

    await connect(mongoUri, dbName, collectionName);
    res.json({ ok: true });
  } catch (err) {
    console.error('Queries connect error:', err);
    res.status(500).json({ error: `Failed to connect: ${err.message}`.replace(currentUri, maskUri(currentUri)) });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/queries/sample-ids
// ────────────────────────────────────────────────────────────

router.get('/sample-ids', async (_req, res) => {
  try {
    if (!ensureConnected()) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const samples = await collection.aggregate([
      { $sample: { size: 5 } },
      { $project: { user_id: 1, msg_id: 1, campaign_id: 1 } },
    ]).toArray();

    const users = [...new Set(samples.map((s) => s.user_id).filter(Boolean))];
    const msgIds = [...new Set(samples.map((s) => s.msg_id).filter(Boolean))];
    const campaignIds = [...new Set(samples.map((s) => s.campaign_id).filter(Boolean))];

    res.json({ users, msgIds, campaignIds });
  } catch (err) {
    console.error('Sample IDs error:', err);
    const message = err.message.replace(currentUri || '', maskUri(currentUri));
    res.status(500).json({ error: `Failed to fetch sample IDs: ${message}` });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/queries/run
// ────────────────────────────────────────────────────────────

router.post('/run', async (req, res) => {
  try {
    if (!ensureConnected()) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const { type, params } = req.body;

    if (!type || !params) {
      return res.status(400).json({ error: 'type and params are required' });
    }

    let results = [];
    let count = 0;
    let explainResult = null;
    let explainSummary = null;
    let queryDescription = '';

    const startTime = performance.now();

    switch (type) {
      // ── Point Read ──────────────────────────────────────────
      case 'point_read': {
        const { userId, msgId } = params;
        if (!userId || !msgId) {
          return res.status(400).json({ error: 'userId and msgId are required for point_read' });
        }

        const filter = { user_id: userId, msg_id: msgId };
        queryDescription = `db.${currentCollectionName}.findOne(${JSON.stringify(filter)})`;

        const doc = await collection.findOne(filter);
        results = doc ? [doc] : [];
        count = results.length;

        // Explain
        try {
          explainResult = await collection.find(filter).limit(1).explain('executionStats');
          explainSummary = extractFindExplain(explainResult);
        } catch {
          explainSummary = null;
        }
        break;
      }

      // ── Recent Messages ─────────────────────────────────────
      case 'recent_messages': {
        const { userId, limit: lim } = params;
        if (!userId) {
          return res.status(400).json({ error: 'userId is required for recent_messages' });
        }

        const effectiveLimit = lim || 20;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const filter = { user_id: userId, created_at: { $gt: oneDayAgo } };
        const sort = { created_at: -1 };

        queryDescription = `db.${currentCollectionName}.find(${JSON.stringify(filter)}).sort(${JSON.stringify(sort)}).limit(${effectiveLimit})`;

        results = await collection.find(filter).sort(sort).limit(effectiveLimit).toArray();
        count = results.length;

        // Explain
        try {
          explainResult = await collection.find(filter).sort(sort).limit(effectiveLimit).explain('executionStats');
          explainSummary = extractFindExplain(explainResult);
        } catch {
          explainSummary = null;
        }
        break;
      }

      // ── Filtered Inbox ──────────────────────────────────────
      case 'filtered_inbox': {
        const { userId, status, limit: lim } = params;
        if (!userId || !status) {
          return res.status(400).json({ error: 'userId and status are required for filtered_inbox' });
        }

        const effectiveLimit = lim || 20;
        const filter = { user_id: userId, status };
        const sort = { created_at: -1 };

        queryDescription = `db.${currentCollectionName}.find(${JSON.stringify(filter)}).sort(${JSON.stringify(sort)}).limit(${effectiveLimit})`;

        results = await collection.find(filter).sort(sort).limit(effectiveLimit).toArray();
        count = results.length;

        // Explain
        try {
          explainResult = await collection.find(filter).sort(sort).limit(effectiveLimit).explain('executionStats');
          explainSummary = extractFindExplain(explainResult);
        } catch {
          explainSummary = null;
        }
        break;
      }

      // ── Count by Status ─────────────────────────────────────
      case 'count_by_status': {
        const { userId } = params;
        if (!userId) {
          return res.status(400).json({ error: 'userId is required for count_by_status' });
        }

        const pipeline = [
          { $match: { user_id: userId } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ];

        queryDescription = `db.${currentCollectionName}.aggregate(${JSON.stringify(pipeline)})`;

        results = await collection.aggregate(pipeline).toArray();
        count = results.length;

        // Explain
        try {
          explainResult = await collection.aggregate(pipeline).explain('executionStats');
          explainSummary = extractAggregateExplain(explainResult);
        } catch {
          explainSummary = null;
        }
        break;
      }

      // ── Campaign Stats ──────────────────────────────────────
      case 'campaign_stats': {
        const { campaignId } = params;
        if (!campaignId) {
          return res.status(400).json({ error: 'campaignId is required for campaign_stats' });
        }

        const pipeline = [
          { $match: { campaign_id: campaignId } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ];

        queryDescription = `db.${currentCollectionName}.aggregate(${JSON.stringify(pipeline)})`;

        results = await collection.aggregate(pipeline).toArray();
        count = results.length;

        // Explain
        try {
          explainResult = await collection.aggregate(pipeline).explain('executionStats');
          explainSummary = extractAggregateExplain(explainResult);
        } catch {
          explainSummary = null;
        }
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown query type: ${type}` });
    }

    const latencyMs = Math.round((performance.now() - startTime) * 100) / 100;

    res.json({
      results,
      count,
      latencyMs,
      queryDescription,
      explain: explainSummary || {
        executionTimeMillis: null,
        totalDocsExamined: null,
        totalKeysExamined: null,
        indexUsed: null,
        stage: null,
      },
      rawExplain: explainResult || null,
    });
  } catch (err) {
    console.error('Query run error:', err);
    const message = err.message.replace(currentUri || '', maskUri(currentUri));
    res.status(500).json({ error: `Query failed: ${message}` });
  }
});

export default router;
