import { NextRequest, NextResponse } from "next/server";
import { Fill, summarizeFillsApiLegacy } from "@/lib/stats";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

const fetchFills = async (body: Record<string, unknown>) => {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { ok: response.ok, payload };
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user = searchParams.get("address")?.trim() ?? "";
  const days = Math.max(1, Number(searchParams.get("days") ?? "14"));

  if (!/^0x[a-fA-F0-9]{40}$/.test(user)) {
    return NextResponse.json({ error: "Adresse wallet invalide." }, { status: 400 });
  }

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  const byTime = await fetchFills({
      type: "userFillsByTime",
      user,
      startTime,
      endTime,
  });

  let fills: Fill[] = [];

  if (byTime.ok && Array.isArray(byTime.payload)) {
    fills = byTime.payload as Fill[];
  } else {
    const latest = await fetchFills({
      type: "userFills",
      user,
    });

    if (latest.ok && Array.isArray(latest.payload)) {
      fills = latest.payload as Fill[];
    } else {
      const rawMessage =
        (typeof byTime.payload === "object" &&
          byTime.payload !== null &&
          "error" in byTime.payload &&
          typeof (byTime.payload as { error?: unknown }).error === "string" &&
          (byTime.payload as { error: string }).error) ||
        "Réponse API invalide";
      return NextResponse.json({ error: `Hyperliquid API: ${rawMessage}` }, { status: 502 });
    }
  }

  const summary = summarizeFillsApiLegacy(fills);

  return NextResponse.json({
    address: user,
    days,
    period: { startTime, endTime },
    source: "api",
    ...summary,
  });
}
