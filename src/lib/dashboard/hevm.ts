import {
  ageFromTimestamp,
  normalizeAddress,
  readStringKeys,
  toFiniteNumber,
  utcDayKey,
  utcMonthKey,
} from "@/lib/dashboard/shared";

const HYPERSCAN_API_URL = "https://www.hyperscan.com/api";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
const DEXSCREENER_TOKEN_API_URL = "https://api.dexscreener.com/tokens/v1/hyperevm";
const HYPEREVM_CHAIN_ID = 999;
const ACCOUNT_OFFSET = 5000;
const TOKEN_OFFSET = 1000;
const INTERNAL_OFFSET = 1000;
const DEXSCREENER_BATCH_SIZE = 30;
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

const chunk = <T>(values: T[], size: number): T[][] => {
  if (size <= 0) return [values];
  const parts: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    parts.push(values.slice(i, i + size));
  }
  return parts;
};

const utcWeekKey = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
};

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

const fetchHypePriceUsd = async (): Promise<number> => {
  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      cache: "no-store",
    });
    const payload = await readResponseJson(response);
    if (!response.ok || !isObjectRecord(payload)) return 0;
    const value = toFiniteNumber(payload.HYPE);
    return value > 0 ? value : 0;
  } catch {
    return 0;
  }
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

const fetchTokenPricesUsd = async (
  contractAddresses: string[]
): Promise<{ prices: Map<string, number>; requestsUsed: number }> => {
  const prices = new Map<string, number>();
  const uniqueContracts = [...new Set(contractAddresses.map(normalizeAddress).filter(Boolean))];
  if (uniqueContracts.length === 0) {
    return { prices, requestsUsed: 0 };
  }

  let requestsUsed = 0;

  for (const batch of chunk(uniqueContracts, DEXSCREENER_BATCH_SIZE)) {
    const endpoint = `${DEXSCREENER_TOKEN_API_URL}/${batch.join(",")}`;
    try {
      const response = await fetch(endpoint, { method: "GET", cache: "no-store" });
      requestsUsed += 1;
      const payload = await readResponseJson(response);
      if (!response.ok || !Array.isArray(payload)) continue;

      const bestPriceByContract = new Map<string, { price: number; liquidityUsd: number }>();
      for (const row of payload) {
        if (!isObjectRecord(row)) continue;
        const baseToken = row.baseToken;
        if (!isObjectRecord(baseToken)) continue;

        const contract = normalizeAddress(readStringKeys(baseToken, ["address"]));
        if (!contract || !batch.includes(contract)) continue;

        const priceUsd = toFiniteNumber(row.priceUsd);
        if (priceUsd <= 0) continue;

        const liquidity =
          isObjectRecord(row.liquidity) && Number.isFinite(toFiniteNumber(row.liquidity.usd))
            ? toFiniteNumber(row.liquidity.usd)
            : 0;

        const previous = bestPriceByContract.get(contract);
        if (!previous || liquidity > previous.liquidityUsd) {
          bestPriceByContract.set(contract, { price: priceUsd, liquidityUsd: liquidity });
        }
      }

      for (const [contract, value] of bestPriceByContract.entries()) {
        prices.set(contract, value.price);
      }
    } catch {
      requestsUsed += 1;
    }
  }

  return { prices, requestsUsed };
};

const computeVolumeUsd = (
  sentAccountTxs: AccountTx[],
  sentTokenTxs: TokenTx[],
  nativePriceUsd: number,
  tokenPricesUsd: Map<string, number>
) => {
  let nativeAmount = 0;
  let stableUsd = 0;
  let tokenUsd = 0;

  for (const tx of sentAccountTxs) {
    if (tx.valueNative > 0) {
      nativeAmount += tx.valueNative;
    }
  }

  for (const transfer of sentTokenTxs) {
    if (transfer.value <= 0) continue;
    if (isStableSymbol(transfer.symbol)) {
      stableUsd += transfer.value;
      continue;
    }
    if (isHypeLikeSymbol(transfer.symbol)) {
      nativeAmount += transfer.value;
      continue;
    }

    const contractPriceUsd = tokenPricesUsd.get(transfer.contractAddress) ?? 0;
    if (contractPriceUsd > 0) {
      tokenUsd += transfer.value * contractPriceUsd;
    }
  }

  if (nativePriceUsd <= 0) {
    return stableUsd + tokenUsd;
  }
  return stableUsd + tokenUsd + nativeAmount * nativePriceUsd;
};

