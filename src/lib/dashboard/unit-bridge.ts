import { ageFromTimestamp, normalizeAddress, readStringKeys, toFiniteNumber, utcDayKey, utcMonthKey } from "@/lib/dashboard/shared";

const UNIT_API_BASE_URL = "https://api.hyperunit.xyz";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAX_PAGINATION_PAGES = 500;
const EXCLUDED_ASSETS = new Set(["ena"]);

type UnitOperationRecord = {
  operationId?: string;
  sourceChain?: string;
  destinationChain?: string;
  sourceAddress?: string;
  destinationAddress?: string;
  asset?: string;
  sourceAmount?: string | number;
  opCreatedAt?: string;
  state?: string;
  [key: string]: unknown;
};

type UnitOperationsPage = {
  operations?: unknown;
  cursor?: unknown;
};

type UnitBridgeStats = {
  volume: number;
  contractsCount: number;
  activeDays: number;
  activeMonths: number;
  sourceChainsCount: number;
  destinationChainsCount: number;
  sinceFirstTx: {
    days: number;
    months: number;
    years: number;
  };
  txCount: number;
  firstTxTime: number | null;
};

export type UnitBridgeApiResult = {
  source: "api";
  address: string;
  period: { startTime: number; endTime: number };
  stats: UnitBridgeStats;
  meta: {
    requestsUsed: number;
    pagesFetched: number;
    operationsFetched: number;
    truncated: boolean;
    coverageMode: "cursor-paginated";
    warnings: string[];
  };
};

type UnitAssetMeta = {
  decimals: number;
  priceSymbols: string[];
};

const UNIT_ASSET_META: Record<string, UnitAssetMeta> = {
  btc: { decimals: 8, priceSymbols: ["BTC"] },
  eth: { decimals: 18, priceSymbols: ["ETH"] },
  sol: { decimals: 9, priceSymbols: ["SOL"] },
  xpl: { decimals: 18, priceSymbols: ["XPL"] },
  mon: { decimals: 18, priceSymbols: ["MON"] },
  zec: { decimals: 8, priceSymbols: ["ZEC"] },
  avax: { decimals: 18, priceSymbols: ["AVAX"] },
  pump: { decimals: 6, priceSymbols: ["PUMP"] },
  fart: { decimals: 6, priceSymbols: ["FARTCOIN", "FART"] },
  bonk: { decimals: 5, priceSymbols: ["kBONK", "BONK"] },
  spxs: { decimals: 8, priceSymbols: ["SPX", "SPXS"] },
  "2z": { decimals: 6, priceSymbols: ["2Z"] },
  virtual: { decimals: 18, priceSymbols: ["VIRTUAL"] },
};

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const toBigIntSafe = (value: unknown): bigint => {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return BigInt(0);
      if (trimmed.includes(".")) {
        const [whole] = trimmed.split(".");
        return whole ? BigInt(whole) : BigInt(0);
      }
      return BigInt(trimmed);
    }
  } catch {
    return BigInt(0);
  }
  return BigInt(0);
};

const toDecimalNumber = (value: bigint, decimals: number): number => {
  const safeDecimals = Math.max(0, Math.floor(decimals));
  if (safeDecimals === 0) return Number(value);

  const negative = value < BigInt(0);
  let raw = (negative ? -value : value).toString();
  if (raw.length <= safeDecimals) raw = raw.padStart(safeDecimals + 1, "0");

  const split = raw.length - safeDecimals;
  const whole = raw.slice(0, split);
  const fractional = raw.slice(split, split + 12).replace(/0+$/, "");
  const text = fractional ? `${whole}.${fractional}` : whole;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
};

const parseOperationTime = (operation: UnitOperationRecord): number => {
  const raw = typeof operation.opCreatedAt === "string" ? operation.opCreatedAt : "";
  if (!raw.trim()) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};

const normalizeAsset = (asset: unknown): string => {
  if (typeof asset !== "string") return "";
  return asset.trim().toLowerCase();
};

