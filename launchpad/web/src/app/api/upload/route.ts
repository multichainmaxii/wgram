import { NextResponse } from "next/server";
import { StorageNotConfiguredError, contentHash, putObject } from "@/lib/storage";
import { IMAGE_ERRORS, MAX_IMAGE_BYTES, sniffImage } from "@/lib/storage/images";

// The image plus multipart framing (boundaries, part headers).
const MAX_BODY_BYTES = MAX_IMAGE_BYTES + 16 * 1024;
const FORM_ERROR = "Send the image as multipart/form-data in a field named 'file'.";

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

// Reads the body but stops past `limit` bytes, so an oversized upload is never buffered whole.
async function readBody(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get("content-length")) > limit) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// POST multipart/form-data with a `file` field: a PNG, JPEG, GIF or WebP image up to 2 MB.
// Returns { url }, the public URL to put in the coin's metadata.
export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) return fail(FORM_ERROR);

  const raw = await readBody(req, MAX_BODY_BYTES);
  if (!raw) return fail(IMAGE_ERRORS.size);
  const file = await new Response(raw, { headers: { "Content-Type": type } })
    .formData()
    .then((form) => form.get("file"))
    .catch(() => null);
  if (!file || typeof file === "string") return fail(FORM_ERROR);
  if (file.size === 0) return fail(IMAGE_ERRORS.empty);
  if (file.size > MAX_IMAGE_BYTES) return fail(IMAGE_ERRORS.size);

  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return fail(IMAGE_ERRORS.type);

  try {
    const url = await putObject(`images/${contentHash(bytes)}.${kind.ext}`, bytes, kind.mime, new URL(req.url).origin);
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) return fail(err.message, 503);
    console.error("upload: store failed", err);
    return fail("Couldn't store the image. Try again.", 500);
  }
}
