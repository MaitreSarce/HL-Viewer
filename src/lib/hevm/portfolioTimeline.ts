import { normalizeAddress } from "@/lib/dashboard/shared";
import { ClassifiedActivity, HevmProtocolAdapter, PortfolioSegment, Position, PriceContext, PriceResult } from "@/lib/hevm/types";

export const buildPortfolioTimeline = async (args: {
  wallet: string;
  activities: ClassifiedActivity[];
  adapters: HevmProtocolAdapter[];
  priceContext: PriceContext;
  endTimestamp: number;
}): Promise<{ segments: PortfolioSegment[]; currentPositions: Position[]; currentPortfolioUsd: number }> => {
  const wallet = normalizeAddress(args.wallet);
  const sorted = [...args.activities].sort((a, b) => a.timestamp - b.timestamp);
  const balances = new Map<string, number>();
  const positions: Position[] = [];
  const segments: PortfolioSegment[] = [];

  if (sorted.length === 0) {
    return { segments: [], currentPositions: [], currentPortfolioUsd: 0 };
  }

  const computePortfolio = async (timestamp: number): Promise<{ totalUsd: number; priceSources: PriceResult[]; pos: Position[] }> => {
    let totalUsd = 0;
    const priceSources: PriceResult[] = [];
    const pos: Position[] = [];

    for (const [asset, amount] of balances.entries()) {
      if (!Number.isFinite(amount) || amount === 0) continue;
      const price = await args.priceContext.resolvePriceUsd(asset, timestamp);
      priceSources.push(price);
      const valueUsd = price.priceUsd ? amount * price.priceUsd : 0;
      totalUsd += valueUsd;
      pos.push({
        protocol: "wallet",
        category: "wallet_balance",
        asset,
        amount,
        valueUsd,
        blockNumber: 0,
        timestamp,
        source: "wallet_balance",
      });
    }

    return { totalUsd, priceSources, pos };
  };

  let lastTs = sorted[0].timestamp;

  for (const activity of sorted) {
    const nowTs = Math.max(activity.timestamp, lastTs);
    const snapBefore = await computePortfolio(lastTs);
    const duration = Math.max(0, nowTs - lastTs);
    segments.push({
      startTimestamp: lastTs,
      endTimestamp: nowTs,
      durationSeconds: duration,
      totalUsd: snapBefore.totalUsd,
      contribution: snapBefore.totalUsd * duration,
      positions: snapBefore.pos,
      priceSources: snapBefore.priceSources,
    });

    const token = (activity.token || "HYPE").toUpperCase();
    const amount = activity.amount ?? 0;
    if (amount > 0) {
      const prev = balances.get(token) ?? 0;
      if (activity.direction === "in") balances.set(token, prev + amount);
      else if (activity.direction === "out") balances.set(token, prev - amount);
    }

    for (const adapter of args.adapters) {
      if (adapter.id !== activity.protocolId) continue;
      const extraPositions = await adapter.getPositions(wallet, activity.blockNumber).catch(() => []);
      for (const p of extraPositions) positions.push(p);
    }

    lastTs = nowTs;
  }

  const finalSnap = await computePortfolio(lastTs);
  const endTs = Math.max(args.endTimestamp, lastTs);
  const finalDuration = Math.max(0, endTs - lastTs);
  segments.push({
    startTimestamp: lastTs,
    endTimestamp: endTs,
    durationSeconds: finalDuration,
    totalUsd: finalSnap.totalUsd,
    contribution: finalSnap.totalUsd * finalDuration,
    positions: finalSnap.pos,
    priceSources: finalSnap.priceSources,
  });

  return {
    segments,
    currentPositions: finalSnap.pos,
    currentPortfolioUsd: finalSnap.totalUsd,
  };
};
