import {
  ageFromTimestamp,
  normalizeAddress,
  readStringKeys,
  toFiniteNumber,
  utcDayKey,
  utcMonthKey,
} from "@/lib/dashboard/shared";

const HYPERSCAN_API_URL = "https://www.hyperscan.com/api";
const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
const COINGECKO_API_URL = "https://api.coingecko.com/api/v3";
const COINGECKO_HYPE_COIN_ID = "hyperliquid";
const COINGECKO_HYPEREVM_PLATFORM_ID = "hyperevm";
const HYPEREVM_CHAIN_ID = 999;
const ACCOUNT_OFFSET = 5000;
const TOKEN_OFFSET = 1000;
const INTERNAL_OFFSET = 1000;
const COINGECKO_MAX_CONTRACT_SERIES = 24;
const COINGECKO_REQUEST_DELAY_MS = 300;
const SYSTEM_BRIDGE_ADDRESS = "0x2222222222222222222222222222222222222222";
const NATIVE_ASSET_KEY = "__native_hype__";

type HevmComputed = {
  twab: number | null;
  volume: number;
  feesPaid: number;
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
  charts: {
    volume: Record<"day" | "week" | "month" | "year", Array<{ period: string; volume: number }>>;
  };
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

type ExplorerAction = "txlist" | "tokentx" | "txlistinternal";

type ExplorerRow = Record<string, unknown>;

type ExplorerFetchResult = {
  rows: ExplorerRow[];
  requestsUsed: number;
  truncated: boolean;
};

type AccountTx = {
  hash: string;
  blockNumber: number;
  timeSec: number;
  from: string;
  to: string;
  valueNative: number;
  gasFeeNative: number;
  input: string;
};

type TokenTx = {
  hash: string;
  blockNumber: number;
  timeSec: number;
  from: string;
  to: string;
  value: number;
  symbol: string;
  contractAddress: string;
};

type PricePoint = {
  timeMs: number;
  priceUsd: number;
};

type HistoricalPriceContext = {
  nativeSeries: PricePoint[];
  tokenSeriesByContract: Map<string, PricePoint[]>;
  requestsUsed: number;
  unavailableContracts: Set<string>;
  skippedContracts: Set<string>;
};

type BalanceAsset = {
  key: string;
  symbol: string;
  contractAddress: string;
  isNative: boolean;
};

type BalanceDelta = {
  asset: BalanceAsset;
  amount: number;
};

type BalanceEvent = {
  hash: string;
  timeSec: number;
  deltas: BalanceDelta[];
};

type ProtocolInteraction = {
  timeSec: number;
  deltaUsd: number;
};

const NO_TX_MESSAGES = new Set([
  "No transactions found",
  "No internal transactions found",
  "No token transfers found",
]);

const KNOWN_BRIDGE_SENDERS = new Set([
  SYSTEM_BRIDGE_ADDRESS,
  "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
  "0xa5f565650890fba1824ee0f21ebbbf660a179934",
  "0x00000000aa467eba42a3d604b3d74d63b2b6c6cb",
  "0xebd1e414ebb98522cfd932104ba41fac10a4ef35",
  "0xa06e1351e2fd2d45b5d35633ca7ecf328684a109",
  "0xa1bea5fe917450041748dbbbe7e9ac57a4bbebab",
  "0xe0b062d028236fa09fe33db8019ffeeee6bf79ed",
  "0x7f4babd2c7d35221e72ab67ea72cba99573a0089",
  "0xf366da269047a06a7275a933c6d653409bd6de5e",
  "0x634e831ce6d460c2cd5067af98d6452eb280e374",
  "0x47eb64e17a6d2fd559b608695e6d308cced918dd",
  "0xb4528b01af9c92f49435f88890a82b0b0ce90479",
  "0x4d6cb5047925e06d2cd6ca72ca30a413c77e1203",
  "0xf042fcc6bd5cb48b2862d9f22d3de5b342e94f4c",
  "0xc56043daac3a26ad451abc7610f04f53cc4412e5",
  "0xd71e5c1d217d12855b37fe60299273aad91d6cec",
  "0xac4615ffec9dbf5efe28db0f98f0011e6df0dabd",
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  "0x341e94069f53234fe6dabef707ad424830525715",
  "0xde1e598b81620773454588b85d6b5d4eec32573e",
  "0x4f8c9056bb8a3616693a76922fa35d53c056e5b3",
  "0xf909c4ae16622898b885b89d7f839e0244851c66",
  "0x0a0758d937d1059c356d4714e57f5df0239bce1a",
  "0x864b314d4c5a0399368609581d3e8933a63b9232",
  "0x3a9a5dba8fe1c4da98187ce4755701bca182f63b",
  "0x026f252016a7c47cdef1f05a3fc9e20c92a49c37",
  "0x3a23f943181408eac424116af7b7790c94cb97a5",
  "0xadde7028e7ec226777e5dea5d53f6457c21ec7d6",
  "0x0b4ed4bdcdd7f39ad33ddbadc5a68e73d1eaa9d9",
  "0xec26f64d0bbe1ecd417be50e6b99769ab17d114b",
  "0x6a138b12be537e3b47328d627c1699bfaaaa68ce",
  "0x1453ebba3d8f60a867b36b0f6d203eeac49f36db",
  "0x425a1e1f4106fb662e1faa4320ef1cf00e76f9e8",
]);

const STABLECOIN_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "USD0",
  "USDT0",
  "USDHL",
  "DAI",
  "USDE",
  "FDUSD",
  "USDH",
  "USDL",
  "USDB",
  "USDX",
  "USDY",
  "SUSDE",
  "USR",
]);

const abs = (value: number) => Math.abs(value);

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object";
};

const readTimeSec = (source: Record<string, unknown>) => {
  const value = toFiniteNumber(source.timeStamp ?? source.time ?? source.timestamp ?? 0);
  return value > 0 ? Math.floor(value) : 0;
};

