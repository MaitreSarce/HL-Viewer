export type Fill = {
  coin?: string;
  sz?: string;
  px?: string;
  closedPnl?: string;
  dir?: string;
};

export type Metrics = {
  volume: number;
  volumeUnits: number;
  pnl: number;
  wins: number;
  losses: number;
};

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

const winrate = (m: Metrics) => {
  const total = m.wins + m.losses;
  return total > 0 ? (m.wins / total) * 100 : 0;
};

export const summarizeFills = (fills: Fill[], focusAsset = "XYZ") => {
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