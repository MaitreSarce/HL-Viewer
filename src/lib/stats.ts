export type Fill = {
  coin?: string;
  sz?: string;
  px?: string;
  closedPnl?: string;
  dir?: string;
};

type Metrics = {
  volume: number;
  pnl: number;
  wins: number;
  losses: number;
};

const emptyMetrics = (): Metrics => ({
  volume: 0,
  pnl: 0,
  wins: 0,
  losses: 0,
});

const toNumber = (value: string | undefined) => {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const tradeVolume = (fill: Fill) => {
  const px = toNumber(fill.px);
  const sz = Math.abs(toNumber(fill.sz));
  return Math.abs(px * sz);
};

const tradePnl = (fill: Fill) => toNumber(fill.closedPnl);

const updateMetric = (metrics: Metrics, fill: Fill) => {
  const volume = tradeVolume(fill);
  const pnl = tradePnl(fill);
  metrics.volume += volume;
  metrics.pnl += pnl;
  if (pnl > 0) metrics.wins += 1;
  if (pnl < 0) metrics.losses += 1;
};

const winrate = (m: Metrics) => {
  const total = m.wins + m.losses;
  return total > 0 ? (m.wins / total) * 100 : 0;
};

export const summarizeFills = (fills: Fill[]) => {
  const outcomes = emptyMetrics();
  const xyz = emptyMetrics();
  const perps = emptyMetrics();

  let spotVolume = 0;
  let unitVolume = 0;

  for (const fill of fills) {
    const coin = (fill.coin ?? "").toUpperCase();
    const dir = (fill.dir ?? "").toUpperCase();
    const volume = tradeVolume(fill);

    // 1) coin contains ? => outcomes stats (volume + pvl)
    if (coin.includes("?")) {
      updateMetric(outcomes, fill);
    }

    // 2) coin contains (xyz) => xyz stats (volume + pvl)
    if (coin.includes("(XYZ)")) {
      updateMetric(xyz, fill);
    }

    // 3) dir contains buy or sell => spot volume
    const isSpot = dir.includes("BUY") || dir.includes("SELL");
    if (isSpot) {
      spotVolume += volume;
    }

    // 4) spot + coin contains BTC/ETH/PUMP/SOL => volume unit
    if (isSpot && (coin.includes("BTC") || coin.includes("ETH") || coin.includes("PUMP") || coin.includes("SOL"))) {
      unitVolume += volume;
    }

    // 5) dir contains Long or Short => perps stats (volume + pvl)
    if (dir.includes("LONG") || dir.includes("SHORT")) {
      updateMetric(perps, fill);
    }
  }

  // 6) volume total = outcomes volume + spot volume + perps volume
  const totalVolume = outcomes.volume + spotVolume + perps.volume;

  return {
    totals: {
      fills: fills.length,
      outcomes,
      xyz,
      perps,
      spotVolume,
      unitVolume,
      totalVolume,
    },
    winrates: {
      outcomes: winrate(outcomes),
      xyz: winrate(xyz),
      perps: winrate(perps),
    },
  };
};