const readBlockNumber = (source: Record<string, unknown>) => {
  const value = toFiniteNumber(source.blockNumber ?? source.block_number ?? 0);
  return value >= 0 ? Math.floor(value) : 0;
};

const toBigIntSafe = (value: unknown): bigint => {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim()) {
      const raw = value.trim();
      if (raw.includes(".")) {
        const integerPart = raw.split(".")[0];
        return integerPart ? BigInt(integerPart) : BigInt(0);
      }
      return BigInt(raw);
    }
  } catch {
    return BigInt(0);
  }
  return BigInt(0);
};

const toDecimalNumber = (value: bigint, decimals: number) => {
  if (!Number.isFinite(decimals) || decimals <= 0) return Number(value);
  const safeDecimals = Math.max(0, Math.floor(decimals));
  const negative = value < BigInt(0);
  let raw = (negative ? -value : value).toString();
  if (raw.length <= safeDecimals) {
    raw = raw.padStart(safeDecimals + 1, "0");
  }
  const split = raw.length - safeDecimals;
  const integerPart = raw.slice(0, split);
  const fractionPart = raw.slice(split, split + 12).replace(/0+$/, "");
  const text = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
};

const readUnitAmount = (raw: unknown, decimals: number) => abs(toDecimalNumber(toBigIntSafe(raw), decimals));
const readGasFeeNative = (source: Record<string, unknown>) => {
  const gasUsed = toBigIntSafe(source.gasUsed ?? source.gas_used ?? source.cumulativeGasUsed ?? 0);
  const gasPrice = toBigIntSafe(source.gasPrice ?? source.gas_price ?? source.effectiveGasPrice ?? 0);
  if (gasUsed <= BigInt(0) || gasPrice <= BigInt(0)) return 0;
  return abs(toDecimalNumber(gasUsed * gasPrice, 18));
};

const normalizeSymbol = (symbol: string) => symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");

const isStableSymbol = (symbol: string) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (STABLECOIN_SYMBOLS.has(normalized)) return true;
  return normalized.startsWith("USD") || normalized.includes("USDC") || normalized.includes("USDT");
};

const isHypeLikeSymbol = (symbol: string) => {
  const upper = normalizeSymbol(symbol);
  return upper === "HYPE" || upper === "WHYPE" || upper === "KHYPE" || upper === "STHYPE";
};

const createTokenAsset = (symbol: string, contractAddress: string): BalanceAsset => {
  const normalizedContract = normalizeAddress(contractAddress);
  if (normalizedContract) {
    return {
      key: `token:${normalizedContract}`,
      symbol,
      contractAddress: normalizedContract,
      isNative: false,
    };
  }
  const normalized = normalizeSymbol(symbol);
  return {
    key: normalized ? `symbol:${normalized}` : `symbol:unknown`,
    symbol,
    contractAddress: "",
    isNative: false,
  };
};

const createNativeAsset = (): BalanceAsset => ({
  key: NATIVE_ASSET_KEY,
  symbol: "HYPE",
  contractAddress: "",
  isNative: true,
});

const utcWeekKey = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
};

const utcYearKey = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  return String(date.getUTCFullYear());
};

const periodKeyByGranularity = (timestampMs: number, granularity: "day" | "week" | "month" | "year") => {
  if (granularity === "day") return utcDayKey(timestampMs);
  if (granularity === "week") return utcWeekKey(timestampMs);
  if (granularity === "month") return utcMonthKey(timestampMs);
  return utcYearKey(timestampMs);
};

const emptyVolumeSeriesMaps = () => ({
  day: new Map<string, number>(),
  week: new Map<string, number>(),
  month: new Map<string, number>(),
  year: new Map<string, number>(),
});

const readResponseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const fetchLatestBlockNumber = async (): Promise<number> => {
  try {
    const response = await fetch(HYPEREVM_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      cache: "no-store",
    });
    const payload = await readResponseJson(response);
    if (!response.ok || !isObjectRecord(payload)) return 99_999_999;
    const raw = payload.result;
    if (typeof raw !== "string" || !raw.trim()) return 99_999_999;
    return parseInt(raw, 16);
  } catch {
    return 99_999_999;
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)));
  });

const normalizePriceSeries = (payload: unknown): PricePoint[] => {
  if (!isObjectRecord(payload) || !Array.isArray(payload.prices)) return [];

  const points: PricePoint[] = [];
  for (const item of payload.prices) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const timeMs = Math.floor(toFiniteNumber(item[0]));
    const priceUsd = toFiniteNumber(item[1]);
    if (timeMs <= 0 || priceUsd <= 0) continue;
    points.push({ timeMs, priceUsd });
  }

  points.sort((a, b) => a.timeMs - b.timeMs);
  return points;
};

