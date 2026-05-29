import { normalizeAddress, utcDayKey, utcMonthKey } from "@/lib/dashboard/shared";
import { ClassifiedActivity, PortfolioSegment, RawActivity } from "@/lib/hevm/types";

const weekKey = (timestampMs: number) => {
  const d = new Date(timestampMs);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - start.getTime()) / 86400000) + 1) / 7);
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
  const area = segments.reduce((sum, segment) => sum + segment.contribution, 0);
  const twabUsd = durationSeconds > 0 ? area / durationSeconds : 0;
  return { twabUsd, startTime, endTime, durationSeconds, area };
};

export const calculateVolumeUsd = async (
  activities: ClassifiedActivity[],
  resolver: (a: ClassifiedActivity) => Promise<number>
) => {
  let totalVolumeUsd = 0;
  let swapVolumeUsd = 0;
  let bridgeVolumeUsd = 0;
  let lendingVolumeUsd = 0;
  let stakingVolumeUsd = 0;
  let transferVolumeUsd = 0;
  let otherContractVolumeUsd = 0;

  for (const activity of activities) {
    const usd = await resolver(activity);
    totalVolumeUsd += usd;
    if (activity.category === "dex") swapVolumeUsd += usd;
    else if (activity.category === "bridge") bridgeVolumeUsd += usd;
    else if (activity.category === "lending") lendingVolumeUsd += usd;
    else if (activity.category === "staking") stakingVolumeUsd += usd;
    else if (activity.category === "erc20" || activity.category === "native") transferVolumeUsd += usd;
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
  const protocol = new Set<string>();

  for (const a of activities) {
    const from = normalizeAddress(a.from ?? "");
    const to = normalizeAddress(a.to ?? "");
    const c = normalizeAddress(a.contractAddress ?? "");
    if (from === wallet && to && to !== wallet) direct.add(to);
    if (to) touched.add(to);
    if (c) touched.add(c);
    if (a.type === "defi_event" || a.type === "bridge_event") {
      if (to) protocol.add(to);
      if (c) protocol.add(c);
    }
  }

  return {
    directContracts: direct.size,
    touchedContracts: touched.size,
    protocolContracts: protocol.size,
    list: [...touched].sort(),
  };
};

export const calculateActivePeriods = (activities: RawActivity[]) => {
  const days = new Set<string>();
  const weeks = new Set<string>();
  const months = new Set<string>();
  const years = new Set<string>();

  for (const a of activities) {
    const ts = a.timestamp * 1000;
    const d = utcDayKey(ts);
    const w = weekKey(ts);
    const m = utcMonthKey(ts);
    const y = new Date(ts).getUTCFullYear().toString();
    if (d) days.add(d);
    if (w) weeks.add(w);
    if (m) months.add(m);
    years.add(y);
  }

  return {
    activeDays: days.size,
    activeWeeks: weeks.size,
    activeMonths: months.size,
    activeYears: years.size,
  };
};

export const calculateWalletAge = (activities: RawActivity[]) => {
  const now = Math.floor(Date.now() / 1000);
  const times = activities
    .map((a) => a.timestamp)
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  const firstSeenTimestamp = times[0] ?? now;
  const ageSeconds = Math.max(0, now - firstSeenTimestamp);
  const ageDays = Math.floor(ageSeconds / 86400);
  return { firstSeenTimestamp, ageSeconds, ageDays };
};

export const calculateTxCounts = (activities: RawActivity[], walletAddress: string) => {
  const wallet = normalizeAddress(walletAddress);
  const sent = new Set<string>();
  const received = new Set<string>();
  const erc20 = new Set<string>();
  const internal = new Set<string>();
  const interactions = new Set<string>();
  const all = new Set<string>();

  for (const a of activities) {
    if (a.txHash) all.add(a.txHash);
    const from = normalizeAddress(a.from ?? "");
    const to = normalizeAddress(a.to ?? "");
    if (a.type === "normal_tx") {
      if (from === wallet && from !== to) sent.add(a.txHash);
      if (to === wallet && from !== to) received.add(a.txHash);
      if (from === wallet && to && to !== wallet) interactions.add(a.txHash);
    }
    if (a.type === "erc20_transfer") erc20.add(`${a.txHash}:${a.logIndex ?? ""}`);
    if (a.type === "internal_transfer") internal.add(`${a.txHash}:${a.traceId ?? ""}`);
  }

  return {
    sentAccountTxCount: sent.size,
    receivedAccountTxCount: received.size,
    erc20TransferCount: erc20.size,
    internalTxCount: internal.size,
    contractInteractionCount: interactions.size,
    allActivityTxCount: all.size,
  };
};

export const calculateBridgeVolume = async (
  activities: ClassifiedActivity[],
  resolver: (a: ClassifiedActivity) => Promise<number>
) => {
  let coreToEvmVolumeUsd = 0;
  let evmToCoreVolumeUsd = 0;
  let externalBridgeVolumeUsd = 0;

  const system = "0x2222222222222222222222222222222222222222";

  for (const a of activities) {
    if (a.category !== "bridge") continue;
    const usd = await resolver(a);
    const from = normalizeAddress(a.from ?? "");
    const to = normalizeAddress(a.to ?? a.contractAddress ?? "");
    if (from === system) coreToEvmVolumeUsd += usd;
    else if (to === system) evmToCoreVolumeUsd += usd;
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
    if (normalizeAddress(activity.from ?? "") !== wallet) continue;
    const feeNative = Number.isFinite(activity.feeNative) ? Math.max(0, activity.feeNative ?? 0) : 0;
    if (feeNative <= 0) continue;
    const px = await hypeUsdAt(activity.timestamp);
    if (!Number.isFinite(px) || px <= 0) continue;
    feesPaidUsd += feeNative * px;
  }

  return feesPaidUsd;
};
