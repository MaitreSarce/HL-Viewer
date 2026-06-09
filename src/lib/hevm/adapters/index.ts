import { normalizeAddress } from "@/lib/dashboard/shared";
import { HYPE_CORE_SYSTEM_ADDRESS, isCoreBridgeSystemAddress } from "@/lib/hevm/bridge";
import { ClassifiedActivity, HevmProtocolAdapter, Position, PriceContext, Protocol, RawActivity } from "@/lib/hevm/types";

const ERC20_TRANSFER_TOPIC = "0xddf252ad";

const classify = (
  activity: RawActivity,
  adapter: Pick<HevmProtocolAdapter, "id" | "name" | "category">,
  confidence: number
): ClassifiedActivity => ({
  ...activity,
  protocolId: adapter.id,
  protocolName: adapter.name,
  category: adapter.category,
  confidence,
});

const emptyPositions = async (): Promise<Position[]> => [];

const amountToUsd = async (activity: ClassifiedActivity, ctx: PriceContext) => {
  const amount = Number.isFinite(activity.amount) ? Math.max(0, activity.amount ?? 0) : 0;
  if (amount <= 0) return 0;
  const token = (activity.token || "HYPE").toUpperCase();
  const price = await ctx.resolvePriceUsd(token, activity.timestamp);
  if (price.priceUsd === null || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0) return 0;
  return amount * price.priceUsd;
};

const categoryFromProtocol = (protocol: Protocol): HevmProtocolAdapter["category"] => {
  const c = protocol.category.toLowerCase();
  if (c.includes("dex") || c.includes("amm") || c.includes("swap")) return "dex";
  if (c.includes("lending") || c.includes("borrow") || c.includes("cdp")) return "lending";
  if (c.includes("vault") || c.includes("yield")) return "vault";
  if (c.includes("staking") || c.includes("lsd")) return "staking";
  if (c.includes("bridge")) return "bridge";
  return "unknown";
};

const contractFromActivity = (activity: RawActivity) =>
  normalizeAddress(activity.contractAddress || activity.to || "");

const makeProtocolContractMap = (protocols: Protocol[]) => {
  const map = new Map<string, { id: string; name: string; category: HevmProtocolAdapter["category"] }>();
  for (const protocol of protocols) {
    const category = categoryFromProtocol(protocol);
    for (const contract of protocol.contracts) {
      const addr = normalizeAddress(contract);
      if (!addr) continue;
      map.set(addr, {
        id: `protocol:${protocol.slug}`,
        name: protocol.name,
        category,
      });
    }
  }
  return map;
};

const makeContractKeywordCategory = (
  activity: RawActivity
): HevmProtocolAdapter["category"] | null => {
  const method = (activity.methodId || "").toLowerCase();
  if (["0x38ed1739", "0x18cbafe5", "0x7ff36ab5", "0x5c11d795", "0xac9650d8"].includes(method)) return "dex";
  if (["0x617ba037", "0x852a12e3", "0x69328dec"].includes(method)) return "lending";
  if (["0xa694fc3a", "0x2e1a7d4d"].includes(method)) return "vault";
  if (["0xa694fc3a", "0x3ccfd60b", "0x9e281a98"].includes(method)) return "staking";
  return null;
};

const isBridgeSystemAddress = (value: string) => {
  return isCoreBridgeSystemAddress(value);
};

