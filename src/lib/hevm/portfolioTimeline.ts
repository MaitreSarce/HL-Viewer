import { normalizeAddress } from "@/lib/dashboard/shared";
import { ClassifiedActivity, HevmProtocolAdapter, PortfolioSegment, Position, PriceContext, PriceResult } from "@/lib/hevm/types";

type BuildTimelineArgs = {
  wallet: string;
  activities: ClassifiedActivity[];
  adapters: HevmProtocolAdapter[];
  priceContext: PriceContext;
  endTimestamp: number;
};

const DAY_SECONDS = 86400;

const nonZero = (value: number) => Number.isFinite(value) && Math.abs(value) > 1e-14;

const balanceKey = (token: string) => {
  const t = (token || "HYPE").trim();
  if (!t) return "HYPE";
  return t.toUpperCase();
};

const buildWalletPositions = async (
  balances: Map<string, number>,
  timestamp: number,
  blockNumber: number,
  priceContext: PriceContext
) => {
  const positions: Position[] = [];
  const priceSources: PriceResult[] = [];
  let totalUsd = 0;

  for (const [asset, amount] of balances.entries()) {
    if (!nonZero(amount)) continue;
    const price = await priceContext.resolvePriceUsd(asset, timestamp);
    priceSources.push(price);
    const priceUsd = price.priceUsd ?? 0;
    const valueUsd = amount * priceUsd;
    totalUsd += valueUsd;
    positions.push({
      protocol: "wallet",
      category: "wallet_balance",
      asset,
      amount,
      valueUsd,
      blockNumber,
      timestamp,
      source: "wallet_balance",
    });
  }

  return { positions, priceSources, totalUsd };
};

const cacheAdapterPositions = async (
  wallet: string,
  blockNumber: number,
  adapters: HevmProtocolAdapter[],
  cache: Map<string, Position[]>
) => {
  const merged: Position[] = [];
  for (const adapter of adapters) {
    const cacheKey = `${adapter.id}:${blockNumber}`;
    if (cache.has(cacheKey)) {
      merged.push(...(cache.get(cacheKey) ?? []));
      continue;
    }
    try {
      const positions = await adapter.getPositions(wallet, blockNumber);
      cache.set(cacheKey, positions);
      merged.push(...positions);
    } catch {
      cache.set(cacheKey, []);
    }
  }
  return merged;
};

const buildDefiPositionsUsd = async (
  positions: Position[],
  timestamp: number,
  priceContext: PriceContext
) => {
  const out: Position[] = [];
  const priceSources: PriceResult[] = [];
  let totalUsd = 0;

  for (const position of positions) {
    const asset = balanceKey(position.asset);
    const price = await priceContext.resolvePriceUsd(asset, timestamp);
    priceSources.push(price);
    const valueUsd = (price.priceUsd ?? 0) * position.amount;
    totalUsd += valueUsd;
    out.push({
      ...position,
      asset,
      valueUsd,
      timestamp,
    });
  }
  return { out, priceSources, totalUsd };
};

const applyActivityToBalances = (wallet: string, balances: Map<string, number>, activity: ClassifiedActivity) => {
  const token = balanceKey(activity.token || "HYPE");
  const amount = Number.isFinite(activity.amount) ? activity.amount ?? 0 : 0;
  if (!nonZero(amount)) return;

  const previous = balances.get(token) ?? 0;
  let next = previous;
  if (activity.direction === "in") next = previous + amount;
  else if (activity.direction === "out") next = previous - amount;
  else if (activity.direction === "self") next = previous;

  const from = normalizeAddress(activity.from || "");
  const to = normalizeAddress(activity.to || "");
  if (activity.direction === "unknown") {
    if (from === wallet && to !== wallet) next = previous - amount;
    else if (to === wallet && from !== wallet) next = previous + amount;
  }

  if (!Number.isFinite(next)) return;
  const clamped = Math.max(0, next);
  if (!nonZero(clamped)) balances.delete(token);
  else balances.set(token, clamped);
};