const fetchCoinGeckoCoinPriceSeries = async (
  coinId: string,
  fromSec: number,
  toSec: number
): Promise<PricePoint[]> => {
  try {
    const params = new URLSearchParams({
      vs_currency: "usd",
      from: String(Math.max(0, Math.floor(fromSec))),
      to: String(Math.max(0, Math.floor(toSec))),
    });
    const response = await fetch(`${COINGECKO_API_URL}/coins/${coinId}/market_chart/range?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });
    const payload = await readResponseJson(response);
    if (!response.ok) return [];
    return normalizePriceSeries(payload);
  } catch {
    return [];
  }
};

const fetchCoinGeckoContractPriceSeries = async (
  contractAddress: string,
  fromSec: number,
  toSec: number
): Promise<PricePoint[]> => {
  try {
    const params = new URLSearchParams({
      vs_currency: "usd",
      from: String(Math.max(0, Math.floor(fromSec))),
      to: String(Math.max(0, Math.floor(toSec))),
    });
    const normalizedContract = normalizeAddress(contractAddress);
    const response = await fetch(
      `${COINGECKO_API_URL}/coins/${COINGECKO_HYPEREVM_PLATFORM_ID}/contract/${normalizedContract}/market_chart/range?${params.toString()}`,
      {
        method: "GET",
        cache: "no-store",
      }
    );
    const payload = await readResponseJson(response);
    if (!response.ok) return [];
    return normalizePriceSeries(payload);
  } catch {
    return [];
  }
};

const priceAtTimeSec = (series: PricePoint[], timeSec: number): number => {
  if (series.length === 0) return 0;
  const targetMs = Math.max(0, Math.floor(timeSec * 1000));

  if (targetMs <= series[0].timeMs) return series[0].priceUsd;
  if (targetMs >= series[series.length - 1].timeMs) return series[series.length - 1].priceUsd;

  let left = 0;
  let right = series.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midTime = series[mid].timeMs;
    if (midTime === targetMs) return series[mid].priceUsd;
    if (midTime < targetMs) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const prev = Math.max(0, right);
  const next = Math.min(series.length - 1, left);
  const prevPoint = series[prev];
  const nextPoint = series[next];
  if (!prevPoint || !nextPoint) return prevPoint?.priceUsd ?? nextPoint?.priceUsd ?? 0;
  return targetMs - prevPoint.timeMs <= nextPoint.timeMs - targetMs ? prevPoint.priceUsd : nextPoint.priceUsd;
};

const fetchExplorerAction = async (
  action: ExplorerAction,
  address: string,
  startBlock: number,
  endBlock: number,
  offset: number
): Promise<ExplorerFetchResult> => {
  const rows: ExplorerRow[] = [];
  let requestsUsed = 0;
  let truncated = false;
  let cursorStart = Math.max(0, Math.floor(startBlock));
  const cursorEnd = Math.max(cursorStart, Math.floor(endBlock));

  while (cursorStart <= cursorEnd) {
    const params = new URLSearchParams({
      chain_id: String(HYPEREVM_CHAIN_ID),
      module: "account",
      action,
      address,
      startblock: String(cursorStart),
      endblock: String(cursorEnd),
      page: "1",
      offset: String(offset),
      sort: "asc",
    });

    const response = await fetch(`${HYPERSCAN_API_URL}?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });
    requestsUsed += 1;

    const payload = await readResponseJson(response);
    if (!response.ok) {
      const message =
        isObjectRecord(payload) && typeof payload.message === "string"
          ? payload.message
          : `Explorer request failed (${response.status})`;
      throw new Error(message);
    }

    if (!isObjectRecord(payload)) {
      throw new Error(`Unexpected explorer payload for ${action}.`);
    }

    const message = readStringKeys(payload, ["message"]).trim();
    if (NO_TX_MESSAGES.has(message)) break;

    const status = readStringKeys(payload, ["status"]).trim();
    const resultRaw = payload.result;
    if (!Array.isArray(resultRaw)) {
      if (status === "0" && !message) {
        truncated = true;
        break;
      }
      throw new Error(`Unexpected explorer result for ${action}.`);
    }

    const pageRows = resultRaw.filter((item) => isObjectRecord(item)) as ExplorerRow[];
    if (pageRows.length === 0) break;
    rows.push(...pageRows);

    if (pageRows.length < offset) break;

    const last = pageRows[pageRows.length - 1];
    const lastBlock = readBlockNumber(last);
    if (lastBlock <= cursorStart) {
      truncated = true;
      break;
    }
    cursorStart = lastBlock + 1;
  }

  return { rows, requestsUsed, truncated };
};

const parseAccountTxs = (rows: ExplorerRow[]): AccountTx[] => {
  const parsed: AccountTx[] = [];
  for (const row of rows) {
    const timeSec = readTimeSec(row);
    if (timeSec <= 0) continue;

    const receiptStatus = readStringKeys(row, ["txreceipt_status"]).trim();
    const isError = readStringKeys(row, ["isError"]).trim();
    if (receiptStatus && receiptStatus !== "1") continue;
    if (!receiptStatus && isError && isError !== "0") continue;

    const hash = readStringKeys(row, ["hash", "transactionHash"]).toLowerCase().trim();
    if (!hash) continue;

    parsed.push({
      hash,
      blockNumber: readBlockNumber(row),
      timeSec,
      from: normalizeAddress(readStringKeys(row, ["from"])),
      to: normalizeAddress(readStringKeys(row, ["to"])),
      valueNative: readUnitAmount(row.value, 18),
      gasFeeNative: readGasFeeNative(row),
      input: readStringKeys(row, ["input", "raw_input"]).trim(),
    });
  }
  return parsed;
};

const parseTokenTxs = (rows: ExplorerRow[]): TokenTx[] => {
  const parsed: TokenTx[] = [];
  for (const row of rows) {
    const timeSec = readTimeSec(row);
    if (timeSec <= 0) continue;

    const hash = readStringKeys(row, ["hash", "transactionHash"]).toLowerCase().trim();
    if (!hash) continue;

    const decimals = Math.max(0, Math.floor(toFiniteNumber(row.tokenDecimal ?? row.token_decimal ?? 18)));
    parsed.push({
      hash,
      blockNumber: readBlockNumber(row),
      timeSec,
      from: normalizeAddress(readStringKeys(row, ["from"])),
      to: normalizeAddress(readStringKeys(row, ["to"])),
      value: readUnitAmount(row.value, decimals),
      symbol: readStringKeys(row, ["tokenSymbol", "symbol"]).toUpperCase().trim(),
      contractAddress: normalizeAddress(readStringKeys(row, ["contractAddress", "tokenAddress"])),
    });
  }
  return parsed;
};

const parseInternalTxs = (rows: ExplorerRow[]): AccountTx[] => {
  const parsed: AccountTx[] = [];
  for (const row of rows) {
    const timeSec = readTimeSec(row);
    if (timeSec <= 0) continue;

    const hash = readStringKeys(row, ["hash", "transactionHash"]).toLowerCase().trim();
    if (!hash) continue;

    parsed.push({
      hash,
      blockNumber: readBlockNumber(row),
      timeSec,
      from: normalizeAddress(readStringKeys(row, ["from"])),
      to: normalizeAddress(readStringKeys(row, ["to"])),
      valueNative: readUnitAmount(row.value, 18),
      gasFeeNative: 0,
      input: readStringKeys(row, ["input", "raw_input"]).trim(),
    });
  }
  return parsed;
};

