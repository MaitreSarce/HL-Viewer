import { normalizeAddress } from "@/lib/dashboard/shared";
import { Protocol } from "@/lib/hevm/types";

const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";

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
];

const isHyperChain = (chain: string) => {
  const c = chain.toLowerCase();
  return c.includes("hyper") || c.includes("hyperevm") || c.includes("hyperliquid");
};

export const fetchProtocolRegistry = async (): Promise<Protocol[]> => {
  const out = new Map<string, Protocol>();

  for (const p of MANUAL_PROTOCOLS) {
    out.set(p.slug, p);
  }

  try {
    const response = await fetch(DEFILLAMA_PROTOCOLS_URL, { cache: "no-store" });
    if (response.ok) {
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const chains = Array.isArray(row.chains)
          ? row.chains.map((x) => String(x)).filter(Boolean)
          : [];
        if (!chains.some(isHyperChain)) continue;

        const slug = String(row.slug ?? "").trim();
        const name = String(row.name ?? slug).trim();
        if (!slug) continue;

        const category = String(row.category ?? "unknown").toLowerCase();
        const protocol: Protocol = {
          slug,
          name,
          category,
          chains,
          contracts: [],
          source: "defillama",
        };
        out.set(slug, protocol);
      }
    }
  } catch {
    // keep manual-only registry
  }

  return [...out.values()]
    .map((p) => ({
      ...p,
      contracts: [...new Set(p.contracts.map((c) => normalizeAddress(c)).filter(Boolean))],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};
