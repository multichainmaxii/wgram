import { NextResponse } from "next/server";
import { saveMetadata } from "@/lib/metadataStore";
import { StorageNotConfiguredError } from "@/lib/storage";

// Uploaded images are https Blob URLs in production; in development they're served by
// this server's /api/images route, usually over plain http on localhost.
function isImageUrl(image: string, origin: string) {
  if (/^https:\/\/\S{4,400}$/.test(image)) return true;
  return image.startsWith(`${origin}/api/images/`) && /^\S{1,400}$/.test(image);
}

// Metaplex limits: name 32 bytes, symbol 10 bytes, uri 200 bytes.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  const image = typeof body?.image === "string" ? body.image.trim() : "";
  const origin = new URL(req.url).origin;

  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (!name || bytes(name) > 32) return NextResponse.json({ error: "Name must be 1-32 characters." }, { status: 400 });
  if (!symbol || bytes(symbol) > 10) return NextResponse.json({ error: "Ticker must be 1-10 characters." }, { status: 400 });
  if (description.length > 500) return NextResponse.json({ error: "Description is limited to 500 characters." }, { status: 400 });
  if (image && !isImageUrl(image, origin)) {
    return NextResponse.json({ error: "Image must be an https:// link." }, { status: 400 });
  }

  try {
    const uri = await saveMetadata({ name, symbol, description, image }, origin);
    return NextResponse.json({ uri });
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) return NextResponse.json({ error: err.message }, { status: 503 });
    console.error("metadata: save failed", err);
    return NextResponse.json({ error: "Couldn't save the coin's details. Try again." }, { status: 500 });
  }
}
