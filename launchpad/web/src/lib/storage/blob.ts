// Production backend: Vercel Blob. Connecting a public Blob store to the Vercel project
// sets BLOB_READ_WRITE_TOKEN; objects are then served by Vercel's CDN at
// https://<store>.public.blob.vercel-storage.com/<key>, and that URL is what we hand out
// (it goes into on-chain metadata as is, so it must stay well under 200 bytes).

import { put } from "@vercel/blob";

const YEAR = 60 * 60 * 24 * 365;

export async function putBlob(token: string, key: string, body: Buffer | string, contentType: string): Promise<string> {
  const blob = await put(key, body, {
    access: "public",
    token,
    contentType,
    // Keys are content-addressed: the URL must be exactly the key, rewriting one stores
    // the same bytes again, and browsers and the CDN may cache it forever.
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: YEAR,
  });
  return blob.url;
}
