// Client-side spike schedule generator (mirrors server logic for previews)

function calcTotalIsolationSeconds(writeActiveSeconds, readIsolationPct) {
  if (readIsolationPct <= 0) return 0;
  const pct = readIsolationPct / 100;
  return Math.ceil((pct * writeActiveSeconds) / (1 - pct));
}

export function generateSchedule({
  targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds,
  readRPSConcurrent = 8000, readRPSIsolation = 2000, readIsolationPct = 0,
}) {
  const schedule = [];
  let t = 0;

  const spikeLength = rampSeconds + sustainSeconds + 60;
  const writeActiveSeconds = numSpikes * spikeLength;
  const totalIsolation = calcTotalIsolationSeconds(writeActiveSeconds, readIsolationPct);
  const blockDuration = numSpikes > 0 ? Math.ceil(totalIsolation / numSpikes) : 0;

  for (let spike = 0; spike < numSpikes; spike++) {
    for (let s = 0; s < rampSeconds; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: targetWriteRPS * (s / rampSeconds),
        targetReadRPS: readRPSConcurrent,
      });
    }
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second: t++, targetWriteRPS, targetReadRPS: readRPSConcurrent });
    }
    for (let s = 0; s < 60; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: targetWriteRPS * (1 - s / 60),
        targetReadRPS: readRPSConcurrent,
      });
    }

    if (readIsolationPct > 0 && blockDuration > 0) {
      // Interleaved isolation block after each spike
      for (let s = 0; s < blockDuration; s++) {
        schedule.push({ second: t++, targetWriteRPS: 0, targetReadRPS: readRPSIsolation });
      }
    } else if (spike < numSpikes - 1) {
      // Legacy: gap between spikes
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({ second: t++, targetWriteRPS: 0, targetReadRPS: readRPSConcurrent });
      }
    }
  }

  return schedule;
}

export function getTotalDuration({ numSpikes, rampSeconds, sustainSeconds, gapSeconds, readIsolationPct = 0 }) {
  const spikeLength = rampSeconds + sustainSeconds + 60;
  const writeActiveSeconds = numSpikes * spikeLength;

  if (readIsolationPct > 0) {
    const totalIsolation = calcTotalIsolationSeconds(writeActiveSeconds, readIsolationPct);
    const blockDuration = numSpikes > 0 ? Math.ceil(totalIsolation / numSpikes) : 0;
    return writeActiveSeconds + numSpikes * blockDuration;
  }

  const gaps = Math.max(0, numSpikes - 1) * gapSeconds;
  return writeActiveSeconds + gaps;
}
