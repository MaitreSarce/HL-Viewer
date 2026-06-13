"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";

type TradingData = {
  source: "api" | "full_export";
  totals: {
    fills: number;
    outcomes: { volume: number; pnl: number; feesPaid: number };
    xyz: { volume: number; pnl: number; feesPaid: number };
    perps: { volume: number; pnl: number; feesPaid: number };
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
export default function Home({ initialAddress = "" }: { initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [activeTab, setActiveTab] = useState<TabKey>("trading");
  const [histGranularity, setHistGranularity] = useState<HistogramGranularity>("day");
  const [loadingApi, setLoadingApi] = useState(false);
  const [loadingFullExport, setLoadingFullExport] = useState(false);
  const [fullExportMessage, setFullExportMessage] = useState("");
  const [error, setError] = useState("");

  const [trading, setTrading] = useState<TradingData | null>(null);
  const [hevm, setHevm] = useState<HevmData | null>(null);
  const [unitBridge, setUnitBridge] = useState<UnitBridgeData | null>(null);

  const tradingWarnings = useMemo(() => trading?.meta?.warnings ?? [], [trading]);
  const hevmWarnings = useMemo(() => hevm?.meta?.warnings ?? [], [hevm]);
  const unitWarnings = useMemo(() => unitBridge?.meta?.warnings ?? [], [unitBridge]);
  const walletAgeDays = hevm?.stats?.sinceFirstTx?.days ?? null;
  const trimmedAddress = address.trim();
  const sharePath = trimmedAddress ? `/wallet/${encodeURIComponent(trimmedAddress)}` : "";
  const canRequestFullExport = Boolean(trading && address.trim());

  const onAnalyzeApi = async (event: FormEvent) => {
    event.preventDefault();
    setLoadingApi(true);
    setError("");
    setFullExportMessage("");

    try {
      const params = new URLSearchParams({
        address: address.trim(),
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

      const [tradingRes, hevmRes, unitRes] = await Promise.all([
        safeCall(`/api/dashboard/trading?${params.toString()}`),
        safeCall(`/api/dashboard/hevm?address=${encodeURIComponent(address.trim())}`),
        safeCall(`/api/dashboard/unit-bridge?address=${encodeURIComponent(address.trim())}`),
      ]);

      const failures: string[] = [];

      if (tradingRes.ok) {
        setTrading(tradingRes.payload as TradingData);
      } else {
        failures.push((tradingRes.payload as { error?: string }).error ?? "Trading API failed.");
      }

      if (hevmRes.ok) {
        setHevm(hevmRes.payload as HevmData);
      } else {
        failures.push((hevmRes.payload as { error?: string }).error ?? "HEVM API failed.");
      }

      if (unitRes.ok) {
        setUnitBridge(unitRes.payload as UnitBridgeData);
      } else {
        failures.push((unitRes.payload as { error?: string }).error ?? "Unit bridge API failed.");
      }

      if (failures.length > 0) {
        setError(failures.join(" "));
      }
    } catch {
      setError("Unable to load dashboard data.");
    } finally {
      setLoadingApi(false);
    }
  };

  const onFetchFullHistory = async () => {
    setLoadingFullExport(true);
    setError("");
    setFullExportMessage(
      "Full history export in progress. This can take a few minutes for active wallets. Please keep this page open."
    );

    try {
      const response = await fetch("/api/dashboard/trading-full", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        body: JSON.stringify({ address: address.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = (payload as { error?: string }).error ?? "Full history export failed.";
        setFullExportMessage(message);
        return;
      }
      setTrading(payload as TradingData);
      setFullExportMessage("Full history export loaded. Complete trading history is now used for fill-based stats.");
    } catch {
      setFullExportMessage("Full history export failed. Standard Hyperliquid API data is still displayed.");
    } finally {
      setLoadingFullExport(false);
    }
  };

  const isLoading = loadingApi || loadingFullExport;

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
            {loadingApi ? "Loading API..." : "Analyze via API"}
          </button>
          <p className="text-[11px] text-amber-700">Warning: API trading stats count up to the most recent 10,000 fills.</p>
          {sharePath ? (
            <Link href={sharePath} className="text-[11px] font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900">
              Shareable link
            </Link>
          ) : null}
        </div>
      </form>

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
            {tab.label}
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
              <p className="text-sm text-slate-600">
                Active source: {trading.meta?.dataSourceLabel ?? (trading.source === "full_export" ? "Full history export" : "Hyperliquid API")}
              </p>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm">
                {trading.source === "full_export" ? (
                  <p className="font-medium text-emerald-700">Full history export loaded. Fill-based trading stats use the complete exported history.</p>
                ) : (
                  <div className="space-y-2">
                    <p>
                      Standard Hyperliquid API is fast, but it only exposes the 10,000 most recent fills. If this wallet is very active,
                      older trades may be missing from fill-based stats.
                    </p>
                    <p className="text-slate-500">
                      Full history export is limited to one request per wallet/user per UTC day. If the daily quota is reached, the app keeps
                      showing standard API data and explains when to retry.
                    </p>
                    <button
                      type="button"
                      disabled={!canRequestFullExport || loadingFullExport}
                      onClick={onFetchFullHistory}
                      className="rounded-xl bg-sky-700 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-600 disabled:opacity-60"
                    >
                      {loadingFullExport ? "Fetching full history..." : "Fetch full history"}
                    </button>
                  </div>
                )}
                {fullExportMessage ? (
                  <p className={`mt-2 ${fullExportMessage.includes("limit reached") || fullExportMessage.includes("failed") ? "text-red-700" : "text-sky-700"}`}>
                    {fullExportMessage}
                  </p>
                ) : null}
              </div>
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
