import { normalizeAddress, readStringKeys, toFiniteNumber } from "@/lib/dashboard/shared";
import { RawActivity } from "@/lib/hevm/types";

const HYPERSCAN_API_URL = "https://www.hyperscan.com/api";
const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
const CHAIN_ID = 999;

type ExplorerAction = "txlist" | "tokentx" | "txlistinternal";

type ExplorerRow = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";

const readTime = (r: Record<string, unknown>) => Math.floor(toFiniteNumber(r.timeStamp ?? r.timestamp ?? r.time ?? 0));
const readBlock = (r: Record<string, unknown>) => Math.floor(toFiniteNumber(r.blockNumber ?? 0));
const readGasFeeNative = (r: Record<string, unknown>) => {
  const gasUsed = toFiniteNumber(r.gasUsed ?? r.cumulativeGasUsed ?? 0);
  const gasPrice = toFiniteNumber(r.gasPrice ?? r.effectiveGasPrice ?? 0);
  if (!Number.isFinite(gasUsed) || !Number.isFinite(gasPrice) || gasUsed <= 0 || gasPrice <= 0) return 0;
  return (gasUsed * gasPrice) / 1e18;
};
const toWei = (raw: string | number | undefined, decimals = 18) => {
  const s = String(raw ?? "0").trim();
  if (!/^\d+$/.test(s)) return 0;
  if (s === "0") return 0;
  const padded = s.padStart(decimals + 1, "0");
  const i = padded.slice(0, -decimals);
  const f = padded.slice(-decimals, -Math.max(0, decimals - 8));
  const n = Number(`${i}.${f}`);
  return Number.isFinite(n) ? n : 0;
};

const fetchExplorer = async (action: ExplorerAction, address: string): Promise<ExplorerRow[]> => {
  const rows: ExplorerRow[] = [];
  const offset = 1000;
  for (let page = 1; page <= 300; page += 1) {
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
    const res = await fetch(`${HYPERSCAN_API_URL}?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) break;
    const payload = await res.json().catch(() => null);
    if (!isObject(payload)) break;
    const result = payload.result;
    if (!Array.isArray(result) || result.length === 0) break;
    const pageRows = result.filter(isObject) as ExplorerRow[];
    rows.push(...pageRows);
    if (pageRows.length < offset) break;
  }
  return rows;
};

const jsonRpc = async (method: string, params: unknown[]) => {
  const res = await fetch(HYPEREVM_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  return isObject(payload) ? payload.result ?? null : null;
};

const fetchReceiptLogs = async (txHash: string): Promise<Array<Record<string, unknown>>> => {
  const receipt = (await jsonRpc("eth_getTransactionReceipt", [txHash])) as Record<string, unknown> | null;
  if (!receipt || !Array.isArray(receipt.logs)) return [];
  return receipt.logs.filter(isObject) as Array<Record<string, unknown>>;
};

const dedupe = (items: RawActivity[]) => {
  const map = new Map<string, RawActivity>();
  for (const i of items) {
    const key = `${i.txHash}:${i.type}:${i.logIndex ?? ""}:${i.traceId ?? ""}:${i.contractAddress ?? i.token ?? ""}:${i.amountRaw ?? ""}`;
    if (!map.has(key)) map.set(key, i);
  }
  return [...map.values()].sort((a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber));
};

const direction = (wallet: string, from?: string, to?: string): RawActivity["direction"] => {
  const f = normalizeAddress(from ?? "");
  const t = normalizeAddress(to ?? "");
  if (f === wallet && t === wallet) return "self";
  if (f === wallet) return "out";
  if (t === wallet) return "in";
  return "unknown";
};

export const indexWalletActivity = async (walletAddress: string): Promise<RawActivity[]> => {
  const wallet = normalizeAddress(walletAddress);
  const out: RawActivity[] = [];

  const [normal, token, internal] = await Promise.all([
    fetchExplorer("txlist", wallet),
    fetchExplorer("tokentx", wallet),
    fetchExplorer("txlistinternal", wallet),
  ]);

  for (const row of normal) {
    const txHash = readStringKeys(row, ["hash", "transactionHash"]).toLowerCase().trim();
    if (!txHash) continue;
    const timestamp = readTime(row);
    const blockNumber = readBlock(row);
    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    const value = toWei(String(row.value ?? "0"), 18);
    out.push({
      txHash,
      blockNumber,
      timestamp,
      from,
      to,
      amount: value,
      amountRaw: String(row.value ?? "0"),
      feeNative: readGasFeeNative(row),
      token: "HYPE",
      direction: direction(wallet, from, to),
      type: "normal_tx",
    });
    if (value > 0) {
      out.push({
        txHash,
        blockNumber,
        timestamp,
        from,
        to,
        amount: value,
        amountRaw: String(row.value ?? "0"),
        token: "HYPE",
        direction: direction(wallet, from, to),
        type: "native_transfer",
      });
    }
  }

  for (const row of token) {
    const txHash = readStringKeys(row, ["hash", "transactionHash"]).toLowerCase().trim();
    if (!txHash) continue;
    const decimals = Math.max(0, Math.floor(toFiniteNumber(row.tokenDecimal ?? 18)));
    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    out.push({
      txHash,
      blockNumber: readBlock(row),
      timestamp: readTime(row),
      from,
      to,
      contractAddress: normalizeAddress(readStringKeys(row, ["contractAddress", "tokenAddress"])),
      token: readStringKeys(row, ["tokenSymbol", "symbol"]).toUpperCase(),
      amountRaw: String(row.value ?? "0"),
      amount: toWei(String(row.value ?? "0"), decimals),
      direction: direction(wallet, from, to),
      type: "erc20_transfer",
      logIndex: Math.floor(toFiniteNumber(row.logIndex ?? 0)),
    });
  }

  for (const row of internal) {
    const txHash = readStringKeys(row, ["hash", "transactionHash"]).toLowerCase().trim();
    if (!txHash) continue;
    const from = normalizeAddress(readStringKeys(row, ["from"]));
    const to = normalizeAddress(readStringKeys(row, ["to"]));
    out.push({
      txHash,
      blockNumber: readBlock(row),
      timestamp: readTime(row),
      from,
      to,
      token: "HYPE",
      amountRaw: String(row.value ?? "0"),
      amount: toWei(String(row.value ?? "0"), 18),
      direction: direction(wallet, from, to),
      type: "internal_transfer",
      traceId: readStringKeys(row, ["traceId", "trace_id"]),
    });
  }

  const txHashes = [...new Set(out.map((x) => x.txHash).filter(Boolean))];
  const maxLogs = 400;
  for (const txHash of txHashes.slice(0, maxLogs)) {
    const logs = await fetchReceiptLogs(txHash);
    for (const log of logs) {
      const blockNumberHex = String(log.blockNumber ?? "0x0");
      const blockNumber = Number.parseInt(blockNumberHex, 16) || 0;
      const timestamp = 0;
      const logIndexHex = String(log.logIndex ?? "0x0");
      const logIndex = Number.parseInt(logIndexHex, 16) || 0;
      const contractAddress = normalizeAddress(readStringKeys(log, ["address"]));
      out.push({
        txHash,
        blockNumber,
        timestamp,
        contractAddress,
        type: "contract_log",
        logIndex,
        direction: "unknown",
      });
      if (contractAddress === "0x2222222222222222222222222222222222222222") {
        out.push({
          txHash,
          blockNumber,
          timestamp,
          contractAddress,
          type: "bridge_event",
          logIndex,
          direction: "unknown",
        });
      }
    }
  }

  return dedupe(out);
};
