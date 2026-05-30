import { normalizeAddress } from "@/lib/dashboard/shared";
import { ClassifiedActivity, HevmProtocolAdapter, PortfolioSegment, Position, PriceContext, PriceResult } from "@/lib/hevm/types";

type BuildTimelineArgs = {
  wallet: string;
  activities: ClassifiedActivity[];
  adapters: HevmProtocolAdapter[];
  priceContext: PriceContext;
  endTimestamp: number;
};

type ProtocolRef = {
  protocolId: string;
  protocolName: string;
  category: "dex" | "lending" | "vault" | "staking" | "bridge";
  confidence: number;
};

const EPSILON = 1e-12;
const TRANSFER_TYPES = new Set<ClassifiedActivity["type"]>([
  "erc20_transfer",
  "native_transfer",
  "internal_transfer",
]);
const STABLES = new Set(["USDC", "USDT", "DAI", "USD0", "USDH", "USDHL", "USDE", "USDT0", "FDUSD", "USDP", "FEUSD"]);
const TWAB_FALLBACK_EVENT_MAX_AGE_SECONDS = 7 * 86400;
const INCLUDE_PROTOCOL_CUSTODY_IN_TWAB = false;
const TWAB_FALLBACK_ALWAYS_ALLOWED_SYMBOLS = new Set([...STABLES, "USD", "USDXL"]);

const isProtocolCategory = (
  category: ClassifiedActivity["category"] | HevmProtocolAdapter["category"]
): category is "dex" | "lending" | "vault" | "staking" | "bridge" => {
  return category === "dex" || category === "lending" || category === "vault" || category === "staking" || category === "bridge";
};
const isCustodyCategory = (
  category: ProtocolRef["category"]
): category is "lending" | "vault" | "staking" => {
  return category === "lending" || category === "vault" || category === "staking";
};

const isValidAddress = (value: string) => value.startsWith("0x") && value.length === 42;

const nonZero = (value: number) => Number.isFinite(value) && Math.abs(value) > EPSILON;

const balanceKey = (token: string) => {
  const t = (token || "HYPE").trim();
  if (!t) return "HYPE";
  return t.toUpperCase();
};

const transferDedupeKey = (activity: ClassifiedActivity) =>
  [
    activity.txHash,
    activity.type,
    normalizeAddress(activity.from || ""),
    normalizeAddress(activity.to || ""),
    normalizeAddress(activity.contractAddress || ""),
    activity.token || "",
    activity.amountRaw || "",
    activity.logIndex ?? "",
    activity.traceId ?? "",
    activity.direction ?? "",
  ].join("|");

const dedupeTransferActivities = (activities: ClassifiedActivity[]) => {
  const seen = new Set<string>();
  const out: ClassifiedActivity[] = [];
  for (const activity of activities) {
    if (!TRANSFER_TYPES.has(activity.type)) continue;
    const key = transferDedupeKey(activity);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(activity);
  }
  return out;
};

const resolveDirection = (wallet: string, activity: ClassifiedActivity): "in" | "out" | "self" | "unknown" => {
  const declared = activity.direction;
  if (declared === "in" || declared === "out" || declared === "self") return declared;

  const from = normalizeAddress(activity.from || "");
  const to = normalizeAddress(activity.to || "");
  if (from === wallet && to === wallet) return "self";
  if (from === wallet && to && to !== wallet) return "out";
  if (to === wallet && from && from !== wallet) return "in";
  return "unknown";
};

const updateBalance = (balances: Map<string, number>, key: string, delta: number) => {
  if (!Number.isFinite(delta) || Math.abs(delta) <= EPSILON) return;
  const previous = balances.get(key) ?? 0;
  const next = previous + delta;
  if (!nonZero(next)) balances.delete(key);
  else balances.set(key, next);
};

