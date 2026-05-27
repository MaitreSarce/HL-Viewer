"use client";

import { FormEvent, useMemo, useState } from "react";

type TradingData = {
  source: "api";
  totals: {
    fills: number;
    outcomes: { volume: number; pnl: number };
    xyz: { volume: number; pnl: number };
    perps: { volume: number; pnl: number };
    spotVolume: number;
    unitVolume: number;
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
};

type HevmData = {
  stats: {
    twab: number | null;
    volume: number;
    contractsCount: number;
    activeDays: number;
    activeMonths: number;
    sinceFirstTx: { days: number; months: number; years: number };
    bridgeVolume: number;
    txCount: number;
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
  };
  meta: {
    coverageMode: "auth-range" | "public-snapshot" | "cursor-paginated";
    warnings: string[];
  };
};

type TabKey = "trading" | "hevm" | "unit";

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

const formatNum = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);

const formatPct = (value: number) => `${value.toFixed(2)}%`;

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

export default function Home() {
  const [address, setAddress] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>("trading");
  const [loadingApi, setLoadingApi] = useState(false);
  const [error, setError] = useState("");

  const [trading, setTrading] = useState<TradingData | null>(null);
  const [hevm, setHevm] = useState<HevmData | null>(null);
  const [unitBridge, setUnitBridge] = useState<UnitBridgeData | null>(null);

  const tradingWarnings = useMemo(() => trading?.meta?.warnings ?? [], [trading]);
  const hevmWarnings = useMemo(() => hevm?.meta?.warnings ?? [], [hevm]);
  const unitWarnings = useMemo(() => unitBridge?.meta?.warnings ?? [], [unitBridge]);

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
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Portfolio Analytics</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Hyperliquid Viewer</h1>
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
                    { label: "Winrate", value: formatPct(trading.winrates.outcomes) },
                  ]}
                />
                <ZoneCard
                  title="XYZ"
                  rows={[
                    { label: "Volume", value: formatUsd(trading.totals.xyz.volume) },
                    { label: "PVL", value: formatUsd(trading.totals.xyz.pnl) },
                    { label: "Winrate", value: formatPct(trading.winrates.xyz) },
                  ]}
                />
                <ZoneCard
                  title="Perps"
                  rows={[
                    { label: "Volume", value: formatUsd(trading.totals.perps.volume) },
                    { label: "PVL", value: formatUsd(trading.totals.perps.pnl) },
                    { label: "Winrate", value: formatPct(trading.winrates.perps) },
                  ]}
                />
                <ZoneCard title="Spot" rows={[{ label: "Volume", value: formatUsd(trading.totals.spotVolume) }]} />
                <ZoneCard
                  title="Unit"
                  rows={[{ label: "Volume (BTC/ETH/PUMP/SOL)", value: formatUsd(trading.totals.unitVolume) }]}
                />
                <ZoneCard
                  title="Total"
                  rows={[
                    { label: "Volume total (perps + spot + outcomes)", value: formatUsd(trading.totals.totalVolume) },
                    { label: "Fills counted", value: formatNum(trading.totals.fills) },
                  ]}
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
                    { label: "TWAB", value: hevm.stats.twab === null ? "N/A" : formatNum(hevm.stats.twab) },
                    { label: "Volume", value: formatUsd(hevm.stats.volume) },
                    { label: "Different contracts", value: formatNum(hevm.stats.contractsCount) },
                    { label: "Different active days", value: formatNum(hevm.stats.activeDays) },
                    { label: "Different active months", value: formatNum(hevm.stats.activeMonths) },
                    {
                      label: "Since first tx",
                      value: `${hevm.stats.sinceFirstTx.days}d / ${hevm.stats.sinceFirstTx.months}m / ${hevm.stats.sinceFirstTx.years}y`,
                    },
                    { label: "Bridge volume", value: formatUsd(hevm.stats.bridgeVolume) },
                    { label: "Number of tx", value: formatNum(hevm.stats.txCount) },
                  ]}
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
