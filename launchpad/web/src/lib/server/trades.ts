// Recent swaps on a coin's bonding curve, read back from the pool's transaction
// history. Every swap moves the pool's two token vaults in opposite directions.

import "server-only";
import { PublicKey, type ConfirmedSignatureInfo, type ParsedTransactionWithMeta, type TokenBalance } from "@solana/web3.js";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { configAddress, wgramMint } from "@/lib/chain";
import { TOKEN_DECIMALS, WGRAM_DECIMALS } from "@/lib/config";
import type { Trade } from "@/lib/types";
import { serverRpc } from "./rpc";

const TTL_MS = 5_000;
const SIGNATURES = 200;
const BATCH = 25;
const PARSED_MAX = 20_000;

type Pool = { address: PublicKey; baseVault: PublicKey; quoteVault: PublicKey };

const pools = new Map<string, Pool>(); // by mint; a pool's vaults never change
// By signature (null: not a swap). Confirmed transactions never change, so each is
// fetched once; oldest entries are dropped first.
const parsed = new Map<string, Trade | null>();
const recent = new Map<string, { at: number; trades: Promise<Trade[]> }>(); // by mint

// Newest first. Unknown mints have no trades.
export function getTrades(mint: string): Promise<Trade[]> {
  const now = Date.now();
  const hit = recent.get(mint);
  if (hit && now - hit.at < TTL_MS) return hit.trades;
  for (const [key, entry] of recent) if (now - entry.at >= TTL_MS) recent.delete(key);
  const trades = loadTrades(mint);
  recent.set(mint, { at: now, trades });
  // Failures aren't cached, so the next request retries.
  trades.catch(() => {
    if (recent.get(mint)?.trades === trades) recent.delete(mint);
  });
  return trades;
}

async function loadTrades(mint: string): Promise<Trade[]> {
  const pool = await findPool(mint);
  if (!pool) return [];
  const signatures = (await serverRpc().connection.getSignaturesForAddress(pool.address, { limit: SIGNATURES })).filter((s) => !s.err);

  const known = new Map<string, Trade | null>();
  const missing: ConfirmedSignatureInfo[] = [];
  for (const s of signatures) {
    const trade = parsed.get(s.signature);
    if (trade === undefined) missing.push(s);
    else known.set(s.signature, trade);
  }
  const batches: ConfirmedSignatureInfo[][] = [];
  for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      const txs = await serverRpc().connection.getParsedTransactions(batch.map((s) => s.signature), { maxSupportedTransactionVersion: 0 });
      txs.forEach((tx, i) => {
        if (!tx) return; // not served by the node yet; retried next time
        const trade = toTrade(tx, batch[i], pool);
        known.set(batch[i].signature, trade);
        remember(batch[i].signature, trade);
      });
    }),
  );
  return signatures.flatMap((s) => known.get(s.signature) ?? []);
}

async function findPool(mint: string): Promise<Pool | null> {
  const cached = pools.get(mint);
  if (cached) return cached;
  let address: PublicKey;
  try {
    address = deriveDbcPoolAddress(wgramMint(), new PublicKey(mint), configAddress());
  } catch {
    return null;
  }
  const account = await serverRpc().dbc.state.getPool(address);
  if (!account) return null;
  const pool = { address, baseVault: account.poolState.baseVault, quoteVault: account.poolState.quoteVault };
  pools.set(mint, pool);
  return pool;
}

function remember(signature: string, trade: Trade | null) {
  parsed.set(signature, trade);
  if (parsed.size > PARSED_MAX) {
    const oldest = parsed.keys().next().value;
    if (oldest) parsed.delete(oldest);
  }
}

// A buy adds wGRAM to the quote vault and takes tokens out of the base vault, a sell
// the reverse. Launches, migration and fee claims never do both, so they're skipped.
function toTrade(tx: ParsedTransactionWithMeta, info: ConfirmedSignatureInfo, pool: Pool): Trade | null {
  if (!tx.meta || tx.meta.err) return null;
  const base = vaultDelta(tx, pool.baseVault);
  const quote = vaultDelta(tx, pool.quoteVault);
  const side = quote > 0n && base < 0n ? "buy" : quote < 0n && base > 0n ? "sell" : null;
  if (!side) return null;
  const wgram = Number(quote < 0n ? -quote : quote) / 10 ** WGRAM_DECIMALS;
  const tokens = Number(base < 0n ? -base : base) / 10 ** TOKEN_DECIMALS;
  const keys = tx.transaction.message.accountKeys;
  return {
    signature: info.signature,
    side,
    wgram,
    tokens,
    priceWgram: wgram / tokens,
    trader: (keys.find((k) => k.signer) ?? keys[0]).pubkey.toBase58(),
    time: tx.blockTime ?? info.blockTime ?? Math.floor(Date.now() / 1000),
  };
}

const amount = (b: TokenBalance) => BigInt(b.uiTokenAmount.amount);
const total = (balances: TokenBalance[] | null | undefined, mint: string) =>
  (balances ?? []).reduce((sum, b) => (b.mint === mint ? sum + amount(b) : sum), 0n);

// Raw change in a vault's balance over the transaction.
function vaultDelta(tx: ParsedTransactionWithMeta, vault: PublicKey): bigint {
  const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(vault));
  const postBalances = tx.meta?.postTokenBalances;
  const preBalances = tx.meta?.preTokenBalances;
  const post = postBalances?.find((b) => b.accountIndex === index);
  if (!post) return 0n;
  const pre = preBalances?.find((b) => b.accountIndex === index);
  // A vault opened by this transaction (a launch, maybe with the creator's first buy)
  // starts with what was minted here: the whole supply for the base vault, no wGRAM.
  const opening = pre ? amount(pre) : total(postBalances, post.mint) - total(preBalances, post.mint);
  return amount(post) - opening;
}
