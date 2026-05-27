import { NextRequest, NextResponse } from "next/server";
import { fetchHevmStatsFromApi } from "@/lib/dashboard/hevm";
import { isEvmAddress, normalizeAddress } from "@/lib/dashboard/shared";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const addressRaw = searchParams.get("address") ?? "";
  const address = normalizeAddress(addressRaw);

  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  try {
    const result = await fetchHevmStatsFromApi(address);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load HEVM stats.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
