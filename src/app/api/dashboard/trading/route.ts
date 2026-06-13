import { NextRequest, NextResponse } from "next/server";
import { fetchTradingStatsFromApi } from "@/lib/dashboard/trading";
import { isEvmAddress, normalizeAddress } from "@/lib/dashboard/shared";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const addressRaw = searchParams.get("address") ?? "";
  const address = normalizeAddress(addressRaw);
  const continueScan = searchParams.get("continue") === "1";
  const scanId = searchParams.get("scanId") ?? undefined;

  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  try {
    const result = await fetchTradingStatsFromApi(address, { continueScan, scanId });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load trading stats.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const address = normalizeAddress(typeof body.address === "string" ? body.address : "");
  const continueScan = Boolean(body.continueScan);
  const scanId = typeof body.scanId === "string" ? body.scanId : undefined;
  const fallbackWindows = Array.isArray(body.pendingWindows) ? body.pendingWindows : undefined;

  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  try {
    const result = await fetchTradingStatsFromApi(address, { continueScan, scanId, fallbackWindows });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load trading stats.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