const computeBridgeVolumeUsd = (
  receivedAccountTxs: AccountTx[],
  receivedTokenTxs: TokenTx[],
  nativePriceUsd: number
) => {
  let bridgeVolumeUsd = 0;
  for (const tx of receivedAccountTxs) {
    if (!KNOWN_BRIDGE_SENDERS.has(tx.from)) continue;
    if (nativePriceUsd > 0 && tx.valueNative > 0) {
      bridgeVolumeUsd += tx.valueNative * nativePriceUsd;
    }
  }
  for (const tx of receivedTokenTxs) {
    if (!KNOWN_BRIDGE_SENDERS.has(tx.from)) continue;
    if (tx.value <= 0) continue;
    if (isStableSymbol(tx.symbol)) {
      bridgeVolumeUsd += tx.value;
      continue;
    }
    if (nativePriceUsd > 0 && isHypeLikeSymbol(tx.symbol)) {
      bridgeVolumeUsd += tx.value * nativePriceUsd;
    }
  }
  return bridgeVolumeUsd;
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
  const nativePriceUsd = await fetchHypePriceUsd();
  requestsUsed += 2;

  if (nativePriceUsd <= 0) {
    warnings.push("HYPE/USD mid-price could not be resolved, so native-value volume may be understated.");
  }

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

  const priceableContracts = dedupedSentTokenTxs
    .filter((tx) => tx.contractAddress && !isStableSymbol(tx.symbol) && !isHypeLikeSymbol(tx.symbol))
    .map((tx) => tx.contractAddress);
  const tokenPriceResult = await fetchTokenPricesUsd(priceableContracts);
  requestsUsed += tokenPriceResult.requestsUsed;

  const uniqueActivity = computeUniqueActivity(dedupedSentAccountTxs);
  const volumeUsd = computeVolumeUsd(
    dedupedSentAccountTxs,
    dedupedSentTokenTxs,
    nativePriceUsd,
    tokenPriceResult.prices
  );
  const bridgeVolumeUsd = computeBridgeVolumeUsd(dedupedReceivedAccountTxs, dedupedReceivedTokenTxs, nativePriceUsd);
  const contractsCount = computeContractsCount(dedupedSentAccountTxs);

  let firstTxTimeSec: number | null = null;
  if (normalTxs.length > 0) {
    firstTxTimeSec = Math.min(...normalTxs.map((tx) => tx.timeSec));
  } else if (tokenTxs.length > 0) {
    firstTxTimeSec = Math.min(...tokenTxs.map((tx) => tx.timeSec));
  } else if (internalTxs.length > 0) {
    firstTxTimeSec = Math.min(...internalTxs.map((tx) => tx.timeSec));
  }

  const stats: HevmComputed = {
    twab: null,
    volume: volumeUsd,
    contractsCount,
    activeDays: uniqueActivity.uniqueDays,
    activeMonths: uniqueActivity.uniqueMonths,
    sinceFirstTx: firstTxTimeSec ? ageFromTimestamp(firstTxTimeSec * 1000) : { days: 0, months: 0, years: 0 },
    bridgeVolume: bridgeVolumeUsd,
    txCount: dedupedSentAccountTxs.length,
    firstTxTime: firstTxTimeSec ? firstTxTimeSec * 1000 : null,
  };

  warnings.push("TWAB is not exposed by a stable public endpoint, so it is currently reported as unavailable.");
  warnings.push("HEVM metrics are now computed from HyperEVM explorer account transactions (txlist/tokentx/internal).");
  warnings.push(
    "Token volume is valued from stablecoins, HYPE-family transfers, and Dexscreener prices for other tokens when available."
  );
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
