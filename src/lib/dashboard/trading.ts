import {
  buildSpotCoinResolver,
  NonFundingUpdate,
  OutcomeMetaResponse,
  PerpMetaResponse,
  fetchHyperliquidInfo,
  fetchTimeRangeWithSplit,
  getFillCoinRaw,
  getFillTime,
  HyperliquidFill,
  SpotMetaResponse,
} from "@/lib/dashboard/hyperliquid";
import { readStringKeys, toFiniteNumber } from "@/lib/dashboard/shared";
import { computeTwabSeriesUsdFromValuePoints, computeTwabUsdFromValuePoints } from "@/lib/dashboard/twab";

export type TradingBucket = {
  volume: number;
  pnl: number;
  feesPaid: number;
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
    spotFeesPaid: number;
    spotTwab: number | null;
    vaultTwab: number | null;
    hypeStakingTwab: number | null;
    unitVolume: number;
    unitFeesPaid: number;
    unitTrades: number;
    unitTokens: string[];
    unitTwab: number | null;
    totalVolume: number;
  };
  winrates: {
    outcomes: number;
    xyz: number;
    perps: number;
  };
  charts: {
    outcomes: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number; pnl: number }>>;
    xyz: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number; pnl: number }>>;
    perps: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number; pnl: number }>>;
    spot: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
    unit: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
    spotTwab: Record<"day" | "week" | "month" | "year", Array<{ period: string; twab: number }>>;
  };
};

export type TradingApiResult = TradingSummary & {
  source: "api" | "full_export";
  address: string;
  period: { startTime: number; endTime: number };
  meta: {
    requestsUsed: number;
    usedFallback: boolean;
    truncated: boolean;
    warnings: string[];
    dataSourceLabel?: string;
  };
};

