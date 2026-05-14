import { NextRequest, NextResponse } from "next/server";

type Fill = {
  coin?: string;
  sz?: string;
  px?: string;
  closedPnl?: string;
  dir?: string;
};

type Metrics = {
  volume: number;
  volumeUnits: number;
  pnl: number;
  wins: number;
  losses: number;
};

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

const emptyMetrics = (): Metrics => ({
  volume: 0,
  volumeUnits: 0,
  pnl: 0,
  wins: 0,
  losses: 0,
});

const toNumber = (value: string | undefined) => {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getCategory = (fill: Fill) => {
  const coin = (fill.coin ?? "").toUpperCase();
  const dir = (fill.dir ?? "").toLowerCase();

  if (coin.startsWith("#") || coin.startsWith("+") || dir.includes("settle") || dir.includes("delist")) {
    return "outcomes" as const;
  }

  if (coin.includes("/") || coin.startsWith("@")) {
    return "spot" as const;
  }

  return "perps" as const;
};

const updateMetrics = (metrics: Metrics, fill: Fill) => {
  const px = toNumber(fill.px);
  const sz = Math.abs(toNumber(fill.sz));
  const pnl = toNumber(fill.closedPnl);

  metrics.volume += Math.abs(px * sz);
  metrics.volumeUnits += sz;
  metrics.pnl += pnl;

  if (pnl > 0) metrics.wins += 1;
  if (pnl < 0) metrics.losses += 1;
};

const buildSummary = (fills: Fill[], focusAsset: string) => {
  const perps = emptyMetrics();
  const spot = emptyMetrics();
  const outcomes = emptyMetrics();
  const focusPerps = emptyMetrics();
  const focusSpot = emptyMetrics();
  const normalizedFocus = focusAsset.trim().toUpperCase();

  for (const fill of fills) {
    const category = getCategory(fill);
    const coin = (fill.coin ?? "").toUpperCase();

    if (category === "perps") {
      updateMetrics(perps, fill);
      if (normalizedFocus && coin === normalizedFocus) {
        updateMetrics(focusPerps, fill);
      }
      continue;
    }

    if (category === "spot") {
      updateMetrics(spot, fill);
      if (normalizedFocus && coin.includes(normalizedFocus)) {
        updateMetrics(focusSpot, fill);
      }
      continue;
    }

    updateMetrics(outcomes, fill);
  }

  const winrate = (m: Metrics) => {
    const total = m.wins + m.losses;
    return total > 0 ? (m.wins / total) * 100 : 0;
  };

  return {
    totals: {
      fills: fills.length,
      perps,
      spot,
      outcomes,
      focusPerps,
      focusSpot,
    },
    winrates: {
      perps: winrate(perps),
      focusPerps: winrate(focusPerps),
      outcomes: winrate(outcomes),
    },
  };
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user = searchParams.get("address")?.trim() ?? "";
  const days = Math.max(1, Math.min(60, Number(searchParams.get("days") ?? "14")));
  const asset = searchParams.get("asset")?.trim() ?? "XYZ";

  if (!/^0x[a-fA-F0-9]{40}$/.test(user)) {
    return NextResponse.json({ error: "Adresse wallet invalide." }, { status: 400 });
  }

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "userFillsByTime",
      user,
      startTime,
      endTime,
      aggregateByTime: true,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Hyperliquid a renvoyé une erreur." }, { status: 502 });
  }

  const fills = (await response.json()) as Fill[];
  const summary = buildSummary(fills, asset);

  return NextResponse.json({
    address: user,
    days,
    asset: asset.toUpperCase(),
    period: { startTime, endTime },
    ...summary,
  });
}
