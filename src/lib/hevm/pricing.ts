import { PriceContext, PriceResult } from "@/lib/hevm/types";

const DEFILLAMA_COINS_CURRENT = "https://coins.llama.fi/prices/current";
const DEFILLAMA_HIST = "https://coins.llama.fi/prices/historical";
const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";

const STABLES = new Set(["USDC", "USDT", "DAI", "USD0", "USDH", "USDHL", "USDE", "USDT0", "FDUSD"]);

const normalizeToken = (token: string) => token.trim().toUpperCase();

const toCoinKey = (token: string) => {
  const t = normalizeToken(token);
  if (t === "HYPE" || t === "WHYPE") return "coingecko:hyperliquid";
  return "coingecko:" + t.toLowerCase();
};

const parseDefiLlamaPrice = (payload: any, coinKey: string): number | null => {
  const row = payload?.coins?.[coinKey];
  const p = typeof row?.price === "number" ? row.price : null;
  return p && Number.isFinite(p) && p > 0 ? p : null;
};

export const createPriceContext = async (): Promise<{
  context: PriceContext;
  ignoredTokens: Array<{ token: string; timestamp: number }>;
  priceErrors: any[];
}> => {
  const ignoredTokens: Array<{ token: string; timestamp: number }> = [];
  const priceErrors: any[] = [];
  const cache = new Map<string, PriceResult>();

  const resolvePriceUsd = async (token: string, timestamp: number): Promise<PriceResult> => {
    const symbol = normalizeToken(token || "HYPE");
    const key = `${symbol}:${timestamp}`;
    if (cache.has(key)) return cache.get(key)!;

    if (STABLES.has(symbol)) {
      const result: PriceResult = { token: symbol, timestamp, priceUsd: 1, source: "stablecoin" };
      cache.set(key, result);
      return result;
    }

    const coinKey = toCoinKey(symbol);
    try {
      const hist = await fetch(`${DEFILLAMA_HIST}/${Math.floor(timestamp)}/${coinKey}`, { cache: "no-store" });
      if (hist.ok) {
        const payload = await hist.json();
        const price = parseDefiLlamaPrice(payload, coinKey);
        if (price !== null) {
          const result: PriceResult = { token: symbol, timestamp, priceUsd: price, source: "defillama" };
          cache.set(key, result);
          return result;
        }
      }
    } catch (error) {
      priceErrors.push({ token: symbol, timestamp, source: "defillama_historical", error: String(error) });
    }

    try {
      if (symbol === "HYPE" || symbol === "WHYPE") {
        const current = await fetch(`${COINGECKO_SIMPLE}?ids=hyperliquid&vs_currencies=usd`, { cache: "no-store" });
        if (current.ok) {
          const payload = await current.json();
          const price = Number(payload?.hyperliquid?.usd ?? 0);
          if (Number.isFinite(price) && price > 0) {
            const result: PriceResult = { token: symbol, timestamp, priceUsd: price, source: "fallback_current" };
            cache.set(key, result);
            return result;
          }
        }
      }

      const current = await fetch(`${DEFILLAMA_COINS_CURRENT}/${coinKey}`, { cache: "no-store" });
      if (current.ok) {
        const payload = await current.json();
        const price = parseDefiLlamaPrice(payload, coinKey);
        if (price !== null) {
          const result: PriceResult = { token: symbol, timestamp, priceUsd: price, source: "fallback_current" };
          cache.set(key, result);
          return result;
        }
      }
    } catch (error) {
      priceErrors.push({ token: symbol, timestamp, source: "fallback_current", error: String(error) });
    }

    ignoredTokens.push({ token: symbol, timestamp });
    const missing: PriceResult = { token: symbol, timestamp, priceUsd: null, source: "missing" };
    cache.set(key, missing);
    return missing;
  };

  return {
    context: { resolvePriceUsd },
    ignoredTokens,
    priceErrors,
  };
};
