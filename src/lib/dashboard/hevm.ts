import { ageFromTimestamp } from "@/lib/dashboard/shared";
import { buildHevmDashboardStats } from "@/lib/hevm/service";

export type HevmApiResult = {
  source: "api";
  address: string;
  period: { startTime: number; endTime: number };
  stats: {
    twab: number | null;
    volume: number;
    feesPaid: number;
    contractsCount: number;
    activeDays: number;
    activeMonths: number;
    sinceFirstTx: { days: number; months: number; years: number };
    bridgeVolume: number;
    totalTxCount: number;
    initiatedTxCount: number;
    firstTxTime: number | null;
    charts: {
      volume: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
      twab: Record<"day" | "week" | "month" | "year", Array<{ period: string; twab: number }>>;
    };
  };
  meta: {
    requestsUsed: number;
    truncated: boolean;
    warnings: string[];
    debug?: Record<string, unknown>;
  };
};

const periodKey = (timestampMs: number, g: "day" | "week" | "month" | "year") => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  if (g === "day") return d.toISOString().slice(0, 10);
  if (g === "month") return d.toISOString().slice(0, 7);
  if (g === "year") return String(d.getUTCFullYear());
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d.getTime() - start.getTime()) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
};

const buildVolumeSeries = (segments: Array<{ startTimestamp: number; totalUsd: number }>) => {
  const maps: Record<"day" | "week" | "month" | "year", Map<string, number>> = {
    day: new Map(),
    week: new Map(),
    month: new Map(),
    year: new Map(),
  };

  for (const s of segments) {
    const tsMs = s.startTimestamp * 1000;
    for (const g of ["day", "week", "month", "year"] as const) {
      const key = periodKey(tsMs, g);
      if (!key) continue;
      maps[g].set(key, (maps[g].get(key) ?? 0) + Math.max(0, s.totalUsd));
    }
  }

  return {
    day: [...maps.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
    week: [...maps.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
    month: [...maps.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
    year: [...maps.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
  };
};

const buildTwabSeries = (segments: Array<{ startTimestamp: number; totalUsd: number; durationSeconds: number; contribution: number }>) => {
  const maps: Record<"day" | "week" | "month" | "year", Map<string, { area: number; duration: number }>> = {
    day: new Map(),
    week: new Map(),
    month: new Map(),
    year: new Map(),
  };

  for (const s of segments) {
    const tsMs = s.startTimestamp * 1000;
    for (const g of ["day", "week", "month", "year"] as const) {
      const key = periodKey(tsMs, g);
      if (!key) continue;
      const row = maps[g].get(key) ?? { area: 0, duration: 0 };
      row.area += s.contribution;
      row.duration += Math.max(0, s.durationSeconds);
      maps[g].set(key, row);
    }
  }

  const toRows = (m: Map<string, { area: number; duration: number }>) =>
    [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, row]) => ({
      period,
      twab: row.duration > 0 ? row.area / row.duration : 0,
    }));

  return {
    day: toRows(maps.day),
    week: toRows(maps.week),
    month: toRows(maps.month),
    year: toRows(maps.year),
  };
};

export const fetchHevmStatsFromApi = async (address: string): Promise<HevmApiResult> => {
  const stats = await buildHevmDashboardStats(address);
  const firstTsMs = stats.walletAge.firstSeenTimestamp > 0 ? stats.walletAge.firstSeenTimestamp * 1000 : null;
  const since = firstTsMs ? ageFromTimestamp(firstTsMs) : { days: 0, months: 0, years: 0 };
  const explorerTotalFromDebug = Number(
    (stats.debug as unknown as { txCountBreakdown?: { explorerTotal?: number } })?.txCountBreakdown?.explorerTotal ?? 0
  );
  const normalTxCountFromDebug = Number(
    (stats.debug as unknown as { txCountBreakdown?: { normal?: number } })?.txCountBreakdown?.normal ?? 0
  );
  const explorerStyleTxCount =
    explorerTotalFromDebug > 0
      ? explorerTotalFromDebug
      : normalTxCountFromDebug > 0
        ? normalTxCountFromDebug
        : stats.txCounts.allActivityTxCount;

  const segments = stats.twabSegments.map((s) => ({
    startTimestamp: s.startTimestamp,
    totalUsd: s.totalUsd,
    durationSeconds: s.durationSeconds,
    contribution: s.contribution,
  }));

  return {
    source: "api",
    address,
    period: { startTime: stats.startTime * 1000, endTime: stats.endTime * 1000 },
    stats: {
      twab: Number.isFinite(stats.twabUsd) ? stats.twabUsd : null,
      volume: stats.volume.totalVolumeUsd,
      feesPaid: stats.feesPaidUsd,
      contractsCount: stats.contracts.touchedContracts,
      activeDays: stats.activePeriods.activeDays,
      activeMonths: stats.activePeriods.activeMonths,
      sinceFirstTx: since,
      bridgeVolume: stats.bridge.totalBridgeVolumeUsd,
      totalTxCount: explorerStyleTxCount,
      initiatedTxCount: stats.txCounts.sentAccountTxCount,
      firstTxTime: firstTsMs,
      charts: {
        volume: buildVolumeSeries(segments),
        twab: buildTwabSeries(segments),
      },
    },
    meta: {
      requestsUsed: 0,
      truncated: false,
      warnings: [
        "HEVM module rebuilt with event-sourced pipeline (indexer/adapters/pricing/timeline/metrics).",
        "Use HEVM debug panel to inspect tx/volume/price decomposition and confidence score.",
      ],
      debug: stats.debug as unknown as Record<string, unknown>,
    },
  };
};
