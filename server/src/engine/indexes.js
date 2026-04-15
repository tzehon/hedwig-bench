/**
 * Set up indexes on the collection based on the chosen profile.
 *
 * Index profiles are modelled after the Scylla access patterns:
 *   Query 1: WHERE user_id = ? AND msg_id = ?           (point read)
 *   Query 2: WHERE user_id = ? AND created_at > ? LIMIT (recent messages)
 *   Query 3: WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT (filtered inbox)
 *
 * @param {import('mongodb').Collection} collection - The MongoDB collection
 * @param {'minimal' | 'ttl' | 'extended'} profile - The index profile to apply
 */
export async function setupIndexes(collection, profile) {
  const indexSpecs = [];

  // ── Minimal (2 indexes) ────────────────────────────────────────────
  // Covers: point read by user_id + msg_id (mirrors Scylla secondary index)
  indexSpecs.push({
    key: { user_id: 1, msg_id: 1 },
    name: 'idx_user_msg',
  });
  // Covers: recent messages query, inbox sorted by recency
  indexSpecs.push({
    key: { user_id: 1, created_at: -1 },
    name: 'idx_user_created',
  });

  // ── TTL (adds 1 more) ─────────────────────────────────────────────
  if (profile === 'ttl' || profile === 'extended') {
    indexSpecs.push({
      key: { created_at: 1 },
      name: 'idx_created_ttl',
      expireAfterSeconds: 5184000, // 60 days
    });
  }

  // ── Extended (adds 2 more) ─────────────────────────────────────────
  if (profile === 'extended') {
    // Covers: filtered inbox by status, ordered by recency (avoids ALLOW FILTERING equivalent)
    indexSpecs.push({
      key: { user_id: 1, status: 1, created_at: -1 },
      name: 'idx_user_status_created',
    });
  }

  // Create all indexes. createIndexes is idempotent for matching specs.
  await collection.createIndexes(indexSpecs);

  return indexSpecs.length;
}

/**
 * Enable sharding on the database and shard the collection with { user_id: "hashed" }.
 * Both commands are idempotent — safe to call on an already-sharded collection.
 *
 * Requires the MongoDB user to have clusterAdmin or clusterManager role.
 * Must be connected to a sharded cluster (mongos), not a plain replica set.
 *
 * @param {import('mongodb').Db} db - The MongoDB database handle
 * @param {string} collectionName - The collection to shard
 */
export async function setupSharding(db, collectionName) {
  const admin = db.admin();
  const collection = db.collection(collectionName);

  // Enable sharding on the database (no-op on MongoDB 6.0+ but harmless)
  await admin.command({ enableSharding: db.databaseName });

  // Create the shard key index first — required if the collection is not empty.
  // shardCollection only auto-creates the index on empty collections.
  await collection.createIndex({ user_id: 'hashed' }, { name: 'idx_user_id_hashed' });

  // Shard the collection with a hashed shard key on user_id
  try {
    await admin.command({
      shardCollection: `${db.databaseName}.${collectionName}`,
      key: { user_id: 'hashed' },
    });
  } catch (err) {
    // Code 20 = AlreadyInitialized — collection is already sharded
    if (err.code === 20) {
      // Already sharded — continue
    } else {
      throw err;
    }
  }
}