export const nativeAdapter: HevmProtocolAdapter = {
  id: "native",
  name: "Native Transfers",
  category: "native",
  contracts: [],
  classifyActivity(activity) {
    if (activity.type !== "native_transfer" && activity.type !== "internal_transfer") return [];
    return [classify(activity, this, 1)];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const erc20Adapter: HevmProtocolAdapter = {
  id: "erc20",
  name: "ERC20 Transfers",
  category: "erc20",
  contracts: [],
  classifyActivity(activity) {
    if (activity.type === "erc20_transfer") return [classify(activity, this, 1)];
    if (activity.type === "contract_log" && (activity.topics?.[0] || "").toLowerCase().startsWith(ERC20_TRANSFER_TOPIC)) {
      return [classify(activity, this, 0.8)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const dexAdapter: HevmProtocolAdapter = {
  id: "dex",
  name: "DEX",
  category: "dex",
  contracts: [],
  classifyActivity(activity) {
    const method = (activity.methodId || "").toLowerCase();
    if (["0x38ed1739", "0x18cbafe5", "0x7ff36ab5", "0x5c11d795", "0xac9650d8"].includes(method)) {
      return [classify(activity, this, 0.9)];
    }
    const nameHint = (activity.contractAddress || activity.to || "").toLowerCase();
    if (nameHint.includes("swap") || nameHint.includes("router") || nameHint.includes("pool")) {
      return [classify(activity, this, 0.55)];
    }
    return [];
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
    const method = (activity.methodId || "").toLowerCase();
    if (["0x617ba037", "0x69328dec", "0x852a12e3", "0x573ade81"].includes(method)) {
      return [classify(activity, this, 0.9)];
    }
    const hint = (activity.contractAddress || activity.to || "").toLowerCase();
    if (hint.includes("lend") || hint.includes("borrow") || hint.includes("morpho") || hint.includes("felix")) {
      return [classify(activity, this, 0.6)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const vaultAdapter: HevmProtocolAdapter = {
  id: "vault",
  name: "Vaults",
  category: "vault",
  contracts: [],
  classifyActivity(activity) {
    const method = (activity.methodId || "").toLowerCase();
    if (["0xb6b55f25", "0x2e1a7d4d", "0x853828b6"].includes(method)) {
      return [classify(activity, this, 0.85)];
    }
    const hint = (activity.contractAddress || activity.to || "").toLowerCase();
    if (hint.includes("vault") || hint.includes("share") || hint.includes("yield")) {
      return [classify(activity, this, 0.55)];
    }
    return [];
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
    const method = (activity.methodId || "").toLowerCase();
    if (["0xa694fc3a", "0x3ccfd60b", "0x9e281a98"].includes(method)) {
      return [classify(activity, this, 0.9)];
    }
    const hint = (activity.contractAddress || activity.to || "").toLowerCase();
    if (hint.includes("stake") || hint.includes("validator") || hint.includes("delegat") || hint.includes("kinetiq")) {
      return [classify(activity, this, 0.6)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const bridgeAdapter: HevmProtocolAdapter = {
  id: "bridge",
  name: "Bridge",
  category: "bridge",
  contracts: [HYPE_CORE_SYSTEM_ADDRESS],
  classifyActivity(activity) {
    const to = normalizeAddress(activity.to || "");
    const from = normalizeAddress(activity.from || "");
    const contract = normalizeAddress(activity.contractAddress || "");
    if (activity.type === "bridge_event") return [classify(activity, this, 1)];
    if (isBridgeSystemAddress(to) || isBridgeSystemAddress(from) || isBridgeSystemAddress(contract)) {
      return [classify(activity, this, 0.95)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const unknownContractAdapter: HevmProtocolAdapter = {
  id: "unknown",
  name: "Unknown Contracts",
  category: "unknown",
  contracts: [],
  classifyActivity(activity) {
    if (activity.type === "contract_log" || activity.type === "defi_event") {
      return [classify(activity, this, 0.25)];
    }
    return [];
  },
  getPositions: emptyPositions,
  getVolumeUsd: amountToUsd,
};

export const buildAdapters = (protocols: Protocol[]): HevmProtocolAdapter[] => {
  const protocolContractMap = makeProtocolContractMap(protocols);

  const protocolAdapter: HevmProtocolAdapter = {
    id: "protocolRegistry",
    name: "Protocol Registry",
    category: "unknown",
    contracts: [...protocolContractMap.keys()],
    classifyActivity(activity) {
      const contract = contractFromActivity(activity);
      const hit = protocolContractMap.get(contract);
      if (hit) {
        return [classify(activity, { id: hit.id, name: hit.name, category: hit.category }, 0.95)];
      }

      const category = makeContractKeywordCategory(activity);
      if (!category) return [];
      return [classify(activity, { id: `heuristic:${category}`, name: `Heuristic ${category}`, category }, 0.5)];
    },
    getPositions: emptyPositions,
    getVolumeUsd: amountToUsd,
  };

  return [
    bridgeAdapter,
    protocolAdapter,
    nativeAdapter,
    erc20Adapter,
    dexAdapter,
    lendingAdapter,
    vaultAdapter,
    stakingAdapter,
    unknownContractAdapter,
  ];
};
