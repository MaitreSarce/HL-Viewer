import { ageFromTimestamp, normalizeAddress, readStringKeys, toFiniteNumber, utcDayKey, utcMonthKey } from "@/lib/dashboard/shared";

const HYPURRSCAN_BASE_URL = "https://api.hypurrscan.io";

type HypurrActionRecord = {
  time?: number;
  user?: string;
  action?: Record<string, unknown>;
  hash?: string;
  [key: string]: unknown;
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
    coverageMode: "auth-range" | "public-snapshot";
    warnings: string[];
  };
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

const fetchHypurr = async (path: string, jwt?: string): Promise<unknown> => {
  const headers: HeadersInit = jwt ? { Authorization: `Bearer ${jwt}` } : {};
  const response = await fetch(`${HYPURRSCAN_BASE_URL}${path}`, {
    method: "GET",
    headers,
    cache: "no-store",
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    const reason =
      payload && typeof payload === "object" && "detail" in (payload as Record<string, unknown>)
        ? String((payload as Record<string, unknown>).detail)
        : `Hypurrscan request failed (${response.status})`;
    throw new Error(reason);
  }
  return payload;
};

const toTokenSymbol = (action: Record<string, unknown>): string => {
  const token = readStringKeys(action, ["token", "coin", "asset"]).toUpperCase().trim();
  if (!token) return "";
  return token.split(":")[0];
};

const isUnitToken = (symbol: string): boolean => {
  if (!symbol) return false;
  if (symbol === "USDC" || symbol === "USDT0" || symbol.startsWith("USD")) return false;
  if (symbol.startsWith("U")) return true;
  return symbol === "BTC" || symbol === "ETH" || symbol === "SOL" || symbol === "PUMP";
};

const isUnitBridgeAction = (action: Record<string, unknown>): boolean => {
  const type = readStringKeys(action, ["type"]).toLowerCase();
  const token = toTokenSymbol(action);

  if (!isUnitToken(token)) return false;

  return (
    type === "sendasset" ||
    type === "spotsend" ||
    type === "systemspotsendaction" ||
    type === "systemsendassetaction" ||
    type === "subaccountspottransfer"
  );
};

const actionVolume = (action: Record<string, unknown>): number => {
  const usdcValue = toFiniteNumber(action.usdcValue);
  if (usdcValue !== 0) return Math.abs(usdcValue);

  const amount = toFiniteNumber(action.amount);
  if (amount !== 0) return Math.abs(amount);

  const usdRaw = toFiniteNumber(action.usd);
  if (usdRaw !== 0) return Math.abs(usdRaw / 1_000_000);

  return 0;
};

const actionTime = (record: HypurrActionRecord): number => {
  const time = toFiniteNumber(record.time);
  return time > 0 ? Math.floor(time) : 0;
};

const actionParticipants = (record: HypurrActionRecord): string[] => {
  const action = record.action ?? {};
  const values = [
    readStringKeys(record as Record<string, unknown>, ["user"]),
    readStringKeys(action, ["user"]),
    readStringKeys(action, ["destination"]),
    readStringKeys(action, ["subAccountUser"]),
  ];
  return values.map((x) => normalizeAddress(x)).filter(Boolean);
};

const sourceChain = (action: Record<string, unknown>): string => {
  const candidate = readStringKeys(action, ["signatureChainId", "sourceChain", "fromChain", "chainId"]).trim();
  if (!candidate) return "";
  return candidate.toLowerCase();
};

const destinationChain = (action: Record<string, unknown>): string => {
  const candidate = readStringKeys(action, ["hyperliquidChain", "destinationChain", "toChain"]).trim();
  if (!candidate) return "";
  return candidate.toLowerCase();
};

const dedupe = (records: HypurrActionRecord[]) => {
  const keyed = new Map<string, HypurrActionRecord>();
  records.forEach((record, index) => {
    const hash = typeof record.hash === "string" ? record.hash : "";
    const time = actionTime(record);
    const key = hash ? `${hash}:${time}` : `${time}:${index}`;
    keyed.set(key, record);
  });
  return [...keyed.values()].sort((a, b) => actionTime(a) - actionTime(b));
};

const computeUnitBridgeStats = (records: HypurrActionRecord[]): UnitBridgeStats => {
  if (records.length === 0) {
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

  let firstTx = Number.MAX_SAFE_INTEGER;
  let volume = 0;
  const contracts = new Set<string>();
  const days = new Set<string>();
  const months = new Set<string>();
  const sourceChains = new Set<string>();
  const destinationChains = new Set<string>();

  for (const record of records) {
    const time = actionTime(record);
    if (time > 0) {
      firstTx = Math.min(firstTx, time);
      const dayKey = utcDayKey(time);
      const monthKey = utcMonthKey(time);
      if (dayKey) days.add(dayKey);
      if (monthKey) months.add(monthKey);
    }

    const action = record.action ?? {};
    const token = toTokenSymbol(action);
    if (token) contracts.add(token);
    volume += actionVolume(action);

    const src = sourceChain(action);
    const dst = destinationChain(action);
    if (src) sourceChains.add(src);
    if (dst) destinationChains.add(dst);
  }

  const firstTxTime = Number.isFinite(firstTx) ? firstTx : null;

  return {
    volume,
    contractsCount: contracts.size,
    activeDays: days.size,
    activeMonths: months.size,
    sourceChainsCount: sourceChains.size,
    destinationChainsCount: destinationChains.size,
    sinceFirstTx: firstTxTime ? ageFromTimestamp(firstTxTime) : { days: 0, months: 0, years: 0 },
    txCount: records.length,
    firstTxTime,
  };
};

const asRecords = (payload: unknown): HypurrActionRecord[] => {
  if (!Array.isArray(payload)) return [];
  return payload.filter((row) => row && typeof row === "object") as HypurrActionRecord[];
};

export const fetchUnitBridgeStats = async (address: string): Promise<UnitBridgeApiResult> => {
  const endTime = Date.now();
  const startTime = 0;
  const jwt = process.env.HYPURRSCAN_JWT?.trim();
  const warnings: string[] = [];

  let requestsUsed = 0;
  let coverageMode: "auth-range" | "public-snapshot" = "public-snapshot";
  let allRecords: HypurrActionRecord[] = [];

  if (jwt) {
    try {
      const fromTs = Math.floor(startTime / 1000);
      const toTs = Math.floor(endTime / 1000);
      const [transfers, bridges] = await Promise.all([
        fetchHypurr(`/transfers/${fromTs}/${toTs}`, jwt),
        fetchHypurr(`/bridges/${fromTs}/${toTs}`, jwt),
      ]);
      requestsUsed += 2;
      allRecords = dedupe([...asRecords(transfers), ...asRecords(bridges)]);
      coverageMode = "auth-range";
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? `Authenticated Hypurrscan mode failed (${error.message}). Falling back to public snapshots.`
          : "Authenticated Hypurrscan mode failed. Falling back to public snapshots."
      );
    }
  }

  if (allRecords.length === 0) {
    const [recentTransfers, recentBridges] = await Promise.all([
      fetchHypurr("/aLotOfTransfers"),
      fetchHypurr("/bridges"),
    ]);
    requestsUsed += 2;
    allRecords = dedupe([...asRecords(recentTransfers), ...asRecords(recentBridges)]);
    coverageMode = "public-snapshot";
    warnings.push(
      "Public Hypurrscan mode is limited to recent snapshots (around 20k transfers + 500 bridges globally)."
    );
  }

  warnings.push("Unit bridge volume is estimated from action amount/usdcValue fields when available.");

  const target = normalizeAddress(address);
  const relevant = allRecords.filter((record) => {
    const participants = actionParticipants(record);
    if (!participants.includes(target)) return false;
    const action = record.action ?? {};
    return isUnitBridgeAction(action);
  });

  const stats = computeUnitBridgeStats(relevant);

  return {
    source: "api",
    address,
    period: { startTime, endTime },
    stats,
    meta: {
      requestsUsed,
      coverageMode,
      warnings,
    },
  };
};
