/**
 * User selection strategies: uniform random vs Zipf-skewed.
 *
 * Zipf distribution: a small percentage of "hot" users receive the majority
 * of operations, simulating realistic inbox access patterns where active users
 * check their inbox frequently.
 *
 * The Zipf exponent (s) controls how skewed the distribution is:
 *   s = 0.0  → uniform (all users equally likely)
 *   s = 0.5  → mild skew
 *   s = 1.0  → standard Zipf (80/20-ish)
 *   s = 1.5  → heavy skew (few users dominate)
 */

/**
 * Pre-compute a Zipf CDF lookup table for fast sampling.
 * Uses the rejection method would be too slow in hot loops.
 *
 * @param {number} n - Number of items (userPoolSize)
 * @param {number} s - Zipf exponent (0 = uniform, 1 = standard Zipf)
 * @returns {Float64Array} CDF table where cdf[i] = P(rank <= i)
 */
function buildZipfCDF(n, s) {
  // Limit table size for memory — for pools > 100k, sample from a smaller
  // rank space and map back to the full pool
  const tableSize = Math.min(n, 100000);
  const weights = new Float64Array(tableSize);
  let total = 0;

  for (let i = 0; i < tableSize; i++) {
    const w = 1.0 / Math.pow(i + 1, s);
    weights[i] = w;
    total += w;
  }

  // Normalize to CDF
  const cdf = new Float64Array(tableSize);
  let cumulative = 0;
  for (let i = 0; i < tableSize; i++) {
    cumulative += weights[i] / total;
    cdf[i] = cumulative;
  }
  cdf[tableSize - 1] = 1.0; // ensure last entry is exactly 1

  return cdf;
}

/**
 * Sample a rank (0-based) from a pre-computed Zipf CDF using binary search.
 */
function sampleZipfRank(cdf) {
  const u = Math.random();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < u) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export class UserSelector {
  /**
   * @param {number} userPoolSize - Total number of unique users
   * @param {number} [zipfExponent=0] - Zipf skew exponent (0 = uniform)
   */
  constructor(userPoolSize, zipfExponent = 0) {
    this._userPoolSize = userPoolSize;
    this._zipfExponent = zipfExponent;
    this._cdf = null;
    this._tableSize = 0;

    if (zipfExponent > 0) {
      this._tableSize = Math.min(userPoolSize, 100000);
      this._cdf = buildZipfCDF(this._tableSize, zipfExponent);
    }
  }

  /**
   * Pick a random user ID string.
   * @returns {string} e.g. "user_000042"
   */
  pickUserId() {
    let num;
    if (this._cdf) {
      // Zipf: sample a rank from the skewed distribution
      const rank = sampleZipfRank(this._cdf);
      // Map rank back to full pool if pool > table size
      if (this._userPoolSize > this._tableSize) {
        // Scale rank proportionally and add random jitter within the bucket
        const bucketSize = this._userPoolSize / this._tableSize;
        num = Math.floor(rank * bucketSize + Math.random() * bucketSize) + 1;
        num = Math.min(num, this._userPoolSize);
      } else {
        num = rank + 1;
      }
    } else {
      // Uniform random
      num = 1 + Math.floor(Math.random() * this._userPoolSize);
    }
    return `user_${String(num).padStart(6, '0')}`;
  }
}
