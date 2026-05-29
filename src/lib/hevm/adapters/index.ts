import { normalizeAddress } from "@/lib/dashboard/shared";
import { ClassifiedActivity, HevmProtocolAdapter, Position, PriceContext, RawActivity } from "@/lib/hevm/types";

const mk = (
  activity: RawActivity,
  id: string,
  name: string,
  category: HevmProtocolAdapter["category"],
  confidence: number
): ClassifiedActivity => ({
  ...activity,
  protocolId: id,
  protocolName: name,
  category,
  confidence,
});

const emptyPositions = async (): Promise<Position[]> => [];

const amountToUsd = async (activity: ClassifiedActivity, ctx: PriceContext) => {
  if (!activity.amount || activity.amount <= 0) return 0;
  const token = activity.token ?? "HYPE";
  const price = await ctx.resolvePriceUsd(token, activity.timestamp);
  return price.priceUsd && price.priceUsd > 0 ? activity.amount * price.priceUsd : 0;
};

export const nativeAdapter: HevmProtocolAdapter = {
  id: "native",
  name: "Native",
  category: "native",
  contracts: [],
  classifyActivity(activity) {
    if (activity.type !== "native_transfer") return [];
    return [mk(activity, "native", "Native", "native", 1)];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const erc20Adapter: HevmProtocolAdapter = {
  id: "erc20",
  name: "ERC20",
  category: "erc20",
  contracts: [],
  classifyActivity(activity) {
    if (activity.type !== "erc20_transfer") return [];
    return [mk(activity, "erc20", "ERC20", "erc20", 1)];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

const classifyByContractKeyword = (
  activity: RawActivity,
  id: string,
  name: string,
  category: HevmProtocolAdapter["category"],
  keywords: string[]
) => {
  const contract = (activity.contractAddress ?? activity.to ?? "").toLowerCase();
  if (!contract) return [] as ClassifiedActivity[];
  const hits = keywords.some((k) => contract.includes(k));
  return hits ? [mk(activity, id, name, category, 0.6)] : [];
};

export const dexAdapter: HevmProtocolAdapter = {
  id: "dex",
  name: "DEX",
  category: "dex",
  contracts: [],
  classifyActivity(activity) {
    return classifyByContractKeyword(activity, "dex", "DEX", "dex", ["swap", "router"]);
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const lendingAdapter: HevmProtocolAdapter = {
  id: "lending",
  name: "Lending",
  category: "lending",
  contracts: [],
  classifyActivity(activity) {
    return classifyByContractKeyword(activity, "lending", "Lending", "lending", ["lend", "borrow", "morpho", "felix"]);
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const vaultAdapter: HevmProtocolAdapter = {
  id: "vault",
  name: "Vault",
  category: "vault",
  contracts: [],
  classifyActivity(activity) {
    return classifyByContractKeyword(activity, "vault", "Vault", "vault", ["vault", "yv", "share"]);
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const stakingAdapter: HevmProtocolAdapter = {
  id: "staking",
  name: "Staking",
  category: "staking",
  contracts: [],
  classifyActivity(activity) {
    return classifyByContractKeyword(activity, "staking", "Staking", "staking", ["stake", "validator", "delegat"]);
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const bridgeAdapter: HevmProtocolAdapter = {
  id: "bridge",
  name: "Bridge",
  category: "bridge",
  contracts: ["0x2222222222222222222222222222222222222222"],
  classifyActivity(activity) {
    const c = normalizeAddress(activity.to ?? activity.contractAddress ?? "");
    if (activity.type === "bridge_event" || c === "0x2222222222222222222222222222222222222222") {
      return [mk(activity, "bridge", "Bridge", "bridge", 1)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const unknownContractAdapter: HevmProtocolAdapter = {
  id: "unknown",
  name: "Unknown",
  category: "unknown",
  contracts: [],
  classifyActivity(activity) {
    if ((activity.type === "contract_log" || activity.type === "defi_event") && activity.contractAddress) {
      return [mk(activity, "unknown", "Unknown", "unknown", 0.3)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const allAdapters: HevmProtocolAdapter[] = [
  bridgeAdapter,
  nativeAdapter,
  erc20Adapter,
  dexAdapter,
  lendingAdapter,
  vaultAdapter,
  stakingAdapter,
  unknownContractAdapter,
];
