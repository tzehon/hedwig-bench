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
