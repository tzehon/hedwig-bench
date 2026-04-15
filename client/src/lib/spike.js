// Client-side spike schedule generator (mirrors server logic for previews)

function calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct) {
  if (readIsolationPct <= 0) return 0;
  const pct = readIsolationPct / 100;
  const extra = Math.ceil((pct * writeScheduleTime - gapTotalSeconds) / (1 - pct));
  return Math.max(0, extra);
}

export function generateSchedule({
  targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds,
  readRPSMin, readRPSMax, readRPSAvg, readIsolationPct = 0,
  targetReadRPS,
}) {
  const legacyReadRPS = targetReadRPS ?? 1500;
  const rMin = readRPSMin ?? legacyReadRPS;
  const rMax = readRPSMax ?? legacyReadRPS;
  const rAvg = readRPSAvg ?? legacyReadRPS;

  const schedule = [];
  let t = 0;

  const writeActiveSeconds = numSpikes * (rampSeconds + sustainSeconds + 60);
  const gapTotalSeconds = Math.max(0, numSpikes - 1) * gapSeconds;
  const writeScheduleTime = writeActiveSeconds + gapTotalSeconds;
  const extraReadOnly = calcExtraReadOnlySeconds(writeScheduleTime, gapTotalSeconds, readIsolationPct);

  let concurrentReadRate;
  if (readIsolationPct > 0) {
    const totalTime = writeActiveSeconds + gapTotalSeconds + extraReadOnly;
    const readOnlyAvg = (rMin + rMax) / 2;
    concurrentReadRate = writeActiveSeconds > 0
      ? Math.round((rAvg * totalTime - rMin * gapTotalSeconds - readOnlyAvg * extraReadOnly) / writeActiveSeconds)
      : rAvg;
    concurrentReadRate = Math.max(rMin, Math.min(rMax, concurrentReadRate));
  } else {
    concurrentReadRate = rAvg;
  }

  for (let spike = 0; spike < numSpikes; spike++) {
    for (let s = 0; s < rampSeconds; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: targetWriteRPS * (s / rampSeconds),
        targetReadRPS: concurrentReadRate,
      });
    }
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second: t++, targetWriteRPS, targetReadRPS: concurrentReadRate });
    }
    for (let s = 0; s < 60; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: targetWriteRPS * (1 - s / 60),
        targetReadRPS: concurrentReadRate,
      });
    }
    if (spike < numSpikes - 1) {
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({
          second: t++,
          targetWriteRPS: 0,
          targetReadRPS: readIsolationPct > 0 ? rMin : concurrentReadRate,
        });
      }
    }
  }

  // Read-only isolation phase (triangle: min → max → min)
  if (extraReadOnly > 0) {
    const half = Math.floor(extraReadOnly / 2);
    for (let s = 0; s < half; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: 0,
        targetReadRPS: rMin + (rMax - rMin) * (s / Math.max(1, half)),
      });
    }
    const remaining = extraReadOnly - half;
    for (let s = 0; s < remaining; s++) {
      schedule.push({
        second: t++,
        targetWriteRPS: 0,
        targetReadRPS: rMax - (rMax - rMin) * (s / Math.max(1, remaining)),
      });
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
