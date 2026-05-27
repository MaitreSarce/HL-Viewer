import { normalizeAddress, readStringKeys, toFiniteNumber } from "@/lib/dashboard/shared";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

type JsonBody = Record<string, unknown>;

export type HyperliquidFill = {
  coin?: string;
  px?: string;
  sz?: string;
  side?: string;
  time?: number;
  timestamp?: number;
  startPosition?: string;
  dir?: string;
  closedPnl?: string;
  hash?: string;
  oid?: number;
  tid?: number;
  fee?: string;
  feeToken?: string;
  [key: string]: unknown;
};

export type NonFundingUpdate = {
  time?: number;
  hash?: string;
  delta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SpotMetaToken = {
  name?: string;
  index?: number;
};

export type SpotMetaPair = {
  tokens?: number[];
  index?: number;
  name?: string;
};

export type SpotMetaResponse = {
  universe?: SpotMetaPair[];
  tokens?: SpotMetaToken[];
};

export type PerpMetaAsset = {
  name?: string;
  [key: string]: unknown;
};

export type PerpMetaResponse = {
  universe?: PerpMetaAsset[];
  [key: string]: unknown;
};

export type OutcomeMetaSide = {
  name?: string;
  [key: string]: unknown;
};

export type OutcomeMetaOutcome = {
  outcome?: number;
  name?: string;
  description?: string;
  sideSpecs?: OutcomeMetaSide[];
  [key: string]: unknown;
};

export type OutcomeMetaQuestion = {
  question?: number;
  name?: string;
  description?: string;
  fallbackOutcome?: number;
  namedOutcomes?: number[];
  settledNamedOutcomes?: number[];
  [key: string]: unknown;
};

export type OutcomeMetaResponse = {
  outcomes?: OutcomeMetaOutcome[];
  questions?: OutcomeMetaQuestion[];
  [key: string]: unknown;
};

const extractRemoteError = (payload: unknown): string => {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (!payload || typeof payload !== "object") return "Remote API error";
  const obj = payload as Record<string, unknown>;
  const value = obj.error ?? obj.message ?? obj.detail ?? obj.title;
  return typeof value === "string" && value.trim() ? value : "Remote API error";
};

export class RemoteApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    super(extractRemoteError(payload));
    this.status = status;
    this.payload = payload;
  }
}

export const fetchHyperliquidInfo = async <T>(body: JsonBody): Promise<T> => {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new RemoteApiError(response.status, payload);
  }

  return payload as T;
};

const safePairName = (pairName: string | undefined, base: string, quote: string) => {
  if (typeof pairName === "string" && pairName.includes("/")) return pairName.toUpperCase();
  return `${base.toUpperCase()}/${quote.toUpperCase()}`;
};

export const buildSpotCoinResolver = (spotMeta: SpotMetaResponse) => {
  const tokenNameByIndex = new Map<number, string>();
  for (const token of spotMeta.tokens ?? []) {
    if (typeof token.index === "number" && typeof token.name === "string" && token.name.trim()) {
      tokenNameByIndex.set(token.index, token.name.trim().toUpperCase());
    }
  }

  const pairBySpotId = new Map<string, string>();
  for (const pair of spotMeta.universe ?? []) {
    if (typeof pair.index !== "number") continue;
    const key = `@${pair.index}`;
    const tokens = pair.tokens ?? [];
    const base = tokens.length > 0 ? tokenNameByIndex.get(tokens[0]) ?? `TOKEN${tokens[0]}` : "UNKNOWN";
    const quote = tokens.length > 1 ? tokenNameByIndex.get(tokens[1]) ?? `TOKEN${tokens[1]}` : "USDC";
    pairBySpotId.set(key, safePairName(pair.name, base, quote));
  }

  return (rawCoin: string): string => {
    const coin = rawCoin.trim();
    if (!coin.startsWith("@")) return coin;
    return pairBySpotId.get(coin) ?? coin;
  };
};

type TimeWindow = {
  startTime: number;
  endTime: number;
};

export type TimeScopedRow = {
  time?: number;
  timestamp?: number;
  hash?: string;
  tid?: number | string;
};

const rowTime = (row: TimeScopedRow): number => {
  const value = toFiniteNumber(row.time ?? row.timestamp ?? 0);
  return value > 0 ? Math.floor(value) : 0;
};

const rowKey = (row: TimeScopedRow, index: number): string => {
  const hash = typeof row.hash === "string" ? row.hash : "";
  const tid = row.tid;
  const t = rowTime(row);
  if (hash && (typeof tid === "number" || typeof tid === "string")) return `${hash}:${String(tid)}`;
  if (hash && t > 0) return `${hash}:${t}`;
  if (typeof tid === "number" || typeof tid === "string") return `${String(tid)}:${t}`;
  return `idx:${index}:${t}`;
};

export type RangeFetchResult<T> = {
  rows: T[];
  requestsUsed: number;
  truncated: boolean;
};

type SplitFetchOptions = {
  type: string;
  user: string;
  startTime: number;
  endTime: number;
  pageLimit: number;
  minWindowMs?: number;
  maxRequests?: number;
  extraBody?: Record<string, unknown>;
};

export const fetchTimeRangeWithSplit = async <T extends TimeScopedRow>(
  options: SplitFetchOptions
): Promise<RangeFetchResult<T>> => {
  const {
    type,
    user,
    startTime,
    endTime,
    pageLimit,
    minWindowMs = 60 * 1000,
    maxRequests = 140,
    extraBody = {},
  } = options;

  const queue: TimeWindow[] = [{ startTime, endTime }];
  const buffered: T[] = [];
  let requestsUsed = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (requestsUsed >= maxRequests) {
      truncated = true;
      break;
    }

    const current = queue.pop();
    if (!current) break;
    if (current.startTime > current.endTime) continue;

    const payload = await fetchHyperliquidInfo<unknown>({
      type,
      user,
      startTime: current.startTime,
      endTime: current.endTime,
      ...extraBody,
    });
    requestsUsed += 1;

    if (!Array.isArray(payload)) {
      throw new Error(`Unexpected payload for ${type}`);
    }

    const rows = payload as T[];
    const windowWidth = current.endTime - current.startTime;
    const shouldSplit = rows.length >= pageLimit && windowWidth > minWindowMs;

    if (shouldSplit) {
      const mid = current.startTime + Math.floor(windowWidth / 2);
      if (mid <= current.startTime || mid >= current.endTime) {
        buffered.push(...rows);
        truncated = true;
        continue;
      }

      queue.push({ startTime: mid + 1, endTime: current.endTime });
      queue.push({ startTime: current.startTime, endTime: mid });
      continue;
    }

    if (rows.length >= pageLimit) {
      truncated = true;
    }

    buffered.push(...rows);
  }

  const deduped = new Map<string, T>();
  for (let i = 0; i < buffered.length; i += 1) {
    const row = buffered[i];
    deduped.set(rowKey(row, i), row);
  }

  const rows = [...deduped.values()].sort((a, b) => rowTime(a) - rowTime(b));

  return { rows, requestsUsed, truncated };
};

export const getFillCoinRaw = (fill: HyperliquidFill): string => {
  const coin = readStringKeys(fill, ["coin", "asset", "symbol"]);
  return coin.trim();
};

export const getFillTime = (fill: HyperliquidFill): number => {
  return rowTime(fill);
};

export const getUserFromRecord = (record: Record<string, unknown>): string => {
  const user = readStringKeys(record, ["user", "address", "account"]);
  return normalizeAddress(user);
};
