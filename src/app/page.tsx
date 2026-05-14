"use client";

import { FormEvent, useMemo, useState } from "react";

type StatsResponse = {
  error?: string;
  asset: string;
  days: number;
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

export default function Home() {
  const [address, setAddress] = useState("");
  const [asset, setAsset] = useState("XYZ");
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<StatsResponse | null>(null);

  const cards = useMemo(() => {
    if (!data) return [];
    return [
      { label: "Volume perps", value: formatUsd(data.totals.perps.volume) },
      { label: "Volume spot", value: formatUsd(data.totals.spot.volume) },
      { label: `Volume spot asset (${data.asset})`, value: formatNum(data.totals.spot.volumeUnits) },
      { label: `Volume perps asset (${data.asset})`, value: formatUsd(data.totals.focusPerps.volume) },
      { label: "Volume outcomes + settlement", value: formatUsd(data.totals.outcomes.volume) },
      { label: "PVL perps", value: formatUsd(data.totals.perps.pnl) },
      { label: `PVL ${data.asset}`, value: formatUsd(data.totals.focusPerps.pnl) },
      { label: "PVL outcomes + settlement", value: formatUsd(data.totals.outcomes.pnl) },
      { label: "Winrate perps", value: formatPct(data.winrates.perps) },
      { label: `Winrate ${data.asset}`, value: formatPct(data.winrates.focusPerps) },
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
        asset: asset.trim().toUpperCase(),
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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 md:px-8">
      <header className="rounded-3xl border border-white/70 bg-white/75 p-6 shadow-sm backdrop-blur">
        <h1 className="text-2xl font-semibold">Hyperliquid Portfolio Viewer</h1>
        <p className="mt-2 text-sm text-slate-600">
          Dashboard prêt pour Vercel pour suivre volumes, PVL et winrates sur perps, spot, outcomes et settlement.
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
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 uppercase outline-none ring-sky-300 focus:ring"
          placeholder="Asset focus (ex: BTC)"
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
          required
        />
        <input
          type="number"
          min={1}
          max={60}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 outline-none ring-sky-300 focus:ring"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-xl bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
        >
          {loading ? "Chargement..." : "Analyser"}
        </button>
      </form>

      {error ? <p className="rounded-xl bg-red-50 px-4 py-3 text-red-700">{error}</p> : null}

      {data ? (
        <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <article key={c.label} className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm">
              <p className="text-sm text-slate-500">{c.label}</p>
              <p className="mt-2 text-xl font-semibold">{c.value}</p>
            </article>
          ))}
          <article className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm">
            <p className="text-sm text-slate-500">Nombre de fills analysés</p>
            <p className="mt-2 text-xl font-semibold">{formatNum(data.totals.fills)}</p>
          </article>
        </section>
      ) : null}
    </div>
  );
}
