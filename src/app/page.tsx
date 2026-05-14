"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { Fill, summarizeFills } from "@/lib/stats";

type StatsResponse = {
  error?: string;
  days: number;
  source?: "api" | "csv";
  totals: {
    fills: number;
    perps: { volume: number; pnl: number };
    spot: { volume: number; volumeUnits: number; pnl: number };
    outcomes: { volume: number; pnl: number };
    focusPerps: { volume: number; pnl: number };
  };
  winrates: {
    perps: number;
    focusPerps: number;
    outcomes: number;
  };
};

const formatUsd = (v: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);

const formatNum = (v: number) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 }).format(v);

const formatPct = (v: number) => `${v.toFixed(2)}%`;

const parseCsvLine = (line: string) => {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const parseCsvFills = (csvText: string): Fill[] => {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idxCoin = headers.indexOf("coin");
  const idxDir = headers.indexOf("dir");
  const idxPx = headers.indexOf("px");
  const idxSz = headers.indexOf("sz");
  const idxClosedPnl = headers.indexOf("closedpnl");

  if (idxCoin < 0 || idxDir < 0 || idxPx < 0 || idxSz < 0 || idxClosedPnl < 0) {
    throw new Error("Le CSV doit contenir les colonnes: coin, dir, px, sz, closedPnl.");
  }

  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    return {
      coin: cols[idxCoin],
      dir: cols[idxDir],
      px: cols[idxPx],
      sz: cols[idxSz],
      closedPnl: cols[idxClosedPnl],
    } satisfies Fill;
  });
};

export default function Home() {
  const [address, setAddress] = useState("");
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<StatsResponse | null>(null);

  const cards = useMemo(() => {
    if (!data) return [];
    return [
      { label: "Volume perps", value: formatUsd(data.totals.perps.volume) },
      { label: "Volume spot", value: formatUsd(data.totals.spot.volume) },
      { label: "Volume spot asset unit", value: formatNum(data.totals.spot.volumeUnits) },
      { label: "Volume perps asset XYZ", value: formatUsd(data.totals.focusPerps.volume) },
      { label: "Volume outcomes + settlement", value: formatUsd(data.totals.outcomes.volume) },
      { label: "PVL perps", value: formatUsd(data.totals.perps.pnl) },
      { label: "PVL XYZ", value: formatUsd(data.totals.focusPerps.pnl) },
      { label: "PVL outcomes + settlement", value: formatUsd(data.totals.outcomes.pnl) },
      { label: "Winrate perps", value: formatPct(data.winrates.perps) },
      { label: "Winrate XYZ", value: formatPct(data.winrates.focusPerps) },
      { label: "Winrate outcomes + settlement", value: formatPct(data.winrates.outcomes) },
    ];
  }, [data]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({
        address: address.trim(),
        days: String(days),
      });
      const res = await fetch(`/api/hyperliquid-stats?${params.toString()}`);
      const json = (await res.json()) as StatsResponse;
      if (!res.ok) {
        setData(null);
        setError(json.error ?? "Erreur API.");
      } else {
        setData(json);
      }
    } catch {
      setData(null);
      setError("Impossible de charger les statistiques.");
    } finally {
      setLoading(false);
    }
  };

  const onCsvImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError("");

    try {
      const text = await file.text();
      const fills = parseCsvFills(text);
      const summary = summarizeFills(fills, "XYZ");

      setData({
        days,
        source: "csv",
        ...summary,
      });
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Import CSV impossible.");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 md:px-8">
      <header className="rounded-3xl border border-white/70 bg-white/75 p-6 shadow-sm backdrop-blur">
        <h1 className="text-2xl font-semibold">Hyperliquid Portfolio Viewer</h1>
        <p className="mt-2 text-sm text-slate-600">
          Dashboard Vercel pour suivre volumes, PVL et winrates sur perps, spot, outcomes et settlement.
        </p>
      </header>

      <form onSubmit={onSubmit} className="grid gap-3 rounded-3xl border border-white/70 bg-white/75 p-5 shadow-sm md:grid-cols-4">
        <input
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 outline-none ring-sky-300 focus:ring"
          placeholder="Adresse wallet 0x..."
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          required
        />
        <input
          type="number"
          min={1}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 outline-none ring-sky-300 focus:ring"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-xl bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
        >
          {loading ? "Chargement..." : "Analyser via API"}
        </button>
        <label className="flex cursor-pointer items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
          Import CSV
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={onCsvImport} />
        </label>
      </form>

      {error ? <p className="rounded-xl bg-red-50 px-4 py-3 text-red-700">{error}</p> : null}

      {data ? (
        <>
          <p className="text-sm text-slate-600">
            Source active: {data.source === "csv" ? "CSV local" : "API Hyperliquid"}
          </p>
          <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => (
              <article key={c.label} className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm">
                <p className="text-sm text-slate-500">{c.label}</p>
                <p className="mt-2 text-xl font-semibold">{c.value}</p>
              </article>
            ))}
            <article className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm">
              <p className="text-sm text-slate-500">Nombre de fills analyses</p>
              <p className="mt-2 text-xl font-semibold">{formatNum(data.totals.fills)}</p>
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}