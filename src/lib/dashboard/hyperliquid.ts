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
    super(
      status === 429
        ? "Hyperliquid API rate limit reached while loading data. Please retry in a minute."
        : extractRemoteError(payload)
    );
    this.status = status;
    this.payload = payload;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchHyperliquidInfo = async <T>(body: JsonBody): Promise<T> => {
  const retryDelaysMs = [700, 1_500, 3_000, 6_000];

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
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

    if (response.ok) {
      return payload as T;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retryDelaysMs.length) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelaysMs[attempt];
      await sleep(delayMs);
      continue;
    }

    throw new RemoteApiError(response.status, payload);
  }

  throw new RemoteApiError(500, null);
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

export type TimeWindow = {
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
  rateLimited: boolean;
  pendingWindows: TimeWindow[];
};

type SplitFetchOptions<T extends TimeScopedRow> = {
  type: string;
  user: string;
  startTime: number;
  endTime: number;
  pageLimit: number;
  minWindowMs?: number;
  maxRequests?: number;
  extraBody?: Record<string, unknown>;
  initialWindows?: TimeWindow[];
  onProgress?: (progress: RangeFetchResult<T>) => void;
};

export const fetchTimeRangeWithSplit = async <T extends TimeScopedRow>(
  options: SplitFetchOptions<T>
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
    initialWindows,
    onProgress,
  } = options;

  const queue: TimeWindow[] = initialWindows && initialWindows.length > 0 ? [...initialWindows] : [{ startTime, endTime }];
  const buffered: T[] = [];
  let requestsUsed = 0;
  let truncated = false;
  let rateLimited = false;
  let pendingWindows: TimeWindow[] = [];

  const reportProgress = () => {
    if (!onProgress) return;
    const deduped = new Map<string, T>();
    for (let i = 0; i < buffered.length; i += 1) {
      const row = buffered[i];
      deduped.set(rowKey(row, i), row);
    }
    const rows = [...deduped.values()].sort((a, b) => rowTime(a) - rowTime(b));
    onProgress({
      rows,
      requestsUsed,
      truncated,
      rateLimited,
      pendingWindows: pendingWindows.length > 0 ? pendingWindows : [...queue],
    });
  };

  while (queue.length > 0) {
    if (requestsUsed >= maxRequests) {
      truncated = true;
      pendingWindows = [...queue];
      reportProgress();
      break;
    }

    const current = queue.pop();
    if (!current) break;
    if (current.startTime > current.endTime) continue;

    let payload: unknown;
    try {
      payload = await fetchHyperliquidInfo<unknown>({
        type,
        user,
        startTime: current.startTime,
        endTime: current.endTime,
        ...extraBody,
      });
      requestsUsed += 1;
    } catch (error) {
      if (
        error instanceof RemoteApiError &&
        error.status === 429 &&
        (buffered.length > 0 || (initialWindows && initialWindows.length > 0))
      ) {
        rateLimited = true;
        truncated = true;
        pendingWindows = [current, ...queue];
        reportProgress();
        break;
      }
      throw error;
    }

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
        reportProgress();
        continue;
      }

      queue.push({ startTime: mid + 1, endTime: current.endTime });
      queue.push({ startTime: current.startTime, endTime: mid });
      continue;
    }

    if (rows.length >= pageLimit) {
      truncated = true;
      pendingWindows = [current, ...queue];
      reportProgress();
      break;
    }

    buffered.push(...rows);
    reportProgress();
  }

  const deduped = new Map<string, T>();
  for (let i = 0; i < buffered.length; i += 1) {
    const row = buffered[i];
    deduped.set(rowKey(row, i), row);
  }

  const rows = [...deduped.values()].sort((a, b) => rowTime(a) - rowTime(b));

  return { rows, requestsUsed, truncated, rateLimited, pendingWindows };
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
