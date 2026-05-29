import { buildAdapters } from "@/lib/hevm/adapters";
import { indexWalletActivity } from "@/lib/hevm/indexer";
import {
  calculateActivePeriods,
  calculateBridgeVolume,
  calculateFeesPaidUsd,
  calculateTxCounts,
  calculateTwabUsd,
  calculateUniqueContracts,
  calculateVolumeUsd,
  calculateWalletAge,
} from "@/lib/hevm/metrics";
import { buildPortfolioTimeline } from "@/lib/hevm/portfolioTimeline";
import { createPriceContext } from "@/lib/hevm/pricing";
import { fetchProtocolRegistry } from "@/lib/hevm/protocolRegistry";
import { ClassifiedActivity, HevmDashboardStats, RawActivity } from "@/lib/hevm/types";

const classifyActivities = (
  activities: RawActivity[],
  adapters: ReturnType<typeof buildAdapters>
): { classified: ClassifiedActivity[]; unclassified: RawActivity[] } => {
  const classified: ClassifiedActivity[] = [];
  const unclassified: RawActivity[] = [];

  for (const activity of activities) {
    let selected: ClassifiedActivity | null = null;
    for (const adapter of adapters) {
      const candidates = adapter.classifyActivity(activity);
      if (candidates.length === 0) continue;
      const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
      if (!selected || best.confidence > selected.confidence) selected = best;
    }
    if (selected) classified.push(selected);
    else unclassified.push(activity);
  }

  return { classified, unclassified };
};

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

export const buildHevmDashboardStats = async (wallet: string): Promise<HevmDashboardStats> => {
  const now = Math.floor(Date.now() / 1000);

  const protocols = await safe(() => fetchProtocolRegistry(), []);
  const adapters = buildAdapters(protocols);

  const indexer = await safe(
    () => indexWalletActivity(wallet),
    { activities: [], warnings: ["Indexer failed, returning empty dataset."], errors: [], dataSourcesUsed: [] }
  );
  const rawActivities = indexer.activities;

  const { classified, unclassified } = classifyActivities(rawActivities, adapters);

  const { context: priceContext, warmup, ignoredTokens, priceErrors } = await createPriceContext();
  await safe(
    () =>
      warmup(
        classified.map((activity) => ({
          token: activity.token || "HYPE",
          timestamp: activity.timestamp,
        }))
      ),
    undefined
  );

  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
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

  const timeline = await safe(
    () =>
      buildPortfolioTimeline({
        wallet,
        activities: classified,
        adapters,
        priceContext,
        endTimestamp: now,
      }),
    { segments: [], currentPositions: [], currentPortfolioUsd: 0 }
  );

  const twab = calculateTwabUsd(timeline.segments);
  const contracts = calculateUniqueContracts(rawActivities, wallet);
  const activePeriods = calculateActivePeriods(rawActivities);
  const walletAge = calculateWalletAge(rawActivities);
  const txCounts = calculateTxCounts(rawActivities, wallet);
  const feesPaidUsd = await calculateFeesPaidUsd(rawActivities, wallet, async (timestamp) => {
    const price = await priceContext.resolvePriceUsd("HYPE", timestamp);
    return price.priceUsd ?? 0;
  });

  const protocolClassification: Record<string, number> = {};
  for (const activity of classified) {
    const key = `${activity.protocolName} (${activity.category})`;
    protocolClassification[key] = (protocolClassification[key] ?? 0) + 1;
  }

  const unknownContracts = [
    ...new Set(
      [
        ...unclassified.map((activity) => activity.contractAddress || activity.to || ""),
        ...classified
          .filter((activity) => activity.category === "unknown")
          .map((activity) => activity.contractAddress || activity.to || ""),
      ]
        .map((addr) => addr.toLowerCase().trim())
        .filter((addr) => addr.startsWith("0x") && addr.length === 42)
    ),
  ];

  const confidenceScore = Math.max(
    0,
    Math.min(
      1,
      1 - (
        ignoredTokens.length * 0.01 +
        unknownContracts.length * 0.005 +
        unclassified.length * 0.001 +
        priceErrors.length * 0.015
      )
    )
  );

  return {
    wallet,
    chainId: 999,
    startTime: twab.startTime || walletAge.firstSeenTimestamp || now,
    endTime: twab.endTime || now,
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
      unknownContracts,
      unclassifiedActivities: unclassified,
      priceErrors,
      dataSourcesUsed: [...new Set([...indexer.dataSourcesUsed, "defillama:protocols", "defillama:prices", "rpc:eth_call"])],
      confidenceScore,
      volumeBreakdownByCategory: {
        total: volume.totalVolumeUsd,
        swap: volume.swapVolumeUsd,
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
      protocolClassification,
      twabSummary: {
        durationSeconds: twab.durationSeconds,
        area: twab.area,
        segmentCount: timeline.segments.length,
      },
      indexer: {
        warnings: indexer.warnings,
        errors: indexer.errors,
      },
    },
  };
};