const buildProtocolIndexes = (
  wallet: string,
  activities: ClassifiedActivity[],
  adapters: HevmProtocolAdapter[]
) => {
  const byContract = new Map<string, ProtocolRef>();
  const byTxHash = new Map<string, ProtocolRef>();

  for (const adapter of adapters) {
    if (!isProtocolCategory(adapter.category)) continue;
    const ref: ProtocolRef = {
      protocolId: adapter.id,
      protocolName: adapter.name,
      category: adapter.category,
      confidence: 1,
    };
    for (const contract of adapter.contracts) {
      const address = normalizeAddress(contract);
      if (!isValidAddress(address) || address === wallet) continue;
      if (!byContract.has(address)) byContract.set(address, ref);
    }
  }

  for (const activity of activities) {
    if (!isProtocolCategory(activity.category)) continue;
    const ref: ProtocolRef = {
      protocolId: activity.protocolId || `detected:${activity.category}`,
      protocolName: activity.protocolName || `Detected ${activity.category}`,
      category: activity.category,
      confidence: Number.isFinite(activity.confidence) ? activity.confidence : 0.5,
    };

    const existing = byTxHash.get(activity.txHash);
    if (!existing || ref.confidence > existing.confidence) byTxHash.set(activity.txHash, ref);

    const addresses = [activity.to, activity.contractAddress]
      .map((row) => normalizeAddress(row || ""))
      .filter((address) => isValidAddress(address) && address !== wallet);
    for (const address of addresses) {
      const existingRef = byContract.get(address);
      if (!existingRef || ref.confidence > existingRef.confidence) byContract.set(address, ref);
    }
  }

  return { byContract, byTxHash };
};

const resolveProtocolForTransfer = (
  wallet: string,
  activity: ClassifiedActivity,
  indexes: ReturnType<typeof buildProtocolIndexes>
) => {
  const direction = resolveDirection(wallet, activity);
  if (direction !== "in" && direction !== "out") return null;

  const counterparty = normalizeAddress(direction === "out" ? (activity.to || "") : (activity.from || ""));
  if (isValidAddress(counterparty) && counterparty !== wallet) {
    const direct = indexes.byContract.get(counterparty);
    if (direct) return { ...direct, counterparty };
  }

  const txRef = indexes.byTxHash.get(activity.txHash);
  if (!txRef) return null;
  if (!isValidAddress(counterparty) || counterparty === wallet) return null;
  return { ...txRef, counterparty };
};

const shouldAcceptTwabPrice = (
  price: PriceResult,
  asset: string,
  timestamp: number,
  endTimestamp: number,
  mode: "event" | "current"
) => {
  if (price.priceUsd === null || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0) return false;
  if (price.source !== "fallback_current") return true;
  const pricedToken = String(price.token || "").trim().toUpperCase();
  if (
    TWAB_FALLBACK_ALWAYS_ALLOWED_SYMBOLS.has(pricedToken) ||
    TWAB_FALLBACK_ALWAYS_ALLOWED_SYMBOLS.has(asset) ||
    asset.startsWith("USD")
  ) {
    return true;
  }
  if (mode === "current") return true;
  const ageSeconds = Math.max(0, endTimestamp - timestamp);
  return ageSeconds <= TWAB_FALLBACK_EVENT_MAX_AGE_SECONDS;
};

const buildUsdPositions = async (
  walletBalances: Map<string, number>,
  protocolBalances: Map<string, { protocol: ProtocolRef; asset: string; amount: number; contract: string }>,
  timestamp: number,
  blockNumber: number,
  endTimestamp: number,
  priceContext: PriceContext,
  mode: "event" | "current"
) => {
  const positions: Position[] = [];
  const priceSources: PriceResult[] = [];
  let totalUsd = 0;

  for (const [asset, amount] of walletBalances.entries()) {
    if (!nonZero(amount)) continue;
    const price = await priceContext.resolvePriceUsd(asset, timestamp);
    priceSources.push(price);
    if (!shouldAcceptTwabPrice(price, asset, timestamp, endTimestamp, mode)) continue;
    const valueUsd = amount * (price.priceUsd ?? 0);
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) continue;
    totalUsd += valueUsd;
    positions.push({
      protocol: "wallet",
      category: "wallet_balance",
      asset,
      amount,
      valueUsd,
      blockNumber,
      timestamp,
      source: "wallet_balance",
    });
  }

  if (!INCLUDE_PROTOCOL_CUSTODY_IN_TWAB) {
    return { positions, priceSources, totalUsd };
  }

  for (const row of protocolBalances.values()) {
    if (!nonZero(row.amount)) continue;
    const asset = balanceKey(row.asset);
    const price = await priceContext.resolvePriceUsd(asset, timestamp);
    priceSources.push(price);
    if (!shouldAcceptTwabPrice(price, asset, timestamp, endTimestamp, mode)) continue;
    const valueUsd = row.amount * (price.priceUsd ?? 0);
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) continue;
    totalUsd += valueUsd;
    positions.push({
      protocol: row.protocol.protocolName,
      category: row.protocol.category,
      asset,
      amount: row.amount,
      valueUsd,
      blockNumber,
      timestamp,
      source:
        row.protocol.category === "lending"
          ? "lending"
          : row.protocol.category === "staking"
            ? "staking"
            : row.protocol.category === "vault" || row.protocol.category === "dex"
              ? "lp"
              : row.protocol.category === "bridge"
                ? "bridge"
                : "unknown",
    });
  }

  return { positions, priceSources, totalUsd };
};

