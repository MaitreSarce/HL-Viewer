export type TwabGranularity = "day" | "week" | "month" | "year";

export type TwabValuePoint = {
  timeSec: number;
  valueUsd: number;
};

const utcDayKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const utcMonthKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 7);
};

const utcWeekKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
};

const utcYearKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return String(d.getUTCFullYear());
};

const periodKey = (timestampMs: number, granularity: TwabGranularity): string => {
  if (granularity === "day") return utcDayKey(timestampMs);
  if (granularity === "week") return utcWeekKey(timestampMs);
  if (granularity === "month") return utcMonthKey(timestampMs);
  return utcYearKey(timestampMs);
};

const nextPeriodStartMs = (timestampMs: number, granularity: TwabGranularity): number => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return timestampMs + 24 * 60 * 60 * 1000;
  if (granularity === "day") {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  if (granularity === "week") {
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.getTime();
  }
  if (granularity === "month") {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.getTime();
  }
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(1);
  d.setUTCMonth(0);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
};

const normalizePoints = (points: TwabValuePoint[]): TwabValuePoint[] =>
  points
    .filter((p) => Number.isFinite(p.timeSec) && p.timeSec > 0 && Number.isFinite(p.valueUsd))
    .sort((a, b) => a.timeSec - b.timeSec);

export const computeTwabUsdFromValuePoints = (pointsRaw: TwabValuePoint[], endTimeSec: number): number | null => {
  const points = normalizePoints(pointsRaw);
  if (points.length === 0) return null;

  let area = 0;
  let lastT = points[0].timeSec;
  let lastV = points[0].valueUsd;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p.timeSec <= lastT) continue;
    area += Math.max(0, lastV) * (p.timeSec - lastT);
    lastT = p.timeSec;
    lastV = p.valueUsd;
  }
  const end = Math.max(lastT, Math.floor(endTimeSec));
  if (end > lastT) area += Math.max(0, lastV) * (end - lastT);
  const duration = Math.max(0, end - points[0].timeSec);
  if (duration <= 0) return lastV > 0 ? lastV : null;
  const twab = area / duration;
  return twab > 0 ? twab : null;
};

export const computeTwabSeriesUsdFromValuePoints = (
  pointsRaw: TwabValuePoint[],
  endTimeSec: number
): Record<TwabGranularity, Array<{ period: string; twab: number }>> => {
  const points = normalizePoints(pointsRaw);
  const empty = { day: [], week: [], month: [], year: [] } as Record<
    TwabGranularity,
    Array<{ period: string; twab: number }>
  >;
  if (points.length === 0) return empty;

  const maps = {
    day: new Map<string, { area: number; duration: number }>(),
    week: new Map<string, { area: number; duration: number }>(),
    month: new Map<string, { area: number; duration: number }>(),
    year: new Map<string, { area: number; duration: number }>(),
  };

  const addSeg = (g: TwabGranularity, startSec: number, endSec: number, valueUsd: number) => {
    if (endSec <= startSec) return;
    let cursorMs = startSec * 1000;
    const endMs = endSec * 1000;
    while (cursorMs < endMs) {
      const key = periodKey(cursorMs, g);
      if (!key) break;
      const boundary = nextPeriodStartMs(cursorMs, g);
      const segEnd = Math.min(endMs, boundary);
      const durationSec = Math.max(0, (segEnd - cursorMs) / 1000);
      if (durationSec > 0) {
        const prev = maps[g].get(key) ?? { area: 0, duration: 0 };
        prev.area += Math.max(0, valueUsd) * durationSec;
        prev.duration += durationSec;
        maps[g].set(key, prev);
      }
      cursorMs = segEnd;
    }
  };

  let lastT = points[0].timeSec;
  let lastV = points[0].valueUsd;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p.timeSec <= lastT) continue;
    for (const g of ["day", "week", "month", "year"] as const) addSeg(g, lastT, p.timeSec, lastV);
    lastT = p.timeSec;
    lastV = p.valueUsd;
  }
  const end = Math.max(lastT, Math.floor(endTimeSec));
  if (end > lastT) {
    for (const g of ["day", "week", "month", "year"] as const) addSeg(g, lastT, end, lastV);
  }

  const toSeries = (map: Map<string, { area: number; duration: number }>) =>
    [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, v]) => ({ period, twab: v.duration > 0 ? v.area / v.duration : 0 }));

  return {
    day: toSeries(maps.day),
    week: toSeries(maps.week),
    month: toSeries(maps.month),
    year: toSeries(maps.year),
  };
};
