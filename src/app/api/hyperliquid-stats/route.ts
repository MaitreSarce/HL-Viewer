import { NextRequest, NextResponse } from "next/server";
import { Fill, summarizeFills } from "@/lib/stats";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user = searchParams.get("address")?.trim() ?? "";
  const days = Math.max(1, Number(searchParams.get("days") ?? "14"));

  if (!/^0x[a-fA-F0-9]{40}$/.test(user)) {
    return NextResponse.json({ error: "Adresse wallet invalide." }, { status: 400 });
  }

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "userFillsByTime",
      user,
      startTime,
      endTime,
      aggregateByTime: true,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Hyperliquid a renvoye une erreur." }, { status: 502 });
  }

  const fills = (await response.json()) as Fill[];
  const summary = summarizeFills(fills);

  return NextResponse.json({
    address: user,
    days,
    period: { startTime, endTime },
    source: "api",
    ...summary,
  });
}