const computeUniqueActivity = (sentTxs: AccountTx[]) => {
  if (sentTxs.length === 0) {
    return {
      walletAge: 0,
      uniqueDays: 0,
      uniqueWeeks: 0,
      uniqueMonths: 0,
      firstTxTimeSec: null as number | null,
    };
  }

  const firstTxTimeSec = Math.min(...sentTxs.map((tx) => tx.timeSec));
  const dayCounts = new Map<string, number>();
  const weekCounts = new Map<string, number>();
  const monthCounts = new Map<string, number>();

  for (const tx of sentTxs) {
    const timeMs = tx.timeSec * 1000;
    const dayKey = utcDayKey(timeMs);
    const weekKey = utcWeekKey(timeMs);
    const monthKey = utcMonthKey(timeMs);
    if (dayKey) dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
    if (weekKey) weekCounts.set(weekKey, (weekCounts.get(weekKey) ?? 0) + 1);
    if (monthKey) monthCounts.set(monthKey, (monthCounts.get(monthKey) ?? 0) + 1);
  }

  return {
    walletAge: ageFromTimestamp(firstTxTimeSec * 1000).days,
    uniqueDays: [...dayCounts.values()].filter((count) => count >= 1).length,
    uniqueWeeks: [...weekCounts.values()].filter((count) => count >= 3).length,
    uniqueMonths: [...monthCounts.values()].filter((count) => count >= 3).length,
    firstTxTimeSec,
  };
};

const buildHistoricalPriceContext = async (
  sentAccountTxs: AccountTx[],
  sentTokenTxs: TokenTx[],
  receivedAccountTxs: AccountTx[],
  receivedTokenTxs: TokenTx[]
): Promise<HistoricalPriceContext> => {
  const context: HistoricalPriceContext = {
    nativeSeries: [],
    tokenSeriesByContract: new Map<string, PricePoint[]>(),
    requestsUsed: 0,
    unavailableContracts: new Set<string>(),
    skippedContracts: new Set<string>(),
  };

  const allTokenTxs = [...sentTokenTxs, ...receivedTokenTxs].filter((tx) => tx.value > 0);
  const allAccountTxs = [...sentAccountTxs, ...receivedAccountTxs].filter((tx) => tx.valueNative > 0);

  const requiresNativePricing =
    allAccountTxs.length > 0 || allTokenTxs.some((tx) => isHypeLikeSymbol(tx.symbol));
  const priceableTokenTxs = allTokenTxs.filter(
    (tx) => !isStableSymbol(tx.symbol) && !isHypeLikeSymbol(tx.symbol) && Boolean(tx.contractAddress)
  );

  const nativeTimes = allAccountTxs.map((tx) => tx.timeSec);
  for (const tx of allTokenTxs) {
    if (isHypeLikeSymbol(tx.symbol)) nativeTimes.push(tx.timeSec);
  }
  const tokenTimes = priceableTokenTxs.map((tx) => tx.timeSec);
  const allTimes = [...nativeTimes, ...tokenTimes].filter((timeSec) => Number.isFinite(timeSec) && timeSec > 0);
  if (allTimes.length === 0) {
    return context;
  }

  const minTimeSec = Math.min(...allTimes);
  const maxTimeSec = Math.max(...allTimes);
  const fromSec = Math.max(0, minTimeSec - 24 * 60 * 60);
  const toSec = maxTimeSec + 24 * 60 * 60;

  if (requiresNativePricing) {
    context.nativeSeries = await fetchCoinGeckoCoinPriceSeries(COINGECKO_HYPE_COIN_ID, fromSec, toSec);
    context.requestsUsed += 1;
  }

  const contractVolume = new Map<string, number>();
  for (const transfer of priceableTokenTxs) {
    const contract = normalizeAddress(transfer.contractAddress);
    if (!contract) continue;
    contractVolume.set(contract, (contractVolume.get(contract) ?? 0) + transfer.value);
  }

  const sortedContracts = [...contractVolume.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([contract]) => contract);
  const selectedContracts = sortedContracts.slice(0, COINGECKO_MAX_CONTRACT_SERIES);
  for (const skipped of sortedContracts.slice(COINGECKO_MAX_CONTRACT_SERIES)) {
    context.skippedContracts.add(skipped);
  }

  for (let i = 0; i < selectedContracts.length; i += 1) {
    if (i > 0) {
      await sleep(COINGECKO_REQUEST_DELAY_MS);
    }
    const contract = selectedContracts[i];
    const series = await fetchCoinGeckoContractPriceSeries(contract, fromSec, toSec);
    context.requestsUsed += 1;
    if (series.length > 0) {
      context.tokenSeriesByContract.set(contract, series);
    } else {
      context.unavailableContracts.add(contract);
    }
  }

  return context;
};

const computeVolumeUsd = (
  sentAccountTxs: AccountTx[],
  sentTokenTxs: TokenTx[],
  priceContext: HistoricalPriceContext
) => {
  let volumeUsd = 0;

  for (const tx of sentAccountTxs) {
    if (tx.valueNative <= 0) continue;
    const priceUsd = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
    if (priceUsd <= 0) continue;
    volumeUsd += tx.valueNative * priceUsd;
  }

  for (const transfer of sentTokenTxs) {
    if (transfer.value <= 0) continue;
    if (isStableSymbol(transfer.symbol)) {
      volumeUsd += transfer.value;
      continue;
    }
    if (isHypeLikeSymbol(transfer.symbol)) {
      const priceUsd = priceAtTimeSec(priceContext.nativeSeries, transfer.timeSec);
      if (priceUsd > 0) {
        volumeUsd += transfer.value * priceUsd;
      }
      continue;
    }

    const contract = normalizeAddress(transfer.contractAddress);
    const series = priceContext.tokenSeriesByContract.get(contract);
    if (!series || series.length === 0) continue;
    const priceUsd = priceAtTimeSec(series, transfer.timeSec);
    if (priceUsd > 0) {
      volumeUsd += transfer.value * priceUsd;
    }
  }

  return volumeUsd;
};

