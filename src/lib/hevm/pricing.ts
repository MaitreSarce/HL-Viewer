import { PriceContext, PriceResult } from "@/lib/hevm/types";

const DEFILLAMA_COINS_CURRENT = "https://coins.llama.fi/prices/current";
const DEFILLAMA_HIST = "https://coins.llama.fi/prices/historical";
const DEFILLAMA_BATCH_HIST = "https://coins.llama.fi/batchHistorical";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_HISTORY = "https://api.coingecko.com/api/v3/coins/hyperliquid/history";
const FETCH_TIMEOUT_MS = 5000;

const STABLES = new Set(["USDC", "USDT", "DAI", "USD0", "USDH", "USDHL", "USDE", "USDT0", "FDUSD", "USDP", "FEUSD"]);

type HyperliquidSpotContext = {
  symbolToCurrentUsd: Map<string, number>;
  aliasToSymbol: Map<string, string>;
  addressToSymbol: Map<string, string>;
};

type SpotMetaTokenRow = {
  index?: number;
  name?: string;
  evmContract?: {
    address?: string;
  } | null;
};

type SpotMetaPairRow = {
  index?: number;
  tokens?: unknown;
  name?: string;
};

const normalizeToken = (token: string) => token.trim().toUpperCase();
const isAddress = (token: string) => token.startsWith("0X") && token.length === 42;
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;
const aliasKey = (token: string) => normalizeToken(token).replaceAll("₮", "T").replace(/[^A-Z0-9]/g, "");
const toNumber = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const setSymbolAlias = (
  aliasToSymbol: Map<string, string>,
  symbol: string
) => {
  const normalized = normalizeToken(symbol);
  if (!normalized) return;
  aliasToSymbol.set(normalized, normalized);
  const alias = aliasKey(normalized);
  if (alias) aliasToSymbol.set(alias, normalized);
};
const isStableLikeSymbol = (symbol: string) => {
  const normalized = normalizeToken(symbol);
  if (STABLES.has(normalized)) return true;
  const alias = aliasKey(normalized);
  return alias === "USDT0" || alias === "USDT" || alias === "USDC" || alias === "DAI" || alias === "USDE";
};

const toCoinKeys = (token: string) => {
  const t = normalizeToken(token);
  if (t === "HYPE" || t === "WHYPE") return ["coingecko:hyperliquid", "hyperevm:0x5555555555555555555555555555555555555555"];
  if (isAddress(t)) return [`hyperevm:${t.toLowerCase()}`, `hyperliquid:${t.toLowerCase()}`];
  return [`coingecko:${t.toLowerCase()}`, `symbol:${t.toLowerCase()}`];
};

const parseDefiLlamaPrice = (payload: any, coinKey: string): number | null => {
  const row = payload?.coins?.[coinKey];
  const p = typeof row?.price === "number" ? row.price : null;
  return p && Number.isFinite(p) && p > 0 ? p : null;
};

