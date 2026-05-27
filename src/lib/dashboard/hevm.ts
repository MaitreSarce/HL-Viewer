import { fetchTimeRangeWithSplit, NonFundingUpdate } from "@/lib/dashboard/hyperliquid";
import {
  ageFromTimestamp,
  normalizeAddress,
  readStringKeys,
  toFiniteNumber,
  unique,
  utcDayKey,
  utcMonthKey,
} from "@/lib/dashboard/shared";

const SYSTEM_BRIDGE_ADDRESS = "0x2222222222222222222222222222222222222222";

type HevmComputed = {
  twab: number | null;
  volume: number;
  contractsCount: number;
  activeDays: number;
  activeMonths: number;
  sinceFirstTx: {
    days: number;
    months: number;
    years: number;
  };
  bridgeVolume: number;
  txCount: number;
  firstTxTime: number | null;
};

export type HevmApiResult = {
  source: "api";
  address: string;
  period: { startTime: number; endTime: number };
  stats: HevmComputed;
  meta: {
    requestsUsed: number;
    truncated: boolean;
    warnings: string[];
  };
};

const readDelta = (row: NonFundingUpdate): Record<string, unknown> => {
  const delta = row.delta;
  if (!delta || typeof delta !== "object") return {};
  return delta;
};

const updateTime = (row: NonFundingUpdate): number => {
  const raw = row.time ?? row.timestamp;
  const value = toFiniteNumber(raw);
  return value > 0 ? Math.floor(value) : 0;
};

const deltaType = (delta: Record<string, unknown>) => readStringKeys(delta, ["type"]).toLowerCase();

const deltaMagnitude = (delta: Record<string, unknown>): number => {
  const preferred = ["usdcValue", "usdc", "amount", "requestedUsd", "netWithdrawnUsd", "basis"];
  for (const key of preferred) {
    const value = abs(toFiniteNumber(delta[key]));
    if (value > 0) return value;
  }
  return 0;
};

const abs = (value: number) => Math.abs(value);

const isBridgeDelta = (delta: Record<string, unknown>): boolean => {
  const type = deltaType(delta);
  const destination = normalizeAddress(readStringKeys(delta, ["destination", "dest"]));
  if (type === "deposit" || type === "withdraw" || type === "cdeposit" || type === "cwithdraw") return true;
  if ((type === "send" || type === "spottransfer") && destination === SYSTEM_BRIDGE_ADDRESS) return true;
  return false;
};

const contractsFromDelta = (delta: Record<string, unknown>): string[] => {
  const contracts: string[] = [];
  const direct = readStringKeys(delta, ["token", "coin", "asset"]).toUpperCase();
  if (direct) contracts.push(direct);

  const liquidatedPositions = delta.liquidatedPositions;
  if (Array.isArray(liquidatedPositions)) {
    for (const position of liquidatedPositions) {
      if (!position || typeof position !== "object") continue;
      const coin = readStringKeys(position as Record<string, unknown>, ["coin", "asset"]).toUpperCase();
      if (coin) contracts.push(coin);
    }
  }

  return unique(contracts);
};

const computeHevmStats = (updates: NonFundingUpdate[]): HevmComputed => {
  if (updates.length === 0) {
    return {
      twab: null,
      volume: 0,
      contractsCount: 0,
      activeDays: 0,
      activeMonths: 0,
      sinceFirstTx: { days: 0, months: 0, years: 0 },
      bridgeVolume: 0,
      txCount: 0,
      firstTxTime: null,
    };
  }

  let totalVolume = 0;
  let bridgeVolume = 0;
  let firstTxTime = Number.MAX_SAFE_INTEGER;
  const dayKeys = new Set<string>();
  const monthKeys = new Set<string>();
  const contracts = new Set<string>();

  for (const row of updates) {
    const time = updateTime(row);
    if (time > 0) {
      firstTxTime = Math.min(firstTxTime, time);
      const dayKey = utcDayKey(time);
      const monthKey = utcMonthKey(time);
      if (dayKey) dayKeys.add(dayKey);
      if (monthKey) monthKeys.add(monthKey);
    }

    const delta = readDelta(row);
    totalVolume += deltaMagnitude(delta);

    for (const contract of contractsFromDelta(delta)) {
      contracts.add(contract);
    }

    if (isBridgeDelta(delta)) {
      bridgeVolume += deltaMagnitude(delta);
    }
  }

  const validFirst = Number.isFinite(firstTxTime) ? firstTxTime : null;

  return {
    twab: null,
    volume: totalVolume,
    contractsCount: contracts.size,
    activeDays: dayKeys.size,
    activeMonths: monthKeys.size,
    sinceFirstTx: validFirst ? ageFromTimestamp(validFirst) : { days: 0, months: 0, years: 0 },
    bridgeVolume,
    txCount: updates.length,
    firstTxTime: validFirst,
  };
};

export const fetchHevmStatsFromApi = async (address: string): Promise<HevmApiResult> => {
  const endTime = Date.now();
  const startTime = 0;

  const result = await fetchTimeRangeWithSplit<NonFundingUpdate>({
    type: "userNonFundingLedgerUpdates",
    user: address,
    startTime,
    endTime,
    pageLimit: 500,
    minWindowMs: 12 * 60 * 60 * 1000,
    maxRequests: 180,
  });

  const stats = computeHevmStats(result.rows);
  const warnings = [
    "TWAB is not exposed by a stable public endpoint, so it is currently reported as unavailable.",
    "HEVM volume is estimated from available ledger amount fields (usdcValue/usdc/amount) when present.",
  ];
  if (result.truncated) {
    warnings.push("Some windows hit the API cap and may be partially truncated for high-activity wallets.");
  }

  return {
    source: "api",
    address,
    period: { startTime, endTime },
    stats,
    meta: {
      requestsUsed: result.requestsUsed,
      truncated: result.truncated,
      warnings,
    },
  };
};
