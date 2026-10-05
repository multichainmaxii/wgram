import { NextResponse } from "next/server";
import { cached } from "@/lib/server/cache";
import { listCoinsServer } from "@/lib/server/coins";
import type { CoinsResponse } from "@/lib/types";

// One chain scan serves every visitor for 4s; a CDN can keep serving it for 20s more
// while it revalidates.
export async function GET(req: Request) {
  const { origin } = new URL(req.url);
  try {
    const body = await cached<CoinsResponse>("coins:list", 4_000, async () => ({
      coins: await listCoinsServer(origin),
      updatedAt: Date.now(),
    }));
    return NextResponse.json(body, {
      headers: { "Cache-Control": "public, s-maxage=4, stale-while-revalidate=20" },
    });
  } catch (err) {
    // Details stay in the server log: RPC errors can carry provider URLs.
    console.error("GET /api/coins failed:", err);
    return NextResponse.json(
      { error: "chain data is unavailable right now" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
