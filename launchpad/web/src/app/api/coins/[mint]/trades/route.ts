import { NextResponse } from "next/server";
import { getTrades } from "@/lib/server/trades";
import type { TradesResponse } from "@/lib/types";

const MAX_TRADES = 100;

// Newest first. Shared caches hold it briefly so a busy coin page doesn't cost an
// RPC read per viewer.
export async function GET(_req: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  try {
    const body: TradesResponse = { trades: (await getTrades(mint)).slice(0, MAX_TRADES) };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=20" },
    });
  } catch (e) {
    console.error("GET /api/coins/[mint]/trades failed", { mint, error: (e as Error).message });
    return NextResponse.json({ error: "Couldn't load trades right now." }, { status: 502 });
  }
}
