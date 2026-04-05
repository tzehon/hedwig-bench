const COOLDOWN_SECONDS = 60;

/**
 * Generate a spike schedule.
 *
 * @param {object} config
 * @param {number} config.targetWriteRPS   - Peak writes per second during sustain
 * @param {number} config.numSpikes        - Number of spike cycles
 * @param {number} config.rampSeconds      - Seconds to ramp from 0 to target
 * @param {number} config.sustainSeconds   - Seconds to hold at target
 * @param {number} config.gapSeconds       - Seconds of silence between spikes
 * @returns {Array<{ second: number, targetWriteRPS: number }>}
 */
export function generateSchedule(config) {
  const { targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;
  const schedule = [];
  let second = 0;

  for (let spike = 0; spike < numSpikes; spike++) {
    // ── Ramp: linear 0 -> target over rampSeconds ──
    for (let s = 0; s < rampSeconds; s++) {
      const rps = rampSeconds > 0
        ? Math.round(targetWriteRPS * (s / rampSeconds))
        : targetWriteRPS;
      schedule.push({ second, targetWriteRPS: rps });
      second++;
    }

    // ── Sustain: hold at target for sustainSeconds ──
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second, targetWriteRPS });
      second++;
    }

    // ── Cooldown: linear target -> 0 over 60s ──
    for (let s = 0; s < COOLDOWN_SECONDS; s++) {
      const rps = Math.round(targetWriteRPS * (1 - (s + 1) / COOLDOWN_SECONDS));
      schedule.push({ second, targetWriteRPS: rps });
      second++;
    }

    // ── Gap: silence between spikes (skip after last spike) ──
    if (spike < numSpikes - 1) {
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({ second, targetWriteRPS: 0 });
        second++;
      }
    }
  }

  return schedule;
}

/**
 * Compute total duration in seconds for a given spike config.
 *
 * @param {object} config - Same shape as generateSchedule config
 * @returns {number} Total seconds the run will last
 */
export function getTotalDurationSeconds(config) {
  const { numSpikes, rampSeconds, sustainSeconds, gapSeconds } = config;

  const spikeLength = rampSeconds + sustainSeconds + COOLDOWN_SECONDS;
  const gaps = Math.max(0, numSpikes - 1) * gapSeconds;

  return numSpikes * spikeLength + gaps;
}
