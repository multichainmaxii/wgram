// Public storage for launch images and coin metadata JSON. Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set (production); otherwise .data/ on the local disk, in
// development only. Production without a token refuses to write: serverless disks are
// ephemeral, so local files would leave coins pointing at metadata that disappears.

import { createHash } from "node:crypto";
import { putBlob } from "./blob";
import { putLocal, readLocal } from "./local";

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("File storage isn't configured on this server. Set BLOB_READ_WRITE_TOKEN (a public Vercel Blob store) to enable it.");
    this.name = "StorageNotConfiguredError";
  }
}

// `<folder>/<name>.<ext>`. The extension is the content type, so dev files need no sidecar.
const KEY = /^(images|metadata)\/[a-z0-9-]{3,64}\.(png|jpg|gif|webp|json)$/;
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  json: "application/json",
};

// 128 bits of SHA-256: identical bodies share a key and different ones never collide,
// which is what makes overwriting a key safe.
export const contentHash = (body: Buffer | string) => createHash("sha256").update(body).digest("hex").slice(0, 32);

export type StoredObject = { body: Buffer<ArrayBuffer>; contentType: string };

// Stores a public object and returns its URL. `origin` is the site origin dev URLs are
// built on (pass the request's own, so links work however the dev server is reached).
export async function putObject(key: string, body: Buffer | string, contentType: string, origin?: string): Promise<string> {
  const match = KEY.exec(key);
  if (!match || TYPES[match[2]] !== contentType) throw new Error(`Bad storage key "${key}" for ${contentType}`);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) return putBlob(token, key, body, contentType);
  if (process.env.NODE_ENV === "production") throw new StorageNotConfiguredError();
  await putLocal(key, body);
  return localUrl(key, origin ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
}

// Reads an object written by the dev backend; null for unknown or malformed keys.
export async function getLocalObject(key: string): Promise<StoredObject | null> {
  const match = KEY.exec(key);
  if (!match) return null;
  const body = await readLocal(key);
  return body && { body, contentType: TYPES[match[2]] };
}

// Dev objects are served by /api/images/<file> and /api/metadata/<id>; metadata URIs
// drop the extension to match the ones already on the local chain.
function localUrl(key: string, origin: string) {
  const [folder, file] = key.split("/");
  return folder === "metadata" ? `${origin}/api/metadata/${file.slice(0, -".json".length)}` : `${origin}/api/images/${file}`;
}
