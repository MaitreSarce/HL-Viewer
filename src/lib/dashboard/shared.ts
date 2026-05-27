export const isEvmAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());

export const normalizeAddress = (value: string) => value.trim().toLowerCase();

export const toFiniteNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

export const readStringKeys = (source: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return "";
};

export const readNumberKeys = (source: Record<string, unknown>, keys: string[]): number => {
  for (const key of keys) {
    const raw = source[key];
    const value = toFiniteNumber(raw);
    if (value !== 0) return value;
    if (raw === 0 || raw === "0" || raw === "0.0") return 0;
  }
  return 0;
};

export const utcDayKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

export const utcMonthKey = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 7);
};

export type AgeBreakdown = {
  days: number;
  months: number;
  years: number;
};

export const ageFromTimestamp = (timestampMs: number, nowMs = Date.now()): AgeBreakdown => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { days: 0, months: 0, years: 0 };
  }

  const diffMs = Math.max(0, nowMs - timestampMs);
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const months = Math.floor(days / 30.4375);
  const years = Math.floor(days / 365.25);

  return { days, months, years };
};

export const unique = <T>(values: T[]): T[] => [...new Set(values)];