const applyTransferToLedgers = (
  wallet: string,
  activity: ClassifiedActivity,
  indexes: ReturnType<typeof buildProtocolIndexes>,
  walletBalances: Map<string, number>,
  protocolBalances: Map<string, { protocol: ProtocolRef; asset: string; amount: number; contract: string }>
) => {
  const token = balanceKey(activity.token || activity.tokenSymbol || "HYPE");
  const amount = Number.isFinite(activity.amount) ? Math.max(0, activity.amount ?? 0) : 0;
  if (!nonZero(amount)) return;

  const direction = resolveDirection(wallet, activity);
  if (direction !== "in" && direction !== "out") return;

  const protocolHit = resolveProtocolForTransfer(wallet, activity, indexes);

  if (direction === "out") {
    updateBalance(walletBalances, token, -amount);
    if (!protocolHit || !isCustodyCategory(protocolHit.category)) return;
    const protocolKey = `${protocolHit.protocolId}:${protocolHit.counterparty}:${token}`;
    const previous = protocolBalances.get(protocolKey) ?? {
      protocol: protocolHit,
      asset: token,
      amount: 0,
      contract: protocolHit.counterparty,
    };
    previous.amount = Math.max(0, previous.amount + amount);
    if (!nonZero(previous.amount)) protocolBalances.delete(protocolKey);
    else protocolBalances.set(protocolKey, previous);
    return;
  }

  updateBalance(walletBalances, token, amount);
  if (!protocolHit || !isCustodyCategory(protocolHit.category)) return;
  const protocolKey = `${protocolHit.protocolId}:${protocolHit.counterparty}:${token}`;
  const previous = protocolBalances.get(protocolKey);
  if (!previous) return;
  previous.amount = Math.max(0, previous.amount - amount);
  if (!nonZero(previous.amount)) protocolBalances.delete(protocolKey);
  else protocolBalances.set(protocolKey, previous);
};

type PricedTransferDelta = {
  timestamp: number;
  blockNumber: number;
  deltaUsd: number;
  price: PriceResult;
};

const applyTransferToWalletBalance = (
  wallet: string,
  activity: ClassifiedActivity,
  walletBalances: Map<string, number>
) => {
  const token = balanceKey(activity.token || activity.tokenSymbol || "HYPE");
  const amount = Number.isFinite(activity.amount) ? Math.max(0, activity.amount ?? 0) : 0;
  if (!nonZero(amount)) return;
  const direction = resolveDirection(wallet, activity);
  if (direction === "in") {
    updateBalance(walletBalances, token, amount);
    return;
  }
  if (direction === "out") {
    updateBalance(walletBalances, token, -amount);
  }
};

const buildPricedTransferDeltas = async (
  wallet: string,
  activities: ClassifiedActivity[],
  endTimestamp: number,
  priceContext: PriceContext
) => {
  const deltas: PricedTransferDelta[] = [];

  for (const activity of activities) {
    const direction = resolveDirection(wallet, activity);
    if (direction !== "in" && direction !== "out") continue;

    const token = balanceKey(activity.token || activity.tokenSymbol || "HYPE");
    const amount = Number.isFinite(activity.amount) ? Math.max(0, activity.amount ?? 0) : 0;
    if (!nonZero(amount)) continue;

    const price = await priceContext.resolvePriceUsd(token, activity.timestamp);
    if (!shouldAcceptTwabPrice(price, token, activity.timestamp, endTimestamp, "event")) continue;

    const sign = direction === "in" ? 1 : -1;
    const deltaUsd = sign * amount * (price.priceUsd ?? 0);
    if (!Number.isFinite(deltaUsd) || Math.abs(deltaUsd) <= EPSILON) continue;

    deltas.push({
      timestamp: activity.timestamp,
      blockNumber: activity.blockNumber,
      deltaUsd,
      price,
    });
  }

  return deltas.sort((a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber));
};

