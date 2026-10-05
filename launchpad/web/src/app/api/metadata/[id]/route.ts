import { NextResponse } from "next/server";
import { loadMetadata } from "@/lib/metadataStore";

// Public, so wallets and explorers can read a coin's name, ticker and image. Serves the
// development store; production URIs are Blob URLs that Vercel serves directly.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = await loadMetadata(id);
  if (!meta) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(meta, {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
