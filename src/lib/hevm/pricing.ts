import { PriceContext, PriceResult } from "@/lib/hevm/types";

const DEFILLAMA_COINS_CURRENT = "https://coins.llama.fi/prices/current";
const DEFILLAMA_HIST = "https://coins.llama.fi/prices/historical";
const DEFILLAMA_BATCH_HIST = "https://coins.llama.fi/batchHistorical";
const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";
const FETCH_TIMEOUT_MS = 5000;

const STABLES = new Set(["USDC", "USDT", "DAI", "USD0", "USDH", "USDHL", "USDE", "USDT0", "FDUSD"]);

const normalizeToken = (token: string) => token.trim().toUpperCase();

const toCoinKeys = (token: string) => {
  const t = normalizeToken(token);
  if (t === "HYPE" || t === "WHYPE") return ["coingecko:hyperliquid", "hyperevm:0x5555555555555555555555555555555555555555"];
  if (t.startsWith("0X") && t.length === 42) return [`hyperevm:${t.toLowerCase()}`, `hyperliquid:${t.toLowerCase()}`];
  return [`coingecko:${t.toLowerCase()}`, `symbol:${t.toLowerCase()}`];
};

const parseDefiLlamaPrice = (payload: any, coinKey: string): number | null => {
  const row = payload?.coins?.[coinKey];
  const p = typeof row?.price === "number" ? row.price : null;
  return p && Number.isFinite(p) && p > 0 ? p : null;
};

