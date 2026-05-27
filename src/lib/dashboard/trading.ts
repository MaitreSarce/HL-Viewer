import {
  buildSpotCoinResolver,
  OutcomeMetaResponse,
  PerpMetaResponse,
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

type TradingClassificationContext = {
  knownSpotCoins: Set<string>;
  knownPerpCoins: Set<string>;
  knownOutcomeCoins: Set<string>;
};

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

const normalizeCoin = (value: string) => value.trim().toUpperCase();

const buildSpotCoinSet = (spotMeta: SpotMetaResponse, resolver: CoinResolver) => {
  const known = new Set<string>();
  for (const pair of spotMeta.universe ?? []) {
    if (typeof pair.index === "number") {
      const rawId = `@${pair.index}`;
      known.add(rawId);
      const resolved = normalizeCoin(resolver(rawId));
      if (resolved) known.add(resolved);
    }
    if (typeof pair.name === "string") {
      const pairName = normalizeCoin(pair.name);
      if (pairName) known.add(pairName);
    }
  }
  return known;
};

const buildPerpCoinSet = (perpMeta: PerpMetaResponse) => {
  const known = new Set<string>();
  for (const asset of perpMeta.universe ?? []) {
    if (typeof asset.name === "string") {
      const name = normalizeCoin(asset.name);
      if (name) known.add(name);
    }
  }
  return known;
};

const buildOutcomeCoinSet = (outcomeMeta: OutcomeMetaResponse) => {
  const known = new Set<string>();
  const outcomeNameById = new Map<number, string>();

  for (const outcome of outcomeMeta.outcomes ?? []) {
    const outcomeName = normalizeCoin(typeof outcome.name === "string" ? outcome.name : "");
    if (outcomeName) known.add(outcomeName);

    if (typeof outcome.outcome === "number" && Number.isFinite(outcome.outcome)) {
      const outcomeId = Math.floor(outcome.outcome);
      if (outcomeName) outcomeNameById.set(outcomeId, outcomeName);
      for (let side = 0; side <= 1; side += 1) {
        const encoding = String(outcomeId * 10 + side);
        known.add(`#${encoding}`);
        known.add(`+${encoding}`);
      }
    }
  }

  for (const question of outcomeMeta.questions ?? []) {
    const questionName = normalizeCoin(typeof question.name === "string" ? question.name : "");
    if (questionName) known.add(questionName);

    if (!questionName || !Array.isArray(question.namedOutcomes)) continue;
    for (const id of question.namedOutcomes) {
      if (typeof id !== "number" || !Number.isFinite(id)) continue;
      const namedOutcome = outcomeNameById.get(Math.floor(id));
      if (!namedOutcome) continue;
      known.add(`${questionName}: ${namedOutcome}`);
      known.add(`${questionName} - ${namedOutcome}`);
    }
  }

  return known;
};

const isBuySellDir = (dirUpper: string) => dirUpper.includes("BUY") || dirUpper.includes("SELL");

const isKnownSpotCoin = (coinUpper: string, rawCoinUpper: string, context: TradingClassificationContext) => {
  return (
    rawCoinUpper.startsWith("@") ||
    context.knownSpotCoins.has(rawCoinUpper) ||
    context.knownSpotCoins.has(coinUpper)
  );
};

const isKnownPerpCoin = (coinUpper: string, rawCoinUpper: string, context: TradingClassificationContext) => {
  return context.knownPerpCoins.has(rawCoinUpper) || context.knownPerpCoins.has(coinUpper);
};

const isOutcomesCoin = (
  coinUpper: string,
  rawCoinUpper: string,
  dirUpper: string,
  context: TradingClassificationContext
) => {
  return (
    coinUpper.includes("?") ||
    rawCoinUpper.startsWith("#") ||
    rawCoinUpper.startsWith("+") ||
    coinUpper.startsWith("#") ||
    coinUpper.startsWith("+") ||
    context.knownOutcomeCoins.has(rawCoinUpper) ||
    context.knownOutcomeCoins.has(coinUpper) ||
    coinUpper.endsWith("-YES") ||
    coinUpper.endsWith("-NO") ||
    dirUpper.includes("SETTLEMENT") ||
    dirUpper.includes("DELIST") ||
    (isBuySellDir(dirUpper) && !isKnownSpotCoin(coinUpper, rawCoinUpper, context) && !isKnownPerpCoin(coinUpper, rawCoinUpper, context))
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

const isSpotTrade = (coinUpper: string, rawCoinUpper: string, context: TradingClassificationContext) => {
  return isKnownSpotCoin(coinUpper, rawCoinUpper, context);
};

const isPerpTrade = (
  dirUpper: string,
  coinUpper: string,
  rawCoinUpper: string,
  context: TradingClassificationContext
) => {
  return (
    dirUpper.includes("LONG") ||
    dirUpper.includes("SHORT") ||
    dirUpper.includes("OPEN ") ||
    dirUpper.includes("CLOSE ") ||
    dirUpper.includes("ADD ") ||
    isKnownPerpCoin(coinUpper, rawCoinUpper, context)
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

export const summarizeTradingFills = (
  fills: HyperliquidFill[],
  resolver?: CoinResolver,
  context?: TradingClassificationContext
): TradingSummary => {
  const outcomes = EMPTY_BUCKET();
  const xyz = EMPTY_BUCKET();
  const perps = EMPTY_BUCKET();
  let spotVolume = 0;
  let unitVolume = 0;
  const classificationContext: TradingClassificationContext = context ?? {
    knownSpotCoins: new Set<string>(),
    knownPerpCoins: new Set<string>(),
    knownOutcomeCoins: new Set<string>(),
  };

  for (const fill of fills) {
    const rawCoin = getFillCoinRaw(fill);
    const resolvedCoin = resolver ? resolver(rawCoin) : rawCoin;
    const coinUpper = resolvedCoin.toUpperCase();
    const rawCoinUpper = rawCoin.toUpperCase();
    const dirUpper = readStringKeys(fill, ["dir", "side"]).toUpperCase();
    const volume = fillVolume(fill);
    const outcomeFill = isOutcomesCoin(coinUpper, rawCoinUpper, dirUpper, classificationContext);

    if (outcomeFill) {
      update(outcomes, fill);
    }

    if (isXyzCoin(coinUpper)) {
      update(xyz, fill);
    }

    if (isSpotTrade(coinUpper, rawCoinUpper, classificationContext) && !outcomeFill) {
      spotVolume += volume;
      if (isUnitCoin(coinUpper)) {
        unitVolume += volume;
      }
    }

    if (isPerpTrade(dirUpper, coinUpper, rawCoinUpper, classificationContext)) {
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

  const [spotMeta, perpMeta, rangeResult] = await Promise.all([
    fetchHyperliquidInfo<SpotMetaResponse>({ type: "spotMeta" }),
    fetchHyperliquidInfo<PerpMetaResponse>({ type: "meta" }),
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
  let outcomeMeta: OutcomeMetaResponse | null = null;
  let outcomeMetaRequestUsed = 0;

  try {
    outcomeMeta = await fetchHyperliquidInfo<OutcomeMetaResponse>({ type: "outcomeMeta" });
    outcomeMetaRequestUsed = 1;
  } catch {
    warnings.push(
      "Could not load outcomeMeta. Outcome detection falls back to encoded prefixes (#/+), settlement flags, and non-spot/non-perp buy/sell inference."
    );
  }

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
  const summary = summarizeTradingFills(fills, resolver, {
    knownSpotCoins: buildSpotCoinSet(spotMeta, resolver),
    knownPerpCoins: buildPerpCoinSet(perpMeta),
    knownOutcomeCoins: outcomeMeta ? buildOutcomeCoinSet(outcomeMeta) : new Set<string>(),
  });

  return {
    source: "api",
    address,
    period: { startTime, endTime },
    meta: {
      requestsUsed: rangeResult.requestsUsed + (usedFallback ? 1 : 0) + 2 + outcomeMetaRequestUsed,
      usedFallback,
      truncated: rangeResult.truncated,
      warnings,
    },
    ...summary,
  };
};