const toCoinGeckoDateParam = (timestampSec: number) => {
  const d = new Date(timestampSec * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
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
  const aliasByToken = new Map<string, string>();
  const addressToSymbol = new Map<string, string>();
  const pricedTokenAttempts = new Set<string>();
  const maxDistinctTokenLookups = 120;
  let hyperliquidContextPromise: Promise<HyperliquidSpotContext | null> | null = null;

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

  const getHyperliquidSpotContext = async (): Promise<HyperliquidSpotContext | null> => {
    if (hyperliquidContextPromise) return hyperliquidContextPromise;
    hyperliquidContextPromise = (async () => {
      const [spotMetaPayload, allMidsPayload] = await Promise.all([
        safeFetchJson(HYPERLIQUID_INFO_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "spotMeta" }),
        }),
        safeFetchJson(HYPERLIQUID_INFO_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        }),
      ]);

      const spotMeta = asRecord(spotMetaPayload);
      const midsObj = asRecord(allMidsPayload);
      if (!spotMeta || !midsObj) return null;

      const symbolToCurrentUsd = new Map<string, number>();
      const aliasToSymbol = new Map<string, string>();
      const addressMap = new Map<string, string>();

      const tokenByIndex = new Map<number, string>();
      const tokens = Array.isArray(spotMeta.tokens) ? (spotMeta.tokens as SpotMetaTokenRow[]) : [];
      for (const token of tokens) {
        if (typeof token.index !== "number") continue;
        const symbol = normalizeToken(String(token.name ?? ""));
        if (!symbol) continue;
        tokenByIndex.set(Math.floor(token.index), symbol);
        setSymbolAlias(aliasToSymbol, symbol);
        const addr = normalizeToken(String(token.evmContract?.address ?? ""));
        if (isAddress(addr)) addressMap.set(addr.toLowerCase(), symbol);
      }

      for (const [key, value] of Object.entries(midsObj)) {
        const price = toNumber(value);
        if (price <= 0) continue;
        const normalizedKey = normalizeToken(key);
        if (!normalizedKey || normalizedKey.startsWith("@") || normalizedKey.startsWith("#")) continue;
        if (!symbolToCurrentUsd.has(normalizedKey)) symbolToCurrentUsd.set(normalizedKey, price);
        setSymbolAlias(aliasToSymbol, normalizedKey);
      }

      const edges: Array<{ base: string; quote: string; mid: number }> = [];
      const universe = Array.isArray(spotMeta.universe) ? (spotMeta.universe as SpotMetaPairRow[]) : [];
      for (const pair of universe) {
        if (typeof pair.index !== "number") continue;
        const idx = Math.floor(pair.index);
        const mid = toNumber(midsObj[`@${idx}`]);
        if (mid <= 0) continue;

        const tokensRaw = Array.isArray(pair.tokens) ? pair.tokens : [];
        if (tokensRaw.length < 2) continue;
        const baseIdx = Math.floor(toNumber(tokensRaw[0]));
        const quoteIdx = Math.floor(toNumber(tokensRaw[1]));
        const base = tokenByIndex.get(baseIdx);
        const quote = tokenByIndex.get(quoteIdx);
        if (!base || !quote) continue;
        edges.push({ base, quote, mid });
        setSymbolAlias(aliasToSymbol, base);
        setSymbolAlias(aliasToSymbol, quote);
      }

      for (const stable of STABLES) {
        symbolToCurrentUsd.set(stable, 1);
        setSymbolAlias(aliasToSymbol, stable);
      }

      for (let iter = 0; iter < 8; iter += 1) {
        let changed = false;
        for (const edge of edges) {
          const basePx = symbolToCurrentUsd.get(edge.base);
          const quotePx = symbolToCurrentUsd.get(edge.quote);

          if (quotePx && quotePx > 0 && !basePx) {
            const v = edge.mid * quotePx;
            if (Number.isFinite(v) && v > 0) {
              symbolToCurrentUsd.set(edge.base, v);
              changed = true;
            }
          }

          if (basePx && basePx > 0 && !quotePx) {
            const v = basePx / edge.mid;
            if (Number.isFinite(v) && v > 0) {
              symbolToCurrentUsd.set(edge.quote, v);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }

      return { symbolToCurrentUsd, aliasToSymbol, addressToSymbol: addressMap };
    })();

    return hyperliquidContextPromise;
  };

  const seedHyperliquidFallbacks = async () => {
    const context = await getHyperliquidSpotContext();
    if (!context) return;

    for (const [symbol, price] of context.symbolToCurrentUsd.entries()) {
      if (!Number.isFinite(price) || price <= 0) continue;
      const normalized = normalizeToken(symbol);
      fallbackCurrentByToken.set(normalized, price);
      const alias = aliasKey(normalized);
      if (alias) aliasByToken.set(alias, normalized);
    }

    for (const [alias, symbol] of context.aliasToSymbol.entries()) {
      const normalizedSymbol = normalizeToken(symbol);
      if (!normalizedSymbol) continue;
      aliasByToken.set(alias, normalizedSymbol);
      aliasByToken.set(normalizeToken(alias), normalizedSymbol);
    }

    for (const [address, symbol] of context.addressToSymbol.entries()) {
      addressToSymbol.set(address.toLowerCase(), normalizeToken(symbol));
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
    await seedHyperliquidFallbacks();

    const input = normalizeToken(token || "HYPE");
    let symbol = input;
    if (isAddress(input)) {
      const mapped = addressToSymbol.get(input.toLowerCase());
      if (mapped) symbol = mapped;
    } else {
      const alias = aliasByToken.get(aliasKey(input)) || aliasByToken.get(input);
      if (alias) symbol = alias;
    }

    const ts = bucketTimestamp(timestamp);
    const key = `${symbol}:${ts}`;
    if (cache.has(key)) return cache.get(key)!;

    if (isStableLikeSymbol(symbol)) {
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

    if (symbol === "HYPE" || symbol === "WHYPE") {
      try {
        const dateParam = toCoinGeckoDateParam(ts);
        const payload = await safeFetchJson(`${COINGECKO_HISTORY}?date=${dateParam}&localization=false`);
        const price = Number(payload?.market_data?.current_price?.usd ?? 0);
        if (Number.isFinite(price) && price > 0) {
          const result: PriceResult = { token: symbol, timestamp: ts, priceUsd: price, source: "onchain" };
          cache.set(key, result);
          return result;
        }
      } catch (error) {
        priceErrors.push({ token: symbol, timestamp: ts, source: "onchain", error: String(error) });
      }
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
    await seedHyperliquidFallbacks();
    const dedup = new Map<string, { token: string; timestamp: number }>();
    for (const entry of entries) {
      const rawToken = normalizeToken(entry.token || "HYPE");
      const token = isAddress(rawToken)
        ? (addressToSymbol.get(rawToken.toLowerCase()) ?? rawToken)
        : (aliasByToken.get(aliasKey(rawToken)) ?? aliasByToken.get(rawToken) ?? rawToken);
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
