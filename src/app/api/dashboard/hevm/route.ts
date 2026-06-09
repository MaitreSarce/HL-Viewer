import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { fetchHevmStatsFromApi } from "@/lib/dashboard/hevm";
import { isEvmAddress, normalizeAddress } from "@/lib/dashboard/shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEVM_RESPONSE_CACHE_SECONDS = 3600;
const getCachedHevmStats = unstable_cache(
  async (address: string, hourBucket: number) => {
    void hourBucket;
    return fetchHevmStatsFromApi(address);
  },
  ["hevm-dashboard-response"],
  { revalidate: HEVM_RESPONSE_CACHE_SECONDS }
);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const addressRaw = searchParams.get("address") ?? "";
  const address = normalizeAddress(addressRaw);

  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address." }, { status: 400 });
  }

  try {
    const hourBucket = Math.floor(Date.now() / (HEVM_RESPONSE_CACHE_SECONDS * 1000));
    const result = await getCachedHevmStats(address, hourBucket);
    return NextResponse.json(result, {
      status: 200,
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${HEVM_RESPONSE_CACHE_SECONDS}, stale-while-revalidate=300`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load HEVM stats.";
    return NextResponse.json(
      { error: message },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      }
    );
  }
}
