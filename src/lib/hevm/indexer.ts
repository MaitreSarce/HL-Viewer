import { normalizeAddress, readStringKeys, toFiniteNumber } from "@/lib/dashboard/shared";
import { HevmIndexerResult, RawActivity } from "@/lib/hevm/types";

const HYPERSCAN_API_URL = "https://www.hyperscan.com/api";
const ETHERSCAN_V2_API_URL = "https://api.etherscan.io/v2/api";
const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
const CHAIN_ID = 999;
const BRIDGE_SYSTEM_ADDRESS = "0x2222222222222222222222222222222222222222";
const FETCH_TIMEOUT_MS = 15000;
const ACTION_OFFSET = 10000;
const ACTION_MAX_PAGES = 1000;
const ACTION_MAX_ROWS = 220000;
const DEFAULT_ETHERSCAN_FALLBACK_KEYS = [
  "M6Y2NY3ABTV3T4BPNMYZ9X2TP2MAYJTK21",
  "N5D34IBKDQIKPK4EEY32ZI3GRGNS6GRDSX",
];

type ExplorerAction = "txlist" | "tokentx" | "txlistinternal";
type ExplorerRow = Record<string, unknown>;

type ExplorerProvider = {
  id: "etherscan_v2" | "hyperscan";
  baseUrl: string;
  chainParam: "chainid" | "chain_id" | null;
  apiKeys?: string[];
};

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";

const toInt = (value: unknown) => Math.floor(toFiniteNumber(value));

const readTime = (row: Record<string, unknown>) =>
  toInt(row.timeStamp ?? row.timestamp ?? row.time ?? 0);

const readBlock = (row: Record<string, unknown>) =>
  toInt(row.blockNumber ?? row.block_number ?? 0);

const normalizeTxHash = (value: string) => value.trim().toLowerCase();

const readMethodId = (inputValue: unknown) => {
  const s = String(inputValue ?? "").trim().toLowerCase();
  if (!s.startsWith("0x") || s.length < 10) return "";
  return s.slice(0, 10);
};

const direction = (wallet: string, from?: string, to?: string): RawActivity["direction"] => {
  const f = normalizeAddress(from ?? "");
  const t = normalizeAddress(to ?? "");
  if (f === wallet && t === wallet) return "self";
  if (f === wallet) return "out";
  if (t === wallet) return "in";
  return "unknown";
};

const rawToFloat = (raw: string | number | undefined, decimals = 18) => {
  const s = String(raw ?? "0").trim();
  if (!/^\d+$/.test(s)) return 0;
  if (s === "0") return 0;
  const d = Math.max(0, decimals);
  const padded = s.padStart(d + 1, "0");
  const intPart = padded.slice(0, -d);
  const fracPart = padded.slice(-d, -Math.max(0, d - 10));
  const value = Number(`${intPart}.${fracPart}`);
  return Number.isFinite(value) ? value : 0;
};

const readGasFeeNative = (row: Record<string, unknown>) => {
  const gasUsed = toFiniteNumber(row.gasUsed ?? row.cumulativeGasUsed ?? 0);
  const gasPrice = toFiniteNumber(row.gasPrice ?? row.effectiveGasPrice ?? 0);
  const l1FeesPaid = toFiniteNumber(
    row.L1FeesPaid ??
      row.l1FeesPaid ??
      row.l1Fee ??
      row.l1_fee ??
      0
  );
  if (!Number.isFinite(gasUsed) || !Number.isFinite(gasPrice) || gasUsed <= 0 || gasPrice <= 0) {
    return 0;
  }
  const l2Fee = gasUsed * gasPrice;
  const totalWei = l2Fee + (Number.isFinite(l1FeesPaid) && l1FeesPaid > 0 ? l1FeesPaid : 0);
  return totalWei / 1e18;
};

const isBridgeSystemAddress = (value?: string) => {
  const v = normalizeAddress(value ?? "");
  return Boolean(v) && (v === BRIDGE_SYSTEM_ADDRESS || v.startsWith("0x20"));
};

const safeFetchJson = async (url: string) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

