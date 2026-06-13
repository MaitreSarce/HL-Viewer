import { NextRequest, NextResponse } from "next/server";
import { getTradingScanProgress } from "@/lib/dashboard/trading";
import { isEvmAddress, normalizeAddress } from "@/lib/dashboard/shared";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = normalizeAddress(searchParams.get("address") ?? "");
  const scanId = searchParams.get("scanId") ?? undefined;

  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  return NextResponse.json(getTradingScanProgress(address, scanId), { status: 200 });
}
