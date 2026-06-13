"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type TradingData = {
  source: "api" | "full_export";
  totals: {
    fills: number;
    outcomes: { volume: number; pnl: number; feesPaid: number; wins?: number; losses?: number; trades?: number };
    xyz: { volume: number; pnl: number; feesPaid: number; wins?: number; losses?: number; trades?: number };
    perps: { volume: number; pnl: number; feesPaid: number; wins?: number; losses?: number; trades?: number };
    spotVolume: number;
    spotFeesPaid: number;
    spotTwab: number | null;
    vaultTwab: number | null;
    hypeStakingTwab: number | null;
    unitVolume: number;
    unitFeesPaid: number;
    unitTrades: number;
    unitTokens: string[];
    unitTwab: number | null;
    totalVolume: number;
  };
  winrates: {
    outcomes: number;
    xyz: number;
    perps: number;
  };
  meta?: {
    warnings?: string[];
    truncated?: boolean;
    dataSourceLabel?: string;
    apiScan?: {
      complete: boolean;
      canContinue: boolean;
      pendingWindows: number;
      pendingWindowsDetail?: Array<{ startTime: number; endTime: number }>;
      cachedFills: number;
      rateLimited: boolean;
      statelessDelta?: boolean;
    };
  };
  charts: {
    outcomes: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number; pnl: number }>>;
    xyz: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number; pnl: number }>>;
    perps: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number; pnl: number }>>;
    spot: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
    unit: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
    spotTwab: Record<"day" | "week" | "month" | "year", Array<{ period: string; twab: number }>>;
  };
};

type HevmData = {
  stats: {
    twab: number | null;
    volume: number;
    feesPaid: number;
    contractsCount: number;
    activeDays: number;
    activeMonths: number;
    sinceFirstTx: { days: number; months: number; years: number };
    totalTxCount: number;
    initiatedTxCount: number;
    charts: {
      volume: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
      twab: Record<"day" | "week" | "month" | "year", Array<{ period: string; twab: number }>>;
    };
  };
  meta: {
    warnings: string[];
    debug?: Record<string, unknown>;
  };
};

type UnitBridgeData = {
  stats: {
    volume: number;
    contractsCount: number;
    activeDays: number;
    activeMonths: number;
    sourceChainsCount: number;
    destinationChainsCount: number;
    sinceFirstTx: { days: number; months: number; years: number };
    txCount: number;
    charts: {
      volume: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
    };
  };
  meta: {
    coverageMode: "auth-range" | "public-snapshot" | "cursor-paginated";
    warnings: string[];
  };
};

type TabKey = "trading" | "hevm" | "unit";
type HistogramGranularity = "day" | "week" | "month" | "year";
type ApiScanProgress = {
  exists: boolean;
  fills: number;
  pendingWindows: number;
  pendingWindowsDetail?: Array<{ startTime: number; endTime: number }>;
  complete: boolean;
  canContinue: boolean;
  rateLimited: boolean;
  inProgress: boolean;
  requestsUsed: number;
  updatedAt: number | null;
};

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

const formatUsdCompact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

const formatNum = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);

const formatPct = (value: number) => `${value.toFixed(2)}%`;
const formatDuration = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const createApiScanId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const formatTwabWithAge = (twab: number | null, ageDays: number | null, unit: "usd" | "raw") => {
  if (twab === null) return "N/A";
  const base = unit === "usd" ? formatUsd(twab) : formatNum(twab);
  if (ageDays === null || ageDays <= 0) return base;
  const product = twab * ageDays;
  const productText = unit === "usd" ? formatUsd(product) : formatNum(product);
  return `${base} (${productText})`;
};

const StatRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-4 text-sm">
    <span className="text-slate-600">{label}</span>
    <span className="font-semibold text-slate-900">{value}</span>
  </div>
);

const ZoneCard = ({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
}) => (
  <article className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</h3>
    <div className="space-y-2">
      {rows.map((row) => (
        <StatRow key={`${title}-${row.label}`} label={row.label} value={row.value} />
      ))}
    </div>
  </article>
);