const assetMeta = (asset: string): UnitAssetMeta => {
  const known = UNIT_ASSET_META[asset];
  if (known) return known;
  return { decimals: 18, priceSymbols: [asset.toUpperCase()] };
};

const toTokenAmount = (operation: UnitOperationRecord): number => {
  const asset = normalizeAsset(operation.asset);
  const decimals = assetMeta(asset).decimals;
  const raw = operation.sourceAmount;

  if (typeof raw === "string" && raw.includes(".")) {
    const direct = toFiniteNumber(raw);
    return direct > 0 ? direct : 0;
  }

  const amount = toDecimalNumber(toBigIntSafe(raw), decimals);
  return amount > 0 ? amount : 0;
};

const asUnitOperations = (payload: unknown): UnitOperationRecord[] => {
  if (!Array.isArray(payload)) return [];
  return payload.filter((row) => row && typeof row === "object") as UnitOperationRecord[];
};

const fetchUnitOperationsPage = async (address: string, cursor?: string): Promise<UnitOperationsPage> => {
  const url = new URL(`/operations/${address}`, UNIT_API_BASE_URL);
  if (cursor) url.searchParams.set("cursor", cursor);

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  const payload = await parseJson(response);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object"
        ? readStringKeys(payload as Record<string, unknown>, ["error", "detail", "message"]).trim()
        : "";
    throw new Error(message || `Unit operations request failed (${response.status})`);
  }

  if (!payload || typeof payload !== "object") return {};
  return payload as UnitOperationsPage;
};

const fetchAllMids = async (): Promise<Record<string, number>> => {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
    cache: "no-store",
  });

  const payload = await parseJson(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(`allMids request failed (${response.status})`);
  }

  const mids: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const price = toFiniteNumber(value);
    if (price > 0) mids[key] = price;
  }
  return mids;
};

const resolveAssetPrice = (asset: string, mids: Record<string, number>): number => {
  const meta = assetMeta(asset);
  for (const symbol of meta.priceSymbols) {
    const price = mids[symbol];
    if (Number.isFinite(price) && price > 0) return price;
  }
  return 0;
};

const dedupeOperations = (operations: UnitOperationRecord[]): UnitOperationRecord[] => {
  const keyed = new Map<string, UnitOperationRecord>();
  operations.forEach((operation, index) => {
    const id = readStringKeys(operation as Record<string, unknown>, ["operationId", "sourceTxHash"]).trim();
    const key =
      id ||
      [
        readStringKeys(operation as Record<string, unknown>, ["sourceAddress"]),
        readStringKeys(operation as Record<string, unknown>, ["destinationAddress"]),
        normalizeAsset(operation.asset),
        String(operation.sourceAmount ?? ""),
        String(parseOperationTime(operation)),
        String(index),
      ].join("|");
    keyed.set(key, operation);
  });
  return [...keyed.values()].sort((a, b) => parseOperationTime(a) - parseOperationTime(b));
};