const compressActivitiesByDay = (activities: ClassifiedActivity[]) => {
  type BucketRow = {
    dayStart: number;
    blockNumber: number;
    from?: string;
    to?: string;
    deltas: Map<string, number>;
  };

  const buckets = new Map<number, BucketRow>();
  for (const activity of activities) {
    if (!Number.isFinite(activity.timestamp) || activity.timestamp <= 0) continue;
    const dayStart = Math.floor(activity.timestamp / DAY_SECONDS) * DAY_SECONDS;
    const token = balanceKey(activity.token || "HYPE");
    const amount = Number.isFinite(activity.amount) ? Math.max(0, activity.amount ?? 0) : 0;

    const bucket = buckets.get(dayStart) ?? {
      dayStart,
      blockNumber: activity.blockNumber,
      from: activity.from,
      to: activity.to,
      deltas: new Map<string, number>(),
    };
    bucket.blockNumber = Math.max(bucket.blockNumber, activity.blockNumber);

    const current = bucket.deltas.get(token) ?? 0;
    let next = current;
    if (activity.direction === "in") next += amount;
    else if (activity.direction === "out") next -= amount;
    else if (activity.direction === "unknown") next = current;
    bucket.deltas.set(token, next);
    buckets.set(dayStart, bucket);
  }

  const synthetic: ClassifiedActivity[] = [];
  for (const bucket of [...buckets.values()].sort((a, b) => a.dayStart - b.dayStart)) {
    for (const [token, delta] of bucket.deltas.entries()) {
      if (!nonZero(delta)) continue;
      synthetic.push({
        txHash: `synthetic-${bucket.dayStart}-${token}`,
        blockNumber: bucket.blockNumber,
        timestamp: bucket.dayStart + DAY_SECONDS - 1,
        from: bucket.from,
        to: bucket.to,
        type: delta >= 0 ? "erc20_transfer" : "internal_transfer",
        token,
        amountRaw: String(Math.abs(delta)),
        amount: Math.abs(delta),
        direction: delta >= 0 ? "in" : "out",
        protocolId: "timelineSynthetic",
        protocolName: "Timeline Synthetic",
        category: "erc20",
        confidence: 1,
      });
    }
  }
  return synthetic;
};

export const buildPortfolioTimeline = async (
  args: BuildTimelineArgs
): Promise<{ segments: PortfolioSegment[]; currentPositions: Position[]; currentPortfolioUsd: number }> => {
  const wallet = normalizeAddress(args.wallet);
  const sorted = [...args.activities]
    .filter((activity) => Number.isFinite(activity.timestamp) && activity.timestamp > 0)
    .sort((a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber));

  const timelineActivities = compressActivitiesByDay(sorted);

  if (timelineActivities.length === 0) {
    return { segments: [], currentPositions: [], currentPortfolioUsd: 0 };
  }

  const balances = new Map<string, number>();
  const segments: PortfolioSegment[] = [];
  const adapterCache = new Map<string, Position[]>();

  let lastTs = timelineActivities[0].timestamp;
  let lastBlock = timelineActivities[0].blockNumber;

  for (const activity of timelineActivities) {
    const ts = Math.max(lastTs, activity.timestamp);
    const durationSeconds = Math.max(0, ts - lastTs);

    const walletSnapshot = await buildWalletPositions(balances, lastTs, lastBlock, args.priceContext);
    const defiRaw = await cacheAdapterPositions(wallet, lastBlock, args.adapters, adapterCache);
    const defiSnapshot = await buildDefiPositionsUsd(defiRaw, lastTs, args.priceContext);

    const totalUsd = walletSnapshot.totalUsd + defiSnapshot.totalUsd;
    const mergedPositions = [...walletSnapshot.positions, ...defiSnapshot.out];
    const mergedSources = [...walletSnapshot.priceSources, ...defiSnapshot.priceSources];

    segments.push({
      startTimestamp: lastTs,
      endTimestamp: ts,
      durationSeconds,
      totalUsd,
      contribution: totalUsd * durationSeconds,
      positions: mergedPositions,
      priceSources: mergedSources,
    });

    applyActivityToBalances(wallet, balances, activity);
    lastTs = ts;
    lastBlock = Math.max(lastBlock, activity.blockNumber);
  }

  const endTs = Math.max(lastTs, args.endTimestamp);
  const finalWalletSnapshot = await buildWalletPositions(balances, lastTs, lastBlock, args.priceContext);
  const finalDefiRaw = await cacheAdapterPositions(wallet, lastBlock, args.adapters, adapterCache);
  const finalDefiSnapshot = await buildDefiPositionsUsd(finalDefiRaw, lastTs, args.priceContext);
  const finalTotalUsd = finalWalletSnapshot.totalUsd + finalDefiSnapshot.totalUsd;
  const finalDuration = Math.max(0, endTs - lastTs);

  segments.push({
    startTimestamp: lastTs,
    endTimestamp: endTs,
    durationSeconds: finalDuration,
    totalUsd: finalTotalUsd,
    contribution: finalTotalUsd * finalDuration,
    positions: [...finalWalletSnapshot.positions, ...finalDefiSnapshot.out],
    priceSources: [...finalWalletSnapshot.priceSources, ...finalDefiSnapshot.priceSources],
  });

  return {
    segments,
    currentPositions: [...finalWalletSnapshot.positions, ...finalDefiSnapshot.out],
    currentPortfolioUsd: finalTotalUsd,
  };
};
