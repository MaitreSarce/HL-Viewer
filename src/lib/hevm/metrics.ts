import { normalizeAddress, utcDayKey, utcMonthKey } from "@/lib/dashboard/shared";
import { isCoreBridgeSystemAddress } from "@/lib/hevm/bridge";
import { ClassifiedActivity, PortfolioSegment, RawActivity } from "@/lib/hevm/types";

const weekKey = (timestampMs: number) => {
  const d = new Date(timestampMs);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const isPositiveAmount = (activity: ClassifiedActivity) =>
  Number.isFinite(activity.amount) && (activity.amount ?? 0) > 0;

const toAmount = (activity: ClassifiedActivity) =>
  Number.isFinite(activity.amount) ? Math.max(0, activity.amount ?? 0) : 0;

const isBridgeLabeled = (activity: ClassifiedActivity) =>
  activity.category === "bridge" && (activity.confidence ?? 0) >= 0.85;

const isCoreSystemAddress = (value?: string) => {
  return isCoreBridgeSystemAddress(value);
};

const transferDedupeKey = (activity: ClassifiedActivity) =>
  [
    activity.txHash,
    activity.type,
    normalizeAddress(activity.from || ""),
    normalizeAddress(activity.to || ""),
    normalizeAddress(activity.contractAddress || ""),
    activity.token || "",
    activity.amountRaw || "",
    activity.logIndex ?? "",
    activity.traceId ?? "",
  ].join("|");

const dedupeTransfers = (activities: ClassifiedActivity[]) => {
  const seen = new Set<string>();
  const out: ClassifiedActivity[] = [];
  for (const activity of activities) {
    const key = transferDedupeKey(activity);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(activity);
  }
  return out;
};

const groupByTxHash = (activities: ClassifiedActivity[]) => {
  const sorted = [...activities].sort(
    (a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber)
  );
  const groups = new Map<string, ClassifiedActivity[]>();
  for (const activity of sorted) {
    const key = activity.txHash || `${activity.blockNumber}:${activity.timestamp}`;
    const list = groups.get(key);
    if (list) list.push(activity);
    else groups.set(key, [activity]);
  }
  return groups;
};

const resolveTxSender = (activities: ClassifiedActivity[]) => {
  const normalTx = activities.find((activity) =>
    activity.type === "normal_tx" && normalizeAddress(activity.from || "").length > 0
  );
  if (normalTx?.from) return normalizeAddress(normalTx.from);

  const outgoing = activities.find((activity) =>
    activity.direction === "out" && normalizeAddress(activity.from || "").length > 0
  );
  if (outgoing?.from) return normalizeAddress(outgoing.from);

  const fallback = activities.find((activity) => normalizeAddress(activity.from || "").length > 0);
  return normalizeAddress(fallback?.from || "");
};

const pickSourceOnlyRows = (rows: ClassifiedActivity[], txSender: string) => {
  if (rows.length === 0) return [];

  const sender = normalizeAddress(txSender);
  if (sender) {
    const fromSender = rows.filter((row) => normalizeAddress(row.from || "") === sender);
    if (fromSender.length > 0) return fromSender;
  }

  const outgoing = rows.filter((row) => row.direction === "out");
  if (outgoing.length > 0) return outgoing;

  const largest = [...rows].sort((a, b) => toAmount(b) - toAmount(a))[0];
  return largest ? [largest] : [];
};

const selectConcreteBridgeTransfers = (activities: ClassifiedActivity[]) =>
  dedupeTransfers(
    activities.filter(
      (activity) =>
        (activity.type === "erc20_transfer" || activity.type === "native_transfer") &&
        isPositiveAmount(activity) &&
        (isBridgeLabeled(activity) ||
          isCoreSystemAddress(activity.from) ||
          isCoreSystemAddress(activity.to))
    )
  );

const hasBridgeSignal = (activities: ClassifiedActivity[]) =>
  selectConcreteBridgeTransfers(activities).length > 0 ||
  activities.some((activity) =>
    activity.type === "bridge_event" &&
      (isCoreSystemAddress(activity.from) || isCoreSystemAddress(activity.to))
  );

const pickPrimaryCategory = (activities: ClassifiedActivity[], bridgeSignal: boolean) => {
  if (bridgeSignal) return "bridge" as const;
  if (activities.some((activity) => activity.category === "dex")) return "dex" as const;
  if (activities.some((activity) => activity.category === "lending")) return "lending" as const;
  if (activities.some((activity) => activity.category === "staking")) return "staking" as const;
  if (activities.some((activity) => activity.category === "erc20" || activity.category === "native")) {
    return "transfer" as const;
  }
  return "other" as const;
};

const pickZkCodexLikeCategory = (activities: ClassifiedActivity[], bridgeSignal: boolean) => {
  if (bridgeSignal) return "bridge" as const;
  if (activities.some((activity) => activity.category === "dex")) return "dex" as const;
  if (activities.some((activity) => activity.category === "lending" || activity.category === "vault")) {
    return "lending" as const;
  }
  if (activities.some((activity) => activity.category === "staking")) return "staking" as const;
  return null;
};

const resolveUsd = async (
  activity: ClassifiedActivity,
  resolver: (activity: ClassifiedActivity) => Promise<number>
) => {
  const value = await resolver(activity);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

export const calculateTwabUsd = (segments: PortfolioSegment[]) => {
  if (segments.length === 0) {
    return {
      twabUsd: 0,
      startTime: 0,
      endTime: 0,
      durationSeconds: 0,
      area: 0,
    };
  }

  const startTime = segments[0].startTimestamp;
  const endTime = segments[segments.length - 1].endTimestamp;
  const durationSeconds = Math.max(0, endTime - startTime);
  const area = segments.reduce((sum, segment) => sum + (segment.totalUsd * segment.durationSeconds), 0);
  const twabUsd = durationSeconds > 0 ? area / durationSeconds : 0;

  return {
    twabUsd,
    startTime,
    endTime,
    durationSeconds,
    area,
  };
};

export const calculateVolumeUsd = async (
  activities: ClassifiedActivity[],
  resolver: (activity: ClassifiedActivity) => Promise<number>,
  walletAddress?: string
) => {
  let totalVolumeUsd = 0;
  let swapVolumeUsd = 0;
  let bridgeVolumeUsd = 0;
  let lendingVolumeUsd = 0;
  let stakingVolumeUsd = 0;
  let transferVolumeUsd = 0;
  let otherContractVolumeUsd = 0;

  const txGroups = groupByTxHash(activities);

  const wallet = normalizeAddress(walletAddress || "");
  const strictZkCodexMode = wallet.length > 0;

  for (const txActivities of txGroups.values()) {
    const sender = resolveTxSender(txActivities);
    if (wallet && sender !== wallet) continue;

    const tokenRows = dedupeTransfers(
      txActivities.filter((activity) => activity.type === "erc20_transfer" && isPositiveAmount(activity))
    );
    const sourceTokenRows = pickSourceOnlyRows(tokenRows, sender);

    let tokenUsd = 0;
    for (const row of sourceTokenRows) {
      tokenUsd += await resolveUsd(row, resolver);
    }

    const nativeRows = dedupeTransfers(
      txActivities.filter(
        (activity) =>
          activity.type === "native_transfer" &&
          isPositiveAmount(activity)
      )
    );
    const sourceNativeRows = pickSourceOnlyRows(nativeRows, sender);

    let nativeUsd = 0;
    for (const row of sourceNativeRows) {
      nativeUsd += await resolveUsd(row, resolver);
    }

    const txVolumeUsd = tokenUsd > 0 ? tokenUsd : nativeUsd > 0 ? nativeUsd : 0;
    if (txVolumeUsd <= 0) continue;

    const concreteBridgeRows = selectConcreteBridgeTransfers(txActivities);
    const bridgeSignal = concreteBridgeRows.length > 0;

    const category = strictZkCodexMode
      ? pickZkCodexLikeCategory(txActivities, bridgeSignal)
      : pickPrimaryCategory(txActivities, bridgeSignal);
    if (!category) continue;

    totalVolumeUsd += txVolumeUsd;

    if (category === "dex") swapVolumeUsd += txVolumeUsd;
    else if (category === "bridge") bridgeVolumeUsd += txVolumeUsd;
    else if (category === "lending") lendingVolumeUsd += txVolumeUsd;
    else if (category === "staking") stakingVolumeUsd += txVolumeUsd;
    else if (category === "transfer") transferVolumeUsd += txVolumeUsd;
    else otherContractVolumeUsd += txVolumeUsd;
  }

  return {
    totalVolumeUsd,
    swapVolumeUsd,
    bridgeVolumeUsd,
    lendingVolumeUsd,
    stakingVolumeUsd,
    transferVolumeUsd,
    otherContractVolumeUsd,
  };
};

export const calculateUniqueContracts = (activities: RawActivity[], walletAddress: string) => {
  const wallet = normalizeAddress(walletAddress);
  const direct = new Set<string>();
  const touched = new Set<string>();
  const protocolContracts = new Set<string>();

  for (const activity of activities) {
    const from = normalizeAddress(activity.from || "");
    const to = normalizeAddress(activity.to || "");
    const contract = normalizeAddress(activity.contractAddress || "");

    if (from === wallet && to && to !== wallet) direct.add(to);

    if (to) touched.add(to);
    if (contract) touched.add(contract);
    if (activity.type === "erc20_transfer" && contract) touched.add(contract);

    if (activity.type === "defi_event" || activity.type === "bridge_event") {
      if (to) protocolContracts.add(to);
      if (contract) protocolContracts.add(contract);
    }
  }

  return {
    directContracts: direct.size,
    touchedContracts: touched.size,
    protocolContracts: protocolContracts.size,
    list: [...touched].sort(),
  };
};

export const calculateActivePeriods = (activities: RawActivity[]) => {
  const activeDays = new Set<string>();
  const activeWeeks = new Set<string>();
  const activeMonths = new Set<string>();
  const activeYears = new Set<string>();

  for (const activity of activities) {
    if (!Number.isFinite(activity.timestamp) || activity.timestamp <= 0) continue;
    const tsMs = activity.timestamp * 1000;
    const day = utcDayKey(tsMs);
    const month = utcMonthKey(tsMs);
    const year = new Date(tsMs).getUTCFullYear().toString();
    const week = weekKey(tsMs);
    if (day) activeDays.add(day);
    if (week) activeWeeks.add(week);
    if (month) activeMonths.add(month);
    activeYears.add(year);
  }

  return {
    activeDays: activeDays.size,
    activeWeeks: activeWeeks.size,
    activeMonths: activeMonths.size,
    activeYears: activeYears.size,
  };
};

export const calculateWalletAge = (activities: RawActivity[]) => {
  const now = Math.floor(Date.now() / 1000);
  const validTs = activities
    .map((a) => a.timestamp)
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  const firstSeenTimestamp = validTs[0] ?? now;

  const ageSeconds = Math.max(0, now - firstSeenTimestamp);
  const ageDays = Math.floor(ageSeconds / 86400);
  return { firstSeenTimestamp, ageSeconds, ageDays };
};

export const calculateTxCounts = (activities: RawActivity[], walletAddress: string) => {
  const wallet = normalizeAddress(walletAddress);
  const sentAccountTx = new Set<string>();
  const receivedAccountTx = new Set<string>();
  const erc20TransferRows = new Set<string>();
  const internalRows = new Set<string>();
  const contractInteractions = new Set<string>();
  const allActivity = new Set<string>();

  for (const activity of activities) {
    if (activity.txHash) allActivity.add(activity.txHash);

    const from = normalizeAddress(activity.from || "");
    const to = normalizeAddress(activity.to || "");

    if (activity.type === "normal_tx") {
      if (from === wallet && to && to !== wallet) sentAccountTx.add(activity.txHash);
      if (to === wallet && from && from !== wallet) receivedAccountTx.add(activity.txHash);
      if (from === wallet && to && to !== wallet) contractInteractions.add(activity.txHash);
    }

    if (activity.type === "erc20_transfer") erc20TransferRows.add(`${activity.txHash}:${activity.logIndex ?? ""}`);
    if (activity.type === "internal_transfer") internalRows.add(`${activity.txHash}:${activity.traceId ?? ""}`);
  }

  return {
    sentAccountTxCount: sentAccountTx.size,
    receivedAccountTxCount: receivedAccountTx.size,
    erc20TransferCount: erc20TransferRows.size,
    internalTxCount: internalRows.size,
    contractInteractionCount: contractInteractions.size,
    allActivityTxCount: allActivity.size,
  };
};

export const calculateBridgeVolume = async (
  activities: ClassifiedActivity[],
  resolver: (activity: ClassifiedActivity) => Promise<number>,
  walletAddress?: string
) => {
  let coreToEvmVolumeUsd = 0;
  let evmToCoreVolumeUsd = 0;
  let externalBridgeVolumeUsd = 0;

  const txGroups = groupByTxHash(activities);
  const wallet = normalizeAddress(walletAddress || "");

  for (const txActivities of txGroups.values()) {
    const sender = resolveTxSender(txActivities);
    if (wallet && sender !== wallet) continue;

    const bridgeRows = selectConcreteBridgeTransfers(txActivities);
    if (bridgeRows.length === 0) continue;
    const sourceBridgeRows = pickSourceOnlyRows(bridgeRows, sender);

    for (const row of sourceBridgeRows) {
      const usd = await resolveUsd(row, resolver);
      if (usd <= 0) continue;

      const from = normalizeAddress(row.from || "");
      const to = normalizeAddress(row.to || row.contractAddress || "");

      if (isCoreSystemAddress(from)) coreToEvmVolumeUsd += usd;
      else if (isCoreSystemAddress(to)) evmToCoreVolumeUsd += usd;
      else externalBridgeVolumeUsd += usd;
    }
  }

  return {
    coreToEvmVolumeUsd,
    evmToCoreVolumeUsd,
    externalBridgeVolumeUsd,
    totalBridgeVolumeUsd: coreToEvmVolumeUsd + evmToCoreVolumeUsd + externalBridgeVolumeUsd,
  };
};

export const calculateFeesPaidUsd = async (
  activities: RawActivity[],
  walletAddress: string,
  hypeUsdAt: (timestamp: number) => Promise<number>
) => {
  const wallet = normalizeAddress(walletAddress);
  let feesPaidUsd = 0;

  for (const activity of activities) {
    if (activity.type !== "normal_tx") continue;
    if (normalizeAddress(activity.from || "") !== wallet) continue;
    const feeNative = Number.isFinite(activity.feeNative) ? Math.max(0, activity.feeNative ?? 0) : 0;
    if (feeNative <= 0) continue;
    const px = await hypeUsdAt(activity.timestamp);
    if (!Number.isFinite(px) || px <= 0) continue;
    feesPaidUsd += feeNative * px;
  }

  return feesPaidUsd;
};
