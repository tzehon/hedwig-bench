// Client-side spike schedule generator (mirrors server logic for previews)
export function generateSchedule({ targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds }) {
  const schedule = [];
  let t = 0;
  for (let spike = 0; spike < numSpikes; spike++) {
    for (let s = 0; s < rampSeconds; s++) {
      schedule.push({ second: t++, targetWriteRPS: targetWriteRPS * (s / rampSeconds) });
    }
    for (let s = 0; s < sustainSeconds; s++) {
      schedule.push({ second: t++, targetWriteRPS: targetWriteRPS });
    }
    for (let s = 0; s < 60; s++) {
      schedule.push({ second: t++, targetWriteRPS: targetWriteRPS * (1 - s / 60) });
    }
    if (spike < numSpikes - 1) {
      for (let s = 0; s < gapSeconds; s++) {
        schedule.push({ second: t++, targetWriteRPS: 0 });
      }
    }
  }
  return schedule;
}

export function getTotalDuration({ numSpikes, rampSeconds, sustainSeconds, gapSeconds }) {
  const spikeLength = rampSeconds + sustainSeconds + 60;
  return numSpikes * spikeLength + Math.max(0, numSpikes - 1) * gapSeconds;
}
