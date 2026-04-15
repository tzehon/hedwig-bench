const COOLDOWN_SECONDS = 60;

/**
 * Calculate the extra read-only seconds needed to achieve the desired isolation percentage.
 */
function calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct) {
  if (readIsolationPct <= 0) return 0;
  const pct = readIsolationPct / 100;
  const extra = Math.ceil((pct * writeScheduleTime - gapTotalSeconds) / (1 - pct));
  return Math.max(0, extra);
}

/**
 * Resolve read rates from config.
 *
 * Supports two modes:
 *   1. Direct: readRPSConcurrent + readRPSIsolation (preferred, used by current UI)
 *   2. Legacy: readRPSMin + readRPSMax + readRPSAvg (auto-computes concurrent rate)
 *
 * @returns {{ concurrentRate: number, isolationRate: number }}
 */
function resolveReadRates(config, writeActiveSeconds, gapTotalSeconds, extraReadOnly) {
  const readIsolationPct = config.readIsolationPct ?? 0;

  // Direct mode: explicit concurrent and isolation rates
  if (config.readRPSConcurrent != null && config.readRPSIsolation != null) {
    return {
      concurrentRate: config.readRPSConcurrent,
      isolationRate: config.readRPSIsolation,
    };
  }

  // Legacy mode: compute from min/avg/max
  const legacyReadRPS = config.targetReadRPS ?? config.readRPS ?? 1500;
  const readRPSMin = config.readRPSMin ?? legacyReadRPS;
  const readRPSMax = config.readRPSMax ?? legacyReadRPS;
  const readRPSAvg = config.readRPSAvg ?? legacyReadRPS;

  if (readIsolationPct <= 0) {
    return { concurrentRate: readRPSAvg, isolationRate: readRPSAvg };
  }

  const totalTime = writeActiveSeconds + gapTotalSeconds + extraReadOnly;
  const isolationRate = (readRPSMin + readRPSMax) / 2;

  let concurrentRate = readRPSAvg;
  if (writeActiveSeconds > 0 && totalTime > 0) {
    concurrentRate = Math.round(
      (readRPSAvg * totalTime - readRPSMin * gapTotalSeconds - isolationRate * extraReadOnly) / writeActiveSeconds,
    );
    concurrentRate = Math.max(readRPSMin, Math.min(readRPSMax, concurrentRate));
  }

  return { concurrentRate, isolationRate };
}

/**
 * Generate a spike schedule with both write and read targets per second.
 *
 * @param {object} config
 * @param {number} config.targetWriteRPS   - Peak writes per second during sustain
 * @param {number} config.numSpikes        - Number of spike cycles
 * @param {number} config.rampSeconds      - Seconds to ramp from 0 to target
 * @param {number} config.sustainSeconds   - Seconds to hold at target
 * @param {number} config.gapSeconds       - Seconds of silence between spikes
 * @param {number} [config.readRPSConcurrent] - Read RPS during write-active phases (preferred)
 * @param {number} [config.readRPSIsolation]  - Read RPS during read-only phase (preferred)
 * @param {number} [config.readIsolationPct]  - Percentage of run time that is read-only (0-100)
 * @returns {Array<{ second: number, targetWriteRPS: number, targetReadRPS: number }>}
 */
export function generateSchedule(config) {
  const { targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;
  const readIsolationPct = config.readIsolationPct ?? 0;

  const schedule = [];
  let second = 0;

  // Pre-calculate durations
  const writeActiveSeconds = numSpikes * (rampSeconds + sustainSeconds + COOLDOWN_SECONDS);
  const gapTotalSeconds = Math.max(0, numSpikes - 1) * gapSeconds;
  const writeScheduleTime = writeActiveSeconds + gapTotalSeconds;
  const extraReadOnly = calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct);

  // Resolve read rates
  const { concurrentRate, isolationRate } = resolveReadRates(
    config, writeActiveSeconds, gapTotalSeconds, extraReadOnly,
  );

  // ── Write spike phases ──
  for (let spike = 0; spike < numSpikes; spike++) {
    // Ramp
    for (let s = 0; s < rampSeconds; s++) {
      const rps = rampSeconds > 0
        ? Math.round(targetWriteRPS * (s / rampSeconds))
        : targetWriteRPS;
      schedule.push({ second, targetWriteRPS: rps, targetReadRPS: concurrentRate });
      second++;
    }

    // Sustain
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second, targetWriteRPS, targetReadRPS: concurrentRate });
      second++;
    }

    // Cooldown
    for (let s = 0; s < COOLDOWN_SECONDS; s++) {
      const rps = Math.round(targetWriteRPS * (1 - (s + 1) / COOLDOWN_SECONDS));
      schedule.push({ second, targetWriteRPS: rps, targetReadRPS: concurrentRate });
      second++;
    }

    // Gap
    if (spike < numSpikes - 1) {
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({ second, targetWriteRPS: 0, targetReadRPS: isolationRate });
        second++;
      }
    }
  }

  // ── Read-only isolation phase (flat rate) ──
  if (extraReadOnly > 0) {
    for (let s = 0; s < extraReadOnly; s++) {
      schedule.push({ second, targetWriteRPS: 0, targetReadRPS: isolationRate });
      second++;
    }
  }

  return schedule;
}

/**
 * Compute total duration in seconds for a given spike config,
 * including the read-only isolation phase if configured.
 */
export function getTotalDurationSeconds(config) {
  const { numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;
  const readIsolationPct = config.readIsolationPct ?? 0;

  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;
  const gaps = Math.max(0, numSpikes - 1) * gapSeconds;
  const writeScheduleTime = numSpikes * spikeLength + gaps;

  const extraReadOnly = calcExtraReadOnlySeconds(writeScheduleTime, gaps, readIsolationPct);

  return writeScheduleTime + extraReadOnly;
}
