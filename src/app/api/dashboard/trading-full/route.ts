import { NextRequest, NextResponse } from "next/server";
import { fetchTradingStatsFromFullExport, fullExportQuotaKey } from "@/lib/dashboard/fullExport";
import { isEvmAddress, normalizeAddress } from "@/lib/dashboard/shared";

const clientIp = (request: NextRequest) => {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const firstForwarded = forwarded.split(",")[0]?.trim();
  return (
    firstForwarded ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
};

export async function POST(request: NextRequest) {
  let addressRaw = "";
  try {
    const body = (await request.json()) as { address?: string };
    addressRaw = body.address ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const address = normalizeAddress(addressRaw);
  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  try {
    const quotaKey = await fullExportQuotaKey(
      address,
      clientIp(request),
      request.headers.get("user-agent") ?? "unknown"
    );
    const result = await fetchTradingStatsFromFullExport(address, quotaKey);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load full trading history.";
    const status = message.includes("Daily full history export limit reached") ? 429 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