const computeHevmVolumeSeries = (
  sentAccountTxs: AccountTx[],
  sentTokenTxs: TokenTx[],
  priceContext: HistoricalPriceContext
) => {
  const series = emptyVolumeSeriesMaps();
  const addPoint = (timeSec: number, usdValue: number) => {
    if (!Number.isFinite(usdValue) || usdValue <= 0) return;
    const timeMs = timeSec * 1000;
    for (const granularity of ["day", "week", "month", "year"] as const) {
      const key = periodKeyByGranularity(timeMs, granularity);
      if (!key) continue;
      series[granularity].set(key, (series[granularity].get(key) ?? 0) + usdValue);
    }
  };

  for (const tx of sentAccountTxs) {
    if (tx.valueNative <= 0) continue;
    const priceUsd = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
    if (priceUsd <= 0) continue;
    addPoint(tx.timeSec, tx.valueNative * priceUsd);
  }
  for (const transfer of sentTokenTxs) {
    if (transfer.value <= 0) continue;
    if (isStableSymbol(transfer.symbol)) {
      addPoint(transfer.timeSec, transfer.value);
      continue;
    }
    if (isHypeLikeSymbol(transfer.symbol)) {
      const priceUsd = priceAtTimeSec(priceContext.nativeSeries, transfer.timeSec);
      if (priceUsd > 0) addPoint(transfer.timeSec, transfer.value * priceUsd);
      continue;
    }
    const contract = normalizeAddress(transfer.contractAddress);
    const contractSeries = priceContext.tokenSeriesByContract.get(contract);
    if (!contractSeries || contractSeries.length === 0) continue;
    const priceUsd = priceAtTimeSec(contractSeries, transfer.timeSec);
    if (priceUsd > 0) addPoint(transfer.timeSec, transfer.value * priceUsd);
  }

  return {
    day: [...series.day.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
    week: [...series.week.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
    month: [...series.month.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
    year: [...series.year.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, volume]) => ({ period, volume })),
  };
};

const computeBridgeVolumeUsd = (
  receivedAccountTxs: AccountTx[],
  receivedTokenTxs: TokenTx[],
  priceContext: HistoricalPriceContext
) => {
  let bridgeVolumeUsd = 0;
  for (const tx of receivedAccountTxs) {
    if (!KNOWN_BRIDGE_SENDERS.has(tx.from) || tx.valueNative <= 0) continue;
    const priceUsd = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
    if (priceUsd > 0) {
      bridgeVolumeUsd += tx.valueNative * priceUsd;
    }
  }
  for (const tx of receivedTokenTxs) {
    if (!KNOWN_BRIDGE_SENDERS.has(tx.from) || tx.value <= 0) continue;
    if (isStableSymbol(tx.symbol)) {
      bridgeVolumeUsd += tx.value;
      continue;
    }
    if (isHypeLikeSymbol(tx.symbol)) {
      const priceUsd = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
      if (priceUsd > 0) {
        bridgeVolumeUsd += tx.value * priceUsd;
      }
      continue;
    }
    const contract = normalizeAddress(tx.contractAddress);
    const series = priceContext.tokenSeriesByContract.get(contract);
    if (!series || series.length === 0) continue;
    const priceUsd = priceAtTimeSec(series, tx.timeSec);
    if (priceUsd > 0) {
      bridgeVolumeUsd += tx.value * priceUsd;
    }
  }
  return bridgeVolumeUsd;
};

const computeHevmFeesPaidUsd = (sentAccountTxs: AccountTx[], priceContext: HistoricalPriceContext) => {
  let feesUsd = 0;
  for (const tx of sentAccountTxs) {
    if (tx.gasFeeNative <= 0) continue;
    const priceUsd = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
    if (priceUsd <= 0) continue;
    feesUsd += tx.gasFeeNative * priceUsd;
  }
  return feesUsd;
};

const resolveAssetPriceUsd = (
  asset: BalanceAsset,
  timeSec: number,
  priceContext: HistoricalPriceContext,
  fallbackPriceByAsset: Map<string, number>
): number => {
  if (asset.isNative) {
    return priceAtTimeSec(priceContext.nativeSeries, timeSec);
  }
  if (isStableSymbol(asset.symbol)) {
    return 1;
  }
  if (isHypeLikeSymbol(asset.symbol)) {
    return priceAtTimeSec(priceContext.nativeSeries, timeSec);
  }
  if (asset.contractAddress) {
    const series = priceContext.tokenSeriesByContract.get(asset.contractAddress);
    if (series && series.length > 0) {
      const price = priceAtTimeSec(series, timeSec);
      if (price > 0) return price;
    }
  }
  const fallback = fallbackPriceByAsset.get(asset.key) ?? 0;
  return fallback > 0 ? fallback : 0;
};

const buildBalanceEvents = (
  target: string,
  sentAccountTxs: AccountTx[],
  receivedAccountTxs: AccountTx[],
  internalTxs: AccountTx[],
  sentTokenTxs: TokenTx[],
  receivedTokenTxs: TokenTx[]
): BalanceEvent[] => {
  const eventMap = new Map<
    string,
    {
      hash: string;
      timeSec: number;
      deltas: Map<string, BalanceDelta>;
    }
  >();

  const pushDelta = (hash: string, timeSec: number, asset: BalanceAsset, amount: number) => {
    if (!Number.isFinite(amount) || abs(amount) <= 1e-12 || timeSec <= 0) return;
    const eventId = `${timeSec}:${hash || "no-hash"}`;
    const existingEvent = eventMap.get(eventId);
    if (!existingEvent) {
      eventMap.set(eventId, {
        hash: hash || eventId,
        timeSec,
        deltas: new Map([[asset.key, { asset, amount }]]),
      });
      return;
    }
    const existingDelta = existingEvent.deltas.get(asset.key);
    if (existingDelta) {
      existingDelta.amount += amount;
    } else {
      existingEvent.deltas.set(asset.key, { asset, amount });
    }
  };

  for (const tx of sentAccountTxs) {
    if (tx.valueNative > 0) {
      pushDelta(tx.hash, tx.timeSec, createNativeAsset(), -tx.valueNative);
    }
  }
  for (const tx of receivedAccountTxs) {
    if (tx.valueNative > 0) {
      pushDelta(tx.hash, tx.timeSec, createNativeAsset(), tx.valueNative);
    }
  }

  for (const tx of internalTxs) {
    if (tx.valueNative <= 0 || tx.from === tx.to) continue;
    if (tx.from === target) {
      pushDelta(tx.hash, tx.timeSec, createNativeAsset(), -tx.valueNative);
    }
    if (tx.to === target) {
      pushDelta(tx.hash, tx.timeSec, createNativeAsset(), tx.valueNative);
    }
  }

  for (const tx of sentTokenTxs) {
    if (tx.value > 0) {
      pushDelta(tx.hash, tx.timeSec, createTokenAsset(tx.symbol, tx.contractAddress), -tx.value);
    }
  }
  for (const tx of receivedTokenTxs) {
    if (tx.value > 0) {
      pushDelta(tx.hash, tx.timeSec, createTokenAsset(tx.symbol, tx.contractAddress), tx.value);
    }
  }

  return [...eventMap.values()]
    .map((event) => ({
      hash: event.hash,
      timeSec: event.timeSec,
      deltas: [...event.deltas.values()].filter((delta) => Number.isFinite(delta.amount) && abs(delta.amount) > 1e-12),
    }))
    .filter((event) => event.timeSec > 0 && event.deltas.length > 0)
    .sort((a, b) => {
      if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
      return a.hash.localeCompare(b.hash);
    });
};

const computeHevmTwabUsd = (
  events: BalanceEvent[],
  protocolInteractions: ProtocolInteraction[],
  priceContext: HistoricalPriceContext,
  nowSec: number
): { twab: number | null; inferredAssetCount: number; unpricedAssetCount: number } => {
  if (events.length === 0) {
    return { twab: null, inferredAssetCount: 0, unpricedAssetCount: 0 };
  }

  const balances = new Map<string, number>();
  const assetsByKey = new Map<string, BalanceAsset>();
  const fallbackPriceByAsset = new Map<string, number>();
  const unpricedAssets = new Set<string>();

  const computePortfolioValueUsd = (timeSec: number): number => {
    let valueUsd = 0;
    for (const [assetKey, balance] of balances.entries()) {
      if (!Number.isFinite(balance) || balance <= 0) continue;
      const asset = assetsByKey.get(assetKey);
      if (!asset) continue;
      const priceUsd = resolveAssetPriceUsd(asset, timeSec, priceContext, fallbackPriceByAsset);
      if (priceUsd > 0) {
        valueUsd += balance * priceUsd;
      } else {
        unpricedAssets.add(assetKey);
      }
    }
    return valueUsd;
  };

  let cumulativeBalanceTime = 0;
  let portfolioValueUsd = 0;
  let lockedProtocolUsd = 0;
  let firstTimeSec = events[0].timeSec;
  let lastTimeSec = firstTimeSec;
  let initialized = false;
  let protocolCursor = 0;

  const applyProtocolInteractionsUntil = (timeSec: number) => {
    while (protocolCursor < protocolInteractions.length && protocolInteractions[protocolCursor].timeSec <= timeSec) {
      lockedProtocolUsd += protocolInteractions[protocolCursor].deltaUsd;
      if (lockedProtocolUsd < 0) lockedProtocolUsd = 0;
      protocolCursor += 1;
    }
  };

  for (const event of events) {
    if (!initialized) {
      firstTimeSec = event.timeSec;
      lastTimeSec = event.timeSec;
      initialized = true;
    } else if (event.timeSec > lastTimeSec) {
      cumulativeBalanceTime += portfolioValueUsd * (event.timeSec - lastTimeSec);
      lastTimeSec = event.timeSec;
    }

    applyProtocolInteractionsUntil(event.timeSec);
    for (const delta of event.deltas) {
      assetsByKey.set(delta.asset.key, delta.asset);
      const nextBalance = (balances.get(delta.asset.key) ?? 0) + delta.amount;
      if (abs(nextBalance) <= 1e-12) {
        balances.delete(delta.asset.key);
      } else {
        balances.set(delta.asset.key, nextBalance);
      }
    }

    portfolioValueUsd = computePortfolioValueUsd(event.timeSec) + lockedProtocolUsd;
  }

  const endSec = Math.max(lastTimeSec, Math.floor(nowSec));
  if (endSec > lastTimeSec) {
    cumulativeBalanceTime += portfolioValueUsd * (endSec - lastTimeSec);
  }

  const durationSec = Math.max(0, endSec - firstTimeSec);
  if (durationSec <= 0) {
    return {
      twab: portfolioValueUsd > 0 ? portfolioValueUsd : null,
      inferredAssetCount: 0,
      unpricedAssetCount: unpricedAssets.size,
    };
  }

  return {
    twab: cumulativeBalanceTime / durationSec,
    inferredAssetCount: 0,
    unpricedAssetCount: unpricedAssets.size,
  };
};

const buildProtocolInteractions = (
  target: string,
  normalTxs: AccountTx[],
  sentAccountTxs: AccountTx[],
  receivedAccountTxs: AccountTx[],
  sentTokenTxs: TokenTx[],
  receivedTokenTxs: TokenTx[],
  priceContext: HistoricalPriceContext
): ProtocolInteraction[] => {
  const sentContractCalls = new Set<string>();
  for (const tx of normalTxs) {
    const input = tx.input.trim().toLowerCase();
    if (tx.from !== target) continue;
    if (!input || input === "0x") continue;
    if (!tx.to || tx.to === target || tx.to === "0x0000000000000000000000000000000000000000") continue;
    sentContractCalls.add(tx.hash);
  }

  const byHash = new Map<string, { timeSec: number; sentUsd: number; receivedUsd: number }>();
  const addSent = (hash: string, timeSec: number, usd: number) => {
    if (!sentContractCalls.has(hash) || usd <= 0) return;
    const row = byHash.get(hash) ?? { timeSec, sentUsd: 0, receivedUsd: 0 };
    row.timeSec = Math.min(row.timeSec, timeSec);
    row.sentUsd += usd;
    byHash.set(hash, row);
  };
  const addReceived = (hash: string, timeSec: number, usd: number) => {
    if (!sentContractCalls.has(hash) || usd <= 0) return;
    const row = byHash.get(hash) ?? { timeSec, sentUsd: 0, receivedUsd: 0 };
    row.timeSec = Math.min(row.timeSec, timeSec);
    row.receivedUsd += usd;
    byHash.set(hash, row);
  };

  for (const tx of sentAccountTxs) {
    const price = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
    if (price > 0 && tx.valueNative > 0) addSent(tx.hash, tx.timeSec, tx.valueNative * price);
  }
  for (const tx of receivedAccountTxs) {
    const price = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
    if (price > 0 && tx.valueNative > 0) addReceived(tx.hash, tx.timeSec, tx.valueNative * price);
  }

  const tokenUsd = (tx: TokenTx): number => {
    if (tx.value <= 0) return 0;
    if (isStableSymbol(tx.symbol)) return tx.value;
    if (isHypeLikeSymbol(tx.symbol)) {
      const price = priceAtTimeSec(priceContext.nativeSeries, tx.timeSec);
      return price > 0 ? tx.value * price : 0;
    }
    const series = priceContext.tokenSeriesByContract.get(normalizeAddress(tx.contractAddress));
    if (!series || series.length === 0) return 0;
    const price = priceAtTimeSec(series, tx.timeSec);
    return price > 0 ? tx.value * price : 0;
  };
  for (const tx of sentTokenTxs) addSent(tx.hash, tx.timeSec, tokenUsd(tx));
  for (const tx of receivedTokenTxs) addReceived(tx.hash, tx.timeSec, tokenUsd(tx));

  const interactions: ProtocolInteraction[] = [];
  for (const row of byHash.values()) {
    const netOut = row.sentUsd - row.receivedUsd;
    if (!Number.isFinite(netOut) || Math.abs(netOut) < 1e-9) continue;
    interactions.push({ timeSec: row.timeSec, deltaUsd: netOut });
  }
  return interactions.sort((a, b) => a.timeSec - b.timeSec);
};

const computeContractsCount = (sentAccountTxs: AccountTx[]) => {
  const contracts = new Set<string>();
  for (const tx of sentAccountTxs) {
    if (!tx.to || tx.to === "0x0000000000000000000000000000000000000000") continue;
    contracts.add(tx.to);
  }
  return contracts.size;
};

const dedupeByKey = <T>(rows: T[], makeKey: (row: T) => string): T[] => {
  const keyed = new Map<string, T>();
  for (const row of rows) keyed.set(makeKey(row), row);
  return [...keyed.values()].sort((a, b) => makeKey(a).localeCompare(makeKey(b)));
};

export const fetchHevmStatsFromApi = async (address: string): Promise<HevmApiResult> => {
  const endTime = Date.now();
  const startTime = 0;
  const warnings: string[] = [];
  let requestsUsed = 0;
  let truncated = false;

  const latestBlock = await fetchLatestBlockNumber();
  requestsUsed += 1;

  const normalTxResult = await fetchExplorerAction(
    "txlist",
    address,
    0,
    latestBlock,
    ACCOUNT_OFFSET
  );
  requestsUsed += normalTxResult.requestsUsed;
  truncated = truncated || normalTxResult.truncated;

  const normalTxs = parseAccountTxs(normalTxResult.rows);
  const firstTxBlock = normalTxs.length > 0 ? Math.min(...normalTxs.map((tx) => tx.blockNumber)) : 0;

  const [tokenTxResult, internalTxResult] = await Promise.all([
    fetchExplorerAction("tokentx", address, firstTxBlock, latestBlock, TOKEN_OFFSET),
    fetchExplorerAction("txlistinternal", address, firstTxBlock, latestBlock, INTERNAL_OFFSET),
  ]);
  requestsUsed += tokenTxResult.requestsUsed + internalTxResult.requestsUsed;
  truncated = truncated || tokenTxResult.truncated || internalTxResult.truncated;

  const tokenTxs = parseTokenTxs(tokenTxResult.rows);
  const internalTxs = parseInternalTxs(internalTxResult.rows);

  const target = normalizeAddress(address);
  const sentAccountTxs = normalTxs.filter((tx) => tx.from === target && tx.from !== tx.to);
  const receivedAccountTxs = normalTxs.filter((tx) => tx.to === target && tx.from !== tx.to);
  const sentTokenTxs = tokenTxs.filter((tx) => tx.from === target && tx.from !== tx.to);
  const receivedTokenTxs = tokenTxs.filter((tx) => tx.to === target && tx.from !== tx.to);

  const dedupedSentAccountTxs = dedupeByKey(
    sentAccountTxs,
    (tx) => `${tx.hash}:${tx.blockNumber}:${tx.timeSec}:${tx.from}:${tx.to}`
  );
  const dedupedReceivedAccountTxs = dedupeByKey(
    receivedAccountTxs,
    (tx) => `${tx.hash}:${tx.blockNumber}:${tx.timeSec}:${tx.from}:${tx.to}`
  );
  const dedupedSentTokenTxs = dedupeByKey(
    sentTokenTxs,
    (tx) => `${tx.hash}:${tx.blockNumber}:${tx.timeSec}:${tx.contractAddress}:${tx.symbol}:${tx.value}`
  );
  const dedupedReceivedTokenTxs = dedupeByKey(
    receivedTokenTxs,
    (tx) => `${tx.hash}:${tx.blockNumber}:${tx.timeSec}:${tx.contractAddress}:${tx.symbol}:${tx.value}`
  );
  const dedupedInternalTxs = dedupeByKey(
    internalTxs.filter((tx) => tx.from !== tx.to),
    (tx) => `${tx.hash}:${tx.blockNumber}:${tx.timeSec}:${tx.from}:${tx.to}:${tx.valueNative}`
  );
  const dedupedSentInternalTxs = dedupedInternalTxs.filter((tx) => tx.from === target);
  const dedupedReceivedInternalTxs = dedupedInternalTxs.filter((tx) => tx.to === target);

  const priceContext = await buildHistoricalPriceContext(
    [...dedupedSentAccountTxs, ...dedupedSentInternalTxs],
    dedupedSentTokenTxs,
    [...dedupedReceivedAccountTxs, ...dedupedReceivedInternalTxs],
    dedupedReceivedTokenTxs
  );
  requestsUsed += priceContext.requestsUsed;

  const uniqueActivity = computeUniqueActivity(dedupedSentAccountTxs);
  const volumeUsd = computeVolumeUsd(dedupedSentAccountTxs, dedupedSentTokenTxs, priceContext);
  const bridgeVolumeUsd = computeBridgeVolumeUsd(dedupedReceivedAccountTxs, dedupedReceivedTokenTxs, priceContext);
  const hevmVolumeSeries = computeHevmVolumeSeries(dedupedSentAccountTxs, dedupedSentTokenTxs, priceContext);
  const hevmFeesPaidUsd = computeHevmFeesPaidUsd(dedupedSentAccountTxs, priceContext);
  const contractsCount = computeContractsCount(dedupedSentAccountTxs);
  const balanceEvents = buildBalanceEvents(
    target,
    dedupedSentAccountTxs,
    dedupedReceivedAccountTxs,
    dedupedInternalTxs,
    dedupedSentTokenTxs,
    dedupedReceivedTokenTxs
  );
  const protocolInteractions = buildProtocolInteractions(
    target,
    normalTxs,
    dedupedSentAccountTxs,
    dedupedReceivedAccountTxs,
    dedupedSentTokenTxs,
    dedupedReceivedTokenTxs,
    priceContext
  );
  const twabResult = computeHevmTwabUsd(balanceEvents, protocolInteractions, priceContext, endTime / 1000);

  let firstTxTimeSec: number | null = null;
  if (normalTxs.length > 0) {
    firstTxTimeSec = Math.min(...normalTxs.map((tx) => tx.timeSec));
  } else if (tokenTxs.length > 0) {
    firstTxTimeSec = Math.min(...tokenTxs.map((tx) => tx.timeSec));
  } else if (internalTxs.length > 0) {
    firstTxTimeSec = Math.min(...internalTxs.map((tx) => tx.timeSec));
  }

  const stats: HevmComputed = {
    twab: twabResult.twab,
    volume: volumeUsd,
    feesPaid: hevmFeesPaidUsd,
    contractsCount,
    activeDays: uniqueActivity.uniqueDays,
    activeMonths: uniqueActivity.uniqueMonths,
    sinceFirstTx: firstTxTimeSec ? ageFromTimestamp(firstTxTimeSec * 1000) : { days: 0, months: 0, years: 0 },
    bridgeVolume: bridgeVolumeUsd,
    txCount: dedupedSentAccountTxs.length,
    firstTxTime: firstTxTimeSec ? firstTxTimeSec * 1000 : null,
    charts: {
      volume: hevmVolumeSeries,
    },
  };

  warnings.push(
    "TWAB is now computed from reconstructed HyperEVM balances over time (normal tx + token tx + internal tx), including LP/lending position tokens when observable."
  );
  warnings.push(
    "TWAB uses conservative pricing only (stablecoins, HYPE, and tokens with historical price series). Unpriced assets are excluded rather than inferred."
  );
  warnings.push(
    "HEVM TWAB additionally tracks net USD locked in contract interactions (tx with calldata), so LP/lending deposits are counted even when no clear position token pricing is available."
  );
  warnings.push("HEVM metrics are now computed from HyperEVM explorer account transactions (txlist/tokentx/internal).");
  warnings.push(
    "Volume now uses historical USD prices at transfer time (CoinGecko) for HYPE and indexed HyperEVM tokens."
  );
  if (twabResult.inferredAssetCount > 0) {
    warnings.push(
      `TWAB pricing inferred ${twabResult.inferredAssetCount} unpriced position token(s) from same-transaction value flow (LP/lending share-token fallback).`
    );
  }
  if (twabResult.unpricedAssetCount > 0) {
    warnings.push(
      `TWAB still has ${twabResult.unpricedAssetCount} asset(s) without USD pricing data; those balances were excluded from TWAB valuation.`
    );
  }
  if (priceContext.nativeSeries.length === 0) {
    warnings.push("Historical HYPE/USD series was unavailable, so native-value transfers could not be fully valued.");
  }
  if (priceContext.unavailableContracts.size > 0) {
    warnings.push(
      `Historical USD series was unavailable for ${priceContext.unavailableContracts.size} token contract(s), so those transfers were excluded from USD valuation.`
    );
  }
  if (priceContext.skippedContracts.size > 0) {
    warnings.push(
      `Pricing requests were capped to ${COINGECKO_MAX_CONTRACT_SERIES} token contracts for reliability; ${priceContext.skippedContracts.size} lower-volume contract(s) were skipped.`
    );
  }
  if (truncated) {
    warnings.push("Explorer pagination returned repeated or invalid block cursors on at least one dataset.");
  }

  return {
    source: "api",
    address,
    period: { startTime, endTime },
    stats,
    meta: {
      requestsUsed,
      truncated,
      warnings,
    },
  };
};
