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

const HYPEREVMSCAN_ADDRESS_URL = "https://hyperevmscan.io/address";
const HYPEREVMSCAN_TXS_URL = "https://hyperevmscan.io/txs";
const FETCH_TIMEOUT_MS = 6000;
const TWAB_SNAPSHOT_GRANULARITY_SECONDS = 3600;
const HEVM_STATS_CACHE_TTL_MS = 5 * 60 * 1000;
const HEVM_STATS_CACHE_MAX_SIZE = 200;

type HevmStatsCacheEntry = {
  expiresAtMs: number;
  value: HevmDashboardStats;
};

const hevmStatsCache = new Map<string, HevmStatsCacheEntry>();

const toStableTwabSnapshotTimestamp = (timestampSec: number) => {
  const safe = Math.max(0, Math.floor(timestampSec));
  return Math.floor(safe / TWAB_SNAPSHOT_GRANULARITY_SECONDS) * TWAB_SNAPSHOT_GRANULARITY_SECONDS;
};

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

const fetchExplorerTxTotal = async (wallet: string): Promise<number> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${HYPEREVMSCAN_ADDRESS_URL}/${wallet}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return 0;
    const html = await response.text();
    const match = html.match(/Transactions:\s*([0-9,]+)/i);
    if (!match) return 0;
    const n = Number.parseInt(match[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timeout);
  }
};

