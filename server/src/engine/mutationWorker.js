/**
 * Mutation worker that performs update and delete operations on existing documents.
 * Runs during the concurrent phase alongside writes and reads.
 *
 * Operations (weighted by avg rate):
 *   a. Update status:  updateOne({ user_id, msg_id }, { $set: { status } })   — 5%
 *   b. Delete:         deleteOne({ user_id, msg_id })                         — 41%
 *   c. Update content: updateOne({ user_id, msg_id }, { $set: { body } })     — 54%
 *
 * All operations use the { user_id: 1, msg_id: 1 } index (no new indexes needed).
 */

import { UserSelector } from './userSelector.js';

const DEFAULT_CONCURRENCY = 10;
const STATUSES = ['delivered', 'read', 'unread'];

const MUTATION_OPS = [
  { name: 'update_status', weight: 80 },   // avg 80/sec
  { name: 'delete', weight: 600 },          // avg 600/sec
  { name: 'update_content', weight: 800 },  // avg 800/sec
];

const TOTAL_WEIGHT = MUTATION_OPS.reduce((sum, p) => sum + p.weight, 0);

function pickMutationOp() {
  const roll = Math.floor(Math.random() * TOTAL_WEIGHT);
  let cumulative = 0;
  for (const op of MUTATION_OPS) {
    cumulative += op.weight;
    if (roll < cumulative) return op.name;
  }
  return MUTATION_OPS[MUTATION_OPS.length - 1].name;
}

// Simple body content for updates (varies in length for realism)
const CONTENT_SNIPPETS = [
  'Message has been updated.',
  'Your order status has changed. Please check the details.',
  'We have updated your subscription preferences based on your recent activity.',
  'This is an automated notification. Your account settings have been modified successfully. Please review the changes at your earliest convenience.',
  'Important: Your recent request has been processed. If you did not make this request, please contact our support team immediately for assistance.',
];

export class MutationWorker {
  /**
   * @param {import('mongodb').Collection} collection
   * @param {import('./rateLimiter.js').RateLimiter} rateLimiter
   * @param {object} config
   * @param {number} config.userPoolSize
   * @param {number} [config.concurrency]
   */
  constructor(collection, rateLimiter, config) {
    this._collection = collection;
    this._rateLimiter = rateLimiter;
    this._config = config;
    /** @type {Map<string, string>} */
    this._knownMsgIds = new Map();
    this._userSelector = new UserSelector(config.userPoolSize, config.zipfExponent ?? 0);
    this._stopped = false;
    this._running = false;

    /** @type {Promise<void>[]} */
    this._lanes = [];

    // Metrics accumulators (drained by MetricsCollector)
    this.opsCount = 0;
    this.errorsCount = 0;
    /** @type {number[]} */
    this.latencies = [];

    this._concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /**
   * Pre-seed the msg_id cache so mutations target real documents.
   */
  async seedCache() {
    try {
      const docs = await this._collection
        .aggregate([{ $sample: { size: 50000 } }, { $project: { user_id: 1, msg_id: 1 } }])
        .toArray();
      for (const doc of docs) {
        if (doc.user_id && doc.msg_id) {
          this._knownMsgIds.set(doc.user_id, doc.msg_id);
        }
      }
    } catch {
      // Collection may be empty — that's fine
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._stopped = false;

    for (let i = 0; i < this._concurrency; i++) {
      this._lanes.push(this._runLane());
    }
  }

  async _runLane() {
    while (!this._stopped) {
      try {
        // Sleep if rate is 0 (isolation phase — mutations don't run)
        if (this._rateLimiter.tokensPerSecond === 0) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        // Find a user with a cached msg_id before acquiring a token
        let userId;
        let msgId;
        for (let attempt = 0; attempt < 10; attempt++) {
          userId = this._userSelector.pickUserId();
          msgId = this._knownMsgIds.get(userId);
          if (msgId) break;
        }
        if (!msgId) {
          // No cached users found — refill cache from a quick query
          try {
            const doc = await this._collection.findOne(
              { user_id: userId },
              { projection: { user_id: 1, msg_id: 1 } },
            );
            if (doc?.msg_id) {
              this._knownMsgIds.set(doc.user_id, doc.msg_id);
              msgId = doc.msg_id;
              userId = doc.user_id;
            }
          } catch {}
          if (!msgId) continue;
        }

        await this._rateLimiter.acquire(1);

        const op = pickMutationOp();
        const start = performance.now();

        switch (op) {
          case 'update_status': {
            const newStatus = STATUSES[Math.floor(Math.random() * STATUSES.length)];
            await this._collection.updateOne(
              { user_id: userId, msg_id: msgId },
              { $set: { status: newStatus } },
            );
            break;
          }
          case 'delete': {
            await this._collection.deleteOne({ user_id: userId, msg_id: msgId });
            // Replace cached msg_id with another doc for this user (if any)
            try {
              const replacement = await this._collection.findOne(
                { user_id: userId },
                { projection: { msg_id: 1 } },
              );
              if (replacement?.msg_id) {
                this._knownMsgIds.set(userId, replacement.msg_id);
              } else {
                this._knownMsgIds.delete(userId);
              }
            } catch {
              this._knownMsgIds.delete(userId);
            }
            break;
          }
          case 'update_content': {
            const content = CONTENT_SNIPPETS[Math.floor(Math.random() * CONTENT_SNIPPETS.length)];
            await this._collection.updateOne(
              { user_id: userId, msg_id: msgId },
              { $set: { body: content } },
            );
            break;
          }
        }

        const elapsed = performance.now() - start;
        this.opsCount += 1;
        this.latencies.push(elapsed);
      } catch (err) {
        if (this._stopped) break;
        if (err.message === 'RateLimiter stopped') break;
        if (err.message === 'RateLimiter acquire timeout') continue;
        this.errorsCount++;
      }
    }
  }

  drainMetrics() {
    const ops = this.opsCount;
    const errors = this.errorsCount;
    const latencies = this.latencies;
    this.opsCount = 0;
    this.errorsCount = 0;
    this.latencies = [];
    return { ops, errors, latencies };
  }

  async stop() {
    this._stopped = true;
    await Promise.allSettled(this._lanes);
    this._lanes = [];
    this._running = false;
  }
}
