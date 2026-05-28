"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";

type TradingData = {
  source: "api";
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
    bridgeVolume: number;
    totalTxCount: number;
    initiatedTxCount: number;
    dedupedTxCount: number;
    charts: {
      volume: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
      twab: Record<"day" | "week" | "month" | "year", Array<{ period: string; twab: number }>>;
    };
  };
  meta: {
    warnings: string[];
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
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const max = rows.reduce((acc, row) => (Math.abs(row.value) > acc ? Math.abs(row.value) : acc), 0);
  const maxItems = 48;
  const displayedRows = rows.length > maxItems ? rows.slice(rows.length - maxItems) : rows;
  const columnWidthPx = 44;
  const chartHeight = Math.round(220 * zoom);
  const plotHeight = chartHeight - 26;
  const minWidth = Math.max(520, Math.round(displayedRows.length * columnWidthPx * zoom));
  const maxPositive = displayedRows.reduce((acc, row) => (row.value > acc ? row.value : acc), 0);
  const minNegative = displayedRows.reduce((acc, row) => (row.value < acc ? row.value : acc), 0);
  const negativeAbs = Math.abs(minNegative);
  const zeroFromBottom =
    allowNegative
      ? maxPositive > 0 && negativeAbs > 0
        ? (negativeAbs / (maxPositive + negativeAbs)) * plotHeight
        : maxPositive > 0
          ? 0
          : plotHeight
      : 0;
  const topSpan = allowNegative ? plotHeight - zeroFromBottom : plotHeight;
  const bottomSpan = allowNegative ? zeroFromBottom : 0;
  const chartBody = (
    <div className="space-y-2">
      <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2">
        <div className="flex gap-2">
          <div className="flex w-14 flex-col justify-between text-right text-[10px] text-slate-500">
            <span>{formatUsdCompact(max)}</span>
            <span>{formatUsdCompact(max * 0.66)}</span>
            <span>{formatUsdCompact(max * 0.33)}</span>
            <span>$0</span>
          </div>
          <div className="overflow-x-auto">
            <div className="relative" style={{ minWidth: `${minWidth}px` }}>
              <div className="relative flex items-end gap-1 border-b border-l border-slate-300 px-2 pb-1" style={{ height: `${chartHeight}px` }}>
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute left-0 right-0 top-[33%] border-t border-dashed border-slate-200" />
                  <div className="absolute left-0 right-0 top-[66%] border-t border-dashed border-slate-200" />
                  {allowNegative ? <div className="absolute left-0 right-0 border-t-2 border-slate-300" style={{ bottom: `${zeroFromBottom}px` }} /> : null}
                </div>
                {displayedRows.map((row) => {
                  const upPx = allowNegative
                    ? row.value >= 0 && maxPositive > 0
                      ? (row.value / maxPositive) * Math.max(0, topSpan)
                      : 0
                    : max > 0
                      ? (Math.abs(row.value) / max) * plotHeight
                      : 0;
                  const downPx = allowNegative && row.value < 0 && negativeAbs > 0
                    ? (Math.abs(row.value) / negativeAbs) * Math.max(0, bottomSpan)
                    : 0;
                  const barHeightPx = allowNegative ? (row.value >= 0 ? upPx : downPx) : upPx;
                  const labelBottom = allowNegative
                    ? row.value >= 0
                      ? zeroFromBottom + upPx + 4
                      : zeroFromBottom + 4
                    : barHeightPx + 4;
                  return (
                    <div key={`${title}-bar-${row.label}`} className="relative flex h-full w-11 flex-none items-end justify-center">
                      <span className="absolute text-[9px] leading-none text-slate-700" style={{ bottom: `${labelBottom}px` }} title={formatUsd(row.value)}>
                        {formatUsdCompact(row.value)}
                      </span>
                      <div
                        className={`absolute w-full rounded-t ${allowNegative && row.value < 0 ? "bg-rose-600" : "bg-slate-700"}`}
                        style={{
                          height: `${barHeightPx}px`,
                          bottom: `${allowNegative ? (row.value >= 0 ? zeroFromBottom : zeroFromBottom - downPx) : 0}px`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex gap-1 px-2">
                {displayedRows.map((row) => (
                  <span key={`${title}-label-${row.label}`} className="w-11 flex-none truncate text-center text-[10px] text-slate-600" title={row.label}>
                    {row.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {rows.length > maxItems ? <p className="text-[10px] text-slate-500">Showing last {maxItems} periods.</p> : null}
    </div>
  );
  return (
    <article className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</h3>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>-</button>
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))}>+</button>
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setExpanded(true)}>Expand</button>
        </div>
      </div>
      {displayedRows.length === 0 ? (
        <p className="text-xs text-slate-500">No data.</p>
      ) : (
        chartBody
      )}
      {expanded ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setExpanded(false)}>
          <div className="max-h-[92vh] w-[96vw] overflow-auto rounded-xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end"><button className="rounded border px-2 py-1 text-xs" onClick={() => setExpanded(false)}>Close</button></div>
            {chartBody}
          </div>
        </div>
      ) : null}
    </article>
  );
};

const DualHistogramCard = ({ title, rows }: { title: string; rows: Array<{ label: string; volume: number; pnl: number }> }) => {
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const maxItems = 48;
  const displayedRows = rows.length > maxItems ? rows.slice(rows.length - maxItems) : rows;
  const maxVolume = displayedRows.reduce((acc, row) => (Math.abs(row.volume) > acc ? Math.abs(row.volume) : acc), 0);
  const maxPnl = displayedRows.reduce((acc, row) => (Math.abs(row.pnl) > acc ? Math.abs(row.pnl) : acc), 0);
  const maxPnlPositive = displayedRows.reduce((acc, row) => (row.pnl > acc ? row.pnl : acc), 0);
  const minPnlNegative = displayedRows.reduce((acc, row) => (row.pnl < acc ? row.pnl : acc), 0);
  const pnlNegativeAbs = Math.abs(minPnlNegative);
  const columnWidthPx = 52;
  const chartHeight = Math.round(220 * zoom);
  const plotHeight = chartHeight - 26;
  const minWidth = Math.max(560, Math.round(displayedRows.length * columnWidthPx * zoom));
  const zeroFromBottom =
    maxPnlPositive > 0 && pnlNegativeAbs > 0
      ? (pnlNegativeAbs / (maxPnlPositive + pnlNegativeAbs)) * plotHeight
      : maxPnlPositive > 0
        ? 0
        : plotHeight;
  const pnlTopSpan = plotHeight - zeroFromBottom;
  const pnlBottomSpan = zeroFromBottom;
  const chartBody = (
    <div className="space-y-2">
      <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2">
        <div className="mb-1 flex items-center justify-between text-[10px]">
          <span className="font-medium text-sky-700">Y-left Volume</span>
          <span className="font-medium text-emerald-700">Y-right PNL</span>
        </div>
        <div className="flex gap-2">
          <div className="flex w-14 flex-col justify-between text-right text-[10px] text-sky-700">
            <span>{formatUsdCompact(maxVolume)}</span>
            <span>{formatUsdCompact(maxVolume * 0.66)}</span>
            <span>{formatUsdCompact(maxVolume * 0.33)}</span>
            <span>$0</span>
          </div>
          <div className="overflow-x-auto">
            <div className="relative" style={{ minWidth: `${minWidth}px` }}>
              <div className="relative flex items-end gap-1 border-b border-l border-r border-slate-300 px-2 pb-1" style={{ height: `${chartHeight}px` }}>
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute left-0 right-0 top-[33%] border-t border-dashed border-slate-200" />
                  <div className="absolute left-0 right-0 top-[66%] border-t border-dashed border-slate-200" />
                  <div className="absolute left-0 right-0 border-t-2 border-slate-300" style={{ bottom: `${zeroFromBottom}px` }} />
                </div>
                {displayedRows.map((row) => {
                  const volumeHeightPx = maxVolume > 0 ? Math.max(2, (Math.abs(row.volume) / maxVolume) * Math.max(0, pnlTopSpan)) : 0;
                  const pnlHeightPx =
                    row.pnl >= 0
                      ? maxPnlPositive > 0
                        ? (row.pnl / maxPnlPositive) * Math.max(0, pnlTopSpan)
                        : 0
                      : pnlNegativeAbs > 0
                        ? (Math.abs(row.pnl) / pnlNegativeAbs) * Math.max(0, pnlBottomSpan)
                        : 0;
                  const pnlLabelAnchorPx = row.pnl >= 0 ? zeroFromBottom + pnlHeightPx : zeroFromBottom;
                  const topPx = Math.max(volumeHeightPx, pnlLabelAnchorPx);
                  return (
                    <div key={`${title}-pair-${row.label}`} className="relative flex h-full w-[52px] flex-none items-end justify-center gap-0.5">
                      <span className="absolute text-[9px] leading-none text-slate-700" style={{ bottom: `${topPx + 4}px` }}>
                        {formatUsdCompact(row.volume)}/{formatUsdCompact(row.pnl)}
                      </span>
                      <div className="absolute left-0 w-1/2 rounded-t bg-sky-600" style={{ height: `${volumeHeightPx}px`, bottom: `${zeroFromBottom}px` }} title={`Volume: ${formatUsd(row.volume)}`} />
                      <div
                        className={`absolute right-0 rounded-t ${row.pnl < 0 ? "bg-rose-600" : "bg-emerald-600"}`}
                        style={{
                          width: "calc(50% - 1px)",
                          height: `${pnlHeightPx}px`,
                          bottom: `${row.pnl >= 0 ? zeroFromBottom : zeroFromBottom - pnlHeightPx}px`,
                        }}
                        title={`PNL: ${formatUsd(row.pnl)}`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex gap-1 px-2">
                {displayedRows.map((row) => (
                  <span key={`${title}-label-${row.label}`} className="w-[52px] flex-none truncate text-center text-[10px] text-slate-600" title={row.label}>
                    {row.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="flex w-14 flex-col justify-between text-[10px] text-emerald-700">
            <span>{formatUsdCompact(maxPnl)}</span>
            <span>{formatUsdCompact(maxPnl * 0.66)}</span>
            <span>{formatUsdCompact(maxPnl * 0.33)}</span>
            <span>$0</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 text-[10px]">
        <span className="inline-flex items-center gap-1 text-sky-700"><span className="h-2 w-2 rounded bg-sky-600" />Volume</span>
        <span className="inline-flex items-center gap-1 text-emerald-700"><span className="h-2 w-2 rounded bg-emerald-600" />PNL</span>
      </div>
      {rows.length > maxItems ? <p className="text-[10px] text-slate-500">Showing last {maxItems} periods.</p> : null}
    </div>
  );
  return (
    <article className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</h3>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>-</button>
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))}>+</button>
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setExpanded(true)}>Expand</button>
        </div>
      </div>
      {displayedRows.length === 0 ? (
        <p className="text-xs text-slate-500">No data.</p>
      ) : (
        chartBody
      )}
      {expanded ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setExpanded(false)}>
          <div className="max-h-[92vh] w-[96vw] overflow-auto rounded-xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end"><button className="rounded border px-2 py-1 text-xs" onClick={() => setExpanded(false)}>Close</button></div>
            {chartBody}
          </div>
        </div>
      ) : null}
    </article>
  );
};

export default function Home() {
  const [address, setAddress] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>("trading");
  const [histGranularity, setHistGranularity] = useState<HistogramGranularity>("day");
  const [loadingApi, setLoadingApi] = useState(false);
  const [error, setError] = useState("");

  const [trading, setTrading] = useState<TradingData | null>(null);
  const [hevm, setHevm] = useState<HevmData | null>(null);
  const [unitBridge, setUnitBridge] = useState<UnitBridgeData | null>(null);

  const tradingWarnings = useMemo(() => trading?.meta?.warnings ?? [], [trading]);
  const hevmWarnings = useMemo(() => hevm?.meta?.warnings ?? [], [hevm]);
  const unitWarnings = useMemo(() => unitBridge?.meta?.warnings ?? [], [unitBridge]);
  const walletAgeDays = hevm?.stats?.sinceFirstTx?.days ?? null;

  const onAnalyzeApi = async (event: FormEvent) => {
    event.preventDefault();
    setLoadingApi(true);
    setError("");

    try {
      const params = new URLSearchParams({
        address: address.trim(),
      });

      const [tradingRes, hevmRes, unitRes] = await Promise.all([
        fetch(`/api/dashboard/trading?${params.toString()}`),
        fetch(`/api/dashboard/hevm?address=${encodeURIComponent(address.trim())}`),
        fetch(`/api/dashboard/unit-bridge?address=${encodeURIComponent(address.trim())}`),
      ]);

      const [tradingJson, hevmJson, unitJson] = await Promise.all([tradingRes.json(), hevmRes.json(), unitRes.json()]);

      const failures: string[] = [];

      if (tradingRes.ok) {
        setTrading(tradingJson as TradingData);
      } else {
        failures.push((tradingJson as { error?: string }).error ?? "Trading API failed.");
      }

      if (hevmRes.ok) {
        setHevm(hevmJson as HevmData);
      } else {
        failures.push((hevmJson as { error?: string }).error ?? "HEVM API failed.");
      }

      if (unitRes.ok) {
        setUnitBridge(unitJson as UnitBridgeData);
      } else {
        failures.push((unitJson as { error?: string }).error ?? "Unit bridge API failed.");
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
  const isLoading = loadingApi;

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
                Active source: Hyperliquid API
              </p>
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
                TWAB legend: the value in parentheses is `TWAB × wallet age (days)`.
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
                    { label: "TWAB (USD)", value: formatTwabWithAge(hevm.stats.twab, hevm.stats.sinceFirstTx.days, "usd") },
                    { label: "Volume", value: formatUsd(hevm.stats.volume) },
                    { label: "Fees paid", value: formatUsd(hevm.stats.feesPaid) },
                    { label: "Different contracts", value: formatNum(hevm.stats.contractsCount) },
                    { label: "Different active days", value: formatNum(hevm.stats.activeDays) },
                    { label: "Different active months", value: formatNum(hevm.stats.activeMonths) },
                    {
                      label: "Since first tx",
                      value: `${hevm.stats.sinceFirstTx.days}d / ${hevm.stats.sinceFirstTx.months}m / ${hevm.stats.sinceFirstTx.years}y`,
                    },
                    { label: "Bridge volume", value: formatUsd(hevm.stats.bridgeVolume) },
                    { label: "Total tx (explorer-style)", value: formatNum(hevm.stats.totalTxCount) },
                    { label: "Initiated tx (wallet actions)", value: formatNum(hevm.stats.initiatedTxCount) },
                  ]}
                />
              </div>
              <p className="text-xs text-slate-500">
                TWAB legend: the value in parentheses is `TWAB × wallet age (days)`.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <HistogramCard
                  title={`HEVM Volume (${histGranularity})`}
                  rows={hevm.stats.charts.volume[histGranularity].map((row) => ({ label: row.period, value: row.volume }))}
                />
              </div>
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
