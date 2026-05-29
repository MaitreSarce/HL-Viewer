import { normalizeAddress, readStringKeys, toFiniteNumber } from "@/lib/dashboard/shared";
import { HevmIndexerResult, RawActivity } from "@/lib/hevm/types";

const HYPERSCAN_API_URL = "https://www.hyperscan.com/api";
const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
const CHAIN_ID = 999;
const BRIDGE_SYSTEM_ADDRESS = "0x2222222222222222222222222222222222222222";
const ERC20_TRANSFER_TOPIC_PREFIX = "0xddf252ad";
const FETCH_TIMEOUT_MS = 3500;

type ExplorerAction = "txlist" | "tokentx" | "txlistinternal" | "logs";
type ExplorerRow = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";

const toInt = (value: unknown) => Math.floor(toFiniteNumber(value));

const readTime = (row: Record<string, unknown>) =>
  toInt(row.timeStamp ?? row.timestamp ?? row.time ?? 0);

const readBlock = (row: Record<string, unknown>) =>
  toInt(row.blockNumber ?? row.block_number ?? 0);

const toHexInt = (hex: string) => {
  if (!hex || typeof hex !== "string") return 0;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
};

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

const hexToDecString = (hexValue: string) => {
  const stripped = String(hexValue || "0x0").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(stripped) || stripped.length === 0) return "0";
  try {
    return BigInt(`0x${stripped}`).toString();
  } catch {
    return "0";
  }
};

const readGasFeeNative = (row: Record<string, unknown>) => {
  const gasUsed = toFiniteNumber(row.gasUsed ?? row.cumulativeGasUsed ?? 0);
  const gasPrice = toFiniteNumber(row.gasPrice ?? row.effectiveGasPrice ?? 0);
  if (!Number.isFinite(gasUsed) || !Number.isFinite(gasPrice) || gasUsed <= 0 || gasPrice <= 0) return 0;
  return (gasUsed * gasPrice) / 1e18;
};

const parseTopicAddress = (topic: string) => {
  const normalized = String(topic || "").toLowerCase().replace(/^0x/, "");
  if (normalized.length < 40) return "";
  return normalizeAddress(`0x${normalized.slice(-40)}`);
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

const fetchExplorerAction = async (action: ExplorerAction, address: string) => {
  const rows: ExplorerRow[] = [];
  const warnings: string[] = [];
  const errors: Array<{ stage: string; message: string }> = [];
  const offset = 1000;
  const maxPages = 300;
  const maxRows = 120000;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      chain_id: String(CHAIN_ID),
      module: "account",
      action,
      address,
      startblock: "0",
      endblock: "99999999",
      page: String(page),
      offset: String(offset),
      sort: "asc",
    });

    const payload = await safeFetchJson(`${HYPERSCAN_API_URL}?${params.toString()}`);
    if (!payload || typeof payload !== "object") break;

    const result = (payload as Record<string, unknown>).result;
    if (typeof result === "string") {
      const msg = result.toLowerCase();
      if (msg.includes("no transactions")) break;
      warnings.push(`Hyperscan ${action}: ${result}`);
      break;
    }

    if (!Array.isArray(result)) break;
    const pageRows = result.filter(isObject) as ExplorerRow[];
    rows.push(...pageRows);
    if (rows.length >= maxRows) {
      warnings.push(`Hyperscan ${action} capped at ${maxRows} rows for runtime safety.`);
      break;
    }
    if (pageRows.length < offset) break;
  }

  if (rows.length === 0 && action === "logs") {
    warnings.push("Hyperscan logs endpoint returned no rows; relying on tx receipts.");
  }

  return { rows, warnings, errors };
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
    ].join("|");
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber));
};

