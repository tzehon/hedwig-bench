const COOLDOWN_SECONDS = 60;

/**
 * Calculate the extra read-only seconds needed to achieve the desired isolation percentage.
 *
 * @param {number} writeScheduleTime - Total seconds in the write schedule
 * @param {number} gapTotalSeconds   - Seconds that are already isolation (gaps between spikes)
 * @param {number} readIsolationPct  - Desired isolation percentage (0-100)
 * @returns {number} Extra read-only seconds to append
 */
function calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct) {
  if (readIsolationPct <= 0) return 0;
  const pct = readIsolationPct / 100;
  const extra = Math.ceil((pct * writeScheduleTime - gapTotalSeconds) / (1 - pct));
  return Math.max(0, extra);
}

/**
 * Calculate the concurrent read rate (during write-active phases) that satisfies the
 * target average read RPS across the entire run.
 *
 * @param {object} params
 * @param {number} params.readRPSAvg       - Target average read RPS
 * @param {number} params.readRPSMin       - Minimum read RPS (used during gaps)
 * @param {number} params.readRPSMax       - Maximum read RPS (peak during isolation)
 * @param {number} params.writeActiveSeconds - Seconds where writes are active
 * @param {number} params.gapTotalSeconds    - Seconds of gaps (reads at min)
 * @param {number} params.extraReadOnly      - Extra read-only seconds (triangle pattern)
 * @returns {number} Concurrent read rate (clamped to [min, max])
 */
function calcConcurrentReadRate({ readRPSAvg, readRPSMin, readRPSMax, writeActiveSeconds, gapTotalSeconds, extraReadOnly }) {
  const totalTime = writeActiveSeconds + gapTotalSeconds + extraReadOnly;
  if (totalTime === 0 || writeActiveSeconds === 0) return readRPSAvg;

  // Triangle (min → max → min) has average = (min + max) / 2
  const readOnlyAvg = (readRPSMin + readRPSMax) / 2;

  const rate = Math.round(
    (readRPSAvg * totalTime - readRPSMin * gapTotalSeconds - readOnlyAvg * extraReadOnly) / writeActiveSeconds,
  );
  return Math.max(readRPSMin, Math.min(readRPSMax, rate));
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
 * @param {number} [config.readRPSMin]     - Minimum read RPS (default: falls back to targetReadRPS or 1500)
 * @param {number} [config.readRPSMax]     - Maximum read RPS (default: same as min for constant rate)
 * @param {number} [config.readRPSAvg]     - Target average read RPS (default: same as min)
 * @param {number} [config.readIsolationPct] - Percentage of run time that should be read-only (0-100, default: 0)
 * @param {number} [config.targetReadRPS]  - Legacy: constant read RPS (used as fallback)
 * @param {number} [config.readRPS]        - Legacy alias for targetReadRPS
 * @returns {Array<{ second: number, targetWriteRPS: number, targetReadRPS: number }>}
 */
export function generateSchedule(config) {
  const { targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;

  // Read config — backward-compatible: if no new params, use constant rate
  const readIsolationPct = config.readIsolationPct ?? 0;
  const legacyReadRPS = config.targetReadRPS ?? config.readRPS ?? 1500;
  const readRPSMin = config.readRPSMin ?? legacyReadRPS;
  const readRPSMax = config.readRPSMax ?? legacyReadRPS;
  const readRPSAvg = config.readRPSAvg ?? legacyReadRPS;

  const schedule = [];
  let second = 0;

  // Pre-calculate durations
  const writeActiveSeconds = numSpikes * (rampSeconds + sustainSeconds + COOLDOWN_SECONDS);
  const gapTotalSeconds = Math.max(0, numSpikes - 1) * gapSeconds;
  const writeScheduleTime = writeActiveSeconds + gapTotalSeconds;

  const extraReadOnly = calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct);

  // Determine read rate during concurrent (write-active) phases
  let concurrentReadRate;
  if (readIsolationPct > 0) {
    concurrentReadRate = calcConcurrentReadRate({
      readRPSAvg,
      readRPSMin,
      readRPSMax,
      writeActiveSeconds,
      gapTotalSeconds,
      extraReadOnly,
    });
  } else {
    // No isolation — constant read rate everywhere
    concurrentReadRate = readRPSAvg;
  }

  // ── Write spike phases ──
  for (let spike = 0; spike < numSpikes; spike++) {
    // Ramp: linear 0 -> target over rampSeconds
    for (let s = 0; s < rampSeconds; s++) {
      const rps = rampSeconds > 0
        ? Math.round(targetWriteRPS * (s / rampSeconds))
        : targetWriteRPS;
      schedule.push({ second, targetWriteRPS: rps, targetReadRPS: concurrentReadRate });
      second++;
    }

    // Sustain: hold at target for sustainSeconds
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second, targetWriteRPS, targetReadRPS: concurrentReadRate });
      second++;
    }

    // Cooldown: linear target -> 0 over 60s
    for (let s = 0; s < COOLDOWN_SECONDS; s++) {
      const rps = Math.round(targetWriteRPS * (1 - (s + 1) / COOLDOWN_SECONDS));
      schedule.push({ second, targetWriteRPS: rps, targetReadRPS: concurrentReadRate });
      second++;
    }

    // Gap: silence between spikes (skip after last spike)
    if (spike < numSpikes - 1) {
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({
          second,
          targetWriteRPS: 0,
          targetReadRPS: readIsolationPct > 0 ? readRPSMin : concurrentReadRate,
        });
        second++;
      }
    }
  }

  // ── Read-only isolation phase (triangle: min → max → min) ──
  if (extraReadOnly > 0) {
    const halfReadOnly = Math.floor(extraReadOnly / 2);
    // Ramp up: min → max
    for (let s = 0; s < halfReadOnly; s++) {
      const rps = Math.round(readRPSMin + (readRPSMax - readRPSMin) * (s / Math.max(1, halfReadOnly)));
      schedule.push({ second, targetWriteRPS: 0, targetReadRPS: rps });
      second++;
    }
    // Ramp down: max → min
    const remaining = extraReadOnly - halfReadOnly;
    for (let s = 0; s < remaining; s++) {
      const rps = Math.round(readRPSMax - (readRPSMax - readRPSMin) * (s / Math.max(1, remaining)));
      schedule.push({ second, targetWriteRPS: 0, targetReadRPS: rps });
      second++;
    }
  }

  return schedule;
}

/**
 * Compute total duration in seconds for a given spike config,
 * including the read-only isolation phase if configured.
 *
 * @param {object} config - Same shape as generateSchedule config
 * @returns {number} Total seconds the run will last
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