type PortfolioHistoryPoint = [number, string];
type PortfolioRange = {
  accountValueHistory?: PortfolioHistoryPoint[];
  spotState?: {
    accountValueHistory?: PortfolioHistoryPoint[];
  };
  [key: string]: unknown;
};
type PortfolioResponse = Array<[string, PortfolioRange]>;
type UserVaultEquity = {
  vaultAddress?: string;
  equity?: string | number;
  [key: string]: unknown;
};
type VaultDetailsResponse = {
  portfolio?: Array<[string, { accountValueHistory?: PortfolioHistoryPoint[]; [key: string]: unknown }]>;
  [key: string]: unknown;
};
type DelegatorHistoryUpdate = {
  time?: number;
  delta?: {
    delegate?: {
      validator?: string;
      amount?: string | number;
      isUndelegate?: boolean;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
type DelegatorSummary = {
  delegated?: string | number;
  [key: string]: unknown;
};

type CoinResolver = (rawCoin: string) => string;

type TradingClassificationContext = {
  knownSpotCoins: Set<string>;
  knownPerpCoins: Set<string>;
  knownOutcomeCoins: Set<string>;
  knownUnitSpotIds: Set<string>;
};

const EMPTY_BUCKET = (): TradingBucket => ({
  volume: 0,
  pnl: 0,
  feesPaid: 0,
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
const fillFeePaid = (fill: HyperliquidFill) => {
  const rawFee = toFiniteNumber(readStringKeys(fill, ["fee", "fees"]));
  return rawFee > 0 ? rawFee : 0;
};

const update = (bucket: TradingBucket, fill: HyperliquidFill) => {
  const volume = fillVolume(fill);
  const pnl = fillPnl(fill);
  const feePaid = fillFeePaid(fill);
  bucket.volume += volume;
  bucket.pnl += pnl;
  bucket.feesPaid += feePaid;
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

export const buildSpotCoinSet = (spotMeta: SpotMetaResponse, resolver: CoinResolver) => {
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

export const buildPerpCoinSet = (perpMeta: PerpMetaResponse) => {
  const known = new Set<string>();
  for (const asset of perpMeta.universe ?? []) {
    if (typeof asset.name === "string") {
      const name = normalizeCoin(asset.name);
      if (name) known.add(name);
    }
  }
  return known;
};

export const buildOutcomeCoinSet = (outcomeMeta: OutcomeMetaResponse) => {
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

const UNIT_TOKEN_ALIASES: Record<string, string[]> = {
  BTC: ["BTC", "UBTC"],
  ETH: ["ETH", "UETH"],
  SOL: ["SOL", "USOL"],
  PUMP: ["PUMP", "UPUMP"],
  FARTCOIN: ["FARTCOIN", "UFART"],
  SPXS: ["SPXS", "UUUSPX"],
  BONK: ["BONK", "UBONK"],
  XPL: ["XPL"],
  ZEC: ["ZEC", "UZEC"],
};

const UNIT_BASE_TOKEN_NAMES = new Set<string>(
  Object.values(UNIT_TOKEN_ALIASES)
    .flat()
    .map((v) => v.toUpperCase())
);

const UNIT_TOKEN_LIST = Object.keys(UNIT_TOKEN_ALIASES);

const matchUnitToken = (coinUpper: string): string | null => {
  const parts = coinUpper
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return null;

  for (const [symbol, aliases] of Object.entries(UNIT_TOKEN_ALIASES)) {
    if (aliases.some((alias) => parts.includes(alias))) {
      return symbol;
    }
  }
  return null;
};

export const buildUnitSpotIdSet = (spotMeta: SpotMetaResponse) => {
  const known = new Set<string>();
  const tokenNameByIndex = new Map<number, string>();
  for (const token of spotMeta.tokens ?? []) {
    if (typeof token.index === "number" && typeof token.name === "string") {
      tokenNameByIndex.set(token.index, token.name.trim().toUpperCase());
    }
  }
  for (const pair of spotMeta.universe ?? []) {
    if (typeof pair.index !== "number") continue;
    const baseTokenIndex = Array.isArray(pair.tokens) ? pair.tokens[0] : undefined;
    const baseTokenName = typeof baseTokenIndex === "number" ? tokenNameByIndex.get(baseTokenIndex) ?? "" : "";
    if (UNIT_BASE_TOKEN_NAMES.has(baseTokenName)) {
      known.add(`@${pair.index}`.toUpperCase());
    }
  }
  return known;
};

const unitFeeUsdFromFill = (fill: HyperliquidFill) => {
  const fee = toFiniteNumber(readStringKeys(fill, ["fee", "fees"]));
  const px = toFiniteNumber(readStringKeys(fill, ["px", "price"]));
  const feeToken = readStringKeys(fill, ["feeToken"]).trim().toUpperCase();
  if (!Number.isFinite(fee) || fee === 0) return 0;
  if (isStableQuote(feeToken)) return fee;
  if (Number.isFinite(px) && px > 0) return fee * px;
  return 0;
};

const spotFeeUsdFromFill = (fill: HyperliquidFill) => {
  const fee = toFiniteNumber(readStringKeys(fill, ["fee", "fees"]));
  const px = toFiniteNumber(readStringKeys(fill, ["px", "price"]));
  const feeToken = readStringKeys(fill, ["feeToken"]).trim().toUpperCase();
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  if (isStableQuote(feeToken)) return fee;
  if (Number.isFinite(px) && px > 0) return fee * px;
  return fee;
};

const STABLE_QUOTES = new Set([
  "USD",
  "USDC",
  "USDT",
  "USDE",
  "USDT0",
  "USD0",
  "USDH",
  "FDUSD",
  "DAI",
]);

const isStableQuote = (asset: string) => {
  const normalized = asset.trim().toUpperCase();
  if (!normalized) return false;
  if (STABLE_QUOTES.has(normalized)) return true;
  return normalized.startsWith("USD");
};

const utcDayKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const utcMonthKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 7);
};

const utcWeekKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
};

const utcYearKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return String(d.getUTCFullYear());
};

const periodKeyByGranularity = (timestampMs: number, granularity: "day" | "week" | "month" | "year") => {
  if (granularity === "day") return utcDayKey(timestampMs);
  if (granularity === "week") return utcWeekKey(timestampMs);
  if (granularity === "month") return utcMonthKey(timestampMs);
  return utcYearKey(timestampMs);
};

const emptyPnlSeriesMaps = () => ({
  day: new Map<string, { volume: number; pnl: number }>(),
  week: new Map<string, { volume: number; pnl: number }>(),
  month: new Map<string, { volume: number; pnl: number }>(),
  year: new Map<string, { volume: number; pnl: number }>(),
});

const emptyVolumeSeriesMaps = () => ({
  day: new Map<string, number>(),
  week: new Map<string, number>(),
  month: new Map<string, number>(),
  year: new Map<string, number>(),
});

const historyToValuePoints = (rows: PortfolioHistoryPoint[]) =>
  rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 2) return null;
      const rawTs = toFiniteNumber(row[0]);
      const timeSec = rawTs > 1e12 ? Math.floor(rawTs / 1000) : Math.floor(rawTs);
      const valueUsd = toFiniteNumber(row[1]);
      if (timeSec <= 0 || !Number.isFinite(valueUsd)) return null;
      return { timeSec, valueUsd };
    })
    .filter((p): p is { timeSec: number; valueUsd: number } => p !== null);

const valueAtTimeSec = (points: Array<{ timeSec: number; valueUsd: number }>, timeSec: number): number | null => {
  if (points.length === 0) return null;
  if (timeSec <= points[0].timeSec) return points[0].valueUsd;
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = points[mid].timeSec;
    if (t === timeSec) return points[mid].valueUsd;
    if (t < timeSec) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 ? points[hi].valueUsd : points[0].valueUsd;
};

const parseVaultLedgerDeltaUsd = (delta: Record<string, unknown>): number | null => {
  const type = readStringKeys(delta, ["type"]).toLowerCase();
  if (type === "vaultdeposit") {
    const amount = toFiniteNumber(delta.usdc);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }
  if (type === "vaultwithdraw") {
    const amount = toFiniteNumber(delta.requestedUsd ?? delta.netWithdrawnUsd ?? delta.usdc);
    return Number.isFinite(amount) && amount > 0 ? -amount : null;
  }
  if (type === "vaultdistribution") {
    const amount = toFiniteNumber(delta.usdc);
    return Number.isFinite(amount) && amount > 0 ? -amount : null;
  }
  return null;
};

const computeVaultTwabUsd = (
  spotSeriesPoints: Array<{ timeSec: number; valueUsd: number }>,
  userVaultEquities: UserVaultEquity[],
  ledgerUpdates: NonFundingUpdate[],
  vaultHistoriesByAddress: Map<string, Array<{ timeSec: number; valueUsd: number }>>,
  endTimeSec: number
) => {
  if (spotSeriesPoints.length === 0 || userVaultEquities.length === 0) return null;

  const endSec = Math.floor(endTimeSec);
  const rawEvents = ledgerUpdates
    .map((u) => {
      const delta = (u.delta ?? {}) as Record<string, unknown>;
      const vault = readStringKeys(delta, ["vault"]).toLowerCase();
      if (!vault) return null;
      const deltaUsd = parseVaultLedgerDeltaUsd(delta);
      if (deltaUsd === null) return null;
      const tMs = Math.floor(toFiniteNumber(u.time ?? 0));
      if (tMs <= 0) return null;
      return { vault, timeSec: Math.floor(tMs / 1000), deltaUsd };
    })
    .filter((e): e is { vault: string; timeSec: number; deltaUsd: number } => e !== null);

  const eventsByVault = new Map<string, Array<{ timeSec: number; deltaUsd: number }>>();
  for (const e of rawEvents) {
    const list = eventsByVault.get(e.vault) ?? [];
    list.push({ timeSec: e.timeSec, deltaUsd: e.deltaUsd });
    eventsByVault.set(e.vault, list);
  }
  for (const list of eventsByVault.values()) {
    list.sort((a, b) => a.timeSec - b.timeSec);
  }

  const changeTimes = new Set<number>([spotSeriesPoints[0].timeSec, endSec]);
  for (const p of spotSeriesPoints) changeTimes.add(p.timeSec);
  for (const [vault, points] of vaultHistoriesByAddress.entries()) {
    if (points.length === 0) continue;
    for (const p of points) changeTimes.add(p.timeSec);
    const events = eventsByVault.get(vault) ?? [];
    for (const e of events) changeTimes.add(e.timeSec);
  }

  const unitsByVault = new Map<string, number>();
  for (const row of userVaultEquities) {
    const vault = readStringKeys(row, ["vaultAddress"]).toLowerCase();
    if (!vault) continue;
    const equityNow = toFiniteNumber((row as UserVaultEquity).equity ?? 0);
    if (equityNow <= 0) continue;
    const navSeries = vaultHistoriesByAddress.get(vault) ?? [];
    const navNow = valueAtTimeSec(navSeries, endSec);
    if (navNow === null || navNow <= 0) continue;
    unitsByVault.set(vault, equityNow / navNow);
  }

  const orderedTimes = [...changeTimes].filter((t) => t > 0).sort((a, b) => a - b);
  if (orderedTimes.length < 2) return null;

  let area = 0;
  let lastT = orderedTimes[0];
  for (const t of orderedTimes) {
    if (t < lastT) continue;

    let vaultValue = 0;
    for (const [vault, units] of unitsByVault.entries()) {
      if (units <= 0) continue;
      const nav = valueAtTimeSec(vaultHistoriesByAddress.get(vault) ?? [], t);
      if (nav !== null && nav > 0) vaultValue += units * nav;
    }

    if (t > lastT) {
      area += vaultValue * (t - lastT);
      lastT = t;
    }

    for (const [vault, events] of eventsByVault.entries()) {
      if (events.length === 0) continue;
      const nav = valueAtTimeSec(vaultHistoriesByAddress.get(vault) ?? [], t);
      if (nav === null || nav <= 0) continue;
      let units = unitsByVault.get(vault) ?? 0;
      for (const evt of events) {
        if (evt.timeSec !== t) continue;
        units += evt.deltaUsd / nav;
      }
      unitsByVault.set(vault, Math.max(0, units));
    }
  }

  const duration = Math.max(0, endSec - orderedTimes[0]);
  if (duration <= 0) return null;
  const twab = area / duration;
  return twab > 0 ? twab : null;
};

export const computeStakingTwabFromDelegatorHistory = (
  updates: DelegatorHistoryUpdate[],
  endTimeMs: number,
  currentDelegated: number
): number | null => {
  const events = updates
    .map((u) => {
      const t = Math.floor(toFiniteNumber(u.time ?? 0));
      const delegate = u.delta?.delegate;
      if (!delegate || t <= 0) return null;
      const amount = abs(toFiniteNumber(delegate.amount ?? 0));
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const isUndelegate = Boolean(delegate.isUndelegate);
      const validator = readStringKeys(delegate as Record<string, unknown>, ["validator"]).toLowerCase();
      return { t, validator, d: isUndelegate ? -amount : amount };
    })
    .filter((e): e is { t: number; validator: string; d: number } => e !== null)
    .sort((a, b) => a.t - b.t);

  if (events.length === 0) return currentDelegated > 0 ? currentDelegated : null;

  let area = 0;
  const start = events[0].t;
  let lastT = start;
  const stakeByValidator = new Map<string, number>();
  const totalStake = () => [...stakeByValidator.values()].reduce((sum, value) => sum + Math.max(0, value), 0);

  for (const e of events) {
    if (e.t > lastT) {
      area += totalStake() * (e.t - lastT);
      lastT = e.t;
    }
    const validatorKey = e.validator || "unknown";
    const nextStake = Math.max(0, (stakeByValidator.get(validatorKey) ?? 0) + e.d);
    stakeByValidator.set(validatorKey, nextStake);
  }

  const end = Math.max(lastT, Math.floor(endTimeMs));
  if (end > lastT) area += totalStake() * (end - lastT);
  const duration = Math.max(0, end - start);
  if (duration <= 0) {
    const stake = totalStake();
    return stake > 0 ? stake : currentDelegated > 0 ? currentDelegated : null;
  }
  const twab = area / duration;
  return twab > 0 ? twab : null;
};


const parseSpotPair = (coinUpper: string): { base: string; quote: string } | null => {
  const raw = coinUpper.trim().toUpperCase();
  if (!raw) return null;
  if (!raw.includes("/")) {
    return { base: raw, quote: "USDC" };
  }

  const [baseRaw, quoteRaw] = raw.split("/", 2);
  const base = baseRaw.trim();
  const quote = quoteRaw.trim();
  if (!base || !quote) return null;
  return { base, quote };
};

const signedSpotSize = (fill: HyperliquidFill, dirUpper: string): number => {
  const size = abs(toFiniteNumber(readStringKeys(fill, ["sz", "size", "qty"])));
  if (size <= 0) return 0;

  if (dirUpper.includes("BUY")) return size;
  if (dirUpper.includes("SELL")) return -size;

  const sideUpper = readStringKeys(fill, ["side"]).toUpperCase();
  if (sideUpper === "B") return size;
  if (sideUpper === "A") return -size;
  return 0;
};

const computeSpotTwabUsd = (
  fills: HyperliquidFill[],
  resolver: CoinResolver,
  context: TradingClassificationContext,
  endTimeMs: number
): number | null => {
  type SpotEvent = {
    timeMs: number;
    base: string;
    quote: string;
    signedBaseSize: number;
    priceInQuote: number;
  };

  const events: SpotEvent[] = [];
  for (const fill of fills) {
    const rawCoin = getFillCoinRaw(fill);
    const resolvedCoin = resolver(rawCoin);
    const coinUpper = resolvedCoin.toUpperCase();
    const rawCoinUpper = rawCoin.toUpperCase();
    const dirUpper = readStringKeys(fill, ["dir", "side"]).toUpperCase();

    if (!isSpotTrade(coinUpper, rawCoinUpper, context)) continue;
    if (isOutcomesCoin(coinUpper, rawCoinUpper, dirUpper, context)) continue;

    const pair = parseSpotPair(coinUpper);
    if (!pair) continue;

    const timeMs = getFillTime(fill);
    const priceInQuote = toFiniteNumber(readStringKeys(fill, ["px", "price"]));
    const signedBaseSize = signedSpotSize(fill, dirUpper);
    if (timeMs <= 0 || priceInQuote <= 0 || signedBaseSize === 0) continue;

    events.push({
      timeMs,
      base: pair.base,
      quote: pair.quote,
      signedBaseSize,
      priceInQuote,
    });
  }

  if (events.length === 0) return null;

  events.sort((a, b) => a.timeMs - b.timeMs);
  const balancesByAsset = new Map<string, number>();
  const usdPriceByAsset = new Map<string, number>([["USDC", 1], ["USD", 1], ["USDT", 1]]);

  const portfolioUsdValue = () => {
    let value = 0;
    for (const [asset, qty] of balancesByAsset.entries()) {
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const price = usdPriceByAsset.get(asset) ?? 0;
      if (price > 0) value += qty * price;
    }
    return value;
  };

  let firstTimeMs = events[0].timeMs;
  let lastTimeMs = firstTimeMs;
  let runningValue = 0;
  let weightedArea = 0;
  let initialized = false;

  for (const event of events) {
    if (!initialized) {
      initialized = true;
      firstTimeMs = event.timeMs;
      lastTimeMs = event.timeMs;
    } else if (event.timeMs > lastTimeMs) {
      weightedArea += runningValue * (event.timeMs - lastTimeMs);
      lastTimeMs = event.timeMs;
    }

    const quotePriceUsd =
      usdPriceByAsset.get(event.quote) ??
      (isStableQuote(event.quote) ? 1 : 0);
    if (quotePriceUsd > 0) {
      usdPriceByAsset.set(event.quote, quotePriceUsd);
      usdPriceByAsset.set(event.base, event.priceInQuote * quotePriceUsd);
    } else {
      const basePriceUsd = usdPriceByAsset.get(event.base) ?? 0;
      if (basePriceUsd > 0) {
        usdPriceByAsset.set(event.quote, basePriceUsd / event.priceInQuote);
      }
    }

    const nextBase = (balancesByAsset.get(event.base) ?? 0) + event.signedBaseSize;
    balancesByAsset.set(event.base, nextBase);

    if (quotePriceUsd > 0) {
      const quoteDelta = event.signedBaseSize * event.priceInQuote;
      const nextQuote = (balancesByAsset.get(event.quote) ?? 0) - quoteDelta;
      balancesByAsset.set(event.quote, nextQuote);
    }

    runningValue = portfolioUsdValue();
  }

  const endMs = Math.max(lastTimeMs, Math.floor(endTimeMs));
  if (endMs > lastTimeMs) {
    weightedArea += runningValue * (endMs - lastTimeMs);
  }

  const durationMs = Math.max(0, endMs - firstTimeMs);
  if (durationMs <= 0) {
    return runningValue > 0 ? runningValue : null;
  }

  const twab = weightedArea / durationMs;
  return twab > 0 ? twab : null;
};

const computeUnitTwabUsd = (
  fills: HyperliquidFill[],
  resolver: CoinResolver,
  context: TradingClassificationContext,
  endTimeMs: number,
  anchorStartTimeMs?: number
): number | null => {
  type SpotEvent = {
    timeMs: number;
    base: string;
    quote: string;
    signedBaseSize: number;
    priceInQuote: number;
  };

  const isUnitAsset = (asset: string) => matchUnitToken(asset.toUpperCase()) !== null;

  const events: SpotEvent[] = [];
  for (const fill of fills) {
    const rawCoin = getFillCoinRaw(fill);
    const resolvedCoin = resolver(rawCoin);
    const coinUpper = resolvedCoin.toUpperCase();
    const rawCoinUpper = rawCoin.toUpperCase();
    const dirUpper = readStringKeys(fill, ["dir", "side"]).toUpperCase();

    if (!isSpotTrade(coinUpper, rawCoinUpper, context)) continue;
    if (isOutcomesCoin(coinUpper, rawCoinUpper, dirUpper, context)) continue;

    const pair = parseSpotPair(coinUpper);
    if (!pair) continue;
    const unitTokenFromPair = context.knownUnitSpotIds.has(rawCoinUpper) ? pair.base : null;
    const unitToken = matchUnitToken(unitTokenFromPair ?? coinUpper);
    if (!unitToken) continue;

    if (!isStableQuote(pair.quote)) continue;

    const timeMs = getFillTime(fill);
    const priceInQuote = toFiniteNumber(readStringKeys(fill, ["px", "price"]));
    const signedBaseSize = signedSpotSize(fill, dirUpper);
    if (timeMs <= 0 || priceInQuote <= 0 || signedBaseSize === 0) continue;

    events.push({
      timeMs,
      base: pair.base,
      quote: pair.quote,
      signedBaseSize,
      priceInQuote,
    });
  }

  if (events.length === 0) return null;

  events.sort((a, b) => a.timeMs - b.timeMs);
  const balancesByAsset = new Map<string, number>();
  const usdPriceByAsset = new Map<string, number>([["USDC", 1], ["USD", 1], ["USDT", 1]]);

  const portfolioUsdValue = () => {
    let value = 0;
    for (const [asset, qty] of balancesByAsset.entries()) {
      if (!isUnitAsset(asset)) continue;
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const price = usdPriceByAsset.get(asset) ?? 0;
      if (price > 0) value += qty * price;
    }
    return value;
  };

  let firstTimeMs = events[0].timeMs;
  const hasAnchorStart =
    typeof anchorStartTimeMs === "number" &&
    Number.isFinite(anchorStartTimeMs) &&
    anchorStartTimeMs > 0 &&
    Math.floor(anchorStartTimeMs) < firstTimeMs;
  if (hasAnchorStart) {
    firstTimeMs = Math.floor(anchorStartTimeMs as number);
  }
  let lastTimeMs = firstTimeMs;
  let runningValue = 0;
  let weightedArea = 0;
  let initialized = hasAnchorStart;

  for (const event of events) {
    if (!initialized) {
      initialized = true;
      firstTimeMs = event.timeMs;
      lastTimeMs = event.timeMs;
    } else if (event.timeMs > lastTimeMs) {
      weightedArea += runningValue * (event.timeMs - lastTimeMs);
      lastTimeMs = event.timeMs;
    }

    const quotePriceUsd = isStableQuote(event.quote) ? 1 : 0;
    if (quotePriceUsd <= 0) continue;
    usdPriceByAsset.set(event.quote, quotePriceUsd);
    usdPriceByAsset.set(event.base, event.priceInQuote * quotePriceUsd);

    const nextBase = (balancesByAsset.get(event.base) ?? 0) + event.signedBaseSize;
    balancesByAsset.set(event.base, nextBase);

    if (quotePriceUsd > 0) {
      const quoteDelta = event.signedBaseSize * event.priceInQuote;
      const nextQuote = (balancesByAsset.get(event.quote) ?? 0) - quoteDelta;
      balancesByAsset.set(event.quote, nextQuote);
    }

    runningValue = portfolioUsdValue();
  }

  const endMs = Math.max(lastTimeMs, Math.floor(endTimeMs));
  if (endMs > lastTimeMs) weightedArea += runningValue * (endMs - lastTimeMs);
  const durationMs = Math.max(0, endMs - firstTimeMs);
  if (durationMs <= 0) return runningValue > 0 ? runningValue : null;
  const twab = weightedArea / durationMs;
  return twab > 0 ? twab : null;
};

export const summarizeTradingFills = (
  fills: HyperliquidFill[],
  resolver?: CoinResolver,
  context?: TradingClassificationContext,
  endTimeMs = Date.now()
): TradingSummary => {
  const outcomes = EMPTY_BUCKET();
  const xyz = EMPTY_BUCKET();
  const perps = EMPTY_BUCKET();
  let spotVolume = 0;
  let spotFeesPaid = 0;
  let unitVolume = 0;
  let unitFeesPaid = 0;
  let unitTrades = 0;
  const unitTokensSeen = new Set<string>();
  const outcomesSeries = emptyPnlSeriesMaps();
  const xyzSeries = emptyPnlSeriesMaps();
  const perpsSeries = emptyPnlSeriesMaps();
  const spotSeries = emptyVolumeSeriesMaps();
  const unitSeries = emptyVolumeSeriesMaps();
  const classificationContext: TradingClassificationContext = context ?? {
    knownSpotCoins: new Set<string>(),
    knownPerpCoins: new Set<string>(),
    knownOutcomeCoins: new Set<string>(),
    knownUnitSpotIds: new Set<string>(),
  };

  for (const fill of fills) {
    const rawCoin = getFillCoinRaw(fill);
    const resolvedCoin = resolver ? resolver(rawCoin) : rawCoin;
    const coinUpper = resolvedCoin.toUpperCase();
    const rawCoinUpper = rawCoin.toUpperCase();
    const dirUpper = readStringKeys(fill, ["dir", "side"]).toUpperCase();
    const volume = fillVolume(fill);
    const pnl = fillPnl(fill);
    const timeMs = getFillTime(fill);
    const outcomeFill = isOutcomesCoin(coinUpper, rawCoinUpper, dirUpper, classificationContext);

    const addPnlPoint = (
      target: ReturnType<typeof emptyPnlSeriesMaps>,
      pointVolume: number,
      pointPnl: number
    ) => {
      if (timeMs <= 0) return;
      for (const granularity of ["day", "week", "month", "year"] as const) {
        const key = periodKeyByGranularity(timeMs, granularity);
        if (!key) continue;
        const prev = target[granularity].get(key) ?? { volume: 0, pnl: 0 };
        target[granularity].set(key, {
          volume: prev.volume + pointVolume,
          pnl: prev.pnl + pointPnl,
        });
      }
    };
    const addVolumePoint = (target: ReturnType<typeof emptyVolumeSeriesMaps>, pointVolume: number) => {
      if (timeMs <= 0) return;
      for (const granularity of ["day", "week", "month", "year"] as const) {
        const key = periodKeyByGranularity(timeMs, granularity);
        if (!key) continue;
        target[granularity].set(key, (target[granularity].get(key) ?? 0) + pointVolume);
      }
    };

    if (outcomeFill) {
      update(outcomes, fill);
      addPnlPoint(outcomesSeries, volume, pnl);
    }

    if (isXyzCoin(coinUpper)) {
      update(xyz, fill);
      addPnlPoint(xyzSeries, volume, pnl);
    }

    if (isSpotTrade(coinUpper, rawCoinUpper, classificationContext) && !outcomeFill) {
      const feePaid = spotFeeUsdFromFill(fill);
      spotVolume += volume;
      spotFeesPaid += feePaid;
      addVolumePoint(spotSeries, volume);
      const unitTokenFromPair = classificationContext.knownUnitSpotIds.has(rawCoinUpper)
        ? parseSpotPair(coinUpper)?.base ?? null
        : null;
      const unitToken = matchUnitToken(unitTokenFromPair ?? coinUpper);
      if (unitToken) {
        unitVolume += volume;
        unitFeesPaid += unitFeeUsdFromFill(fill);
        unitTrades += 1;
        unitTokensSeen.add(unitToken);
        addVolumePoint(unitSeries, volume);
      }
    }

    if (isPerpTrade(dirUpper, coinUpper, rawCoinUpper, classificationContext)) {
      update(perps, fill);
      addPnlPoint(perpsSeries, volume, pnl);
    }
  }

  const totalVolume = outcomes.volume + spotVolume + perps.volume;
  const spotTwab = computeSpotTwabUsd(fills, resolver ?? ((coin) => coin), classificationContext, endTimeMs);
  const unitTwab = computeUnitTwabUsd(fills, resolver ?? ((coin) => coin), classificationContext, endTimeMs);

  return {
    totals: {
      fills: fills.length,
      outcomes,
      xyz,
      perps,
      spotVolume,
      spotFeesPaid,
      spotTwab,
      vaultTwab: null,
      hypeStakingTwab: null,
      unitVolume,
      unitFeesPaid,
      unitTrades,
      unitTokens: UNIT_TOKEN_LIST.filter((token) => unitTokensSeen.has(token)),
      unitTwab,
      totalVolume,
    },
    winrates: {
      outcomes: winrate(outcomes),
      xyz: winrate(xyz),
      perps: winrate(perps),
    },
    charts: {
      outcomes: {
        day: [...outcomesSeries.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        week: [...outcomesSeries.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        month: [...outcomesSeries.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        year: [...outcomesSeries.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
      },
      xyz: {
        day: [...xyzSeries.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        week: [...xyzSeries.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        month: [...xyzSeries.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        year: [...xyzSeries.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
      },
      perps: {
        day: [...perpsSeries.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        week: [...perpsSeries.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        month: [...perpsSeries.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
        year: [...perpsSeries.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, volume: v.volume, pnl: v.pnl })),
      },
      spot: {
        day: [...spotSeries.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
        week: [...spotSeries.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
        month: [...spotSeries.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
        year: [...spotSeries.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
      },
      unit: {
        day: [...unitSeries.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
        week: [...unitSeries.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
        month: [...unitSeries.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
        year: [...unitSeries.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
      },
      spotTwab: {
        day: [],
        week: [],
        month: [],
        year: [],
      },
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
  warnings.push(
    "Spot TWAB is computed from spot fills as a reconstructed time-weighted USD balance (fill-price based, using pair quotes and propagated USD cross-prices when possible)."
  );

  const resolver = buildSpotCoinResolver(spotMeta);
  const summary = summarizeTradingFills(fills, resolver, {
    knownSpotCoins: buildSpotCoinSet(spotMeta, resolver),
    knownPerpCoins: buildPerpCoinSet(perpMeta),
    knownOutcomeCoins: outcomeMeta ? buildOutcomeCoinSet(outcomeMeta) : new Set<string>(),
    knownUnitSpotIds: buildUnitSpotIdSet(spotMeta),
  }, endTime);
  let spotTwab = summary.totals.spotTwab;
  let vaultTwab: number | null = null;
  let portfolioRequestUsed = 0;
  let stakingRequestUsed = 0;
  let vaultRequestUsed = 0;
  try {
    portfolioRequestUsed = 1;
    const portfolio = await fetchHyperliquidInfo<PortfolioResponse>({ type: "portfolio", user: address });
    const allTime = portfolio.find((row) => Array.isArray(row) && row[0] === "allTime")?.[1];
    // Spot TWAB should use spot-state history first; fallback to allTime account history if missing.
    const officialSpotHistory =
      (allTime?.spotState?.accountValueHistory as PortfolioHistoryPoint[] | undefined) ??
      (allTime?.accountValueHistory as PortfolioHistoryPoint[] | undefined) ??
      [];
    const officialSpotPoints = historyToValuePoints(officialSpotHistory);
    const officialSpotTwab = computeTwabUsdFromValuePoints(officialSpotPoints, endTime / 1000);
    const anchoredUnitTwab = computeUnitTwabUsd(
      fills,
      resolver,
      {
        knownSpotCoins: buildSpotCoinSet(spotMeta, resolver),
        knownPerpCoins: buildPerpCoinSet(perpMeta),
        knownOutcomeCoins: outcomeMeta ? buildOutcomeCoinSet(outcomeMeta) : new Set<string>(),
        knownUnitSpotIds: buildUnitSpotIdSet(spotMeta),
      },
      endTime,
      officialSpotPoints.length > 0 ? officialSpotPoints[0].timeSec * 1000 : undefined
    );
    if (anchoredUnitTwab !== null) {
      summary.totals.unitTwab = anchoredUnitTwab;
    }

    try {
      const [vaultEquities, nonFundingRange] = await Promise.all([
        fetchHyperliquidInfo<UserVaultEquity[]>({ type: "userVaultEquities", user: address }),
        fetchTimeRangeWithSplit<NonFundingUpdate>({
          type: "userNonFundingLedgerUpdates",
          user: address,
          startTime,
          endTime,
          pageLimit: 2000,
          minWindowMs: 30 * 60 * 1000,
          maxRequests: 120,
        }),
      ]);
      vaultRequestUsed += 1 + nonFundingRange.requestsUsed;

      const vaultAddresses = new Set<string>();
      for (const v of Array.isArray(vaultEquities) ? vaultEquities : []) {
        const vaultAddress = readStringKeys(v, ["vaultAddress"]).toLowerCase();
        if (vaultAddress) vaultAddresses.add(vaultAddress);
      }
      for (const row of nonFundingRange.rows) {
        const delta = (row.delta ?? {}) as Record<string, unknown>;
        const vaultAddress = readStringKeys(delta, ["vault"]).toLowerCase();
        if (vaultAddress) vaultAddresses.add(vaultAddress);
      }

      const vaultHistoryEntries = await Promise.all(
        [...vaultAddresses].map(async (vaultAddress) => {
          try {
            const details = await fetchHyperliquidInfo<VaultDetailsResponse>({
              type: "vaultDetails",
              vaultAddress,
              user: address,
            });
            const allTime = (details.portfolio ?? []).find((row) => Array.isArray(row) && row[0] === "allTime")?.[1];
            const points = historyToValuePoints((allTime?.accountValueHistory as PortfolioHistoryPoint[] | undefined) ?? []);
            return [vaultAddress, points] as const;
          } catch {
            return [vaultAddress, [] as Array<{ timeSec: number; valueUsd: number }>] as const;
          }
        })
      );
      vaultRequestUsed += vaultHistoryEntries.length;

      const vaultHistoriesByAddress = new Map<string, Array<{ timeSec: number; valueUsd: number }>>(vaultHistoryEntries);
      vaultTwab = computeVaultTwabUsd(
        officialSpotPoints,
        Array.isArray(vaultEquities) ? vaultEquities : [],
        nonFundingRange.rows,
        vaultHistoriesByAddress,
        endTime / 1000
      );
      if (vaultTwab !== null && officialSpotTwab !== null) {
        spotTwab = Math.max(officialSpotTwab - vaultTwab, 0);
        warnings.push("Spot/Vault TWAB split uses method 1: userNonFundingLedgerUpdates flows + vaultDetails NAV histories.");
      }
    } catch {
      warnings.push("Could not compute Vault TWAB split from vault flows/NAV history; fallback to merged Spot TWAB.");
    }

    if (officialSpotTwab !== null) {
      summary.charts.spotTwab = computeTwabSeriesUsdFromValuePoints(officialSpotPoints, endTime / 1000);
      if (spotTwab === summary.totals.spotTwab) {
        spotTwab = officialSpotTwab;
        warnings.push("Spot TWAB now uses Hyperliquid portfolio spotState.accountValueHistory (official source).");
      }
    }
  } catch {
    warnings.push("Could not load portfolio spotState history, so Spot TWAB uses fill-based reconstruction fallback.");
  }

  try {
    const [history, stakingSummary] = await Promise.all([
      fetchHyperliquidInfo<DelegatorHistoryUpdate[]>({ type: "delegatorHistory", user: address }),
      fetchHyperliquidInfo<DelegatorSummary>({ type: "delegatorSummary", user: address }),
    ]);
    stakingRequestUsed = 2;
    const delegatedNow = abs(toFiniteNumber((stakingSummary as DelegatorSummary)?.delegated ?? 0));
    const stakingTwab = computeStakingTwabFromDelegatorHistory(
      Array.isArray(history) ? history : [],
      endTime,
      delegatedNow
    );
    summary.totals.hypeStakingTwab = stakingTwab;
    if (stakingTwab !== null) {
      warnings.push("HYPE staking TWAB is computed from Hyperliquid staking-native delegatorHistory + delegatorSummary (multi-validator aware).");
    } else {
      warnings.push("HYPE staking TWAB unavailable (no staking ledger events detected).");
    }
  } catch {
    warnings.push("Could not load staking-native delegator history/summary, so HYPE staking TWAB is unavailable.");
  }

  summary.totals.spotTwab = spotTwab;
  if (summary.totals.spotTwab !== null && summary.totals.spotVolume > 0) {
    const unitExposureShare = Math.max(0, Math.min(1, summary.totals.unitVolume / summary.totals.spotVolume));
    summary.totals.unitTwab = summary.totals.spotTwab * unitExposureShare;
    warnings.push("Unit TWAB uses exposure-share method: Spot TWAB × (Unit Volume / Spot Volume), clamped to [0,1].");
  }
  summary.totals.vaultTwab = vaultTwab;
  if (summary.totals.spotTwab === null) {
    warnings.push("Spot TWAB was unavailable (official history missing and fallback had insufficient data).");
  }

  return {
    source: "api",
    address,
    period: { startTime, endTime },
    meta: {
      requestsUsed:
        rangeResult.requestsUsed +
        (usedFallback ? 1 : 0) +
        2 +
        outcomeMetaRequestUsed +
        portfolioRequestUsed +
        stakingRequestUsed +
        vaultRequestUsed,
      usedFallback,
      truncated: rangeResult.truncated,
      warnings,
    },
    ...summary,
  };
};
