import {
  buildSpotCoinResolver,
  fetchHyperliquidInfo,
  fetchTimeRangeWithSplit,
  getFillCoinRaw,
  HyperliquidFill,
  SpotMetaResponse,
} from "@/lib/dashboard/hyperliquid";
import { readStringKeys, toFiniteNumber } from "@/lib/dashboard/shared";

export type TradingBucket = {
  volume: number;
  pnl: number;
  wins: number;
  losses: number;
  trades: number;
};

export type TradingSummary = {
  totals: {
    fills: number;
    outcomes: TradingBucket;
    xyz: TradingBucket;
    perps: TradingBucket;
    spotVolume: number;
    unitVolume: number;
    totalVolume: number;
  };
  winrates: {
    outcomes: number;
    xyz: number;
    perps: number;
  };
};

export type TradingApiResult = TradingSummary & {
  source: "api";
  address: string;
  period: { startTime: number; endTime: number };
  meta: {
    requestsUsed: number;
    usedFallback: boolean;
    truncated: boolean;
    warnings: string[];
  };
};

type CoinResolver = (rawCoin: string) => string;

const EMPTY_BUCKET = (): TradingBucket => ({
  volume: 0,
  pnl: 0,
  wins: 0,
  losses: 0,
  trades: 0,
});

const abs = (value: number) => Math.abs(value);

const fillVolume = (fill: HyperliquidFill) => {
  const px = toFiniteNumber(readStringKeys(fill, ["px", "price"]));
  const sz = abs(toFiniteNumber(readStringKeys(fill, ["sz", "size", "qty"])));
  return abs(px * sz);
};

const fillPnl = (fill: HyperliquidFill) => toFiniteNumber(readStringKeys(fill, ["closedPnl", "closed_pnl", "pnl"]));

const update = (bucket: TradingBucket, fill: HyperliquidFill) => {
  const volume = fillVolume(fill);
  const pnl = fillPnl(fill);
  bucket.volume += volume;
  bucket.pnl += pnl;
  bucket.trades += 1;
  if (pnl > 0) bucket.wins += 1;
  if (pnl < 0) bucket.losses += 1;
};

const winrate = (bucket: TradingBucket) => {
  const closedTrades = bucket.wins + bucket.losses;
  if (closedTrades === 0) return 0;
  return (bucket.wins / closedTrades) * 100;
};

const isOutcomesCoin = (coinUpper: string, rawCoinUpper: string, dirUpper: string) => {
  return (
    coinUpper.includes("?") ||
    rawCoinUpper.startsWith("#") ||
    rawCoinUpper.startsWith("+") ||
    coinUpper.startsWith("#") ||
    coinUpper.startsWith("+") ||
    coinUpper.endsWith("-YES") ||
    coinUpper.endsWith("-NO") ||
    dirUpper.includes("SETTLEMENT") ||
    dirUpper.includes("DELIST")
  );
};

const isXyzCoin = (coinUpper: string) => {
  return (
    coinUpper.includes("(XYZ)") ||
    coinUpper === "XYZ" ||
    coinUpper.startsWith("XYZ/") ||
    coinUpper.endsWith("/XYZ") ||
    coinUpper.startsWith("XYZ:") ||
    coinUpper.includes(":XYZ")
  );
};

const isSpotTrade = (dirUpper: string, coinUpper: string, rawCoinUpper: string) => {
  return (
    dirUpper.includes("BUY") ||
    dirUpper.includes("SELL") ||
    coinUpper.includes("/") ||
    rawCoinUpper.startsWith("@")
  );
};

const isPerpTrade = (dirUpper: string) => {
  return (
    dirUpper.includes("LONG") ||
    dirUpper.includes("SHORT") ||
    dirUpper.includes("OPEN ") ||
    dirUpper.includes("CLOSE ") ||
    dirUpper.includes("ADD ")
  );
};

const isUnitCoin = (coinUpper: string) => {
  return (
    coinUpper.includes("BTC") ||
    coinUpper.includes("ETH") ||
    coinUpper.includes("PUMP") ||
    coinUpper.includes("SOL")
  );
};

export const summarizeTradingFills = (fills: HyperliquidFill[], resolver?: CoinResolver): TradingSummary => {
  const outcomes = EMPTY_BUCKET();
  const xyz = EMPTY_BUCKET();
  const perps = EMPTY_BUCKET();
  let spotVolume = 0;
  let unitVolume = 0;

  for (const fill of fills) {
    const rawCoin = getFillCoinRaw(fill);
    const resolvedCoin = resolver ? resolver(rawCoin) : rawCoin;
    const coinUpper = resolvedCoin.toUpperCase();
    const rawCoinUpper = rawCoin.toUpperCase();
    const dirUpper = readStringKeys(fill, ["dir", "side"]).toUpperCase();
    const volume = fillVolume(fill);

    if (isOutcomesCoin(coinUpper, rawCoinUpper, dirUpper)) {
      update(outcomes, fill);
    }

    if (isXyzCoin(coinUpper)) {
      update(xyz, fill);
    }

    if (isSpotTrade(dirUpper, coinUpper, rawCoinUpper)) {
      spotVolume += volume;
      if (isUnitCoin(coinUpper)) {
        unitVolume += volume;
      }
    }

    if (isPerpTrade(dirUpper)) {
      update(perps, fill);
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

export const fetchTradingStatsFromApi = async (address: string): Promise<TradingApiResult> => {
  const endTime = Date.now();
  const startTime = 0;

  const [spotMeta, rangeResult] = await Promise.all([
    fetchHyperliquidInfo<SpotMetaResponse>({ type: "spotMeta" }),
    fetchTimeRangeWithSplit<HyperliquidFill>({
      type: "userFillsByTime",
      user: address,
      startTime,
      endTime,
      pageLimit: 2000,
      minWindowMs: 30 * 60 * 1000,
      maxRequests: 160,
    }),
  ]);

  let fills = rangeResult.rows;
  let usedFallback = false;
  const warnings: string[] = [];

  if (fills.length === 0) {
    const latest = await fetchHyperliquidInfo<unknown>({
      type: "userFills",
      user: address,
    });
    if (Array.isArray(latest)) {
      fills = latest as HyperliquidFill[];
      usedFallback = true;
      warnings.push("userFillsByTime returned no rows. Fallback to the latest 2000 fills was used.");
    }
  }

  if (rangeResult.truncated) {
    warnings.push("The API window was dense and had to be split; some rows may still be truncated by API limits.");
  }
  warnings.push("Hyperliquid only exposes up to the 10000 most recent fills per wallet on fill endpoints.");

  const resolver = buildSpotCoinResolver(spotMeta);
  const summary = summarizeTradingFills(fills, resolver);

  return {
    source: "api",
    address,
    period: { startTime, endTime },
    meta: {
      requestsUsed: rangeResult.requestsUsed + (usedFallback ? 1 : 0),
      usedFallback,
      truncated: rangeResult.truncated,
      warnings,
    },
    ...summary,
  };
};
