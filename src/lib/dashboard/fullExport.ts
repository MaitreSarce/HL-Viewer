import { gunzipSync } from "node:zlib";
import {
  buildOutcomeCoinSet,
  buildPerpCoinSet,
  buildSpotCoinSet,
  buildUnitSpotIdSet,
  summarizeTradingFills,
  TradingApiResult,
} from "@/lib/dashboard/trading";
import {
  buildSpotCoinResolver,
  fetchHyperliquidInfo,
  HyperliquidFill,
  OutcomeMetaResponse,
  PerpMetaResponse,
  SpotMetaResponse,
} from "@/lib/dashboard/hyperliquid";
import { normalizeAddress } from "@/lib/dashboard/shared";

const HYPEDEXER_API_BASE = "https://api.hypedexer.com";
const HYPEDEXER_ORIGIN = "https://trade-export.hypedexer.com";
const FULL_EXPORT_START_DATE = "2023-01-01";
const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 230_000;

type QuotaEntry = {
  jobId?: string;
  createdAt: number;
  retryAt: number;
};

type HypedexerJob = {
  job_id: string;
  status: "queued" | "running" | "done" | "empty" | "error" | string;
  progress_ratio_estimate?: number;
  rows_written?: number;
  error?: string | null;
};

type HypedexerApiResponse<T> = {
  success?: boolean;
  data?: T;
  detail?: string;
  message?: string;
};

const quotaMemory = new Map<string, QuotaEntry>();

const utcDateKey = (date = new Date()) => date.toISOString().slice(0, 10);

const tomorrowUtcDate = () => {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.toISOString().slice(0, 10);
};

const hashText = async (input: string) => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
};

export const fullExportQuotaKey = async (wallet: string, ip: string, userAgent: string) => {
  const fingerprint = await hashText(`${ip}|${userAgent}`);
  return `full-export:${normalizeAddress(wallet)}:${fingerprint}:${utcDateKey()}`;
};

const cleanupQuotaMemory = () => {
  const now = Date.now();
  for (const [key, entry] of quotaMemory) {
    if (entry.retryAt <= now) quotaMemory.delete(key);
  }
};

export const checkFullExportQuota = (key: string) => {
  cleanupQuotaMemory();
  const entry = quotaMemory.get(key);
  if (!entry) return { allowed: true as const };
  return {
    allowed: false as const,
    retryAt: entry.retryAt,
    retryInSeconds: Math.max(0, Math.ceil((entry.retryAt - Date.now()) / 1000)),
    jobId: entry.jobId,
  };
};

