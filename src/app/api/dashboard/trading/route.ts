import { NextRequest, NextResponse } from "next/server";
import { fetchTradingStatsFromApi } from "@/lib/dashboard/trading";
import { isEvmAddress, normalizeAddress } from "@/lib/dashboard/shared";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const addressRaw = searchParams.get("address") ?? "";
  const daysRaw = Number(searchParams.get("days") ?? "14");
  const address = normalizeAddress(addressRaw);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.floor(daysRaw)) : 14;

  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  try {
    const result = await fetchTradingStatsFromApi(address, days);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load trading stats.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
