import { NextResponse } from "next/server";
import { getGramUsd } from "@/lib/server/price";

// Cached for a minute in-process and at the CDN; browsers poll it once a minute.
export async function GET() {
  return NextResponse.json(await getGramUsd(), {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}