const computeUnitBridgeStats = (
  operations: UnitOperationRecord[],
  mids: Record<string, number>,
  warnings: string[]
): UnitBridgeStats => {
  if (operations.length === 0) {
    return {
      volume: 0,
      contractsCount: 0,
      activeDays: 0,
      activeMonths: 0,
      sourceChainsCount: 0,
      destinationChainsCount: 0,
      sinceFirstTx: { days: 0, months: 0, years: 0 },
      txCount: 0,
      firstTxTime: null,
    };
  }

  const contracts = new Set<string>();
  const days = new Set<string>();
  const months = new Set<string>();
  const sourceChains = new Set<string>();
  const destinationChains = new Set<string>();
  const missingPriceAssets = new Set<string>();

  let firstTxTime = Number.MAX_SAFE_INTEGER;
  let volumeUsd = 0;

  for (const operation of operations) {
    const asset = normalizeAsset(operation.asset);
    if (!asset || EXCLUDED_ASSETS.has(asset)) continue;

    contracts.add(asset.toUpperCase());

    const time = parseOperationTime(operation);
    if (time > 0) {
      firstTxTime = Math.min(firstTxTime, time);
      const dayKey = utcDayKey(time);
      const monthKey = utcMonthKey(time);
      if (dayKey) days.add(dayKey);
      if (monthKey) months.add(monthKey);
    }

    const sourceChain = readStringKeys(operation as Record<string, unknown>, ["sourceChain"]).trim().toLowerCase();
    const destinationChain = readStringKeys(operation as Record<string, unknown>, ["destinationChain"]).trim().toLowerCase();
    if (sourceChain) sourceChains.add(sourceChain);
    if (destinationChain) destinationChains.add(destinationChain);

    const amount = toTokenAmount(operation);
    if (amount <= 0) continue;
    const price = resolveAssetPrice(asset, mids);
    if (price <= 0) {
      missingPriceAssets.add(asset.toUpperCase());
      continue;
    }
    volumeUsd += amount * price;
  }

  if (missingPriceAssets.size > 0) {
    warnings.push(
      `Missing Hyperliquid mid-price for: ${[...missingPriceAssets].sort().join(", ")}. These amounts were excluded from USD volume.`
    );
  }

  const first = Number.isFinite(firstTxTime) ? firstTxTime : null;
  return {
    volume: volumeUsd,
    contractsCount: contracts.size,
    activeDays: days.size,
    activeMonths: months.size,
    sourceChainsCount: sourceChains.size,
    destinationChainsCount: destinationChains.size,
    sinceFirstTx: first ? ageFromTimestamp(first) : { days: 0, months: 0, years: 0 },
    txCount: operations.filter((operation) => !EXCLUDED_ASSETS.has(normalizeAsset(operation.asset))).length,
    firstTxTime: first,
  };
};

export const fetchUnitBridgeStats = async (address: string): Promise<UnitBridgeApiResult> => {
  const endTime = Date.now();
  const startTime = 0;
  const warnings: string[] = [];
  let requestsUsed = 0;
  let pagesFetched = 0;
  let truncated = false;

  const allOperations: UnitOperationRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const payload = await fetchUnitOperationsPage(address, cursor);
    requestsUsed += 1;
    pagesFetched += 1;

    const pageOperations = asUnitOperations(payload.operations);
    allOperations.push(...pageOperations);

    const nextCursorRaw = readStringKeys(payload as Record<string, unknown>, ["cursor"]).trim();
    if (!nextCursorRaw) break;
    if (seenCursors.has(nextCursorRaw)) {
      truncated = true;
      warnings.push("Unit pagination cursor repeated unexpectedly; stopped early to avoid an infinite loop.");
      break;
    }
    seenCursors.add(nextCursorRaw);
    cursor = nextCursorRaw;
  }

  if (cursor && pagesFetched >= MAX_PAGINATION_PAGES) {
    truncated = true;
    warnings.push(`Stopped after ${MAX_PAGINATION_PAGES} pages while more Unit history was available.`);
  }

  let mids: Record<string, number> = {};
  try {
    mids = await fetchAllMids();
    requestsUsed += 1;
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? `Could not fetch Hyperliquid mid-prices (${error.message}); Unit USD volume may be understated.`
        : "Could not fetch Hyperliquid mid-prices; Unit USD volume may be understated."
    );
  }

  const dedupedOperations = dedupeOperations(allOperations);
  const stats = computeUnitBridgeStats(dedupedOperations, mids, warnings);

  warnings.push("Unit bridge volume is estimated in USD from source amounts and current Hyperliquid mid-prices.");

  return {
    source: "api",
    address: normalizeAddress(address),
    period: { startTime, endTime },
    stats,
    meta: {
      requestsUsed,
      pagesFetched,
      operationsFetched: dedupedOperations.length,
      truncated,
      coverageMode: "cursor-paginated",
      warnings,
    },
  };
};
