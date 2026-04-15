const COOLDOWN_SECONDS = 60;

/**
 * Calculate total isolation time from the isolation percentage and write-active time.
 * isolationTime / totalTime = pct  →  isolationTime = pct × writeActive / (1 - pct)
 */
function calcTotalIsolationSeconds(writeActiveSeconds, readIsolationPct) {
  if (readIsolationPct <= 0) return 0;
  const pct = readIsolationPct / 100;
  return Math.ceil((pct * writeActiveSeconds) / (1 - pct));
}

/**
 * Resolve read rates from config.
 */
function resolveReadRates(config) {
  // Direct mode: explicit concurrent and isolation rates
  if (config.readRPSConcurrent != null && config.readRPSIsolation != null) {
    return {
      concurrentRate: config.readRPSConcurrent,
      isolationRate: config.readRPSIsolation,
    };
  }

  // Legacy fallback
  const legacyReadRPS = config.targetReadRPS ?? config.readRPS ?? 1500;
  return { concurrentRate: legacyReadRPS, isolationRate: legacyReadRPS };
}

/**
 * Generate a spike schedule with interleaved write and read-only phases.
 *
 * When isolation is enabled (readIsolationPct > 0), an isolation block follows
 * each write spike rather than being appended at the end:
 *
 *   [Spike 1: ramp→sustain→cooldown] → [Isolation] → [Spike 2] → [Isolation] → ...
 *
 * @param {object} config
 * @param {number} config.targetWriteRPS
 * @param {number} config.numSpikes
 * @param {number} config.rampSeconds
 * @param {number} config.sustainSeconds
 * @param {number} config.gapSeconds       - Gap between spikes (used when isolation = 0)
 * @param {number} [config.readRPSConcurrent] - Read RPS during write-active phases
 * @param {number} [config.readRPSIsolation]  - Read RPS during read-only phases
 * @param {number} [config.readIsolationPct]  - % of run time that is read-only (0-100)
 * @returns {Array<{ second: number, targetWriteRPS: number, targetReadRPS: number }>}
 */
export function generateSchedule(config) {
  const { targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;
  const readIsolationPct = config.readIsolationPct ?? 0;

  const schedule = [];
  let second = 0;

  const { concurrentRate, isolationRate } = resolveReadRates(config);

  // Calculate isolation block duration per spike
  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;
  const writeActiveSeconds = numSpikes * spikeLength;
  const totalIsolation = calcTotalIsolationSeconds(writeActiveSeconds, readIsolationPct);
  const isolationBlockDuration = numSpikes > 0 ? Math.ceil(totalIsolation / numSpikes) : 0;

  for (let spike = 0; spike < numSpikes; spike++) {
    // ── Ramp: linear 0 → target ──
    for (let s = 0; s < rampSeconds; s++) {
      const rps = rampSeconds > 0
        ? Math.round(targetWriteRPS * (s / rampSeconds))
        : targetWriteRPS;
      schedule.push({ second, targetWriteRPS: rps, targetReadRPS: concurrentRate });
      second++;
    }

    // ── Sustain: hold at target ──
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second, targetWriteRPS, targetReadRPS: concurrentRate });
      second++;
    }

    // ── Cooldown: target → 0 over 60s ──
    for (let s = 0; s < COOLDOWN_SECONDS; s++) {
      const rps = Math.round(targetWriteRPS * (1 - (s + 1) / COOLDOWN_SECONDS));
      schedule.push({ second, targetWriteRPS: rps, targetReadRPS: concurrentRate });
      second++;
    }

    // ── Isolation block (interleaved after each spike) ──
    if (readIsolationPct > 0 && isolationBlockDuration > 0) {
      for (let s = 0; s < isolationBlockDuration; s++) {
        schedule.push({ second, targetWriteRPS: 0, targetReadRPS: isolationRate });
        second++;
      }
    } else if (spike < numSpikes - 1) {
      // Legacy: gap between spikes (no isolation configured)
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({ second, targetWriteRPS: 0, targetReadRPS: concurrentRate });
        second++;
      }
    }
  }

  return schedule;
}

/**
 * Compute total duration in seconds.
 */
export function getTotalDurationSeconds(config) {
  const { numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;
  const readIsolationPct = config.readIsolationPct ?? 0;

  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;
  const writeActiveSeconds = numSpikes * spikeLength;

  if (readIsolationPct > 0) {
    const totalIsolation = calcTotalIsolationSeconds(writeActiveSeconds, readIsolationPct);
    const blockDuration = numSpikes > 0 ? Math.ceil(totalIsolation / numSpikes) : 0;
    return writeActiveSeconds + numSpikes * blockDuration;
  }

  // Legacy: gaps between spikes
  const gaps = Math.max(0, numSpikes - 1) * gapSeconds;
  return writeActiveSeconds + gaps;
}