const jsonRpc = async (method: string, params: unknown[]) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(HYPEREVM_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (!isObject(payload)) return null;
    return payload.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

const toHexInt = (hex: string) => {
  if (!hex || typeof hex !== "string") return 0;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
};

const dedupeActivities = (items: RawActivity[]) => {
  const byKey = new Map<string, RawActivity>();
  for (const item of items) {
    const key = [
      item.txHash,
      item.type,
      item.logIndex ?? "",
      item.traceId ?? "",
      item.contractAddress ?? "",
      item.amountRaw ?? "",
      item.direction ?? "",
      item.token ?? "",
      item.from ?? "",
      item.to ?? "",
    ].join("|");
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()].sort(
    (a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber)
  );
};

const getExplorerProviders = (): ExplorerProvider[] => {
  const envPrimaryKey = String(process.env.ETHERSCAN_API_KEY ?? "").trim();
  const envKeyList = String(process.env.ETHERSCAN_API_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const apiKeys = [
    ...new Set([envPrimaryKey, ...envKeyList, ...DEFAULT_ETHERSCAN_FALLBACK_KEYS].filter(Boolean)),
  ];

  const providers: ExplorerProvider[] = [];
  if (apiKeys.length > 0) {
    providers.push({
      id: "etherscan_v2",
      baseUrl: ETHERSCAN_V2_API_URL,
      chainParam: "chainid",
      apiKeys,
    });
  }
  providers.push({
    id: "hyperscan",
    baseUrl: HYPERSCAN_API_URL,
    chainParam: "chain_id",
  });
  return providers;
};

const fetchActionFromProvider = async (
  provider: ExplorerProvider,
  action: ExplorerAction,
  address: string
) => {
  const rows: ExplorerRow[] = [];
  const warnings: string[] = [];
  const errors: Array<{ stage: string; message: string }> = [];
  let startBlock = 0;
  const keyCandidates = provider.apiKeys && provider.apiKeys.length > 0 ? provider.apiKeys : [undefined];
  let keyIndex = 0;
  let temporaryUnavailableRetries = 2;
  let noPayloadRetries = 4;

  for (let pageNo = 0; pageNo < ACTION_MAX_PAGES; pageNo += 1) {
    const activeKey = keyCandidates[keyIndex % keyCandidates.length];
    const params = new URLSearchParams({
      module: "account",
      action,
      address,
      startblock: String(startBlock),
      endblock: "99999999",
      page: "1",
      offset: String(ACTION_OFFSET),
      sort: "asc",
    });
    if (provider.chainParam) params.set(provider.chainParam, String(CHAIN_ID));
    if (activeKey) params.set("apikey", activeKey);

    const payload = await safeFetchJson(`${provider.baseUrl}?${params.toString()}`);
    if (!payload || !isObject(payload)) {
      if (noPayloadRetries > 0) {
        noPayloadRetries -= 1;
        if (keyCandidates.length > 1) keyIndex += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
        pageNo -= 1;
        continue;
      }
      errors.push({
        stage: `${provider.id}:${action}`,
        message: "No response payload from explorer endpoint.",
      });
      break;
    }
    noPayloadRetries = 4;

    const status = String((payload as Record<string, unknown>).status ?? "");
    const message = String((payload as Record<string, unknown>).message ?? "");
    const result = (payload as Record<string, unknown>).result;

    if (typeof result === "string") {
      const msg = result.toLowerCase();
      if (msg.includes("no transactions")) break;
      const invalidKey =
        msg.includes("invalid api key") ||
        msg.includes("missing/invalid api key") ||
        msg.includes("#err2") ||
        msg.includes("too many invalid api key attempts");
      if (invalidKey && keyCandidates.length > 1) {
        keyIndex += 1;
        continue;
      }
      if (invalidKey) {
        errors.push({
          stage: `${provider.id}:${action}`,
          message: "Invalid API key for Etherscan V2. Falling back.",
        });
        break;
      }
      if (msg.includes("rate limit") && keyCandidates.length > 1) {
        keyIndex += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      if (msg.includes("temporarily unavailable") && temporaryUnavailableRetries > 0) {
        temporaryUnavailableRetries -= 1;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }
      warnings.push(`${provider.id} ${action}: ${result}`);
      break;
    }

    if (!Array.isArray(result)) {
      if (status === "0" && message.toLowerCase().includes("no transactions")) break;
      warnings.push(`${provider.id} ${action}: unexpected payload shape.`);
      break;
    }

    const pageRows = result.filter(isObject) as ExplorerRow[];
    if (pageRows.length === 0) break;

    rows.push(...pageRows);
    if (rows.length >= ACTION_MAX_ROWS) {
      warnings.push(`${provider.id} ${action} capped at ${ACTION_MAX_ROWS} rows for runtime safety.`);
      break;
    }

    if (pageRows.length < ACTION_OFFSET) break;
    const lastBlock = readBlock(pageRows[pageRows.length - 1]);
    if (lastBlock <= startBlock) break;
    startBlock = lastBlock + 1;
    if (provider.id === "etherscan_v2") {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  return { rows, warnings, errors };
};

const fetchExplorerAction = async (action: ExplorerAction, address: string) => {
  const providers = getExplorerProviders();
  const mergedWarnings: string[] = [];
  const mergedErrors: Array<{ stage: string; message: string }> = [];
  let bestRows: ExplorerRow[] = [];
  let bestSource = `hyperscan:${action}`;

  for (const provider of providers) {
    const result = await fetchActionFromProvider(provider, action, address);
    mergedWarnings.push(...result.warnings);
    mergedErrors.push(...result.errors);

    if (result.rows.length > bestRows.length) {
      bestRows = result.rows;
      bestSource = `${provider.id}:${action}`;
    }
    if (result.rows.length > 0) break;
  }

  return {
    rows: bestRows,
    warnings: mergedWarnings,
    errors: mergedErrors,
    source: bestSource,
  };
};

const enrichMissingTimestamps = async (activities: RawActivity[]) => {
  const blockNumbers = [
    ...new Set(
      activities
        .filter((a) => a.timestamp <= 0 && a.blockNumber > 0)
        .map((a) => a.blockNumber)
    ),
  ].slice(0, 320);
  if (blockNumbers.length === 0) return false;

  const tsByBlock = new Map<number, number>();
  const concurrency = 10;
  for (let i = 0; i < blockNumbers.length; i += concurrency) {
    const chunk = blockNumbers.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (blockNumber) => {
        const result = await jsonRpc("eth_getBlockByNumber", [
          `0x${blockNumber.toString(16)}`,
          false,
        ]);
        if (!result || typeof result !== "object") return;
        const blockTs = toHexInt(String((result as Record<string, unknown>).timestamp ?? "0x0"));
        if (blockTs > 0) tsByBlock.set(blockNumber, blockTs);
      })
    );
  }

  for (const activity of activities) {
    if (activity.timestamp > 0) continue;
    const blockTs = tsByBlock.get(activity.blockNumber);
    if (blockTs && blockTs > 0) activity.timestamp = blockTs;
  }
  return tsByBlock.size > 0;
};

export const indexWalletActivity = async (walletAddress: string): Promise<HevmIndexerResult> => {
  const wallet = normalizeAddress(walletAddress);
  const out: RawActivity[] = [];
  const warnings: string[] = [];
  const errors: Array<{ stage: string; message: string }> = [];
  const dataSourcesUsed = new Set<string>();

  const [normalRes, tokenRes, internalRes] = await Promise.all([
    fetchExplorerAction("txlist", wallet),
    fetchExplorerAction("tokentx", wallet),
    fetchExplorerAction("txlistinternal", wallet),
  ]);

  dataSourcesUsed.add(normalRes.source);
  dataSourcesUsed.add(tokenRes.source);
  dataSourcesUsed.add(internalRes.source);
  warnings.push(...normalRes.warnings, ...tokenRes.warnings, ...internalRes.warnings);
  errors.push(...normalRes.errors, ...tokenRes.errors, ...internalRes.errors);

  const normalRows = normalRes.rows;
  const tokenRows = tokenRes.rows;
  const internalRows = internalRes.rows;

  for (const row of normalRows) {
    const txHash = normalizeTxHash(readStringKeys(row, ["hash", "transactionHash"]));
    if (!txHash) continue;

    const timestamp = readTime(row);
    const blockNumber = readBlock(row);
    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    const amountRaw = String(row.value ?? "0");
    const amount = rawToFloat(amountRaw, 18);
    const methodId = readMethodId(row.input);
    const dir = direction(wallet, from, to);
    const source = normalRes.source.startsWith("etherscan_v2")
      ? "etherscan_v2_txlist"
      : "hyperscan_txlist";

    out.push({
      txHash,
      blockNumber,
      timestamp,
      from,
      to,
      type: "normal_tx",
      token: "HYPE",
      amountRaw,
      amount,
      feeNative: readGasFeeNative(row),
      direction: dir,
      methodId,
      source,
    });

    if (amount > 0) {
      out.push({
        txHash,
        blockNumber,
        timestamp,
        from,
        to,
        type: "native_transfer",
        token: "HYPE",
        amountRaw,
        amount,
        direction: dir,
        methodId,
        source,
      });
    }

    if (isBridgeSystemAddress(from) || isBridgeSystemAddress(to)) {
      out.push({
        txHash,
        blockNumber,
        timestamp,
        from,
        to,
        type: "bridge_event",
        token: "HYPE",
        amountRaw,
        amount,
        direction: dir,
        methodId,
        source,
      });
    }
  }

  for (const row of tokenRows) {
    const txHash = normalizeTxHash(readStringKeys(row, ["hash", "transactionHash"]));
    if (!txHash) continue;

    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    const tokenAddress = normalizeAddress(readStringKeys(row, ["contractAddress", "tokenAddress"]));
    const tokenSymbol = readStringKeys(row, ["tokenSymbol", "symbol"]).toUpperCase();
    const decimals = Math.max(0, Math.floor(toFiniteNumber(row.tokenDecimal ?? 18)));
    const amountRaw = String(row.value ?? "0");
    const amount = rawToFloat(amountRaw, decimals);
    const dir = direction(wallet, from, to);
    const source = tokenRes.source.startsWith("etherscan_v2")
      ? "etherscan_v2_tokentx"
      : "hyperscan_tokentx";
    const rawLogIndex = toFiniteNumber(row.logIndex);
    const logIndex = Number.isFinite(rawLogIndex) ? Math.floor(rawLogIndex) : undefined;

    out.push({
      txHash,
      blockNumber: readBlock(row),
      timestamp: readTime(row),
      from,
      to,
      contractAddress: tokenAddress,
      type: "erc20_transfer",
      token: tokenAddress || tokenSymbol,
      amountRaw,
      amount,
      direction: dir,
      logIndex,
      source,
    });

    if (isBridgeSystemAddress(from) || isBridgeSystemAddress(to) || isBridgeSystemAddress(tokenAddress)) {
      out.push({
        txHash,
        blockNumber: readBlock(row),
        timestamp: readTime(row),
        from,
        to,
        contractAddress: tokenAddress,
        type: "bridge_event",
        token: tokenAddress || tokenSymbol,
        amountRaw,
        amount,
        direction: dir,
        logIndex,
        source,
      });
    }
  }

  for (const row of internalRows) {
    const txHash = normalizeTxHash(readStringKeys(row, ["hash", "transactionHash", "transactionHash"]));
    if (!txHash) continue;

    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    const amountRaw = String(row.value ?? "0");
    const amount = rawToFloat(amountRaw, 18);
    const dir = direction(wallet, from, to);
    const source = internalRes.source.startsWith("etherscan_v2")
      ? "etherscan_v2_internal"
      : "hyperscan_internal";

    out.push({
      txHash,
      blockNumber: readBlock(row),
      timestamp: readTime(row),
      from,
      to,
      type: "internal_transfer",
      token: "HYPE",
      amountRaw,
      amount,
      direction: dir,
      traceId: readStringKeys(row, ["traceId", "trace_id", "index"]),
      source,
    });

    if (isBridgeSystemAddress(from) || isBridgeSystemAddress(to)) {
      out.push({
        txHash,
        blockNumber: readBlock(row),
        timestamp: readTime(row),
        from,
        to,
        type: "bridge_event",
        token: "HYPE",
        amountRaw,
        amount,
        direction: dir,
        traceId: readStringKeys(row, ["traceId", "trace_id", "index"]),
        source,
      });
    }
  }

  const rpcBlocksUsed = await enrichMissingTimestamps(out);
  if (rpcBlocksUsed) dataSourcesUsed.add("rpc:eth_getBlockByNumber");

  const activities = dedupeActivities(out).filter((a) => a.timestamp > 0);
  if (activities.length === 0) {
    warnings.push("No HEVM activity detected from explorer sources.");
  }

  return {
    activities,
    warnings,
    errors,
    dataSourcesUsed: [...dataSourcesUsed],
  };
};
