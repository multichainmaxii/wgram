import { NextResponse } from "next/server";
import { cached } from "@/lib/server/cache";

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
// Reads that are the same for every visitor (a coin's pool, the latest blockhash) are
// shared for a moment, so a thousand people watching one coin cost one upstream read per
// TTL instead of one each. Concurrent identical calls also share one request. Sends,
// simulations and signature checks always go straight through.
const SHARED_TTL_MS: Record<string, number> = {
  getAccountInfo: 1_500,
  getMultipleAccounts: 1_500,
  getBalance: 1_500,
  getTokenAccountBalance: 1_500,
  getTokenAccountsByOwner: 1_500,
  getTokenSupply: 5_000,
  getLatestBlockhash: 2_000,
  getSlot: 1_000,
  getBlockHeight: 1_000,
  getEpochInfo: 5_000,
  getRecentPrioritizationFees: 5_000,
  getMinimumBalanceForRentExemption: 3_600_000,
  getGenesisHash: 3_600_000,
  getVersion: 3_600_000,
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 20;

type RpcRequest = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type RpcReply = { result?: unknown; error?: unknown };

class UpstreamError extends Error {}

async function forward(upstream: string, body: string): Promise<Response | null> {
  return fetch(upstream, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
}

// One shareable call, answered from the short-lived cache. Upstream HTTP failures (rate
// limits, outages) throw, so they aren't cached as answers.
function sharedCall(upstream: string, call: RpcRequest): Promise<RpcReply> {
  const key = `rpc:${call.method}:${JSON.stringify(call.params ?? null)}`;
  return cached(key, SHARED_TTL_MS[call.method as string], async () => {
    const res = await forward(upstream, JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params }));
    if (!res?.ok) throw new UpstreamError(res ? `Upstream RPC returned ${res.status}` : "Upstream RPC unreachable");
    const reply = (await res.json()) as RpcReply;
    return reply.error !== undefined ? { error: reply.error } : { result: reply.result };
  });
}

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

  if (calls.every((c) => SHARED_TTL_MS[c.method as string] !== undefined)) {
    try {
      const replies = await Promise.all(calls.map((c) => sharedCall(upstream, c).then((r) => ({ jsonrpc: "2.0", id: c.id ?? null, ...r }))));
      return NextResponse.json(Array.isArray(body) ? replies : replies[0], { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return NextResponse.json(rpcError(null, -32005, (e as Error).message), { status: 503 });
    }
  }

  const res = await forward(upstream, text);
  if (!res) return NextResponse.json(rpcError(null, -32000, "Upstream RPC unreachable"), { status: 502 });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
