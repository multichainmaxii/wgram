// Live GRAM/USD. CoinGecko still lists GRAM under Toncoin's old id: "the-open-network"
// is "Gram (prev. Toncoin)", symbol GRAM (checked October 2026).

import "server-only";
import { GRAM_USD } from "@/lib/config";
import type { PriceResponse } from "@/lib/types";
import { cached } from "./cache";

const COINGECKO_ID = "the-open-network";
const PRICE_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd&include_last_updated_at=true`;

async function fromCoinGecko(): Promise<PriceResponse> {
  // Optional free demo key: keyless calls share a small per-IP rate limit, which hosts
  // with shared egress IPs can exhaust.
  const key = process.env.COINGECKO_DEMO_API_KEY;
  const res = await fetch(PRICE_URL, {
    headers: key ? { "x-cg-demo-api-key": key } : {},
    signal: AbortSignal.timeout(3_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const quote = ((await res.json()) as Record<string, { usd?: unknown; last_updated_at?: unknown } | undefined>)[COINGECKO_ID];
  const gramUsd = Number(quote?.usd);
  if (!Number.isFinite(gramUsd) || gramUsd <= 0) throw new Error("CoinGecko returned no GRAM price");
  const at = Number(quote?.last_updated_at);
  return { gramUsd, source: "coingecko", updatedAt: at > 0 ? at * 1000 : Date.now() };
}

// Cached for a minute. If CoinGecko fails the last good quote is kept; until there is
// one, the configured NEXT_PUBLIC_GRAM_USD stands in.
export async function getGramUsd(): Promise<PriceResponse> {
  try {
    return await cached("price:gram-usd", 60_000, fromCoinGecko);
  } catch {
    return { gramUsd: GRAM_USD, source: "fallback", updatedAt: Date.now() };
  }
}