const HistogramCard = ({
  title,
  rows,
  allowNegative = false,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
  allowNegative?: boolean;
}) => {
  const [zoomX, setZoomX] = useState(1);
  const [zoomY, setZoomY] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const maxItems = 72;
  const displayedRows = rows.length > maxItems ? rows.slice(rows.length - maxItems) : rows;
  const positiveRows = displayedRows.filter((row) => row.value > 0);
  const negativeRows = displayedRows.filter((row) => row.value < 0);
  const maxPositive = positiveRows.reduce((acc, row) => Math.max(acc, row.value), 0);
  const minNegative = negativeRows.reduce((acc, row) => Math.min(acc, row.value), 0);
  const negativeAbs = Math.abs(minNegative);
  const maxAbs = Math.max(maxPositive, negativeAbs, 1);
  const total = displayedRows.reduce((sum, row) => sum + row.value, 0);
  const peak = displayedRows.reduce<{ label: string; value: number } | null>((best, row) => {
    if (!best || Math.abs(row.value) > Math.abs(best.value)) return row;
    return best;
  }, null);
  const latest = displayedRows[displayedRows.length - 1] ?? null;
  const columnWidthPx = Math.round(56 * zoomX);
  const columnGapPx = 8;
  const chartHeight = Math.round((allowNegative ? 280 : 240) * zoomY);
  const valueLabelHeight = 30;
  const axisLabelHeight = 38;
  const plotHeight = Math.max(120, chartHeight - valueLabelHeight - axisLabelHeight);
  const contentWidth = Math.round(displayedRows.length * columnWidthPx + Math.max(0, displayedRows.length - 1) * columnGapPx);
  const scrollEndPaddingPx = 96;
  const minWidth = Math.max(620, contentWidth + scrollEndPaddingPx);
  const zeroFromBottom = allowNegative
    ? maxPositive > 0 && negativeAbs > 0
      ? (negativeAbs / (maxPositive + negativeAbs)) * plotHeight
      : maxPositive > 0
        ? 0
        : plotHeight
    : 0;
  const topSpan = allowNegative ? plotHeight - zeroFromBottom : plotHeight;
  const bottomSpan = allowNegative ? zeroFromBottom : 0;
  const tickValues = allowNegative
    ? [maxPositive, maxPositive / 2, 0, minNegative / 2, minNegative].filter((value, index, arr) => index === 0 || Math.abs(value - arr[index - 1]) > 1e-9)
    : [maxAbs, maxAbs * 0.66, maxAbs * 0.33, 0];
  const chartTone = allowNegative ? "rose" : "cyan";
  const targetLabelWidthPx = 88;
  const labelEvery = Math.max(1, Math.ceil(targetLabelWidthPx / Math.max(1, columnWidthPx + columnGapPx)));

  const chartBody = (isExpanded = false) => (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Total shown</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdCompact(total)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Peak period</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-900" title={peak ? `${peak.label}: ${formatUsd(peak.value)}` : "N/A"}>
            {peak ? `${peak.label} - ${formatUsdCompact(peak.value)}` : "N/A"}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Latest</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-900" title={latest ? `${latest.label}: ${formatUsd(latest.value)}` : "N/A"}>
            {latest ? `${latest.label} - ${formatUsdCompact(latest.value)}` : "N/A"}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-3 shadow-inner">
        <div className="flex gap-3">
          <div className="flex w-16 flex-col justify-between py-5 text-right text-[10px] font-medium text-slate-400">
            {tickValues.map((tick, index) => (
              <span key={`${title}-tick-${index}`}>{formatUsdCompact(tick)}</span>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto pb-2">
            <div className="relative" style={{ minWidth: `${isExpanded ? Math.max(minWidth, 980) : minWidth}px` }}>
              <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white px-3" style={{ height: `${isExpanded ? chartHeight + 90 : chartHeight}px`, paddingTop: `${valueLabelHeight}px`, paddingBottom: `${axisLabelHeight}px` }}>
                <div className="pointer-events-none absolute inset-x-3" style={{ top: `${valueLabelHeight}px`, bottom: `${axisLabelHeight}px` }}>
                  <div className="absolute inset-x-0 top-0 border-t border-dashed border-slate-200" />
                  <div className="absolute inset-x-0 top-1/3 border-t border-dashed border-slate-100" />
                  <div className="absolute inset-x-0 top-2/3 border-t border-dashed border-slate-100" />
                  {allowNegative ? <div className="absolute inset-x-0 border-t-2 border-slate-300" style={{ bottom: `${zeroFromBottom}px` }} /> : null}
                </div>
                <div className="relative flex items-end" style={{ height: `${plotHeight}px`, gap: `${columnGapPx}px`, width: `${contentWidth}px` }}>
                  {displayedRows.map((row) => {
                    const isNegative = allowNegative && row.value < 0;
                    const upPx = !isNegative && maxPositive > 0 ? (Math.max(0, row.value) / maxPositive) * Math.max(0, topSpan) : 0;
                    const downPx = isNegative && negativeAbs > 0 ? (Math.abs(row.value) / negativeAbs) * Math.max(0, bottomSpan) : 0;
                    const barHeightPx = Math.max(row.value === 0 ? 0 : 3, isNegative ? downPx : allowNegative ? upPx : (Math.abs(row.value) / maxAbs) * plotHeight);
                    const barBottom = allowNegative ? (isNegative ? zeroFromBottom - downPx : zeroFromBottom) : 0;
                    const labelBottom = allowNegative
                      ? isNegative
                        ? Math.max(4, zeroFromBottom - downPx - 22)
                        : Math.min(plotHeight + 6, zeroFromBottom + upPx + 8)
                      : Math.min(plotHeight + 6, barHeightPx + 8);
                    const barColor = isNegative
                      ? "bg-gradient-to-t from-rose-700 to-rose-400"
                      : chartTone === "rose"
                        ? "bg-gradient-to-t from-emerald-700 to-emerald-400"
                        : "bg-gradient-to-t from-cyan-700 to-sky-400";
                    return (
                      <div key={`${title}-bar-${row.label}`} className="group relative h-full flex-none" style={{ width: `${columnWidthPx}px` }}>
                        <span
                          className="absolute left-1/2 z-10 -translate-x-1/2 rounded-md bg-white/90 px-1 py-0.5 text-[9px] font-semibold leading-none text-slate-700 opacity-80 shadow-sm ring-1 ring-slate-200 transition group-hover:opacity-100"
                          style={{ bottom: `${labelBottom}px` }}
                          title={`${row.label}: ${formatUsd(row.value)}`}
                        >
                          {formatUsdCompact(row.value)}
                        </span>
                        <div
                          className={`absolute left-1/2 w-[72%] -translate-x-1/2 rounded-t-lg shadow-sm transition group-hover:w-[82%] group-hover:brightness-110 ${barColor}`}
                          style={{ height: `${barHeightPx}px`, bottom: `${barBottom}px` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="absolute left-3 right-3" style={{ bottom: "8px" }}>
                  <div className="flex" style={{ gap: `${columnGapPx}px`, width: `${contentWidth}px` }}>
                    {displayedRows.map((row, index) => {
                      const showAxisLabel = index % labelEvery === 0 || index === displayedRows.length - 1;
                      return (
                        <div key={`${title}-axis-${row.label}`} className="relative flex-none" style={{ width: `${columnWidthPx}px`, height: `${axisLabelHeight - 10}px` }}>
                          {showAxisLabel ? (
                            <span
                              className="absolute left-1/2 top-1 block w-[86px] -translate-x-1/2 truncate rounded-full bg-slate-100 px-2 py-1 text-center text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200"
                              title={row.label}
                            >
                              {row.label}
                            </span>
                          ) : (
                            <span className="absolute left-1/2 top-1 h-1 w-1 -translate-x-1/2 rounded-full bg-slate-300" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {rows.length > maxItems ? (
          <p className="mt-2 text-[11px] text-slate-500">Showing last {maxItems} periods. Use Expand or zoom for denser histories.</p>
        ) : null}
      </div>
    </div>
  );

  return (
    <article className="rounded-3xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-200/70">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-700">{title}</h3>
          <p className="mt-1 text-xs text-slate-400">{displayedRows.length} periods - scroll horizontally for history</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 p-1" title="Horizontal zoom changes bar width and spacing.">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Width</span>
            <button type="button" className="rounded-full px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-white" onClick={() => setZoomX((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>-</button>
            <span className="min-w-10 text-center text-[10px] font-semibold text-slate-400">{Math.round(zoomX * 100)}%</span>
            <button type="button" className="rounded-full px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-white" onClick={() => setZoomX((z) => Math.min(2.6, +(z + 0.2).toFixed(1)))}>+</button>
          </div>
          <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 p-1" title="Vertical zoom changes chart height.">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Height</span>
            <button type="button" className="rounded-full px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-white" onClick={() => setZoomY((z) => Math.max(0.7, +(z - 0.2).toFixed(1)))}>-</button>
            <span className="min-w-10 text-center text-[10px] font-semibold text-slate-400">{Math.round(zoomY * 100)}%</span>
            <button type="button" className="rounded-full px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-white" onClick={() => setZoomY((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))}>+</button>
          </div>
          <button type="button" className="rounded-full bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700" onClick={() => setExpanded(true)}>Expand</button>
        </div>
      </div>
      {displayedRows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No data for this period.</p>
      ) : (
        chartBody(false)
      )}
      {expanded ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onClick={() => setExpanded(false)}>
          <div className="max-h-[92vh] w-[96vw] overflow-auto rounded-3xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">{title}</h3>
                <p className="text-xs text-slate-500">Expanded view with the same selected granularity.</p>
              </div>
              <button className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50" onClick={() => setExpanded(false)}>Close</button>
            </div>
            {chartBody(true)}
          </div>
        </div>
      ) : null}
    </article>
  );
};

const mergeBucket = <T extends { volume: number; pnl: number; feesPaid: number; wins?: number; losses?: number; trades?: number }>(
  base: T,
  delta: T
): T => ({
  ...base,
  volume: base.volume + delta.volume,
  pnl: base.pnl + delta.pnl,
  feesPaid: base.feesPaid + delta.feesPaid,
  wins: (base.wins ?? 0) + (delta.wins ?? 0),
  losses: (base.losses ?? 0) + (delta.losses ?? 0),
  trades: (base.trades ?? 0) + (delta.trades ?? 0),
});

const mergeVolumeRows = (
  base: Array<{ period: string; volume: number }>,
  delta: Array<{ period: string; volume: number }>
) => {
  const byPeriod = new Map<string, { period: string; volume: number }>();
  for (const row of base) byPeriod.set(row.period, { ...row });
  for (const row of delta) {
    const current = byPeriod.get(row.period) ?? { period: row.period, volume: 0 };
    current.volume += row.volume;
    byPeriod.set(row.period, current);
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
};

const mergeVolumePnlRows = (
  base: Array<{ period: string; volume: number; pnl: number }>,
  delta: Array<{ period: string; volume: number; pnl: number }>
) => {
  const byPeriod = new Map<string, { period: string; volume: number; pnl: number }>();
  for (const row of base) byPeriod.set(row.period, { ...row });
  for (const row of delta) {
    const current = byPeriod.get(row.period) ?? { period: row.period, volume: 0, pnl: 0 };
    current.volume += row.volume;
    current.pnl += row.pnl;
    byPeriod.set(row.period, current);
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
};

const mergeTradingData = (base: TradingData, delta: TradingData): TradingData => {
  const outcomes = mergeBucket(base.totals.outcomes, delta.totals.outcomes);
  const xyz = mergeBucket(base.totals.xyz, delta.totals.xyz);
  const perps = mergeBucket(base.totals.perps, delta.totals.perps);
  const winrate = (bucket: { wins?: number; losses?: number }) => {
    const closed = (bucket.wins ?? 0) + (bucket.losses ?? 0);
    return closed > 0 ? ((bucket.wins ?? 0) / closed) * 100 : 0;
  };
  const mergeByGranularity = <T extends "outcomes" | "xyz" | "perps">(key: T) => ({
    day: mergeVolumePnlRows(base.charts[key].day, delta.charts[key].day),
    week: mergeVolumePnlRows(base.charts[key].week, delta.charts[key].week),
    month: mergeVolumePnlRows(base.charts[key].month, delta.charts[key].month),
    year: mergeVolumePnlRows(base.charts[key].year, delta.charts[key].year),
  });
  const mergeVolumeGranularity = <T extends "spot" | "unit">(key: T) => ({
    day: mergeVolumeRows(base.charts[key].day, delta.charts[key].day),
    week: mergeVolumeRows(base.charts[key].week, delta.charts[key].week),
    month: mergeVolumeRows(base.charts[key].month, delta.charts[key].month),
    year: mergeVolumeRows(base.charts[key].year, delta.charts[key].year),
  });

  return {
    ...base,
    meta: {
      ...delta.meta,
      warnings: [...(base.meta?.warnings ?? []), ...(delta.meta?.warnings ?? [])],
      apiScan: delta.meta?.apiScan
        ? {
            ...delta.meta.apiScan,
            cachedFills: base.totals.fills + delta.totals.fills,
            statelessDelta: false,
          }
        : base.meta?.apiScan,
    },
    totals: {
      ...base.totals,
      fills: base.totals.fills + delta.totals.fills,
      outcomes,
      xyz,
      perps,
      spotVolume: base.totals.spotVolume + delta.totals.spotVolume,
      spotFeesPaid: base.totals.spotFeesPaid + delta.totals.spotFeesPaid,
      unitVolume: base.totals.unitVolume + delta.totals.unitVolume,
      unitFeesPaid: base.totals.unitFeesPaid + delta.totals.unitFeesPaid,
      unitTrades: base.totals.unitTrades + delta.totals.unitTrades,
      unitTokens: [...new Set([...base.totals.unitTokens, ...delta.totals.unitTokens])].sort(),
      totalVolume: base.totals.totalVolume + delta.totals.totalVolume,
    },
    winrates: {
      outcomes: winrate(outcomes),
      xyz: winrate(xyz),
      perps: winrate(perps),
    },
    charts: {
      outcomes: mergeByGranularity("outcomes"),
      xyz: mergeByGranularity("xyz"),
      perps: mergeByGranularity("perps"),
      spot: mergeVolumeGranularity("spot"),
      unit: mergeVolumeGranularity("unit"),
      spotTwab: base.charts.spotTwab,
    },
  };
};
export default function Home({ initialAddress = "" }: { initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [activeTab, setActiveTab] = useState<TabKey>("trading");
  const [histGranularity, setHistGranularity] = useState<HistogramGranularity>("day");
  const [loadingApi, setLoadingApi] = useState(false);
  const [loadingTrading, setLoadingTrading] = useState(false);
  const [loadingHevm, setLoadingHevm] = useState(false);
  const [loadingUnitBridge, setLoadingUnitBridge] = useState(false);
  const [loadingContinueApi, setLoadingContinueApi] = useState(false);
  const [apiScanMessage, setApiScanMessage] = useState("");
  const [error, setError] = useState("");
  const [apiScanProgress, setApiScanProgress] = useState<ApiScanProgress | null>(null);
  const [apiScanStartedAt, setApiScanStartedAt] = useState<number | null>(null);
  const [apiScanElapsedMs, setApiScanElapsedMs] = useState(0);
  const [autoContinueApi, setAutoContinueApi] = useState(false);
  const [autoContinueKick, setAutoContinueKick] = useState(0);
  const [autoScanComplete, setAutoScanComplete] = useState(false);
  const [autoScanBlocked, setAutoScanBlocked] = useState(false);
  const apiScanIdRef = useRef(createApiScanId());
  const autoScanCompleteRef = useRef(false);
  const autoScanBlockedRef = useRef(false);
  const autoContinueRequestedRef = useRef(false);
  const autoContinueInFlightRef = useRef(false);
  const autoContinueRetryCountRef = useRef(0);
  const autoContinueSessionRetryCountRef = useRef(0);

  const setActiveApiScanId = useCallback((nextScanId: string) => {
    apiScanIdRef.current = nextScanId;
  }, []);

  const setAutoScanCompleteState = useCallback((complete: boolean) => {
    autoScanCompleteRef.current = complete;
    setAutoScanComplete(complete);
  }, []);

  const setAutoScanBlockedState = useCallback((blocked: boolean) => {
    autoScanBlockedRef.current = blocked;
    setAutoScanBlocked(blocked);
  }, []);

  const [trading, setTrading] = useState<TradingData | null>(null);
  const [hevm, setHevm] = useState<HevmData | null>(null);
  const [unitBridge, setUnitBridge] = useState<UnitBridgeData | null>(null);

  const tradingWarnings = useMemo(() => trading?.meta?.warnings ?? [], [trading]);
  const hevmWarnings = useMemo(() => hevm?.meta?.warnings ?? [], [hevm]);
  const unitWarnings = useMemo(() => unitBridge?.meta?.warnings ?? [], [unitBridge]);
  const walletAgeDays = hevm?.stats?.sinceFirstTx?.days ?? null;
  const trimmedAddress = address.trim();
  const sharePath = trimmedAddress ? `/wallet/${encodeURIComponent(trimmedAddress)}` : "";
  const canContinueApiScan = Boolean(
    address.trim() &&
      (trading?.meta?.apiScan?.canContinue || apiScanProgress?.canContinue) &&
      !autoScanComplete &&
      !loadingTrading &&
      !loadingContinueApi
  );
  const displayedScanFills = Math.max(
    apiScanProgress?.fills ?? 0,
    trading?.meta?.apiScan?.cachedFills ?? 0,
    trading?.totals.fills ?? 0
  );
  const displayedPendingWindows = apiScanProgress?.pendingWindows ?? trading?.meta?.apiScan?.pendingWindows ?? 0;
  const displayedRequestsUsed = apiScanProgress?.requestsUsed ?? 0;
  const scanIsActive = loadingTrading || loadingContinueApi || Boolean(apiScanProgress?.inProgress);
  const autoScanWaitingForNextRun = autoContinueApi && canContinueApiScan && !autoScanComplete && !autoScanBlocked;
  const tabStates: Record<TabKey, { loading: boolean; loaded: boolean }> = {
    trading: { loading: loadingTrading || loadingContinueApi || autoScanWaitingForNextRun, loaded: Boolean(trading) && !autoScanWaitingForNextRun },
    hevm: { loading: loadingHevm, loaded: Boolean(hevm) },
    unit: { loading: loadingUnitBridge, loaded: Boolean(unitBridge) },
  };

  const refreshApiScanProgress = useCallback(async (scanIdOverride?: string) => {
    const wallet = address.trim();
    if (!wallet) return;
    try {
      const params = new URLSearchParams({
        address: wallet,
        scanId: scanIdOverride ?? apiScanIdRef.current,
      });
      const response = await fetch(`/api/dashboard/trading/progress?${params.toString()}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as ApiScanProgress;
      setApiScanProgress(payload);
    } catch {
      // Progress polling is best-effort; the main request still owns the final result.
    }
  }, [address]);

  useEffect(() => {
    if (!apiScanStartedAt || !scanIsActive) return;
    const timer = window.setInterval(() => {
      setApiScanElapsedMs(Date.now() - apiScanStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [apiScanStartedAt, scanIsActive]);

  useEffect(() => {
    if (!scanIsActive) return;
    const immediate = window.setTimeout(() => {
      void refreshApiScanProgress();
    }, 0);
    const timer = window.setInterval(() => {
      void refreshApiScanProgress();
    }, 1500);
    return () => {
      window.clearTimeout(immediate);
      window.clearInterval(timer);
    };
  }, [scanIsActive, refreshApiScanProgress]);

  const runAnalyzeApi = async (enableAutoContinue: boolean) => {
    setLoadingApi(true);
    setLoadingTrading(true);
    setLoadingHevm(true);
    setLoadingUnitBridge(true);
    setError("");
    setApiScanMessage("");
    setApiScanProgress(null);
    setTrading(null);
    setHevm(null);
    setUnitBridge(null);
    autoContinueRequestedRef.current = enableAutoContinue;
    autoContinueRetryCountRef.current = 0;
    autoContinueSessionRetryCountRef.current = 0;
    setAutoScanCompleteState(false);
    setAutoScanBlockedState(false);
    setAutoContinueKick(0);
    setAutoContinueApi(enableAutoContinue);
    const nextScanId = createApiScanId();
    setActiveApiScanId(nextScanId);
    const startedAt = Date.now();
    setApiScanStartedAt(startedAt);
    setApiScanElapsedMs(0);

    const appendError = (message: string) => {
      setError((current) => (current ? `${current} ${message}` : message));
    };

    const params = new URLSearchParams({
      address: address.trim(),
      scanId: nextScanId,
    });

    const safeCall = async (url: string) => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, payload };
      } catch (e) {
        return { ok: false, payload: { error: e instanceof Error ? e.message : "Network error." } };
      }
    };

    const tradingTask = safeCall(`/api/dashboard/trading?${params.toString()}`)
      .then((tradingRes) => {
        if (tradingRes.ok) {
          const nextTrading = tradingRes.payload as TradingData;
          setTrading(nextTrading);
          if (enableAutoContinue && nextTrading.meta?.apiScan?.canContinue) {
            setApiScanMessage("Auto continuing is enabled. Next continuation starts in a few seconds.");
            setAutoContinueKick((value) => value + 1);
          }
        } else {
          setAutoScanBlockedState(true);
          setApiScanMessage("Auto scan paused because Hyperliquid trading stats returned an error. You can retry manually with Continue API scan.");
          const message = (tradingRes.payload as { error?: string }).error ?? "Trading API failed.";
          appendError(`Hyperliquid trading stats failed: ${message}. HEVM and Unit Bridge sections may still be available.`);
        }
      })
      .finally(() => {
        setLoadingTrading(false);
      });

    const hevmTask = safeCall(`/api/dashboard/hevm?address=${encodeURIComponent(address.trim())}`)
      .then((hevmRes) => {
        if (hevmRes.ok) {
          setHevm(hevmRes.payload as HevmData);
        } else {
          appendError(`HEVM stats failed: ${(hevmRes.payload as { error?: string }).error ?? "HEVM API failed."}`);
        }
      })
      .finally(() => {
        setLoadingHevm(false);
      });

    const unitTask = safeCall(`/api/dashboard/unit-bridge?address=${encodeURIComponent(address.trim())}`)
      .then((unitRes) => {
        if (unitRes.ok) {
          setUnitBridge(unitRes.payload as UnitBridgeData);
        } else {
          appendError(`Unit Bridge stats failed: ${(unitRes.payload as { error?: string }).error ?? "Unit bridge API failed."}`);
        }
      })
      .finally(() => {
        setLoadingUnitBridge(false);
      });

    try {
      await Promise.allSettled([tradingTask, hevmTask, unitTask]);
    } finally {
      setLoadingApi(false);
      setApiScanElapsedMs(Date.now() - startedAt);
      void refreshApiScanProgress(nextScanId);
    }
  };

  const onAnalyzeApi = async (event: FormEvent) => {
    event.preventDefault();
    await runAnalyzeApi(false);
  };

  const onCompleteAnalyzeApi = async () => {
    await runAnalyzeApi(true);
  };

  const onContinueApiScan = useCallback(async (options?: { automatic?: boolean }) => {
    if (autoScanCompleteRef.current) return;
    if (options?.automatic && autoScanBlockedRef.current) return;
    if (options?.automatic && autoContinueInFlightRef.current) return;
    autoContinueInFlightRef.current = true;
    setLoadingContinueApi(true);
    setError("");
    setApiScanMessage("Continuing Hyperliquid API scan from the remaining time windows...");
    const startedAt = Date.now();
    const currentScanId = apiScanIdRef.current;
    setApiScanStartedAt(startedAt);
    setApiScanElapsedMs(0);

    try {
      const response = await fetch("/api/dashboard/trading", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        body: JSON.stringify({
          address: address.trim(),
          continueScan: true,
          scanId: currentScanId,
          pendingWindows: trading?.meta?.apiScan?.pendingWindowsDetail ?? apiScanProgress?.pendingWindowsDetail ?? [],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = (payload as { error?: string }).error ?? "Continue API scan failed.";
        if (errorMessage.includes("already complete")) {
          setAutoContinueApi(false);
          autoContinueRequestedRef.current = false;
          setAutoScanCompleteState(true);
          setApiScanMessage("Auto scan complete. No remaining time windows to continue.");
          return;
        }
        if (errorMessage.includes("continuation state is unavailable")) {
          if (options?.automatic && autoContinueRequestedRef.current && trading?.meta?.apiScan?.canContinue) {
            autoContinueSessionRetryCountRef.current += 1;
            if (autoContinueSessionRetryCountRef.current >= 20) {
              setAutoScanBlockedState(true);
              setApiScanMessage(`${errorMessage} Auto scan paused after 20 session retries.`);
              return;
            }
            setApiScanMessage(
              `${errorMessage} Auto scan is waiting for the scan session and will retry (${autoContinueSessionRetryCountRef.current}/20).`
            );
            setAutoContinueKick((value) => value + 1);
            return;
          }
          setAutoScanBlockedState(true);
          setApiScanMessage(`${errorMessage} Auto scan paused to avoid restarting from zero.`);
          return;
        }
        if (options?.automatic && autoContinueRequestedRef.current && trading?.meta?.apiScan?.canContinue) {
          autoContinueRetryCountRef.current += 1;
          if (autoContinueRetryCountRef.current >= 3) {
            setAutoScanBlockedState(true);
            setApiScanMessage(`${errorMessage} Auto scan paused after 3 temporary retries.`);
            return;
          }
          setApiScanMessage(`${errorMessage} Auto scan will retry in a few seconds (${autoContinueRetryCountRef.current}/3).`);
          return;
        }
        setAutoScanBlockedState(true);
        setApiScanMessage(errorMessage);
        return;
      }

      const responseTrading = payload as TradingData;
      const nextTrading =
        responseTrading.meta?.apiScan?.statelessDelta && trading ? mergeTradingData(trading, responseTrading) : responseTrading;
      const previousFills = trading?.totals.fills ?? 0;
      if (nextTrading.totals.fills < previousFills) {
        if (options?.automatic && autoContinueRequestedRef.current && trading?.meta?.apiScan?.canContinue) {
          autoContinueRetryCountRef.current += 1;
          if (autoContinueRetryCountRef.current >= 3) {
            setAutoScanBlockedState(true);
            setApiScanMessage(
              `Auto scan paused after 3 temporary retries because continuations kept returning fewer fills than the current dashboard. Current results were kept.`
            );
            return;
          }
          setApiScanMessage(
            `Temporary continuation returned fewer fills (${formatNum(nextTrading.totals.fills)}) than the current dashboard (${formatNum(previousFills)}). Current results were kept and auto scan will retry in a few seconds (${autoContinueRetryCountRef.current}/3).`
          );
          return;
        }
        setAutoScanBlockedState(true);
        setApiScanMessage(
          `Auto scan paused because the continuation returned fewer fills (${formatNum(nextTrading.totals.fills)}) than the current dashboard (${formatNum(previousFills)}). Current results were kept.`
        );
        return;
      }
      setTrading(nextTrading);
      autoContinueRetryCountRef.current = 0;
      autoContinueSessionRetryCountRef.current = 0;
      if (nextTrading.meta?.apiScan?.canContinue) {
        setAutoScanBlockedState(false);
        setAutoContinueKick((value) => value + 1);
        setApiScanMessage(
          `API scan continued: ${formatNum(nextTrading.totals.fills)} fills recovered (${formatNum(Math.max(0, nextTrading.totals.fills - previousFills))} new). ${nextTrading.meta.apiScan.pendingWindows} time windows remain.`
        );
      } else if (nextTrading.meta?.apiScan?.complete) {
        setAutoContinueApi(false);
        autoContinueRequestedRef.current = false;
        setAutoScanCompleteState(true);
        setApiScanProgress((current) =>
          current
            ? {
                ...current,
                complete: true,
                canContinue: false,
                pendingWindows: 0,
                inProgress: false,
              }
            : current
        );
        setApiScanMessage(
          `Auto scan complete. All available Hyperliquid API fills were recovered: ${formatNum(nextTrading.totals.fills)} fills total (${formatNum(Math.max(0, nextTrading.totals.fills - previousFills))} new in the last scan).`
        );
      } else {
        setAutoScanBlockedState(true);
        setApiScanMessage(
          `Auto scan paused: the API scan is partial but no safe continuation window is available. Current results were kept: ${formatNum(nextTrading.totals.fills)} fills.`
        );
      }
    } catch {
      if (options?.automatic) {
        autoContinueRetryCountRef.current += 1;
        if (autoContinueRetryCountRef.current >= 3) {
          setAutoScanBlockedState(true);
          setApiScanMessage("Continue API scan failed. Auto scan paused after 3 temporary retries.");
        } else {
          setApiScanMessage(
            `Continue API scan failed. Current dashboard data is still displayed and auto scan will retry in a few seconds (${autoContinueRetryCountRef.current}/3).`
          );
        }
      } else {
        setApiScanMessage("Continue API scan failed. Current dashboard data is still displayed.");
      }
    } finally {
      autoContinueInFlightRef.current = false;
      setLoadingContinueApi(false);
      setApiScanElapsedMs(Date.now() - startedAt);
      void refreshApiScanProgress(currentScanId);
    }
  }, [
    address,
    apiScanProgress?.pendingWindowsDetail,
    refreshApiScanProgress,
    setAutoScanBlockedState,
    setAutoScanCompleteState,
    trading,
  ]);

  useEffect(() => {
    if (
      autoContinueKick <= 0 ||
      autoScanComplete ||
      autoScanBlocked ||
      !autoContinueApi ||
      !canContinueApiScan ||
      autoContinueInFlightRef.current
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (!autoContinueRequestedRef.current || autoContinueInFlightRef.current) return;
      void onContinueApiScan({ automatic: true });
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [autoContinueApi, autoContinueKick, autoScanBlocked, autoScanComplete, canContinueApiScan, onContinueApiScan]);

  const isLoading = loadingApi || loadingContinueApi;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-8 md:px-8">
      <header className="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Portfolio Analytics</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">Hyperliquid Viewer</h1>
          </div>
          <Link
            href="/details"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Details
          </Link>
        </div>
      </header>

      <form
        onSubmit={onAnalyzeApi}
        className="grid gap-3 rounded-3xl border border-white/70 bg-white/80 p-5 shadow-sm lg:grid-cols-[3fr_1fr]"
      >
        <input
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 outline-none ring-sky-300 focus:ring"
          placeholder="EVM wallet address 0x..."
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          required
        />
        <div className="flex flex-col gap-1">
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-xl bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
          >
            {loadingApi && !autoContinueApi ? "Loading API..." : "Quick Analyze via API"}
          </button>
          <button
            type="button"
            disabled={isLoading || !address.trim()}
            onClick={onCompleteAnalyzeApi}
            className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 font-medium text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-60"
          >
            {loadingApi && autoContinueApi ? "Starting complete scan..." : "Complete Analyze via API"}
          </button>
          {sharePath ? (
            <Link href={sharePath} className="text-[11px] font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900">
              Shareable link
            </Link>
          ) : null}
        </div>
      </form>

      {(trading || scanIsActive || apiScanMessage) ? (
        <section className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-700">
                Active source: {trading?.meta?.dataSourceLabel ?? (trading?.source === "full_export" ? "Full history export" : "Hyperliquid API")}
              </p>
              <p>Standard Hyperliquid API is the primary source. HL-Viewer splits requests by time to recover as many fills as possible.</p>
              <p className="text-slate-500">
                API scan status: {trading?.meta?.apiScan?.complete || apiScanProgress?.complete ? "complete" : "partial"} - {formatNum(displayedScanFills)} fills cached
                {displayedPendingWindows > 0 ? ` - ${displayedPendingWindows} windows remaining` : ""}
                {displayedRequestsUsed > 0 ? ` - ${displayedRequestsUsed} requests in current run` : ""}
                {apiScanStartedAt ? ` - ${formatDuration(apiScanElapsedMs)}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={autoContinueApi}
                  onChange={(event) => {
                    autoContinueRequestedRef.current = event.target.checked;
                    setAutoContinueApi(event.target.checked);
                    if (event.target.checked) setAutoScanBlockedState(false);
                  }}
                  className="h-4 w-4"
                />
                Auto continuing
              </label>
              <button
                type="button"
                disabled={!canContinueApiScan}
                onClick={() => void onContinueApiScan()}
                className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
              >
                {loadingContinueApi ? "Continuing API scan..." : "Continue API scan"}
              </button>
            </div>
          </div>
          {apiScanMessage ? (
            <div
              className={`mt-3 flex items-center gap-3 rounded-xl px-3 py-2 ${
                apiScanMessage.includes("failed")
                  ? "bg-red-50 text-red-700"
                  : apiScanMessage.includes("Auto scan complete")
                    ? "border border-emerald-200 bg-emerald-50 text-base font-semibold text-emerald-800"
                  : loadingContinueApi && apiScanMessage.includes("Continuing Hyperliquid API scan")
                    ? "bg-emerald-50 text-sm font-semibold text-emerald-800"
                    : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {loadingContinueApi && apiScanMessage.includes("Continuing Hyperliquid API scan") ? (
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-700" />
              ) : null}
              {apiScanMessage.includes("Auto scan complete") ? (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
                  ✓
                </span>
              ) : null}
              <p>{apiScanMessage}</p>
            </div>
          ) : null}
          {autoContinueApi && canContinueApiScan && !loadingContinueApi ? (
            <p className="mt-2 text-emerald-700">Auto continuing is enabled. Next continuation starts in a few seconds.</p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-white/60 bg-white/50 px-4 py-3 text-xs text-slate-500">
        <p>Thank you for your support.</p>
        <p>
          HL ref link :{" "}
          <a
            href="https://app.hyperliquid.xyz/join/MAITRESARCE"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-slate-700"
          >
            https://app.hyperliquid.xyz/join/MAITRESARCE
          </a>
        </p>
        <p>EVM address : 0xCc8A2E7E279C10c6D740Eb0b27D1993F10437335</p>
        <p>BTC address : bc1qlknx6s5xpahym2t5jj2tt50x62rp4trt5qurz7</p>
      </section>

      <nav className="flex flex-wrap gap-2">
        {[
          { id: "trading", label: "Trading" },
          { id: "hevm", label: "HEVM" },
          { id: "unit", label: "Unit Bridge" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id as TabKey)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id
                ? "bg-slate-900 text-white"
                : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span className="flex items-center gap-2">
              <span>{tab.label}</span>
              {tabStates[tab.id as TabKey].loading ? (
                <span
                  aria-label={`${tab.label} loading`}
                  className={`h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 ${
                    activeTab === tab.id ? "border-white/30 border-t-white" : "border-slate-200 border-t-slate-700"
                  }`}
                />
              ) : tabStates[tab.id as TabKey].loaded ? (
                <span
                  aria-label={`${tab.label} loaded`}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white"
                >
                  ✓
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </nav>

      {error ? <p className="rounded-xl bg-red-50 px-4 py-3 text-red-700">{error}</p> : null}
      <div className="flex items-center gap-2">
        {([
          { id: "day", label: "Day" },
          { id: "week", label: "Week" },
          { id: "month", label: "Month" },
          { id: "year", label: "Year" },
        ] as const).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setHistGranularity(option.id)}
            className={`rounded-lg px-3 py-1 text-xs font-medium ${
              histGranularity === option.id
                ? "bg-slate-900 text-white"
                : "border border-slate-300 bg-white text-slate-700"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {activeTab === "trading" ? (
        <section className="space-y-4">
          {trading ? (
            <>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <ZoneCard
                  title="Outcomes"
                  rows={[
                    { label: "Volume", value: formatUsd(trading.totals.outcomes.volume) },
                    { label: "PVL", value: formatUsd(trading.totals.outcomes.pnl) },
                    { label: "Fees paid", value: formatUsd(trading.totals.outcomes.feesPaid) },
                    { label: "Winrate", value: formatPct(trading.winrates.outcomes) },
                  ]}
                />
                <ZoneCard
                  title="XYZ"
                  rows={[
                    { label: "Volume", value: formatUsd(trading.totals.xyz.volume) },
                    { label: "PVL", value: formatUsd(trading.totals.xyz.pnl) },
                    { label: "Fees paid", value: formatUsd(trading.totals.xyz.feesPaid) },
                    { label: "Winrate", value: formatPct(trading.winrates.xyz) },
                  ]}
                />
                <ZoneCard
                  title="Perps"
                  rows={[
                    { label: "Volume", value: formatUsd(trading.totals.perps.volume) },
                    { label: "PVL", value: formatUsd(trading.totals.perps.pnl) },
                    { label: "Fees paid", value: formatUsd(trading.totals.perps.feesPaid) },
                    { label: "Winrate", value: formatPct(trading.winrates.perps) },
                  ]}
                />
                <ZoneCard
                  title="Spot"
                  rows={[
                    { label: "Volume", value: formatUsd(trading.totals.spotVolume) },
                    { label: "Fees paid", value: formatUsd(trading.totals.spotFeesPaid) },
                    {
                      label: "TWAB (USD)",
                      value: formatTwabWithAge(trading.totals.spotTwab, walletAgeDays, "usd"),
                    },
                    {
                      label: "Vault TWAB (USD)",
                      value: formatTwabWithAge(trading.totals.vaultTwab, walletAgeDays, "usd"),
                    },
                    {
                      label: "HYPE Staking TWAB",
                      value: formatTwabWithAge(trading.totals.hypeStakingTwab, walletAgeDays, "raw"),
                    },
                  ]}
                />
                <ZoneCard
                  title="Unit"
                  rows={[
                    { label: "Volume (Unit assets)", value: formatUsd(trading.totals.unitVolume) },
                    { label: "Fees paid", value: formatUsd(trading.totals.unitFeesPaid) },
                    {
                      label: "TWAB (USD)",
                      value: formatTwabWithAge(trading.totals.unitTwab, walletAgeDays, "usd"),
                    },
                    { label: "Trades", value: formatNum(trading.totals.unitTrades) },
                    { label: "Tokens", value: trading.totals.unitTokens.join(", ") || "N/A" },
                  ]}
                />
                <ZoneCard
                  title="Total"
                  rows={[
                    { label: "Volume total (perps + spot + outcomes)", value: formatUsd(trading.totals.totalVolume) },
                    { label: "Fills counted", value: formatNum(trading.totals.fills) },
                  ]}
                />
              </div>
              <p className="text-xs text-slate-500">
                TWAB legend: the value in parentheses is `TWAB x wallet age (days)`.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <HistogramCard
                  title={`Outcomes Volume (${histGranularity})`}
                  rows={trading.charts.outcomes[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
                <HistogramCard
                  title={`Outcomes PNL (${histGranularity})`}
                  allowNegative
                  rows={trading.charts.outcomes[histGranularity].map((row) => ({ label: row.period, value: row.pnl }))}
                />
                <HistogramCard
                  title={`XYZ Volume (${histGranularity})`}
                  rows={trading.charts.xyz[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
                <HistogramCard
                  title={`XYZ PNL (${histGranularity})`}
                  allowNegative
                  rows={trading.charts.xyz[histGranularity].map((row) => ({ label: row.period, value: row.pnl }))}
                />
                <HistogramCard
                  title={`Perps Volume (${histGranularity})`}
                  rows={trading.charts.perps[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
                <HistogramCard
                  title={`Perps PNL (${histGranularity})`}
                  allowNegative
                  rows={trading.charts.perps[histGranularity].map((row) => ({ label: row.period, value: row.pnl }))}
                />
                <HistogramCard
                  title={`Spot Volume (${histGranularity})`}
                  rows={trading.charts.spot[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
                <HistogramCard
                  title={`Unit Asset Volume (${histGranularity})`}
                  rows={trading.charts.unit[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
              </div>
              {tradingWarnings.length > 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                  {tradingWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-white px-4 py-5 text-sm text-slate-600">
              Start with API analysis to view trading stats.
            </p>
          )}
        </section>
      ) : null}

      {activeTab === "hevm" ? (
        <section className="space-y-4">
          {hevm ? (
            <>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <ZoneCard
                  title="HEVM Activity"
                  rows={[
                    { label: "TWAB (USD)", value: formatTwabWithAge(hevm.stats.twab, walletAgeDays, "usd") },
                    { label: "Volume", value: formatUsd(hevm.stats.volume) },
                    { label: "Fees paid", value: formatUsd(hevm.stats.feesPaid) },
                    { label: "Different contracts", value: formatNum(hevm.stats.contractsCount) },
                    { label: "Different active days", value: formatNum(hevm.stats.activeDays) },
                    { label: "Different active months", value: formatNum(hevm.stats.activeMonths) },
                    {
                      label: "Since first tx",
                      value: `${hevm.stats.sinceFirstTx.days}d / ${hevm.stats.sinceFirstTx.months}m / ${hevm.stats.sinceFirstTx.years}y`,
                    },
                    { label: "Total tx (explorer-style)", value: formatNum(hevm.stats.totalTxCount) },
                    { label: "Initiated tx (wallet actions)", value: formatNum(hevm.stats.initiatedTxCount) },
                  ]}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <HistogramCard
                  title={`HEVM Volume (${histGranularity})`}
                  rows={hevm.stats.charts.volume[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
              </div>
              {hevm.meta.debug ? (
                <article className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">HEVM Debug</h3>
                  <pre className="max-h-[420px] overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">
                    {JSON.stringify(hevm.meta.debug, null, 2)}
                  </pre>
                </article>
              ) : null}
              {hevmWarnings.length > 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                  {hevmWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-white px-4 py-5 text-sm text-slate-600">
              Run API analysis to load HEVM stats.
            </p>
          )}
        </section>
      ) : null}

      {activeTab === "unit" ? (
        <section className="space-y-4">
          {unitBridge ? (
            <>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <ZoneCard
                  title="Unit Bridge"
                  rows={[
                    { label: "Volume", value: formatUsd(unitBridge.stats.volume) },
                    { label: "Different contracts", value: formatNum(unitBridge.stats.contractsCount) },
                    { label: "Different active days", value: formatNum(unitBridge.stats.activeDays) },
                    { label: "Different active months", value: formatNum(unitBridge.stats.activeMonths) },
                    { label: "Source chains", value: formatNum(unitBridge.stats.sourceChainsCount) },
                    { label: "Destination chains", value: formatNum(unitBridge.stats.destinationChainsCount) },
                    {
                      label: "Since first tx",
                      value: `${unitBridge.stats.sinceFirstTx.days}d / ${unitBridge.stats.sinceFirstTx.months}m / ${unitBridge.stats.sinceFirstTx.years}y`,
                    },
                    { label: "Number of tx", value: formatNum(unitBridge.stats.txCount) },
                  ]}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <HistogramCard
                  title={`Unit Bridge Volume (${histGranularity})`}
                  rows={unitBridge.stats.charts.volume[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
              </div>
              <p className="text-xs text-slate-500">
                Coverage mode: {unitBridge.meta.coverageMode === "cursor-paginated"
                  ? "Unit API cursor pagination (full history)"
                  : unitBridge.meta.coverageMode === "auth-range"
                    ? "Authenticated full range"
                    : "Public snapshot"}
              </p>
              {unitWarnings.length > 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                  {unitWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-white px-4 py-5 text-sm text-slate-600">
              Run API analysis to load Unit bridge stats.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
