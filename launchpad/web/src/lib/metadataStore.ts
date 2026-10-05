// Off-chain token metadata (the JSON a coin's on-chain `uri` points at), saved through
// lib/storage: a Vercel Blob URL in production, /api/metadata/<id> in development.

import { contentHash, getLocalObject, putObject } from "./storage";

export type TokenMetadata = {
  name: string;
  symbol: string;
  description: string;
  image: string;
};

// Metaplex keeps at most 200 bytes of uri on-chain.
const MAX_URI_BYTES = 200;
const ID = /^[a-z0-9-]{3,48}$/;

// Returns the full public URI. Ids are content-addressed, so the JSON behind a URI can
// never change after a coin launches with it.
export async function saveMetadata(meta: TokenMetadata, origin?: string): Promise<string> {
  const json = JSON.stringify({ name: meta.name, symbol: meta.symbol, description: meta.description, image: meta.image });
  const slug = meta.symbol.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "coin";
  const uri = await putObject(`metadata/${slug}-${contentHash(json)}.json`, json, "application/json", origin);
  if (new TextEncoder().encode(uri).length > MAX_URI_BYTES) {
    throw new Error(`Metadata URI is over the ${MAX_URI_BYTES}-byte Metaplex limit: ${uri}`);
  }
  return uri;
}

// Development store only; Blob URIs are served by Vercel directly.
export async function loadMetadata(id: string): Promise<TokenMetadata | null> {
  if (!ID.test(id)) return null;
  const object = await getLocalObject(`metadata/${id}.json`);
  if (!object) return null;
  try {
    return JSON.parse(object.body.toString("utf8")) as TokenMetadata;
  } catch {
    return null;
  }
}
