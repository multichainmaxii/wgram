import { NextResponse } from "next/server";
import { getLocalObject } from "@/lib/storage";

// Serves images uploaded in development; production image URLs point at Vercel Blob.
// Names are content hashes, so the bytes behind a URL never change.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const image = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(id) ? await getLocalObject(`images/${id}`) : null;
  if (!image) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new Response(image.body, {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      // User-supplied bytes: never sniff them as anything else, never run them as a page.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
