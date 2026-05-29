import { normalizeAddress } from "@/lib/dashboard/shared";

export const HYPE_CORE_SYSTEM_ADDRESS = "0x2222222222222222222222222222222222222222";

// HyperCore token system addresses are 0x20 + zero-padded token index (big-endian).
// We keep this strict enough to avoid classifying random 0x20-prefixed addresses as bridge traffic.
const CORE_SPOT_SYSTEM_ADDRESS_REGEX = /^0x20(?:0{24}[0-9a-f]{14})$/;

export const isCoreBridgeSystemAddress = (value?: string) => {
  const v = normalizeAddress(value || "");
  if (!v) return false;
  if (v === HYPE_CORE_SYSTEM_ADDRESS) return true;
  return CORE_SPOT_SYSTEM_ADDRESS_REGEX.test(v);
};

