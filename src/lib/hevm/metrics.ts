import { normalizeAddress, utcDayKey, utcMonthKey } from "@/lib/dashboard/shared";
import { ClassifiedActivity, PortfolioSegment, RawActivity } from "@/lib/hevm/types";

const weekKey = (timestampMs: number) => {
  const d = new Date(timestampMs);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
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
  resolver: (activity: ClassifiedActivity) => Promise<number>
) => {
  let totalVolumeUsd = 0;
  let swapVolumeUsd = 0;
  let bridgeVolumeUsd = 0;
  let lendingVolumeUsd = 0;
  let stakingVolumeUsd = 0;
  let transferVolumeUsd = 0;
  let otherContractVolumeUsd = 0;

  for (const activity of activities) {
    const amount = await resolver(activity);
    const usd = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    totalVolumeUsd += usd;

    if (activity.category === "dex") swapVolumeUsd += usd;
    else if (activity.category === "bridge") bridgeVolumeUsd += usd;
    else if (activity.category === "lending") lendingVolumeUsd += usd;
    else if (activity.category === "staking") stakingVolumeUsd += usd;
    else if (activity.category === "native" || activity.category === "erc20") transferVolumeUsd += usd;
    else otherContractVolumeUsd += usd;
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
  const firstSeenTimestamp =
    activities
      .map((a) => a.timestamp)
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b)[0] ?? now;

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
  resolver: (activity: ClassifiedActivity) => Promise<number>
) => {
  const coreSystemAddress = "0x2222222222222222222222222222222222222222";
  let coreToEvmVolumeUsd = 0;
  let evmToCoreVolumeUsd = 0;
  let externalBridgeVolumeUsd = 0;

  for (const activity of activities) {
    if (activity.category !== "bridge") continue;
    const value = await resolver(activity);
    const usd = Number.isFinite(value) ? Math.max(0, value) : 0;
    const from = normalizeAddress(activity.from || "");
    const to = normalizeAddress(activity.to || activity.contractAddress || "");

    if (from === coreSystemAddress || from.startsWith("0x20")) coreToEvmVolumeUsd += usd;
    else if (to === coreSystemAddress || to.startsWith("0x20")) evmToCoreVolumeUsd += usd;
    else externalBridgeVolumeUsd += usd;
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