export const createPriceContext = async (): Promise<{
  context: PriceContext;
  warmup: (entries: Array<{ token: string; timestamp: number }>) => Promise<void>;
  ignoredTokens: Array<{ token: string; timestamp: number }>;
  priceErrors: any[];
}> => {
  const ignoredTokens: Array<{ token: string; timestamp: number }> = [];
  const priceErrors: any[] = [];
  const cache = new Map<string, PriceResult>();
  const ignoredSet = new Set<string>();
  const permanentlyMissingTokens = new Set<string>();
  const fallbackCurrentByToken = new Map<string, number>();
  const pricedTokenAttempts = new Set<string>();
  const maxDistinctTokenLookups = 120;

  const bucketTimestamp = (timestamp: number) => Math.floor(Math.max(0, timestamp) / 86400) * 86400;

  const pushIgnored = (token: string, timestamp: number) => {
    const key = `${token}:${timestamp}`;
    if (ignoredSet.has(key)) return;
    ignoredSet.add(key);
    ignoredTokens.push({ token, timestamp });
  };

  const safeFetchJson = async (url: string, init?: RequestInit) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  const resolveViaDefiLlama = async (token: string, timestamp: number): Promise<PriceResult | null> => {
    for (const coinKey of toCoinKeys(token)) {
      const payload = await safeFetchJson(`${DEFILLAMA_HIST}/${timestamp}/${encodeURIComponent(coinKey)}`);
      const price = payload ? parseDefiLlamaPrice(payload, coinKey) : null;
      if (price !== null) {
        return { token, timestamp, priceUsd: price, source: "defillama" };
      }
    }
    return null;
  };

  const resolvePriceUsd = async (token: string, timestamp: number): Promise<PriceResult> => {
    const symbol = normalizeToken(token || "HYPE");
    const ts = bucketTimestamp(timestamp);
    const key = `${symbol}:${ts}`;
    if (cache.has(key)) return cache.get(key)!;

    if (STABLES.has(symbol)) {
      const result: PriceResult = { token: symbol, timestamp: ts, priceUsd: 1, source: "stablecoin" };
      cache.set(key, result);
      return result;
    }

    const tokenFallback = fallbackCurrentByToken.get(symbol);
    if (tokenFallback && Number.isFinite(tokenFallback) && tokenFallback > 0) {
      const result: PriceResult = { token: symbol, timestamp: ts, priceUsd: tokenFallback, source: "fallback_current" };
      cache.set(key, result);
      return result;
    }

    if (permanentlyMissingTokens.has(symbol)) {
      pushIgnored(symbol, ts);
      const missing: PriceResult = { token: symbol, timestamp: ts, priceUsd: null, source: "missing" };
      cache.set(key, missing);
      return missing;
    }

    if (!pricedTokenAttempts.has(symbol)) {
      if (pricedTokenAttempts.size >= maxDistinctTokenLookups) {
        permanentlyMissingTokens.add(symbol);
        pushIgnored(symbol, ts);
        const missing: PriceResult = { token: symbol, timestamp: ts, priceUsd: null, source: "missing" };
        cache.set(key, missing);
        return missing;
      }
      pricedTokenAttempts.add(symbol);
    }

    const historical = await resolveViaDefiLlama(symbol, ts);
    if (historical) {
      cache.set(key, historical);
      return historical;
    }

    try {
      if (symbol === "HYPE" || symbol === "WHYPE") {
        const payload = await safeFetchJson(`${COINGECKO_SIMPLE}?ids=hyperliquid&vs_currencies=usd`);
        if (payload) {
          const price = Number(payload?.hyperliquid?.usd ?? 0);
          if (Number.isFinite(price) && price > 0) {
            fallbackCurrentByToken.set(symbol, price);
            const result: PriceResult = { token: symbol, timestamp: ts, priceUsd: price, source: "fallback_current" };
            cache.set(key, result);
            return result;
          }
        }
      }

      for (const coinKey of toCoinKeys(symbol)) {
        const payload = await safeFetchJson(`${DEFILLAMA_COINS_CURRENT}/${encodeURIComponent(coinKey)}`);
        const price = payload ? parseDefiLlamaPrice(payload, coinKey) : null;
        if (price !== null) {
          fallbackCurrentByToken.set(symbol, price);
          const result: PriceResult = { token: symbol, timestamp: ts, priceUsd: price, source: "fallback_current" };
          cache.set(key, result);
          return result;
        }
      }
    } catch (error) {
      priceErrors.push({ token: symbol, timestamp: ts, source: "fallback_current", error: String(error) });
    }

    permanentlyMissingTokens.add(symbol);
    pushIgnored(symbol, ts);
    const missing: PriceResult = { token: symbol, timestamp: ts, priceUsd: null, source: "missing" };
    cache.set(key, missing);
    return missing;
  };

  const warmup = async (entries: Array<{ token: string; timestamp: number }>) => {
    const dedup = new Map<string, { token: string; timestamp: number }>();
    for (const entry of entries) {
      const token = normalizeToken(entry.token || "HYPE");
      const timestamp = bucketTimestamp(entry.timestamp);
      dedup.set(`${token}:${timestamp}`, { token, timestamp });
    }

    const sample = [...dedup.values()].slice(0, 500);
    if (sample.length === 0) return;

    const coins = [...new Set(sample.flatMap((x) => toCoinKeys(x.token)))];
    const timestamps = [...new Set(sample.map((x) => x.timestamp))];

    const payload = await safeFetchJson(DEFILLAMA_BATCH_HIST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coins, timestamps }),
    });

    if (!payload || typeof payload !== "object") return;
    const items = (payload as { coins?: Record<string, { price?: number; timestamp?: number }> }).coins ?? {};
    for (const coinKey of Object.keys(items)) {
      const row = items[coinKey];
      const price = Number(row?.price ?? 0);
      const ts = Number(row?.timestamp ?? 0);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts) || ts <= 0) continue;
      for (const sampleEntry of sample) {
        if (!toCoinKeys(sampleEntry.token).includes(coinKey)) continue;
        const key = `${sampleEntry.token}:${sampleEntry.timestamp}`;
        if (cache.has(key)) continue;
        cache.set(key, {
          token: sampleEntry.token,
          timestamp: sampleEntry.timestamp,
          priceUsd: price,
          source: "defillama",
        });
      }
    }
  };

  return {
    context: { resolvePriceUsd },
    warmup,
    ignoredTokens,
    priceErrors,
  };
};
