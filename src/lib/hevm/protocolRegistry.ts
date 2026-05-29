import { normalizeAddress } from "@/lib/dashboard/shared";
import { Protocol } from "@/lib/hevm/types";

const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
const DEFILLAMA_PROTOCOL_DETAIL_URL = "https://api.llama.fi/protocol";
const FETCH_TIMEOUT_MS = 6000;
const EVM_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;
const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
const DETAIL_CONCURRENCY = 10;
const DETAIL_FETCH_BUDGET_MS = 12000;

let protocolRegistryCache: { value: Protocol[]; expiresAt: number } | null = null;

const MANUAL_PROTOCOLS: Protocol[] = [
  {
    slug: "hyperliquid-system",
    name: "Hyperliquid System",
    category: "bridge",
    chains: ["HyperEVM"],
    contracts: ["0x2222222222222222222222222222222222222222"],
    source: "manual",
  },
  {
    slug: "hyperunit",
    name: "HyperUnit",
    category: "bridge",
    chains: ["HyperEVM"],
    contracts: [],
    source: "manual",
  },
  {
    slug: "hyperswap",
    name: "HyperSwap",
    category: "dex",
    chains: ["HyperEVM"],
    contracts: [],
    source: "manual",
  },
  {
    slug: "project-x",
    name: "Project X",
    category: "dex",
    chains: ["HyperEVM"],
    contracts: [],
    source: "manual",
  },
  {
    slug: "hyperlend",
    name: "HyperLend",
    category: "lending",
    chains: ["HyperEVM"],
    contracts: [],
    source: "manual",
  },
  {
    slug: "felix",
    name: "Felix",
    category: "lending",
    chains: ["HyperEVM"],
    contracts: [],
    source: "manual",
  },
  {
    slug: "kinetiq",
    name: "Kinetiq",
    category: "staking",
    chains: ["HyperEVM"],
    contracts: [],
    source: "manual",
  },
];

const isHyperChain = (chain: string) => {
  const c = chain.toLowerCase();
  return c.includes("hyper") || c.includes("hyperevm") || c.includes("hyperliquid") || c.includes("hyper-evm");
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

const normalizeCategory = (category: string) => {
  const c = category.toLowerCase();
  if (c.includes("dex") || c.includes("swap") || c.includes("amm")) return "dex";
  if (c.includes("lend") || c.includes("borrow") || c.includes("cdp")) return "lending";
  if (
    c.includes("vault") ||
    c.includes("yield") ||
    c.includes("liquidity manager") ||
    c.includes("onchain capital allocator") ||
    c.includes("leveraged farming")
  ) {
    return "vault";
  }
  if (c.includes("stake") || c.includes("lsd")) return "staking";
  if (c.includes("bridge")) return "bridge";
  return c || "unknown";
};

const extractAddressesFromValue = (value: unknown): string[] => {
  if (value === null || value === undefined) return [] as string[];
  if (typeof value === "string") {
    const matches = value.match(EVM_ADDRESS_REGEX) ?? [];
    return matches
      .map((match) => normalizeAddress(match))
      .filter((address) => address.startsWith("0x") && address.length === 42);
  }
  if (Array.isArray(value)) {
    return value.flatMap((row) => extractAddressesFromValue(row));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((row) => extractAddressesFromValue(row));
  }
  return [] as string[];
};

const readAddressList = (value: unknown) => {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((x) => normalizeAddress(String(x)))
    .filter((x) => x.startsWith("0x") && x.length === 42);
};

const collectContractsFromProtocolDetail = (detail: Record<string, unknown>) => {
  const contracts = new Set<string>();
  for (const addr of extractAddressesFromValue(detail.address)) contracts.add(addr);
  const direct = readAddressList(detail.addresses);
  for (const addr of direct) contracts.add(addr);

  const chainTvls = detail.chainTvls;
  if (chainTvls && typeof chainTvls === "object") {
    for (const value of Object.values(chainTvls as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const maybe = value as Record<string, unknown>;
      for (const key of ["addresses", "tokens", "poolAddresses", "contracts"]) {
        for (const addr of readAddressList(maybe[key])) contracts.add(addr);
      }
    }
  }

  return [...contracts];
};

export const fetchProtocolRegistry = async (): Promise<Protocol[]> => {
  if (protocolRegistryCache && protocolRegistryCache.expiresAt > Date.now()) {
    return protocolRegistryCache.value;
  }

  const bySlug = new Map<string, Protocol>();

  for (const p of MANUAL_PROTOCOLS) bySlug.set(p.slug, p);

  const protocolsPayload = await safeFetchJson(DEFILLAMA_PROTOCOLS_URL);
  const rows = Array.isArray(protocolsPayload) ? (protocolsPayload as Array<Record<string, unknown>>) : [];

  const candidates: Protocol[] = [];
  for (const row of rows) {
    const chains = Array.isArray(row.chains) ? row.chains.map((x) => String(x)).filter(Boolean) : [];
    if (!chains.some(isHyperChain)) continue;

    const slug = String(row.slug ?? "").trim();
    if (!slug) continue;

    const category = normalizeCategory(String(row.category ?? "unknown"));
    candidates.push({
      slug,
      name: String(row.name ?? slug).trim(),
      category,
      chains,
      contracts: extractAddressesFromValue(row.address),
      source: "defillama",
    });
  }

  for (const p of candidates) {
    const current = bySlug.get(p.slug);
    if (!current) {
      bySlug.set(p.slug, p);
      continue;
    }
    bySlug.set(p.slug, {
      ...current,
      chains: [...new Set([...current.chains, ...p.chains])],
      category: current.category === "unknown" ? p.category : current.category,
      source: current.source,
    });
  }

  const detailTargets = [...bySlug.values()]
    .filter((p) => p.source === "defillama")
    .sort((a, b) => a.contracts.length - b.contracts.length);
  const detailStart = Date.now();
  for (let i = 0; i < detailTargets.length; i += DETAIL_CONCURRENCY) {
    if (Date.now() - detailStart >= DETAIL_FETCH_BUDGET_MS) break;
    const chunk = detailTargets.slice(i, i + DETAIL_CONCURRENCY);
    await Promise.all(
      chunk.map(async (p) => {
        const payload = await safeFetchJson(`${DEFILLAMA_PROTOCOL_DETAIL_URL}/${encodeURIComponent(p.slug)}`);
        if (!payload || typeof payload !== "object") return;
        const contracts = collectContractsFromProtocolDetail(payload as Record<string, unknown>);
        if (contracts.length === 0) return;
        const current = bySlug.get(p.slug);
        if (!current) return;
        bySlug.set(p.slug, {
          ...current,
          contracts: [...new Set([...current.contracts, ...contracts])],
        });
      })
    );
  }

  const result = [...bySlug.values()]
    .map((p) => {
      const contracts = [...new Set(p.contracts.map((c) => normalizeAddress(c)).filter((c) => c.startsWith("0x") && c.length === 42))];
      return { ...p, contracts };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  protocolRegistryCache = {
    value: result,
    expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS,
  };
  return result;
};
