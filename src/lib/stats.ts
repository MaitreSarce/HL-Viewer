export type Fill = {
  coin?: string;
  sz?: string;
  px?: string;
  closedPnl?: string;
  dir?: string;
  side?: string;
  asset?: string;
  symbol?: string;
  [key: string]: unknown;
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

const readText = (fill: Fill, keys: string[]) => {
  for (const key of keys) {
    const raw = fill[key];
    if (typeof raw === "string") return raw;
  }
  return "";
};

const tradeVolume = (fill: Fill) => {
  const px = toNumber(readText(fill, ["px", "price"]));
  const sz = Math.abs(toNumber(readText(fill, ["sz", "size", "qty"])));
  return Math.abs(px * sz);
};

const tradePnl = (fill: Fill) => toNumber(readText(fill, ["closedPnl", "closed_pnl", "pnl"]));

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
    const coin = readText(fill, ["coin", "asset", "symbol"]).toUpperCase();
    const dir = readText(fill, ["dir", "side"]).toUpperCase();
    const volume = tradeVolume(fill);

    if (coin.includes("?")) {
      updateMetric(outcomes, fill);
    }

    if (coin.includes("(XYZ)")) {
      updateMetric(xyz, fill);
    }

    const isSpot = dir.includes("BUY") || dir.includes("SELL");
    if (isSpot) {
      spotVolume += volume;
    }

    if (isSpot && (coin.includes("BTC") || coin.includes("ETH") || coin.includes("PUMP") || coin.includes("SOL"))) {
      unitVolume += volume;
    }

    if (dir.includes("LONG") || dir.includes("SHORT")) {
      updateMetric(perps, fill);
    }
  }

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

const getLegacyApiCategory = (fill: Fill) => {
  const coin = readText(fill, ["coin", "asset", "symbol"]).toUpperCase();
  const dir = readText(fill, ["dir", "side"]).toLowerCase();

  if (coin.startsWith("#") || coin.startsWith("+") || dir.includes("settle") || dir.includes("delist")) {
    return "outcomes" as const;
  }

  if (coin.includes("/") || coin.startsWith("@")) {
    return "spot" as const;
  }

  return "perps" as const;
};

export const summarizeFillsApiLegacy = (fills: Fill[]) => {
  const outcomes = emptyMetrics();
  const xyz = emptyMetrics();
  const perps = emptyMetrics();

  let spotVolume = 0;
  let unitVolume = 0;

  for (const fill of fills) {
    const category = getLegacyApiCategory(fill);
    const coin = readText(fill, ["coin", "asset", "symbol"]).toUpperCase();
    const volume = tradeVolume(fill);

    if (category === "outcomes") {
      updateMetric(outcomes, fill);
      continue;
    }

    if (category === "spot") {
      spotVolume += volume;
      if (coin.includes("BTC") || coin.includes("ETH") || coin.includes("PUMP") || coin.includes("SOL")) {
        unitVolume += volume;
      }
      if (coin.includes("XYZ")) {
        updateMetric(xyz, fill);
      }
      continue;
    }

    updateMetric(perps, fill);
    if (coin === "XYZ") {
      updateMetric(xyz, fill);
    }
  }

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