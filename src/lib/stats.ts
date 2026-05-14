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

export const summarizeFills = (fills: Fill[], source: "api" | "csv" = "csv") => {
  const outcomes = emptyMetrics();
  const xyz = emptyMetrics();
  const perps = emptyMetrics();

  let spotVolume = 0;
  let unitVolume = 0;

  for (const fill of fills) {
    const coin = readText(fill, ["coin", "asset", "symbol"]).toUpperCase();
    const dir = readText(fill, ["dir", "side"]).toUpperCase();
    const volume = tradeVolume(fill);

    const isOutcomesCsv = coin.includes("?");
    const isOutcomesApi =
      coin.includes("?") ||
      coin.startsWith("#") ||
      coin.startsWith("+") ||
      dir.includes("SETTLE") ||
      dir.includes("DELIST") ||
      dir.includes("OUTCOME");
    const isOutcomes = source === "api" ? isOutcomesApi : isOutcomesCsv;

    // 1) outcomes stats (volume + pvl)
    if (isOutcomes) {
      updateMetric(outcomes, fill);
    }

    const isXyzCsv = coin.includes("(XYZ)");
    const isXyzApi = coin.includes("(XYZ)") || coin === "XYZ" || coin.includes("XYZ/");
    const isXyz = source === "api" ? isXyzApi : isXyzCsv;

    // 2) xyz stats (volume + pvl)
    if (isXyz) {
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