const parseExplorerTxTotalFromHtml = (html: string) => {
  const metaMatch = html.match(/Transactions:\s*([0-9,]+)/i);
  if (metaMatch) {
    const n = Number.parseInt(metaMatch[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const tableMatch = html.match(/A total of\s*([0-9,]+)\s*transactions found/i);
  if (tableMatch) {
    const n = Number.parseInt(tableMatch[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
};

const parseExplorerPageCount = (html: string) => {
  const match = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  if (!match) return 1;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const parseExplorerMinTimestamp = (html: string) => {
  const regex = /showLocalDate[^>]*>\s*<span[^>]*>(\d+)<\/span>/gi;
  const values: number[] = [];
  let m = regex.exec(html);
  while (m) {
    const ts = Number.parseInt(m[1], 10);
    if (Number.isFinite(ts) && ts > 0) values.push(ts);
    m = regex.exec(html);
  }
  if (values.length === 0) return 0;
  return Math.min(...values);
};

const fetchExplorerTxPageHtml = async (wallet: string, page: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${HYPEREVMSCAN_TXS_URL}?a=${wallet}&p=${page}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
};

const fetchExplorerSnapshot = async (wallet: string) => {
  const pageOneHtml = await fetchExplorerTxPageHtml(wallet, 1);
  if (!pageOneHtml) {
    return { totalTx: 0, firstSeenTimestamp: 0 };
  }

  const totalTx = parseExplorerTxTotalFromHtml(pageOneHtml);
  const pageCount = parseExplorerPageCount(pageOneHtml);
  let firstSeenTimestamp = parseExplorerMinTimestamp(pageOneHtml);

  if (pageCount <= 1) {
    return { totalTx, firstSeenTimestamp };
  }

  let left = 1;
  let right = pageCount;
  let lastNonEmptyPage = 1;
  let lastNonEmptyMinTs = firstSeenTimestamp;
  const pageCache = new Map<number, string>([[1, pageOneHtml]]);

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const html = pageCache.get(mid) ?? await fetchExplorerTxPageHtml(wallet, mid);
    if (!pageCache.has(mid) && html) pageCache.set(mid, html);
    if (!html) {
      right = mid - 1;
      continue;
    }
    const minTs = parseExplorerMinTimestamp(html);
    const hasRows = minTs > 0 && !/There are no matching entries/i.test(html);
    if (hasRows) {
      lastNonEmptyPage = mid;
      lastNonEmptyMinTs = minTs;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  if (lastNonEmptyPage > 1) {
    const html = pageCache.get(lastNonEmptyPage) ?? await fetchExplorerTxPageHtml(wallet, lastNonEmptyPage);
    const minTs = parseExplorerMinTimestamp(html);
    if (minTs > 0) lastNonEmptyMinTs = minTs;
  }

  if (lastNonEmptyMinTs > 0) firstSeenTimestamp = lastNonEmptyMinTs;
  return { totalTx, firstSeenTimestamp };
};

export const buildHevmDashboardStats = async (wallet: string): Promise<HevmDashboardStats> => {
  const now = Math.floor(Date.now() / 1000);
  const twabEndTimestamp = Math.max(0, Math.min(now, toStableTwabSnapshotTimestamp(now)));
  const cacheKey = `${wallet.toLowerCase()}:${twabEndTimestamp}`;
  const nowMs = Date.now();

  const cached = hevmStatsCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.value;
  }

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
  }, wallet);

  const bridge = await calculateBridgeVolume(classified, async (activity) => {
    const adapter = adapterById.get(activity.protocolId);
    if (!adapter) return 0;
    return adapter.getVolumeUsd(activity, priceContext);
  }, wallet);

  const timeline = await safe(
    () =>
      buildPortfolioTimeline({
        wallet,
        activities: classified,
        adapters,
        priceContext,
        endTimestamp: twabEndTimestamp,
      }),
    { segments: [], currentPositions: [], currentPortfolioUsd: 0 }
  );

  const twab = calculateTwabUsd(timeline.segments);
  const contracts = calculateUniqueContracts(rawActivities, wallet);
  const activePeriods = calculateActivePeriods(rawActivities);
  const walletAge = calculateWalletAge(rawActivities);
  const txCounts = calculateTxCounts(rawActivities, wallet);
  const normalTxCount = new Set(
    rawActivities.filter((activity) => activity.type === "normal_tx").map((activity) => activity.txHash)
  ).size;
  const explorerSnapshot = await safe(() => fetchExplorerSnapshot(wallet), { totalTx: 0, firstSeenTimestamp: 0 });
  const explorerTotalTxCount = explorerSnapshot.totalTx;
  const walletAgeWithExplorer =
    explorerSnapshot.firstSeenTimestamp > 0 &&
    (walletAge.firstSeenTimestamp <= 0 || explorerSnapshot.firstSeenTimestamp < walletAge.firstSeenTimestamp)
      ? {
          firstSeenTimestamp: explorerSnapshot.firstSeenTimestamp,
          ageSeconds: Math.max(0, now - explorerSnapshot.firstSeenTimestamp),
          ageDays: Math.floor(Math.max(0, now - explorerSnapshot.firstSeenTimestamp) / 86400),
        }
      : walletAge;
  const hypeNow = await priceContext.resolvePriceUsd("HYPE", now);
  const feesPaidUsd = await calculateFeesPaidUsd(rawActivities, wallet, async (timestamp) => {
    void timestamp;
    return hypeNow.priceUsd ?? 0;
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

  const result: HevmDashboardStats = {
    wallet,
    chainId: 999,
    startTime: twab.startTime || walletAgeWithExplorer.firstSeenTimestamp || now,
    endTime: twab.endTime || twabEndTimestamp,
    twabUsd: twab.twabUsd,
    twabSegments: timeline.segments,
    currentPortfolioUsd: timeline.currentPortfolioUsd,
    currentPositions: timeline.currentPositions,
    volume,
    contracts,
    activePeriods,
    walletAge: walletAgeWithExplorer,
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
        explorerTotal: explorerTotalTxCount,
        normal: normalTxCount,
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

  hevmStatsCache.set(cacheKey, {
    value: result,
    expiresAtMs: nowMs + HEVM_STATS_CACHE_TTL_MS,
  });

  if (hevmStatsCache.size > HEVM_STATS_CACHE_MAX_SIZE) {
    for (const [key, entry] of hevmStatsCache.entries()) {
      if (entry.expiresAtMs <= nowMs) hevmStatsCache.delete(key);
    }
    if (hevmStatsCache.size > HEVM_STATS_CACHE_MAX_SIZE) {
      const oldestKey = hevmStatsCache.keys().next().value;
      if (oldestKey) hevmStatsCache.delete(oldestKey);
    }
  }

  return result;
};