export const markFullExportUsed = (key: string, jobId?: string) => {
  const now = new Date();
  const retryAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  quotaMemory.set(key, { jobId, createdAt: Date.now(), retryAt });
};

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Origin: HYPEDEXER_ORIGIN,
      ...(init?.headers ?? {}),
    },
    redirect: "manual",
    cache: "no-store",
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      const jobId = location.split("/").filter(Boolean).at(-1);
      return { success: true, data: { job_id: jobId, status: "queued" } } as T;
    }
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Hypedexer export failed with status ${response.status}`);
  }

  return JSON.parse(text) as T;
};

const startHypedexerExport = async (wallet: string) => {
  const url = new URL(`${HYPEDEXER_API_BASE}/fills/user/${wallet}/export/csv`);
  url.searchParams.set("mode", "distributed");
  url.searchParams.set("start_time", FULL_EXPORT_START_DATE);
  url.searchParams.set("end_time", tomorrowUtcDate());

  const payload = await requestJson<HypedexerApiResponse<HypedexerJob>>(url.toString());
  const jobId = payload.data?.job_id;
  if (!jobId) throw new Error(payload.detail ?? payload.message ?? "Could not start full history export.");
  return jobId;
};

const getHypedexerJob = async (jobId: string) => {
  const payload = await requestJson<HypedexerApiResponse<HypedexerJob>>(
    `${HYPEDEXER_API_BASE}/fills/export/jobs/${jobId}`
  );
  if (!payload.data) throw new Error(payload.detail ?? payload.message ?? "Could not read full export job status.");
  return payload.data;
};

const downloadHypedexerJob = async (jobId: string) => {
  const response = await fetch(`${HYPEDEXER_API_BASE}/fills/export/jobs/${jobId}/download`, {
    headers: { Origin: HYPEDEXER_ORIGIN },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not download full export file (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
};

const parseCsvLine = (line: string) => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};

export const parseHypedexerCsvGz = (buffer: Buffer): HyperliquidFill[] => {
  const csv = gunzipSync(buffer).toString("utf8");
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0] ?? "");
  const indexByName = new Map(header.map((name, index) => [name, index]));

  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line);
    const read = (name: string) => cells[indexByName.get(name) ?? -1] ?? "";
    const timeRaw = read("time");
    const timeMs = Number.isFinite(Date.parse(`${timeRaw.replace(" ", "T")}Z`))
      ? Date.parse(`${timeRaw.replace(" ", "T")}Z`)
      : 0;

    return {
      coin: read("coin"),
      dir: read("dir"),
      px: read("px"),
      sz: read("sz"),
      fee: read("fee"),
      feeToken: read("feeToken"),
      closedPnl: read("closedPnl"),
      hash: read("hash"),
      time: timeMs,
      tid: rowIndex,
    };
  });
};

const waitForHypedexerJob = async (jobId: string) => {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastJob: HypedexerJob | null = null;

  while (Date.now() < deadline) {
    const job = await getHypedexerJob(jobId);
    lastJob = job;
    if (job.status === "done" || job.status === "empty") return job;
    if (job.status === "error" || job.error) {
      throw new Error(job.error ?? "Full history export failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    lastJob?.progress_ratio_estimate
      ? `Full history export is still processing (${Math.round(lastJob.progress_ratio_estimate * 100)}%). Please try again in a few minutes.`
      : "Full history export is still processing. Please try again in a few minutes."
  );
};

export const fetchTradingStatsFromFullExport = async (
  address: string,
  quotaKey: string
): Promise<TradingApiResult> => {
  const wallet = normalizeAddress(address);
  const quota = checkFullExportQuota(quotaKey);
  if (!quota.allowed && !quota.jobId) {
    throw new Error(
      quota.retryInSeconds > 0
        ? `Daily full history export limit reached. Try again in about ${Math.ceil(quota.retryInSeconds / 60)} minutes.`
        : "Daily full history export limit reached. Please try again tomorrow."
    );
  }

  const endTime = Date.now();
  const warnings: string[] = [
    "Data source: Hypedexer/Enigma full history export (.csv.gz).",
    "Full export is an alternative data source; HL-Viewer compares fill counts before replacing API values.",
    `Full export is requested from ${FULL_EXPORT_START_DATE} to tomorrow UTC to cover early Hyperliquid trading history.`,
    "Full export quota is limited to one request per wallet/user per UTC day in HL-Viewer.",
  ];

  const jobId = quota.allowed ? await startHypedexerExport(wallet) : quota.jobId;
  if (!jobId) throw new Error("Could not resolve full history export job.");
  if (quota.allowed) {
    markFullExportUsed(quotaKey, jobId);
  } else {
    warnings.push("Daily full history export was already started; reusing the existing export job for this wallet/user.");
  }
  const job = await waitForHypedexerJob(jobId);
  if (job.status === "empty") {
    throw new Error("Full history export completed, but no trades were found for this wallet.");
  }

  const [spotMeta, perpMeta, exportBuffer] = await Promise.all([
    fetchHyperliquidInfo<SpotMetaResponse>({ type: "spotMeta" }),
    fetchHyperliquidInfo<PerpMetaResponse>({ type: "meta" }),
    downloadHypedexerJob(jobId),
  ]);

  let outcomeMeta: OutcomeMetaResponse | null = null;
  let outcomeMetaRequestUsed = 0;
  try {
    outcomeMeta = await fetchHyperliquidInfo<OutcomeMetaResponse>({ type: "outcomeMeta" });
    outcomeMetaRequestUsed = 1;
  } catch {
    warnings.push(
      "Could not load outcomeMeta. Outcome detection falls back to encoded prefixes (#/+), settlement flags, and non-spot/non-perp buy/sell inference."
    );
  }

  const fills = parseHypedexerCsvGz(exportBuffer);
  const resolver = buildSpotCoinResolver(spotMeta);
  const summary = summarizeTradingFills(
    fills,
    resolver,
    {
      knownSpotCoins: buildSpotCoinSet(spotMeta, resolver),
      knownPerpCoins: buildPerpCoinSet(perpMeta),
      knownOutcomeCoins: outcomeMeta ? buildOutcomeCoinSet(outcomeMeta) : new Set<string>(),
      knownUnitSpotIds: buildUnitSpotIdSet(spotMeta),
    },
    endTime
  );

  warnings.push(`Full export job ${jobId} loaded ${fills.length} fills.`);
  warnings.push(
    "Spot/Vault/Staking TWAB enrichments still depend on Hyperliquid account history endpoints; fill-based stats use the full export."
  );

  return {
    source: "full_export",
    address: wallet,
    period: { startTime: Date.parse(`${FULL_EXPORT_START_DATE}T00:00:00Z`), endTime },
    meta: {
      requestsUsed: 4 + outcomeMetaRequestUsed,
      usedFallback: false,
      truncated: false,
      warnings,
      dataSourceLabel: "Full history export",
    },
    ...summary,
  };
};
