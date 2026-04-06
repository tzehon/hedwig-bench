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
    // If the URI doesn't parse as a URL, do a simple regex mask
    return uri.replace(/:([^@/]+)@/, ':***@');
  }
}

/**
 * Set connection info programmatically (called from other modules).
 */
export function setConnectionInfo(uri, dbName, collectionName) {
  currentUri = uri;
  currentDbName = dbName;
  currentCollectionName = collectionName;
}

/**
 * Connect (or reconnect) to MongoDB using the stored connection info.
 */
async function connect(uri, dbName, collectionName) {
  // If already connected to a different URI, close the old connection first
  if (client && uri !== currentUri) {
    await client.close();
    client = null;
    db = null;
    collection = null;
  }

  if (client) {
    // Already connected to the same URI, just update db/collection references
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
 * Ensure we have an active connection, lazily connecting if connection info is set.
 * Returns true if connected, false otherwise.
 */
async function ensureConnected() {
  if (collection) return true;
  if (currentUri && currentDbName && currentCollectionName) {
    await connect(currentUri, currentDbName, currentCollectionName);
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────
// POST /api/search/connect
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
    console.error('Search connect error:', err);
    res.status(500).json({ error: `Failed to connect: ${err.message}`.replace(currentUri, maskUri(currentUri)) });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/search/index
// ────────────────────────────────────────────────────────────

router.get('/index', async (_req, res) => {
  try {
    if (!(await ensureConnected())) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const indexes = await collection.listSearchIndexes().toArray();
    const exists = indexes.some((idx) => idx.name === 'default');

    res.json({ exists, indexes });
  } catch (err) {
    console.error('Search index check error:', err);
    const message = err.message.replace(currentUri || '', maskUri(currentUri));
    res.status(500).json({ error: `Failed to check search indexes: ${message}` });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/search/index
// ────────────────────────────────────────────────────────────

router.post('/index', async (_req, res) => {
  try {
    if (!(await ensureConnected())) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const indexDef = {
      name: 'default',
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            subject: [
              { type: 'string', analyzer: 'lucene.standard' },
              {
                type: 'autocomplete',
                analyzer: 'lucene.standard',
                tokenization: 'edgeGram',
                minGrams: 3,
                maxGrams: 15,
              },
            ],
            body: { type: 'string', analyzer: 'lucene.standard' },
            campaign_id: { type: 'string', analyzer: 'lucene.keyword' },
            status: { type: 'string', analyzer: 'lucene.keyword' },
            user_id: { type: 'string', analyzer: 'lucene.keyword' },
            created_at: { type: 'date' },
          },
        },
      },
    };

    await collection.createSearchIndex(indexDef);
    res.json({ ok: true, name: 'default' });
  } catch (err) {
    // Handle "index already exists" gracefully
    if (err.codeName === 'IndexAlreadyExists' || err.message?.includes('already exists')) {
      return res.json({ ok: true, name: 'default', message: 'Index already exists' });
    }

    console.error('Search index creation error:', err);
    const message = err.message.replace(currentUri || '', maskUri(currentUri));
    res.status(500).json({ error: `Failed to create search index: ${message}` });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/search/query
// ────────────────────────────────────────────────────────────

router.post('/query', async (req, res) => {
  try {
    if (!(await ensureConnected())) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const { query, filters = {}, page = 1, pageSize = 10 } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query is required and must be a string' });
    }

    const skip = (page - 1) * pageSize;

    // Build the compound query
    const compound = {
      must: [
        {
          text: {
            query,
            path: ['subject', 'body'],
            fuzzy: { maxEdits: 1 },
          },
        },
      ],
      filter: [],
    };

    // Add optional filters
    if (filters.status) {
      compound.filter.push({
        text: {
          query: filters.status,
          path: 'status',
        },
      });
    }

    if (filters.userId) {
      compound.filter.push({
        text: {
          query: filters.userId,
          path: 'user_id',
        },
      });
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateRange = {
        range: {
          path: 'created_at',
        },
      };
      if (filters.dateFrom) {
        dateRange.range.gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        dateRange.range.lte = new Date(filters.dateTo);
      }
      compound.filter.push(dateRange);
    }

    // Main search pipeline
    const searchPipeline = [
      {
        $search: {
          index: 'default',
          compound,
          highlight: {
            path: ['subject', 'body'],
          },
        },
      },
      {
        $project: {
          body: 0,
          score: { $meta: 'searchScore' },
          highlights: { $meta: 'searchHighlights' },
        },
      },
      { $skip: skip },
      { $limit: pageSize },
    ];

    // Count pipeline using $searchMeta
    const countPipeline = [
      {
        $searchMeta: {
          index: 'default',
          count: { type: 'total' },
          compound,
        },
      },
    ];

    const startTime = performance.now();

    // Run both pipelines in parallel
    const [results, countResult] = await Promise.all([
      collection.aggregate(searchPipeline).toArray(),
      collection.aggregate(countPipeline).toArray(),
    ]);

    const latencyMs = Math.round((performance.now() - startTime) * 100) / 100;
    const total = countResult[0]?.count?.total ?? 0;

    res.json({
      results,
      total,
      page,
      pageSize,
      latencyMs,
    });
  } catch (err) {
    console.error('Search query error:', err);

    // Handle "index not found" errors with a helpful message
    if (err.codeName === 'IndexNotFound' || err.message?.includes('index not found') || err.message?.includes('no such index')) {
      return res.status(400).json({
        error: 'Search index "default" not found. Create it first via POST /api/search/index.',
      });
    }

    const message = err.message.replace(currentUri || '', maskUri(currentUri));
    res.status(500).json({ error: `Search query failed: ${message}` });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/search/autocomplete
// ────────────────────────────────────────────────────────────

router.post('/autocomplete', async (req, res) => {
  try {
    if (!(await ensureConnected())) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const { prefix } = req.body;

    if (!prefix || typeof prefix !== 'string') {
      return res.status(400).json({ error: 'prefix is required and must be a string' });
    }

    const pipeline = [
      {
        $search: {
          index: 'default',
          autocomplete: {
            query: prefix,
            path: 'subject',
          },
        },
      },
      { $limit: 50 },
      {
        $project: {
          subject: 1,
          score: { $meta: 'searchScore' },
        },
      },
    ];

    const raw = await collection.aggregate(pipeline).toArray();

    // Deduplicate by subject client-side
    const seen = new Set();
    const suggestions = [];
    for (const doc of raw) {
      if (!seen.has(doc.subject)) {
        seen.add(doc.subject);
        suggestions.push(doc);
        if (suggestions.length >= 5) break;
      }
    }

    res.json({ suggestions });
  } catch (err) {
    console.error('Autocomplete error:', err);

    if (err.codeName === 'IndexNotFound' || err.message?.includes('index not found') || err.message?.includes('no such index')) {
      return res.status(400).json({
        error: 'Search index "default" not found. Create it first via POST /api/search/index.',
      });
    }

    const message = err.message.replace(currentUri || '', maskUri(currentUri));
    res.status(500).json({ error: `Autocomplete failed: ${message}` });
  }
});

export default router;