export const buildPortfolioTimeline = async (
  args: BuildTimelineArgs
): Promise<{ segments: PortfolioSegment[]; currentPositions: Position[]; currentPortfolioUsd: number }> => {
  const wallet = normalizeAddress(args.wallet);
  const transferActivities = dedupeTransferActivities(args.activities)
    .filter((activity) => Number.isFinite(activity.timestamp) && activity.timestamp > 0)
    .sort((a, b) => (a.timestamp - b.timestamp) || (a.blockNumber - b.blockNumber));

  if (transferActivities.length === 0) {
    return { segments: [], currentPositions: [], currentPortfolioUsd: 0 };
  }

  const walletBalances = new Map<string, number>();
  for (const activity of transferActivities) {
    applyTransferToWalletBalance(wallet, activity, walletBalances);
  }

  const lastBlock = transferActivities[transferActivities.length - 1].blockNumber;
  const currentSnapshot = await buildUsdPositions(
    walletBalances,
    new Map(),
    args.endTimestamp,
    lastBlock,
    args.endTimestamp,
    args.priceContext,
    "current"
  );

  const pricedDeltas = await buildPricedTransferDeltas(
    wallet,
    transferActivities,
    args.endTimestamp,
    args.priceContext
  );

  if (pricedDeltas.length === 0) {
    const startTimestamp = transferActivities[0].timestamp;
    const endTimestamp = Math.max(startTimestamp, args.endTimestamp);
    const durationSeconds = Math.max(0, endTimestamp - startTimestamp);
    return {
      segments: [
        {
          startTimestamp,
          endTimestamp,
          durationSeconds,
          totalUsd: currentSnapshot.totalUsd,
          contribution: currentSnapshot.totalUsd * durationSeconds,
          positions: currentSnapshot.positions,
          priceSources: currentSnapshot.priceSources,
        },
      ],
      currentPositions: currentSnapshot.positions,
      currentPortfolioUsd: currentSnapshot.totalUsd,
    };
  }

  const reverseSegments: PortfolioSegment[] = [];
  let runningUsd = currentSnapshot.totalUsd;
  let cursorTimestamp = Math.max(args.endTimestamp, pricedDeltas[pricedDeltas.length - 1].timestamp);

  for (let index = pricedDeltas.length - 1; index >= 0; index -= 1) {
    const row = pricedDeltas[index];
    const startTimestamp = Math.min(cursorTimestamp, row.timestamp);
    const endTimestamp = cursorTimestamp;
    const durationSeconds = Math.max(0, endTimestamp - startTimestamp);
    const totalUsd = Math.max(0, runningUsd);

    reverseSegments.push({
      startTimestamp,
      endTimestamp,
      durationSeconds,
      totalUsd,
      contribution: totalUsd * durationSeconds,
      positions: [],
      priceSources: [row.price],
    });

    runningUsd -= row.deltaUsd;
    cursorTimestamp = startTimestamp;
  }

  const firstTimestamp = pricedDeltas[0].timestamp;
  if (cursorTimestamp > firstTimestamp) {
    const durationSeconds = Math.max(0, cursorTimestamp - firstTimestamp);
    const totalUsd = Math.max(0, runningUsd);
    reverseSegments.push({
      startTimestamp: firstTimestamp,
      endTimestamp: cursorTimestamp,
      durationSeconds,
      totalUsd,
      contribution: totalUsd * durationSeconds,
      positions: [],
      priceSources: [],
    });
  }

  const segments = reverseSegments
    .reverse()
    .filter((segment) => Number.isFinite(segment.durationSeconds) && segment.durationSeconds >= 0);

  if (segments.length > 0) {
    segments[segments.length - 1] = {
      ...segments[segments.length - 1],
      positions: currentSnapshot.positions,
      priceSources: [
        ...segments[segments.length - 1].priceSources,
        ...currentSnapshot.priceSources,
      ],
    };
  }

  return {
    segments,
    currentPositions: currentSnapshot.positions,
    currentPortfolioUsd: currentSnapshot.totalUsd,
  };
};
