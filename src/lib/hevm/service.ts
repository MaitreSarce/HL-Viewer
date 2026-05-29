import { allAdapters } from "@/lib/hevm/adapters";
import { indexWalletActivity } from "@/lib/hevm/indexer";
import {
  calculateActivePeriods,
  calculateBridgeVolume,
  calculateTxCounts,
  calculateTwabUsd,
  calculateUniqueContracts,
  calculateVolumeUsd,
  calculateWalletAge,
  calculateFeesPaidUsd,
} from "@/lib/hevm/metrics";
import { buildPortfolioTimeline } from "@/lib/hevm/portfolioTimeline";
import { createPriceContext } from "@/lib/hevm/pricing";
import { fetchProtocolRegistry } from "@/lib/hevm/protocolRegistry";
import { ClassifiedActivity, HevmDashboardStats, RawActivity } from "@/lib/hevm/types";

const classifyActivities = (activities: RawActivity[]): { classified: ClassifiedActivity[]; unclassified: RawActivity[] } => {
  const classified: ClassifiedActivity[] = [];
  const unclassified: RawActivity[] = [];

  for (const activity of activities) {
    let matched = false;
    for (const adapter of allAdapters) {
      const parts = adapter.classifyActivity(activity);
      if (parts.length > 0) {
        matched = true;
        classified.push(...parts);
      }
    }
    if (!matched) unclassified.push(activity);
  }

  return { classified, unclassified };
};

export const buildHevmDashboardStats = async (wallet: string): Promise<HevmDashboardStats> => {
  const endTime = Math.floor(Date.now() / 1000);
  const protocols = await fetchProtocolRegistry();
  const rawActivities = await indexWalletActivity(wallet);
  const { classified, unclassified } = classifyActivities(rawActivities);
  const { context: priceContext, ignoredTokens, priceErrors } = await createPriceContext();

  const adapterById = new Map(allAdapters.map((a) => [a.id, a]));
  const volume = await calculateVolumeUsd(classified, async (activity) => {
    const adapter = adapterById.get(activity.protocolId);
    if (!adapter) return 0;
    return adapter.getVolumeUsd(activity, priceContext);
  });

  const bridge = await calculateBridgeVolume(classified, async (activity) => {
    const adapter = adapterById.get(activity.protocolId);
    if (!adapter) return 0;
    return adapter.getVolumeUsd(activity, priceContext);
  });

  const timeline = await buildPortfolioTimeline({
    wallet,
    activities: classified,
    adapters: allAdapters,
    priceContext,
    endTimestamp: endTime,
  });

  const twab = calculateTwabUsd(timeline.segments);
  const contracts = calculateUniqueContracts(rawActivities, wallet);
  const activePeriods = calculateActivePeriods(rawActivities);
  const walletAge = calculateWalletAge(rawActivities);
  const txCounts = calculateTxCounts(rawActivities, wallet);
  const feesPaidUsd = await calculateFeesPaidUsd(rawActivities, wallet, async (timestamp) => {
    const p = await priceContext.resolvePriceUsd("HYPE", timestamp);
    return p.priceUsd ?? 0;
  });

  const categoryCount: Record<string, number> = {};
  for (const c of classified) categoryCount[c.category] = (categoryCount[c.category] ?? 0) + 1;

  const confidenceScore = Math.max(
    0,
    Math.min(
      1,
      1 - (ignoredTokens.length * 0.01 + unclassified.length * 0.001 + priceErrors.length * 0.02)
    )
  );

  return {
    wallet,
    chainId: 999,
    startTime: twab.startTime,
    endTime: twab.endTime || endTime,
    twabUsd: twab.twabUsd,
    twabSegments: timeline.segments,
    currentPortfolioUsd: timeline.currentPortfolioUsd,
    currentPositions: timeline.currentPositions,
    volume,
    contracts,
    activePeriods,
    walletAge,
    bridge,
    txCounts,
    feesPaidUsd,
    debug: {
      ignoredTokens,
      unknownContracts: [...new Set(unclassified.map((a) => a.contractAddress).filter(Boolean) as string[])],
      unclassifiedActivities: unclassified,
      priceErrors,
      dataSourcesUsed: [
        "hyperscan:txlist",
        "hyperscan:tokentx",
        "hyperscan:txlistinternal",
        "rpc:eth_getTransactionReceipt",
        "defillama:protocols",
        "defillama:prices",
      ],
      confidenceScore,
      volumeBreakdownByCategory: {
        dex: volume.swapVolumeUsd,
        bridge: volume.bridgeVolumeUsd,
        lending: volume.lendingVolumeUsd,
        staking: volume.stakingVolumeUsd,
        transfer: volume.transferVolumeUsd,
        other: volume.otherContractVolumeUsd,
      },
      txCountBreakdown: {
        sent: txCounts.sentAccountTxCount,
        received: txCounts.receivedAccountTxCount,
        erc20: txCounts.erc20TransferCount,
        internal: txCounts.internalTxCount,
        interactions: txCounts.contractInteractionCount,
        all: txCounts.allActivityTxCount,
      },
      protocolClassification: categoryCount,
    },
  };
};
