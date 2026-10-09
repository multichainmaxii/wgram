import { NextResponse } from "next/server";

// Browsers can't use Solana's public RPC (it answers 403 to web origins), and the
// server's keyed RPC must stay secret, so the site's own pages send their JSON-RPC
// calls here (NEXT_PUBLIC_RPC=/api/rpc) and they are relayed to RPC_URL_SERVER.
// Only the methods the site and wallets need are relayed; program-wide scans like
// getProgramAccounts are not, so the key can't be used to hammer the provider.
const ALLOWED = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getBlockTime",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 20;

type RpcRequest = { jsonrpc?: string; id?: unknown; method?: unknown };

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function POST(request: Request) {
  const upstream = process.env.RPC_URL_SERVER;
  if (!upstream) return NextResponse.json(rpcError(null, -32000, "RPC relay is not configured"), { status: 503 });

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return NextResponse.json(rpcError(null, -32600, "Request too large"), { status: 413 });
  let body: RpcRequest | RpcRequest[];
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return NextResponse.json(rpcError(null, -32600, "Invalid batch size"), { status: 400 });
  const refused = calls.find((c) => typeof c?.method !== "string" || !ALLOWED.has(c.method));
  if (refused) {
    return NextResponse.json(rpcError(refused?.id, -32601, `Method not available through this site: ${String(refused?.method)}`), { status: 403 });
  }

  const res = await fetch(upstream, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return NextResponse.json(rpcError(null, -32000, "Upstream RPC unreachable"), { status: 502 });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