const enrichMissingTimestamps = async (activities: RawActivity[]) => {
  const blockNumbers = [...new Set(activities.filter((a) => a.timestamp <= 0 && a.blockNumber > 0).map((a) => a.blockNumber))].slice(0, 320);
  const tsByBlock = new Map<number, number>();
  const concurrency = 10;
  for (let i = 0; i < blockNumbers.length; i += concurrency) {
    const chunk = blockNumbers.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (blockNumber) => {
        const result = await jsonRpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
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
};

const addReceiptLogs = async (
  wallet: string,
  txHashes: string[],
  out: RawActivity[],
  errors: Array<{ stage: string; message: string }>
) => {
  const limit = 80;
  const targets = txHashes.slice(0, limit);
  const concurrency = 10;
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (txHash) => {
    const receipt = await jsonRpc("eth_getTransactionReceipt", [txHash]);
    if (!receipt || typeof receipt !== "object") return;
    const logs = Array.isArray((receipt as Record<string, unknown>).logs)
      ? ((receipt as Record<string, unknown>).logs as unknown[]).filter(isObject)
      : [];

    const blockNumber = toHexInt(String((receipt as Record<string, unknown>).blockNumber ?? "0x0"));
    const transaction = await jsonRpc("eth_getTransactionByHash", [txHash]);
    const txObj = isObject(transaction) ? transaction : null;
    const from = normalizeAddress(String(txObj?.from ?? ""));
    const to = normalizeAddress(String(txObj?.to ?? ""));
    const methodId = readMethodId(txObj?.input);

    for (const log of logs) {
      const logIndex = toHexInt(String(log.logIndex ?? "0x0"));
      const contractAddress = normalizeAddress(readStringKeys(log, ["address"]));
      const topics = Array.isArray(log.topics) ? log.topics.map((x) => String(x).toLowerCase()) : [];
      const data = String(log.data ?? "0x");

      out.push({
        txHash,
        blockNumber,
        timestamp: 0,
        from,
        to,
        contractAddress,
        type: "contract_log",
        direction: direction(wallet, from, to),
        methodId,
        topics,
        data,
        source: "rpc_receipt_log",
        logIndex,
      });

      const firstTopic = topics[0] || "";
      if (firstTopic.startsWith(ERC20_TRANSFER_TOPIC_PREFIX) && topics.length >= 3) {
        const transferFrom = parseTopicAddress(topics[1]);
        const transferTo = parseTopicAddress(topics[2]);
        const transferDirection = direction(wallet, transferFrom, transferTo);
        if (transferDirection !== "unknown") {
          const transferRaw = hexToDecString(data);
          out.push({
            txHash,
            blockNumber,
            timestamp: 0,
            from: transferFrom,
            to: transferTo,
            contractAddress,
            type: "erc20_transfer",
            token: contractAddress,
            amountRaw: transferRaw,
            amount: rawToFloat(transferRaw, 18),
            direction: transferDirection,
            methodId,
            topics,
            data,
            source: "rpc_receipt_log",
            logIndex,
          });

          if (isBridgeSystemAddress(transferFrom) || isBridgeSystemAddress(transferTo) || isBridgeSystemAddress(contractAddress)) {
            out.push({
              txHash,
              blockNumber,
              timestamp: 0,
              from: transferFrom,
              to: transferTo,
              contractAddress,
              type: "bridge_event",
              token: contractAddress,
              amountRaw: transferRaw,
              amount: rawToFloat(transferRaw, 18),
              direction: transferDirection,
              methodId,
              topics,
              data,
              source: "rpc_receipt_log",
              logIndex,
            });
          }
        }
      }

      if (isBridgeSystemAddress(contractAddress) || isBridgeSystemAddress(from) || isBridgeSystemAddress(to)) {
        out.push({
          txHash,
          blockNumber,
          timestamp: 0,
          from,
          to,
          contractAddress,
          type: "bridge_event",
          direction: direction(wallet, from, to),
          methodId,
          topics,
          data,
          source: "rpc_receipt_log",
          logIndex,
        });
      }
    }
    }));
  }

  if (txHashes.length > limit) {
    errors.push({
      stage: "rpc_receipts",
      message: `Receipt enrichment capped at ${limit} tx hashes (from ${txHashes.length}).`,
    });
  }
};

export const indexWalletActivity = async (walletAddress: string): Promise<HevmIndexerResult> => {
  const wallet = normalizeAddress(walletAddress);
  const out: RawActivity[] = [];
  const warnings: string[] = [];
  const errors: Array<{ stage: string; message: string }> = [];
  const dataSourcesUsed = new Set<string>([
    "hyperscan:txlist",
    "hyperscan:tokentx",
    "hyperscan:txlistinternal",
    "rpc:eth_getTransactionReceipt",
    "rpc:eth_getTransactionByHash",
    "rpc:eth_getBlockByNumber",
  ]);

  const [normalRes, tokenRes, internalRes, logsRes] = await Promise.all([
    fetchExplorerAction("txlist", wallet),
    fetchExplorerAction("tokentx", wallet),
    fetchExplorerAction("txlistinternal", wallet),
    fetchExplorerAction("logs", wallet),
  ]);

  warnings.push(...normalRes.warnings, ...tokenRes.warnings, ...internalRes.warnings, ...logsRes.warnings);
  errors.push(...normalRes.errors, ...tokenRes.errors, ...internalRes.errors, ...logsRes.errors);

  const normalRows = normalRes.rows;
  const tokenRows = tokenRes.rows;
  const internalRows = internalRes.rows;
  const logRows = logsRes.rows;

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
      source: "hyperscan_txlist",
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
        source: "hyperscan_txlist",
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
        source: "hyperscan_txlist",
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
      logIndex: toInt(row.logIndex ?? row.transactionIndex ?? 0),
      source: "hyperscan_tokentx",
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
        logIndex: toInt(row.logIndex ?? row.transactionIndex ?? 0),
        source: "hyperscan_tokentx",
      });
    }
  }

  for (const row of internalRows) {
    const txHash = normalizeTxHash(readStringKeys(row, ["hash", "transactionHash"]));
    if (!txHash) continue;
    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    const amountRaw = String(row.value ?? "0");
    const amount = rawToFloat(amountRaw, 18);
    const dir = direction(wallet, from, to);

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
      traceId: readStringKeys(row, ["traceId", "trace_id"]),
      source: "hyperscan_internal",
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
        traceId: readStringKeys(row, ["traceId", "trace_id"]),
        source: "hyperscan_internal",
      });
    }
  }

  for (const row of logRows) {
    const txHash = normalizeTxHash(readStringKeys(row, ["hash", "transactionHash", "transactionHash"]));
    if (!txHash) continue;
    const contractAddress = normalizeAddress(readStringKeys(row, ["address", "contractAddress"]));
    const logIndex = toInt(row.logIndex ?? 0);
    out.push({
      txHash,
      blockNumber: readBlock(row),
      timestamp: readTime(row),
      contractAddress,
      type: "contract_log",
      direction: "unknown",
      logIndex,
      source: "rpc_getLogs",
    });
  }

  const txHashes = [...new Set(out.map((x) => x.txHash).filter(Boolean))];
  if (logRows.length === 0 && txHashes.length <= 1800) {
    await addReceiptLogs(wallet, txHashes, out, errors);
  } else {
    warnings.push("Skipped tx receipt enrichment (explorer logs available or tx volume too high for runtime budget).");
  }

  await enrichMissingTimestamps(out);
  const activities = dedupeActivities(out).filter((a) => a.timestamp > 0);

  if (activities.length === 0) {
    warnings.push("No HEVM activity detected from current indexer sources.");
  }

  return {
    activities,
    warnings,
    errors,
    dataSourcesUsed: [...dataSourcesUsed],
  };
};
