// The server's RPC connection, shared by the coin list, trade history and link previews.
// RPC_URL_SERVER is for a private (keyed) RPC that must never reach the browser bundle;
// a domain-restricted browser key (NEXT_PUBLIC_RPC) may reject server requests.

import "server-only";
import { Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { RPC_URL } from "@/lib/config";

const RPC_TIMEOUT_MS = 10_000;

let rpc: { connection: Connection; dbc: DynamicBondingCurveClient } | null = null;

export function serverRpc() {
  if (!rpc) {
    const connection = new Connection(process.env.RPC_URL_SERVER || RPC_URL, {
      commitment: "confirmed",
      // Fail fast instead of web3.js's 429 backoff; callers' caches cover the gap.
      disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
    });
    rpc = { connection, dbc: new DynamicBondingCurveClient(connection, "confirmed") };
  }
  return rpc;
}
