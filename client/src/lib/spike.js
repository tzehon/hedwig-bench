// Client-side spike schedule generator (mirrors server logic for previews)

function calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct) {
  if (readIsolationPct <= 0) return 0;
  const pct = readIsolationPct / 100;
  const extra = Math.ceil((pct * writeScheduleTime - gapTotalSeconds) / (1 - pct));
  return Math.max(0, extra);
}

export function generateSchedule({
  targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds,
  readRPSConcurrent = 8000, readRPSIsolation = 2000, readIsolationPct = 0,
}) {
  const schedule = [];
  let t = 0;

  const writeActiveSeconds = numSpikes * (rampSeconds + sustainSeconds + 60);
  const gapTotalSeconds = Math.max(0, numSpikes - 1) * gapSeconds;
  const writeScheduleTime = writeActiveSeconds + gapTotalSeconds;
  const extraReadOnly = calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct);

  const concurrentRate = readRPSConcurrent;
  const isolationRate = readRPSIsolation;

  for (let spike = 0; spike < numSpikes; spike++) {
    for (let s = 0; s < rampSeconds; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: targetWriteRPS * (s / rampSeconds),
        targetReadRPS: concurrentRate,
      });
    }
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second: t++, targetWriteRPS, targetReadRPS: concurrentRate });
    }
    for (let s = 0; s < 60; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: targetWriteRPS * (1 - s / 60),
        targetReadRPS: concurrentRate,
      });
    }
    if (spike < numSpikes - 1) {
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({ second: t++, targetWriteRPS: 0, targetReadRPS: isolationRate });
      }
    }
  }

  // Read-only isolation phase (flat rate)
  if (extraReadOnly > 0) {
    for (let s = 0; s < extraReadOnly; s++) {
      schedule.push({ second: t++, targetWriteRPS: 0, targetReadRPS: isolationRate });
    }
  }

  return schedule;
}

export function getTotalDuration({ numSpikes, rampSeconds, sustainSeconds, gapSeconds, readIsolationPct = 0 }) {
  const spikeLength = rampSeconds + sustainSeconds + 60;
  const gaps = Math.max(0, numSpikes - 1) * gapSeconds;
  const writeScheduleTime = numSpikes * spikeLength + gaps;
  const extraReadOnly = calcExtraReadOnlySeconds(writeScheduleTime, gaps, readIsolationPct);
  return writeScheduleTime + extraReadOnly;
}
